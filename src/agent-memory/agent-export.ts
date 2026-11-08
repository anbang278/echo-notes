import type { EvidenceKind } from "../evidence/evidence-types";
import { AgentMemoryError, type AgentAccessPolicy, type AgentCurrentPointer, type AgentGeneration, type AgentMemoryStorage, type AgentPublishInput } from "./agent-memory-types";
import { agentJson, agentSha256, isWithinAgentRoots, normalizeAgentPath, normalizedSource, parseAgentJson } from "./agent-memory-utils";

interface PublisherOptions {
	systemDir: string;
	vaultId: string;
	now?: () => string;
	id?: () => string;
}

export interface AgentPolicyUpdate {
	enabled: boolean;
	sourceKinds: EvidenceKind[];
	allowedRoots: string[];
}

export interface AgentGenerationComplete {
	schemaVersion: 1;
	generationId: string;
	previousGenerationId: string | null;
	sha256: string;
	bytes: number;
}

export class AgentExportPublisher {
	readonly policyPath: string;
	readonly currentPath: string;
	private queue: Promise<unknown> = Promise.resolve();
	private readonly base: string;
	private readonly now: () => string;
	private readonly id: () => string;

	constructor(private readonly storage: AgentMemoryStorage, private readonly options: PublisherOptions) {
		this.base = `${normalizeAgentPath(options.systemDir)}/agent-reader`;
		this.policyPath = `${this.base}/policy.json`;
		this.currentPath = `${this.base}/current.json`;
		this.now = options.now ?? (() => new Date().toISOString());
		this.id = options.id ?? (() => crypto.randomUUID());
	}

	async getPolicy(): Promise<AgentAccessPolicy | null> {
		const text = await this.storage.read(this.policyPath);
		return text === null ? null : parseAgentPolicy(text);
	}

	async setPolicy(update: AgentPolicyUpdate): Promise<AgentAccessPolicy> {
		const policy: AgentAccessPolicy = {
			schemaVersion: 1,
			vaultId: this.options.vaultId,
			version: this.id(),
			enabled: update.enabled,
			sourceKinds: [...new Set(update.sourceKinds)].sort(),
			allowedRoots: [...new Set(update.allowedRoots.map(normalizeAgentPath))].sort(),
			updatedAt: this.now()
		};
		parseAgentPolicy(agentJson(policy));
		await this.storage.write(this.policyPath, agentJson(policy));
		return policy;
	}

	publish(input: AgentPublishInput): Promise<AgentGeneration> {
		const operation = this.queue.then(() => this.publishGeneration(input));
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	private async publishGeneration(input: AgentPublishInput): Promise<AgentGeneration> {
		const policyText = await this.storage.read(this.policyPath);
		if (policyText === null) throw new AgentMemoryError("EXPORT_DISABLED", "Configure the current Agent export policy before publishing.");
		const policy = parseAgentPolicy(policyText);
		if (!policy.enabled) throw new AgentMemoryError("EXPORT_DISABLED", "Agent export is disabled.");
		if (policy.vaultId !== this.options.vaultId) throw new AgentMemoryError("IDENTITY_CONFLICT", "Agent policy belongs to another Vault.");
		const currentText = await this.storage.read(this.currentPath);
		const current = currentText === null ? null : parseAgentJson<AgentCurrentPointer>(currentText, this.currentPath);
		validatePublishInput(input, policy);
		const authorityFiles = await collectAuthorityFiles(this.storage, input.authorityRoots, input.relationPath);
		const metadataRevisions: Record<string, string> = {};
		for (const item of [...input.meetings, ...input.projects]) {
			const path = normalizeAgentPath(item.path);
			const content = await this.storage.read(path);
			if (!item.sourceRevision || content === null || await agentSha256(normalizedSource(content)) !== item.sourceRevision) {
				throw new AgentMemoryError("SOURCE_CHANGED", "Catalog metadata changed or has no verified source revision. Refresh the catalog and publish again.", path);
			}
			metadataRevisions[path] = item.sourceRevision;
		}
		const sourceRevisions: Record<string, string> = {};
		const documents = [];
		for (const document of input.documents) {
			const path = normalizeAgentPath(document.sourcePath);
			const currentSource = await this.storage.read(path);
			if (document.missing) {
				if (currentSource !== null) throw new AgentMemoryError("SOURCE_CHANGED", "A missing source exists again. Refresh its catalog identity before publishing.", path);
				documents.push({ ...document, content: "", missing: true });
				continue;
			}
			if (currentSource === null) throw new AgentMemoryError("SOURCE_CHANGED", "A source disappeared while publishing. Refresh the catalog and retry.", path);
			const normalized = normalizedSource(currentSource);
			if (normalized !== normalizedSource(document.content)) throw new AgentMemoryError("SOURCE_CHANGED", "A source changed while publishing. Refresh the catalog and retry.", path);
			sourceRevisions[path] = await agentSha256(normalized);
			documents.push({ ...document, content: "" });
		}
		const generationId = `generation-${this.id()}`;
		if (!/^[a-zA-Z0-9_-]+$/.test(generationId)) throw new AgentMemoryError("INVALID_QUERY", "Generation ID is invalid.");
		const generation: AgentGeneration = {
			schemaVersion: 1,
			protocolVersion: 1,
			vaultId: policy.vaultId,
			generationId,
			generatedAt: this.now(),
			policyVersion: policy.version,
			documents,
			meetings: input.meetings,
			projects: input.projects,
			authorityRoots: [...input.authorityRoots],
			relationPath: input.relationPath,
			sourceRevisions,
			metadataRevisions,
			authorityFiles
		};
		const serialized = agentJson(generation);
		const sha256 = await agentSha256(serialized);
		const bytes = new TextEncoder().encode(serialized).byteLength;
		const path = `${this.base}/generations/${generationId}/snapshot.json`;
		const completePath = `${this.base}/generations/${generationId}/complete.json`;
		const complete: AgentGenerationComplete = { schemaVersion: 1, generationId, previousGenerationId: current?.generationId ?? null, sha256, bytes };
		await this.storage.write(path, serialized, { exclusive: true });
		if (await this.storage.read(path) !== serialized) throw new AgentMemoryError("INDEX_INCOMPLETE", "Generation integrity check failed.", path);
		for (const [sourcePath, revision] of Object.entries(sourceRevisions)) {
			const currentSource = await this.storage.read(sourcePath);
			if (currentSource === null || await agentSha256(normalizedSource(currentSource)) !== revision) throw new AgentMemoryError("DATA_UPDATING", "A source changed before generation completion. Refresh and retry.", sourcePath);
		}
		for (const [path, revision] of Object.entries(metadataRevisions)) {
			const content = await this.storage.read(path);
			if (content === null || await agentSha256(normalizedSource(content)) !== revision) throw new AgentMemoryError("DATA_UPDATING", "Catalog metadata changed before generation completion. Refresh the catalog and retry.", path);
		}
		for (const document of input.documents.filter((document) => document.missing)) {
			if (await this.storage.read(document.sourcePath) !== null) throw new AgentMemoryError("DATA_UPDATING", "A previously missing source reappeared during publication. Refresh the catalog.", document.sourcePath);
		}
		if (await this.storage.read(this.policyPath) !== policyText || await this.storage.read(this.currentPath) !== currentText) {
			throw new AgentMemoryError("DATA_UPDATING", "Agent policy or generation changed during publication. Retry after synchronization.");
		}
		if (agentJson(await collectAuthorityFiles(this.storage, input.authorityRoots, input.relationPath)) !== agentJson(authorityFiles)) {
			throw new AgentMemoryError("DATA_UPDATING", "Memory authority changed during publication. Retry after synchronization.");
		}
		await this.storage.write(completePath, agentJson(complete), { exclusive: true });
		const pointer: AgentCurrentPointer = { schemaVersion: 1, generationId, path, sha256, bytes, completePath };
		await this.storage.write(this.currentPath, agentJson(pointer));
		await assertNoCompetingGeneration(this.storage, `${this.base}/generations`, complete);
		return generation;
	}
}

export function parseAgentPolicy(text: string): AgentAccessPolicy {
	const value = parseAgentJson<AgentAccessPolicy>(text, "policy.json");
	if (value.schemaVersion !== 1) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "Agent policy schema is unsupported.");
	if (typeof value.vaultId !== "string" || !value.vaultId || typeof value.version !== "string" || !value.version || typeof value.enabled !== "boolean" || !Array.isArray(value.allowedRoots) || !Array.isArray(value.sourceKinds) || typeof value.updatedAt !== "string") {
		throw new AgentMemoryError("EXPORT_DISABLED", "The current Agent policy is invalid. Review the connection settings.");
	}
	if (!value.sourceKinds.every((kind) => ["transcript", "approved_memory", "analysis"].includes(kind))) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "Agent policy contains unsupported material kinds.");
	value.allowedRoots.forEach(normalizeAgentPath);
	return value;
}

export async function collectAuthorityFiles(storage: AgentMemoryStorage, roots: readonly string[], relationPath?: string): Promise<Record<string, string>> {
	const files = new Set<string>();
	for (const root of roots) {
		const normalized = normalizeAgentPath(root);
		for (const path of await storage.list(normalized)) {
			if (!isWithinAgentRoots(path, [normalized])) throw new AgentMemoryError("ACCESS_DENIED", "Authority listing escaped its registered directory.");
			if (path.toLowerCase().endsWith(".md")) files.add(path);
		}
	}
	if (relationPath) {
		const normalized = normalizeAgentPath(relationPath);
		const parent = normalized.slice(0, normalized.lastIndexOf("/"));
		for (const path of await storage.list(parent)) {
			const basename = path.slice(path.lastIndexOf("/") + 1);
			if (path === normalized || (/relation/i.test(basename) && basename.endsWith(".json"))) files.add(path);
		}
	}
	const result: Record<string, string> = {};
	for (const path of [...files].sort()) {
		const text = await storage.read(path);
		if (text === null) throw new AgentMemoryError("DATA_UPDATING", "Authority files changed during enumeration.", path);
		result[path] = await agentSha256(text);
	}
	return result;
}

export async function assertNoCompetingGeneration(storage: AgentMemoryStorage, directory: string, complete: AgentGenerationComplete): Promise<void> {
	for (const path of await storage.list(directory)) {
		if (!path.endsWith("/complete.json")) continue;
		const other = parseAgentJson<AgentGenerationComplete>(await storage.read(path), path);
		if (other.schemaVersion !== 1) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "Generation completion schema is unsupported.", path);
		if (other.generationId !== complete.generationId && other.previousGenerationId === complete.previousGenerationId) {
			throw new AgentMemoryError("IDENTITY_CONFLICT", "Two synchronized devices published competing generations. Review the conflict before reading.");
		}
	}
}

function validatePublishInput(input: AgentPublishInput, policy: AgentAccessPolicy): void {
	for (const group of [input.documents.map((item) => item.sourceId), input.meetings.map((item) => item.id), input.projects.map((item) => item.id)]) {
		if (new Set(group).size !== group.length || group.some((id) => !id)) throw new AgentMemoryError("IDENTITY_CONFLICT", "Duplicate or missing stable identity in the catalog.");
	}
	const paths = input.documents.map((item) => item.sourcePath);
	if (new Set(paths).size !== paths.length) throw new AgentMemoryError("IDENTITY_CONFLICT", "A source path has multiple identities.");
	for (const path of [...paths, ...input.meetings.map((item) => item.path), ...input.projects.map((item) => item.path), ...input.authorityRoots, ...(input.relationPath ? [input.relationPath] : [])]) {
		if (!isWithinAgentRoots(path, policy.allowedRoots)) throw new AgentMemoryError("ACCESS_DENIED", "A publication dependency is outside the current allowed roots.", path);
	}
}

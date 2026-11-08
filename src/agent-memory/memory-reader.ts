import { meetingDates } from "../catalog/catalog-time";
import { currentProjectedMemories, type ProjectedMemory } from "../memory/memory-projection";
import { readMemoryProjection } from "./memory-projection-reader";
import { createEvidenceQuery, normalizeEvidenceQuery, freezeEvidencePackage, renderEvidenceMarkdown, searchEvidence, parseFormalTranscript } from "../evidence";
import { parseAnalysisSections } from "../evidence/formal-transcript";
import { matchMemoryEvidence } from "../evidence/evidence-query";
import type { EvidenceDocument, EvidenceKind, EvidenceMemory, EvidenceQueryV1 } from "../evidence/evidence-types";
import { AgentMemoryError, type AgentAccessPolicy, type AgentCurrentPointer, type AgentGeneration, type AgentIssue, type AgentMemoryStorage, type AgentResponse } from "./agent-memory-types";
import { agentJson, agentSha256, isWithinAgentRoots, normalizeAgentPath, normalizedSource, parseAgentJson } from "./agent-memory-utils";
import { assertNoCompetingGeneration, collectAuthorityFiles, parseAgentPolicy, type AgentGenerationComplete } from "./agent-export";

export interface AgentReadRequest {
	command: "doctor" | "projects" | "meetings" | "search" | "read" | "context" | "export";
	query?: EvidenceQueryV1;
	id?: string;
	kind?: "memory" | "evidence";
	includeHistory?: boolean;
	includeAnalysis?: boolean;
	projectIds?: string[];
	fromDate?: string;
	toDate?: string;
	limit?: number;
	cursor?: string;
}

export interface MemoryReaderOptions {
	policyPath: string;
	sourceKinds?: EvidenceKind[];
	allowedRoots?: string[];
	now?: () => string;
}

interface ReaderState {
	policy: AgentAccessPolicy;
	generation: AgentGeneration;
	documents: EvidenceDocument[];
	memories: ProjectedMemory[];
	warnings: AgentIssue[];
	reads: Map<string, string | null>;
	authorityFiles: Record<string, string>;
	kinds: EvidenceKind[];
	roots: string[];
	complete: AgentGenerationComplete;
}

export class MemoryReader {
	private readonly base: string;
	private readonly currentPath: string;
	private readonly now: () => string;

	constructor(private readonly storage: AgentMemoryStorage, private readonly options: MemoryReaderOptions) {
		const policyPath = normalizeAgentPath(options.policyPath);
		if (!policyPath.endsWith("/policy.json")) throw new AgentMemoryError("VAULT_NOT_CONFIGURED", "Select the policy.json path shown in Echo Notes Agent connection settings.");
		this.base = policyPath.slice(0, -"/policy.json".length);
		this.currentPath = `${this.base}/current.json`;
		this.now = options.now ?? (() => new Date().toISOString());
	}

	async execute(request: AgentReadRequest): Promise<AgentResponse> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			const checkedAt = this.now();
			try {
				if (request.query) {
					if (request.query.protocolVersion !== 1) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "The query protocol version is unsupported.");
					try { request = { ...request, query: normalizeEvidenceQuery(request.query) }; } catch {
						throw new AgentMemoryError("INVALID_QUERY", "The evidence query is invalid. Check fields, dates, timezone and budget.");
					}
				}
				const state = await this.loadState(request, checkedAt);
				const data = await this.query(state, request, checkedAt);
				await this.verifyState(state);
				return this.response(request.command, checkedAt, state, data);
			} catch (error) {
				lastError = error;
				if (!(error instanceof AgentMemoryError) || error.code !== "DATA_UPDATING") break;
			}
		}
		const failure = lastError instanceof AgentMemoryError
			? lastError
			: new AgentMemoryError("AUTHORITY_UNVERIFIED", "The current sources or memory authority could not be validated. Run doctor and rebuild the snapshot.");
		return {
			protocolVersion: 1,
			command: request.command,
			vaultId: "",
			generationId: "",
			status: "error",
			checkedAt: this.now(),
			freshness: { index: "as_of_snapshot", returnedItems: "unverified", scopeCompleteness: "as_of_snapshot" },
			data: null,
			warnings: [],
			errors: [{ code: failure.code, message: failure.message, ...(failure.path ? { path: failure.path } : {}) }]
		};
	}

	private async loadState(request: AgentReadRequest, checkedAt: string): Promise<ReaderState> {
		const reads = new Map<string, string | null>();
		const read = async (path: string): Promise<string | null> => {
			const value = await this.storage.read(path);
			reads.set(path, value);
			return value;
		};
		const policyText = await read(this.options.policyPath);
		if (policyText === null) throw new AgentMemoryError("EXPORT_DISABLED", "Current export policy is missing. Open Echo Notes and explicitly enable Agent export.");
		const policy = parseAgentPolicy(policyText);
		if (!policy.enabled) throw new AgentMemoryError("EXPORT_DISABLED", "Agent export is disabled. Enable it in Echo Notes before reading.");
		const roots = intersectRoots(policy.allowedRoots, this.options.allowedRoots);
		const configuredKinds = policy.sourceKinds.filter((kind) => !this.options.sourceKinds || this.options.sourceKinds.includes(kind));
		const requestedKinds = materialKinds(request, configuredKinds);
		const kinds = requestedKinds.filter((kind) => configuredKinds.includes(kind));
		if (requestedKinds.length && !kinds.length) throw new AgentMemoryError("ACCESS_DENIED", "This material kind is outside the current policy or local setup scope.");
		if (!roots.length) throw new AgentMemoryError("ACCESS_DENIED", "The current policy and local setup have no allowed directory in common.");
		const pointer = parseAgentJson<AgentCurrentPointer>(await read(this.currentPath), this.currentPath);
		if (pointer.schemaVersion !== 1) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "Current snapshot pointer version is unsupported.");
		for (const path of [pointer.path, pointer.completePath]) {
			if (typeof path !== "string" || !isWithinAgentRoots(path, [`${this.base}/generations`])) throw new AgentMemoryError("INDEX_INCOMPLETE", "Snapshot pointer has an invalid generation path.");
		}
		const serialized = await read(pointer.path);
		if (serialized === null || await agentSha256(serialized) !== pointer.sha256 || new TextEncoder().encode(serialized).byteLength !== pointer.bytes) throw new AgentMemoryError("INDEX_INCOMPLETE", "Snapshot hash or length does not match. Publish a complete snapshot.");
		const complete = parseAgentJson<AgentGenerationComplete>(await read(pointer.completePath), pointer.completePath);
		if (complete.schemaVersion !== 1 || complete.generationId !== pointer.generationId || complete.sha256 !== pointer.sha256 || complete.bytes !== pointer.bytes) throw new AgentMemoryError("INDEX_INCOMPLETE", "Generation completion record does not match the snapshot.");
		await assertNoCompetingGeneration(this.storage, `${this.base}/generations`, complete);
		const generation = parseAgentJson<AgentGeneration>(serialized, pointer.path);
		validateGeneration(generation, pointer, policy);
		for (const item of [...generation.meetings, ...generation.projects]) {
			if (!isWithinAgentRoots(item.path, roots)) continue;
			const expected = generation.metadataRevisions?.[item.path];
			const content = await read(item.path);
			if (!expected || expected !== item.sourceRevision || content === null || await agentSha256(normalizedSource(content)) !== expected) {
				throw new AgentMemoryError("SOURCE_CHANGED", "Catalog metadata changed, is missing or has no verified revision. Open Echo Notes, refresh the catalog and publish a new Agent snapshot.", item.path);
			}
		}
		const warnings: AgentIssue[] = [];
		const documents: EvidenceDocument[] = [];
		for (const document of generation.documents) {
			if (!isWithinAgentRoots(document.sourcePath, roots)) continue;
			const needsText = request.command === "context" || request.command === "export" || (request.command === "search" && request.kind === "evidence") || (request.command === "read" && request.id === document.sourceId);
			if (!needsText || !kinds.some((kind) => kind === "transcript" || kind === "analysis")) continue;
			const content = await read(document.sourcePath);
			const revision = content === null ? null : await agentSha256(normalizedSource(content));
			const sourceCheck = revision === null ? "missing" : revision === generation.sourceRevisions[document.sourcePath] ? "verified" : "changed";
			if (sourceCheck === "changed") throw new AgentMemoryError("SOURCE_CHANGED", "The registered source changed since publication. Open Echo Notes, refresh the catalog and publish a new Agent snapshot before reading its text.", document.sourcePath);
			if (sourceCheck === "missing") warnings.push({ code: "SOURCE_MISSING", message: "A source is missing from the published scope.", path: document.sourcePath });
			if (kinds.some((kind) => kind === "transcript" || kind === "analysis")) documents.push({ ...document, content: content ?? "", missing: content === null });
		}
		if (kinds.includes("approved_memory") && generation.relationPath && generation.authorityFiles[generation.relationPath] && await read(generation.relationPath) === null) {
			throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "The previously registered relationship store is missing. Restore it before claiming current memory.", generation.relationPath);
		}
		const projection = kinds.includes("approved_memory")
			? await readMemoryProjection({ ...this.storage, read, list: (path) => this.storage.list(path), write: (path, content, options) => this.storage.write(path, content, options) }, { authorityRoots: generation.authorityRoots, relationPath: generation.relationPath, documents: generation.documents, checkedAt, sourceRevisions: generation.sourceRevisions, allowedRoots: roots, verifySources: false })
			: { items: [], staleRelationIds: [], dependencyHashes: {} };
		const authorityFiles = projection.dependencyHashes;
		if (kinds.includes("approved_memory") && agentJson(authorityFiles) !== agentJson(generation.authorityFiles)) warnings.push({ code: "AUTHORITY_UNVERIFIED", message: "Authority files changed after publication. Current saved authority was re-evaluated." });
		if (projection.staleRelationIds.length) warnings.push({ code: "AUTHORITY_UNVERIFIED", message: "Historical relation endpoints no longer match current Review values and were excluded." });
		const memories = projection.items.filter((item) => item.sourcePath && isWithinAgentRoots(item.sourcePath, roots));

		return { policy, generation, documents, memories, warnings, reads, authorityFiles, kinds, roots, complete };
	}

	private async query(state: ReaderState, request: AgentReadRequest, checkedAt: string): Promise<unknown> {
		const projects = state.generation.projects.filter((project) => isWithinAgentRoots(project.path, state.roots)).sort(compareStableIds);
		const meetings = state.generation.meetings.filter((meeting) => isWithinAgentRoots(meeting.path, state.roots)).sort(compareStableIds);
		const visibleMemories = (request.includeHistory ? state.memories.filter((item) => item.approval === "approved") : currentProjectedMemories(state.memories)).sort(compareStableIds);
		if (request.command === "doctor") return { policyPath: this.options.policyPath, enabled: true, sourceKinds: state.kinds, allowedRoots: state.roots, generatedAt: state.generation.generatedAt, meetings: meetings.length, projects: projects.length, currentMemory: currentProjectedMemories(state.memories).length, sources: state.generation.documents.filter((document) => isWithinAgentRoots(document.sourcePath, state.roots)).length, sourceVerification: "performed_on_read" };
		if (request.command === "projects") return paginate(projects, request);
		if (request.command === "meetings") {
			const timezone = request.query?.filters.timezone ?? "UTC";
			const projected = meetings.map((meeting) => ({ ...meeting, dates: meeting.time ? meetingDates(meeting.time, timezone) : meeting.date ? [meeting.date] : [] }));
			const selected = projected.filter((meeting) => (!request.projectIds?.length || request.projectIds.some((id) => meeting.projectIds.includes(id))) && ((!request.fromDate && !request.toDate) || meeting.dates.some((date) => (!request.fromDate || date >= request.fromDate) && (!request.toDate || date <= request.toDate))));
			return paginate(selected, request);
		}
		if (request.command === "read") {
			const memory = visibleMemories.find((item) => item.id === request.id);
			if (memory) {
				await this.verifyMemorySources(state, [memory]);
				return publicMemory(memory);
			}
			const source = state.documents.find((item) => item.sourceId === request.id);
			if (source) return this.readSource(source, state, request);
			throw new AgentMemoryError("ITEM_NOT_FOUND", "The requested identity is absent from the current allowed scope.");
		}
		const query = request.query ?? createEvidenceQuery("");
		if (request.command === "search" && request.kind !== "evidence") {
			const matchedIds = new Set(matchMemoryEvidence(visibleMemories, { ...query, includeHistoricalMemory: Boolean(request.includeHistory) }).map((item) => item.id));
			const items = visibleMemories.filter((item) => matchedIds.has(item.id));
			const page = paginate(items, request);
			await this.verifyMemorySources(state, page.items);
			return { ...page, items: page.items.map(publicMemory) };
		}
		if (state.kinds.includes("approved_memory")) await this.verifyMemorySources(state, visibleMemories);
		const narrowed: EvidenceQueryV1 = { ...query, filters: { ...query.filters, sourceKinds: query.filters.sourceKinds.filter((kind) => state.kinds.includes(kind)) } };
		const memories = state.memories.map(evidenceMemory);
		if (request.command === "export") {
			const snapshot = await freezeEvidencePackage(state.documents, narrowed, { packageId: `package-${state.generation.generationId}-${await agentSha256(agentJson(narrowed))}`, frozenAt: checkedAt, checkedAt, generationId: state.generation.generationId, memories });
			return { markdown: renderEvidenceMarkdown(snapshot), snapshot };
		}
		const result = await searchEvidence(state.documents, narrowed, memories);
		return request.command === "search" ? { ...paginate(result.items, request), coverage: result.coverage, issues: result.issues } : result;
	}

	private async readSource(source: EvidenceDocument, state: ReaderState, request: AgentReadRequest): Promise<unknown> {
		if (source.missing) throw new AgentMemoryError("SOURCE_MISSING", "The registered source is missing. Restore it or refresh the catalog.", source.sourcePath);
		const normalized = normalizedSource(source.content);
		const sourceRevision = await agentSha256(normalized);
		const result: Record<string, unknown> = {
			sourceId: source.sourceId,
			meetingId: source.meetingId,
			sourcePath: source.sourcePath,
			title: source.title,
			meetingDate: source.meetingDate,
			projectIds: source.projectIds,
			sourceRevision,
			parserVersion: 1,
			rangeUnit: "utf16_code_unit"
		};
		if (state.kinds.includes("transcript")) {
			const formal = parseFormalTranscript(normalized);
			if (formal.status !== "ok") throw new AgentMemoryError("SOURCE_CHANGED", "The formal transcript boundaries are incomplete or unsupported. Repair the source before reading.", source.sourcePath);
			const sections = formal.ranges.map((range) => ({ ...range, quote: formal.normalizedDocument.slice(range.start, range.end) }));
			result.kind = formal.kind;
			result.sections = sections;
			result.content = sections.map((section) => section.quote).join("\n\n");
		}
		if (request.includeAnalysis && state.kinds.includes("analysis")) {
			const analysis = parseAnalysisSections(normalized);
			if (analysis.status !== "ok") throw new AgentMemoryError("SOURCE_CHANGED", "The analysis section boundaries are incomplete or unsupported.", source.sourcePath);
			result.analysis = analysis.ranges.map((range) => ({ ...range, quote: analysis.normalizedDocument.slice(range.start, range.end) }));
		}
		return result;
	}

	private async verifyMemorySources(state: ReaderState, items: readonly ProjectedMemory[]): Promise<void> {
		for (const item of items) {
			if (!item.sourcePath) continue;
			let content: string | null;
			if (state.reads.has(item.sourcePath)) content = state.reads.get(item.sourcePath)!;
			else {
				content = await this.storage.read(item.sourcePath);
				state.reads.set(item.sourcePath, content);
			}
			const expected = state.generation.sourceRevisions[item.sourcePath];
			const currentRevision = content === null ? null : await agentSha256(normalizedSource(content));
			item.snapshotSourceCheck = currentRevision === null ? "missing" : !expected ? "unsupported" : currentRevision === expected ? "verified" : "changed";
			item.sourceCheck = currentRevision === null ? "missing" : item.sourceRevision ? (currentRevision === item.sourceRevision ? "verified" : "changed") : "unsupported";
			if (item.sourceCheck === "changed" || item.sourceCheck === "missing") state.warnings.push({ code: item.sourceCheck === "missing" ? "SOURCE_MISSING" : "SOURCE_CHANGED", message: "A returned memory source changed or is missing. Approval history is preserved separately.", path: item.sourcePath });
		}
	}

	private async verifyState(state: ReaderState): Promise<void> {
		for (const [path, text] of state.reads) {
			if (await this.storage.read(path) !== text) throw new AgentMemoryError("DATA_UPDATING", "Saved files changed during the read. Retrying against a consistent generation.");
		}
		if (state.kinds.includes("approved_memory") && agentJson(await collectAuthorityFiles(this.storage, state.generation.authorityRoots, state.generation.relationPath)) !== agentJson(state.authorityFiles)) throw new AgentMemoryError("DATA_UPDATING", "The authority file set changed during the read.");
		await assertNoCompetingGeneration(this.storage, `${this.base}/generations`, state.complete);
	}

	private response(command: string, checkedAt: string, state: ReaderState, data: unknown): AgentResponse {
		return {
			protocolVersion: 1, command, vaultId: state.policy.vaultId, generationId: state.generation.generationId,
			status: state.warnings.length ? "partial" : "ok", checkedAt,
			freshness: { index: "as_of_snapshot", returnedItems: state.warnings.length ? "partial" : "verified", scopeCompleteness: "as_of_snapshot", generatedAt: state.generation.generatedAt },
			data, warnings: state.warnings, errors: []
		};
	}
}

function intersectRoots(policy: string[], local?: string[]): string[] {
	if (!local) return policy;
	const result = new Set<string>();
	for (const left of policy) {
		for (const right of local) {
			if (isWithinAgentRoots(left, [right])) result.add(left);
			if (isWithinAgentRoots(right, [left])) result.add(right);
		}
	}
	return [...result].sort();
}

function materialKinds(request: AgentReadRequest, configured: EvidenceKind[]): EvidenceKind[] {
	if (request.command === "search" && request.kind !== "evidence") return ["approved_memory"];
	if (["context", "export"].includes(request.command) || (request.command === "search" && request.kind === "evidence")) return request.query?.filters.sourceKinds ?? ["transcript"];
	if (request.command === "read") return configured.filter((kind) => kind !== "analysis" || request.includeAnalysis);
	return configured;
}

function paginate<T>(items: readonly T[], request: AgentReadRequest): { items: T[]; nextCursor: string | null; totalMatched: number } {
	const offset = request.cursor ? Number(request.cursor) : 0;
	const limit = request.limit ?? 20;
	if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new AgentMemoryError("INVALID_QUERY", "Use a non-negative cursor and a limit from 1 through 500.");
	return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null, totalMatched: items.length };
}

function publicMemory(item: ProjectedMemory): unknown {
	return { id: item.id, text: item.text, approval: item.approval, authority: item.authority, storedValidity: item.storedValidity, resolvedValidity: item.resolvedValidity, effectiveType: item.effectiveType, effectiveTier: item.effectiveTier, validFrom: item.validFrom, validUntil: item.validUntil, sourceId: item.sourceId, sourcePath: item.sourcePath, sourceCheck: item.sourceCheck, sourceRevision: item.sourceRevision, snapshotSourceCheck: item.snapshotSourceCheck, meetingId: item.meetingId, meetingDate: item.meetingDate, meetingDates: item.meetingDates, meetingTime: item.meetingTime, projectIds: item.projectIds, candidateId: item.candidateId, assertionId: item.assertionId, candidatePath: item.candidatePath, reviewPath: item.reviewPath, checkedAt: item.checkedAt };
}

function evidenceMemory(item: ProjectedMemory): EvidenceMemory {
	return { id: item.id, text: item.text, approval: item.approval, resolvedValidity: item.resolvedValidity, sourceId: item.sourceId, sourcePath: item.sourcePath, meetingId: item.meetingId, meetingDate: item.meetingDate, meetingDates: item.meetingDates, meetingTime: item.meetingTime, projectIds: item.projectIds, sourceCheck: item.sourceCheck, authority: item.authority, validFrom: item.validFrom, validUntil: item.validUntil };
}

function validateGeneration(generation: AgentGeneration, pointer: AgentCurrentPointer, policy: AgentAccessPolicy): void {
	if (generation.schemaVersion !== 1 || generation.protocolVersion !== 1) throw new AgentMemoryError("SCHEMA_UNSUPPORTED", "The snapshot requires a newer reader protocol.");
	if (generation.generationId !== pointer.generationId || generation.vaultId !== policy.vaultId || !Array.isArray(generation.documents) || !Array.isArray(generation.meetings) || !Array.isArray(generation.projects) || !Array.isArray(generation.authorityRoots) || !generation.sourceRevisions || !generation.authorityFiles) throw new AgentMemoryError("INDEX_INCOMPLETE", "The generation identity or catalog is invalid.");
	for (const group of [generation.documents.map((item) => item.sourceId), generation.meetings.map((item) => item.id), generation.projects.map((item) => item.id)]) {
		if (new Set(group).size !== group.length) throw new AgentMemoryError("IDENTITY_CONFLICT", "The snapshot contains duplicate stable identities.");
	}
}

function compareStableIds(left: { id: string }, right: { id: string }): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

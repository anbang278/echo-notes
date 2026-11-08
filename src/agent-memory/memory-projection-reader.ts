import type { EvidenceDocument } from "../evidence/evidence-types";
import { parseMemoryCandidate } from "../memory/memory-output";
import { currentProjectedMemories, projectMemories, type MemoryProjectionPackage, type MemoryProjectionSource, type MemoryProjectionResult } from "../memory/memory-projection";
import { createMemoryRelationStore, parseMemoryRelationStore } from "../memory/memory-relation";
import { getMemoryReviewPath, parseMemoryReview } from "../memory/memory-review";
import { collectAuthorityFiles } from "./agent-export";
import { AgentMemoryError, type AgentMemoryStorage } from "./agent-memory-types";
import { agentJson, agentSha256, isWithinAgentRoots, normalizedSource } from "./agent-memory-utils";

export interface ReadMemoryProjectionOptions {
	authorityRoots: string[];
	relationPath?: string;
	documents: readonly EvidenceDocument[];
	checkedAt: string;
	sourceRevisions?: Record<string, string>;
	allowedRoots?: string[];
	/** Reader queries verify only returned sources after selecting current memory. */
	verifySources?: boolean;
}

export interface ReadMemoryProjectionResult extends MemoryProjectionResult {
	dependencyHashes: Record<string, string>;
	currentCount: number;
}

/** Local UI and external reader share current authority parsing without writing sidecars. */
export async function readMemoryProjection(storage: AgentMemoryStorage, options: ReadMemoryProjectionOptions): Promise<ReadMemoryProjectionResult> {
	for (const path of [...options.authorityRoots, ...(options.relationPath ? [options.relationPath] : [])]) {
		if (options.allowedRoots && !isWithinAgentRoots(path, options.allowedRoots)) throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "The selected scope cannot verify all current memory authority.", path);
	}
	const dependencyHashes = await collectAuthorityFiles(storage, options.authorityRoots, options.relationPath);
	const reads = new Map<string, string | null>();
	const read = async (path: string): Promise<string | null> => {
		const text = await storage.read(path);
		reads.set(path, text);
		return text;
	};
	const packages: MemoryProjectionPackage[] = [];
	let relations = createMemoryRelationStore(options.checkedAt);
	for (const file of Object.keys(dependencyHashes)) {
		const text = await read(file);
		if (text === null) throw new AgentMemoryError("DATA_UPDATING", "The authority set changed during reading.", file);
		if (file === options.relationPath) {
			const parsed = parseMemoryRelationStore(text);
			if (!parsed) throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "The relationship store cannot be parsed.", file);
			relations = parsed;
			continue;
		}
		if (file.endsWith(".json")) throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "An unregistered relationship record was found.", file);
		if (file.toLowerCase().endsWith(".review.md")) continue;
		try {
			const candidate = parseMemoryCandidate(text);
			const reviewPath = getMemoryReviewPath(file);
			const reviewText = await read(reviewPath);
			const review = reviewText === null ? null : parseMemoryReview(reviewText);
			packages.push({ candidatePath: file, reviewPath, candidate, review });
		} catch (error) {
			if (error instanceof AgentMemoryError) throw error;
			throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "A Candidate or Review record cannot be verified.", file);
		}
	}
	for (const file of Object.keys(dependencyHashes).filter((file) => file.toLowerCase().endsWith(".review.md"))) {
		if (!packages.some((item) => item.reviewPath === file)) throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "An orphan Review sidecar changed the authority set.", file);
	}
	const identities = packages.flatMap((item) => item.candidate.assertions.map((assertion) => `${item.candidate.id}\n${assertion.id}`));
	if (new Set(identities).size !== identities.length || new Set(packages.map((item) => item.candidate.id)).size !== packages.length) throw new AgentMemoryError("IDENTITY_CONFLICT", "Duplicate Candidate or memory identity in registered authority directories.");
	const sourceIdentities = options.documents.map((document) => document.sourceId);
	if (new Set(sourceIdentities).size !== sourceIdentities.length) throw new AgentMemoryError("IDENTITY_CONFLICT", "Duplicate registered source identity.");
	const sources: MemoryProjectionSource[] = [];
	for (const document of options.documents) {
		if (options.allowedRoots && !isWithinAgentRoots(document.sourcePath, options.allowedRoots)) continue;
		if (options.verifySources === false) {
			sources.push({ path: document.sourcePath, sourceId: document.sourceId, meetingId: document.meetingId, meetingDate: document.meetingDate, meetingDates: document.meetingDates, meetingTime: document.meetingTime, projectIds: document.projectIds, sourceCheck: "unsupported" });
			continue;
		}
		const current = await read(document.sourcePath);
		const expected = options.sourceRevisions?.[document.sourcePath] ?? await agentSha256(normalizedSource(document.content));
		const currentRevision = current === null ? null : await agentSha256(normalizedSource(current));
		sources.push({ path: document.sourcePath, sourceId: document.sourceId, meetingId: document.meetingId, meetingDate: document.meetingDate, meetingDates: document.meetingDates, meetingTime: document.meetingTime, projectIds: document.projectIds, sourceRevision: currentRevision ?? undefined, sourceCheck: currentRevision === null ? "missing" : currentRevision === expected ? "verified" : "changed" });
	}
	let result;
	try { result = projectMemories(packages, relations, options.checkedAt, sources); } catch {
		throw new AgentMemoryError("AUTHORITY_UNVERIFIED", "Current Review records do not match their immutable Candidate packages.");
	}
	for (const [file, text] of reads) {
		if (await storage.read(file) !== text) throw new AgentMemoryError("DATA_UPDATING", "Memory dependencies changed during reading.", file);
	}
	if (agentJson(await collectAuthorityFiles(storage, options.authorityRoots, options.relationPath)) !== agentJson(dependencyHashes)) throw new AgentMemoryError("DATA_UPDATING", "Memory authority files were added, removed or moved during reading.");
	return { ...result, dependencyHashes, currentCount: currentProjectedMemories(result.items).length };
}

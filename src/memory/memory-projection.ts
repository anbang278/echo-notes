import type { MeetingTime } from "../catalog/catalog-types";
import type { EvidenceMemory, SourceCheck } from "../evidence/evidence-types";
import { createMemoryRelationEndpoint, getMemoryRelationEndpointKey, resolveMemoryRelations, type MemoryRelationStore } from "./memory-relation";
import { validateMemoryReviewForCandidate } from "./memory-review";
import type { MemoryAssertion, MemoryAssertionReview, MemoryCandidatePackage, MemoryReviewPackage, MemoryTier, MemoryType, MemoryAuthority, MemoryValidity } from "./memory-types";

export interface MemoryProjectionPackage {
	candidatePath: string;
	reviewPath: string;
	candidate: MemoryCandidatePackage;
	review: MemoryReviewPackage | null;
}

export interface MemoryProjectionSource {
	path: string;
	sourceId?: string;
	meetingId?: string;
	meetingDate?: string;
	meetingDates?: string[];
	meetingTime?: MeetingTime;
	projectIds?: string[];
	sourceCheck: SourceCheck;
	sourceRevision?: string;
}

export interface ProjectedMemory extends EvidenceMemory {
	candidateId: string;
	assertionId: string;
	candidatePath: string;
	reviewPath: string;
	assertion: MemoryAssertion;
	review: MemoryAssertionReview | null;
	effectiveType: MemoryType;
	effectiveTier: MemoryTier;
	authority: MemoryAuthority;
	storedValidity: MemoryValidity;
	resolvedValidity: "active" | "historical" | "superseded" | "invalidated" | "expired" | "not_yet_valid" | "uncertain";
	checkedAt: string;
	meetingDates?: string[];
	meetingTime?: MeetingTime;
	sourceRevision?: string;
	snapshotSourceCheck?: SourceCheck;
}

export interface MemoryProjectionResult {
	items: ProjectedMemory[];
	staleRelationIds: string[];
}

export function projectMemories(
	packages: readonly MemoryProjectionPackage[],
	relations: MemoryRelationStore,
	checkedAt: string,
	sources: readonly MemoryProjectionSource[] = []
): MemoryProjectionResult {
	const now = Date.parse(checkedAt);
	if (!Number.isFinite(now)) throw new Error("Memory projection requires a valid checkedAt instant.");
	const sourceMap = new Map(sources.map((source) => [source.path, source]));
	const sourcesById = new Map(sources.filter((source) => source.sourceId).map((source) => [source.sourceId!, source]));
	const items = packages.flatMap((item) => {
		if (item.review) validateMemoryReviewForCandidate(item.review, item.candidate, item.candidatePath);
		return item.candidate.assertions.map((assertion): ProjectedMemory => {
			const review = item.review?.reviews[assertion.id] ?? null;
			const storedSourceId = item.candidate.source.sourceId;
			const source = (storedSourceId ? sourcesById.get(storedSourceId) : undefined) ?? sourceMap.get(assertion.sourcePath);
			const effectiveType = review?.effectiveType ?? assertion.memoryType ?? "fact";
			const effectiveTier = review?.effectiveTier ?? (assertion.proposedTier === "working" ? "working" : "long_term");
			const validFrom = review?.validFrom ?? assertion.temporal?.validFrom;
			const validUntil = review?.validUntil ?? assertion.temporal?.validUntil;
			const storedValidity = review?.validity ?? "active";
			const storedRevision = item.candidate.source.sourceRevision;
			const sourceCheck = source?.sourceCheck;
			const approvalSourceCheck = sourceCheck === "missing" || sourceCheck === "changed"
				? sourceCheck
				: storedSourceId && source?.sourceId && storedSourceId !== source.sourceId ? "ambiguous"
					: storedSourceId && storedRevision && source?.sourceRevision ? (storedRevision === source.sourceRevision ? "verified" : "changed") : "unsupported";
			return {
				id: `memory:${item.candidate.id}:${assertion.id}`,
				text: review?.effectiveValue ?? assertion.value,
				approval: review?.status ?? "unverified",
				candidateId: item.candidate.id,
				assertionId: assertion.id,
				candidatePath: item.candidatePath,
				reviewPath: item.reviewPath,
				assertion: { ...assertion, value: review?.effectiveValue ?? assertion.value, memoryType: effectiveType },
				review,
				effectiveType,
				effectiveTier,
				authority: review?.authority ?? "evidence_backed",
				storedValidity,
				resolvedValidity: resolveTemporalValidity(storedValidity, validFrom, validUntil, now),
				validFrom,
				validUntil,
				sourcePath: source?.path ?? assertion.sourcePath,
				sourceId: source?.sourceId,
				meetingId: source?.meetingId,
				meetingDate: source?.meetingDate,
				meetingDates: source?.meetingDates,
				meetingTime: source?.meetingTime,
				projectIds: source?.projectIds,
				sourceCheck: approvalSourceCheck,
				sourceRevision: storedRevision,
				snapshotSourceCheck: sourceCheck,
				checkedAt
			};
		});
	});
	const packageMap = new Map(packages.map((item) => [item.candidatePath, item]));
	const approved = items.filter((item) => item.approval === "approved");
	const endpoints = approved.map((item) => createMemoryRelationEndpoint({
		candidate: packageMap.get(item.candidatePath)!.candidate,
		candidatePath: item.candidatePath,
		reviewPath: item.reviewPath,
		assertion: item.assertion
	}));
	const resolution = resolveMemoryRelations(relations, endpoints);
	const byEndpoint = new Map(approved.map((item, index) => [getMemoryRelationEndpointKey(endpoints[index]), item]));
	for (const relationId of resolution.applicableRelationIds) {
		const relation = relations.relations[relationId];
		const source = byEndpoint.get(getMemoryRelationEndpointKey(relation.source));
		const target = byEndpoint.get(getMemoryRelationEndpointKey(relation.target));
		if (!source || !target) continue;
		if (relation.type === "supersedes") target.resolvedValidity = "superseded";
		if (relation.type === "invalidates") target.resolvedValidity = "invalidated";
	}
	return { items, staleRelationIds: [...resolution.staleRelationIds].sort() };
}

export function currentProjectedMemories(items: readonly ProjectedMemory[]): ProjectedMemory[] {
	return items.filter((item) => item.approval === "approved" && item.resolvedValidity === "active");
}

function resolveTemporalValidity(stored: MemoryValidity, from: string | undefined, until: string | undefined, now: number): ProjectedMemory["resolvedValidity"] {
	const start = from ? parseTemporal(from) : null;
	const end = until ? parseTemporal(until) : null;
	if ((from && start === null) || (until && end === null) || (start !== null && end !== null && start > end)) return "uncertain";
	if (start !== null && now < start) return "not_yet_valid";
	if (end !== null && now >= end) return "expired";
	return stored;
}

function parseTemporal(value: string): number | null {
	if (!/^\d{4}-\d{2}-\d{2}(?:T.*(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return null;
	const date = value.slice(0, 10);
	const day = new Date(`${date}T00:00:00Z`);
	if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

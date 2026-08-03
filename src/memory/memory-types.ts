import type { CopyLanguage } from "../settings/settings";

export const MEMORY_SCHEMA_VERSION = 1;
export const MEMORY_REVIEW_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTION_PROMPT_VERSION = 2;

export const MEMORY_SUBJECT_TYPES = ["user", "person", "organization", "project"] as const;
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];

export const MEMORY_CATEGORIES = [
	"mission-goal",
	"decision-principle",
	"mental-model",
	"lesson",
	"idea-challenge",
	"writing-collaboration",
	"background",
	"privacy-boundary",
	"relationship",
	"responsibility",
	"status",
	"other"
] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export interface MemoryUserProfile {
	displayName: string;
	role: string;
	recentGoal: string;
}

export interface MemoryPaths {
	home: string;
	meetingsDir: string;
	candidatesDir: string;
	peopleDir: string;
	organizationsDir: string;
	projectsDir: string;
	userDir: string;
	soul: string;
	userProfiles: Record<MemoryUserCategory, string>;
	aggregationsDir: string;
	projectAggregation: string;
	peopleAggregation: string;
	timelineAggregation: string;
	contextPackagesDir: string;
	systemDir: string;
	manifest: string;
	logsDir: string;
}

export type MemoryUserCategory = Exclude<
	MemoryCategory,
	"relationship" | "responsibility" | "status" | "other"
>;

export interface MemoryRunRecord {
	fingerprint: string;
	transcriptPath: string;
	candidatePath: string;
	meetingPath: string;
	provider: string;
	model: string;
	createdAt: string;
	compiledAt?: string;
}

export interface EchoMemoryManifest {
	schemaVersion: number;
	rootFolder: string;
	language: CopyLanguage;
	initializedAt: string;
	user: MemoryUserProfile;
	paths: MemoryPaths;
	runs: Record<string, MemoryRunRecord>;
	entityIndex: Record<string, string>;
	lastCompiledAt?: string;
}

export interface RawMemoryAssertion {
	subjectType: MemorySubjectType;
	subjectName: string;
	category: MemoryCategory;
	predicate: string;
	value: string;
	confidence: number;
	evidenceQuote: string;
}

export interface MemoryAssertion extends RawMemoryAssertion {
	id: string;
	observedAt: string;
	sourcePath: string;
	chunkIndex: number;
}

export interface MemoryCandidatePackage {
	schemaVersion: number;
	id: string;
	fingerprint: string;
	createdAt: string;
	provider: string;
	model: string;
	traceIds: string[];
	rejectedAssertionCount?: number;
	source: {
		transcriptPath: string;
		transcriptTitle: string;
		analysisTemplateIds: string[];
	};
	assertions: MemoryAssertion[];
}

export const MEMORY_REVIEW_STATUSES = ["pending", "approved", "rejected"] as const;
export type MemoryReviewStatus = (typeof MEMORY_REVIEW_STATUSES)[number];

export interface MemoryReviewEvent {
	at: string;
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
}

export interface MemoryAssertionReview {
	assertionId: string;
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
	reviewedAt: string;
	history: MemoryReviewEvent[];
}

export interface MemoryReviewPackage {
	schemaVersion: number;
	candidateId: string;
	candidateFingerprint: string;
	candidatePath: string;
	updatedAt: string;
	reviews: Record<string, MemoryAssertionReview>;
}

export interface MemoryReviewUpdate {
	assertionId: string;
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
}

export interface MemoryExtractionResponse {
	assertions: RawMemoryAssertion[];
}

export interface MemoryExtractionResult {
	skipped: boolean;
	candidateFilePath: string;
	meetingFilePath: string;
	assertionCount: number;
	rejectedAssertionCount: number;
	compiled: boolean;
	provider: string;
	model: string;
	traceIds: string[];
}

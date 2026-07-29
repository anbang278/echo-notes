import type { CopyLanguage } from "../settings/settings";

export const MEMORY_SCHEMA_VERSION = 1;

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
	source: {
		transcriptPath: string;
		transcriptTitle: string;
		analysisTemplateIds: string[];
	};
	assertions: MemoryAssertion[];
}

export interface MemoryExtractionResponse {
	assertions: RawMemoryAssertion[];
}

export interface MemoryExtractionResult {
	skipped: boolean;
	candidateFilePath: string;
	meetingFilePath: string;
	assertionCount: number;
	compiled: boolean;
	provider: string;
	model: string;
	traceIds: string[];
}

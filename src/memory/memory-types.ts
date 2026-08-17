import type { CopyLanguage } from "../settings/settings";

export const MEMORY_MANIFEST_SCHEMA_VERSION = 1;
export const MEMORY_CANDIDATE_SCHEMA_VERSION = 2;
export const MEMORY_CANDIDATE_LEGACY_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);
export const MEMORY_REVIEW_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTION_PROMPT_VERSION = 3;

export const MEMORY_SUBJECT_TYPES = ["user", "person", "organization", "project"] as const;
export type MemorySubjectType = (typeof MEMORY_SUBJECT_TYPES)[number];

export const MEMORY_TYPES = ["fact", "decision", "preference", "belief", "experience", "goal"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_PROPOSED_TIERS = ["working", "long_term", "core_candidate"] as const;
export type ProposedMemoryTier = (typeof MEMORY_PROPOSED_TIERS)[number];

export const MEMORY_TIERS = ["working", "long_term", "core"] as const;
export type MemoryTier = (typeof MEMORY_TIERS)[number];

export const MEMORY_AUTHORITIES = [
	"inferred",
	"evidence_backed",
	"repeated_evidence",
	"user_confirmed",
	"core_declared"
] as const;
export type MemoryAuthority = (typeof MEMORY_AUTHORITIES)[number];

export const MEMORY_VALIDITIES = ["active", "historical", "uncertain"] as const;
export type MemoryValidity = (typeof MEMORY_VALIDITIES)[number];

export const MEMORY_TEMPORAL_SCOPES = ["point", "ongoing", "interval", "unknown"] as const;
export type MemoryTemporalScope = (typeof MEMORY_TEMPORAL_SCOPES)[number];

export interface MemoryTemporal {
	validFrom?: string;
	validUntil?: string;
	scope?: MemoryTemporalScope;
}

export const MEMORY_ADMISSION_RECOMMENDATIONS = [
	"low_priority",
	"working_candidate",
	"long_term_candidate",
	"core_candidate"
] as const;
export type MemoryAdmissionRecommendation = (typeof MEMORY_ADMISSION_RECOMMENDATIONS)[number];

export interface MemoryAdmissionDimensions {
	futureRelevance: number;
	personalSpecificity: number;
	persistence: number;
	impact: number;
	evidenceQuality: number;
	novelty: number;
}

export interface MemoryAdmissionResult {
	score: number;
	recommendation: MemoryAdmissionRecommendation;
	dimensions: MemoryAdmissionDimensions;
	reasons: string[];
	evaluatorVersion: string;
	evaluatedAt: string;
}

export const MEMORY_CONTEXT_PURPOSES = [
	"general",
	"planning",
	"decision",
	"retrospective",
	"self_profile"
] as const;
export type ContextPurpose = (typeof MEMORY_CONTEXT_PURPOSES)[number];

export const MEMORY_TYPE_LABELS: Record<CopyLanguage, Record<MemoryType, string>> = {
	zh: {
		fact: "事实",
		decision: "决策",
		preference: "偏好",
		belief: "信念",
		experience: "经验",
		goal: "目标"
	},
	en: {
		fact: "Fact",
		decision: "Decision",
		preference: "Preference",
		belief: "Belief",
		experience: "Experience",
		goal: "Goal"
	}
};

export const MEMORY_PROPOSED_TIER_LABELS: Record<CopyLanguage, Record<ProposedMemoryTier, string>> = {
	zh: { working: "工作记忆", long_term: "长期", core_candidate: "核心候选" },
	en: { working: "Working", long_term: "Long-term", core_candidate: "Core candidate" }
};

export const MEMORY_TIER_LABELS: Record<CopyLanguage, Record<MemoryTier, string>> = {
	zh: { working: "工作记忆", long_term: "长期", core: "核心" },
	en: { working: "Working", long_term: "Long-term", core: "Core" }
};

export const MEMORY_AUTHORITY_LABELS: Record<CopyLanguage, Record<MemoryAuthority, string>> = {
	zh: {
		inferred: "A0 AI 推断",
		evidence_backed: "A1 有来源证据",
		repeated_evidence: "A2 多次独立证据",
		user_confirmed: "A3 用户已确认",
		core_declared: "A4 用户声明为核心"
	},
	en: {
		inferred: "A0 Inferred",
		evidence_backed: "A1 Evidence-backed",
		repeated_evidence: "A2 Repeated evidence",
		user_confirmed: "A3 User-confirmed",
		core_declared: "A4 Core-declared"
	}
};

export const MEMORY_VALIDITY_LABELS: Record<CopyLanguage, Record<MemoryValidity, string>> = {
	zh: { active: "当前有效", historical: "历史状态", uncertain: "待确认" },
	en: { active: "Active", historical: "Historical", uncertain: "Uncertain" }
};

export function formatMemoryType(value: MemoryType | undefined, language: CopyLanguage = "zh"): string {
	if (!value) {
		return language === "en" ? "Unclassified" : "未分类";
	}
	return MEMORY_TYPE_LABELS[language][value];
}

export function formatProposedTier(
	value: ProposedMemoryTier | undefined,
	language: CopyLanguage = "zh"
): string {
	if (!value) {
		return language === "en" ? "Long-term" : "长期";
	}
	return MEMORY_PROPOSED_TIER_LABELS[language][value];
}

export function formatMemoryTier(value: MemoryTier | undefined, language: CopyLanguage = "zh"): string {
	if (!value) {
		return language === "en" ? "Unclassified" : "未分类";
	}
	return MEMORY_TIER_LABELS[language][value];
}

export function formatMemoryAuthority(
	value: MemoryAuthority | undefined,
	language: CopyLanguage = "zh"
): string {
	if (!value) {
		return language === "en" ? "Unclassified" : "未分类";
	}
	return MEMORY_AUTHORITY_LABELS[language][value];
}

export function formatMemoryValidity(
	value: MemoryValidity | undefined,
	language: CopyLanguage = "zh"
): string {
	if (!value) {
		return language === "en" ? "Unclassified" : "未分类";
	}
	return MEMORY_VALIDITY_LABELS[language][value];
}

export function isLongTermMemory(value: ProposedMemoryTier | undefined): boolean {
	return value === undefined || value === "long_term" || value === "core_candidate";
}

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
	transcriptionEnhancementDir: string;
	transcriptionEnhancement: string;
	transcriptionEnhancementCandidates: string;
	transcriptionEnhancementLegacyBackup: string;
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
	memoryType?: MemoryType;
	proposedTier?: ProposedMemoryTier;
	temporal?: MemoryTemporal;
	whyRemember?: string;
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

export const MEMORY_REVIEW_EVENT_TYPES = [
	"created",
	"approved",
	"corrected",
	"rejected",
	"reset",
	"tier_changed",
	"type_changed",
	"validity_changed",
	"promoted_to_core",
	"demoted_from_core"
] as const;
export type MemoryReviewEventType = (typeof MEMORY_REVIEW_EVENT_TYPES)[number];

export interface MemoryReviewEvent {
	at: string;
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
	type?: MemoryReviewEventType;
	effectiveType?: MemoryType;
	effectiveTier?: MemoryTier;
	authority?: MemoryAuthority;
	validity?: MemoryValidity;
}

export interface MemoryAssertionReview {
	assertionId: string;
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
	reviewedAt: string;
	effectiveType?: MemoryType;
	effectiveTier?: MemoryTier;
	authority?: MemoryAuthority;
	validity?: MemoryValidity;
	validFrom?: string;
	validUntil?: string;
	admission?: MemoryAdmissionResult;
	reviewAfter?: string;
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
	effectiveType?: MemoryType;
	effectiveTier?: MemoryTier;
	authority?: MemoryAuthority;
	validity?: MemoryValidity;
	validFrom?: string;
	validUntil?: string;
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

export type MemoryControlCenterActionId =
	| "initialize"
	| "configure-model"
	| "review"
	| "extract-current"
	| "select-source";

export interface MemoryControlCenterSummary {
	initialized: boolean;
	modelReady: boolean;
	autoEnabled: boolean;
	pending: {
		total: number;
		coreCandidate: number;
		longTermCandidate: number;
		workingCandidate: number;
		lowPriority: number;
	} | null;
	nextAction: {
		id: MemoryControlCenterActionId;
		title: string;
		description: string;
		label: string;
		hint: string;
	};
}

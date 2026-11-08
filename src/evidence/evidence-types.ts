import type { MeetingTime } from "../catalog/catalog-types";

export type EvidenceKind = "transcript" | "approved_memory" | "analysis";
export type SourceCheck = "verified" | "changed" | "missing" | "ambiguous" | "unsupported";

/** A registered, explicitly allowed document read from one source snapshot. */
export interface EvidenceDocument {
	sourceId: string;
	meetingId: string;
	sourcePath: string;
	content: string;
	missing?: boolean;
	title: string;
	meetingDate?: string;
	meetingDates?: string[];
	meetingTime?: MeetingTime;
	projectIds: string[];
	tags?: string[];
}

export interface EvidenceQueryV1 {
	protocolVersion: 1;
	question: string;
	keywords: string[];
	exactPhrases: string[];
	filters: {
		projectIds: string[];
		meetingIds: string[];
		fromDate?: string;
		toDateInclusive?: string;
		timezone: string;
		sourceKinds: EvidenceKind[];
	};
	includeHistoricalMemory: boolean;
	retrievalMode: "lexical";
	maxCharacters: number;
	contextBefore: number;
	contextAfter: number;
	pinnedEvidenceIds: string[];
	excludedEvidenceIds: string[];
}

export interface SourceRange {
	start: number;
	end: number;
}

export interface FormalParagraph extends SourceRange {
	text: string;
	sectionIndex: number;
	speaker?: string;
}

export interface FormalTranscript {
	parserVersion: 1;
	status: "ok" | "unsupported";
	kind: "transcript" | "revised_transcript";
	normalizedDocument: string;
	ranges: SourceRange[];
	paragraphs: FormalParagraph[];
	errors: string[];
}

export interface EvidenceMatch {
	term: string;
	kind: "keyword" | "phrase" | "bigram" | "scope";
}

export interface EvidenceItem {
	evidenceId: string;
	sourceId: string;
	sourceRevision: string;
	sourcePath: string;
	sourceRange: SourceRange;
	meetingId: string;
	meetingTitle: string;
	meetingDate?: string;
	projectIds: string[];
	kind: "transcript" | "revised_transcript" | "analysis";
	quote: string;
	contextBefore: string;
	contextAfter: string;
	contextRange: SourceRange;
	speaker?: string;
	matches: EvidenceMatch[];
	score: number;
	sourceCheck: SourceCheck;
}

/** The memory owner supplies already jointly evaluated authority and provenance. */
export interface EvidenceMemory {
	id: string;
	text: string;
	approval: "approved" | "pending" | "rejected" | "unverified";
	resolvedValidity: string;
	sourceId?: string;
	sourcePath?: string;
	meetingId?: string;
	meetingDate?: string;
	meetingDates?: string[];
	meetingTime?: MeetingTime;
	projectIds?: string[];
	sourceCheck?: SourceCheck;
	authority?: string;
	validFrom?: string;
	validUntil?: string;
}

export interface EvidenceIssue {
	sourceId?: string;
	sourcePath?: string;
	code: "SOURCE_CHANGED" | "SOURCE_MISSING" | "IDENTITY_CONFLICT" | "SOURCE_UNSUPPORTED" | "PINNED_EVIDENCE_MISSING" | "PINNED_OVER_BUDGET";
	message: string;
}

export interface EvidenceCoverage {
	scannedMeetings: number;
	matchedMeetings: number;
	includedMeetings: number;
	matchedItems: number;
	includedItems: number;
	omittedByBudget: number;
	excludedByUser: number;
	abnormalSources: number;
	characters: number;
	matchedMemories: number;
	includedMemories: number;
	omittedMemories: number;
	budgetUnit: "unicode_code_point";
}

export interface EvidenceSearchResult {
	protocolVersion: 1;
	retrievalVersion: 1;
	query: EvidenceQueryV1;
	items: EvidenceItem[];
	selectedItems: EvidenceItem[];
	memories: EvidenceMemory[];
	coverage: EvidenceCoverage;
	issues: EvidenceIssue[];
	canFreeze: boolean;
}

export interface EvidenceValidationResult {
	valid: boolean;
	items: Array<{ evidenceId: string; sourceCheck: SourceCheck }>;
	issues: EvidenceIssue[];
}

export interface EvidenceSnapshot {
	protocolVersion: 1;
	packageId: string;
	frozenAt: string;
	checkedAt: string;
	generationId: string;
	parserVersion: 1;
	retrievalVersion: 1;
	query: EvidenceQueryV1;
	items: EvidenceItem[];
	memories: EvidenceMemory[];
	coverage: EvidenceCoverage;
	issues: EvidenceIssue[];
}

export interface FreezeEvidenceOptions {
	packageId: string;
	frozenAt: string;
	checkedAt?: string;
	generationId?: string;
	memories?: readonly EvidenceMemory[];
	/** Selection from a previous preview. Sources are checked against these exact versions. */
	selection?: readonly EvidenceItem[];
}

export interface QuestionRecord {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	updatedAt: string;
	query: EvidenceQueryV1;
	pinnedEvidence: Array<Pick<EvidenceItem, "evidenceId" | "sourceId" | "sourceRevision" | "sourceRange">>;
	notes: string;
}

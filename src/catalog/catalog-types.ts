import type { MemoryPaths } from "../memory/memory-types";

export type MeetingTime =
	| { precision: "instant"; startedAt: string; endedAt?: string; timezone?: string; source: "user" | "recording"; confirmed: boolean }
	| { precision: "date"; date: string; source: "user" | "legacy"; confirmed: boolean; warning?: string }
	| { precision: "unknown"; reason?: string };

export interface MeetingStages {
	recording: "none" | "recording" | "saved" | "interrupted" | "canceled";
	transcription: "none" | "running" | "done" | "failed";
	analysis: "none" | "running" | "done" | "failed" | "partial_failed";
	memory: "none" | "available";
}

export interface MeetingRecord {
	id: string;
	path: string;
	sourceRevision?: string;
	title: string;
	time: MeetingTime;
	projectIds: string[];
	tags: string[];
	excerpt?: string;
	summary?: string;
	sourceIds: string[];
	recordingIds: string[];
	stages: MeetingStages;
	legacy?: boolean;
	missing?: boolean;
}

export interface ProjectRecord {
	id: string;
	path: string;
	sourceRevision?: string;
	name: string;
	aliases: string[];
	status: "active" | "archived";
	missing?: boolean;
}

export interface CatalogSourceRecord {
	id: string;
	path: string;
	meetingId: string;
	kind: "transcript";
	missing?: boolean;
}

export interface RecordingRecord {
	id: string;
	meetingId: string;
	path?: string;
	sessionKey?: string;
	startedAt?: string;
	endedAt?: string;
	durationMs?: number;
	state: MeetingStages["recording"];
}

export interface CatalogIssue {
	code: "IDENTITY_CONFLICT" | "PARSE_ERROR" | "SOURCE_MISSING" | "PROJECT_MISSING" | "INVALID_METADATA" | "RELATION_CONFLICT";
	path: string;
	message: string;
}

export interface CatalogSnapshot {
	schemaVersion: 1;
	meetings: MeetingRecord[];
	projects: ProjectRecord[];
	sources: CatalogSourceRecord[];
	recordings: RecordingRecord[];
	issues: CatalogIssue[];
}

export interface CatalogPaths {
	rootFolder: string;
	meetingsDir: string;
	projectsDir: string;
	questionsDir: string;
	evidenceDir: string;
	systemDir: string;
	registry: string;
	migrationDir: string;
	memory: MemoryPaths;
}

export interface CatalogStorage {
	ensureFolder?(folder: string): Promise<void>;
	updateProperties?(path: string, changes: Record<string, unknown>): Promise<void>;
	read(path: string): Promise<string | null>;
	list(folder: string): Promise<string[]>;
	create(path: string, content: string): Promise<void>;
	write(path: string, content: string): Promise<void>;
	process(path: string, update: (current: string) => string): Promise<string>;
	remove(path: string): Promise<void>;
}

export interface CatalogYamlCodec {
	parse(source: string): unknown;
	stringify(value: Record<string, unknown>): string;
}

export interface CatalogRepositoryOptions {
	storage: CatalogStorage;
	yaml: CatalogYamlCodec;
	rootFolder: string;
	language: "zh" | "en";
	paths?: MemoryPaths;
	transcriptFolders?: string[];
	now?: () => string;
	createId?: (kind: "mtg" | "prj" | "src" | "rec" | "migration") => string;
}

export interface MeetingRegistration {
	meetingId?: string;
	meetingPath?: string;
	title?: string;
	time?: MeetingTime;
	projectIds?: string[];
}

export interface TranscriptRegistration extends MeetingRegistration {
	transcriptPath: string;
	audioPath?: string;
}

export interface RecordingRegistration extends MeetingRegistration {
	sessionKey?: string;
	audioPath?: string;
	startedAt?: string;
	timezone?: string;
}

export interface CatalogQuery {
	date?: string;
	fromDate?: string;
	toDate?: string;
	timezone: string;
	projectIds?: string[];
	tags?: string[];
	search?: string;
	undated?: boolean;
	unlinked?: boolean;
}

export interface CatalogMigrationItem {
	path: string;
	beforeHash: string | null;
	beforeContent: string | null;
	afterContent: string;
	afterHash: string;
	kind: "meeting" | "project" | "source" | "registry";
}

export interface CatalogMigrationPlan {
	schemaVersion: 1;
	id: string;
	createdAt: string;
	items: CatalogMigrationItem[];
	issues: CatalogIssue[];
}

export interface CatalogMigrationResult {
	id: string;
	written: string[];
	skipped: string[];
	conflicts: Array<{ path: string; message: string }>;
}

import type { MeetingTime } from "../catalog/catalog-types";
import type { EvidenceDocument, EvidenceKind } from "../evidence/evidence-types";

export const AGENT_MEMORY_PROTOCOL_VERSION = 1;

export interface AgentMemoryStorage {
	read(path: string): Promise<string | null>;
	write(path: string, content: string, options?: { exclusive?: boolean }): Promise<void>;
	list(root: string): Promise<string[]>;
}

export interface AgentAccessPolicy {
	schemaVersion: 1;
	vaultId: string;
	version: string;
	enabled: boolean;
	sourceKinds: EvidenceKind[];
	allowedRoots: string[];
	updatedAt: string;
}

export interface AgentMeeting {
	id: string;
	path: string;
	title: string;
	projectIds: string[];
	date?: string;
	time?: MeetingTime;
	/** SHA-256 of the normalized Markdown used to derive this metadata. */
	sourceRevision?: string;
}

export interface AgentProject {
	id: string;
	path: string;
	name: string;
	aliases: string[];
	status: string;
	sourceRevision?: string;
}

export interface AgentPublishInput {
	documents: EvidenceDocument[];
	meetings: AgentMeeting[];
	projects: AgentProject[];
	/** Candidate directories only, recursively enumerated for current authority. */
	authorityRoots: string[];
	/** The existing single relationship store, even when not created yet. */
	relationPath?: string;
}

export interface AgentGeneration extends AgentPublishInput {
	schemaVersion: 1;
	protocolVersion: 1;
	vaultId: string;
	generationId: string;
	generatedAt: string;
	policyVersion: string;
	sourceRevisions: Record<string, string>;
	metadataRevisions: Record<string, string>;
	authorityFiles: Record<string, string>;
}

export interface AgentCurrentPointer {
	schemaVersion: 1;
	generationId: string;
	path: string;
	sha256: string;
	bytes: number;
	completePath: string;
}

export type AgentErrorCode =
	| "VAULT_NOT_CONFIGURED"
	| "VAULT_UNREACHABLE"
	| "EXPORT_DISABLED"
	| "SCHEMA_UNSUPPORTED"
	| "INDEX_INCOMPLETE"
	| "SOURCE_CHANGED"
	| "SOURCE_MISSING"
	| "AUTHORITY_UNVERIFIED"
	| "IDENTITY_CONFLICT"
	| "ACCESS_DENIED"
	| "DATA_UPDATING"
	| "INVALID_QUERY"
	| "ITEM_NOT_FOUND";

export interface AgentIssue {
	code: AgentErrorCode;
	message: string;
	path?: string;
}

export interface AgentResponse<T = unknown> {
	protocolVersion: 1;
	command: string;
	vaultId: string;
	generationId: string;
	status: "ok" | "partial" | "error";
	checkedAt: string;
	freshness: {
		index: "current" | "as_of_snapshot";
		returnedItems: "verified" | "partial" | "unverified";
		scopeCompleteness: "as_of_snapshot";
		generatedAt?: string;
	};
	data: T | null;
	warnings: AgentIssue[];
	errors: AgentIssue[];
}

export class AgentMemoryError extends Error {
	constructor(readonly code: AgentErrorCode, message: string, readonly path?: string) {
		super(message);
		this.name = "AgentMemoryError";
	}
}

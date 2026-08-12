export type DiagnosticTaskKind = "transcription" | "analysis" | "memory";
export type DiagnosticSessionStatus = "running" | "success" | "failed" | "skipped";
export type DiagnosticEventCategory = "environment" | "configuration" | "lifecycle" | "request" | "progress" | "result";

export type DiagnosticScalar = string | number | boolean | null;
export type DiagnosticValue = DiagnosticScalar | DiagnosticValue[] | { [key: string]: DiagnosticValue };

export interface DiagnosticEvent {
	id: string;
	timestamp: number;
	category: DiagnosticEventCategory;
	name: string;
	data?: Record<string, DiagnosticValue>;
	count?: number;
}

export interface DiagnosticSession {
	id: string;
	chainId: string;
	retryOfSessionId?: string;
	kind: DiagnosticTaskKind;
	status: DiagnosticSessionStatus;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	events: DiagnosticEvent[];
}

export interface DiagnosticState {
	schemaVersion: 1;
	enabled: boolean;
	sessions: DiagnosticSession[];
}

export interface DiagnosticSink {
	event(category: DiagnosticEventCategory, name: string, data?: Record<string, unknown>): void;
}

export interface DiagnosticSessionInput {
	kind: DiagnosticTaskKind;
	chainId?: string;
	retryOfSessionId?: string;
}

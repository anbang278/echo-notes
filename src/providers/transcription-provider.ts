import type { TFile } from "obsidian";

export interface TranscriptionInput {
	audioFile: TFile;
	sourceNote?: TFile;
	language?: string;
}

export interface TranscriptionResult {
	text: string;
	provider: string;
	model: string;
	traceId?: string;
	raw?: unknown;
}

export interface TranscriptionProvider {
	id: string;
	name: string;
	transcribe(input: TranscriptionInput): Promise<TranscriptionResult>;
}

export type TranscriptionErrorCode =
	| "missing_api_key"
	| "unsupported_audio"
	| "file_too_large"
	| "api_error"
	| "invalid_response"
	| "network_error";

export class TranscriptionError extends Error {
	code: TranscriptionErrorCode;
	traceId?: string;

	constructor(code: TranscriptionErrorCode, message: string, traceId?: string) {
		super(message);
		this.name = "TranscriptionError";
		this.code = code;
		this.traceId = traceId;
	}
}

export function shouldWriteFailedTranscript(error: unknown): boolean {
	if (!(error instanceof TranscriptionError)) {
		return true;
	}

	return error.code === "api_error" || error.code === "invalid_response" || error.code === "network_error";
}

import type { TFile } from "obsidian";

export interface TranscriptionSegmentRange {
	index: number;
	total: number;
	startSeconds: number;
	endSeconds: number;
}

export interface TranscriptionSegment extends TranscriptionSegmentRange {
	text: string;
	traceId?: string;
}

export type TranscriptionProgress =
	| {
			type: "long-audio-preparing";
			segments: TranscriptionSegment[];
	  }
	| {
			type: "long-audio-started";
			totalSegments: number;
			segments: TranscriptionSegment[];
	  }
	| {
			type: "segment-started";
			segment: TranscriptionSegmentRange;
			segments: TranscriptionSegment[];
	  }
	| {
			type: "segment-completed";
			segment: TranscriptionSegment;
			segments: TranscriptionSegment[];
	  };

export interface TranscriptionInput {
	audioFile: TFile;
	sourceNote?: TFile;
	language?: string;
	onProgress?: (progress: TranscriptionProgress) => Promise<void> | void;
}

export interface TranscriptionResult {
	text: string;
	provider: string;
	model: string;
	traceId?: string;
	segments?: TranscriptionSegment[];
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
	| "audio_decode_error"
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

	return (
		error.code === "audio_decode_error" ||
		error.code === "api_error" ||
		error.code === "invalid_response" ||
		error.code === "network_error"
	);
}

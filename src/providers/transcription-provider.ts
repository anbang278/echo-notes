import type { TFile } from "obsidian";
import type { DiagnosticSink } from "../diagnostics/diagnostic-types";
import { getSanitizedErrorMessage, sanitizeSensitiveText } from "../security/redaction";

export interface TranscriptionSegmentRange {
	index: number;
	total: number;
	startSeconds: number;
	endSeconds: number;
}

export interface TranscriptionSegment extends TranscriptionSegmentRange {
	text: string;
	traceId?: string;
	utterances?: TranscriptionUtterance[];
}

export interface TranscriptionUtterance {
	speakerId: string;
	text: string;
	startSeconds?: number;
	endSeconds?: number;
}

export interface StreamingTranscriptionState {
	text: string;
	utterances?: TranscriptionUtterance[];
	provisionalText?: string;
	realtime?: boolean;
	connectionStatus?: string;
	processedSeconds: number;
	totalSeconds: number;
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
	  }
	| {
			type: "segment-retrying";
			segment?: TranscriptionSegmentRange;
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			httpStatus?: number;
			segments: TranscriptionSegment[];
	  }
	| {
			type: "segment-split";
			segment: TranscriptionSegmentRange;
			replacementSegments: TranscriptionSegmentRange[];
			totalSegments: number;
			segments: TranscriptionSegment[];
	  }
	| {
			type: "whole-audio-request-started";
			attempt: number;
			totalAttempts: number;
			audioBytes: number;
			durationSeconds?: number;
	  }
	| {
			type: "streaming-result";
			text: StreamingTranscriptionState["text"];
			utterances?: StreamingTranscriptionState["utterances"];
			processedSeconds: StreamingTranscriptionState["processedSeconds"];
			totalSeconds: StreamingTranscriptionState["totalSeconds"];
			traceId?: StreamingTranscriptionState["traceId"];
	  };

export interface TranscriptionInput {
	audioFile: TFile;
	sourceNote?: TFile;
	language?: string;
	resumeSegments?: TranscriptionSegment[];
	onProgress?: (progress: TranscriptionProgress) => Promise<void> | void;
	diagnostics?: DiagnosticSink;
}

export interface TranscriptionResult {
	text: string;
	provider: string;
	model: string;
	traceId?: string;
	segments?: TranscriptionSegment[];
	utterances?: TranscriptionUtterance[];
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
	| "unsupported_format"
	| "file_too_large"
	| "audio_decode_error"
	| "authentication_failed"
	| "rate_limited"
	| "quota_exceeded"
	| "invalid_model"
	| "api_error"
	| "invalid_response"
	| "network_error";

export class TranscriptionError extends Error {
	code: TranscriptionErrorCode;
	traceId?: string;
	httpStatus?: number;

	constructor(code: TranscriptionErrorCode, message: string, traceId?: string, httpStatus?: number) {
		super(sanitizeSensitiveText(message));
		this.name = "TranscriptionError";
		this.code = code;
		this.traceId = traceId;
		this.httpStatus = httpStatus;
	}
}

export function createHttpTranscriptionError(
	providerName: string,
	status: number,
	responseText: string,
	traceId?: string
): TranscriptionError {
	const code = classifyHttpTranscriptionError(status, responseText);
	const sanitizedResponse = sanitizeSensitiveText(responseText || "No response body.");
	return new TranscriptionError(
		code,
		`${providerName} API 请求失败：HTTP ${status} ${sanitizedResponse}`,
		traceId,
		status
	);
}

export function createNetworkTranscriptionError(providerName: string, error: unknown): TranscriptionError {
	return new TranscriptionError("network_error", `${providerName} API 调用失败：${getSanitizedErrorMessage(error)}`);
}

export function classifyHttpTranscriptionError(status: number, responseText: string): TranscriptionErrorCode {
	const normalized = responseText.toLowerCase();

	if (status === 401 || status === 403) {
		return "authentication_failed";
	}

	if (status === 413) {
		return "file_too_large";
	}

	if (status === 429) {
		return "rate_limited";
	}

	if (status === 402 || /quota|insufficient_quota|billing|credit|balance/.test(normalized)) {
		return "quota_exceeded";
	}

	if (/invalid[_ -]?model|model_not_found|model not found|no such model|model .*does not exist/.test(normalized)) {
		return "invalid_model";
	}

	return "api_error";
}

export function shouldWriteFailedTranscript(error: unknown): boolean {
	if (!(error instanceof TranscriptionError)) {
		return true;
	}

	return (
		error.code === "audio_decode_error" ||
		error.code === "file_too_large" ||
		error.code === "authentication_failed" ||
		error.code === "rate_limited" ||
		error.code === "quota_exceeded" ||
		error.code === "invalid_model" ||
		error.code === "api_error" ||
		error.code === "invalid_response" ||
		error.code === "network_error"
	);
}

import {
	MOSI_PLAIN_TRANSCRIPTION_MODEL,
	MOSI_PLAIN_TRANSCRIPTION_VERSION,
	MOSI_TRANSCRIPTION_MODEL,
	MOSI_TRANSCRIPTION_VERSION
} from "../settings/settings";
import {
	createHttpTranscriptionError,
	TranscriptionError,
	type TranscriptionUtterance
} from "./transcription-provider";

export interface NormalizedMosiTranscription {
	text: string;
	utterances?: TranscriptionUtterance[];
}

export function buildMosiTranscriptionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/audio/transcriptions")) {
		return normalized;
	}
	if (normalized.endsWith("/v1")) {
		return `${normalized}/audio/transcriptions`;
	}
	return `${normalized}/v1/audio/transcriptions`;
}

export function buildMosiMultipartBody(
	boundary: string,
	audioBuffer: ArrayBuffer,
	fileName: string,
	mimeType: string,
	speakerDiarizationEnabled = true
): ArrayBuffer {
	const parts: MultipartPart[] = [
		{
			name: "model",
			value: speakerDiarizationEnabled
				? MOSI_TRANSCRIPTION_MODEL
				: MOSI_PLAIN_TRANSCRIPTION_MODEL
		},
		{
			name: "version",
			value: speakerDiarizationEnabled
				? MOSI_TRANSCRIPTION_VERSION
				: MOSI_PLAIN_TRANSCRIPTION_VERSION
		},
		{
			name: "response_format",
			value: "json"
		},
		{
			name: "file",
			fileName,
			contentType: mimeType,
			value: audioBuffer
		}
	];
	if (speakerDiarizationEnabled) {
		parts.splice(2, 0, {
			name: "diarize",
			value: "true"
		});
	}
	return buildMultipartBody(boundary, parts);
}

export function normalizeMosiTranscriptionResponse(
	data: unknown,
	speakerDiarizationEnabled = true
): NormalizedMosiTranscription {
	if (!isRecord(data) || typeof data.text !== "string") {
		throw new TranscriptionError(
			"invalid_response",
			"MOSI API 响应缺少有效的 text 字段。"
		);
	}

	if (!speakerDiarizationEnabled) {
		return {
			text: data.text.trim(),
			utterances: undefined
		};
	}

	if (!Array.isArray(data.segments)) {
		throw new TranscriptionError(
			"invalid_response",
			"MOSI 多说话人响应缺少有效的 segments 字段。"
		);
	}

	const utterances: TranscriptionUtterance[] = [];
	for (const [index, segment] of data.segments.entries()) {
		if (!isRecord(segment) || typeof segment.text !== "string") {
			throw new TranscriptionError(
				"invalid_response",
				`MOSI API 响应的 segments[${index}] 结构无效。`
			);
		}

		const text = segment.text.trim();
		if (!text) {
			continue;
		}
		if (
			typeof segment.speaker !== "string" ||
			!segment.speaker.trim() ||
			!isValidTimestamp(segment.start) ||
			!isValidTimestamp(segment.end) ||
			segment.end < segment.start
		) {
			throw new TranscriptionError(
				"invalid_response",
				`MOSI API 响应的 segments[${index}] 缺少有效的说话人或时间范围。`
			);
		}

		utterances.push({
			speakerId: segment.speaker.trim(),
			text,
			startSeconds: segment.start,
			endSeconds: segment.end
		});
	}

	const text = data.text.trim() || utterances.map((utterance) => utterance.text).join("");
	return {
		text,
		utterances: utterances.length > 0 ? utterances : undefined
	};
}

export function createMosiHttpError(
	status: number,
	responseText: string,
	traceId?: string
): TranscriptionError {
	if (status === 413 || isMosiSizeOrDurationError(responseText)) {
		return new TranscriptionError(
			"file_too_large",
			`MOSI 拒绝了上传：音频过长或文件过大（HTTP ${status}）。官方未公布稳定上限，Echo Notes 将尝试缩小当前分段。`,
			traceId,
			status
		);
	}

	return createHttpTranscriptionError("MOSI", status, responseText, traceId);
}

export function offsetMosiUtterances(
	utterances: TranscriptionUtterance[] | undefined,
	offsetSeconds: number
): TranscriptionUtterance[] | undefined {
	if (!utterances || utterances.length === 0) {
		return undefined;
	}

	return utterances.map((utterance) => ({
		...utterance,
		startSeconds:
			utterance.startSeconds === undefined
				? undefined
				: utterance.startSeconds + offsetSeconds,
		endSeconds:
			utterance.endSeconds === undefined
				? undefined
				: utterance.endSeconds + offsetSeconds
	}));
}

type MultipartPart =
	| {
			name: string;
			value: string;
	  }
	| {
			name: string;
			fileName: string;
			contentType: string;
			value: ArrayBuffer;
	  };

function buildMultipartBody(boundary: string, parts: MultipartPart[]): ArrayBuffer {
	const encoder = new TextEncoder();
	const chunks: Uint8Array[] = [];

	for (const part of parts) {
		if (!("fileName" in part)) {
			chunks.push(
				encoder.encode(
					`--${boundary}\r\n` +
						`Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"\r\n\r\n` +
						`${part.value}\r\n`
				)
			);
			continue;
		}

		chunks.push(
			encoder.encode(
				`--${boundary}\r\n` +
					`Content-Disposition: form-data; name="${escapeHeaderValue(part.name)}"; filename="${escapeHeaderValue(part.fileName)}"; filename*=UTF-8''${encodeURIComponent(part.fileName)}\r\n` +
					`Content-Type: ${part.contentType}\r\n\r\n`
			)
		);
		chunks.push(new Uint8Array(part.value));
		chunks.push(encoder.encode("\r\n"));
	}

	chunks.push(encoder.encode(`--${boundary}--\r\n`));

	const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
	const combined = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return combined.buffer;
}

function escapeHeaderValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isValidTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isMosiSizeOrDurationError(responseText: string): boolean {
	return /audio.{0,24}too long|file.{0,24}too large|request entity too large|payload too large|exceeds?.{0,24}(limit|maximum)/i.test(
		responseText
	);
}

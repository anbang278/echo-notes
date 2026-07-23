import { App, requestUrl } from "obsidian";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import type { EchoNotesSettings, TranscriptionProviderId } from "../settings/settings";
import {
	createHttpTranscriptionError,
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";

const OPENAI_COMPATIBLE_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

interface OpenAICompatibleTranscriptionResponse {
	text?: string;
}

export class OpenAICompatibleAudioProvider implements TranscriptionProvider {
	id: TranscriptionProviderId;
	name: string;

	private app: App;
	private settings: EchoNotesSettings;
	private apiKey: string;

	constructor(app: App, settings: EchoNotesSettings, apiKey: string, id: TranscriptionProviderId, name: string) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
		this.id = id;
		this.name = name;
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError("missing_api_key", `请先在 Echo Notes 设置中配置 ${this.name} API Key。`);
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		if (input.audioFile.stat.size > OPENAI_COMPATIBLE_MAX_AUDIO_BYTES) {
			throw new TranscriptionError("file_too_large", "Audio file exceeds OpenAI-compatible 25MB limit.");
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const boundary = `----EchoNotesBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		const parts: MultipartPart[] = [
			{
				name: "model",
				value: this.settings.model
			},
			{
				name: "file",
				fileName: input.audioFile.name,
				contentType: getAudioMimeType(input.audioFile),
				value: audioBuffer
			}
		];

		if (input.language && input.language !== "auto") {
			parts.push({
				name: "language",
				value: input.language
			});
		}

		let response;
		try {
			response = await requestUrl({
				url: `${this.settings.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body: buildMultipartBody(boundary, parts)
			});
		} catch (error) {
			throw createNetworkTranscriptionError(this.name, error);
		}

		const traceId = readTraceId(response.headers);
		if (response.status < 200 || response.status >= 300) {
			throw createHttpTranscriptionError(this.name, response.status, response.text, traceId);
		}

		const data = response.json as OpenAICompatibleTranscriptionResponse;
		if (!data || typeof data.text !== "string") {
			throw new TranscriptionError("invalid_response", `${this.name} API 响应中缺少 text 字段。`, traceId);
		}

		return {
			text: data.text,
			provider: this.id,
			model: this.settings.model,
			traceId,
			raw: data
		};
	}
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

function readTraceId(headers: Record<string, string>): string | undefined {
	const traceHeaders = ["x-request-id", "x-groq-id", "openai-processing-ms"];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

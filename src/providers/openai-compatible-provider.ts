import { App, requestUrl } from "obsidian";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	buildMultipartFormDataBody,
	type MultipartFormDataPart
} from "../network/multipart-form-data";
import type { OfflineTranscriptionProviderId, TranscriptionConfig } from "../settings/settings";
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

type LocalOpenAICompatibleTranscriptionProviderId = "ollama" | "lm-studio";

export class OpenAICompatibleAudioProvider implements TranscriptionProvider {
	id: LocalOpenAICompatibleTranscriptionProviderId;
	name: string;

	private app: App;
	private settings: TranscriptionConfig<OfflineTranscriptionProviderId>;
	private apiKey: string;

	constructor(
		app: App,
		settings: TranscriptionConfig<OfflineTranscriptionProviderId>,
		apiKey: string,
		id: LocalOpenAICompatibleTranscriptionProviderId,
		name: string
	) {
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
		const parts: MultipartFormDataPart[] = [
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
			const requestStartedAt = Date.now();
			input.diagnostics?.event("request", "openai-audio-request-started", {
				provider: this.id,
				protocol: "multipart/form-data",
				endpoint: `${this.settings.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
				model: this.settings.model,
				language: input.language ?? "auto",
				audioBytes: audioBuffer.byteLength
			});
			response = await requestUrl({
				url: `${this.settings.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`,
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body: buildMultipartFormDataBody(boundary, parts)
			});
			input.diagnostics?.event("request", "openai-audio-request-finished", {
				status: response.status,
				durationMs: Date.now() - requestStartedAt
			});
		} catch (error) {
			input.diagnostics?.event("result", "openai-audio-request-failed", { error: error instanceof Error ? error.message : String(error) });
			throw createNetworkTranscriptionError(this.name, error);
		}

		const traceId = readTraceId(response.headers);
		input.diagnostics?.event("request", "openai-audio-trace-id", { traceId });
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

function readTraceId(headers: Record<string, string>): string | undefined {
	const traceHeaders = ["x-request-id", "x-groq-id", "openai-processing-ms"];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

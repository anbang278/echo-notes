import { App, requestUrl } from "obsidian";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import type { EchoNotesSettings } from "../settings/settings";
import {
	createHttpTranscriptionError,
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";

const SILICONFLOW_MAX_AUDIO_BYTES = 50 * 1024 * 1024;

interface SiliconFlowTranscriptionResponse {
	text?: string;
}

export class SiliconFlowTeleSpeechProvider implements TranscriptionProvider {
	id = "siliconflow";
	name = "SiliconFlow";

	private app: App;
	private settings: EchoNotesSettings;
	private apiKey: string;

	constructor(app: App, settings: EchoNotesSettings, apiKey: string) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置 API Key。");
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		if (input.audioFile.stat.size > SILICONFLOW_MAX_AUDIO_BYTES) {
			throw new TranscriptionError("file_too_large", "Audio file exceeds SiliconFlow 50MB limit.");
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const boundary = `----EchoNotesBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		const body = buildMultipartBody(boundary, [
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
		]);

		const baseUrl = this.settings.baseUrl.replace(/\/+$/, "");
		const url = `${baseUrl}/v1/audio/transcriptions`;

		try {
			const response = await requestUrl({
				url,
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body
			});

			const traceId = readTraceId(response.headers);
			if (response.status < 200 || response.status >= 300) {
				throw createHttpTranscriptionError("SiliconFlow", response.status, response.text, traceId);
			}

			const data = response.json as SiliconFlowTranscriptionResponse;
			if (!data || typeof data.text !== "string") {
				throw new TranscriptionError("invalid_response", "SiliconFlow API 响应中缺少 text 字段。", traceId);
			}

			return {
				text: data.text,
				provider: this.id,
				model: this.settings.model,
				traceId,
				raw: data
			};
		} catch (error) {
			if (error instanceof TranscriptionError) {
				throw error;
			}

			throw createNetworkTranscriptionError("SiliconFlow", error);
		}
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
	const foundKey = Object.keys(headers).find((key) => key.toLowerCase() === "x-siliconcloud-trace-id");
	return foundKey ? headers[foundKey] : undefined;
}

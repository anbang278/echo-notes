import { App, requestUrl } from "obsidian";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	MOSI_TRANSCRIPTION_MODEL,
	type TranscriptionConfig
} from "../settings/settings";
import {
	buildMosiMultipartBody,
	buildMosiTranscriptionsUrl,
	createMosiHttpError,
	normalizeMosiTranscriptionResponse
} from "./mosi-protocol";
import {
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";

export class MosiDiarizationProvider implements TranscriptionProvider {
	id = "mosi";
	name = "MOSI";

	private app: App;
	private settings: TranscriptionConfig;
	private apiKey: string;

	constructor(app: App, settings: TranscriptionConfig, apiKey: string) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置 MOSI API Key。");
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const boundary = `----EchoNotesBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		let response;
		try {
			response = await requestUrl({
				url: buildMosiTranscriptionsUrl(this.settings.baseUrl),
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body: buildMosiMultipartBody(
					boundary,
					audioBuffer,
					input.audioFile.name,
					getAudioMimeType(input.audioFile)
				)
			});
		} catch (error) {
			throw createNetworkTranscriptionError("MOSI", error);
		}

		const traceId = readTraceId(response.headers);
		if (response.status < 200 || response.status >= 300) {
			const message = readMosiErrorMessage(response.json) ?? response.text;
			throw createMosiHttpError(response.status, message, traceId);
		}

		const normalized = normalizeMosiTranscriptionResponse(response.json);
		return {
			text: normalized.text,
			provider: this.id,
			model: MOSI_TRANSCRIPTION_MODEL,
			traceId,
			utterances: normalized.utterances,
			raw: response.json
		};
	}
}

function readMosiErrorMessage(data: unknown): string | undefined {
	if (!isRecord(data) || !isRecord(data.error) || typeof data.error.message !== "string") {
		return undefined;
	}
	return data.error.message;
}

function readTraceId(headers: Record<string, string>): string | undefined {
	const traceHeaders = ["x-request-id", "x-trace-id", "trace-id", "request-id"];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

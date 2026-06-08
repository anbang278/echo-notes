import { App, requestUrl } from "obsidian";
import { runAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	createWavAudioSegments,
	estimateBase64DataUrlByteLength,
	formatSegmentTimeRange,
	type WavAudioSegment
} from "../audio/audio-segmenter";
import type { EchoNotesSettings } from "../settings/settings";
import {
	createHttpTranscriptionError,
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";

const BAILIAN_MAX_BASE64_BYTES = 10 * 1024 * 1024;

interface BailianChatCompletionResponse {
	id?: string;
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
	error?: {
		message?: string;
		code?: string;
	};
}

interface BailianTranscriptionResponse {
	text: string;
	traceId?: string;
	raw: BailianChatCompletionResponse;
}

export class AliyunBailianQwenAsrProvider implements TranscriptionProvider {
	id = "aliyun-bailian";
	name = "阿里百炼";

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
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置阿里百炼 API Key。");
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const mimeType = getAudioMimeType(input.audioFile);

		if (estimateBase64DataUrlByteLength(audioBuffer.byteLength, mimeType) > BAILIAN_MAX_BASE64_BYTES) {
			return this.transcribeLongAudio(audioBuffer, input);
		}

		const result = await this.transcribeAudioBuffer(audioBuffer, mimeType);

		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: result.traceId,
			raw: result.raw
		};
	}

	private async transcribeLongAudio(audioBuffer: ArrayBuffer, input: TranscriptionInput): Promise<TranscriptionResult> {
		const pipelineResult = await runAudioChunkPipeline<WavAudioSegment, BailianChatCompletionResponse>({
			onProgress: input.onProgress,
			createChunks: () => this.createLongAudioChunks(audioBuffer),
			transcribeChunk: async (chunk) => {
				this.assertChunkWithinBase64Limit(chunk);
				const result = await this.transcribeAudioBuffer(chunk.audioBuffer, chunk.mimeType);
				return {
					text: result.text,
					traceId: result.traceId,
					raw: result.raw
				};
			}
		});

		return {
			text: pipelineResult.text,
			provider: this.id,
			model: this.settings.model,
			traceId: pipelineResult.traceId,
			segments: pipelineResult.segments,
			raw: {
				segments: pipelineResult.rawSegments
			}
		};
	}

	private async createLongAudioChunks(audioBuffer: ArrayBuffer): Promise<WavAudioSegment[]> {
		try {
			return await createWavAudioSegments(audioBuffer);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError("audio_decode_error", `音频解码失败，无法进行长音频分段转写：${message}`);
		}
	}

	private assertChunkWithinBase64Limit(chunk: WavAudioSegment): void {
		const encodedByteLength = estimateBase64DataUrlByteLength(chunk.audioBuffer.byteLength, chunk.mimeType);
		if (encodedByteLength <= BAILIAN_MAX_BASE64_BYTES) {
			return;
		}

		throw new TranscriptionError(
			"file_too_large",
			`长音频分段 ${chunk.index}/${chunk.total}（${formatSegmentTimeRange(chunk)}）编码后仍超过阿里百炼 qwen3-asr-flash 10MB Base64 输入限制。`
		);
	}

	private async transcribeAudioBuffer(audioBuffer: ArrayBuffer, mimeType: string): Promise<BailianTranscriptionResponse> {
		const dataUrl = `data:${mimeType};base64,${arrayBufferToBase64(audioBuffer)}`;
		if (new TextEncoder().encode(dataUrl).byteLength > BAILIAN_MAX_BASE64_BYTES) {
			throw new TranscriptionError(
				"file_too_large",
				"Audio file exceeds Alibaba Bailian qwen3-asr-flash 10MB Base64 input limit."
			);
		}

		let response;
		try {
			response = await requestUrl({
				url: buildChatCompletionsUrl(this.settings.baseUrl),
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${this.apiKey.trim()}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify({
					model: this.settings.model,
					messages: [
						{
							role: "user",
							content: [
								{
									type: "input_audio",
									input_audio: {
										data: dataUrl
									}
								}
							]
						}
					],
					stream: false,
					asr_options: buildAsrOptions(this.settings.language)
				})
			});
		} catch (error) {
			throw createNetworkTranscriptionError("阿里百炼", error);
		}

		const traceId = readTraceId(response.headers);
		const data = response.json as BailianChatCompletionResponse;
		if (response.status < 200 || response.status >= 300) {
			const message = data?.error?.message ?? response.text;
			throw createHttpTranscriptionError("阿里百炼", response.status, message, traceId);
		}

		const text = data?.choices?.[0]?.message?.content;
		if (typeof text !== "string") {
			throw new TranscriptionError("invalid_response", "阿里百炼 API 响应中缺少 choices[0].message.content。", traceId);
		}

		return {
			text,
			traceId: traceId ?? data.id,
			raw: data
		};
	}
}

function buildChatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/chat/completions")) {
		return normalized;
	}

	return `${normalized}/chat/completions`;
}

function buildAsrOptions(language: string): Record<string, unknown> {
	const options: Record<string, unknown> = {
		enable_itn: false
	};
	if (language && language !== "auto") {
		options.language = language;
	}

	return options;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 0x8000;
	let binary = "";

	for (let index = 0; index < bytes.length; index += chunkSize) {
		const chunk = bytes.subarray(index, index + chunkSize);
		binary += String.fromCharCode(...chunk);
	}

	return btoa(binary);
}

function readTraceId(headers: Record<string, string>): string | undefined {
	const traceHeaders = ["x-request-id", "x-dashscope-request-id", "x-acs-request-id"];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

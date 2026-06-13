import { App, requestUrl } from "obsidian";
import { runAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	createWavAudioSegments,
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

const SILICONFLOW_MAX_AUDIO_BYTES = 50 * 1024 * 1024;
const SILICONFLOW_LONG_AUDIO_TARGET_SEGMENT_SECONDS = 600;

interface SiliconFlowTranscriptionResponse {
	text?: string;
}

interface SiliconFlowSegmentResult {
	text: string;
	traceId?: string;
	raw: SiliconFlowTranscriptionResponse;
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

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		if (input.audioFile.stat.size > SILICONFLOW_MAX_AUDIO_BYTES) {
			return this.transcribeLongAudio(audioBuffer, input);
		}

		const result = await this.transcribeAudioBuffer(
			audioBuffer,
			getAudioMimeType(input.audioFile),
			input.audioFile.name
		);

		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: result.traceId,
			raw: result.raw
		};
	}

	private async transcribeLongAudio(
		audioBuffer: ArrayBuffer,
		input: TranscriptionInput
	): Promise<TranscriptionResult> {
		const pipelineResult = await runAudioChunkPipeline<WavAudioSegment, SiliconFlowTranscriptionResponse>({
			onProgress: input.onProgress,
			createChunks: () => this.createLongAudioChunks(audioBuffer),
			transcribeChunk: async (chunk) => {
				this.assertChunkWithinMultipartLimit(chunk);
				const result = await this.transcribeAudioBuffer(
					chunk.audioBuffer,
					chunk.mimeType,
					buildSegmentFileName(input.audioFile.name, chunk)
				);
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
			return await createWavAudioSegments(audioBuffer, {
				targetSegmentSeconds: SILICONFLOW_LONG_AUDIO_TARGET_SEGMENT_SECONDS
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError("audio_decode_error", `音频解码失败，无法进行硅基流动长音频分段转写：${message}`);
		}
	}

	private assertChunkWithinMultipartLimit(chunk: WavAudioSegment): void {
		if (chunk.audioBuffer.byteLength <= SILICONFLOW_MAX_AUDIO_BYTES) {
			return;
		}

		throw new TranscriptionError(
			"file_too_large",
			`长音频分段 ${chunk.index}/${chunk.total}（${formatSegmentTimeRange(chunk)}）仍超过 SiliconFlow 50MB 单段上传限制。`
		);
	}

	private async transcribeAudioBuffer(
		audioBuffer: ArrayBuffer,
		mimeType: string,
		fileName: string
	): Promise<SiliconFlowSegmentResult> {
		const apiKey = this.apiKey.trim();
		const boundary = `----EchoNotesBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		const body = buildMultipartBody(boundary, [
			{
				name: "model",
				value: this.settings.model
			},
			{
				name: "file",
				fileName,
				contentType: mimeType,
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

function buildSegmentFileName(sourceFileName: string, chunk: WavAudioSegment): string {
	const extensionIndex = sourceFileName.lastIndexOf(".");
	const basename = extensionIndex > 0 ? sourceFileName.slice(0, extensionIndex) : sourceFileName;
	return `${basename}.segment-${chunk.index.toString().padStart(2, "0")}.wav`;
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

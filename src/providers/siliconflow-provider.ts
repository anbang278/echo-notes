import { App, requestUrl } from "obsidian";
import { runAdaptiveAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import { probeAudioDurationSeconds } from "../audio/audio-duration";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	createWavAudioSegments,
	formatSegmentTimeRange,
	splitWavAudioSegment,
	type WavAudioSegment
} from "../audio/audio-segmenter";
import type { TranscriptionConfig } from "../settings/settings";
import {
	isRetryablePolicyStatus,
	resolveProviderTranscriptionPolicy,
	shouldPreChunkTranscription,
	shouldSplitPolicyError,
	type ProviderTranscriptionPolicy
} from "./transcription-policy";
import {
	createHttpTranscriptionError,
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";

interface SiliconFlowTranscriptionResponse {
	text?: string;
}

interface SiliconFlowSegmentResult {
	text: string;
	traceId?: string;
	raw: SiliconFlowTranscriptionResponse;
}

interface SiliconFlowProviderDependencies {
	probeDuration?: typeof probeAudioDurationSeconds;
	sleep?: (delayMs: number) => Promise<void>;
}

export class SiliconFlowTeleSpeechProvider implements TranscriptionProvider {
	id = "siliconflow";
	name = "SiliconFlow";

	private app: App;
	private settings: TranscriptionConfig;
	private apiKey: string;
	private probeDuration: typeof probeAudioDurationSeconds;
	private sleep: (delayMs: number) => Promise<void>;

	constructor(
		app: App,
		settings: TranscriptionConfig,
		apiKey: string,
		dependencies: SiliconFlowProviderDependencies = {}
	) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
		this.probeDuration = dependencies.probeDuration ?? probeAudioDurationSeconds;
		this.sleep =
			dependencies.sleep ??
			((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
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
		const mimeType = getAudioMimeType(input.audioFile);
		const policy = resolveProviderTranscriptionPolicy({
			provider: "siliconflow",
			model: this.settings.model
		});
		const durationSeconds = await this.probeDuration(audioBuffer, mimeType);
		if (input.resumeSegments && input.resumeSegments.length > 0) {
			return this.transcribeLongAudio(audioBuffer, input, policy, true);
		}
		if (
			shouldPreChunkTranscription({
				policy,
				sourceBytes: input.audioFile.stat.size,
				durationSeconds
			})
		) {
			return this.transcribeLongAudio(audioBuffer, input, policy);
		}

		try {
			const result = await this.transcribeWholeAudioWithRetry(
				audioBuffer,
				mimeType,
				input.audioFile.name,
				input,
				policy,
				durationSeconds
			);

			return {
				text: result.text,
				provider: this.id,
				model: this.settings.model,
				traceId: result.traceId,
				raw: result.raw
			};
		} catch (error) {
			const httpStatus = readHttpStatus(error);
			if (!shouldSplitPolicyError(policy, httpStatus)) {
				throw error;
			}
			return this.transcribeLongAudio(audioBuffer, input, policy, httpStatus === 413);
		}
	}

	private async transcribeLongAudio(
		audioBuffer: ArrayBuffer,
		input: TranscriptionInput,
		policy: ProviderTranscriptionPolicy,
		forceInitialSplit = false
	): Promise<TranscriptionResult> {
		const pipelineResult = await runAdaptiveAudioChunkPipeline<
			WavAudioSegment,
			SiliconFlowTranscriptionResponse
		>({
			onProgress: input.onProgress,
			initialSegments: input.resumeSegments,
			createChunks: async () => {
				const chunks = await this.createLongAudioChunks(audioBuffer, policy);
				if (
					forceInitialSplit &&
					chunks.length === 1 &&
					chunks[0].endSeconds - chunks[0].startSeconds >= (policy.minSegmentSeconds ?? 60) * 2
				) {
					const splitChunks = splitWavAudioSegment(chunks[0]);
					chunks[0].audioBuffer = new ArrayBuffer(0);
					return splitChunks;
				}
				return chunks;
			},
			transcribeChunk: async (chunk) => {
				try {
					this.assertChunkWithinMultipartLimit(chunk, policy);
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
				} catch (error) {
					if (error instanceof TranscriptionError) {
						throw new TranscriptionError(
							error.code,
							`分段 ${chunk.index}/${chunk.total}（${formatSegmentTimeRange(chunk)}）转写失败：${error.message}`,
							error.traceId,
							error.httpStatus
						);
					}
					throw error;
				}
			},
			splitChunk: (chunk) => splitWavAudioSegment(chunk),
			shouldRetry: (error) => isRetryablePolicyStatus(policy, readHttpStatus(error)),
			shouldSplit: (error) => shouldSplitPolicyError(policy, readHttpStatus(error)),
			retryDelaysMs: policy.retryDelaysMs,
			maxSplitDepth: policy.maxSplitDepth,
			minSegmentSeconds: policy.minSegmentSeconds ?? 60,
			sleep: this.sleep
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

	private async createLongAudioChunks(
		audioBuffer: ArrayBuffer,
		policy: ProviderTranscriptionPolicy
	): Promise<WavAudioSegment[]> {
		try {
			return await createWavAudioSegments(audioBuffer, {
				targetSegmentSeconds: policy.targetSegmentSeconds,
				minSegmentSeconds: policy.minSegmentSeconds
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError("audio_decode_error", `音频解码失败，无法进行硅基流动长音频分段转写：${message}`);
		}
	}

	private assertChunkWithinMultipartLimit(
		chunk: WavAudioSegment,
		policy: ProviderTranscriptionPolicy
	): void {
		if (!policy.maxSourceBytes || chunk.audioBuffer.byteLength <= policy.maxSourceBytes) {
			return;
		}

		throw new TranscriptionError(
			"file_too_large",
			`长音频分段 ${chunk.index}/${chunk.total}（${formatSegmentTimeRange(chunk)}）仍超过 SiliconFlow 50MB 单段上传限制。`,
			undefined,
			413
		);
	}

	private async transcribeWholeAudioWithRetry(
		audioBuffer: ArrayBuffer,
		mimeType: string,
		fileName: string,
		input: TranscriptionInput,
		policy: ProviderTranscriptionPolicy,
		durationSeconds?: number
	): Promise<SiliconFlowSegmentResult> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.transcribeAudioBuffer(audioBuffer, mimeType, fileName);
			} catch (error) {
				const delayMs = policy.retryDelaysMs[attempt];
				if (delayMs === undefined || !isRetryablePolicyStatus(policy, readHttpStatus(error))) {
					throw error;
				}

				await input.onProgress?.({
					type: "segment-retrying",
					segment:
						durationSeconds !== undefined
							? {
									index: 1,
									total: 1,
									startSeconds: 0,
									endSeconds: durationSeconds
								}
							: undefined,
					attempt: attempt + 1,
					maxAttempts: policy.retryDelaysMs.length,
					delayMs,
					httpStatus: readHttpStatus(error),
					segments: []
				});
				await this.sleep(delayMs);
			}
		}
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

function readHttpStatus(error: unknown): number | undefined {
	return error instanceof TranscriptionError ? error.httpStatus : undefined;
}

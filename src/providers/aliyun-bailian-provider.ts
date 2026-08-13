import { App, requestUrl } from "obsidian";
import { runAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import {
	createWavAudioBuffer,
	createWavAudioSegments,
	estimateBase64DataUrlByteLength,
	formatSegmentTimeRange,
	type WavAudioSegment
} from "../audio/audio-segmenter";
import {
	ALIYUN_FILETRANS_MODEL,
	DEFAULT_ALIYUN_FILETRANS_SETTINGS,
	type TranscriptionConfig
} from "../settings/settings";
import {
	ALIYUN_FILETRANS_TEMP_UPLOAD_MAX_BYTES,
	AliyunFiletransProtocolError,
	buildAliyunLegacyChatCompletionsUrl,
	downloadAliyunFiletransResult,
	exceedsAliyunDiarizationDuration,
	getAliyunFiletransResultUrl,
	getAliyunPollDelayMs,
	getAliyunTemporaryUploadPolicy,
	queryAliyunFiletransTask,
	submitAliyunFiletransTask,
	uploadAliyunTemporaryAudio,
	waitForAliyunPollDelay,
	type AliyunHttpRequester
} from "./aliyun-filetrans-client";
import { resolveProviderTranscriptionPolicy } from "./transcription-policy";
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
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置阿里百炼 API Key。");
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}
		if (this.settings.model === ALIYUN_FILETRANS_MODEL) {
			return this.transcribeFiletrans(input);
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const mimeType = getAudioMimeType(input.audioFile);
		const encodedBytes = estimateBase64DataUrlByteLength(audioBuffer.byteLength, mimeType);
		input.diagnostics?.event("configuration", "bailian-asr-options", {
			provider: this.id,
			protocol: "chat-completions-base64",
			endpoint: buildAliyunLegacyChatCompletionsUrl(this.settings.baseUrl),
			model: this.settings.model,
			language: this.settings.language || "auto",
			asrOptions: buildAsrOptions(this.settings.language),
			base64EstimatedBytes: encodedBytes,
			base64LimitBytes: BAILIAN_MAX_BASE64_BYTES
		});

		if (encodedBytes > BAILIAN_MAX_BASE64_BYTES) {
			input.diagnostics?.event("lifecycle", "bailian-long-audio-segmentation-started", { encodedBytes });
			return this.transcribeLongAudio(audioBuffer, input);
		}

		const result = await this.transcribeAudioBuffer(audioBuffer, mimeType, input);

		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: result.traceId,
			raw: result.raw
		};
	}

	private async transcribeFiletrans(input: TranscriptionInput): Promise<TranscriptionResult> {
		if (input.audioFile.stat.size > ALIYUN_FILETRANS_TEMP_UPLOAD_MAX_BYTES) {
			throw new TranscriptionError("file_too_large", "音频超过百炼临时上传 1GB 上限；当前版本未接入用户自有 OSS。");
		}
		const filetransSettings = this.settings.aliyunFiletrans ?? DEFAULT_ALIYUN_FILETRANS_SETTINGS;
		const configurationFingerprint = input.resumeRemoteTask?.configurationFingerprint ??
			input.configurationFingerprint ??
			createFiletransConfigurationFingerprint(this.settings, input.enhancement?.fingerprint);

		const requester = requestUrl as unknown as AliyunHttpRequester;
		let task = input.resumeRemoteTask;
		let traceId: string | undefined;
		try {
			if (!task) {
				let audioBuffer = await this.app.vault.readBinary(input.audioFile);
				let mimeType = getAudioMimeType(input.audioFile);
				let uploadFileName = input.audioFile.name;
				let convertedToMono = false;
				if (filetransSettings.diarizationEnabled) {
					try {
						audioBuffer = await createWavAudioBuffer(audioBuffer);
					} catch (error) {
						const detail = getErrorMessage(error);
						const likelyMemoryPressure = error instanceof RangeError || /memory|allocation|array buffer/i.test(detail);
						throw new TranscriptionError(
							"audio_decode_error",
							likelyMemoryPressure
								? "设备内存不足，无法为说话人分离生成整段 16 kHz 单声道 WAV。请释放内存，或关闭说话人分离后重试。"
								: `说话人分离需要整段 16 kHz 单声道 WAV，但本地转换失败：${detail}。请转换音频或关闭说话人分离后重试。`
						);
					}
					if (exceedsAliyunDiarizationDuration(audioBuffer.byteLength)) {
						throw new TranscriptionError(
							"unsupported_audio",
							"说话人分离仅允许提交不超过 2 小时的整段单声道音频。请关闭说话人分离后重试该长音频。"
						);
					}
					mimeType = "audio/wav";
					uploadFileName = "audio.wav";
					convertedToMono = true;
				}
				if (audioBuffer.byteLength > ALIYUN_FILETRANS_TEMP_UPLOAD_MAX_BYTES) {
					throw new TranscriptionError("file_too_large", "单声道转换后的音频超过百炼临时上传 1GB 上限。");
				}
				await input.onProgress?.({
					type: "filetrans-upload-started",
					audioBytes: audioBuffer.byteLength,
					convertedToMono
				});
				input.diagnostics?.event("configuration", "bailian-filetrans-options", {
					provider: this.id,
					protocol: "dashscope-async-filetrans",
					model: this.settings.model,
					diarizationEnabled: filetransSettings.diarizationEnabled,
					speakerCount: filetransSettings.speakerCount,
					hotwordCount: input.enhancement?.hotwords.length ?? 0,
					contextCharacters: input.enhancement?.contextText?.length ?? 0,
					convertedToMono,
					audioBytes: audioBuffer.byteLength
				});
				const policy = await getAliyunTemporaryUploadPolicy(
					requester,
					this.settings.baseUrl,
					this.apiKey.trim(),
					this.settings.model
				);
				const fileUrl = await uploadAliyunTemporaryAudio(
					requester,
					policy,
					uploadFileName,
					mimeType,
					audioBuffer
				);
				await input.onProgress?.({ type: "filetrans-upload-completed", audioBytes: audioBuffer.byteLength });
				const submitted = await submitAliyunFiletransTask(requester, {
					baseUrl: this.settings.baseUrl,
					apiKey: this.apiKey.trim(),
					model: this.settings.model,
					fileUrl,
					language: input.language,
					diarizationEnabled: filetransSettings.diarizationEnabled,
					speakerCount: filetransSettings.speakerCount,
					enhancement: input.enhancement
				}, configurationFingerprint);
				task = submitted.task;
				traceId = submitted.requestId;
				await input.onProgress?.({ type: "filetrans-task-submitted", task, traceId });
			}

			let pollAttempt = 0;
			while (true) {
				throwIfAborted(input.signal);
				const query = await queryAliyunFiletransTask(
					requester,
					this.settings.baseUrl,
					this.apiKey.trim(),
					task
				);
				task = query.task;
				traceId = query.requestId ?? traceId;
				if (task.status === "SUCCEEDED") {
					await input.onProgress?.({ type: "filetrans-result-downloading", task });
					const result = await downloadAliyunFiletransResult(
						requester,
						getAliyunFiletransResultUrl(query)
					);
					return {
						text: result.text,
						provider: this.id,
						model: this.settings.model,
						traceId,
						utterances: result.utterances,
						raw: result.raw
					};
				}
				if (task.status === "FAILED" || task.status === "CANCELED" || task.status === "UNKNOWN") {
					throw new AliyunFiletransProtocolError(`百炼异步转写任务结束：${task.status}`, {
						requestId: traceId,
						remoteStatus: task.status
					});
				}
				const delayMs = getAliyunPollDelayMs(pollAttempt, query.retryAfter);
				await input.onProgress?.({
					type: "filetrans-task-status",
					task,
					traceId,
					pollDelayMs: delayMs
				});
				pollAttempt += 1;
				await waitForAliyunPollDelay(delayMs, input.signal);
			}
		} catch (error) {
			if (input.signal?.aborted) {
				throw input.signal.reason instanceof Error ? input.signal.reason : error;
			}
			if (error instanceof TranscriptionError) {
				throw error;
			}
			if (error instanceof AliyunFiletransProtocolError) {
				if (error.status !== undefined) {
					throw createHttpTranscriptionError("阿里百炼", error.status, error.message, error.requestId ?? traceId);
				}
				throw new TranscriptionError("invalid_response", error.message, error.requestId ?? traceId);
			}
			throw createNetworkTranscriptionError("阿里百炼", error);
		}
	}

	private async transcribeLongAudio(audioBuffer: ArrayBuffer, input: TranscriptionInput): Promise<TranscriptionResult> {
		const pipelineResult = await runAudioChunkPipeline<WavAudioSegment, BailianChatCompletionResponse>({
			onProgress: input.onProgress,
			initialSegments: input.resumeSegments,
			createChunks: () => this.createLongAudioChunks(audioBuffer),
			transcribeChunk: async (chunk) => {
				this.assertChunkWithinBase64Limit(chunk);
				input.diagnostics?.event("progress", "bailian-segment-request", {
					segmentIndex: chunk.index,
					totalSegments: chunk.total,
					startSeconds: chunk.startSeconds,
					endSeconds: chunk.endSeconds,
					base64EstimatedBytes: estimateBase64DataUrlByteLength(chunk.audioBuffer.byteLength, chunk.mimeType)
				});
				const result = await this.transcribeAudioBuffer(chunk.audioBuffer, chunk.mimeType, input);
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
			const policy = resolveProviderTranscriptionPolicy({
				provider: "aliyun-bailian",
				model: this.settings.model
			});
			return await createWavAudioSegments(audioBuffer, {
				targetSegmentSeconds: policy.targetSegmentSeconds,
				minSegmentSeconds: policy.minSegmentSeconds
			});
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

	private async transcribeAudioBuffer(audioBuffer: ArrayBuffer, mimeType: string, input: TranscriptionInput): Promise<BailianTranscriptionResponse> {
		const dataUrl = `data:${mimeType};base64,${arrayBufferToBase64(audioBuffer)}`;
		if (new TextEncoder().encode(dataUrl).byteLength > BAILIAN_MAX_BASE64_BYTES) {
			throw new TranscriptionError(
				"file_too_large",
				"Audio file exceeds Alibaba Bailian qwen3-asr-flash 10MB Base64 input limit."
			);
		}

		let response;
		try {
			const requestStartedAt = Date.now();
			input.diagnostics?.event("request", "bailian-request-started", {
				endpoint: buildAliyunLegacyChatCompletionsUrl(this.settings.baseUrl),
				model: this.settings.model,
				asrOptions: buildAsrOptions(this.settings.language),
				encodedBytes: new TextEncoder().encode(dataUrl).byteLength
			});
			response = await requestUrl({
				url: buildAliyunLegacyChatCompletionsUrl(this.settings.baseUrl),
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
			input.diagnostics?.event("request", "bailian-request-finished", {
				status: response.status,
				durationMs: Date.now() - requestStartedAt
			});
		} catch (error) {
			input.diagnostics?.event("result", "bailian-request-failed", { error: error instanceof Error ? error.message : String(error) });
			throw createNetworkTranscriptionError("阿里百炼", error);
		}

		const traceId = readTraceId(response.headers);
		input.diagnostics?.event("request", "bailian-trace-id", { traceId });
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

function buildAsrOptions(language: string): Record<string, unknown> {
	const options: Record<string, unknown> = {
		enable_itn: false
	};
	if (language && language !== "auto") {
		options.language = language;
	}

	return options;
}

function createFiletransConfigurationFingerprint(
	settings: TranscriptionConfig,
	enhancementFingerprint: string | undefined
): string {
	const value = JSON.stringify({
		provider: settings.provider,
		baseUrl: settings.baseUrl,
		model: settings.model,
		language: settings.language,
		filetrans: settings.aliyunFiletrans ?? DEFAULT_ALIYUN_FILETRANS_SETTINGS,
		enhancementFingerprint: enhancementFingerprint ?? ""
	});
	let hash = 2166136261;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return `filetrans-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw signal.reason instanceof Error ? signal.reason : new Error("百炼异步转写已停止。");
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

import { App, requestUrl } from "obsidian";
import { runAdaptiveAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import { probeAudioDurationSeconds } from "../audio/audio-duration";
import {
	createWavAudioSegments,
	formatSegmentTimeRange,
	splitWavAudioSegment,
	type WavAudioSegment
} from "../audio/audio-segmenter";
import {
	isMosiSpeakerDiarizationModel,
	type TranscriptionConfig
} from "../settings/settings";
import {
	buildMosiMultipartBody,
	buildMosiTranscriptionsUrl,
	createMosiHttpError,
	normalizeMosiTranscriptionResponse,
	offsetMosiUtterances
} from "./mosi-protocol";
import {
	isRetryablePolicyStatus,
	resolveProviderTranscriptionPolicy,
	shouldPreChunkTranscription,
	shouldSplitPolicyError,
	type ProviderTranscriptionPolicy
} from "./transcription-policy";
import {
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult,
	type TranscriptionUtterance
} from "./transcription-provider";

interface MosiSegmentResult {
	text: string;
	traceId?: string;
	utterances?: TranscriptionUtterance[];
	raw: unknown;
}

interface MosiProviderDependencies {
	probeDuration?: typeof probeAudioDurationSeconds;
	sleep?: (delayMs: number) => Promise<void>;
}

export class MosiTranscriptionProvider implements TranscriptionProvider {
	id = "mosi";
	name = "MOSI";

	private app: App;
	private settings: TranscriptionConfig;
	private apiKey: string;
	private probeDuration: typeof probeAudioDurationSeconds;
	private sleep: (delayMs: number) => Promise<void>;

	constructor(
		app: App,
		settings: TranscriptionConfig,
		apiKey: string,
		dependencies: MosiProviderDependencies = {}
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
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置 MOSI API Key。");
		}

		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const audioBuffer = await this.app.vault.readBinary(input.audioFile);
		const mimeType = getAudioMimeType(input.audioFile);
		const policy = resolveProviderTranscriptionPolicy({
			provider: "mosi",
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
				utterances: result.utterances,
				raw: result.raw
			};
		} catch (error) {
			if (!shouldRecoverMosiError(policy, error)) {
				throw error;
			}
			return this.transcribeLongAudio(audioBuffer, input, policy, true);
		}
	}

	private async transcribeLongAudio(
		audioBuffer: ArrayBuffer,
		input: TranscriptionInput,
		policy: ProviderTranscriptionPolicy,
		forceInitialSplit = false
	): Promise<TranscriptionResult> {
		const pipelineResult = await runAdaptiveAudioChunkPipeline<WavAudioSegment, unknown>({
			onProgress: input.onProgress,
			initialSegments: input.resumeSegments,
			createChunks: async () => {
				const chunks = await this.createLongAudioChunks(audioBuffer, policy);
				if (
					forceInitialSplit &&
					chunks.length === 1 &&
					chunks[0].endSeconds - chunks[0].startSeconds >=
						(policy.minSegmentSeconds ?? 30) * 2
				) {
					const splitChunks = splitWavAudioSegment(chunks[0]);
					chunks[0].audioBuffer = new ArrayBuffer(0);
					return splitChunks;
				}
				return chunks;
			},
			transcribeChunk: async (chunk) => {
				try {
					const result = await this.transcribeAudioBuffer(
						chunk.audioBuffer,
						chunk.mimeType,
						buildSegmentFileName(input.audioFile.name, chunk)
					);
					return {
						text: result.text,
						traceId: result.traceId,
						utterances: offsetMosiUtterances(
							result.utterances,
							chunk.startSeconds
						),
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
			shouldRetry: (error) =>
				isRetryablePolicyStatus(policy, readHttpStatus(error)),
			shouldSplit: (error) => shouldRecoverMosiError(policy, error),
			retryDelaysMs: policy.retryDelaysMs,
			maxSplitDepth: policy.maxSplitDepth,
			minSegmentSeconds: policy.minSegmentSeconds ?? 30,
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
			throw new TranscriptionError(
				"audio_decode_error",
				`音频解码失败，无法进行 MOSI 长音频分段转写：${message}`
			);
		}
	}

	private async transcribeWholeAudioWithRetry(
		audioBuffer: ArrayBuffer,
		mimeType: string,
		fileName: string,
		input: TranscriptionInput,
		policy: ProviderTranscriptionPolicy,
		durationSeconds?: number
	): Promise<MosiSegmentResult> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				return await this.transcribeAudioBuffer(audioBuffer, mimeType, fileName);
			} catch (error) {
				const delayMs = policy.retryDelaysMs[attempt];
				if (
					delayMs === undefined ||
					!isRetryablePolicyStatus(policy, readHttpStatus(error))
				) {
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
	): Promise<MosiSegmentResult> {
		const boundary = `----EchoNotesBoundary${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
		let response;
		try {
			response = await requestUrl({
				url: buildMosiTranscriptionsUrl(this.settings.baseUrl),
				method: "POST",
				throw: false,
				headers: {
					Authorization: `Bearer ${this.apiKey.trim()}`,
					"Content-Type": `multipart/form-data; boundary=${boundary}`
				},
				body: buildMosiMultipartBody(
					boundary,
					audioBuffer,
					fileName,
					mimeType,
					isMosiSpeakerDiarizationModel(this.settings.model)
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

		const normalized = normalizeMosiTranscriptionResponse(
			response.json,
			isMosiSpeakerDiarizationModel(this.settings.model)
		);
		return {
			text: normalized.text,
			traceId,
			utterances: normalized.utterances,
			raw: response.json
		};
	}
}

function buildSegmentFileName(sourceFileName: string, chunk: WavAudioSegment): string {
	const extensionIndex = sourceFileName.lastIndexOf(".");
	const basename = extensionIndex > 0 ? sourceFileName.slice(0, extensionIndex) : sourceFileName;
	return `${basename}.segment-${chunk.index.toString().padStart(2, "0")}.wav`;
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

function readHttpStatus(error: unknown): number | undefined {
	return error instanceof TranscriptionError ? error.httpStatus : undefined;
}

function shouldRecoverMosiError(
	policy: ProviderTranscriptionPolicy,
	error: unknown
): boolean {
	return (
		error instanceof TranscriptionError &&
		(error.code === "file_too_large" ||
			shouldSplitPolicyError(policy, error.httpStatus))
	);
}

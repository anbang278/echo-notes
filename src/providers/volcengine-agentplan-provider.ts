import type { App } from "obsidian";
import { runAudioChunkPipeline } from "../audio/audio-chunk-pipeline";
import {
	createWavAudioSegments,
	formatSegmentTimeRange,
	type WavAudioSegment
} from "../audio/audio-segmenter";
import { isSupportedAudioFile } from "../audio/audio-detector";
import type { TranscriptionConfig } from "../settings/settings";
import {
	normalizeAgentPlanError,
	transcribeAgentPlanWav,
	type AgentPlanSocketFactory
} from "./volcengine-agentplan-client";
import { loadAgentPlanSocketFactory } from "./volcengine-agentplan-socket";
import { resolveProviderTranscriptionPolicy, type ProviderTranscriptionPolicy } from "./transcription-policy";
import {
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult,
	type TranscriptionUtterance
} from "./transcription-provider";
import {
	normalizeAgentPlanUtterances,
	type AgentPlanResponsePayload
} from "./volcengine-agentplan-protocol";

export interface AgentPlanOfflineProviderDependencies {
	isMobile: () => boolean;
	createSegments?: typeof createWavAudioSegments;
	createSocket?: AgentPlanSocketFactory;
	transcribeWav?: typeof transcribeAgentPlanWav;
	sleep?: (delayMs: number) => Promise<void>;
}

export class VolcengineAgentPlanAsrProvider implements TranscriptionProvider {
	id = "volcengine-agentplan";
	name = "火山引擎 AgentPlan";

	private app: App;
	private settings: TranscriptionConfig;
	private apiKey: string;
	private createSegments: typeof createWavAudioSegments;
	private createSocket?: AgentPlanSocketFactory;
	private transcribeWav: typeof transcribeAgentPlanWav;
	private sleep: (delayMs: number) => Promise<void>;
	private isMobile: () => boolean;

	constructor(
		app: App,
		settings: TranscriptionConfig,
		apiKey: string,
		dependencies: AgentPlanOfflineProviderDependencies
	) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
		this.createSegments = dependencies.createSegments ?? createWavAudioSegments;
		this.createSocket = dependencies.createSocket;
		this.transcribeWav = dependencies.transcribeWav ?? transcribeAgentPlanWav;
		this.isMobile = dependencies.isMobile;
		this.sleep =
			dependencies.sleep ??
			((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置火山引擎 AgentPlan 专属 API Key。");
		}
		if (this.isMobile()) {
			throw new TranscriptionError(
				"unsupported_audio",
				"火山引擎 AgentPlan 转写仅支持 Obsidian 桌面端；移动端无法为 WebSocket 握手写入鉴权请求头。"
			);
		}
		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const sourceAudioBuffer = await this.app.vault.readBinary(input.audioFile);
		const policy = resolveProviderTranscriptionPolicy({
			provider: "volcengine-agentplan",
			model: this.settings.model
		});
		let chunks: WavAudioSegment[];
		try {
			chunks = await this.createSegments(sourceAudioBuffer, {
				targetSegmentSeconds: policy.targetSegmentSeconds,
				minSegmentSeconds: policy.minSegmentSeconds
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError(
				"audio_decode_error",
				`音频解码失败，无法转换并切分为 AgentPlan 所需的 16 kHz mono WAV：${message}`
			);
		}
		if (chunks.length === 0) {
			throw new TranscriptionError("audio_decode_error", "音频解码后没有可转写的有效内容。");
		}
		const createSocket = this.createSocket ?? await loadAgentPlanSocketFactory();

		if (chunks.length === 1) {
			const chunk = chunks[0];
			try {
				const result = await this.transcribeChunkWithRetry(
					chunk,
					input,
					policy,
					createSocket,
					true
				);
				return {
					text: result.text,
					provider: this.id,
					model: this.settings.model,
					traceId: result.traceId,
					utterances: result.utterances,
					raw: result.raw
				};
			} finally {
				chunk.audioBuffer = new ArrayBuffer(0);
			}
		}

		const pipelineResult = await runAudioChunkPipeline<WavAudioSegment, AgentPlanResponsePayload>({
			onProgress: input.onProgress,
			createChunks: async () => chunks,
			transcribeChunk: async (chunk) => {
				try {
					return await this.transcribeChunkWithRetry(
						chunk,
						input,
						policy,
						createSocket,
						false
					);
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

	private async transcribeChunkWithRetry(
		chunk: WavAudioSegment,
		input: TranscriptionInput,
		policy: ProviderTranscriptionPolicy,
		createSocket: AgentPlanSocketFactory,
		reportStreamingProgress: boolean
	): Promise<{
		text: string;
		traceId?: string;
		utterances?: TranscriptionUtterance[];
		raw: AgentPlanResponsePayload;
	}> {
		for (let attempt = 0; ; attempt += 1) {
			try {
				const result = await this.transcribeWav({
					url: this.settings.baseUrl.trim(),
					apiKey: this.apiKey.trim(),
					language: input.language ?? this.settings.language,
					requestMode: "nostream",
					wavBytes: new Uint8Array(chunk.audioBuffer),
					createSocket,
					onProgress: reportStreamingProgress
						? async (progress) => {
								await input.onProgress?.({
									type: "streaming-result",
									text: progress.text,
									utterances: progress.utterances,
									processedSeconds: progress.processedSeconds,
									totalSeconds: progress.totalSeconds,
									traceId: progress.traceId
								});
							}
						: undefined
				});
				return {
					text: result.text,
					traceId: result.traceId,
					utterances: offsetAgentPlanUtterances(
						normalizeAgentPlanUtterances(result.raw.result?.utterances),
						chunk.startSeconds
					),
					raw: result.raw
				};
			} catch (error) {
				const normalizedError = normalizeAgentPlanError(error);
				const delayMs = policy.retryDelaysMs[attempt];
				if (delayMs === undefined || !isRetryableAgentPlanOfflineError(normalizedError)) {
					throw normalizedError;
				}

				await input.onProgress?.({
					type: "segment-retrying",
					segment: { ...chunk },
					attempt: attempt + 1,
					maxAttempts: policy.retryDelaysMs.length,
					delayMs,
					segments: []
				});
				await this.sleep(delayMs);
			}
		}
	}
}

export function isRetryableAgentPlanOfflineError(error: TranscriptionError): boolean {
	return (
		error.code === "network_error" ||
		error.code === "rate_limited"
	);
}

export function offsetAgentPlanUtterances(
	utterances: TranscriptionUtterance[] | undefined,
	offsetSeconds: number
): TranscriptionUtterance[] | undefined {
	if (!utterances) {
		return undefined;
	}
	return utterances.map((utterance) => ({
		...utterance,
		...(utterance.startSeconds !== undefined
			? { startSeconds: utterance.startSeconds + offsetSeconds }
			: {}),
		...(utterance.endSeconds !== undefined
			? { endSeconds: utterance.endSeconds + offsetSeconds }
			: {})
	}));
}

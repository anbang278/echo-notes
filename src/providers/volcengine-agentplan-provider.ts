import type { App } from "obsidian";
import { probeAudioDurationSeconds } from "../audio/audio-duration";
import {
	getAudioMimeType,
	isSupportedAudioFile
} from "../audio/audio-detector";
import { createWavAudioBuffer } from "../audio/audio-segmenter";
import type { TranscriptionConfig } from "../settings/settings";
import { resolveProviderTranscriptionPolicy } from "./transcription-policy";
import {
	createNetworkTranscriptionError,
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";
import {
	AGENTPLAN_FLASH_MAX_AUDIO_BYTES,
	AGENTPLAN_FLASH_MAX_DURATION_SECONDS,
	transcribeAgentPlanFlash,
	type AgentPlanFlashRequest,
	type AgentPlanFlashClientResult
} from "./volcengine-agentplan-flash-client";
import {
	getAgentPlanWavDurationSeconds,
	normalizeAgentPlanUtterances
} from "./volcengine-agentplan-protocol";

export interface AgentPlanOfflineProviderDependencies {
	createWavBuffer?: typeof createWavAudioBuffer;
	probeDuration?: typeof probeAudioDurationSeconds;
	transcribeFlash?: typeof transcribeAgentPlanFlash;
	request?: AgentPlanFlashRequest;
	sleep?: (delayMs: number) => Promise<void>;
}

const AGENTPLAN_FLASH_DIRECT_UPLOAD_EXTENSIONS = new Set([
	"wav",
	"mp3",
	"mpeg",
	"mpga",
	"ogg"
]);

export class VolcengineAgentPlanAsrProvider implements TranscriptionProvider {
	id = "volcengine-agentplan";
	name = "火山引擎 AgentPlan";

	private app: App;
	private settings: TranscriptionConfig;
	private apiKey: string;
	private createWavBuffer: typeof createWavAudioBuffer;
	private probeDuration: typeof probeAudioDurationSeconds;
	private transcribeFlash: typeof transcribeAgentPlanFlash;
	private request: AgentPlanFlashRequest;
	private sleep: (delayMs: number) => Promise<void>;

	constructor(
		app: App,
		settings: TranscriptionConfig,
		apiKey: string,
		dependencies: AgentPlanOfflineProviderDependencies = {}
	) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
		this.createWavBuffer = dependencies.createWavBuffer ?? createWavAudioBuffer;
		this.probeDuration = dependencies.probeDuration ?? probeAudioDurationSeconds;
		this.transcribeFlash = dependencies.transcribeFlash ?? transcribeAgentPlanFlash;
		this.request = dependencies.request ?? (async () => {
			throw new Error("AgentPlan 极速版 HTTP 请求实现未配置。");
		});
		this.sleep =
			dependencies.sleep ??
			((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError(
				"missing_api_key",
				"请先在 Echo Notes 设置中配置火山引擎 AgentPlan 专属 API Key。"
			);
		}
		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError(
				"unsupported_format",
				`不支持的音频格式：${input.audioFile.extension}`
			);
		}
		const usesOriginalAudio = AGENTPLAN_FLASH_DIRECT_UPLOAD_EXTENSIONS.has(
			input.audioFile.extension.toLowerCase()
		);
		if (
			usesOriginalAudio &&
			input.audioFile.stat.size > AGENTPLAN_FLASH_MAX_AUDIO_BYTES
		) {
			throw new TranscriptionError(
				"file_too_large",
				`AgentPlan 极速版单次音频不能超过 100 MB；当前文件为 ${formatMegabytes(input.audioFile.stat.size)} MB。`
			);
		}

		const sourceAudioBuffer = await this.app.vault.readBinary(input.audioFile);
		const sourceMimeType = getAudioMimeType(input.audioFile);
		let durationSeconds = await this.probeDuration(sourceAudioBuffer, sourceMimeType);
		this.assertDurationWithinLimit(durationSeconds);

		let uploadAudioBuffer: ArrayBuffer;
		if (usesOriginalAudio) {
			uploadAudioBuffer = sourceAudioBuffer;
		} else {
			try {
				uploadAudioBuffer = await this.createWavBuffer(sourceAudioBuffer);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new TranscriptionError(
					"audio_decode_error",
					`音频解码失败，无法转换为 AgentPlan 极速版支持的 16 kHz mono WAV：${message}`
				);
			}
			if (uploadAudioBuffer.byteLength <= 44) {
				throw new TranscriptionError(
					"audio_decode_error",
					"音频解码后没有可转写的有效内容。"
				);
			}
			durationSeconds ??= getAgentPlanWavDurationSeconds(
				new Uint8Array(uploadAudioBuffer)
			);
			this.assertDurationWithinLimit(durationSeconds);
		}

		if (uploadAudioBuffer.byteLength === 0) {
			throw new TranscriptionError("audio_decode_error", "待转写音频为空。");
		}
		if (uploadAudioBuffer.byteLength > AGENTPLAN_FLASH_MAX_AUDIO_BYTES) {
			throw new TranscriptionError(
				"file_too_large",
				`AgentPlan 极速版单次音频不能超过 100 MB；当前待上传音频为 ${formatMegabytes(uploadAudioBuffer.byteLength)} MB。`
			);
		}

		const policy = resolveProviderTranscriptionPolicy({
			provider: "volcengine-agentplan",
			model: this.settings.model
		});
		const totalAttempts = policy.retryDelaysMs.length + 1;
		const traceIds: string[] = [];

		for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
			await input.onProgress?.({
				type: "whole-audio-request-started",
				attempt,
				totalAttempts,
				audioBytes: uploadAudioBuffer.byteLength,
				durationSeconds
			});
			try {
				const result = await this.transcribeFlash({
					url: this.settings.baseUrl.trim(),
					apiKey,
					language: input.language ?? this.settings.language,
					audioBytes: new Uint8Array(uploadAudioBuffer),
					request: this.request
				});
				appendTraceId(traceIds, result.traceId);
				return this.createResult(result, traceIds);
			} catch (error) {
				const normalizedError = normalizeAgentPlanFlashError(error);
				appendTraceId(traceIds, normalizedError.traceId);
				const delayMs = policy.retryDelaysMs[attempt - 1];
				if (
					delayMs === undefined ||
					!isRetryableAgentPlanOfflineError(normalizedError)
				) {
					normalizedError.traceId = joinTraceIds(traceIds);
					throw normalizedError;
				}

				await input.onProgress?.({
					type: "segment-retrying",
					attempt: attempt + 1,
					maxAttempts: totalAttempts,
					delayMs,
					httpStatus: normalizedError.httpStatus,
					segments: []
				});
				await this.sleep(delayMs);
			}
		}

		throw new TranscriptionError(
			"api_error",
			"火山引擎 AgentPlan 极速版未返回结果。",
			joinTraceIds(traceIds)
		);
	}

	private assertDurationWithinLimit(durationSeconds: number | undefined): void {
		if (
			durationSeconds !== undefined &&
			Number.isFinite(durationSeconds) &&
			durationSeconds > AGENTPLAN_FLASH_MAX_DURATION_SECONDS
		) {
			throw new TranscriptionError(
				"file_too_large",
				`AgentPlan 极速版单次音频不能超过 2 小时；当前音频约 ${formatDuration(durationSeconds)}。`
			);
		}
	}

	private createResult(
		result: AgentPlanFlashClientResult,
		traceIds: string[]
	): TranscriptionResult {
		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: joinTraceIds(traceIds),
			utterances: normalizeAgentPlanUtterances(result.raw.result?.utterances),
			raw: result.raw
		};
	}
}

export function isRetryableAgentPlanOfflineError(
	error: TranscriptionError
): boolean {
	return error.code === "network_error" || error.code === "rate_limited";
}

function normalizeAgentPlanFlashError(error: unknown): TranscriptionError {
	return error instanceof TranscriptionError
		? error
		: createNetworkTranscriptionError("火山引擎 AgentPlan 极速版", error);
}

function appendTraceId(traceIds: string[], traceId: string | undefined): void {
	for (const value of traceId?.split(",") ?? []) {
		const normalized = value.trim();
		if (normalized && !traceIds.includes(normalized)) {
			traceIds.push(normalized);
		}
	}
}

function joinTraceIds(traceIds: string[]): string | undefined {
	return traceIds.length > 0 ? traceIds.join(", ") : undefined;
}

function formatMegabytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

function formatDuration(seconds: number): string {
	const roundedMinutes = Math.ceil(seconds / 60);
	return `${Math.floor(roundedMinutes / 60)} 小时 ${roundedMinutes % 60} 分钟`;
}

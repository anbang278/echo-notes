import { App, Platform } from "obsidian";
import { createWavAudioBuffer } from "../audio/audio-segmenter";
import { isSupportedAudioFile } from "../audio/audio-detector";
import type { TranscriptionConfig } from "../settings/settings";
import {
	normalizeAgentPlanError,
	transcribeAgentPlanWav
} from "./volcengine-agentplan-client";
import { loadAgentPlanSocketFactory } from "./volcengine-agentplan-socket";
import {
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";
import { normalizeAgentPlanUtterances } from "./volcengine-agentplan-protocol";

export class VolcengineAgentPlanAsrProvider implements TranscriptionProvider {
	id = "volcengine-agentplan";
	name = "火山引擎 AgentPlan";

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
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置火山引擎 AgentPlan 专属 API Key。");
		}
		if (Platform.isMobile) {
			throw new TranscriptionError(
				"unsupported_audio",
				"火山引擎 AgentPlan 转写仅支持 Obsidian 桌面端；移动端无法为 WebSocket 握手写入鉴权请求头。"
			);
		}
		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const sourceAudioBuffer = await this.app.vault.readBinary(input.audioFile);
		const createSocket = await loadAgentPlanSocketFactory();
		let wavAudioBuffer: ArrayBuffer;
		try {
			wavAudioBuffer = await createWavAudioBuffer(sourceAudioBuffer);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError("audio_decode_error", `音频解码失败，无法转换为 AgentPlan 所需的 16 kHz mono WAV：${message}`);
		}

		let result;
		try {
			result = await transcribeAgentPlanWav({
				url: this.settings.baseUrl.trim(),
				apiKey,
				language: input.language ?? this.settings.language,
				wavBytes: new Uint8Array(wavAudioBuffer),
				createSocket,
				onProgress: async (progress) => {
					await input.onProgress?.({
						type: "streaming-result",
						text: progress.text,
						utterances: progress.utterances,
						processedSeconds: progress.processedSeconds,
						totalSeconds: progress.totalSeconds,
						traceId: progress.traceId
					});
				}
			});
		} catch (error) {
			throw normalizeAgentPlanError(error);
		}

		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: result.traceId,
			utterances: normalizeAgentPlanUtterances(result.raw.result?.utterances),
			raw: result.raw
		};
	}
}

import type { App } from "obsidian";
import {
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
	type OfflineTranscriptionProviderId,
	type TranscriptionConfig
} from "../settings/settings";
import { AliyunBailianQwenAsrProvider } from "./aliyun-bailian-provider";
import { MosiTranscriptionProvider } from "./mosi-provider";
import { OpenAICompatibleAudioProvider } from "./openai-compatible-provider";
import { SiliconFlowTeleSpeechProvider } from "./siliconflow-provider";
import type { TranscriptionProvider } from "./transcription-provider";

export function createTranscriptionProvider(
	app: App,
	settings: TranscriptionConfig<OfflineTranscriptionProviderId>,
	apiKey: string
): TranscriptionProvider {
	switch (settings.provider) {
		case "aliyun-bailian":
			return new AliyunBailianQwenAsrProvider(app, settings, apiKey);
		case "siliconflow":
			return new SiliconFlowTeleSpeechProvider(app, settings, apiKey);
		case "mosi":
			return new MosiTranscriptionProvider(app, settings, apiKey);
		case "ollama":
		case "lm-studio":
			return new OpenAICompatibleAudioProvider(
				app,
				settings,
				apiKey,
				settings.provider,
				PROVIDER_LABELS[settings.provider]
			);
		default:
			return new AliyunBailianQwenAsrProvider(
				app,
				{
					provider: "aliyun-bailian",
					...PROVIDER_DEFAULTS["aliyun-bailian"]
				},
				apiKey
			);
	}
}

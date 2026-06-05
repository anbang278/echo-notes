import type { App } from "obsidian";
import { isProviderId, PROVIDER_LABELS, type EchoNotesSettings } from "../settings/settings";
import { AliyunBailianQwenAsrProvider } from "./aliyun-bailian-provider";
import { OpenAICompatibleAudioProvider } from "./openai-compatible-provider";
import { SiliconFlowTeleSpeechProvider } from "./siliconflow-provider";
import type { TranscriptionProvider } from "./transcription-provider";

export function createTranscriptionProvider(app: App, settings: EchoNotesSettings, apiKey: string): TranscriptionProvider {
	switch (settings.provider) {
		case "aliyun-bailian":
			return new AliyunBailianQwenAsrProvider(app, settings, apiKey);
		case "openai":
			return new OpenAICompatibleAudioProvider(app, settings, apiKey, "openai", PROVIDER_LABELS.openai);
		case "groq":
			return new OpenAICompatibleAudioProvider(app, settings, apiKey, "groq", PROVIDER_LABELS.groq);
		case "custom-openai-compatible":
			return new OpenAICompatibleAudioProvider(
				app,
				settings,
				apiKey,
				"custom-openai-compatible",
				PROVIDER_LABELS["custom-openai-compatible"]
			);
		case "siliconflow":
			return new SiliconFlowTeleSpeechProvider(app, settings, apiKey);
		default:
			if (isProviderId(settings.provider)) {
				return new OpenAICompatibleAudioProvider(
					app,
					settings,
					apiKey,
					settings.provider,
					PROVIDER_LABELS[settings.provider]
				);
			}
			return new AliyunBailianQwenAsrProvider(app, settings, apiKey);
	}
}

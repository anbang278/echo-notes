import type { App } from "obsidian";
import type { EchoNotesSettings } from "../settings/settings";
import { AliyunBailianQwenAsrProvider } from "./aliyun-bailian-provider";
import { SiliconFlowTeleSpeechProvider } from "./siliconflow-provider";
import type { TranscriptionProvider } from "./transcription-provider";

export function createTranscriptionProvider(app: App, settings: EchoNotesSettings, apiKey: string): TranscriptionProvider {
	switch (settings.provider) {
		case "aliyun-bailian":
			return new AliyunBailianQwenAsrProvider(app, settings, apiKey);
		case "siliconflow":
			return new SiliconFlowTeleSpeechProvider(app, settings, apiKey);
		default:
			return new SiliconFlowTeleSpeechProvider(app, settings, apiKey);
	}
}

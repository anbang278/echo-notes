export type ProviderId = "siliconflow" | "aliyun-bailian";

export type OutputStrategy = "same-name-subfolder" | "same-folder" | "custom-folder";

export type InsertStyle = "linkOnly" | "callout";

export interface EchoNotesSettings {
	provider: string;
	apiKey?: string;
	baseUrl: string;
	model: string;
	language: string;
	outputStrategy: OutputStrategy;
	customOutputFolder: string;
	insertStyle: InsertStyle;
	skipExistingTranscript: boolean;
	autoTranscribeOnAudioLink: boolean;
	autoTranscribeOnAudioCreated: boolean;
	verboseLog: boolean;
}

export const DEFAULT_SETTINGS: EchoNotesSettings = {
	provider: "siliconflow",
	baseUrl: "https://api.siliconflow.cn",
	model: "TeleAI/TeleSpeechASR",
	language: "auto",
	outputStrategy: "same-name-subfolder",
	customOutputFolder: "Transcripts",
	insertStyle: "linkOnly",
	skipExistingTranscript: true,
	autoTranscribeOnAudioLink: false,
	autoTranscribeOnAudioCreated: false,
	verboseLog: false
};

export const PROVIDER_DEFAULTS: Record<ProviderId, Pick<EchoNotesSettings, "baseUrl" | "model" | "language">> = {
	siliconflow: {
		baseUrl: "https://api.siliconflow.cn",
		model: "TeleAI/TeleSpeechASR",
		language: "auto"
	},
	"aliyun-bailian": {
		baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		model: "qwen3-asr-flash",
		language: "auto"
	}
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	siliconflow: "SiliconFlow",
	"aliyun-bailian": "阿里百炼"
};

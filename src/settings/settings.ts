export type ProviderId =
	| "siliconflow"
	| "aliyun-bailian"
	| "openai"
	| "groq"
	| "custom-openai-compatible";

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
	},
	openai: {
		baseUrl: "https://api.openai.com/v1",
		model: "whisper-1",
		language: "auto"
	},
	groq: {
		baseUrl: "https://api.groq.com/openai/v1",
		model: "whisper-large-v3-turbo",
		language: "auto"
	},
	"custom-openai-compatible": {
		baseUrl: "https://example.com/v1",
		model: "whisper-1",
		language: "auto"
	}
};

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	siliconflow: "硅基流动（SiliconFlow）",
	"aliyun-bailian": "阿里百炼（Alibaba Bailian）",
	openai: "OpenAI（OpenAI）",
	groq: "Groq（Groq）",
	"custom-openai-compatible": "自定义兼容接口（Custom OpenAI-compatible）"
};

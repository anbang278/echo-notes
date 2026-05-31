export type ProviderId =
	| "siliconflow"
	| "aliyun-bailian"
	| "openai"
	| "ollama"
	| "ollama-open-webui"
	| "google-gemini"
	| "openrouter"
	| "lm-studio"
	| "groq"
	| "302-ai"
	| "anthropic"
	| "mistral-ai"
	| "together-ai"
	| "fireworks-ai"
	| "perplexity-ai"
	| "deepseek"
	| "xai"
	| "novita-ai"
	| "deepinfra"
	| "sambanova"
	| "cerebras"
	| "z-ai"
	| "custom-openai-compatible";

export type OutputStrategy = "same-name-subfolder" | "same-folder" | "custom-folder";

export type InsertStyle = "linkOnly" | "callout";

export type CopyLanguage = "zh" | "en";

export type AnalysisProviderId = "deepseek" | "openai" | "custom-openai-compatible";

export type AnalysisTemplateId = "work-minutes" | "study-notes" | "product-requirement-mining";

export interface EchoNotesSettings {
	provider: string;
	apiKey?: string;
	baseUrl: string;
	model: string;
	language: string;
	outputStrategy: OutputStrategy;
	customOutputFolder: string;
	insertStyle: InsertStyle;
	copyLanguage: CopyLanguage;
	analysisProvider: AnalysisProviderId;
	analysisApiKey?: string;
	analysisBaseUrl: string;
	analysisModel: string;
	autoAnalyzeAfterTranscription: boolean;
	autoAnalysisTemplate: AnalysisTemplateId;
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
	copyLanguage: "zh",
	analysisProvider: "deepseek",
	analysisBaseUrl: "https://api.deepseek.com/v1",
	analysisModel: "deepseek-chat",
	autoAnalyzeAfterTranscription: false,
	autoAnalysisTemplate: "work-minutes",
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
	ollama: {
		baseUrl: "http://localhost:11434/v1",
		model: "whisper-1",
		language: "auto"
	},
	"ollama-open-webui": {
		baseUrl: "http://localhost:3000/api",
		model: "whisper-1",
		language: "auto"
	},
	"google-gemini": {
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		model: "whisper-1",
		language: "auto"
	},
	openrouter: {
		baseUrl: "https://openrouter.ai/api/v1",
		model: "whisper-1",
		language: "auto"
	},
	"lm-studio": {
		baseUrl: "http://localhost:1234/v1",
		model: "whisper-1",
		language: "auto"
	},
	groq: {
		baseUrl: "https://api.groq.com/openai/v1",
		model: "whisper-large-v3-turbo",
		language: "auto"
	},
	"302-ai": {
		baseUrl: "https://api.302.ai/v1",
		model: "whisper-1",
		language: "auto"
	},
	anthropic: {
		baseUrl: "https://api.anthropic.com/v1",
		model: "whisper-1",
		language: "auto"
	},
	"mistral-ai": {
		baseUrl: "https://api.mistral.ai/v1",
		model: "whisper-1",
		language: "auto"
	},
	"together-ai": {
		baseUrl: "https://api.together.xyz/v1",
		model: "whisper-1",
		language: "auto"
	},
	"fireworks-ai": {
		baseUrl: "https://api.fireworks.ai/inference/v1",
		model: "whisper-1",
		language: "auto"
	},
	"perplexity-ai": {
		baseUrl: "https://api.perplexity.ai",
		model: "whisper-1",
		language: "auto"
	},
	deepseek: {
		baseUrl: "https://api.deepseek.com/v1",
		model: "whisper-1",
		language: "auto"
	},
	xai: {
		baseUrl: "https://api.x.ai/v1",
		model: "whisper-1",
		language: "auto"
	},
	"novita-ai": {
		baseUrl: "https://api.novita.ai/v3/openai",
		model: "whisper-1",
		language: "auto"
	},
	deepinfra: {
		baseUrl: "https://api.deepinfra.com/v1/openai",
		model: "openai/whisper-large-v3",
		language: "auto"
	},
	sambanova: {
		baseUrl: "https://api.sambanova.ai/v1",
		model: "whisper-1",
		language: "auto"
	},
	cerebras: {
		baseUrl: "https://api.cerebras.ai/v1",
		model: "whisper-1",
		language: "auto"
	},
	"z-ai": {
		baseUrl: "https://open.bigmodel.cn/api/paas/v4",
		model: "whisper-1",
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
	ollama: "Ollama",
	"ollama-open-webui": "Ollama（Open WebUI）",
	"google-gemini": "Google Gemini",
	openrouter: "OpenRouter",
	"lm-studio": "LM Studio",
	groq: "Groq（Groq）",
	"302-ai": "302.AI",
	anthropic: "Anthropic",
	"mistral-ai": "Mistral AI",
	"together-ai": "Together AI",
	"fireworks-ai": "Fireworks AI",
	"perplexity-ai": "Perplexity AI",
	deepseek: "DeepSeek",
	xai: "xAI（Grok）",
	"novita-ai": "Novita AI",
	deepinfra: "DeepInfra",
	sambanova: "SambaNova",
	cerebras: "Cerebras",
	"z-ai": "Z.AI",
	"custom-openai-compatible": "自定义兼容接口（Custom OpenAI-compatible）"
};

export const COPY_LANGUAGE_LABELS: Record<CopyLanguage, string> = {
	zh: "中文",
	en: "English"
};

export const ANALYSIS_PROVIDER_DEFAULTS: Record<AnalysisProviderId, Pick<EchoNotesSettings, "analysisBaseUrl" | "analysisModel">> = {
	deepseek: {
		analysisBaseUrl: "https://api.deepseek.com/v1",
		analysisModel: "deepseek-chat"
	},
	openai: {
		analysisBaseUrl: "https://api.openai.com/v1",
		analysisModel: "gpt-4o-mini"
	},
	"custom-openai-compatible": {
		analysisBaseUrl: "https://example.com/v1",
		analysisModel: "gpt-4o-mini"
	}
};

export const ANALYSIS_PROVIDER_LABELS: Record<AnalysisProviderId, string> = {
	deepseek: "DeepSeek",
	openai: "OpenAI",
	"custom-openai-compatible": "自定义兼容接口（Custom OpenAI-compatible）"
};

export const ANALYSIS_TEMPLATE_LABELS: Record<AnalysisTemplateId, string> = {
	"work-minutes": "工作纪要",
	"study-notes": "学习纪要",
	"product-requirement-mining": "产品需求挖掘纪要"
};

export interface LocalizedCopy {
	transcriptLinkAlias: string;
	calloutTitle: string;
	transcriptTitleSuffix: string;
	sourceAudioLabel: string;
	sourceNoteLabel: string;
	transcriptHeading: string;
	failedTitle: string;
	errorReasonLabel: string;
	analysisLinksHeading: string;
	sourceTranscriptLabel: string;
	analysisHeading: string;
}

export const LOCALIZED_COPY: Record<CopyLanguage, LocalizedCopy> = {
	zh: {
		transcriptLinkAlias: "查看转写稿",
		calloutTitle: "音频转写稿",
		transcriptTitleSuffix: "转写稿",
		sourceAudioLabel: "原始录音：",
		sourceNoteLabel: "来源笔记：",
		transcriptHeading: "转写稿",
		failedTitle: "转写失败",
		errorReasonLabel: "错误原因：",
		analysisLinksHeading: "AI 纪要分析",
		sourceTranscriptLabel: "来源转写稿：",
		analysisHeading: "分析结果"
	},
	en: {
		transcriptLinkAlias: "View the transcribed manuscript",
		calloutTitle: "Audio transcription",
		transcriptTitleSuffix: "Transcribed manuscript",
		sourceAudioLabel: "Original recording: ",
		sourceNoteLabel: "Source note: ",
		transcriptHeading: "Transcribed manuscript",
		failedTitle: "Transcription failed",
		errorReasonLabel: "Error reason:",
		analysisLinksHeading: "AI Analysis",
		sourceTranscriptLabel: "Source transcript: ",
		analysisHeading: "Analysis"
	}
};

export function getLocalizedCopy(language: string | undefined): LocalizedCopy {
	return language === "en" ? LOCALIZED_COPY.en : LOCALIZED_COPY.zh;
}

export function isProviderId(value: string): value is ProviderId {
	return value in PROVIDER_LABELS;
}

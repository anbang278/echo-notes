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

export type BuiltInAnalysisTemplateId = "work-minutes" | "study-notes" | "product-requirement-mining";

export type AnalysisTemplateId = string;

export interface AnalysisTemplateConfig {
	id: AnalysisTemplateId;
	name: string;
	description: string;
	prompt: string;
	enabled: boolean;
	builtin: boolean;
}

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
	analysisEnabled: boolean;
	promptForAnalysisTemplateOnTranscription: boolean;
	analysisTemplates: AnalysisTemplateConfig[];
	skipExistingTranscript: boolean;
	autoTranscribeOnAudioLink: boolean;
	autoTranscribeOnAudioCreated: boolean;
	verboseLog: boolean;
}

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

export const BUILTIN_ANALYSIS_TEMPLATE_IDS: BuiltInAnalysisTemplateId[] = [
	"work-minutes",
	"study-notes",
	"product-requirement-mining"
];

export const DEFAULT_ANALYSIS_TEMPLATES: Record<BuiltInAnalysisTemplateId, AnalysisTemplateConfig> = {
	"work-minutes": {
		id: "work-minutes",
		name: "工作纪要",
		description: "适合工作同步、会议复盘和任务追踪。",
		prompt: [
			"请生成工作纪要，固定包含以下 Markdown 二级标题：",
			"## 摘要",
			"## 关键结论",
			"## 行动项",
			"## 风险/阻塞",
			"## 待确认问题",
			"",
			"行动项尽量包含负责人、事项和截止时间；未提及时写“待确认”。"
		].join("\n"),
		enabled: true,
		builtin: true
	},
	"study-notes": {
		id: "study-notes",
		name: "学习纪要",
		description: "适合课程、读书、分享和知识复盘。",
		prompt: [
			"请生成学习纪要，固定包含以下 Markdown 二级标题：",
			"## 核心概念",
			"## 知识要点",
			"## 案例/例子",
			"## 易混淆点",
			"## 复习清单",
			"",
			"复习清单要写成可执行的检查项。"
		].join("\n"),
		enabled: true,
		builtin: true
	},
	"product-requirement-mining": {
		id: "product-requirement-mining",
		name: "产品需求挖掘纪要",
		description: "适合从访谈、会议和反馈中提炼产品需求。",
		prompt: [
			"请生成产品需求挖掘纪要，固定包含以下 Markdown 二级标题：",
			"## 用户/场景",
			"## 痛点",
			"## 需求机会",
			"## 功能建议",
			"## 优先级",
			"## 验收标准",
			"## 开放问题",
			"",
			"优先级请使用 P0/P1/P2；验收标准尽量写成可验证条目。"
		].join("\n"),
		enabled: true,
		builtin: true
	}
};

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
	analysisEnabled: false,
	promptForAnalysisTemplateOnTranscription: false,
	analysisTemplates: createDefaultAnalysisTemplates(),
	skipExistingTranscript: true,
	autoTranscribeOnAudioLink: false,
	autoTranscribeOnAudioCreated: false,
	verboseLog: false
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

export function createDefaultAnalysisTemplates(): AnalysisTemplateConfig[] {
	return BUILTIN_ANALYSIS_TEMPLATE_IDS.map((id) => cloneAnalysisTemplate(DEFAULT_ANALYSIS_TEMPLATES[id]));
}

export function normalizeEchoNotesSettings(rawData: unknown): EchoNotesSettings {
	const raw = isRecord(rawData) ? rawData : {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, raw) as EchoNotesSettings;
	const oldAutoAnalyze = raw.autoAnalyzeAfterTranscription === true;

	settings.analysisEnabled = typeof raw.analysisEnabled === "boolean" ? raw.analysisEnabled : oldAutoAnalyze;
	settings.promptForAnalysisTemplateOnTranscription =
		typeof raw.promptForAnalysisTemplateOnTranscription === "boolean"
			? raw.promptForAnalysisTemplateOnTranscription
			: typeof raw.promptForAnalysisAfterTranscription === "boolean"
				? raw.promptForAnalysisAfterTranscription
				: oldAutoAnalyze;
	settings.analysisTemplates = normalizeAnalysisTemplates(raw.analysisTemplates);

	const mutableSettings = settings as EchoNotesSettings & Record<string, unknown>;
	delete mutableSettings.autoAnalyzeAfterTranscription;
	delete mutableSettings.autoAnalysisTemplate;
	delete mutableSettings.promptForAnalysisAfterTranscription;

	return settings;
}

export function normalizeAnalysisTemplates(value: unknown): AnalysisTemplateConfig[] {
	const templates = Array.isArray(value) ? value.filter(isAnalysisTemplateLike).map(normalizeAnalysisTemplate) : [];
	const byId = new Map<string, AnalysisTemplateConfig>();

	for (const template of templates) {
		const id = sanitizeAnalysisTemplateId(template.id || template.name) || createAnalysisTemplateId("custom-template", Array.from(byId.keys()));
		byId.set(id, {
			...template,
			id,
			builtin: BUILTIN_ANALYSIS_TEMPLATE_IDS.includes(id as BuiltInAnalysisTemplateId)
		});
	}

	for (const id of BUILTIN_ANALYSIS_TEMPLATE_IDS) {
		const existing = byId.get(id);
		if (!existing) {
			byId.set(id, cloneAnalysisTemplate(DEFAULT_ANALYSIS_TEMPLATES[id]));
			continue;
		}

		const defaults = DEFAULT_ANALYSIS_TEMPLATES[id];
		byId.set(id, {
			...defaults,
			...existing,
			id,
			name: existing.name.trim() || defaults.name,
			description: existing.description.trim() || defaults.description,
			prompt: existing.prompt.trim() || defaults.prompt,
			builtin: true
		});
	}

	return [
		...BUILTIN_ANALYSIS_TEMPLATE_IDS.map((id) => byId.get(id)).filter((template): template is AnalysisTemplateConfig => Boolean(template)),
		...Array.from(byId.values()).filter((template) => !template.builtin)
	];
}

export function restoreDefaultAnalysisTemplate(templateId: string): AnalysisTemplateConfig | null {
	if (!BUILTIN_ANALYSIS_TEMPLATE_IDS.includes(templateId as BuiltInAnalysisTemplateId)) {
		return null;
	}

	return cloneAnalysisTemplate(DEFAULT_ANALYSIS_TEMPLATES[templateId as BuiltInAnalysisTemplateId]);
}

export function createCustomAnalysisTemplate(name: string, existingTemplates: AnalysisTemplateConfig[]): AnalysisTemplateConfig {
	return {
		id: createAnalysisTemplateId(name, existingTemplates.map((template) => template.id)),
		name: name.trim() || "自定义模板",
		description: "自定义转写稿分析模板。",
		prompt: [
			"请根据转写稿生成一份结构化纪要。",
			"你可以自行组织标题，但必须突出关键结论、行动建议和待确认问题。"
		].join("\n"),
		enabled: true,
		builtin: false
	};
}

export function createAnalysisTemplateId(name: string, existingIds: string[] = []): string {
	const base = sanitizeAnalysisTemplateId(name) || "custom-template";
	const existing = new Set(existingIds);
	if (!existing.has(base)) {
		return base;
	}

	let index = 2;
	while (existing.has(`${base}-${index}`)) {
		index += 1;
	}
	return `${base}-${index}`;
}

export function sanitizeAnalysisTemplateId(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "-")
		.replace(/[\\/:*?"<>|#[\]^]+/g, "-")
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function cloneAnalysisTemplate(template: AnalysisTemplateConfig): AnalysisTemplateConfig {
	return {
		...template
	};
}

function isAnalysisTemplateLike(value: unknown): value is Partial<AnalysisTemplateConfig> {
	return isRecord(value) && (typeof value.id === "string" || typeof value.name === "string");
}

function normalizeAnalysisTemplate(value: Partial<AnalysisTemplateConfig>): AnalysisTemplateConfig {
	const id = typeof value.id === "string" ? value.id : value.name ?? "";
	const name = typeof value.name === "string" ? value.name : id;
	return {
		id,
		name,
		description: typeof value.description === "string" ? value.description : "",
		prompt: typeof value.prompt === "string" ? value.prompt : "",
		enabled: typeof value.enabled === "boolean" ? value.enabled : true,
		builtin: typeof value.builtin === "boolean" ? value.builtin : false
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

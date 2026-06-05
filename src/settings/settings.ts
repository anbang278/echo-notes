import type { Hotkey, Modifier } from "obsidian";

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

export type AnalysisProviderId = ProviderId;

export type EchoNotesHotkeySetting = Hotkey | null;

export type BuiltInAnalysisTemplateId =
	| "work-minutes"
	| "study-notes"
	| "product-requirement-mining"
	| "manager-sync-minutes"
	| "product-manager-minutes"
	| "project-manager-minutes"
	| "engineering-minutes"
	| "sales-minutes"
	| "customer-success-minutes"
	| "operations-minutes"
	| "hr-minutes";

export type AnalysisTemplateId = string;

export interface AnalysisTemplateConfig {
	id: AnalysisTemplateId;
	name: string;
	description: string;
	systemPrompt: string;
	customPrompt: string;
	recognitionKeywords: string[];
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
	defaultAnalysisTemplateId: AnalysisTemplateId;
	analysisTemplates: AnalysisTemplateConfig[];
	skipExistingTranscript: boolean;
	autoTranscribeOnAudioLink: boolean;
	autoTranscribeOnAudioCreated: boolean;
	officialRecorderStartHotkey: EchoNotesHotkeySetting;
	officialRecorderStopHotkey: EchoNotesHotkeySetting;
	transcribeAllAudioHotkey: EchoNotesHotkeySetting;
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
	siliconflow: {
		analysisBaseUrl: "https://api.siliconflow.cn/v1",
		analysisModel: "deepseek-ai/DeepSeek-V3"
	},
	"aliyun-bailian": {
		analysisBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
		analysisModel: "deepseek-v4-pro"
	},
	openai: {
		analysisBaseUrl: "https://api.openai.com/v1",
		analysisModel: "gpt-4o-mini"
	},
	ollama: {
		analysisBaseUrl: "http://localhost:11434/v1",
		analysisModel: "llama3.1"
	},
	"ollama-open-webui": {
		analysisBaseUrl: "http://localhost:3000/api",
		analysisModel: "llama3.1"
	},
	"google-gemini": {
		analysisBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
		analysisModel: "gemini-2.0-flash"
	},
	openrouter: {
		analysisBaseUrl: "https://openrouter.ai/api/v1",
		analysisModel: "openai/gpt-4o-mini"
	},
	"lm-studio": {
		analysisBaseUrl: "http://localhost:1234/v1",
		analysisModel: "local-model"
	},
	groq: {
		analysisBaseUrl: "https://api.groq.com/openai/v1",
		analysisModel: "llama-3.3-70b-versatile"
	},
	"302-ai": {
		analysisBaseUrl: "https://api.302.ai/v1",
		analysisModel: "gpt-4o-mini"
	},
	anthropic: {
		analysisBaseUrl: "https://api.anthropic.com/v1",
		analysisModel: "claude-3-5-haiku-latest"
	},
	"mistral-ai": {
		analysisBaseUrl: "https://api.mistral.ai/v1",
		analysisModel: "mistral-small-latest"
	},
	"together-ai": {
		analysisBaseUrl: "https://api.together.xyz/v1",
		analysisModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo"
	},
	"fireworks-ai": {
		analysisBaseUrl: "https://api.fireworks.ai/inference/v1",
		analysisModel: "accounts/fireworks/models/llama-v3p3-70b-instruct"
	},
	"perplexity-ai": {
		analysisBaseUrl: "https://api.perplexity.ai",
		analysisModel: "sonar-pro"
	},
	deepseek: {
		analysisBaseUrl: "https://api.deepseek.com/v1",
		analysisModel: "deepseek-v4-pro"
	},
	xai: {
		analysisBaseUrl: "https://api.x.ai/v1",
		analysisModel: "grok-3-mini"
	},
	"novita-ai": {
		analysisBaseUrl: "https://api.novita.ai/v3/openai",
		analysisModel: "deepseek/deepseek-v3-0324"
	},
	deepinfra: {
		analysisBaseUrl: "https://api.deepinfra.com/v1/openai",
		analysisModel: "meta-llama/Meta-Llama-3.1-8B-Instruct"
	},
	sambanova: {
		analysisBaseUrl: "https://api.sambanova.ai/v1",
		analysisModel: "Meta-Llama-3.1-8B-Instruct"
	},
	cerebras: {
		analysisBaseUrl: "https://api.cerebras.ai/v1",
		analysisModel: "llama3.1-8b"
	},
	"z-ai": {
		analysisBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
		analysisModel: "glm-4-flash"
	},
	"custom-openai-compatible": {
		analysisBaseUrl: "https://example.com/v1",
		analysisModel: "gpt-4o-mini"
	}
};

export const ANALYSIS_PROVIDER_LABELS: Record<AnalysisProviderId, string> = PROVIDER_LABELS;

export const BUILTIN_ANALYSIS_TEMPLATE_IDS: BuiltInAnalysisTemplateId[] = [
	"work-minutes",
	"study-notes",
	"product-requirement-mining",
	"manager-sync-minutes",
	"product-manager-minutes",
	"project-manager-minutes",
	"engineering-minutes",
	"sales-minutes",
	"customer-success-minutes",
	"operations-minutes",
	"hr-minutes"
];

export const DEFAULT_ANALYSIS_SYSTEM_PROMPT = [
	"你是一个专业的录音文本分析助手，擅长将 ASR 转写后的非结构化文本，整理成适合长期沉淀的 Markdown 知识文档。",
	"",
	"你的任务不是简单总结全文，而是根据用户指定的分析场景，对录音转写内容进行结构化提炼、信息归纳、重点识别和后续行动建议生成。",
	"",
	"你需要遵循以下原则：",
	"",
	"1. 基于原文，不要编造",
	"- 所有分析必须严格基于输入的转写文本。",
	"- 如果原文没有明确提到，不要擅自补充事实、人物、时间、结论或背景。",
	"- 对于不确定的信息，需要标记为“未明确提及”或“需进一步确认”。",
	"- 如果 ASR 转写中存在明显错别字、断句错误或语义不连贯，可以在理解上下文的基础上进行合理修正，但不要改变原意。",
	"",
	"2. 保留关键信息，而不是泛泛总结",
	"- 不要只输出普通摘要。",
	"- 需要识别文本中的关键结论、重要观点、待办事项、问题、风险、疑点、需求、用户原话等高价值信息。",
	"- 对于有价值的原始表达，应尽量保留为“原文摘录”。",
	"- 如果存在多个主题，需要按主题进行分组，而不是混在一起输出。",
	"",
	"3. 根据不同场景采用不同分析重点",
	"- 用户会传入一个分析场景，你需要根据场景调整分析重点。",
	"",
	"4. 输出必须是 Markdown 格式",
	"- 输出内容要适合直接写入 Obsidian。",
	"- 使用清晰的 Markdown 标题层级。",
	"- 不要输出 JSON，除非用户明确要求。",
	"- 表格可以用于待办事项、需求列表、风险清单等结构化内容。",
	"- 如果内容较少，也要保持结构完整，但可以标注“未明确提及”。",
	"",
	"5. 生成适合知识管理的内容",
	"- 输出结果应该方便后续检索、复盘、引用和二次加工。",
	"- 可以生成标签、关联主题、后续问题、行动项。",
	"- 可以将内容整理成知识卡片、会议纪要、需求分析或学习笔记。",
	"- 不要把所有内容压缩成一段话，要形成可沉淀的结构化笔记。",
	"",
	"6. 处理转写文本的特殊情况",
	"- 如果转写文本过短，需要说明信息不足，并尽量提取已有信息。",
	"- 如果转写文本包含多位说话人，但没有明确 speaker 标识，需要根据上下文谨慎判断，不要强行分配说话人。",
	"- 如果文本中出现重复、口头禅、语气词，可以在总结中忽略，但不能影响关键信息判断。",
	"- 如果发现明显存在未完成表达、被打断内容或上下文缺失，需要列入“待确认问题”。",
	"",
	"7. 输出风格",
	"- 表达要专业、清晰、克制。",
	"- 不要使用夸张、营销化语言。",
	"- 不要过度解释你的分析过程。",
	"- 直接输出最终整理后的 Markdown 内容。",
	"- 内容要有产品经理视角，重视场景、问题、决策、行动、边界和后续推进。",
	"",
	"8. Mermaid 图表生成规则",
	"",
	"你可以在合适的场景下，使用 Mermaid 语言绘制结构化图表，用于增强 Markdown 文档的可读性和知识沉淀价值。",
	"",
	"Mermaid 图表不是必须输出，只有当录音内容适合图形化表达时才生成。不要为了画图而画图。",
	"",
	"适合使用 Mermaid 的场景包括：",
	"- 会议中讨论了流程、审批链路、系统流转、业务步骤",
	"- 产品需求中涉及用户路径、功能流程、状态流转",
	"- 学习记录中存在知识框架、概念关系、因果关系",
	"- 客户访谈中描述了业务流程、组织关系、问题链路",
	"- 销售复盘中存在客户决策流程、成交路径、异议处理路径",
	"- 灵感记录中存在想法拆解、项目规划、能力结构"
].join("\n");

export const DEFAULT_ANALYSIS_TEMPLATES: Record<BuiltInAnalysisTemplateId, AnalysisTemplateConfig> = {
	"work-minutes": {
		id: "work-minutes",
		name: "工作纪要",
		description: "适合工作同步、会议复盘和任务追踪。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请生成工作纪要，固定包含以下 Markdown 二级标题：",
			"## 摘要",
			"## 关键结论",
			"## 行动项",
			"## 风险/阻塞",
			"## 待确认问题",
			"",
			"行动项尽量包含负责人、事项和截止时间；未提及时写“待确认”。"
		].join("\n"),
		recognitionKeywords: ["工作纪要"],
		enabled: true,
		builtin: true
	},
	"study-notes": {
		id: "study-notes",
		name: "学习纪要",
		description: "适合课程、读书、分享和知识复盘。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请生成学习纪要，固定包含以下 Markdown 二级标题：",
			"## 核心概念",
			"## 知识要点",
			"## 案例/例子",
			"## 易混淆点",
			"## 复习清单",
			"",
			"复习清单要写成可执行的检查项。"
		].join("\n"),
		recognitionKeywords: ["学习纪要"],
		enabled: true,
		builtin: true
	},
	"product-requirement-mining": {
		id: "product-requirement-mining",
		name: "产品需求挖掘纪要",
		description: "适合从访谈、会议和反馈中提炼产品需求。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
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
		recognitionKeywords: ["产品需求挖掘纪要"],
		enabled: true,
		builtin: true
	},
	"manager-sync-minutes": {
		id: "manager-sync-minutes",
		name: "管理者纪要",
		description: "适合管理者处理团队同步、业务判断、决策授权和跨团队协调。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以管理者视角生成管理者纪要，固定包含以下 Markdown 二级标题：",
			"## 管理摘要",
			"## 关键判断",
			"## 团队/业务状态",
			"## 决策与授权",
			"## 行动项",
			"## 风险与待协调",
			"## 汇报口径",
			"",
			"行动项要包含负责人、事项、截止时间和检查方式；知识沉淀要提炼可复用的管理判断、组织模式或协作经验；汇报口径要能直接用于向上级或相关团队同步。"
		].join("\n"),
		recognitionKeywords: ["管理者纪要", "管理纪要", "团队管理", "管理同步"],
		enabled: false,
		builtin: true
	},
	"product-manager-minutes": {
		id: "product-manager-minutes",
		name: "产品经理纪要",
		description: "适合产品经理沉淀需求讨论、方案判断、优先级取舍和对外同步。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以产品经理视角生成产品经理纪要，固定包含以下 Markdown 二级标题：",
			"## 背景与目标",
			"## 用户/业务问题",
			"## 需求与方案判断",
			"## 优先级与取舍",
			"## 行动项",
			"## 风险与待确认",
			"## 对外同步摘要",
			"",
			"行动项要明确负责人、交付物和下一步验证；知识沉淀要保留需求判断依据、用户洞察和产品原则；对外同步摘要要适合发给研发、业务或管理层。"
		].join("\n"),
		recognitionKeywords: ["产品经理纪要", "产品纪要", "需求讨论", "产品方案"],
		enabled: false,
		builtin: true
	},
	"project-manager-minutes": {
		id: "project-manager-minutes",
		name: "项目经理纪要",
		description: "适合项目经理跟踪项目进展、里程碑、依赖阻塞和风险闭环。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以项目经理视角生成项目经理纪要，固定包含以下 Markdown 二级标题：",
			"## 项目进展",
			"## 里程碑",
			"## 依赖与阻塞",
			"## 风险清单",
			"## 决策记录",
			"## 行动项",
			"## 下次检查点",
			"",
			"行动项要可跟踪并包含负责人、截止时间和验收信号；知识沉淀要总结项目节奏、协作模式和风险模式；下次检查点要能直接转成项目例会跟进项。"
		].join("\n"),
		recognitionKeywords: ["项目经理纪要", "项目纪要", "项目同步", "项目复盘"],
		enabled: false,
		builtin: true
	},
	"engineering-minutes": {
		id: "engineering-minutes",
		name: "研发/技术纪要",
		description: "适合研发和技术负责人整理技术方案、架构判断、风险和发布验证。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以研发/技术视角生成研发/技术纪要，固定包含以下 Markdown 二级标题：",
			"## 技术背景",
			"## 方案与架构判断",
			"## 关键决策",
			"## 风险/技术债",
			"## 验证与发布",
			"## 行动项",
			"## 沉淀要点",
			"",
			"行动项要明确实现、验证、评审和发布责任；知识沉淀要提炼技术取舍、架构原则和可复用经验；汇报内容要能让非技术干系人理解风险、影响和下一步。"
		].join("\n"),
		recognitionKeywords: ["研发/技术纪要", "研发纪要", "技术纪要", "技术方案"],
		enabled: false,
		builtin: true
	},
	"sales-minutes": {
		id: "sales-minutes",
		name: "销售纪要",
		description: "适合销售整理客户沟通、需求痛点、决策链、异议和商机推进。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以销售视角生成销售纪要，固定包含以下 Markdown 二级标题：",
			"## 客户背景",
			"## 需求与痛点",
			"## 决策链与预算",
			"## 异议/竞品",
			"## 商机阶段",
			"## 下一步行动",
			"## 汇报摘要",
			"",
			"下一步行动要明确客户侧和我方责任人、触达方式和时间点；知识沉淀要提炼可复用销售线索、客户画像和异议处理经验；汇报摘要要适合更新商机记录或同步上级。"
		].join("\n"),
		recognitionKeywords: ["销售纪要", "客户拜访", "商机推进", "销售沟通"],
		enabled: false,
		builtin: true
	},
	"customer-success-minutes": {
		id: "customer-success-minutes",
		name: "客户成功纪要",
		description: "适合客户成功整理客户健康度、使用问题、续约风险和价值机会。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以客户成功视角生成客户成功纪要，固定包含以下 Markdown 二级标题：",
			"## 客户现状",
			"## 使用问题",
			"## 健康度与风险",
			"## 价值机会",
			"## 升级/续约信号",
			"## 行动项",
			"## 客户同步口径",
			"",
			"行动项要区分客户侧、我方和跨团队协同事项；知识沉淀要总结客户成功打法、风险信号和价值证明；客户同步口径要清晰、克制、可直接用于会后跟进。"
		].join("\n"),
		recognitionKeywords: ["客户成功纪要", "客户成功", "续约沟通", "客户健康度"],
		enabled: false,
		builtin: true
	},
	"operations-minutes": {
		id: "operations-minutes",
		name: "运营纪要",
		description: "适合运营整理目标指标、活动流程、数据反馈、问题归因和复盘沉淀。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以运营视角生成运营纪要，固定包含以下 Markdown 二级标题：",
			"## 目标与指标",
			"## 活动/流程现状",
			"## 数据与反馈信号",
			"## 问题归因",
			"## 优化动作",
			"## 风险与资源需求",
			"## 复盘沉淀",
			"",
			"优化动作要明确负责人、执行节奏和验证指标；知识沉淀要提炼运营方法、实验结论和可复用 SOP；汇报内容要能用于周报、复盘或跨团队同步。"
		].join("\n"),
		recognitionKeywords: ["运营纪要", "运营复盘", "活动复盘", "运营同步"],
		enabled: false,
		builtin: true
	},
	"hr-minutes": {
		id: "hr-minutes",
		name: "HR/人力纪要",
		description: "适合 HR 和管理协作者整理组织、岗位、反馈、诉求和合规风险。",
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请以 HR/人力视角生成 HR/人力纪要，固定包含以下 Markdown 二级标题：",
			"## 组织/岗位背景",
			"## 关键事实",
			"## 反馈与诉求",
			"## 风险与合规提醒",
			"## 行动项",
			"## 待确认问题",
			"## 管理同步摘要",
			"",
			"行动项要注意责任人、时间点和沟通边界；知识沉淀要提炼组织信号、岗位要求和协作经验；管理同步摘要要客观克制，避免超出原文进行判断或贴标签。"
		].join("\n"),
		recognitionKeywords: ["HR/人力纪要", "HR纪要", "人力纪要", "组织沟通", "面谈纪要"],
		enabled: false,
		builtin: true
	}
};

export const DEFAULT_SETTINGS: EchoNotesSettings = {
	provider: "aliyun-bailian",
	baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	model: "qwen3-asr-flash",
	language: "auto",
	outputStrategy: "same-name-subfolder",
	customOutputFolder: "Transcripts",
	insertStyle: "linkOnly",
	copyLanguage: "zh",
	analysisProvider: "aliyun-bailian",
	analysisBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	analysisModel: "deepseek-v4-pro",
	analysisEnabled: false,
	defaultAnalysisTemplateId: "work-minutes",
	analysisTemplates: createDefaultAnalysisTemplates(),
	skipExistingTranscript: true,
	autoTranscribeOnAudioLink: false,
	autoTranscribeOnAudioCreated: false,
	officialRecorderStartHotkey: {
		modifiers: ["Ctrl"],
		key: "L"
	},
	officialRecorderStopHotkey: {
		modifiers: ["Ctrl"],
		key: "S"
	},
	transcribeAllAudioHotkey: {
		modifiers: ["Ctrl"],
		key: "Z"
	},
	verboseLog: false
};

const MODIFIER_ORDER: Modifier[] = ["Mod", "Ctrl", "Meta", "Shift", "Alt"];

const MODIFIER_ALIASES: Record<string, Modifier> = {
	mod: "Mod",
	ctrl: "Ctrl",
	control: "Ctrl",
	meta: "Meta",
	cmd: "Meta",
	command: "Meta",
	shift: "Shift",
	alt: "Alt",
	option: "Alt"
};

const KEY_ALIASES: Record<string, string> = {
	space: "Space",
	spacebar: "Space",
	enter: "Enter",
	return: "Enter",
	escape: "Escape",
	esc: "Escape",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	del: "Delete",
	up: "ArrowUp",
	arrowup: "ArrowUp",
	down: "ArrowDown",
	arrowdown: "ArrowDown",
	left: "ArrowLeft",
	arrowleft: "ArrowLeft",
	right: "ArrowRight",
	arrowright: "ArrowRight",
	plus: "+",
	comma: ",",
	period: ".",
	dot: ".",
	minus: "-",
	dash: "-",
	equal: "="
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
	transcribingNotice: string;
	partialFailureNotice: string;
	segmentHeadingPrefix: string;
	emptySegmentText: string;
	analysisLinksHeading: string;
	sourceTranscriptLabel: string;
	analysisHeading: string;
	analysisGeneratedAtLabel: string;
	analysisProviderLabel: string;
	analysisModelLabel: string;
	analysisTraceIdLabel: string;
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
		transcribingNotice: "长音频正在逐段转写，已完成的分段会持续写入本文档。",
		partialFailureNotice: "长音频逐段转写已中断，以下为已完成的分段。",
		segmentHeadingPrefix: "分段",
		emptySegmentText: "（本段暂无转写内容）",
		analysisLinksHeading: "AI 纪要分析",
		sourceTranscriptLabel: "来源转写稿：",
		analysisHeading: "分析结果",
		analysisGeneratedAtLabel: "生成时间：",
		analysisProviderLabel: "Provider：",
		analysisModelLabel: "模型：",
		analysisTraceIdLabel: "Trace ID："
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
		transcribingNotice: "Long audio transcription is running. Completed segments are written here as they finish.",
		partialFailureNotice: "Long audio transcription stopped. Completed segments are kept below.",
		segmentHeadingPrefix: "Segment",
		emptySegmentText: "(No transcript text for this segment yet.)",
		analysisLinksHeading: "AI Analysis",
		sourceTranscriptLabel: "Source transcript: ",
		analysisHeading: "Analysis",
		analysisGeneratedAtLabel: "Generated at: ",
		analysisProviderLabel: "Provider: ",
		analysisModelLabel: "Model: ",
		analysisTraceIdLabel: "Trace ID: "
	}
};

export function getLocalizedCopy(language: string | undefined): LocalizedCopy {
	return language === "en" ? LOCALIZED_COPY.en : LOCALIZED_COPY.zh;
}

export function isProviderId(value: string): value is ProviderId {
	return value in PROVIDER_LABELS;
}

export function isAnalysisProviderId(value: string): value is AnalysisProviderId {
	return isProviderId(value);
}

export function createDefaultAnalysisTemplates(): AnalysisTemplateConfig[] {
	return BUILTIN_ANALYSIS_TEMPLATE_IDS.map((id) => cloneAnalysisTemplate(DEFAULT_ANALYSIS_TEMPLATES[id]));
}

export function normalizeEchoNotesSettings(rawData: unknown): EchoNotesSettings {
	const raw = isRecord(rawData) ? rawData : {};
	const settings = Object.assign({}, DEFAULT_SETTINGS, raw) as EchoNotesSettings;
	const rawProvider = typeof raw.provider === "string" ? raw.provider : "";
	const hasValidProvider = isProviderId(rawProvider);
	settings.provider = hasValidProvider ? rawProvider : DEFAULT_SETTINGS.provider;
	const providerDefaults = PROVIDER_DEFAULTS[settings.provider as ProviderId] ?? PROVIDER_DEFAULTS[DEFAULT_SETTINGS.provider as ProviderId];
	settings.baseUrl =
		hasValidProvider && typeof raw.baseUrl === "string" && raw.baseUrl.trim()
			? raw.baseUrl.trim()
			: providerDefaults.baseUrl;
	settings.model =
		hasValidProvider && typeof raw.model === "string" && raw.model.trim()
			? raw.model.trim()
			: providerDefaults.model;
	settings.language =
		hasValidProvider && typeof raw.language === "string" && raw.language.trim()
			? raw.language.trim()
			: providerDefaults.language;
	const oldAutoAnalyze = raw.autoAnalyzeAfterTranscription === true;
	const rawDefaultAnalysisTemplateId =
		typeof raw.defaultAnalysisTemplateId === "string"
			? raw.defaultAnalysisTemplateId
			: typeof raw.autoAnalysisTemplate === "string"
				? raw.autoAnalysisTemplate
				: undefined;
	const rawAnalysisProvider = typeof raw.analysisProvider === "string" ? raw.analysisProvider : "";
	const hasValidAnalysisProvider = isAnalysisProviderId(rawAnalysisProvider);

	settings.analysisProvider = hasValidAnalysisProvider ? rawAnalysisProvider : DEFAULT_SETTINGS.analysisProvider;
	const analysisDefaults =
		ANALYSIS_PROVIDER_DEFAULTS[settings.analysisProvider] ??
		ANALYSIS_PROVIDER_DEFAULTS[DEFAULT_SETTINGS.analysisProvider];
	settings.analysisBaseUrl =
		hasValidAnalysisProvider && typeof raw.analysisBaseUrl === "string" && raw.analysisBaseUrl.trim()
			? raw.analysisBaseUrl.trim()
			: analysisDefaults.analysisBaseUrl;
	settings.analysisModel =
		hasValidAnalysisProvider && typeof raw.analysisModel === "string" && raw.analysisModel.trim()
			? raw.analysisModel.trim()
			: analysisDefaults.analysisModel;
	settings.analysisEnabled = typeof raw.analysisEnabled === "boolean" ? raw.analysisEnabled : oldAutoAnalyze;
	settings.analysisTemplates = normalizeAnalysisTemplates(raw.analysisTemplates);
	settings.defaultAnalysisTemplateId = normalizeDefaultAnalysisTemplateId(rawDefaultAnalysisTemplateId, settings.analysisTemplates);
	settings.officialRecorderStartHotkey = normalizeHotkeySetting(
		raw.officialRecorderStartHotkey,
		DEFAULT_SETTINGS.officialRecorderStartHotkey
	);
	settings.officialRecorderStopHotkey = normalizeHotkeySetting(
		raw.officialRecorderStopHotkey,
		DEFAULT_SETTINGS.officialRecorderStopHotkey
	);
	settings.transcribeAllAudioHotkey = normalizeHotkeySetting(
		raw.transcribeAllAudioHotkey,
		DEFAULT_SETTINGS.transcribeAllAudioHotkey
	);

	const mutableSettings = settings as EchoNotesSettings & Record<string, unknown>;
	delete mutableSettings.autoAnalyzeAfterTranscription;
	delete mutableSettings.autoAnalysisTemplate;
	delete mutableSettings.promptForAnalysisAfterTranscription;
	delete mutableSettings.promptForAnalysisTemplateOnTranscription;

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
			recognitionKeywords: normalizeRecognitionKeywords(template.recognitionKeywords, template.name),
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
			systemPrompt: existing.systemPrompt.trim() || defaults.systemPrompt,
			customPrompt: existing.customPrompt.trim() || defaults.customPrompt,
			recognitionKeywords: existing.recognitionKeywords.length > 0 ? existing.recognitionKeywords : defaults.recognitionKeywords,
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
		systemPrompt: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt: [
			"请根据转写稿生成一份结构化纪要。",
			"你可以自行组织标题，但必须突出关键结论、行动建议和待确认问题。"
		].join("\n"),
		recognitionKeywords: [name.trim() || "自定义模板"],
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
		...template,
		recognitionKeywords: [...template.recognitionKeywords]
	};
}

function isAnalysisTemplateLike(value: unknown): value is Partial<AnalysisTemplateConfig> {
	return isRecord(value) && (typeof value.id === "string" || typeof value.name === "string");
}

function normalizeAnalysisTemplate(value: Partial<AnalysisTemplateConfig> & { prompt?: unknown }): AnalysisTemplateConfig {
	const id = typeof value.id === "string" ? value.id : value.name ?? "";
	const name = typeof value.name === "string" ? value.name : id;
	const legacyPrompt = typeof value.prompt === "string" ? value.prompt : "";
	const customPrompt = typeof value.customPrompt === "string" ? value.customPrompt : legacyPrompt;
	return {
		id,
		name,
		description: typeof value.description === "string" ? value.description : "",
		systemPrompt:
			typeof value.systemPrompt === "string" && value.systemPrompt.trim()
				? value.systemPrompt
				: DEFAULT_ANALYSIS_SYSTEM_PROMPT,
		customPrompt,
		recognitionKeywords: normalizeRecognitionKeywords(value.recognitionKeywords, name),
		enabled: typeof value.enabled === "boolean" ? value.enabled : true,
		builtin: typeof value.builtin === "boolean" ? value.builtin : false
	};
}

export function parseRecognitionKeywordsInput(value: string): string[] {
	return uniqueNonEmptyStrings(value.split(/[\n,，、]+/g));
}

function normalizeRecognitionKeywords(value: unknown, fallbackName: string): string[] {
	if (Array.isArray(value)) {
		const keywords = uniqueNonEmptyStrings(value.filter((item): item is string => typeof item === "string"));
		return keywords.length > 0 ? keywords : uniqueNonEmptyStrings([fallbackName]);
	}
	if (typeof value === "string") {
		const keywords = parseRecognitionKeywordsInput(value);
		return keywords.length > 0 ? keywords : uniqueNonEmptyStrings([fallbackName]);
	}

	return uniqueNonEmptyStrings([fallbackName]);
}

function normalizeDefaultAnalysisTemplateId(value: unknown, templates: AnalysisTemplateConfig[]): AnalysisTemplateId {
	const ids = new Set(templates.map((template) => template.id));
	if (typeof value === "string" && ids.has(value)) {
		return value;
	}
	if (ids.has(DEFAULT_SETTINGS.defaultAnalysisTemplateId)) {
		return DEFAULT_SETTINGS.defaultAnalysisTemplateId;
	}
	return templates[0]?.id ?? "work-minutes";
}

function uniqueNonEmptyStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed || seen.has(trimmed)) {
			continue;
		}
		seen.add(trimmed);
		result.push(trimmed);
	}

	return result;
}

export function parseHotkeyInput(value: string): EchoNotesHotkeySetting | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}

	const rawParts = trimmed.split("+").map((part) => part.trim()).filter(Boolean);
	if (rawParts.length === 0) {
		return null;
	}

	const modifiers: Modifier[] = [];
	let key = "";

	for (const part of rawParts) {
		const normalizedPart = part.toLowerCase();
		const modifier = MODIFIER_ALIASES[normalizedPart];
		if (modifier) {
			if (!modifiers.includes(modifier)) {
				modifiers.push(modifier);
			}
			continue;
		}

		const normalizedKey = normalizeHotkeyKey(part);
		if (!normalizedKey || key) {
			return undefined;
		}
		key = normalizedKey;
	}

	if (!key) {
		return undefined;
	}

	return {
		modifiers: sortModifiers(modifiers),
		key
	};
}

export function formatHotkey(hotkey: EchoNotesHotkeySetting): string {
	if (!hotkey) {
		return "";
	}
	return [...hotkey.modifiers, hotkey.key].join("+");
}

export function cloneHotkey(hotkey: EchoNotesHotkeySetting): EchoNotesHotkeySetting {
	if (!hotkey) {
		return null;
	}
	return {
		modifiers: [...hotkey.modifiers],
		key: hotkey.key
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function normalizeHotkeySetting(value: unknown, fallback: EchoNotesHotkeySetting): EchoNotesHotkeySetting {
	if (value === null) {
		return null;
	}

	if (typeof value === "string") {
		return parseHotkeyInput(value) ?? cloneHotkey(fallback);
	}

	if (isHotkeyLike(value)) {
		if (!value.modifiers.every(isModifier)) {
			return cloneHotkey(fallback);
		}
		const normalizedModifiers = sortModifiers(value.modifiers);
		const normalizedKey = normalizeHotkeyKey(value.key);
		if (normalizedKey) {
			return {
				modifiers: normalizedModifiers,
				key: normalizedKey
			};
		}
	}

	return cloneHotkey(fallback);
}

function isHotkeyLike(value: unknown): value is { modifiers: unknown[]; key: string } {
	return isRecord(value) && Array.isArray(value.modifiers) && typeof value.key === "string";
}

function isModifier(value: unknown): value is Modifier {
	return typeof value === "string" && MODIFIER_ORDER.includes(value as Modifier);
}

function sortModifiers(modifiers: Modifier[]): Modifier[] {
	const unique = new Set(modifiers);
	return MODIFIER_ORDER.filter((modifier) => unique.has(modifier));
}

function normalizeHotkeyKey(value: string): string {
	const trimmed = value.trim();
	if (!trimmed || /\s/.test(trimmed)) {
		return "";
	}

	const lower = trimmed.toLowerCase();
	const alias = KEY_ALIASES[lower];
	if (alias) {
		return alias;
	}

	if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(trimmed)) {
		return trimmed.toUpperCase();
	}

	if (trimmed.length === 1) {
		return /[a-z]/i.test(trimmed) ? trimmed.toUpperCase() : trimmed;
	}

	if (/^arrow(up|down|left|right)$/i.test(trimmed)) {
		return `Arrow${trimmed.slice(5, 6).toUpperCase()}${trimmed.slice(6).toLowerCase()}`;
	}

	return "";
}

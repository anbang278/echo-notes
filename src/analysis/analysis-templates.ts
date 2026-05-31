import {
	BUILTIN_ANALYSIS_TEMPLATE_IDS,
	type AnalysisTemplateConfig,
	type AnalysisTemplateId,
	type CopyLanguage,
	type EchoNotesSettings
} from "../settings/settings";

export const ANALYSIS_TEMPLATE_ORDER = BUILTIN_ANALYSIS_TEMPLATE_IDS;

export interface AnalysisPromptInput {
	template: AnalysisTemplateConfig;
	transcriptTitle: string;
	transcriptText: string;
	copyLanguage: CopyLanguage;
}

export function getAnalysisTemplate(settings: EchoNotesSettings, templateId: AnalysisTemplateId): AnalysisTemplateConfig | null {
	return settings.analysisTemplates.find((template) => template.id === templateId) ?? null;
}

export function getBuiltInAnalysisTemplates(settings: EchoNotesSettings): AnalysisTemplateConfig[] {
	return ANALYSIS_TEMPLATE_ORDER
		.map((templateId) => getAnalysisTemplate(settings, templateId))
		.filter((template): template is AnalysisTemplateConfig => Boolean(template));
}

export function getEnabledAnalysisTemplates(settings: EchoNotesSettings): AnalysisTemplateConfig[] {
	return settings.analysisTemplates.filter((template) => template.enabled);
}

export function getCommandAnalysisTemplates(settings: EchoNotesSettings): AnalysisTemplateConfig[] {
	const builtInTemplates = getBuiltInAnalysisTemplates(settings).filter((template) => template.enabled);
	const enabledCustomTemplates = settings.analysisTemplates.filter((template) => !template.builtin && template.enabled);
	return [...builtInTemplates, ...enabledCustomTemplates];
}

export function buildAnalysisMessages(input: AnalysisPromptInput): { system: string; user: string } {
	const languageName = input.copyLanguage === "en" ? "English" : "简体中文";

	return {
		system: [
			"你是 Echo Notes 的转写稿分析助手。",
			`请始终使用${languageName}输出。`,
			"只依据用户提供的转写稿内容分析；信息不足时明确写“未提及”或“待确认”。",
			"输出 Markdown，不要使用代码块包裹，不要编造转写稿中不存在的事实。"
		].join("\n"),
		user: [
			`转写稿标题：${input.transcriptTitle}`,
			`分析模板：${input.template.name}`,
			...(input.template.description.trim() ? [`模板说明：${input.template.description.trim()}`] : []),
			"",
			"模板提示词：",
			input.template.prompt.trim(),
			"",
			"转写稿正文：",
			input.transcriptText.trim()
		].join("\n")
	};
}

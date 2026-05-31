import {
	BUILTIN_ANALYSIS_TEMPLATE_IDS,
	type AnalysisTemplateConfig,
	type AnalysisTemplateId,
	type CopyLanguage,
	type EchoNotesSettings
} from "../settings/settings";
import type { AudioLinkMatch } from "../audio/audio-link-parser";

export const ANALYSIS_TEMPLATE_ORDER = BUILTIN_ANALYSIS_TEMPLATE_IDS;
export const ANALYSIS_CONTEXT_LINE_RADIUS = 3;

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

export function getDefaultAnalysisTemplate(settings: EchoNotesSettings): AnalysisTemplateConfig | null {
	const enabledTemplates = getEnabledAnalysisTemplates(settings);
	const defaultTemplate = enabledTemplates.find((template) => template.id === settings.defaultAnalysisTemplateId);
	return defaultTemplate ?? enabledTemplates[0] ?? null;
}

export function selectAnalysisTemplateForContext(settings: EchoNotesSettings, contextText: string): AnalysisTemplateConfig | null {
	const normalizedContext = contextText.toLowerCase();
	const enabledTemplates = getEnabledAnalysisTemplates(settings);

	for (const template of enabledTemplates) {
		const hasKeyword = template.recognitionKeywords.some((keyword) => {
			const normalizedKeyword = keyword.trim().toLowerCase();
			return normalizedKeyword.length > 0 && normalizedContext.includes(normalizedKeyword);
		});
		if (hasKeyword) {
			return template;
		}
	}

	return getDefaultAnalysisTemplate(settings);
}

export function getAnalysisContextAroundAudioMatch(markdown: string, match: Pick<AudioLinkMatch, "lineStart" | "lineEnd">): string {
	const lines = markdown.split("\n");
	const start = Math.max(0, match.lineStart - ANALYSIS_CONTEXT_LINE_RADIUS);
	const end = Math.min(lines.length - 1, match.lineEnd + ANALYSIS_CONTEXT_LINE_RADIUS);
	return lines.slice(start, end + 1).join("\n");
}

export function buildAnalysisMessages(input: AnalysisPromptInput): { system: string; user: string } {
	const languageName = input.copyLanguage === "en" ? "English" : "简体中文";

	return {
		system: [
			input.template.systemPrompt.trim(),
			`请始终使用${languageName}输出。`,
			"输出 Markdown，不要使用代码块包裹。"
		]
			.filter(Boolean)
			.join("\n\n"),
		user: [
			`转写稿标题：${input.transcriptTitle}`,
			`分析方案：${input.template.name}`,
			"",
			"自定义提示词：",
			input.template.customPrompt.trim(),
			"",
			"转写稿正文：",
			input.transcriptText.trim()
		].join("\n")
	};
}

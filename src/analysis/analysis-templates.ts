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
export const ANALYSIS_TEMPLATE_FRONTMATTER_KEYS = [
	"echo_notes_analysis_template",
	"echo_notes_template",
	"analysis_template"
];

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

export function selectAnalysisTemplateForSourceMarkdown(
	settings: EchoNotesSettings,
	sourceMarkdown: string,
	contextText: string
): AnalysisTemplateConfig | null {
	const frontmatterTemplate = selectAnalysisTemplateFromFrontmatter(settings, sourceMarkdown);
	const tagTemplate = selectAnalysisTemplateFromTags(settings, sourceMarkdown);
	return frontmatterTemplate ?? tagTemplate ?? selectAnalysisTemplateForContext(settings, contextText);
}

export function selectAnalysisTemplateFromFrontmatter(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig | null {
	const requestedTemplate = getAnalysisTemplateFrontmatterValue(sourceMarkdown);
	if (!requestedTemplate) {
		return null;
	}

	const normalizedRequestedTemplate = requestedTemplate.trim().toLowerCase();
	return (
		getEnabledAnalysisTemplates(settings).find(
			(template) =>
				template.id.toLowerCase() === normalizedRequestedTemplate ||
				template.name.trim().toLowerCase() === normalizedRequestedTemplate
		) ?? null
	);
}

export function selectAnalysisTemplateFromTags(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig | null {
	const normalizedTags = new Set(getSourceNoteTags(sourceMarkdown).map(normalizeAnalysisTagValue).filter(Boolean));
	if (normalizedTags.size === 0) {
		return null;
	}

	return (
		getEnabledAnalysisTemplates(settings).find((template) =>
			[template.id, template.name, ...template.recognitionKeywords]
				.map(normalizeAnalysisTagValue)
				.some((candidate) => candidate.length > 0 && normalizedTags.has(candidate))
		) ?? null
	);
}

export function getAnalysisContextAroundAudioMatch(markdown: string, match: Pick<AudioLinkMatch, "lineStart" | "lineEnd">): string {
	const lines = markdown.split("\n");
	const start = Math.max(0, match.lineStart - ANALYSIS_CONTEXT_LINE_RADIUS);
	const end = Math.min(lines.length - 1, match.lineEnd + ANALYSIS_CONTEXT_LINE_RADIUS);
	return lines.slice(start, end + 1).join("\n");
}

function getAnalysisTemplateFrontmatterValue(markdown: string): string | null {
	const lines = getFrontmatterLines(markdown);
	if (!lines) {
		return null;
	}

	for (const line of lines) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		if (!ANALYSIS_TEMPLATE_FRONTMATTER_KEYS.includes(key)) {
			continue;
		}

		return unquoteYamlScalar(line.slice(separatorIndex + 1).trim());
	}

	return null;
}

function getSourceNoteTags(markdown: string): string[] {
	return [...getFrontmatterTags(markdown), ...getInlineTags(markdown)];
}

function getFrontmatterTags(markdown: string): string[] {
	const lines = getFrontmatterLines(markdown);
	if (!lines) {
		return [];
	}

	const tags: string[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1 || line.slice(0, separatorIndex).trim() !== "tags") {
			continue;
		}

		const inlineValue = line.slice(separatorIndex + 1).trim();
		if (inlineValue) {
			tags.push(...parseTagValue(inlineValue));
			continue;
		}

		for (let childIndex = lineIndex + 1; childIndex < lines.length; childIndex += 1) {
			const childLine = lines[childIndex];
			const listMatch = childLine.match(/^\s*-\s+(.+)$/);
			if (!listMatch) {
				break;
			}

			tags.push(...parseTagValue(listMatch[1].trim()));
		}
	}

	return tags;
}

function getInlineTags(markdown: string): string[] {
	const tags: string[] = [];
	const tagRegex = /(?:^|[\s([{"'])#([^\s#\])}",.;:!?]+)/g;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(markdown)) !== null) {
		tags.push(match[1]);
	}

	return tags;
}

function parseTagValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((tag) => unquoteYamlScalar(tag.trim()))
			.filter(Boolean);
	}

	return trimmed.split(/\s+/).map(unquoteYamlScalar).filter(Boolean);
}

function normalizeAnalysisTagValue(value: string): string {
	return value.trim().replace(/^#+/, "").toLowerCase();
}

function getFrontmatterLines(markdown: string): string[] | null {
	if (!markdown.startsWith("---\n")) {
		return null;
	}

	const endIndex = markdown.indexOf("\n---", 4);
	if (endIndex === -1) {
		return null;
	}

	return markdown.slice(4, endIndex).split(/\r?\n/);
}

function unquoteYamlScalar(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}

	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}

	return value;
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

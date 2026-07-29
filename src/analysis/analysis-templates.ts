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
	return selectAnalysisTemplatesForContext(settings, contextText)[0] ?? null;
}

export function selectAnalysisTemplatesForContext(settings: EchoNotesSettings, contextText: string): AnalysisTemplateConfig[] {
	const normalizedContext = contextText.toLowerCase();
	const enabledTemplates = getEnabledAnalysisTemplates(settings);
	const matchedTemplates = enabledTemplates.filter((template) =>
		template.recognitionKeywords.some((keyword) => {
			const normalizedKeyword = keyword.trim().toLowerCase();
			return normalizedKeyword.length > 0 && normalizedContext.includes(normalizedKeyword);
		})
	);

	return matchedTemplates.length > 0 ? matchedTemplates : getDefaultAnalysisTemplates(settings);
}

export function selectAnalysisTemplateForSourceMarkdown(
	settings: EchoNotesSettings,
	sourceMarkdown: string,
	contextText: string
): AnalysisTemplateConfig | null {
	return selectAnalysisTemplatesForSourceMarkdown(settings, sourceMarkdown, contextText)[0] ?? null;
}

export function selectAnalysisTemplatesForSourceMarkdown(
	settings: EchoNotesSettings,
	sourceMarkdown: string,
	contextText: string
): AnalysisTemplateConfig[] {
	const frontmatterTemplates = selectAnalysisTemplatesFromFrontmatter(settings, sourceMarkdown);
	if (frontmatterTemplates.length > 0) {
		return frontmatterTemplates;
	}

	const tagTemplates = selectAnalysisTemplatesFromTags(settings, sourceMarkdown);
	return tagTemplates.length > 0 ? tagTemplates : selectAnalysisTemplatesForContext(settings, contextText);
}

export function selectAnalysisTemplateFromFrontmatter(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig | null {
	return selectAnalysisTemplatesFromFrontmatter(settings, sourceMarkdown)[0] ?? null;
}

export function selectAnalysisTemplatesFromFrontmatter(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig[] {
	const requestedTemplates = getAnalysisTemplateFrontmatterValues(sourceMarkdown);
	return getTemplatesForRequestedValues(settings, requestedTemplates);
}

export function selectAnalysisTemplateFromTags(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig | null {
	return selectAnalysisTemplatesFromTags(settings, sourceMarkdown)[0] ?? null;
}

export function selectAnalysisTemplatesFromTags(
	settings: EchoNotesSettings,
	sourceMarkdown: string
): AnalysisTemplateConfig[] {
	const normalizedTags = new Set(getSourceNoteTags(sourceMarkdown).map(normalizeAnalysisTagValue).filter(Boolean));
	if (normalizedTags.size === 0) {
		return [];
	}

	return getEnabledAnalysisTemplates(settings).filter((template) =>
		[template.id, template.name, ...template.recognitionKeywords]
			.map(normalizeAnalysisTagValue)
			.some((candidate) => candidate.length > 0 && normalizedTags.has(candidate))
	);
}

export function getAnalysisContextAroundAudioMatch(markdown: string, match: Pick<AudioLinkMatch, "lineStart" | "lineEnd">): string {
	const lines = markdown.split("\n");
	const start = Math.max(0, match.lineStart - ANALYSIS_CONTEXT_LINE_RADIUS);
	const end = Math.min(lines.length - 1, match.lineEnd + ANALYSIS_CONTEXT_LINE_RADIUS);
	return lines.slice(start, end + 1).join("\n");
}

function getDefaultAnalysisTemplates(settings: EchoNotesSettings): AnalysisTemplateConfig[] {
	const template = getDefaultAnalysisTemplate(settings);
	return template ? [template] : [];
}

function getAnalysisTemplateFrontmatterValues(markdown: string): string[] {
	const lines = getFrontmatterLines(markdown);
	if (!lines) {
		return [];
	}

	const requestedTemplates: string[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		if (!ANALYSIS_TEMPLATE_FRONTMATTER_KEYS.includes(key)) {
			continue;
		}

		const inlineValue = line.slice(separatorIndex + 1).trim();
		if (inlineValue) {
			requestedTemplates.push(...parseAnalysisTemplateRequestValue(inlineValue));
			continue;
		}

		for (let childIndex = lineIndex + 1; childIndex < lines.length; childIndex += 1) {
			const childLine = lines[childIndex];
			const listMatch = childLine.match(/^\s*-\s+(.+)$/);
			if (!listMatch) {
				break;
			}

			requestedTemplates.push(...parseAnalysisTemplateRequestValue(listMatch[1].trim()));
		}
	}

	return uniqueTemplates(requestedTemplates);
}

function getTemplatesForRequestedValues(settings: EchoNotesSettings, requestedValues: string[]): AnalysisTemplateConfig[] {
	const enabledTemplates = getEnabledAnalysisTemplates(settings);
	const templates: AnalysisTemplateConfig[] = [];
	const seen = new Set<string>();

	for (const requestedValue of requestedValues) {
		const normalizedRequestedValue = requestedValue.trim().toLowerCase();
		if (!normalizedRequestedValue) {
			continue;
		}

		const template = enabledTemplates.find(
			(candidate) =>
				candidate.id.toLowerCase() === normalizedRequestedValue ||
				candidate.name.trim().toLowerCase() === normalizedRequestedValue
		);
		if (!template || seen.has(template.id)) {
			continue;
		}

		seen.add(template.id);
		templates.push(template);
	}

	return templates;
}

function parseAnalysisTemplateRequestValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(/[,，、]+/g)
			.map((template) => unquoteYamlScalar(template.trim()))
			.filter(Boolean);
	}

	return trimmed
		.split(/[,，、]+/g)
		.map((template) => unquoteYamlScalar(template.trim()))
		.filter(Boolean);
}

function uniqueTemplates(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const normalizedValue = value.trim().toLowerCase();
		if (!normalizedValue || seen.has(normalizedValue)) {
			continue;
		}
		seen.add(normalizedValue);
		result.push(value.trim());
	}

	return result;
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
			"输出 Markdown；不要把整篇结果包裹在代码块中。"
		]
			.filter(Boolean)
			.join("\n\n"),
		user: [
			`分析方案：${input.template.name}`,
			"",
			"<analysis-template>",
			input.template.customPrompt.trim(),
			"</analysis-template>",
			"",
			`<transcript title="${escapePromptAttribute(input.transcriptTitle)}">`,
			input.transcriptText.trim(),
			"</transcript>"
		].join("\n")
	};
}

function escapePromptAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

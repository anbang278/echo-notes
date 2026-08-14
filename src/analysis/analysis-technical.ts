import {
	DEFAULT_ANALYSIS_TEMPLATE_VERSION,
	getLocalizedCopy,
	type AnalysisTemplateId,
	type CopyLanguage
} from "../settings/settings";
import type { AnalysisResult } from "./analysis-provider";
import { TRANSCRIPT_MANAGED_END, TRANSCRIPT_TECHNICAL_END, TRANSCRIPT_TECHNICAL_START } from "../transcript/transcript-content";

export interface RenderTranscriptTechnicalInfoInput {
	templateId: AnalysisTemplateId;
	templateName: string;
	templateVersion?: string;
	generatedAt: string;
	result: AnalysisResult;
	copyLanguage: CopyLanguage;
}

export function renderTranscriptTechnicalInfo(input: RenderTranscriptTechnicalInfoInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const metadataSeparator = input.copyLanguage === "en" ? "; " : "；";
	const templateVersion = input.templateVersion?.trim() || DEFAULT_ANALYSIS_TEMPLATE_VERSION;
	const metadata = [
		`${copy.analysisGeneratedAtLabel}${input.generatedAt}`,
		`${copy.analysisProviderLabel}${input.result.provider}`,
		`${copy.analysisModelLabel}${input.result.model}`
	];
	if (input.result.traceId) {
		metadata.push(`${copy.analysisTraceIdLabel}${input.result.traceId}`);
	}

	const inlineFields = [
		renderDataviewInlineField("echo_notes_analysis_template_id", input.templateId),
		renderDataviewInlineField("echo_notes_analysis_template_name", input.templateName),
		renderDataviewInlineField("echo_notes_analysis_template_version", templateVersion),
		renderDataviewInlineField("echo_notes_analysis_provider", input.result.provider),
		renderDataviewInlineField("echo_notes_analysis_model", input.result.model),
		renderDataviewInlineField("echo_notes_analysis_generated_at", input.generatedAt)
	];
	if (input.result.traceId) {
		inlineFields.push(renderDataviewInlineField("echo_notes_analysis_trace_id", input.result.traceId));
	}

	return [
		`## ${input.templateName}`,
		"",
		...inlineFields,
		"",
		`_${metadata.join(metadataSeparator)}_`
	].join("\n");
}

export function insertTranscriptTechnicalSection(
	content: string,
	technicalBlock: string,
	templateId: AnalysisTemplateId,
	copyLanguage: CopyLanguage
): string {
	const item = renderTranscriptTechnicalItem(technicalBlock, templateId);
	const section = [
		"",
		TRANSCRIPT_TECHNICAL_START,
		`# ${getLocalizedCopy(copyLanguage).analysisTechnicalInfoHeading}`,
		"",
		item,
		TRANSCRIPT_TECHNICAL_END,
		""
	].join("\n");

	const sectionStart = content.indexOf(TRANSCRIPT_TECHNICAL_START);
	const sectionEnd = content.indexOf(TRANSCRIPT_TECHNICAL_END);
	if (sectionStart !== -1 && sectionEnd > sectionStart) {
		const contentWithoutSection = `${content.slice(0, sectionStart)}${content.slice(sectionEnd + TRANSCRIPT_TECHNICAL_END.length)}`;
		return appendTranscriptTechnicalSection(contentWithoutSection, section);
	}

	return appendTranscriptTechnicalSection(content, section);
}

function appendTranscriptTechnicalSection(content: string, section: string): string {
	const trimmedSection = section.trim();
	const managedEndIndex = content.indexOf(TRANSCRIPT_MANAGED_END);
	if (managedEndIndex !== -1) {
		const afterManagedEnd = content.slice(managedEndIndex + TRANSCRIPT_MANAGED_END.length);
		const withoutLeadingBlankLines = afterManagedEnd.replace(/^\n+/, "");
		const trailing = withoutLeadingBlankLines.trimEnd();
		const before = content.slice(0, managedEndIndex + TRANSCRIPT_MANAGED_END.length).trimEnd();
		return trailing
			? `${before}\n\n${trimmedSection}\n\n${trailing}\n`
			: `${before}\n\n${trimmedSection}\n`;
	}

	const trimmedContent = content.trimEnd();
	return trimmedContent ? `${trimmedContent}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
}

export function insertOrReplaceTranscriptTechnicalItem(
	content: string,
	technicalBlock: string,
	templateId: AnalysisTemplateId,
	copyLanguage: CopyLanguage
): string {
	const sectionStart = content.indexOf(TRANSCRIPT_TECHNICAL_START);
	const sectionEnd = content.indexOf(TRANSCRIPT_TECHNICAL_END);
	if (sectionStart === -1 || sectionEnd <= sectionStart) {
		return insertTranscriptTechnicalSection(content, technicalBlock, templateId, copyLanguage);
	}

	const existingSection = content.slice(sectionStart, sectionEnd + TRANSCRIPT_TECHNICAL_END.length);
	const updatedSection = insertOrReplaceTechnicalItem(existingSection, technicalBlock, templateId);
	const contentWithoutSection = `${content.slice(0, sectionStart)}${content.slice(sectionEnd + TRANSCRIPT_TECHNICAL_END.length)}`;
	return appendTranscriptTechnicalSection(contentWithoutSection, updatedSection);
}

function insertOrReplaceTechnicalItem(
	section: string,
	technicalBlock: string,
	templateId: AnalysisTemplateId
): string {
	const itemStart = getTranscriptTechnicalItemStart(templateId);
	const itemEnd = getTranscriptTechnicalItemEnd(templateId);
	let nextSection = section;
	const legacyBlock = findLegacyTechnicalBlock(nextSection, technicalBlock, templateId);
	if (legacyBlock) {
		nextSection = removeLegacyTechnicalBlock(nextSection, legacyBlock);
	}

	const itemStartIndex = nextSection.indexOf(itemStart);
	const itemEndIndex = nextSection.indexOf(itemEnd);
	if (itemStartIndex !== -1 && itemEndIndex > itemStartIndex) {
		return `${nextSection.slice(0, itemStartIndex)}${renderTranscriptTechnicalItem(technicalBlock, templateId)}${nextSection.slice(itemEndIndex + itemEnd.length)}`;
	}

	const sectionEndIndex = nextSection.lastIndexOf(TRANSCRIPT_TECHNICAL_END);
	if (sectionEndIndex === -1) {
		return nextSection;
	}

	const prefix = nextSection.slice(0, sectionEndIndex).trimEnd();
	const suffix = nextSection.slice(sectionEndIndex);
	return `${prefix}\n\n${renderTranscriptTechnicalItem(technicalBlock, templateId)}\n${suffix}`;
}

function renderTranscriptTechnicalItem(technicalBlock: string, templateId: AnalysisTemplateId): string {
	return `${getTranscriptTechnicalItemStart(templateId)}\n\n${technicalBlock.trim()}\n${getTranscriptTechnicalItemEnd(templateId)}`;
}

function findLegacyTechnicalBlock(
	section: string,
	technicalBlock: string,
	templateId: AnalysisTemplateId
): { start: number; end: number } | null {
	const headingLine = technicalBlock.trim().split("\n")[0];
	const templateIdLine = `[echo_notes_analysis_template_id:: ${templateId}]`;
	let searchFrom = 0;
	while (true) {
		const start = section.indexOf(headingLine, searchFrom);
		if (start === -1) {
			return null;
		}
		searchFrom = start + headingLine.length;
		if (isInsideTechnicalItem(section, start, templateId)) {
			continue;
		}
		const windowEnd = Math.min(section.length, start + headingLine.length + 4000);
		if (!section.slice(start, windowEnd).includes(templateIdLine)) {
			continue;
		}
		const afterHeading = section.slice(start + headingLine.length);
		const metadataMatch = /(?:^|\n)(_[^\n]*_)(?=\n|$)/.exec(afterHeading);
		if (!metadataMatch) {
			continue;
		}
		return {
			start,
			end: start + headingLine.length + metadataMatch.index + metadataMatch[0].length
		};
	}
}

function isInsideTechnicalItem(section: string, headingIndex: number, templateId: AnalysisTemplateId): boolean {
	const itemStart = getTranscriptTechnicalItemStart(templateId);
	const itemEnd = getTranscriptTechnicalItemEnd(templateId);
	const before = section.slice(0, headingIndex);
	const lastStart = before.lastIndexOf(itemStart);
	const lastEnd = before.lastIndexOf(itemEnd);
	return lastStart !== -1 && lastEnd < lastStart;
}

function removeLegacyTechnicalBlock(
	section: string,
	legacyBlock: { start: number; end: number }
): string {
	const before = section.slice(0, legacyBlock.start).trimEnd();
	const after = section.slice(legacyBlock.end).replace(/^\n+/, "");
	return `${before}\n\n${after}`;
}

function getTranscriptTechnicalItemStart(templateId: AnalysisTemplateId): string {
	return `<!-- echo-notes-technical-item:start ${templateId} -->`;
}

function getTranscriptTechnicalItemEnd(templateId: AnalysisTemplateId): string {
	return `<!-- echo-notes-technical-item:end ${templateId} -->`;
}

function renderDataviewInlineField(key: string, value: string): string {
	return `- [${key}:: ${formatDataviewInlineValue(value)}]`;
}

function formatDataviewInlineValue(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/]/g, "\\]").trim();
}

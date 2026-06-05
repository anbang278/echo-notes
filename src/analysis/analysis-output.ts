import { getLocalizedCopy, type AnalysisTemplateId, type CopyLanguage } from "../settings/settings";
import type { AnalysisResult } from "./analysis-provider";

export const ANALYSIS_LINKS_START = "<!-- echo-notes-analysis-links:start -->";
export const ANALYSIS_LINKS_END = "<!-- echo-notes-analysis-links:end -->";
export const TRANSCRIPT_ANALYSIS_START = "<!-- echo-notes-analysis:start -->";
export const TRANSCRIPT_ANALYSIS_END = "<!-- echo-notes-analysis:end -->";

export interface RenderTranscriptAnalysisBlockInput {
	templateId: AnalysisTemplateId;
	templateName: string;
	result: AnalysisResult;
	copyLanguage: CopyLanguage;
}

export function extractTranscriptText(content: string): string {
	return content
		.replace(/^---\n[\s\S]*?\n---\n?/, "")
		.replace(new RegExp(`${escapeRegExp(ANALYSIS_LINKS_START)}[\\s\\S]*?${escapeRegExp(ANALYSIS_LINKS_END)}\\n?`, "g"), "")
		.replace(new RegExp(`${escapeRegExp(TRANSCRIPT_ANALYSIS_START)}[\\s\\S]*?${escapeRegExp(TRANSCRIPT_ANALYSIS_END)}\\n?`, "g"), "")
		.trim();
}

export function renderTranscriptAnalysisBlock(input: RenderTranscriptAnalysisBlockInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const metadataSeparator = input.copyLanguage === "en" ? "; " : "；";
	const metadata = [
		`${copy.analysisGeneratedAtLabel}${new Date().toISOString()}`,
		`${copy.analysisProviderLabel}${input.result.provider}`,
		`${copy.analysisModelLabel}${input.result.model}`
	];
	if (input.result.traceId) {
		metadata.push(`${copy.analysisTraceIdLabel}${input.result.traceId}`);
	}

	return [
		getTranscriptAnalysisItemStart(input.templateId),
		`### ${input.templateName}`,
		"",
		`_${metadata.join(metadataSeparator)}_`,
		"",
		input.result.text.trim(),
		getTranscriptAnalysisItemEnd(input.templateId)
	].join("\n");
}

export function insertOrReplaceTranscriptAnalysis(
	content: string,
	analysisBlock: string,
	templateId: AnalysisTemplateId,
	heading: string,
	insertBeforeHeading?: string
): string {
	const startIndex = content.indexOf(TRANSCRIPT_ANALYSIS_START);
	const endIndex = content.indexOf(TRANSCRIPT_ANALYSIS_END);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		const fullBlock = [TRANSCRIPT_ANALYSIS_START, `## ${heading}`, "", analysisBlock, TRANSCRIPT_ANALYSIS_END].join("\n");
		return insertAnalysisSection(content, fullBlock, insertBeforeHeading);
	}

	const existingSection = content.slice(startIndex, endIndex + TRANSCRIPT_ANALYSIS_END.length);
	const updatedSection = insertOrReplaceAnalysisItem(existingSection, analysisBlock, templateId);
	const contentWithoutSection = `${content.slice(0, startIndex)}${content.slice(endIndex + TRANSCRIPT_ANALYSIS_END.length)}`;
	return insertAnalysisSection(contentWithoutSection, updatedSection, insertBeforeHeading);
}

function insertOrReplaceAnalysisItem(section: string, analysisBlock: string, templateId: AnalysisTemplateId): string {
	const itemStart = getTranscriptAnalysisItemStart(templateId);
	const itemEnd = getTranscriptAnalysisItemEnd(templateId);
	const itemStartIndex = section.indexOf(itemStart);
	const itemEndIndex = section.indexOf(itemEnd);
	if (itemStartIndex !== -1 && itemEndIndex > itemStartIndex) {
		return `${section.slice(0, itemStartIndex)}${analysisBlock}${section.slice(itemEndIndex + itemEnd.length)}`;
	}

	const sectionEndIndex = section.lastIndexOf(TRANSCRIPT_ANALYSIS_END);
	if (sectionEndIndex === -1) {
		return section;
	}

	const prefix = section.slice(0, sectionEndIndex).trimEnd();
	const suffix = section.slice(sectionEndIndex);
	return `${prefix}\n\n${analysisBlock}\n${suffix}`;
}

function getTranscriptAnalysisItemStart(templateId: AnalysisTemplateId): string {
	return `<!-- echo-notes-analysis-item:start ${templateId} -->`;
}

function getTranscriptAnalysisItemEnd(templateId: AnalysisTemplateId): string {
	return `<!-- echo-notes-analysis-item:end ${templateId} -->`;
}

function insertAnalysisSection(content: string, section: string, insertBeforeHeading?: string): string {
	const trimmedSection = section.trim();
	const insertionIndex = insertBeforeHeading ? findHeadingIndex(content, insertBeforeHeading) : -1;
	if (insertionIndex === -1) {
		const trimmedContent = content.trimEnd();
		return trimmedContent ? `${trimmedContent}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
	}

	const before = content.slice(0, insertionIndex).trimEnd();
	const after = content.slice(insertionIndex).replace(/^\n+/, "");
	const prefix = before ? `${before}\n\n` : "";
	return `${prefix}${trimmedSection}\n\n${after}`;
}

function findHeadingIndex(content: string, heading: string): number {
	const pattern = new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "m");
	const match = pattern.exec(content);
	return match?.index ?? -1;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

import { type AnalysisTemplateId, type CopyLanguage } from "../settings/settings";
import type { AnalysisResult } from "./analysis-provider";
import { removeAllAnalysisCheckpoints } from "./analysis-checkpoint";
import { TRANSCRIPT_MANAGED_END, TRANSCRIPT_MANAGED_START } from "../transcript/transcript-content";
import { insertOrReplaceTranscriptTechnicalItem, renderTranscriptTechnicalInfo } from "./analysis-technical";

export const ANALYSIS_LINKS_START = "<!-- echo-notes-analysis-links:start -->";
export const ANALYSIS_LINKS_END = "<!-- echo-notes-analysis-links:end -->";
export const TRANSCRIPT_ANALYSIS_START = "<!-- echo-notes-analysis:start -->";
export const TRANSCRIPT_ANALYSIS_END = "<!-- echo-notes-analysis:end -->";

export interface RenderTranscriptAnalysisBlockInput {
	templateId: AnalysisTemplateId;
	templateName: string;
	templateVersion?: string;
	result: AnalysisResult;
	copyLanguage: CopyLanguage;
}

export interface ExtractedTranscriptAnalysis {
	templateId: AnalysisTemplateId;
	markdown: string;
}

export function extractTranscriptText(content: string): string {
	const contentWithoutManagedBlocks = removeAllAnalysisCheckpoints(content)
		.replace(/^---\n[\s\S]*?\n---\n?/, "")
		.replace(new RegExp(`${escapeRegExp(ANALYSIS_LINKS_START)}[\\s\\S]*?${escapeRegExp(ANALYSIS_LINKS_END)}\\n?`, "g"), "")
		.replace(new RegExp(`${escapeRegExp(TRANSCRIPT_ANALYSIS_START)}[\\s\\S]*?${escapeRegExp(TRANSCRIPT_ANALYSIS_END)}\\n?`, "g"), "")
		.replaceAll(TRANSCRIPT_MANAGED_START, "")
		.replaceAll(TRANSCRIPT_MANAGED_END, "")
		.trim();

	return extractContentAfterTranscriptHeading(contentWithoutManagedBlocks) ?? contentWithoutManagedBlocks;
}

export function extractTranscriptAnalyses(
	content: string,
	templateIds?: readonly AnalysisTemplateId[]
): ExtractedTranscriptAnalysis[] {
	const sectionStart = content.indexOf(TRANSCRIPT_ANALYSIS_START);
	const sectionEnd = content.indexOf(TRANSCRIPT_ANALYSIS_END);
	if (sectionStart === -1 || sectionEnd <= sectionStart) {
		return [];
	}

	const allowedIds = templateIds ? new Set(templateIds) : null;
	const section = content.slice(sectionStart, sectionEnd + TRANSCRIPT_ANALYSIS_END.length);
	const itemPattern = /<!-- echo-notes-analysis-item:start\s+([^\s]+)\s*-->([\s\S]*?)<!-- echo-notes-analysis-item:end\s+\1\s*-->/g;
	const analyses: ExtractedTranscriptAnalysis[] = [];
	for (const match of section.matchAll(itemPattern)) {
		const templateId = match[1];
		if (allowedIds && !allowedIds.has(templateId)) {
			continue;
		}
		analyses.push({ templateId, markdown: match[2].trim() });
	}
	return analyses;
}

export function renderTranscriptAnalysisBlock(input: RenderTranscriptAnalysisBlockInput): string {
	return [
		getTranscriptAnalysisItemStart(input.templateId),
		`## ${input.templateName}`,
		"",
		normalizeAnalysisMarkdownHeadings(input.result.text.trim()),
		getTranscriptAnalysisItemEnd(input.templateId)
	].join("\n");
}

export function renderTranscriptAnalysisWithTechnicalInfo(input: RenderTranscriptAnalysisBlockInput): {
	analysisBlock: string;
	technicalBlock: string;
	generatedAt: string;
} {
	const generatedAt = new Date().toISOString();
	return {
		analysisBlock: renderTranscriptAnalysisBlock(input),
		generatedAt,
		technicalBlock: renderTranscriptTechnicalInfo({
			...input,
			generatedAt
		})
	};
}

export function insertOrReplaceTranscriptAnalysis(
	content: string,
	analysisBlock: string,
	templateId: AnalysisTemplateId,
	heading: string,
	insertBeforeHeading?: string | string[],
	technicalBlock?: string,
	copyLanguage?: CopyLanguage
): string {
	let nextContent = content;
	const startIndex = content.indexOf(TRANSCRIPT_ANALYSIS_START);
	const endIndex = content.indexOf(TRANSCRIPT_ANALYSIS_END);
	if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
		const fullBlock = [TRANSCRIPT_ANALYSIS_START, `# ${heading}`, "", analysisBlock, TRANSCRIPT_ANALYSIS_END].join("\n");
		nextContent = insertAnalysisSection(nextContent, fullBlock, insertBeforeHeading);
	} else {
		const existingSection = nextContent.slice(startIndex, endIndex + TRANSCRIPT_ANALYSIS_END.length);
		const updatedSection = insertOrReplaceAnalysisItem(existingSection, analysisBlock, templateId);
		const contentWithoutSection = `${nextContent.slice(0, startIndex)}${nextContent.slice(endIndex + TRANSCRIPT_ANALYSIS_END.length)}`;
		nextContent = insertAnalysisSection(contentWithoutSection, updatedSection, insertBeforeHeading);
	}

	if (technicalBlock && copyLanguage) {
		nextContent = insertOrReplaceTranscriptTechnicalItem(nextContent, technicalBlock, templateId, copyLanguage);
	}
	return nextContent;
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

function insertAnalysisSection(content: string, section: string, insertBeforeHeading?: string | string[]): string {
	const trimmedSection = section.trim();
	const managedSectionIndex = content.indexOf(TRANSCRIPT_MANAGED_START);
	const headingIndex = insertBeforeHeading ? findHeadingIndex(content, insertBeforeHeading) : -1;
	const insertionIndex = managedSectionIndex !== -1 ? managedSectionIndex : headingIndex;
	if (insertionIndex === -1) {
		const trimmedContent = content.trimEnd();
		return trimmedContent ? `${trimmedContent}\n\n${trimmedSection}\n` : `${trimmedSection}\n`;
	}

	const before = content.slice(0, insertionIndex).trimEnd();
	const after = content.slice(insertionIndex).replace(/^\n+/, "");
	const prefix = before ? `${before}\n\n` : "";
	return `${prefix}${trimmedSection}\n\n${after}`;
}

function findHeadingIndex(content: string, heading: string | string[]): number {
	const headings = Array.isArray(heading) ? heading : [heading];
	const matches = headings
		.map((candidate) => {
			const pattern = new RegExp(`^#{1,6}\\s+${escapeRegExp(candidate)}\\s*$`, "m");
			return pattern.exec(content)?.index ?? -1;
		})
		.filter((index) => index !== -1);

	return matches.length > 0 ? Math.min(...matches) : -1;
}

function extractContentAfterTranscriptHeading(content: string): string | null {
	const lines = content.split("\n");
	const transcriptHeadingIndex = lines.findIndex((line) => isTranscriptHeading(line));
	if (transcriptHeadingIndex === -1) {
		return null;
	}

	return lines
		.slice(transcriptHeadingIndex + 1)
		.join("\n")
		.trim();
}

function isTranscriptHeading(line: string): boolean {
	const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
	if (!match) {
		return false;
	}

	const heading = match[1];
	return (
		heading === "转写稿" ||
		heading.startsWith("转写稿 ") ||
		heading === "Transcribed manuscript" ||
		heading.startsWith("Transcribed manuscript ")
	);
}

function normalizeAnalysisMarkdownHeadings(markdown: string): string {
	let inFence = false;
	return markdown
		.split("\n")
		.map((line) => {
			if (/^\s*(```|~~~)/.test(line)) {
				inFence = !inFence;
				return line;
			}
			if (inFence) {
				return line;
			}

			const headingMatch = /^(\s{0,3})(#{1,6})(\s+.*)$/.exec(line);
			if (!headingMatch) {
				return line;
			}

			const nextLevel = Math.min(Math.max(headingMatch[2].length + 1, 3), 6);
			return `${headingMatch[1]}${"#".repeat(nextLevel)}${headingMatch[3]}`;
		})
		.join("\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

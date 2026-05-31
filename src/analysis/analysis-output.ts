import { getAnalysisTemplateTitle } from "./analysis-templates";
import { getLocalizedCopy, type AnalysisTemplateId, type CopyLanguage } from "../settings/settings";
import type { AnalysisResult } from "./analysis-provider";

export const ANALYSIS_LINKS_START = "<!-- echo-notes-analysis-links:start -->";
export const ANALYSIS_LINKS_END = "<!-- echo-notes-analysis-links:end -->";

export interface RenderAnalysisMarkdownInput {
	sourceTranscriptLink: string;
	transcriptBaseName: string;
	templateId: AnalysisTemplateId;
	result: AnalysisResult;
	copyLanguage: CopyLanguage;
}

export function getAnalysisPathForTranscriptPath(transcriptPath: string, templateId: AnalysisTemplateId): string {
	const transcriptFolder = getParentPath(transcriptPath);
	const transcriptBaseName = getBaseName(transcriptPath);
	return normalizeVaultPath(joinPath(transcriptFolder, `${transcriptBaseName}.analysis.${templateId}.md`));
}

export function renderAnalysisMarkdown(input: RenderAnalysisMarkdownInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const templateTitle = getAnalysisTemplateTitle(input.templateId, input.copyLanguage);

	return [
		"---",
		"type: audio-analysis",
		`source_transcript: "${escapeYaml(input.sourceTranscriptLink)}"`,
		`analysis_template: "${escapeYaml(input.templateId)}"`,
		`provider: "${escapeYaml(input.result.provider)}"`,
		`model: "${escapeYaml(input.result.model)}"`,
		`generated_at: ${new Date().toISOString()}`,
		"status: done",
		`trace_id: "${escapeYaml(input.result.traceId ?? "")}"`,
		"---",
		"",
		`# ${input.transcriptBaseName} ${templateTitle}`,
		"",
		`${copy.sourceTranscriptLabel}${input.sourceTranscriptLink}`,
		"",
		`## ${copy.analysisHeading}`,
		"",
		input.result.text.trim(),
		""
	].join("\n");
}

export function extractTranscriptText(content: string): string {
	return content
		.replace(/^---\n[\s\S]*?\n---\n?/, "")
		.replace(new RegExp(`${escapeRegExp(ANALYSIS_LINKS_START)}[\\s\\S]*?${escapeRegExp(ANALYSIS_LINKS_END)}\\n?`, "g"), "")
		.trim();
}

export function insertAnalysisLinkBlock(content: string, analysisLink: string, analysisBaseName: string, heading: string): string {
	if (content.includes(analysisLink) || content.includes(analysisBaseName)) {
		return content;
	}

	const lines = content.split("\n");
	const startIndex = lines.findIndex((line) => line.trim() === ANALYSIS_LINKS_START);
	const endIndex = lines.findIndex((line) => line.trim() === ANALYSIS_LINKS_END);

	if (startIndex !== -1 && endIndex > startIndex) {
		lines.splice(endIndex, 0, `- ${analysisLink}`);
		return lines.join("\n");
	}

	const block = [ANALYSIS_LINKS_START, `## ${heading}`, "", `- ${analysisLink}`, ANALYSIS_LINKS_END].join("\n");
	return `${content.trimEnd()}\n\n${block}\n`;
}

function getParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

function getBaseName(path: string): string {
	const name = path.split("/").pop() ?? path;
	const dotIndex = name.lastIndexOf(".");
	return dotIndex === -1 ? name : name.slice(0, dotIndex);
}

function joinPath(...parts: string[]): string {
	return parts.filter(Boolean).join("/");
}

function normalizeVaultPath(path: string): string {
	return path.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

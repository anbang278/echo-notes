import type { App, TFile } from "obsidian";
import { formatSegmentTimeRange } from "../audio/audio-segmenter";
import type { TranscriptionResult, TranscriptionSegment } from "../providers/transcription-provider";
import { getLocalizedCopy, type CopyLanguage } from "../settings/settings";

export interface TranscriptTemplateInput {
	app: App;
	audioFile: TFile;
	transcriptPath: string;
	sourceNote?: TFile;
	result: TranscriptionResult;
	copyLanguage: CopyLanguage;
}

export interface FailedTranscriptTemplateInput {
	app: App;
	audioFile: TFile;
	transcriptPath: string;
	sourceNote?: TFile;
	provider: string;
	model: string;
	error: string;
	traceId?: string;
	segments?: TranscriptionSegment[];
	copyLanguage: CopyLanguage;
}

export interface ProgressTranscriptTemplateInput {
	app: App;
	audioFile: TFile;
	transcriptPath: string;
	sourceNote?: TFile;
	provider: string;
	model: string;
	segments: TranscriptionSegment[];
	copyLanguage: CopyLanguage;
}

export function renderTranscriptTemplate(input: TranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const title = input.audioFile.basename;

	return [
		"---",
		"type: audio-transcript",
		`source_audio: "${escapeYaml(sourceAudioLink)}"`,
		`source_note: "${escapeYaml(sourceNoteLink)}"`,
		`provider: "${escapeYaml(input.result.provider)}"`,
		`model: "${escapeYaml(input.result.model)}"`,
		`transcribed_at: ${new Date().toISOString()}`,
		"status: done",
		`trace_id: "${escapeYaml(input.result.traceId ?? "")}"`,
		"---",
		"",
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderTranscriptionBody(input.result, input.copyLanguage),
		""
	].join("\n");
}

export function renderFailedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
	if (input.segments && input.segments.length > 0) {
		return renderInterruptedTranscriptTemplate(input);
	}

	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";

	return [
		"---",
		"type: audio-transcript",
		`source_audio: "${escapeYaml(sourceAudioLink)}"`,
		`source_note: "${escapeYaml(sourceNoteLink)}"`,
		`provider: "${escapeYaml(input.provider)}"`,
		`model: "${escapeYaml(input.model)}"`,
		`transcribed_at: ${new Date().toISOString()}`,
		"status: failed",
		`error: "${escapeYaml(input.error)}"`,
		`trace_id: "${escapeYaml(input.traceId ?? "")}"`,
		"---",
		"",
		`# ${copy.failedTitle}`,
		"",
		copy.errorReasonLabel,
		"",
		input.error,
		""
	].join("\n");
}

export function renderProgressTranscriptTemplate(input: ProgressTranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const title = input.audioFile.basename;

	return [
		...renderTranscriptFrontmatter({
			sourceAudioLink,
			sourceNoteLink,
			provider: input.provider,
			model: input.model,
			status: "transcribing"
		}),
		"",
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`> ${copy.transcribingNotice}`,
		"",
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderSegmentsOrEmpty(input.segments, input.copyLanguage),
		""
	].join("\n");
}

export function renderTranscriptionSegments(segments: TranscriptionSegment[], copyLanguage: CopyLanguage): string {
	const copy = getLocalizedCopy(copyLanguage);
	return segments
		.map((segment) =>
			[
				`## ${copy.segmentHeadingPrefix} ${segment.index.toString().padStart(2, "0")}（${formatSegmentTimeRange(segment)}）`,
				...(segment.traceId ? [`<!-- trace_id: ${escapeHtmlComment(segment.traceId)} -->`] : []),
				"",
				segment.text.trim() || copy.emptySegmentText
			].join("\n")
		)
		.join("\n\n");
}

function renderInterruptedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const title = input.audioFile.basename;

	return [
		...renderTranscriptFrontmatter({
			sourceAudioLink,
			sourceNoteLink,
			provider: input.provider,
			model: input.model,
			status: "failed",
			error: input.error,
			traceId: input.traceId
		}),
		"",
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`> ${copy.partialFailureNotice}`,
		"",
		copy.errorReasonLabel,
		"",
		input.error,
		"",
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderSegmentsOrEmpty(input.segments ?? [], input.copyLanguage),
		""
	].join("\n");
}

function renderSourceInfo(
	copy: ReturnType<typeof getLocalizedCopy>,
	sourceAudioLink: string,
	sourceNoteLink: string
): string[] {
	return [`${copy.sourceAudioLabel}!${sourceAudioLink}`, ...(sourceNoteLink ? [`${copy.sourceNoteLabel}${sourceNoteLink}`] : []), ""];
}

function formatTranscriptTitle(copy: ReturnType<typeof getLocalizedCopy>, title: string): string {
	return `${copy.transcriptHeading} ${title}`.trim();
}

function renderTranscriptFrontmatter(input: {
	sourceAudioLink: string;
	sourceNoteLink: string;
	provider: string;
	model: string;
	status: "transcribing" | "failed";
	error?: string;
	traceId?: string;
}): string[] {
	return [
		"---",
		"type: audio-transcript",
		`source_audio: "${escapeYaml(input.sourceAudioLink)}"`,
		`source_note: "${escapeYaml(input.sourceNoteLink)}"`,
		`provider: "${escapeYaml(input.provider)}"`,
		`model: "${escapeYaml(input.model)}"`,
		`transcribed_at: ${new Date().toISOString()}`,
		`status: ${input.status}`,
		...(input.error ? [`error: "${escapeYaml(input.error)}"`] : []),
		`trace_id: "${escapeYaml(input.traceId ?? "")}"`,
		"---"
	];
}

function renderTranscriptionBody(result: TranscriptionResult, copyLanguage: CopyLanguage): string {
	if (result.segments && result.segments.length > 0) {
		return renderTranscriptionSegments(result.segments, copyLanguage);
	}

	return result.text.trim();
}

function renderSegmentsOrEmpty(segments: TranscriptionSegment[], copyLanguage: CopyLanguage): string {
	if (segments.length > 0) {
		return renderTranscriptionSegments(segments, copyLanguage);
	}

	return getLocalizedCopy(copyLanguage).emptySegmentText;
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHtmlComment(value: string): string {
	return value.replace(/--/g, "- -").replace(/>/g, "&gt;");
}

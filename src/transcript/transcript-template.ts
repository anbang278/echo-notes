import type { App, TFile } from "obsidian";
import type { TranscriptionResult } from "../providers/transcription-provider";
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
		`# ${title} ${copy.transcriptTitleSuffix}`,
		"",
		`${copy.sourceAudioLabel}!${sourceAudioLink}`,
		...(sourceNoteLink ? [`${copy.sourceNoteLabel}${sourceNoteLink}`, ""] : [""]),
		`## ${copy.transcriptHeading}`,
		"",
		input.result.text.trim(),
		""
	].join("\n");
}

export function renderFailedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
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

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

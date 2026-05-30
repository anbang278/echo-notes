import type { App, TFile } from "obsidian";
import type { TranscriptionResult } from "../providers/transcription-provider";

export interface TranscriptTemplateInput {
	app: App;
	audioFile: TFile;
	transcriptPath: string;
	sourceNote?: TFile;
	result: TranscriptionResult;
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
}

export function renderTranscriptTemplate(input: TranscriptTemplateInput): string {
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
		`# ${title} 转写稿`,
		"",
		`原始录音：!${sourceAudioLink}`,
		...(sourceNoteLink ? [`来源笔记：${sourceNoteLink}`, ""] : [""]),
		"## Transcript",
		"",
		input.result.text.trim(),
		""
	].join("\n");
}

export function renderFailedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
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
		"# 转写失败",
		"",
		"错误原因：",
		"",
		input.error,
		""
	].join("\n");
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

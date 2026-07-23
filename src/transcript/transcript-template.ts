import type { App, TFile } from "obsidian";
import { formatSegmentTimeRange } from "../audio/audio-segmenter";
import type {
	TranscriptionResult,
	TranscriptionSegment,
	TranscriptionUtterance,
	StreamingTranscriptionState
} from "../providers/transcription-provider";
import {
	getLocalizedCopy,
	type AgentPlanSpeakerLabelStyle,
	type CopyLanguage
} from "../settings/settings";
import {
	createSourceAudioMetadata,
	renderSourceAudioMetadata,
	type SourceAudioMetadata
} from "./transcript-source-metadata";
import { TRANSCRIPT_MANAGED_END, TRANSCRIPT_MANAGED_START } from "./transcript-content";

export interface TranscriptTemplateInput {
	app: App;
	audioFile: TFile;
	transcriptPath: string;
	sourceNote?: TFile;
	result: TranscriptionResult;
	copyLanguage: CopyLanguage;
	speakerLabelStyle?: AgentPlanSpeakerLabelStyle;
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
	streamingState?: StreamingTranscriptionState;
	speakerLabelStyle?: AgentPlanSpeakerLabelStyle;
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
	streamingState?: StreamingTranscriptionState;
	speakerLabelStyle?: AgentPlanSpeakerLabelStyle;
	copyLanguage: CopyLanguage;
}

export function renderTranscriptTemplate(input: TranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const sourceAudioMetadata = createSourceAudioMetadata(input.audioFile);
	const title = input.audioFile.basename;

	return [
		"---",
		"type: audio-transcript",
		`source_audio: "${escapeYaml(sourceAudioLink)}"`,
		...renderSourceAudioMetadata(sourceAudioMetadata),
		`source_note: "${escapeYaml(sourceNoteLink)}"`,
		`provider: "${escapeYaml(input.result.provider)}"`,
		`model: "${escapeYaml(input.result.model)}"`,
		`transcribed_at: ${new Date().toISOString()}`,
		"status: done",
		`trace_id: "${escapeYaml(input.result.traceId ?? "")}"`,
		"---",
		"",
		TRANSCRIPT_MANAGED_START,
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderTranscriptionBody(
			input.result,
			input.copyLanguage,
			input.speakerLabelStyle ?? "speaker-with-time"
		),
		TRANSCRIPT_MANAGED_END,
		""
	].join("\n");
}

export function renderFailedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
	if (
		(input.segments && input.segments.length > 0) ||
		input.streamingState?.text.trim()
	) {
		return renderInterruptedTranscriptTemplate(input);
	}

	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const sourceAudioMetadata = createSourceAudioMetadata(input.audioFile);

	return [
		"---",
		"type: audio-transcript",
		`source_audio: "${escapeYaml(sourceAudioLink)}"`,
		...renderSourceAudioMetadata(sourceAudioMetadata),
		`source_note: "${escapeYaml(sourceNoteLink)}"`,
		`provider: "${escapeYaml(input.provider)}"`,
		`model: "${escapeYaml(input.model)}"`,
		`transcribed_at: ${new Date().toISOString()}`,
		"status: failed",
		`error: "${escapeYaml(input.error)}"`,
		`trace_id: "${escapeYaml(input.traceId ?? "")}"`,
		"---",
		"",
		TRANSCRIPT_MANAGED_START,
		`# ${copy.failedTitle}`,
		"",
		copy.errorReasonLabel,
		"",
		input.error,
		TRANSCRIPT_MANAGED_END,
		""
	].join("\n");
}

export function renderProgressTranscriptTemplate(input: ProgressTranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const sourceAudioMetadata = createSourceAudioMetadata(input.audioFile);
	const title = input.audioFile.basename;

	return [
		...renderTranscriptFrontmatter({
			sourceAudioLink,
			sourceAudioMetadata,
			sourceNoteLink,
			provider: input.provider,
			model: input.model,
			status: "transcribing"
		}),
		"",
		TRANSCRIPT_MANAGED_START,
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`> ${renderProgressNotice(input, copy.transcribingNotice)}`,
		"",
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderProgressBody(input),
		TRANSCRIPT_MANAGED_END,
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

export function renderTranscriptionUtterances(
	utterances: TranscriptionUtterance[],
	copyLanguage: CopyLanguage,
	style: AgentPlanSpeakerLabelStyle
): string {
	const turns = groupConsecutiveSpeakerUtterances(utterances);
	const copy = getLocalizedCopy(copyLanguage);
	const speakerNumbers = new Map<string, number>();

	return turns
		.map((turn) => {
			let speakerNumber = speakerNumbers.get(turn.speakerId);
			if (speakerNumber === undefined) {
				speakerNumber = speakerNumbers.size + 1;
				speakerNumbers.set(turn.speakerId, speakerNumber);
			}
			let localizedTimeRange = "";
			if (
				style === "speaker-with-time" &&
				turn.startSeconds !== undefined &&
				turn.endSeconds !== undefined &&
				turn.endSeconds >= turn.startSeconds
			) {
				const formattedTimeRange = formatSegmentTimeRange({
					startSeconds: turn.startSeconds,
					endSeconds: turn.endSeconds
				});
				localizedTimeRange =
					copyLanguage === "en" ? ` (${formattedTimeRange})` : `（${formattedTimeRange}）`;
			}
			return `**${copy.speakerLabel} ${speakerNumber}${localizedTimeRange}**\n\n${turn.text}`;
		})
		.join("\n\n");
}

function renderInterruptedTranscriptTemplate(input: FailedTranscriptTemplateInput): string {
	const copy = getLocalizedCopy(input.copyLanguage);
	const sourceAudioLink = input.app.fileManager.generateMarkdownLink(input.audioFile, input.transcriptPath);
	const sourceNoteLink = input.sourceNote
		? input.app.fileManager.generateMarkdownLink(input.sourceNote, input.transcriptPath)
		: "";
	const sourceAudioMetadata = createSourceAudioMetadata(input.audioFile);
	const title = input.audioFile.basename;

	return [
		...renderTranscriptFrontmatter({
			sourceAudioLink,
			sourceAudioMetadata,
			sourceNoteLink,
			provider: input.provider,
			model: input.model,
			status: "failed",
			error: input.error,
			traceId: input.traceId
		}),
		"",
		TRANSCRIPT_MANAGED_START,
		...renderSourceInfo(copy, sourceAudioLink, sourceNoteLink),
		`> ${copy.partialFailureNotice}`,
		"",
		copy.errorReasonLabel,
		"",
		input.error,
		"",
		`# ${formatTranscriptTitle(copy, title)}`,
		"",
		renderInterruptedBody(input),
		TRANSCRIPT_MANAGED_END,
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
	sourceAudioMetadata: SourceAudioMetadata;
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
		...renderSourceAudioMetadata(input.sourceAudioMetadata),
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

function renderTranscriptionBody(
	result: TranscriptionResult,
	copyLanguage: CopyLanguage,
	speakerLabelStyle: AgentPlanSpeakerLabelStyle
): string {
	if (result.utterances && result.utterances.length > 0) {
		return renderTranscriptionUtterances(result.utterances, copyLanguage, speakerLabelStyle);
	}

	if (result.segments && result.segments.length > 0) {
		return renderTranscriptionSegments(result.segments, copyLanguage);
	}

	return result.text.trim();
}

function groupConsecutiveSpeakerUtterances(utterances: TranscriptionUtterance[]): TranscriptionUtterance[] {
	const turns: TranscriptionUtterance[] = [];
	for (const utterance of utterances) {
		const text = utterance.text.trim();
		if (!text || !utterance.speakerId.trim()) {
			continue;
		}

		const previous = turns.at(-1);
		if (previous?.speakerId === utterance.speakerId) {
			previous.text = joinUtteranceText(previous.text, text);
			previous.startSeconds ??= utterance.startSeconds;
			if (utterance.endSeconds !== undefined) {
				previous.endSeconds = utterance.endSeconds;
			}
			continue;
		}

		turns.push({ ...utterance, speakerId: utterance.speakerId.trim(), text });
	}
	return turns;
}

function joinUtteranceText(left: string, right: string): string {
	const separator = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right) ? " " : "";
	return `${left}${separator}${right}`;
}

function renderSegmentsOrEmpty(segments: TranscriptionSegment[], copyLanguage: CopyLanguage): string {
	if (segments.length > 0) {
		return renderTranscriptionSegments(segments, copyLanguage);
	}

	return getLocalizedCopy(copyLanguage).emptySegmentText;
}

function renderProgressNotice(input: ProgressTranscriptTemplateInput, fallback: string): string {
	const state = input.streamingState;
	if (state?.realtime) {
		const elapsed = formatProgressTime(state.processedSeconds);
		const utteranceCount = state.utterances?.length ?? 0;
		return input.copyLanguage === "en"
			? `Realtime recording: ${elapsed}, ${state.connectionStatus ?? "connecting"}${utteranceCount > 0 ? `, ${utteranceCount} stable utterances written` : ""}.`
			: `正在实时录音：${elapsed}，${state.connectionStatus ?? "正在连接 AgentPlan"}${utteranceCount > 0 ? `，已写入 ${utteranceCount} 个确定分句` : ""}。`;
	}
	if (!state || state.totalSeconds <= 0) {
		return fallback;
	}

	const processed = formatProgressTime(state.processedSeconds);
	const total = formatProgressTime(state.totalSeconds);
	const utteranceCount = state.utterances?.length ?? 0;
	return input.copyLanguage === "en"
		? `Transcription is running: ${processed} / ${total} sent${utteranceCount > 0 ? `, ${utteranceCount} stable utterances written` : ""}.`
		: `音频正在转写：已发送 ${processed} / ${total}${utteranceCount > 0 ? `，已写入 ${utteranceCount} 个确定分句` : ""}。`;
}

function renderProgressBody(input: ProgressTranscriptTemplateInput): string {
	const state = input.streamingState;
	const provisional = state?.provisionalText?.trim();
	let stable: string;
	if (state?.utterances && state.utterances.length > 0) {
		stable = renderTranscriptionUtterances(
			state.utterances,
			input.copyLanguage,
			input.speakerLabelStyle ?? "speaker-with-time"
		);
	} else if (state?.text.trim()) {
		stable = state.text.trim();
	} else {
		stable = renderSegmentsOrEmpty(input.segments, input.copyLanguage);
	}
	if (!provisional) {
		return stable;
	}
	const provisionalBlock = input.copyLanguage === "en"
		? `> [!info] Recognizing\n> ${provisional.replace(/\n/g, "\n> ")}`
		: `> [!info] 正在识别\n> ${provisional.replace(/\n/g, "\n> ")}`;
	return `${stable}\n\n${provisionalBlock}`;
}

function renderInterruptedBody(input: FailedTranscriptTemplateInput): string {
	const state = input.streamingState;
	if (state?.utterances && state.utterances.length > 0) {
		return renderTranscriptionUtterances(
			state.utterances,
			input.copyLanguage,
			input.speakerLabelStyle ?? "speaker-with-time"
		);
	}
	if (state?.text.trim()) {
		return state.text.trim();
	}
	return renderSegmentsOrEmpty(input.segments ?? [], input.copyLanguage);
}

function formatProgressTime(seconds: number): string {
	const safeSeconds = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(safeSeconds / 3600);
	const minutes = Math.floor((safeSeconds % 3600) / 60);
	const remainingSeconds = safeSeconds % 60;
	return hours > 0
		? `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`
		: `${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function escapeHtmlComment(value: string): string {
	return value.replace(/--/g, "- -").replace(/>/g, "&gt;");
}

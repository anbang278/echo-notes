import type { AudioLinkMatch } from "../audio/audio-link-parser";
import {
	normalizeRecordingSummary,
	RECORDING_SUMMARY_END,
	RECORDING_SUMMARY_START
} from "../analysis/recording-summary";

export interface RecordingSummaryContentResult {
	status: "inserted" | "updated" | "already-present" | "skipped";
	content: string;
	reason?: string;
	previousSummary?: string;
	edit?: { line: number; from: number; to: number; text: string };
}

const TIME = "(?:[01]\\d|2[0-3]):[0-5]\\d";
const DATE = "\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])";
const TIME_RANGE = `(?:${TIME}–${TIME}|${DATE} ${TIME}–${DATE} ${TIME})`;
const RECORDING_TIME = new RegExp(`^ {0,3}录音时间：${TIME_RANGE}（(?:不到1分钟|[1-9]\\d*分钟|[1-9]\\d*小时(?:[1-9]\\d*分钟)?)）`);
const SUMMARY_LABEL = "｜AI 总结：";

/** Return a minimal edit of the time line, leaving every surrounding byte intact. */
export function updateRecordingSummaryContent(
	content: string,
	match: AudioLinkMatch,
	summary: string,
	knownSummaries: readonly string[] = []
): RecordingSummaryContentResult {
	const skipped = (reason: string): RecordingSummaryContentResult => ({ status: "skipped", content, reason });
	const normalized = normalizeRecordingSummary(summary);
	if (!normalized) return skipped("invalid-summary");
	if (match.lineStart === 0 || match.lineStart !== match.lineEnd) return skipped("missing-recording-time");
	const lineIndex = match.lineStart - 1;
	const lines = content.split("\n");
	const line = lines[lineIndex].replace(/\r$/, "");
	const lineOffset = lines.slice(0, lineIndex).reduce((offset, value) => offset + value.length + 1, 0);
	const beforeLine = content.slice(0, lineOffset);
	if (beforeLine.lastIndexOf("<!--") > beforeLine.lastIndexOf("-->")) return skipped("missing-recording-time");
	if (/^(?: {4}|\t)/.test(lines[match.lineStart])) return skipped("unsupported-audio-context");
	const timing = RECORDING_TIME.exec(line);
	if (!timing) return skipped("missing-recording-time");

	const start = line.indexOf(RECORDING_SUMMARY_START);
	const end = line.indexOf(RECORDING_SUMMARY_END);
	const hasMarker = line.includes("echo-notes-recording-summary");
	if (hasMarker && (
		start < timing[0].length || end < start + RECORDING_SUMMARY_START.length
		|| line.indexOf(RECORDING_SUMMARY_START, start + RECORDING_SUMMARY_START.length) !== -1
		|| line.indexOf(RECORDING_SUMMARY_END, end + RECORDING_SUMMARY_END.length) !== -1
		|| line.split("echo-notes-recording-summary").length !== 3
		|| !line.slice(start + RECORDING_SUMMARY_START.length, end).startsWith(SUMMARY_LABEL)
	)) return skipped("malformed-summary-marker");

	const text = `${SUMMARY_LABEL}${normalized}`;
	let from = line.length;
	let to = line.length;
	let previousSummary: string | undefined;
	if (hasMarker) {
		from = start;
		to = end + RECORDING_SUMMARY_END.length;
	} else {
		const labelIndex = line.indexOf(SUMMARY_LABEL);
		if (labelIndex !== -1) {
			if (line.indexOf(SUMMARY_LABEL, labelIndex + SUMMARY_LABEL.length) !== -1) return skipped("ambiguous-summary-label");
			const candidates = Array.from(new Set(knownSummaries)).filter((candidate) => line.startsWith(`${SUMMARY_LABEL}${candidate}`, labelIndex));
			if (candidates.length > 1) return skipped("ambiguous-summary-boundary");
			previousSummary = candidates[0];
			if (!previousSummary && knownSummaries.length === 0 && line.slice(labelIndex) === text) previousSummary = normalized;
			if (!previousSummary) return skipped("untracked-summary");
			from = labelIndex;
			to = labelIndex + SUMMARY_LABEL.length + previousSummary.length;
		}
	}
	if (line.slice(from, to) === text) return { status: "already-present", content, previousSummary };
	return {
		status: from === line.length ? "inserted" : "updated",
		content: `${content.slice(0, lineOffset + from)}${text}${content.slice(lineOffset + to)}`,
		previousSummary,
		edit: { line: lineIndex, from, to, text }
	};
}

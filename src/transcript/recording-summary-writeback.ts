import { normalizeHistoricalRecordingSummary, normalizeRecordingSummary } from "../analysis/recording-summary";

export const RECORDING_SUMMARY_WRITEBACK_FIELD = "echo_notes_recording_summary_writeback";

interface FrontmatterRange {
	start: number;
	end: number;
	lineEnding: string;
}

function findFrontmatter(content: string): FrontmatterRange | null | undefined {
	const opening = /^---(\r?\n)/.exec(content);
	if (!opening) return content.startsWith("---") ? null : undefined;
	const closing = /^---[ \t]*\r?$/gm;
	closing.lastIndex = opening[0].length;
	const match = closing.exec(content);
	return match ? { start: opening[0].length, end: match.index, lineEnding: opening[1] } : null;
}

function findFields(content: string, range: FrontmatterRange): RegExpMatchArray[] {
	return [...content.slice(range.start, range.end).matchAll(new RegExp(`^${RECORDING_SUMMARY_WRITEBACK_FIELD}:([^\\r\\n]*)(?:\\r?\\n|$)`, "gm"))];
}

/** An absent snapshot is empty. A malformed owned field cannot authorize a write. */
export function readRecordingSummaryWriteback(content: string): string[] | null {
	const range = findFrontmatter(content);
	if (range === null) return null;
	if (!range) return [];
	const fields = findFields(content, range);
	if (fields.length === 0) return [];
	if (fields.length !== 1) return null;
	try {
		const encoded = fields[0][1].trim();
		const scalar: unknown = /^'(?:[^']|'')*'$/.test(encoded)
			? encoded.slice(1, -1).replace(/''/g, "'")
			: JSON.parse(encoded);
		if (typeof scalar !== "string") return null;
		const values: unknown = JSON.parse(scalar);
		if (!Array.isArray(values) || values.length < 1 || values.length > 2) return null;
		if (!values.every((value: unknown) => typeof value === "string" && normalizeHistoricalRecordingSummary(value) === value)) return null;
		return Array.from(new Set(values as string[]));
	} catch {
		return null;
	}
}

/** Keep source-note ownership outside per-template analysis blocks. */
export function writeRecordingSummaryWriteback(content: string, summaries: readonly string[]): string | null {
	const values = Array.from(new Set(summaries));
	if (values.length < 1 || values.length > 2 || normalizeRecordingSummary(values[0]) !== values[0]
		|| values.some((value) => normalizeHistoricalRecordingSummary(value) !== value)) return null;
	if (readRecordingSummaryWriteback(content) === null) return null;
	const range = findFrontmatter(content);
	const field = `${RECORDING_SUMMARY_WRITEBACK_FIELD}: ${JSON.stringify(JSON.stringify(values))}`;
	if (!range) {
		const ending = content.includes("\r\n") ? "\r\n" : "\n";
		return `---${ending}${field}${ending}---${ending}${content}`;
	}
	const existing = findFields(content, range)[0];
	if (!existing) return `${content.slice(0, range.end)}${field}${range.lineEnding}${content.slice(range.end)}`;
	const start = range.start + existing.index!;
	const ending = existing[0].endsWith("\r\n") ? "\r\n" : existing[0].endsWith("\n") ? "\n" : "";
	return `${content.slice(0, start)}${field}${ending}${content.slice(start + existing[0].length)}`;
}

import { TRANSCRIPT_MANAGED_END, TRANSCRIPT_MANAGED_START } from "../transcript/transcript-content";
import { PROOFREADING_READING_END, PROOFREADING_READING_START } from "../proofreading/proofreading-document";
import type { FormalParagraph, FormalTranscript, SourceRange } from "./evidence-types";

const ANALYSIS_START = "<!-- echo-notes-analysis:start -->";
const ANALYSIS_END = "<!-- echo-notes-analysis:end -->";

export function normalizeEvidenceDocument(content: string): string {
	return content.replace(/\r\n/g, "\n");
}

/** Keep coordinates in the normalized complete document, including frontmatter. */
export function parseFormalTranscript(content: string): FormalTranscript {
	const document = normalizeEvidenceDocument(content);
	const result: FormalTranscript = {
		parserVersion: 1, status: "ok", kind: "transcript", normalizedDocument: document,
		ranges: [], paragraphs: [], errors: []
	};
	let range: SourceRange | null;
	if (document.includes("<!-- echo-notes-proofreading-")) {
		result.kind = "revised_transcript";
		range = ownedRange(document, PROOFREADING_READING_START, PROOFREADING_READING_END);
		if (!range) return unsupported(result, "校对阅读稿标记残缺或重复，需修复来源后重新核验。");
	} else if (document.includes(TRANSCRIPT_MANAGED_START) || document.includes(TRANSCRIPT_MANAGED_END)) {
		range = ownedRange(document, TRANSCRIPT_MANAGED_START, TRANSCRIPT_MANAGED_END);
		if (!range) return unsupported(result, "转写正文标记残缺或重复，需修复来源后重新核验。");
		range = afterTranscriptHeading(document, range, false) ?? range;
	} else {
		range = afterTranscriptHeading(document, { start: frontmatterEnd(document), end: document.length }, true);
		if (!range) return unsupported(result, "旧版转写缺少可识别的正式正文边界，需先登记或修复正文。");
	}
	result.ranges = removeTechnicalRanges(document, range);
	result.paragraphs = result.ranges.flatMap((section, index) => paragraphsWithin(document, section, index));
	if (result.paragraphs.length === 0) return unsupported(result, "正式转写正文为空。");
	return result;
}

/** Analysis stays in a separately labelled material channel. */
export function parseAnalysisSections(content: string): FormalTranscript {
	const document = normalizeEvidenceDocument(content);
	const result: FormalTranscript = {
		parserVersion: 1, status: "ok", kind: "transcript", normalizedDocument: document,
		ranges: [], paragraphs: [], errors: []
	};
	const range = ownedRange(document, ANALYSIS_START, ANALYSIS_END);
	if (!range) return unsupported(result, "AI 分析区不存在或标记不完整。");
	result.ranges = removeTechnicalRanges(document, range, true);
	result.paragraphs = result.ranges.flatMap((section, index) => paragraphsWithin(document, section, index));
	return result;
}

function unsupported(result: FormalTranscript, error: string): FormalTranscript {
	return { ...result, status: "unsupported", ranges: [], paragraphs: [], errors: [error] };
}

function ownedRange(content: string, opening: string, closing: string): SourceRange | null {
	const start = content.indexOf(opening);
	const end = content.indexOf(closing);
	if (start < 0 || end < start + opening.length || content.indexOf(opening, start + opening.length) >= 0 || content.indexOf(closing, end + closing.length) >= 0) return null;
	return { start: start + opening.length, end };
}

function frontmatterEnd(content: string): number {
	if (!content.startsWith("---\n")) return 0;
	const end = /^---[ \t]*$/gm;
	end.lastIndex = 4;
	const match = end.exec(content);
	return match ? match.index + match[0].length : content.length;
}

function afterTranscriptHeading(content: string, range: SourceRange, legacy: boolean): SourceRange | null {
	const text = content.slice(range.start, range.end);
	const heading = /^(#{1,6})[ \t]+([^\n]+)$/gm;
	let chosen: RegExpExecArray | null = null;
	for (const match of text.matchAll(heading)) {
		if (/^(?:转写正文|完整转写|正文|Transcription|Transcript text)$/i.test(match[2].trim())) {
			chosen = match;
			break;
		}
		if (!chosen && /^(?:转写稿(?:\s|$)|Transcribed manuscript(?:\s|$))/.test(match[2])) chosen = match;
		if (!legacy && !chosen && match[1].length === 1) chosen = match;
	}
	if (!chosen) return legacy ? null : range;
	const start = range.start + chosen.index + chosen[0].length;
	let end = range.end;
	const body = content.slice(start, end);
	for (const match of body.matchAll(heading)) {
		const label = match[2].trim();
		if (/^(?:AI\s*分析|分析结果|技术信息|技术记录|人工补充|Analysis|Technical|Notes)(?:\s|$)/i.test(label) || (legacy && match[1].length <= chosen[1].length)) {
			end = start + match.index;
			break;
		}
	}
	return { start, end };
}

function removeTechnicalRanges(content: string, range: SourceRange, analysis = false): SourceRange[] {
	const excluded: SourceRange[] = [];
	const text = content.slice(range.start, range.end);
	const pairs = [
		["<!-- echo-notes-transcript-technical:start -->", "<!-- echo-notes-transcript-technical:end -->"],
		["<!-- echo-notes-analysis-links:start -->", "<!-- echo-notes-analysis-links:end -->"]
	];
	if (!analysis) pairs.push([ANALYSIS_START, ANALYSIS_END]);
	for (const [opening, closing] of pairs) {
		let cursor = 0;
		for (;;) {
			const a = text.indexOf(opening, cursor);
			if (a < 0) break;
			const b = text.indexOf(closing, a + opening.length);
			// An unclosed technical area cannot leak the remainder as formal text.
			const end = b < 0 ? text.length : b + closing.length;
			excluded.push({ start: range.start + a, end: range.start + end });
			cursor = end;
		}
	}
	for (const match of text.matchAll(/<!--[\s\S]*?-->/g)) {
		excluded.push({ start: range.start + match.index, end: range.start + match.index + match[0].length });
	}
	excluded.sort((a, b) => a.start - b.start || a.end - b.end);
	const included: SourceRange[] = [];
	let cursor = range.start;
	for (const item of excluded) {
		if (item.start > cursor) addTrimmed(included, content, cursor, item.start);
		cursor = Math.max(cursor, item.end);
	}
	if (cursor < range.end) addTrimmed(included, content, cursor, range.end);
	return included;
}

function addTrimmed(ranges: SourceRange[], content: string, start: number, end: number): void {
	const text = content.slice(start, end);
	const left = /^\s*/u.exec(text)?.[0].length ?? 0;
	const right = /\s*$/u.exec(text)?.[0].length ?? 0;
	if (start + left < end - right) ranges.push({ start: start + left, end: end - right });
}

function paragraphsWithin(content: string, range: SourceRange, sectionIndex: number): FormalParagraph[] {
	const text = content.slice(range.start, range.end);
	const paragraphs: FormalParagraph[] = [];
	let speaker: string | undefined;
	let pendingSpeakerStart: number | undefined;
	for (const match of text.matchAll(/\S[\s\S]*?(?=\n[ \t]*\n|$)/g)) {
		const block = match[0].trimEnd();
		const offset = range.start + match.index;
		if (/^#{1,6}\s/u.test(block)) {
			pendingSpeakerStart = undefined;
			continue;
		}
		const label = /^\*\*([^\n]+)\*\*$/u.exec(block);
		if (label) {
			speaker = label[1];
			pendingSpeakerStart = offset;
			continue;
		}
		const inlineSpeaker = /^(?:\*\*)?([^\n：:]{1,40})[：:]/u.exec(block);
		const start = pendingSpeakerStart ?? offset;
		const end = offset + block.length;
		paragraphs.push({ start, end, sectionIndex, text: content.slice(start, end), ...(speaker || inlineSpeaker ? { speaker: speaker ?? inlineSpeaker?.[1] } : {}) });
		pendingSpeakerStart = undefined;
	}
	return paragraphs;
}

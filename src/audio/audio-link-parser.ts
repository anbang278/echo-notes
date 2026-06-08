import { isSupportedAudioExtension } from "./audio-detector";

export type AudioLinkType = "wiki" | "markdown";

export interface AudioLinkMatch {
	rawText: string;
	linkPath: string;
	type: AudioLinkType;
	start: number;
	end: number;
	lineStart: number;
	lineEnd: number;
}

interface TextRange {
	start: number;
	end: number;
}

const WIKI_LINK_REGEX = /!?\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_REGEX = /!?\[[^\]]*]\(([^)]+)\)/g;

export function parseAudioLinks(markdown: string): AudioLinkMatch[] {
	const lineStarts = buildLineStarts(markdown);
	const ignoredRanges = buildIgnoredMarkdownRanges(markdown, lineStarts);
	const matches: AudioLinkMatch[] = [];

	collectWikiLinks(markdown, lineStarts, ignoredRanges, matches);
	collectMarkdownLinks(markdown, lineStarts, ignoredRanges, matches);

	return matches
		.filter((match, index, all) => all.findIndex((candidate) => candidate.start === match.start && candidate.end === match.end) === index)
		.sort((a, b) => a.start - b.start);
}

export function normalizeAudioLinkPath(linkPath: string): string {
	const withoutSubpath = linkPath.split("#")[0];
	const trimmed = stripWrappingAngleBrackets(withoutSubpath.trim());

	try {
		return normalizeVaultLinkPath(decodeURIComponent(trimmed));
	} catch {
		return normalizeVaultLinkPath(trimmed);
	}
}

function collectWikiLinks(markdown: string, lineStarts: number[], ignoredRanges: TextRange[], matches: AudioLinkMatch[]): void {
	WIKI_LINK_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = WIKI_LINK_REGEX.exec(markdown)) !== null) {
		if (isOffsetIgnored(match.index, ignoredRanges)) {
			continue;
		}

		const rawText = match[0];
		const linkPath = normalizeAudioLinkPath(match[1].split("|")[0]);
		if (!isAudioPath(linkPath)) {
			continue;
		}

		matches.push({
			rawText,
			linkPath,
			type: "wiki",
			start: match.index,
			end: match.index + rawText.length,
			lineStart: offsetToLine(match.index, lineStarts),
			lineEnd: offsetToLine(match.index + rawText.length, lineStarts)
		});
	}
}

function collectMarkdownLinks(markdown: string, lineStarts: number[], ignoredRanges: TextRange[], matches: AudioLinkMatch[]): void {
	MARKDOWN_LINK_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
		if (isOffsetIgnored(match.index, ignoredRanges)) {
			continue;
		}

		const rawText = match[0];
		const linkPath = normalizeAudioLinkPath(match[1]);
		if (!isAudioPath(linkPath)) {
			continue;
		}

		matches.push({
			rawText,
			linkPath,
			type: "markdown",
			start: match.index,
			end: match.index + rawText.length,
			lineStart: offsetToLine(match.index, lineStarts),
			lineEnd: offsetToLine(match.index + rawText.length, lineStarts)
		});
	}
}

function isAudioPath(path: string): boolean {
	const extension = path.split("/").pop()?.split(".").pop()?.toLowerCase();
	return extension ? isSupportedAudioExtension(extension) : false;
}

function stripWrappingAngleBrackets(value: string): string {
	if (value.startsWith("<") && value.endsWith(">")) {
		return value.slice(1, -1);
	}

	return value;
}

function normalizeVaultLinkPath(path: string): string {
	return path.replace(/^\/+/, "").replace(/^\.\//, "").replace(/\\/g, "/").replace(/\/+/g, "/");
}

function buildIgnoredMarkdownRanges(markdown: string, lineStarts: number[]): TextRange[] {
	return [
		...buildFrontmatterRanges(markdown, lineStarts),
		...buildFencedCodeBlockRanges(markdown, lineStarts),
		...buildHtmlCommentRanges(markdown)
	].sort((left, right) => left.start - right.start);
}

function buildFrontmatterRanges(markdown: string, lineStarts: number[]): TextRange[] {
	if (lineStarts.length === 0 || getLineText(markdown, lineStarts, 0).trim() !== "---") {
		return [];
	}

	for (let lineIndex = 1; lineIndex < lineStarts.length; lineIndex += 1) {
		if (getLineText(markdown, lineStarts, lineIndex).trim() === "---") {
			return [{ start: 0, end: getLineEnd(markdown, lineStarts, lineIndex) }];
		}
	}

	return [];
}

function buildFencedCodeBlockRanges(markdown: string, lineStarts: number[]): TextRange[] {
	const ranges: TextRange[] = [];
	let openFence: { marker: string; length: number; start: number } | null = null;

	for (let lineIndex = 0; lineIndex < lineStarts.length; lineIndex += 1) {
		const lineText = getLineText(markdown, lineStarts, lineIndex);
		const fence = lineText.match(/^\s{0,3}(`{3,}|~{3,})/);
		if (!fence) {
			continue;
		}

		const marker = fence[1][0];
		const length = fence[1].length;
		if (!openFence) {
			openFence = {
				marker,
				length,
				start: lineStarts[lineIndex]
			};
			continue;
		}

		if (marker === openFence.marker && length >= openFence.length) {
			ranges.push({
				start: openFence.start,
				end: getLineEnd(markdown, lineStarts, lineIndex)
			});
			openFence = null;
		}
	}

	if (openFence) {
		ranges.push({ start: openFence.start, end: markdown.length });
	}

	return ranges;
}

function buildHtmlCommentRanges(markdown: string): TextRange[] {
	const ranges: TextRange[] = [];
	let searchStart = 0;

	while (searchStart < markdown.length) {
		const start = markdown.indexOf("<!--", searchStart);
		if (start === -1) {
			break;
		}

		const endMarker = markdown.indexOf("-->", start + 4);
		const end = endMarker === -1 ? markdown.length : endMarker + 3;
		ranges.push({ start, end });
		searchStart = end;
	}

	return ranges;
}

function isOffsetIgnored(offset: number, ignoredRanges: TextRange[]): boolean {
	return ignoredRanges.some((range) => offset >= range.start && offset < range.end);
}

function buildLineStarts(markdown: string): number[] {
	const starts = [0];
	for (let index = 0; index < markdown.length; index += 1) {
		if (markdown[index] === "\n") {
			starts.push(index + 1);
		}
	}

	return starts;
}

function getLineText(markdown: string, lineStarts: number[], lineIndex: number): string {
	return markdown.slice(lineStarts[lineIndex], getLineEnd(markdown, lineStarts, lineIndex));
}

function getLineEnd(markdown: string, lineStarts: number[], lineIndex: number): number {
	return lineStarts[lineIndex + 1] ?? markdown.length;
}

function offsetToLine(offset: number, lineStarts: number[]): number {
	let low = 0;
	let high = lineStarts.length - 1;

	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		if (lineStarts[middle] <= offset) {
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}

	return Math.max(0, low - 1);
}

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

const WIKI_LINK_REGEX = /!?\[\[([^\]]+)\]\]/g;
const MARKDOWN_LINK_REGEX = /!?\[[^\]]*]\(([^)]+)\)/g;

export function parseAudioLinks(markdown: string): AudioLinkMatch[] {
	const lineStarts = buildLineStarts(markdown);
	const matches: AudioLinkMatch[] = [];

	collectWikiLinks(markdown, lineStarts, matches);
	collectMarkdownLinks(markdown, lineStarts, matches);

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

function collectWikiLinks(markdown: string, lineStarts: number[], matches: AudioLinkMatch[]): void {
	WIKI_LINK_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = WIKI_LINK_REGEX.exec(markdown)) !== null) {
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

function collectMarkdownLinks(markdown: string, lineStarts: number[], matches: AudioLinkMatch[]): void {
	MARKDOWN_LINK_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;

	while ((match = MARKDOWN_LINK_REGEX.exec(markdown)) !== null) {
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

function buildLineStarts(markdown: string): number[] {
	const starts = [0];
	for (let index = 0; index < markdown.length; index += 1) {
		if (markdown[index] === "\n") {
			starts.push(index + 1);
		}
	}

	return starts;
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

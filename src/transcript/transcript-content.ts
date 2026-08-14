export const TRANSCRIPT_MANAGED_START = "<!-- echo-notes-transcript:start -->";
export const TRANSCRIPT_MANAGED_END = "<!-- echo-notes-transcript:end -->";
export const TRANSCRIPT_TECHNICAL_START = "<!-- echo-notes-transcript-technical:start -->";
export const TRANSCRIPT_TECHNICAL_END = "<!-- echo-notes-transcript-technical:end -->";

const MANAGED_FRONTMATTER_KEYS = new Set([
	"type",
	"source_audio",
	"source_audio_path",
	"source_audio_size",
	"source_audio_mtime",
	"source_note",
	"provider",
	"model",
	"transcribed_at",
	"status",
	"error",
	"trace_id"
]);

interface FrontmatterDocument {
	lines: string[];
	body: string;
}

export function mergeManagedTranscriptDocument(existingContent: string, nextContent: string): string | null {
	const existingManagedBlock = getManagedBlock(existingContent);
	const nextManagedBlock = getManagedBlock(nextContent);
	const existingDocument = splitFrontmatter(existingContent);
	const nextDocument = splitFrontmatter(nextContent);
	if (!existingManagedBlock || !nextManagedBlock || !existingDocument || !nextDocument) {
		return null;
	}

	const contentWithUpdatedBlock =
		existingContent.slice(0, existingManagedBlock.startIndex) +
		nextContent.slice(nextManagedBlock.startIndex, nextManagedBlock.endIndex) +
		existingContent.slice(existingManagedBlock.endIndex);
	const updatedDocument = splitFrontmatter(contentWithUpdatedBlock);
	if (!updatedDocument) {
		return null;
	}

	const preservedLines = updatedDocument.lines.filter((line) => !MANAGED_FRONTMATTER_KEYS.has(getTopLevelKey(line)));
	const nextManagedLines = nextDocument.lines.filter((line) => MANAGED_FRONTMATTER_KEYS.has(getTopLevelKey(line)));
	const mergedLines = [...preservedLines, ...nextManagedLines];

	return ["---", ...mergedLines, "---", updatedDocument.body].join("\n");
}

export function createTranscriptBackupPath(path: string, timestamp: string, attempt = 0): string {
	const suffix = attempt > 0 ? `-${attempt}` : "";
	const extensionIndex = path.toLowerCase().endsWith(".md") ? path.length - 3 : path.length;
	return `${path.slice(0, extensionIndex)}.backup-${timestamp}${suffix}.md`;
}

function getManagedBlock(content: string): { startIndex: number; endIndex: number } | null {
	const startIndex = content.indexOf(TRANSCRIPT_MANAGED_START);
	const endMarkerIndex = content.indexOf(TRANSCRIPT_MANAGED_END, startIndex + TRANSCRIPT_MANAGED_START.length);
	if (startIndex === -1 || endMarkerIndex === -1) {
		return null;
	}

	return {
		startIndex,
		endIndex: endMarkerIndex + TRANSCRIPT_MANAGED_END.length
	};
}

function splitFrontmatter(content: string): FrontmatterDocument | null {
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) {
		return null;
	}

	return {
		lines: match[1].split(/\r?\n/),
		body: content.slice(match[0].length)
	};
}

function getTopLevelKey(line: string): string {
	return /^([A-Za-z0-9_-]+):/.exec(line)?.[1] ?? "";
}

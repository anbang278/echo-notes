import type { DualModelProofreadingSession } from "./proofreading";

// 旧版恢复数据曾写入 Markdown；仅用于读取并迁移，新的会话数据保存在插件本机存储中。
export const PROOFREADING_DATA_START = "<!-- echo-notes-proofreading-data:start\n";
export const PROOFREADING_DATA_END = "\necho-notes-proofreading-data:end -->";
export const PROOFREADING_READING_START = "<!-- echo-notes-proofreading-reading:start -->";
export const PROOFREADING_READING_END = "<!-- echo-notes-proofreading-reading:end -->";

const LEGACY_PROOFREADING_DATA_START = "<!-- echo-notes-proofreading-data:start -->";
const LEGACY_PROOFREADING_DATA_END = "<!-- echo-notes-proofreading-data:end -->";

export interface ProofreadingDocument {
	readingText: string;
	session: DualModelProofreadingSession;
}

/** Markdown 只保存可读内容；恢复会话由 ProofreadingSessionStore 单独持久化。 */
export function renderProofreadingBlocks(session: DualModelProofreadingSession): string {
	return [
		PROOFREADING_READING_START,
		session.readingText,
		PROOFREADING_READING_END,
		"",
		"> [!note]- 主模型转写稿",
		"> " + session.primary.text.replace(/\n/g, "\n> "),
		"",
		...(session.auxiliary ? ["> [!note]- 辅助模型转写稿", "> " + session.auxiliary.text.replace(/\n/g, "\n> "), ""] : []),
		"> [!info]- 校对记录与恢复信息",
		"> 状态：" + session.status + "；待确认：" + session.issues.filter((item) => !item.decision).length,
		""
	].join("\n");
}

/** 只兼容读取旧版内嵌恢复数据；新稿必须从本机会话存储读取。 */
export function parseProofreadingDocument(content: string): ProofreadingDocument | null {
	const reading = between(content, PROOFREADING_READING_START, PROOFREADING_READING_END);
	const data = findProofreadingData(content);
	if (reading === null || data === null) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(data.encoded.trim())) as DualModelProofreadingSession;
		if (parsed.schemaVersion !== 2 || !parsed.sessionId || !parsed.primary?.text || !Array.isArray(parsed.issues)) return null;
		return { readingText: reading.trim(), session: { ...parsed, readingText: reading.trim() } };
	} catch {
		return null;
	}
}

export function replaceProofreadingBlocks(content: string, session: DualModelProofreadingSession): string | null {
	const oldStart = content.indexOf(PROOFREADING_READING_START);
	const oldEnd = findProofreadingBlockEnd(content, oldStart);
	if (oldStart < 0 || oldEnd === null || oldEnd < oldStart) return null;
	return `${content.slice(0, oldStart)}${renderProofreadingBlocks(session)}${content.slice(oldEnd)}`;
}

export function extractProofreadingReadingText(content: string): string | null {
	const reading = between(content, PROOFREADING_READING_START, PROOFREADING_READING_END);
	return reading === null ? null : reading.trim();
}

function between(content: string, startMarker: string, endMarker: string): string | null {
	const start = content.indexOf(startMarker);
	const end = content.indexOf(endMarker, start + startMarker.length);
	return start < 0 || end < start ? null : content.slice(start + startMarker.length, end);
}

function findProofreadingData(content: string): { encoded: string; end: number } | null {
	const current = findBetweenWithEnd(content, PROOFREADING_DATA_START, PROOFREADING_DATA_END);
	return current ?? findBetweenWithEnd(content, LEGACY_PROOFREADING_DATA_START, LEGACY_PROOFREADING_DATA_END);
}

function findProofreadingBlockEnd(content: string, start: number): number | null {
	const data = findProofreadingData(content);
	if (data && data.end >= start) return data.end;
	const transcriptEnd = content.indexOf("<!-- echo-notes-transcript:end -->", start);
	return transcriptEnd < 0 ? null : transcriptEnd;
}

function findBetweenWithEnd(content: string, startMarker: string, endMarker: string): { encoded: string; end: number } | null {
	const start = content.indexOf(startMarker);
	const end = content.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < start) return null;
	return { encoded: content.slice(start + startMarker.length, end), end: end + endMarker.length };
}

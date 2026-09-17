import type { DualModelProofreadingSession } from "./proofreading";

// 恢复数据必须处在同一个 HTML 注释内；分开的起止注释会让中间的编码文本被 Markdown 渲染。
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

/** 单一 Markdown 的受控区块；读取失败即显式失败，绝不退回全文交给下游 AI。 */
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
		"",
		PROOFREADING_DATA_START,
		encodeSession(session),
		PROOFREADING_DATA_END
	].join("\n");
}

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
	const data = findProofreadingData(content);
	if (oldStart < 0 || data === null || data.end < oldStart) return null;
	return `${content.slice(0, oldStart)}${renderProofreadingBlocks(session)}${content.slice(data.end)}`;
}

export function extractProofreadingReadingText(content: string): string | null {
	return parseProofreadingDocument(content)?.readingText ?? null;
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

function findBetweenWithEnd(content: string, startMarker: string, endMarker: string): { encoded: string; end: number } | null {
	const start = content.indexOf(startMarker);
	const end = content.indexOf(endMarker, start + startMarker.length);
	if (start < 0 || end < start) return null;
	return { encoded: content.slice(start + startMarker.length, end), end: end + endMarker.length };
}

function encodeSession(session: DualModelProofreadingSession): string {
	return encodeURIComponent(JSON.stringify(session));
}

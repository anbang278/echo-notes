import type { DualModelProofreadingSession } from "./proofreading";

export const PROOFREADING_DATA_START = "<!-- echo-notes-proofreading-data:start -->";
export const PROOFREADING_DATA_END = "<!-- echo-notes-proofreading-data:end -->";
export const PROOFREADING_READING_START = "<!-- echo-notes-proofreading-reading:start -->";
export const PROOFREADING_READING_END = "<!-- echo-notes-proofreading-reading:end -->";

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
	const encoded = between(content, PROOFREADING_DATA_START, PROOFREADING_DATA_END);
	if (reading === null || encoded === null) return null;
	try {
		const parsed = JSON.parse(decodeURIComponent(encoded.trim())) as DualModelProofreadingSession;
		if (parsed.schemaVersion !== 2 || !parsed.sessionId || !parsed.primary?.text || !Array.isArray(parsed.issues)) return null;
		return { readingText: reading.trim(), session: { ...parsed, readingText: reading.trim() } };
	} catch {
		return null;
	}
}

export function replaceProofreadingBlocks(content: string, session: DualModelProofreadingSession): string | null {
	const oldStart = content.indexOf(PROOFREADING_READING_START);
	const oldEnd = content.indexOf(PROOFREADING_DATA_END);
	if (oldStart < 0 || oldEnd < oldStart) return null;
	const end = oldEnd + PROOFREADING_DATA_END.length;
	return `${content.slice(0, oldStart)}${renderProofreadingBlocks(session)}${content.slice(end)}`;
}

export function extractProofreadingReadingText(content: string): string | null {
	return parseProofreadingDocument(content)?.readingText ?? null;
}

function between(content: string, startMarker: string, endMarker: string): string | null {
	const start = content.indexOf(startMarker);
	const end = content.indexOf(endMarker, start + startMarker.length);
	return start < 0 || end < start ? null : content.slice(start + startMarker.length, end);
}

function encodeSession(session: DualModelProofreadingSession): string {
	return encodeURIComponent(JSON.stringify(session)).replace(/%/g, "%");
}

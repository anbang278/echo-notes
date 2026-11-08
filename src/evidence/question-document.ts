import { normalizeEvidenceQuery } from "./evidence-query";
import type { QuestionRecord } from "./evidence-types";

const START = "<!-- echo-notes-question:start -->";
const END = "<!-- echo-notes-question:end -->";

/** Existing text outside the owned query block remains authoritative and byte-for-byte intact. */
export function renderQuestionDocument(record: QuestionRecord, existingContent?: string): string {
	const normalized = validateRecord(record);
	let current = normalized;
	if (existingContent !== undefined) {
		const existing = parseQuestionDocument(existingContent);
		if (!existing || existing.id !== record.id) throw new Error("问题文档身份或受管标记不匹配，已停止覆盖。");
		current = { ...normalized, createdAt: existing.createdAt, notes: existing.notes };
	}
	const block = [START, "```json", JSON.stringify(current, null, 2).replace(/</g, "\\u003c"), "```", END].join("\n");
	if (existingContent !== undefined) {
		const start = existingContent.indexOf(START);
		const end = existingContent.indexOf(END) + END.length;
		return existingContent.slice(0, start) + block + existingContent.slice(end);
	}
	return ["---", "echo_schema: 1", "echo_kind: question", `echo_question_id: ${JSON.stringify(current.id)}`, "---", "",
		`# ${current.query.question.replace(/[\r\n]/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;") || "按范围整理"}`, "", block, "", "## 人工备注", "", current.notes, ""].join("\n");
}

export function parseQuestionDocument(content: string): QuestionRecord | null {
	const start = content.indexOf(START), end = content.indexOf(END);
	if (start < 0 || end < start || content.indexOf(START, start + START.length) >= 0 || content.indexOf(END, end + END.length) >= 0) return null;
	const inner = content.slice(start + START.length, end).trim();
	const encoded = /^```json\s*\n([\s\S]*)\n```$/.exec(inner);
	if (!encoded) return null;
	try {
		const value = validateRecord(JSON.parse(encoded[1]) as QuestionRecord);
		const manual = content.slice(end + END.length);
		const notes = /(?:^|\n)## 人工备注[ \t]*\n([\s\S]*)/.exec(manual);
		return notes ? { ...value, notes: notes[1].replace(/^\n/, "").replace(/\n$/, "") } : value;
	} catch { return null; }
}

function validateRecord(record: QuestionRecord): QuestionRecord {
	if (!record || record.schemaVersion !== 1 || typeof record.id !== "string" || !record.id.trim() || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.notes !== "string" || !Array.isArray(record.pinnedEvidence)) throw new Error("问题文档格式不受支持。");
	for (const item of record.pinnedEvidence) {
		if (!item || typeof item.evidenceId !== "string" || typeof item.sourceId !== "string" || typeof item.sourceRevision !== "string" || !item.sourceRange || !Number.isInteger(item.sourceRange.start) || !Number.isInteger(item.sourceRange.end) || item.sourceRange.start < 0 || item.sourceRange.end <= item.sourceRange.start) throw new Error("问题中的固定引用格式无效。");
	}
	return { ...record, query: normalizeEvidenceQuery(record.query) };
}

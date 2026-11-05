import type { CopyLanguage } from "../settings/settings";

export const RECORDING_SUMMARY_START = "<!-- echo-notes-recording-summary:start -->";
export const RECORDING_SUMMARY_END = "<!-- echo-notes-recording-summary:end -->";
export const RECORDING_SUMMARY_MIN_CHARACTERS = 15;
export const RECORDING_SUMMARY_MAX_CHARACTERS = 30;

export function normalizeRecordingSummary(value: string): string | undefined {
	const summary = value.trim();
	const characters = Array.from(summary);
	if (characters.length < RECORDING_SUMMARY_MIN_CHARACTERS || characters.length > RECORDING_SUMMARY_MAX_CHARACTERS) return undefined;
	if (/[\u2028\u2029<>`[\]\\*]/u.test(summary)
		|| characters.some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
		|| summary.includes("%%") || summary.includes("__") || summary.includes("｜AI 总结：")
		|| /^#{1,6}\s/u.test(summary)) return undefined;
	return summary;
}

export function createRecordingSummaryPrompt(copyLanguage: CopyLanguage): string {
	const instructions = copyLanguage === "en"
		? [
			"After the complete analysis, append one concise plain-text sentence explaining what this meeting or recording is for, so the reader understands its topic without opening the transcript.",
			"Focus on the specific subject and meeting topic or purpose. Use terms such as training, reconciliation or review only when supported by the transcript. Omit detailed processes and do not force conclusions or action items.",
			"Use only information supported by the transcript. Do not invent participants, intentions or outcomes to meet the length requirement. Leave the summary empty if the available facts cannot support a summary within the required length.",
			`Use ${RECORDING_SUMMARY_MIN_CHARACTERS}–${RECORDING_SUMMARY_MAX_CHARACTERS} Unicode characters, including spaces and punctuation. Keep it on one line, without a heading, prefix or Markdown formatting.`
		]
		: [
			"完成完整分析后，额外输出一句核心精炼的录音摘要，让读者不打开转写稿也能知道这场会议或这段录音是做什么的。",
			"聚焦具体事项和会议主题或用途，培训、核对、评审等词须有转写依据。不铺陈过程，不强求结论或行动项，避免“讨论相关问题”等空泛表述。",
			"只使用转写稿中有依据的信息，不猜测意图，不为凑字编造参与人、目的或结论。已有信息无法支持规定长度的摘要时，摘要留空。",
			`严格${RECORDING_SUMMARY_MIN_CHARACTERS}–${RECORDING_SUMMARY_MAX_CHARACTERS}字，按Unicode字符计数，包含标点。摘要必须是单行纯文本，不加标题、前缀或Markdown格式。`
		];
	return [
		...instructions,
		copyLanguage === "en"
			? "Place the summary inside the following exact markers at the very end of the response, after the analysis. Emit each marker exactly once."
			: "摘要放在分析正文之后、响应末尾的以下精确标记之间，每个标记只输出一次。",
		RECORDING_SUMMARY_START,
		copyLanguage === "en" ? "One plain-text summary sentence" : "一句纯文本摘要",
		RECORDING_SUMMARY_END
	].join("\n");
}

export function parseRecordingSummaryResponse(
	text: string,
	includeRecordingSummary = false
): { text: string; recordingSummary?: string } {
	if (!includeRecordingSummary) return { text };
	const starts = text.split(RECORDING_SUMMARY_START).length - 1;
	const ends = text.split(RECORDING_SUMMARY_END).length - 1;
	const start = text.indexOf(RECORDING_SUMMARY_START);
	const end = text.indexOf(RECORDING_SUMMARY_END);
	const paired = starts === 1 && ends === 1 && end > start;
	const recordingSummary = paired && !text.slice(end + RECORDING_SUMMARY_END.length).trim()
		? normalizeRecordingSummary(text.slice(start + RECORDING_SUMMARY_START.length, end))
		: undefined;

	// Remove only the dedicated envelope. A dangling start belongs to the appended summary.
	let body = text.replace(/<!-- echo-notes-recording-summary:start -->[\s\S]*?<!-- echo-notes-recording-summary:end -->/g, "");
	const danglingStart = body.indexOf(RECORDING_SUMMARY_START);
	if (danglingStart !== -1) body = body.slice(0, danglingStart);
	body = body.split(RECORDING_SUMMARY_END).join("");
	return { text: body.trimEnd(), ...(recordingSummary ? { recordingSummary } : {}) };
}

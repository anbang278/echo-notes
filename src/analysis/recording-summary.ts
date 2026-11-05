import type { CopyLanguage } from "../settings/settings";

export const RECORDING_SUMMARY_START = "<!-- echo-notes-recording-summary:start -->";
export const RECORDING_SUMMARY_END = "<!-- echo-notes-recording-summary:end -->";
export const RECORDING_SUMMARY_MAX_CHARACTERS = 150;

export function normalizeRecordingSummary(value: string): string | undefined {
	const summary = value.trim();
	if (!summary || Array.from(summary).length > RECORDING_SUMMARY_MAX_CHARACTERS) return undefined;
	if (/[\u2028\u2029<>`[\]\\*]/u.test(summary)
		|| Array.from(summary).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
		|| summary.includes("%%") || summary.includes("__") || /^#{1,6}\s/u.test(summary)) return undefined;
	return summary;
}

export function createRecordingSummaryPrompt(copyLanguage: CopyLanguage): string {
	const instructions = copyLanguage === "en"
		? [
			"After the complete analysis, append one plain-text sentence explaining what this meeting or recording is for, so the reader can understand its purpose without opening the transcript.",
			"Name the specific project, business topic or problem, the stated purpose, and the main discussion or activity. Include a clear outcome only if it helps explain the purpose.",
			"Use only information supported by the transcript. If no purpose is stated, describe the actual discussion or activity. Do not invent intentions or force conclusions or action items.",
			"Aim for 50–100 characters and use at most 150 Unicode characters, including spaces. A shorter sentence is fine when the source is brief. Keep it on one line, without a heading, prefix or Markdown formatting."
		]
		: [
			"完成完整分析后，额外输出一句用途明确的录音摘要，让读者不打开转写稿也能知道这场会议或这段录音是做什么的。",
			"优先交代具体项目、业务或问题，会议或录音的目的，以及主要讨论范围或活动内容。明确结果有助于理解用途时才简要带出。",
			"只使用转写稿中有依据的信息，没有明确目的时通过实际讨论或活动说明用途，不猜测意图，不强求结论或行动项，避免“讨论相关问题”等空泛表述。",
			"通常50–100字，最多150个Unicode字符，信息少时允许更短。摘要必须是单行纯文本，不加标题、前缀或Markdown格式。"
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

import assert from "node:assert/strict";
import { DEFAULT_ANALYSIS_TEMPLATES } from "../src/settings/settings";
import type { AnalysisInput } from "../src/analysis/analysis-provider";
import { buildAnalysisMessages } from "../src/analysis/analysis-templates";
import { createChunkAnalysisInput, createSynthesisAnalysisInput } from "../src/analysis/analysis-stage-prompts";
import {
	insertOrReplaceTranscriptTechnicalItem,
	readTranscriptRecordingSummary,
	renderTranscriptTechnicalInfo
} from "../src/analysis/analysis-technical";
import {
	RECORDING_SUMMARY_END,
	RECORDING_SUMMARY_START,
	normalizeRecordingSummary,
	parseRecordingSummaryResponse
} from "../src/analysis/recording-summary";

const envelope = (summary: string): string => `${RECORDING_SUMMARY_START}\n${summary}\n${RECORDING_SUMMARY_END}`;

export function runRecordingSummaryAnalysisTests(): void {
	const input: AnalysisInput = {
		template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"],
		transcriptTitle: "Synthetic meeting.transcript",
		transcriptText: "为准备新人上岗，本次培训通过模拟客户问答练习销售沟通。",
		copyLanguage: "zh",
		includeRecordingSummary: true
	};
	const prompt = buildAnalysisMessages(input);
	assert.match(prompt.system, /不打开转写稿.*是做什么的/);
	assert.match(prompt.system, /具体项目、业务或问题/);
	assert.match(prompt.system, /目的.*主要讨论范围或活动内容/);
	assert.match(prompt.system, /没有明确目的.*不猜测意图/);
	assert.match(prompt.system, /50–100字.*150个Unicode字符/);
	assert.match(prompt.system, /信息少时允许更短/);
	assert.ok(prompt.system.includes(RECORDING_SUMMARY_START));
	assert.ok(prompt.system.includes(RECORDING_SUMMARY_END));
	assert.ok(prompt.user.includes(input.template.customPrompt.trim()), "保留原模板要求");
	assert.ok(prompt.user.includes(input.transcriptText), "保持原转写输入");
	assert.ok(!buildAnalysisMessages({ ...input, includeRecordingSummary: undefined }).system.includes(RECORDING_SUMMARY_START));
	assert.match(buildAnalysisMessages({ ...input, copyLanguage: "en" }).system, /what this meeting or recording is for/);
	assert.match(buildAnalysisMessages({ ...input, copyLanguage: "en" }).system, /at most 150 Unicode characters/);

	const chunk = createChunkAnalysisInput(input, 1, 2);
	assert.equal(chunk.includeRecordingSummary, false);
	assert.ok(!buildAnalysisMessages(chunk).system.includes(RECORDING_SUMMARY_START));
	const synthesis = createSynthesisAnalysisInput(input, [{ text: "新人进行模拟问答训练。", provider: "test", model: "mock" }]);
	assert.equal(synthesis.includeRecordingSummary, true);
	assert.ok(buildAnalysisMessages(synthesis).system.includes(RECORDING_SUMMARY_START));
	assert.equal(createSynthesisAnalysisInput({ ...input, includeRecordingSummary: undefined }, []).includeRecordingSummary, undefined);

	const summary = "面向新员工开展销售沟通培训，通过模拟客户问答练习提问顺序与表达语气，帮助新人熟悉上岗后的客户沟通方式。";
	const body = "## 培训内容\n\n练习客户问答。\n\n## 后续\n\n安排下一次对练。";
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n\n${envelope(summary)}\n`, true), { text: body, recordingSummary: summary });
	assert.deepEqual(parseRecordingSummaryResponse(body, true), { text: body });
	const unrequested = `${body}\n${envelope(summary)}`;
	assert.deepEqual(parseRecordingSummaryResponse(unrequested), { text: unrequested }, "其他调用保持原始响应");

	assert.equal(normalizeRecordingSummary(` \n${summary}\n `), summary);
	assert.equal(normalizeRecordingSummary("短录音主题"), "短录音主题");
	assert.equal(normalizeRecordingSummary("𠮷".repeat(150)), "𠮷".repeat(150), "按Unicode字符计数");
	assert.equal(normalizeRecordingSummary("𠮷".repeat(151)), undefined);
	const invalid = ["", " \n ", "一".repeat(151), "第一行\n第二行", "第一行\r第二行", "a\tb", "a\u0000b", "a\u007fb", "a\u2028b", "<b>摘要</b>", "[[其他笔记]]", "[外链](https://example.com)", "**加粗**", "`代码`", "__下划线__", "%%隐藏%%", "# 标题"];
	for (const value of invalid) {
		assert.equal(normalizeRecordingSummary(value), undefined, `应拒绝 ${JSON.stringify(value)}`);
		assert.deepEqual(parseRecordingSummaryResponse(`${body}\n\n${envelope(value)}`, true), { text: body }, "异常摘要仍保留分析正文");
	}
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n${envelope(summary)}\n${envelope("另一个摘要")}`, true), { text: body });
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n${RECORDING_SUMMARY_START}\n未闭合摘要`, true), { text: body });
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n${RECORDING_SUMMARY_END}`, true), { text: body });
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n${envelope(summary)}\n追加正文`, true), { text: `${body}\n\n追加正文` }, "不丢弃封套之后的正文");
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n${RECORDING_SUMMARY_END}\n${RECORDING_SUMMARY_START}摘要`, true), { text: body });

	const technicalInput = {
		templateId: "work-minutes",
		templateName: "工作纪要",
		generatedAt: "2026-11-05T03:00:00Z",
		result: { text: body, provider: "test", model: "mock", recordingSummary: summary },
		copyLanguage: "zh" as const
	};
	const technical = renderTranscriptTechnicalInfo(technicalInput);
	assert.ok(technical.includes(`- [echo_notes_recording_summary:: ${summary}]`));
	const transcript = `人工说明\n\n${body}\n`;
	const first = insertOrReplaceTranscriptTechnicalItem(transcript, technical, "work-minutes", "zh");
	assert.equal(readTranscriptRecordingSummary(first, "work-minutes"), summary);
	assert.equal(readTranscriptRecordingSummary(first, "study-notes"), undefined);
	assert.ok(first.includes(transcript.trimEnd()), "保留原始正文与人工说明");
	const studySummary = "围绕语言学习复习词汇，并记录需要继续练习的发音。";
	const other = renderTranscriptTechnicalInfo({ ...technicalInput, templateId: "study-notes", result: { ...technicalInput.result, recordingSummary: studySummary } });
	const multi = insertOrReplaceTranscriptTechnicalItem(first, other, "study-notes", "zh");
	assert.equal(readTranscriptRecordingSummary(multi, "work-minutes"), summary);
	assert.equal(readTranscriptRecordingSummary(multi, "study-notes"), studySummary);
	const changed = "项目团队围绕上线前的数据核对进行讨论，梳理当前差异与需要确认的处理方式。";
	const updated = insertOrReplaceTranscriptTechnicalItem(multi, renderTranscriptTechnicalInfo({ ...technicalInput, result: { ...technicalInput.result, recordingSummary: changed } }), "work-minutes", "zh");
	assert.equal(readTranscriptRecordingSummary(updated, "work-minutes"), changed);
	assert.equal(readTranscriptRecordingSummary(updated, "study-notes"), studySummary);
	assert.equal(updated.split("[echo_notes_recording_summary::").length - 1, 2, "每模板只保留一个摘要");
	assert.equal(readTranscriptRecordingSummary(updated.replace("<!-- echo-notes-technical-item:end work-minutes -->", ""), "work-minutes"), undefined);
	assert.equal(readTranscriptRecordingSummary(first.replace(`- [echo_notes_recording_summary:: ${summary}]`, `- [echo_notes_recording_summary:: ${summary}]\n- [echo_notes_recording_summary:: ${summary}]`), "work-minutes"), undefined);
	assert.ok(!renderTranscriptTechnicalInfo({ ...technicalInput, result: { ...technicalInput.result, recordingSummary: "[[unsafe]]" } }).includes("echo_notes_recording_summary"));
	assert.ok(!renderTranscriptTechnicalInfo({ ...technicalInput, result: { ...technicalInput.result, recordingSummary: undefined } }).includes("echo_notes_recording_summary"));
	assert.equal(readTranscriptRecordingSummary("旧版没有技术区", "work-minutes"), undefined);
	assert.equal(readTranscriptRecordingSummary(`${first}\n${first}`, "work-minutes"), undefined);
	assert.equal(readTranscriptRecordingSummary(updated.replace(/\n/g, "\r\n"), "work-minutes"), changed);
}

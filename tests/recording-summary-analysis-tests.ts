import { readRecordingSummaryWriteback, writeRecordingSummaryWriteback } from "../src/transcript/recording-summary-writeback";
import { markTranscriptAnalysisPending, markTranscriptAnalysisDone } from "../src/transcript/transcript-analysis-metadata";
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
	RECORDING_SUMMARY_MAX_CHARACTERS,
	RECORDING_SUMMARY_MIN_CHARACTERS,
	RECORDING_SUMMARY_START,
	normalizeRecordingSummary,
	parseRecordingSummaryResponse
} from "../src/analysis/recording-summary";

const envelope = (summary: string): string => `${RECORDING_SUMMARY_START}\n${summary}\n${RECORDING_SUMMARY_END}`;

export function runRecordingSummaryAnalysisTests(): void {
	const durableSummary = "新悦新员工销售话术与沟通语气培训";
	assert.equal(normalizeRecordingSummary(`｜AI 总结：${durableSummary}`), undefined, "模型返回保留标签时不能生成重复标签并阻断后续更新");
	for (const ending of ["\n", "\r\n"]) {
		const transcript = ["---", "type: audio-transcript", "custom: keep", "---", "合成转写正文", ""].join(ending);
		const snapshot = writeRecordingSummaryWriteback(transcript, [durableSummary]);
		assert.ok(snapshot);
		const metadata = { templateId: "work-minutes", provider: "mock", model: "fixture", timestamp: "2026-11-05T00:00:00Z" };
		const afterAnalysis = markTranscriptAnalysisDone(markTranscriptAnalysisPending(snapshot, metadata), metadata);
		assert.deepEqual(readRecordingSummaryWriteback(afterAnalysis), [durableSummary], "正常分析更新必须保留写回快照");
		assert.equal(afterAnalysis.split(ending + "---").length - 1, 1, "分析更新只保留一段frontmatter");
		assert.ok(afterAnalysis.includes("custom: keep" + ending));
		assert.ok(afterAnalysis.endsWith("合成转写正文" + ending));
		if (ending === "\r\n") assert.equal(afterAnalysis.replace(/\r\n/g, "").includes("\n"), false);
	}

	const input: AnalysisInput = {
		template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"],
		transcriptTitle: "Synthetic meeting.transcript",
		transcriptText: "为准备新人上岗，本次培训通过模拟客户问答练习销售沟通。",
		copyLanguage: "zh",
		includeRecordingSummary: true
	};
	const prompt = buildAnalysisMessages(input);
	assert.match(prompt.system, /不打开转写稿.*是做什么的/);
	assert.match(prompt.system, /具体事项和会议主题或用途/);
	assert.match(prompt.system, /培训、核对、评审.*须有转写依据/);
	assert.match(prompt.system, /不铺陈过程.*不强求结论或行动项/);
	assert.match(prompt.system, /不猜测意图.*不为凑字编造/);
	assert.match(prompt.system, /严格15–30字.*Unicode字符计数/);
	assert.match(prompt.system, /已有信息无法支持规定长度.*摘要留空/);
	assert.doesNotMatch(prompt.system, /50–100字|150个Unicode字符/);
	assert.ok(prompt.system.includes(RECORDING_SUMMARY_START));
	assert.ok(prompt.system.includes(RECORDING_SUMMARY_END));
	assert.ok(prompt.user.includes(input.template.customPrompt.trim()), "保留原模板要求");
	assert.ok(prompt.user.includes(input.transcriptText), "保持原转写输入");
	assert.ok(!buildAnalysisMessages({ ...input, includeRecordingSummary: undefined }).system.includes(RECORDING_SUMMARY_START));
	assert.match(buildAnalysisMessages({ ...input, copyLanguage: "en" }).system, /what this meeting or recording is for/);
	assert.match(buildAnalysisMessages({ ...input, copyLanguage: "en" }).system, /15–30 Unicode characters/);

	const chunk = createChunkAnalysisInput(input, 1, 2);
	assert.equal(chunk.includeRecordingSummary, false);
	assert.ok(!buildAnalysisMessages(chunk).system.includes(RECORDING_SUMMARY_START));
	const synthesis = createSynthesisAnalysisInput(input, [{ text: "新人进行模拟问答训练。", provider: "test", model: "mock" }]);
	assert.equal(synthesis.includeRecordingSummary, true);
	assert.ok(buildAnalysisMessages(synthesis).system.includes(RECORDING_SUMMARY_START));
	assert.equal(createSynthesisAnalysisInput({ ...input, includeRecordingSummary: undefined }, []).includeRecordingSummary, undefined);

	const summary = "新悦新员工销售话术与表达语气对练";
	const body = "## 培训内容\n\n练习客户问答。\n\n## 后续\n\n安排下一次对练。";
	assert.deepEqual(parseRecordingSummaryResponse(`${body}\n\n${envelope(summary)}\n`, true), { text: body, recordingSummary: summary });
	assert.deepEqual(parseRecordingSummaryResponse(body, true), { text: body });
	const unrequested = `${body}\n${envelope(summary)}`;
	assert.deepEqual(parseRecordingSummaryResponse(unrequested), { text: unrequested }, "其他调用保持原始响应");

	assert.equal(normalizeRecordingSummary(` \n${summary}\n `), summary);
	assert.equal(RECORDING_SUMMARY_MIN_CHARACTERS, 15);
	assert.equal(RECORDING_SUMMARY_MAX_CHARACTERS, 30);
	assert.equal(normalizeRecordingSummary("一".repeat(14)), undefined);
	assert.equal(normalizeRecordingSummary("一".repeat(15)), "一".repeat(15));
	assert.equal(normalizeRecordingSummary("一".repeat(30)), "一".repeat(30));
	assert.equal(normalizeRecordingSummary("一".repeat(31)), undefined);
	assert.equal(normalizeRecordingSummary("𠮷".repeat(15)), "𠮷".repeat(15), "补充平面文字按Unicode字符计数");
	assert.equal(normalizeRecordingSummary("😀".repeat(30)), "😀".repeat(30), "emoji按Unicode字符计数");
	assert.equal(normalizeRecordingSummary("😀".repeat(14)), undefined);
	assert.equal(normalizeRecordingSummary("😀".repeat(31)), undefined);
	const withControl = (control: string) => `${summary.slice(0, 8)}${control}${summary.slice(8)}`;
	const invalid = [
		"", " \n ", "短录音主题", "一".repeat(14), "一".repeat(31),
		...["\n", "\r", "\t", "\u0000", "\u007f", "\u2028", "\u2029"].map(withControl),
		`<b>${summary}</b>`, `[[${summary}]]`, "[培训](https://a.b)",
		`**${summary}**`, `\`${summary}\``, `__${summary}__`, `%%${summary}%%`, `# ${summary}`
	];
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
	const studySummary = "英语学习复盘与发音重点练习安排讨论";
	const other = renderTranscriptTechnicalInfo({ ...technicalInput, templateId: "study-notes", result: { ...technicalInput.result, recordingSummary: studySummary } });
	const multi = insertOrReplaceTranscriptTechnicalItem(first, other, "study-notes", "zh");
	assert.equal(readTranscriptRecordingSummary(multi, "work-minutes"), summary);
	assert.equal(readTranscriptRecordingSummary(multi, "study-notes"), studySummary);
	const changed = "项目上线前业务数据差异核对与处理讨论";
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

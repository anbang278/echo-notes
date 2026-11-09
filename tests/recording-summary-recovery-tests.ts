import assert from "node:assert/strict";
import { AnalysisError, type AnalysisInput, type AnalysisProvider } from "../src/analysis/analysis-provider";
import { recoverRecordingSummary } from "../src/analysis/recording-summary-recovery";
import {
	insertOrReplaceTranscriptTechnicalItem,
	readTranscriptTechnicalItem,
	readTranscriptRecordingSummary,
	renderTranscriptTechnicalInfo,
	updateTranscriptRecordingSummary
} from "../src/analysis/analysis-technical";
import { DEFAULT_ANALYSIS_TEMPLATES } from "../src/settings/settings";

export async function runRecordingSummaryRecoveryTests(): Promise<void> {
	const summary = "团队核对项目实施进度并确认接口联调安排";
	const input: AnalysisInput = {
		template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"], copyLanguage: "zh",
		transcriptTitle: "合成会议", transcriptText: "原始转写不应重复外发", includeRecordingSummary: true
	};
	let calls = 0;
	let captured: AnalysisInput | undefined;
	const provider: AnalysisProvider = {
		id: "mock", name: "Mock",
		analyze: async (value) => {
			calls++;
			captured = value;
			return { text: summary, provider: "mock", model: "mock", traceId: "synthetic-summary" };
		}
	};
	const body = "纪要正文。\n\n".repeat(40);
	const recovered = await recoverRecordingSummary(provider, input, body, 80, () => true);
	assert.equal(recovered.summary, summary);
	assert.equal(recovered.traceId, "synthetic-summary");
	assert.equal(calls, 1);
	assert.equal(captured?.includeRecordingSummary, false, "补生成不能递归请求封套摘要");
	assert.ok(captured!.transcriptText.length <= 80);
	assert.equal(captured?.transcriptText.includes(input.transcriptText), false);
	assert.equal(captured?.template.customPrompt.includes(input.template.customPrompt), false);

	const skipped = await recoverRecordingSummary(provider, input, body, 80, () => false);
	assert.equal(skipped.reason, "stale-analysis");
	assert.equal(calls, 1, "过期任务不能外发请求");
	for (const text of ["过短", "一".repeat(31), "**团队核对项目实施进度并确认接口联调安排**"]) {
		let attempts = 0;
		const invalid = await recoverRecordingSummary({ ...provider, analyze: async () => {
			attempts++;
			return { text, provider: "mock", model: "mock" };
		} }, input, body, 80, () => true);
		assert.equal(invalid.summary, undefined);
		assert.equal(attempts, 1, "无效补生成不能继续重试");
	}
	const failed = await recoverRecordingSummary({ ...provider, analyze: async () => {
		throw new AnalysisError("timeout", "合成敏感原始响应");
	} }, input, body, 80, () => true);
	assert.deepEqual(failed, { reason: "request-failed", errorCode: "timeout" });
	let current = true;
	const late = await recoverRecordingSummary({ ...provider, analyze: async () => {
		current = false;
		return { text: summary, provider: "mock", model: "mock" };
	} }, input, body, 80, () => current);
	assert.equal(late.reason, "stale-analysis");
	assert.equal(late.summary, undefined);

	for (const ending of ["\n", "\r\n"]) {
		const technical = renderTranscriptTechnicalInfo({ templateId: "work-minutes", templateName: "纪要",
			generatedAt: "2026-11-09T10:00:00Z", result: { text: "完整纪要", provider: "mock", model: "mock" }, copyLanguage: "zh" });
		const document = insertOrReplaceTranscriptTechnicalItem("手写内容\n完整纪要正文\n", technical, "work-minutes", "zh").replace(/\n/g, ending);
		const snapshot = readTranscriptTechnicalItem(document, "work-minutes")!;
		const withManualEdits = document.replace("完整纪要正文", "完整纪要正文和等待期间的人工补充");
		const updated = updateTranscriptRecordingSummary(withManualEdits, "work-minutes", summary, snapshot)!;
		assert.ok(updated.includes("完整纪要正文和等待期间的人工补充"));
		assert.equal(readTranscriptRecordingSummary(updated, "work-minutes"), summary);
		assert.equal(updated.replace(new RegExp(`- \\[echo_notes_recording_summary:: ${summary}\\]${ending}`), ""), withManualEdits);
		assert.equal(updateTranscriptRecordingSummary(document.replace("mock", "new-provider"), "work-minutes", summary, snapshot), undefined,
			"技术记录变化后不能认领旧结果");
		assert.equal(updateTranscriptRecordingSummary(document + document, "work-minutes", summary, snapshot), undefined);
	}
}

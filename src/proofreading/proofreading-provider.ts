import type { AnalysisProvider } from "../analysis/analysis-provider";
import type { AnalysisTemplateConfig, CopyLanguage } from "../settings/settings";
import { buildProofreadingIssues, type ProofreadingIssue } from "./proofreading";

const PROOFREADING_TEMPLATE: AnalysisTemplateConfig = {
	id: "echo-notes-proofreading-v1", name: "独立转写校对", version: "1", category: "general", enabled: true, builtin: false,
	description: "仅做受约束的双稿差异定位。",
	systemPrompt: "你是转写校对器。只定位两份原稿中可核验的局部差异；金额、日期、编号、否定、身份和责任一律标记高风险。禁止润色、补写、合并句子或把建议当事实。输出 JSON 数组，每项含 primary、auxiliary、reason、risk(low|high)。",
	customPrompt: "", recognitionKeywords: []
};

export async function requestIndependentProofreading(input: {
	provider: AnalysisProvider; primary: string; auxiliary: string; copyLanguage: CopyLanguage;
}): Promise<ProofreadingIssue[]> {
	const fallback = buildProofreadingIssues(input.primary, input.auxiliary);
	const result = await input.provider.analyze({ template: PROOFREADING_TEMPLATE, transcriptTitle: "双模型转写校对", transcriptText: JSON.stringify({ primary: input.primary, auxiliary: input.auxiliary }), copyLanguage: input.copyLanguage });
	try {
		const value = JSON.parse(extractJson(result.text)) as unknown;
		if (!Array.isArray(value)) return fallback;
		const issues = value.flatMap((item, index) => {
			if (!item || typeof item !== "object") return [];
			const record = item as Record<string, unknown>;
			const primary = typeof record.primary === "string" ? record.primary : "";
			const auxiliary = typeof record.auxiliary === "string" ? record.auxiliary : "";
			if (!primary || !input.primary.includes(primary) || (auxiliary && !input.auxiliary.includes(auxiliary))) return [];
			return [{ id: `C${String(index + 1).padStart(2, "0")}`, primary, auxiliary, reason: typeof record.reason === "string" ? record.reason.slice(0, 300) : "两路转写存在差异，需要人工确认。", risk: record.risk === "low" ? "low" : "high" } satisfies ProofreadingIssue];
		});
		return issues.length > 0 ? issues : fallback;
	} catch { return fallback; }
}

function extractJson(value: string): string { const match = /```(?:json)?\s*([\s\S]*?)```/i.exec(value); return (match?.[1] ?? value).trim(); }

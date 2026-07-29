import type { AnalysisInput, AnalysisResult } from "./analysis-provider";

export function createChunkAnalysisInput(
	input: AnalysisInput,
	chunkIndex: number,
	totalChunks: number
): AnalysisInput {
	return {
		...input,
		template: {
			...input.template,
			customPrompt: [
				input.template.customPrompt.trim(),
				"",
				`阶段任务：这是长转写稿的第 ${chunkIndex}/${totalChunks} 个分块。`,
				"只提取本分块中与模板字段相关的事实、决策、建议、行动项、风险、待确认问题和重要原话，并尽量保留说话人或时间信息。",
				"本阶段不要生成最终总览，不要假设其他分块内容，也不要把缺失信息补写为事实。"
			].join("\n")
		}
	};
}

export function createSynthesisAnalysisInput(
	input: AnalysisInput,
	chunkResults: AnalysisResult[]
): AnalysisInput {
	const chunkText = chunkResults
		.map((result, index) => `## 分块 ${index + 1}\n\n${result.text.slice(0, 12000)}`)
		.join("\n\n");

	return {
		...input,
		template: {
			...input.template,
			customPrompt: [
				input.template.customPrompt.trim(),
				"",
				"阶段任务：以下转写数据是同一份长转写稿各分块的结构化提取结果。",
				"按原模板生成完整最终纪要；去重重复结论与行动项，合并同一事项，保留跨分块冲突、证据不足和待确认信息。",
				"不要提及分块、提取或汇总过程。"
			].join("\n")
		},
		transcriptText: chunkText
	};
}

import type { AnalysisTextChunk } from "../analysis/analysis-chunking";
import type { MemoryExtractionChunkResult } from "./memory-checkpoint";

export interface MemoryExtractionChunkSequenceInput {
	chunks: readonly AnalysisTextChunk[];
	resumeResults?: readonly MemoryExtractionChunkResult[];
	extractChunk: (chunk: AnalysisTextChunk) => Promise<MemoryExtractionChunkResult>;
	prepareResult?: (
		result: MemoryExtractionChunkResult,
		chunk: AnalysisTextChunk
	) => MemoryExtractionChunkResult;
	onChunkStart?: (chunk: AnalysisTextChunk, completedCount: number) => Promise<void> | void;
	onChunkComplete?: (
		chunk: AnalysisTextChunk,
		results: readonly MemoryExtractionChunkResult[]
	) => Promise<void> | void;
}

export async function extractMemoryChunkSequence(
	input: MemoryExtractionChunkSequenceInput
): Promise<MemoryExtractionChunkResult[]> {
	if (input.chunks.length === 0) {
		throw new Error("记忆提取分块序列不能为空。");
	}
	const resumeResults = input.resumeResults ?? [];
	if (resumeResults.length > input.chunks.length) {
		throw new Error("可恢复记忆提取分块数量超过当前分块总数。");
	}
	const results = resumeResults.map((result, index) => {
		const cloned = {
			...result,
			assertions: result.assertions.map((assertion) => ({ ...assertion }))
		};
		return input.prepareResult?.(cloned, input.chunks[index]) ?? cloned;
	});
	for (const chunk of input.chunks.slice(results.length)) {
		await input.onChunkStart?.(chunk, results.length);
		const extracted = await input.extractChunk(chunk);
		const result = input.prepareResult?.(extracted, chunk) ?? extracted;
		results.push(result);
		await input.onChunkComplete?.(chunk, results);
	}
	if (results.length !== input.chunks.length) {
		throw new Error("记忆提取分块结果不完整。");
	}
	return results;
}

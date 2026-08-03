import type { AnalysisInput, AnalysisResult } from "./analysis-provider";
import { AnalysisError } from "./analysis-provider";
import { splitAnalysisText, type AnalysisTextChunk } from "./analysis-chunking";

export interface AnalysisChunkedInput extends AnalysisInput {
	maxCharacters: number;
	overlapCharacters?: number;
	summarizeChunk: (input: AnalysisInput & { chunk: AnalysisTextChunk }) => Promise<AnalysisResult>;
	summarizeFinal: (input: AnalysisInput & { chunks: AnalysisResult[] }) => Promise<AnalysisResult>;
}

export interface AnalysisChunkSequenceInput {
	analysisInput: AnalysisInput;
	chunks: readonly AnalysisTextChunk[];
	resumeResults?: readonly AnalysisResult[];
	analyzeChunk: (input: AnalysisInput, chunk: AnalysisTextChunk) => Promise<AnalysisResult>;
	prepareResult?: (result: AnalysisResult, chunk: AnalysisTextChunk) => AnalysisResult;
	synthesize: (input: AnalysisInput, results: AnalysisResult[]) => Promise<AnalysisResult>;
	onChunkStart?: (chunk: AnalysisTextChunk, completedCount: number) => Promise<void> | void;
	onChunkComplete?: (
		chunk: AnalysisTextChunk,
		results: readonly AnalysisResult[]
	) => Promise<void> | void;
	onSynthesisStart?: (results: readonly AnalysisResult[]) => Promise<void> | void;
}

export function shouldChunkAnalysisText(text: string, maxCharacters: number): boolean {
	return text.trim().length > maxCharacters;
}

export async function analyzeLongText(input: AnalysisChunkedInput): Promise<AnalysisResult> {
	const chunks = splitAnalysisText(input.transcriptText, {
		maxCharacters: input.maxCharacters,
		overlapCharacters: input.overlapCharacters
	});
	if (chunks.length <= 1) {
		return input.summarizeFinal({ ...input, chunks: [] });
	}

	const chunkResults: AnalysisResult[] = [];
	for (const chunk of chunks) {
		chunkResults.push(await input.summarizeChunk({ ...input, chunk, transcriptText: chunk.text }));
	}
	if (chunkResults.length === 0) {
		throw new AnalysisError("invalid_response", "长文本分块后没有可分析内容。");
	}
	return input.summarizeFinal({ ...input, chunks: chunkResults });
}

export async function analyzeChunkSequence(input: AnalysisChunkSequenceInput): Promise<AnalysisResult> {
	if (input.chunks.length <= 1) {
		throw new AnalysisError("invalid_response", "分析分块序列至少需要两个分块。");
	}
	const resumeResults = input.resumeResults ?? [];
	if (resumeResults.length > input.chunks.length) {
		throw new AnalysisError("invalid_response", "可恢复分析分块数量超过当前分块总数。");
	}
	const results = resumeResults.map((result, index) =>
		input.prepareResult?.(result, input.chunks[index]) ?? result
	);

	for (const chunk of input.chunks.slice(results.length)) {
		await input.onChunkStart?.(chunk, results.length);
		const analyzed = await input.analyzeChunk(
			{ ...input.analysisInput, transcriptText: chunk.text },
			chunk
		);
		const result = input.prepareResult?.(analyzed, chunk) ?? analyzed;
		results.push(result);
		await input.onChunkComplete?.(chunk, results);
	}
	if (results.length !== input.chunks.length) {
		throw new AnalysisError("invalid_response", "长文本分析分块结果不完整。");
	}
	await input.onSynthesisStart?.(results);
	return input.synthesize(input.analysisInput, results);
}

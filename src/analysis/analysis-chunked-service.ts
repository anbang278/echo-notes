import type { AnalysisInput, AnalysisResult } from "./analysis-provider";
import { AnalysisError } from "./analysis-provider";
import { splitAnalysisText, type AnalysisTextChunk } from "./analysis-chunking";

export interface AnalysisChunkedInput extends AnalysisInput {
	maxCharacters: number;
	overlapCharacters?: number;
	summarizeChunk: (input: AnalysisInput & { chunk: AnalysisTextChunk }) => Promise<AnalysisResult>;
	summarizeFinal: (input: AnalysisInput & { chunks: AnalysisResult[] }) => Promise<AnalysisResult>;
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

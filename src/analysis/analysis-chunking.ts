export interface AnalysisTextChunk {
	index: number;
	total: number;
	start: number;
	end: number;
	text: string;
}

export interface AnalysisChunkOptions {
	maxCharacters: number;
	overlapCharacters?: number;
}

export function estimateAnalysisTextTokens(text: string): number {
	return Math.ceil(text.length / 2);
}

export function splitAnalysisText(text: string, options: AnalysisChunkOptions): AnalysisTextChunk[] {
	const maxCharacters = Math.max(1, Math.floor(options.maxCharacters));
	const overlapCharacters = Math.min(Math.max(0, Math.floor(options.overlapCharacters ?? 0)), maxCharacters - 1);
	const normalized = text.trim();
	if (!normalized) {
		return [];
	}

	const chunks: Array<Omit<AnalysisTextChunk, "index" | "total">> = [];
	let start = 0;
	while (start < normalized.length) {
		const preferredEnd = Math.min(normalized.length, start + maxCharacters);
		const end = findNaturalBreak(normalized, start, preferredEnd);
		chunks.push({ start, end, text: normalized.slice(start, end).trim() });
		if (end >= normalized.length) {
			break;
		}
		start = Math.max(end - overlapCharacters, start + 1);
	}

	return chunks.map((chunk, index) => ({ ...chunk, index: index + 1, total: chunks.length }));
}

function findNaturalBreak(text: string, start: number, preferredEnd: number): number {
	if (preferredEnd >= text.length) {
		return text.length;
	}
	const windowStart = Math.max(start + 1, preferredEnd - 80);
	const candidate = Math.max(
		text.lastIndexOf("\n\n", preferredEnd),
		text.lastIndexOf("。", preferredEnd),
		text.lastIndexOf("！", preferredEnd),
		text.lastIndexOf("？", preferredEnd),
		text.lastIndexOf(".", preferredEnd)
	);
	return candidate >= windowStart ? candidate + 1 : preferredEnd;
}

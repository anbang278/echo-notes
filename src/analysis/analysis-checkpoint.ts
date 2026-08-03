import type { AnalysisResult } from "./analysis-provider";
import type { AnalysisTextChunk } from "./analysis-chunking";
import type { AnalysisTemplateConfig, EchoNotesSettings } from "../settings/settings";
import { TRANSCRIPT_MANAGED_START } from "../transcript/transcript-content";

export const ANALYSIS_CHECKPOINT_SCHEMA_VERSION = 1;
export const ANALYSIS_CHUNKING_VERSION = 1;
export const ANALYSIS_PROMPT_PIPELINE_VERSION = 1;
export const ANALYSIS_REQUEST_CONFIGURATION_VERSION = 1;
export const ANALYSIS_CHECKPOINT_RESULT_MAX_CHARACTERS = 12_000;
export const ANALYSIS_CHECKPOINT_MAX_CHUNKS = 20;
export const ANALYSIS_CHECKPOINT_START_PREFIX = "%% echo-notes-analysis-checkpoint:start ";
export const ANALYSIS_CHECKPOINT_END_PREFIX = "echo-notes-analysis-checkpoint:end ";

const MAX_TRACE_ID_CHARACTERS = 2_048;

export interface AnalysisCheckpointIdentity {
	transcriptPath: string;
	inputFingerprint: string;
	templateId: string;
	provider: string;
	model: string;
	configurationFingerprint: string;
}

export interface CompletedAnalysisChunk {
	index: number;
	total: number;
	start: number;
	end: number;
	textFingerprint: string;
	result: AnalysisResult;
}

export interface AnalysisCheckpoint extends AnalysisCheckpointIdentity {
	schemaVersion: number;
	chunkingVersion: number;
	updatedAt: string;
	completedChunks: CompletedAnalysisChunk[];
}

export function createAnalysisCheckpointIdentity(input: {
	transcriptPath: string;
	analysisText: string;
	template: AnalysisTemplateConfig;
	settings: EchoNotesSettings;
	overlapCharacters: number;
}): AnalysisCheckpointIdentity {
	const { settings, template } = input;
	return {
		transcriptPath: input.transcriptPath,
		inputFingerprint: createStableFingerprint(input.analysisText),
		templateId: template.id,
		provider: settings.analysisProvider,
		model: settings.analysisModel,
		configurationFingerprint: createStableFingerprint(JSON.stringify({
			chunkingVersion: ANALYSIS_CHUNKING_VERSION,
			promptPipelineVersion: ANALYSIS_PROMPT_PIPELINE_VERSION,
			requestConfigurationVersion: ANALYSIS_REQUEST_CONFIGURATION_VERSION,
			provider: settings.analysisProvider,
			baseUrl: settings.analysisBaseUrl.trim().replace(/\/+$/, ""),
			model: settings.analysisModel.trim(),
			copyLanguage: settings.copyLanguage,
			redactTranscriptBeforeAnalysis: settings.redactTranscriptBeforeAnalysis,
			analysisLongTextEnabled: settings.analysisLongTextEnabled,
			analysisChunkCharacters: settings.analysisChunkCharacters,
			overlapCharacters: input.overlapCharacters,
			template: {
				id: template.id,
				name: template.name,
				version: template.version,
				systemPrompt: template.systemPrompt,
				customPrompt: template.customPrompt
			}
		}))
	};
}

export function createAnalysisCheckpoint(
	identity: AnalysisCheckpointIdentity,
	chunks: readonly AnalysisTextChunk[],
	results: readonly AnalysisResult[],
	updatedAt = new Date().toISOString()
): AnalysisCheckpoint {
	if (results.length > chunks.length || results.length > ANALYSIS_CHECKPOINT_MAX_CHUNKS) {
		throw new Error("分析检查点的已完成分块数量无效。");
	}
	return {
		schemaVersion: ANALYSIS_CHECKPOINT_SCHEMA_VERSION,
		chunkingVersion: ANALYSIS_CHUNKING_VERSION,
		...identity,
		updatedAt,
		completedChunks: results.map((result, index) => {
			const chunk = chunks[index];
			return {
				index: chunk.index,
				total: chunk.total,
					start: chunk.start,
					end: chunk.end,
					textFingerprint: createStableFingerprint(chunk.text),
					result: prepareAnalysisCheckpointResult(result)
			};
		})
	};
}

export function readResumableAnalysisResults(
	content: string,
	expectedIdentity: AnalysisCheckpointIdentity,
	expectedChunks: readonly AnalysisTextChunk[]
): AnalysisResult[] {
	const checkpoint = parseAnalysisCheckpoint(content, expectedIdentity.templateId);
	if (!checkpoint || !matchesIdentity(checkpoint, expectedIdentity)) {
		return [];
	}
	if (
		checkpoint.completedChunks.length > expectedChunks.length ||
		checkpoint.completedChunks.length > ANALYSIS_CHECKPOINT_MAX_CHUNKS
	) {
		return [];
	}
	for (let index = 0; index < checkpoint.completedChunks.length; index += 1) {
		const completed = checkpoint.completedChunks[index];
		const expected = expectedChunks[index];
		if (
			completed.index !== index + 1 ||
			completed.total !== expectedChunks.length ||
			completed.index !== expected.index ||
			completed.total !== expected.total ||
			completed.start !== expected.start ||
			completed.end !== expected.end ||
			completed.textFingerprint !== createStableFingerprint(expected.text) ||
			completed.result.provider !== expectedIdentity.provider ||
			completed.result.model !== expectedIdentity.model
		) {
			return [];
		}
	}
	return checkpoint.completedChunks.map((chunk) => ({ ...chunk.result }));
}

export function renderAnalysisCheckpoint(checkpoint: AnalysisCheckpoint): string {
	const key = encodeCheckpointKey(checkpoint.templateId);
	const json = JSON.stringify(checkpoint, null, 2).replace(/%%/g, "%\\u0025");
	return [
		`${ANALYSIS_CHECKPOINT_START_PREFIX}${key}`,
		json,
		`${ANALYSIS_CHECKPOINT_END_PREFIX}${key} %%`
	].join("\n");
}

export function upsertAnalysisCheckpoint(content: string, checkpoint: AnalysisCheckpoint): string {
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	const block = renderAnalysisCheckpoint(checkpoint).replace(/\n/g, lineEnding);
	const range = findCheckpointRange(content, checkpoint.templateId);
	if (range) {
		return `${content.slice(0, range.start)}${block}${lineEnding}${content.slice(range.end)}`;
	}

	const insertionIndex = content.indexOf(TRANSCRIPT_MANAGED_START);
	if (insertionIndex === -1) {
		const fallbackIndex = findFallbackInsertionIndex(content);
		return `${content.slice(0, fallbackIndex)}${block}${lineEnding}${content.slice(fallbackIndex)}`;
	}
	const before = content.slice(0, insertionIndex);
	const after = content.slice(insertionIndex);
	return `${before}${getLineSeparatorAfter(before, lineEnding)}${block}${lineEnding}${after}`;
}

export function removeAnalysisCheckpoint(content: string, templateId: string): string {
	const range = findCheckpointRange(content, templateId);
	if (!range) {
		return content;
	}
	return `${content.slice(0, range.start)}${content.slice(range.end)}`;
}

export function removeAllAnalysisCheckpoints(content: string): string {
	return content.replace(
		/%% echo-notes-analysis-checkpoint:start [^\r\n]+\r?\n[\s\S]*?\r?\necho-notes-analysis-checkpoint:end [^\r\n]+ %%\r?\n?/g,
		""
	);
}

export function parseAnalysisCheckpoint(content: string, templateId: string): AnalysisCheckpoint | null {
	const range = findCheckpointRange(content, templateId);
	if (!range) {
		return null;
	}
	const key = encodeCheckpointKey(templateId);
	const startMarker = `${ANALYSIS_CHECKPOINT_START_PREFIX}${key}`;
	const endMarker = `${ANALYSIS_CHECKPOINT_END_PREFIX}${key} %%`;
	const storedBlock = content.slice(range.start, range.end);
	const endMarkerIndex = storedBlock.indexOf(endMarker, startMarker.length);
	if (endMarkerIndex === -1) {
		return null;
	}
	const json = storedBlock.slice(startMarker.length, endMarkerIndex).trim();
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	return parseCheckpoint(value);
}

function findCheckpointRange(content: string, templateId: string): { start: number; end: number } | null {
	const key = encodeCheckpointKey(templateId);
	const startMarker = `${ANALYSIS_CHECKPOINT_START_PREFIX}${key}`;
	const endMarker = `${ANALYSIS_CHECKPOINT_END_PREFIX}${key} %%`;
	const start = content.indexOf(startMarker);
	if (start === -1) {
		return null;
	}
	const endMarkerIndex = content.indexOf(endMarker, start + startMarker.length);
	if (endMarkerIndex === -1) {
		return null;
	}
	let end = endMarkerIndex + endMarker.length;
	if (content.slice(end, end + 2) === "\r\n") {
		end += 2;
	} else if (content[end] === "\n") {
		end += 1;
	}
	return { start, end };
}

function parseCheckpoint(value: unknown): AnalysisCheckpoint | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== ANALYSIS_CHECKPOINT_SCHEMA_VERSION ||
		value.chunkingVersion !== ANALYSIS_CHUNKING_VERSION ||
		typeof value.transcriptPath !== "string" || !value.transcriptPath ||
		typeof value.inputFingerprint !== "string" || !value.inputFingerprint ||
		typeof value.templateId !== "string" || !value.templateId ||
		typeof value.provider !== "string" || !value.provider ||
		typeof value.model !== "string" || !value.model ||
		typeof value.configurationFingerprint !== "string" || !value.configurationFingerprint ||
		typeof value.updatedAt !== "string" || !value.updatedAt ||
		!Array.isArray(value.completedChunks) ||
		value.completedChunks.length > ANALYSIS_CHECKPOINT_MAX_CHUNKS
	) {
		return null;
	}
	const completedChunks = value.completedChunks.map(parseCompletedChunk);
	if (completedChunks.some((chunk) => chunk === null)) {
		return null;
	}
	return {
		schemaVersion: ANALYSIS_CHECKPOINT_SCHEMA_VERSION,
		chunkingVersion: ANALYSIS_CHUNKING_VERSION,
		transcriptPath: value.transcriptPath,
		inputFingerprint: value.inputFingerprint,
		templateId: value.templateId,
		provider: value.provider,
		model: value.model,
		configurationFingerprint: value.configurationFingerprint,
		updatedAt: value.updatedAt,
		completedChunks: completedChunks as CompletedAnalysisChunk[]
	};
}

function parseCompletedChunk(value: unknown): CompletedAnalysisChunk | null {
	if (
		!isRecord(value) ||
		!isPositiveInteger(value.index) ||
		!isPositiveInteger(value.total) ||
		!isNonNegativeInteger(value.start) ||
		!isPositiveInteger(value.end) ||
		value.end <= value.start ||
		typeof value.textFingerprint !== "string" || !value.textFingerprint ||
		!isRecord(value.result) ||
		typeof value.result.text !== "string" || !value.result.text.trim() ||
		value.result.text.length > ANALYSIS_CHECKPOINT_RESULT_MAX_CHARACTERS ||
		typeof value.result.provider !== "string" || !value.result.provider ||
		typeof value.result.model !== "string" || !value.result.model ||
		(value.result.traceId !== undefined && (
			typeof value.result.traceId !== "string" || value.result.traceId.length > MAX_TRACE_ID_CHARACTERS
		))
	) {
		return null;
	}
	return {
		index: value.index,
		total: value.total,
		start: value.start,
		end: value.end,
		textFingerprint: value.textFingerprint,
		result: {
			text: value.result.text,
			provider: value.result.provider,
			model: value.result.model,
			traceId: typeof value.result.traceId === "string" ? value.result.traceId : undefined
		}
	};
}

function matchesIdentity(left: AnalysisCheckpointIdentity, right: AnalysisCheckpointIdentity): boolean {
	return left.transcriptPath === right.transcriptPath &&
		left.inputFingerprint === right.inputFingerprint &&
		left.templateId === right.templateId &&
		left.provider === right.provider &&
		left.model === right.model &&
		left.configurationFingerprint === right.configurationFingerprint;
}

export function prepareAnalysisCheckpointResult(result: AnalysisResult): AnalysisResult {
	const text = result.text.trim().slice(0, ANALYSIS_CHECKPOINT_RESULT_MAX_CHARACTERS);
	if (!text) {
		throw new Error("无法保存空的分析分块结果。");
	}
	const provider = result.provider.trim();
	const model = result.model.trim();
	if (!provider || !model) {
		throw new Error("无法保存缺少 Provider 或模型的分析分块结果。");
	}
	return {
		text,
		provider,
		model,
		traceId: result.traceId?.trim().slice(0, MAX_TRACE_ID_CHARACTERS) || undefined
	};
}

function encodeCheckpointKey(templateId: string): string {
	return encodeURIComponent(templateId.trim());
}

function getLineSeparatorAfter(content: string, lineEnding: string): string {
	if (!content) {
		return "";
	}
	return content.endsWith("\n") ? "" : lineEnding;
}

function findFallbackInsertionIndex(content: string): number {
	const frontmatter = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)/.exec(content);
	return frontmatter?.[0].length ?? 0;
}

function createStableFingerprint(value: string): string {
	return `${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9)}${value.length.toString(16).padStart(8, "0")}`;
}

function hash32(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

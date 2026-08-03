import type { AnalysisTextChunk } from "../analysis/analysis-chunking";
import type { EchoNotesSettings, CopyLanguage } from "../settings/settings";
import {
	MEMORY_CATEGORIES,
	MEMORY_SUBJECT_TYPES,
	type MemoryUserProfile,
	type RawMemoryAssertion
} from "./memory-types";
import { createStableFingerprint, parseMemoryExtractionResponse } from "./memory-output";

export const MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION = 1;
export const MEMORY_EXTRACTION_CHUNKING_VERSION = 1;
export const MEMORY_EXTRACTION_PIPELINE_VERSION = 1;
export const MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS = 20;
export const MEMORY_EXTRACTION_CHECKPOINT_MAX_ENTRIES = 100;
export const MEMORY_EXTRACTION_CHECKPOINT_RESULT_MAX_CHARACTERS = 24_000;
export const MEMORY_EXTRACTION_CHECKPOINT_STORE_MAX_CHARACTERS = 25_000_000;
export const MEMORY_EXTRACTION_CHECKPOINT_FILE_NAME = "echo-memory-checkpoints.json";

const MAX_TRACE_ID_CHARACTERS = 2_048;

export interface MemoryExtractionCheckpointIdentity {
	transcriptPath: string;
	inputFingerprint: string;
	sourceFingerprint: string;
	provider: string;
	model: string;
	configurationFingerprint: string;
}

export interface MemoryExtractionChunkResult {
	assertions: RawMemoryAssertion[];
	provider: string;
	model: string;
	rejectedAssertionCount?: number;
	traceId?: string;
}

export interface CompletedMemoryExtractionChunk {
	index: number;
	total: number;
	start: number;
	end: number;
	textFingerprint: string;
	result: MemoryExtractionChunkResult;
}

export interface MemoryExtractionCheckpoint extends MemoryExtractionCheckpointIdentity {
	schemaVersion: number;
	chunkingVersion: number;
	createdAt: string;
	updatedAt: string;
	completedChunks: CompletedMemoryExtractionChunk[];
}

export interface MemoryExtractionCheckpointStore {
	schemaVersion: number;
	updatedAt: string;
	checkpoints: Record<string, MemoryExtractionCheckpoint>;
}

export interface ResumableMemoryExtraction {
	createdAt: string;
	results: MemoryExtractionChunkResult[];
}

export function getMemoryExtractionCheckpointStorePath(systemDir: string): string {
	return `${systemDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${MEMORY_EXTRACTION_CHECKPOINT_FILE_NAME}`;
}

export function createMemoryExtractionCheckpointIdentity(input: {
	transcriptPath: string;
	sourceText: string;
	inputFingerprint: string;
	analysisTemplateIds: readonly string[];
	user: MemoryUserProfile;
	settings: Pick<
		EchoNotesSettings,
		| "memoryProvider"
		| "memoryBaseUrl"
		| "memoryModel"
		| "memoryLongTextEnabled"
		| "memoryChunkCharacters"
	> & { copyLanguage: CopyLanguage };
	overlapCharacters: number;
	promptVersion: number;
}): MemoryExtractionCheckpointIdentity {
	const provider = input.settings.memoryProvider.trim();
	const model = input.settings.memoryModel.trim();
	return {
		transcriptPath: input.transcriptPath,
		inputFingerprint: input.inputFingerprint,
		sourceFingerprint: createStableFingerprint(input.sourceText),
		provider,
		model,
		configurationFingerprint: createStableFingerprint(JSON.stringify({
			checkpointSchemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
			chunkingVersion: MEMORY_EXTRACTION_CHUNKING_VERSION,
			pipelineVersion: MEMORY_EXTRACTION_PIPELINE_VERSION,
			promptVersion: input.promptVersion,
			provider,
			baseUrl: input.settings.memoryBaseUrl.trim().replace(/\/+$/, ""),
			model,
			copyLanguage: input.settings.copyLanguage,
			memoryLongTextEnabled: input.settings.memoryLongTextEnabled,
			memoryChunkCharacters: input.settings.memoryChunkCharacters,
			overlapCharacters: input.overlapCharacters,
			analysisTemplateIds: [...input.analysisTemplateIds],
			user: input.user
		}))
	};
}

export function createMemoryExtractionCheckpoint(
	identity: MemoryExtractionCheckpointIdentity,
	chunks: readonly AnalysisTextChunk[],
	results: readonly MemoryExtractionChunkResult[],
	createdAt: string,
	updatedAt = new Date().toISOString()
): MemoryExtractionCheckpoint {
	if (
		results.length === 0 ||
		results.length > chunks.length ||
		results.length > MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS
	) {
		throw new Error("记忆提取检查点的已完成分块数量无效。");
	}
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		chunkingVersion: MEMORY_EXTRACTION_CHUNKING_VERSION,
		...identity,
		createdAt,
		updatedAt,
		completedChunks: results.map((result, index) => {
			const chunk = chunks[index];
			return {
				index: chunk.index,
				total: chunk.total,
				start: chunk.start,
				end: chunk.end,
				textFingerprint: createStableFingerprint(chunk.text),
				result: prepareMemoryExtractionCheckpointResult(result, chunk.text, identity)
			};
		})
	};
}

export function createMemoryExtractionCheckpointStore(
	updatedAt = new Date().toISOString()
): MemoryExtractionCheckpointStore {
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		updatedAt,
		checkpoints: {}
	};
}

export function renderMemoryExtractionCheckpointStore(store: MemoryExtractionCheckpointStore): string {
	const rendered = `${JSON.stringify(store, null, 2)}\n`;
	if (rendered.length > MEMORY_EXTRACTION_CHECKPOINT_STORE_MAX_CHARACTERS) {
		throw new Error("Echo Memory 检查点存储超过 25,000,000 字符上限，请先处理或移走旧检查点。");
	}
	return rendered;
}

export function parseMemoryExtractionCheckpointStore(content: string): MemoryExtractionCheckpointStore | null {
	if (!content.trim() || content.length > MEMORY_EXTRACTION_CHECKPOINT_STORE_MAX_CHARACTERS) {
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return null;
	}
	if (
		!isRecord(value) ||
		value.schemaVersion !== MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION ||
		typeof value.updatedAt !== "string" || !value.updatedAt ||
		!isRecord(value.checkpoints)
	) {
		return null;
	}
	const entries = Object.entries(value.checkpoints);
	if (entries.length > MEMORY_EXTRACTION_CHECKPOINT_MAX_ENTRIES) {
		return null;
	}
	const checkpoints: Array<[string, MemoryExtractionCheckpoint]> = [];
	for (const [transcriptPath, rawCheckpoint] of entries) {
		const checkpoint = parseMemoryExtractionCheckpoint(rawCheckpoint);
		if (!checkpoint || checkpoint.transcriptPath !== transcriptPath) {
			return null;
		}
		checkpoints.push([transcriptPath, checkpoint]);
	}
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		updatedAt: value.updatedAt,
		checkpoints: Object.fromEntries(checkpoints)
	};
}

export function assertMemoryExtractionCheckpointCapacity(
	store: MemoryExtractionCheckpointStore,
	transcriptPath: string
): void {
	if (
		!Object.prototype.hasOwnProperty.call(store.checkpoints, transcriptPath) &&
		Object.keys(store.checkpoints).length >= MEMORY_EXTRACTION_CHECKPOINT_MAX_ENTRIES
	) {
		throw new Error(
			`Echo Memory 已保留 ${MEMORY_EXTRACTION_CHECKPOINT_MAX_ENTRIES} 个未完成提取检查点，请先完成或手动归档检查点存储。`
		);
	}
}

export function upsertMemoryExtractionCheckpoint(
	store: MemoryExtractionCheckpointStore,
	checkpoint: MemoryExtractionCheckpoint,
	updatedAt = new Date().toISOString()
): MemoryExtractionCheckpointStore {
	assertMemoryExtractionCheckpointCapacity(store, checkpoint.transcriptPath);
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		updatedAt,
		checkpoints: {
			...store.checkpoints,
			[checkpoint.transcriptPath]: checkpoint
		}
	};
}

export function removeMemoryExtractionCheckpoint(
	store: MemoryExtractionCheckpointStore,
	transcriptPath: string,
	expectedIdentity?: MemoryExtractionCheckpointIdentity,
	updatedAt = new Date().toISOString()
): MemoryExtractionCheckpointStore {
	const checkpoint = store.checkpoints[transcriptPath];
	if (!checkpoint || (expectedIdentity && !matchesIdentity(checkpoint, expectedIdentity))) {
		return store;
	}
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		updatedAt,
		checkpoints: Object.fromEntries(
			Object.entries(store.checkpoints).filter(([path]) => path !== transcriptPath)
		)
	};
}

export function readResumableMemoryExtraction(
	store: MemoryExtractionCheckpointStore,
	expectedIdentity: MemoryExtractionCheckpointIdentity,
	expectedChunks: readonly AnalysisTextChunk[]
): ResumableMemoryExtraction | null {
	const checkpoint = store.checkpoints[expectedIdentity.transcriptPath];
	if (!checkpoint || !matchesIdentity(checkpoint, expectedIdentity)) {
		return null;
	}
	if (
		checkpoint.completedChunks.length === 0 ||
		checkpoint.completedChunks.length > expectedChunks.length ||
		checkpoint.completedChunks.length > MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS
	) {
		return null;
	}
	const results: MemoryExtractionChunkResult[] = [];
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
			return null;
		}
		try {
			results.push(prepareMemoryExtractionCheckpointResult(completed.result, expected.text, expectedIdentity));
		} catch {
			return null;
		}
	}
	return { createdAt: checkpoint.createdAt, results };
}

export function prepareMemoryExtractionCheckpointResult(
	result: MemoryExtractionChunkResult,
	sourceText: string,
	identity: MemoryExtractionCheckpointIdentity
): MemoryExtractionChunkResult {
	const provider = result.provider.trim();
	const model = result.model.trim();
	if (provider !== identity.provider || model !== identity.model) {
		throw new Error("记忆提取分块结果的 Provider 或模型与检查点身份不一致。");
	}
	const assertions = parseMemoryExtractionResponse(JSON.stringify({ assertions: result.assertions }), sourceText).assertions;
	if (JSON.stringify(assertions).length > MEMORY_EXTRACTION_CHECKPOINT_RESULT_MAX_CHARACTERS) {
		throw new Error(
			`单个记忆提取分块结果超过 ${MEMORY_EXTRACTION_CHECKPOINT_RESULT_MAX_CHARACTERS} 字符检查点上限。`
		);
	}
	const rejectedAssertionCount = result.rejectedAssertionCount ?? 0;
	if (!isNonNegativeInteger(rejectedAssertionCount)) {
		throw new Error("记忆提取分块结果的证据校验拒绝数量无效。");
	}
	return {
		assertions,
		provider,
		model,
		...(rejectedAssertionCount > 0 ? { rejectedAssertionCount } : {}),
		traceId: result.traceId?.trim().slice(0, MAX_TRACE_ID_CHARACTERS) || undefined
	};
}

function parseMemoryExtractionCheckpoint(value: unknown): MemoryExtractionCheckpoint | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION ||
		value.chunkingVersion !== MEMORY_EXTRACTION_CHUNKING_VERSION ||
		typeof value.transcriptPath !== "string" || !value.transcriptPath ||
		typeof value.inputFingerprint !== "string" || !value.inputFingerprint ||
		typeof value.sourceFingerprint !== "string" || !value.sourceFingerprint ||
		typeof value.provider !== "string" || !value.provider ||
		typeof value.model !== "string" || !value.model ||
		typeof value.configurationFingerprint !== "string" || !value.configurationFingerprint ||
		typeof value.createdAt !== "string" || !value.createdAt ||
		typeof value.updatedAt !== "string" || !value.updatedAt ||
		!Array.isArray(value.completedChunks) ||
		value.completedChunks.length === 0 ||
		value.completedChunks.length > MEMORY_EXTRACTION_CHECKPOINT_MAX_CHUNKS
	) {
		return null;
	}
	const completedChunks = value.completedChunks.map(parseCompletedMemoryExtractionChunk);
	if (completedChunks.some((chunk) => chunk === null)) {
		return null;
	}
	return {
		schemaVersion: MEMORY_EXTRACTION_CHECKPOINT_SCHEMA_VERSION,
		chunkingVersion: MEMORY_EXTRACTION_CHUNKING_VERSION,
		transcriptPath: value.transcriptPath,
		inputFingerprint: value.inputFingerprint,
		sourceFingerprint: value.sourceFingerprint,
		provider: value.provider,
		model: value.model,
		configurationFingerprint: value.configurationFingerprint,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		completedChunks: completedChunks as CompletedMemoryExtractionChunk[]
	};
}

function parseCompletedMemoryExtractionChunk(value: unknown): CompletedMemoryExtractionChunk | null {
	if (
		!isRecord(value) ||
		!isPositiveInteger(value.index) ||
		!isPositiveInteger(value.total) ||
		!isNonNegativeInteger(value.start) ||
		!isPositiveInteger(value.end) || value.end <= value.start ||
		typeof value.textFingerprint !== "string" || !value.textFingerprint ||
		!isRecord(value.result) ||
		typeof value.result.provider !== "string" || !value.result.provider ||
		typeof value.result.model !== "string" || !value.result.model ||
		(value.result.rejectedAssertionCount !== undefined &&
			!isNonNegativeInteger(value.result.rejectedAssertionCount)) ||
		(value.result.traceId !== undefined && (
			typeof value.result.traceId !== "string" || value.result.traceId.length > MAX_TRACE_ID_CHARACTERS
		)) ||
		!Array.isArray(value.result.assertions) ||
		JSON.stringify(value.result.assertions).length > MEMORY_EXTRACTION_CHECKPOINT_RESULT_MAX_CHARACTERS ||
		!value.result.assertions.every(isRawMemoryAssertion)
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
			assertions: value.result.assertions.map((assertion) => ({ ...assertion })),
			provider: value.result.provider,
			model: value.result.model,
			...(typeof value.result.rejectedAssertionCount === "number" && value.result.rejectedAssertionCount > 0
				? { rejectedAssertionCount: value.result.rejectedAssertionCount }
				: {}),
			traceId: typeof value.result.traceId === "string" ? value.result.traceId : undefined
		}
	};
}

function matchesIdentity(
	left: MemoryExtractionCheckpointIdentity,
	right: MemoryExtractionCheckpointIdentity
): boolean {
	return left.transcriptPath === right.transcriptPath &&
		left.inputFingerprint === right.inputFingerprint &&
		left.sourceFingerprint === right.sourceFingerprint &&
		left.provider === right.provider &&
		left.model === right.model &&
		left.configurationFingerprint === right.configurationFingerprint;
}

function isRawMemoryAssertion(value: unknown): value is RawMemoryAssertion {
	return isRecord(value) &&
		MEMORY_SUBJECT_TYPES.includes(value.subjectType as never) &&
		MEMORY_CATEGORIES.includes(value.category as never) &&
		typeof value.subjectName === "string" && Boolean(value.subjectName.trim()) &&
		typeof value.predicate === "string" && Boolean(value.predicate.trim()) &&
		typeof value.value === "string" && Boolean(value.value.trim()) &&
		typeof value.confidence === "number" && Number.isFinite(value.confidence) &&
		value.confidence >= 0 && value.confidence <= 1 &&
		typeof value.evidenceQuote === "string" && Boolean(value.evidenceQuote.trim());
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

import {
	MEMORY_CATEGORIES,
	MEMORY_SCHEMA_VERSION,
	MEMORY_SUBJECT_TYPES,
	type MemoryAssertion,
	type MemoryCandidatePackage,
	type MemoryExtractionResponse,
	type MemorySubjectType,
	type RawMemoryAssertion
} from "./memory-types";

export const MEMORY_CANDIDATE_DATA_START = "<!-- echo-memory-data:start -->";
export const MEMORY_CANDIDATE_DATA_END = "<!-- echo-memory-data:end -->";
export const MEMORY_MANAGED_START = "<!-- echo-memory:managed:start -->";
export const MEMORY_MANAGED_END = "<!-- echo-memory:managed:end -->";
export const MEMORY_MEETING_START = "<!-- echo-memory-meeting:start -->";
export const MEMORY_MEETING_END = "<!-- echo-memory-meeting:end -->";

export interface RejectedMemoryAssertion {
	index: number;
	reason: string;
}

export interface MemoryExtractionResponseDiagnostics {
	response: MemoryExtractionResponse;
	rejectedAssertions: RejectedMemoryAssertion[];
}

export function parseMemoryExtractionResponse(text: string, sourceText: string): MemoryExtractionResponse {
	const diagnostics = parseMemoryExtractionResponseDiagnostics(text, sourceText, false);
	const rejected = diagnostics.rejectedAssertions[0];
	if (rejected) {
		throw new Error(rejected.reason);
	}
	return diagnostics.response;
}

export function parseMemoryExtractionResponseWithDiagnostics(
	text: string,
	sourceText: string
): MemoryExtractionResponseDiagnostics {
	return parseMemoryExtractionResponseDiagnostics(text, sourceText, true);
}

function parseMemoryExtractionResponseDiagnostics(
	text: string,
	sourceText: string,
	rejectFullyUngroundedResponse: boolean
): MemoryExtractionResponseDiagnostics {
	const jsonText = extractJsonObject(text);
	let parsed: unknown;
	try {
		parsed = JSON.parse(jsonText);
	} catch (error) {
		throw new Error(`记忆提取结果不是有效 JSON：${getErrorMessage(error)}`, { cause: error });
	}

	if (!isRecord(parsed) || !Array.isArray(parsed.assertions)) {
		throw new Error("记忆提取结果必须包含 assertions 数组。");
	}

	const assertions: RawMemoryAssertion[] = [];
	const rejectedAssertions: RejectedMemoryAssertion[] = [];
	parsed.assertions.forEach((value, index) => {
		const assertion = parseRawAssertion(value, index);
		if (!includesNormalized(sourceText, assertion.evidenceQuote)) {
			rejectedAssertions.push({
				index,
				reason: `assertions[${index}].evidenceQuote 无法在本次输入中定位。`
			});
			return;
		}
		assertions.push(assertion);
	});
	if (rejectFullyUngroundedResponse && parsed.assertions.length > 0 && assertions.length === 0) {
		throw new Error(`模型返回的 ${rejectedAssertions.length} 条断言均因原文证据无法定位被拒绝。`);
	}
	return {
		response: { assertions },
		rejectedAssertions
	};
}

export function renderMemoryCandidate(candidate: MemoryCandidatePackage, reviewPath?: string): string {
	const rows = candidate.assertions.length > 0
		? candidate.assertions.map((assertion) => [
			assertion.subjectType,
			assertion.subjectName,
			assertion.predicate,
			assertion.value,
			assertion.confidence.toFixed(2),
			assertion.evidenceQuote
		].map(escapeTableCell).join(" | "))
		: ["- | - | - | 未提取到可存档断言 | - | -"];

	return [
		"---",
		"echo_memory_type: candidate",
		`echo_memory_id: ${candidate.id}`,
		`echo_memory_fingerprint: ${candidate.fingerprint}`,
		`source: "[[${escapeYamlString(candidate.source.transcriptPath)}]]"`,
		`created: ${candidate.createdAt}`,
		"---",
		"",
		`# 记忆候选 · ${candidate.source.transcriptTitle}`,
		"",
		`来源：[[${candidate.source.transcriptPath}]]`,
		`Provider：${candidate.provider} · 模型：${candidate.model}`,
		...(candidate.rejectedAssertionCount
			? [`证据校验拒绝：${candidate.rejectedAssertionCount} 条`]
			: []),
		...(reviewPath ? [`审核：[[${reviewPath}]]`] : []),
		"",
		"| 类型 | 主体 | 关系/属性 | 内容 | 置信度 | 原文证据 |",
		"| --- | --- | --- | --- | ---: | --- |",
		...rows.map((row) => `| ${row} |`),
		"",
		MEMORY_CANDIDATE_DATA_START,
		"```json",
		JSON.stringify(candidate, null, 2),
		"```",
		MEMORY_CANDIDATE_DATA_END,
		""
	].join("\n");
}

export function parseMemoryCandidate(content: string): MemoryCandidatePackage {
	const startIndex = content.indexOf(MEMORY_CANDIDATE_DATA_START);
	const endIndex = content.indexOf(MEMORY_CANDIDATE_DATA_END);
	if (startIndex === -1 || endIndex <= startIndex) {
		throw new Error("候选包缺少 Echo Memory 数据区块。");
	}

	const block = content.slice(startIndex + MEMORY_CANDIDATE_DATA_START.length, endIndex);
	const parsed = JSON.parse(extractJsonObject(block)) as unknown;
	if (!isRecord(parsed) || parsed.schemaVersion !== MEMORY_SCHEMA_VERSION || !Array.isArray(parsed.assertions)) {
		throw new Error("候选包 Schema 不受支持。");
	}
	if (typeof parsed.id !== "string" || typeof parsed.fingerprint !== "string" || !isRecord(parsed.source)) {
		throw new Error("候选包元数据不完整。");
	}
	if (
		typeof parsed.createdAt !== "string" ||
		typeof parsed.provider !== "string" ||
		typeof parsed.model !== "string" ||
		!Array.isArray(parsed.traceIds) ||
		!parsed.traceIds.every((value) => typeof value === "string") ||
		(parsed.rejectedAssertionCount !== undefined && (
			typeof parsed.rejectedAssertionCount !== "number" ||
			!Number.isInteger(parsed.rejectedAssertionCount) ||
			parsed.rejectedAssertionCount < 0
		)) ||
		typeof parsed.source.transcriptPath !== "string" ||
		typeof parsed.source.transcriptTitle !== "string" ||
		!Array.isArray(parsed.source.analysisTemplateIds) ||
		!parsed.source.analysisTemplateIds.every((value) => typeof value === "string")
	) {
		throw new Error("候选包来源或 Provider 元数据无效。");
	}

	for (const assertion of parsed.assertions) {
		if (!isStoredAssertion(assertion)) {
			throw new Error("候选包包含无效断言。");
		}
	}
	return parsed as unknown as MemoryCandidatePackage;
}

export function insertOrReplaceManagedBlock(
	content: string,
	startMarker: string,
	endMarker: string,
	block: string
): string {
	const startIndex = content.indexOf(startMarker);
	const endIndex = content.indexOf(endMarker);
	const normalizedBlock = block.trim();
	if (startIndex !== -1 && endIndex > startIndex) {
		const suffixIndex = endIndex + endMarker.length;
		return `${content.slice(0, startIndex)}${normalizedBlock}${content.slice(suffixIndex)}`;
	}

	const trimmed = content.trimEnd();
	return `${trimmed}${trimmed ? "\n\n" : ""}${normalizedBlock}\n`;
}

export function createStableFingerprint(value: string): string {
	return `${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9)}${value.length.toString(16).padStart(8, "0")}`;
}

export function normalizeEntityName(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function sanitizeMemoryFileName(value: string): string {
	const sanitized = value
		.normalize("NFKC")
		.replace(/[\\/:*?"<>|#^]/g, " ")
		.replace(/\[|\]/g, " ")
		.replace(/\s+/g, " ")
		.replace(/^\.+|\.+$/g, "")
		.trim();
	return sanitized || "未命名实体";
}

export function formatMemoryExtractionFailureLog(transcriptPath: string, error: string): string {
	return `记忆提取失败 [[${sanitizeMemoryLogPath(transcriptPath)}]]：${normalizeMemoryLogText(error)}。可在任务中心点击“重试记忆提取”。`;
}

export function formatMemoryExtractionRetryLog(transcriptPath: string): string {
	return `从任务中心重试记忆提取 [[${sanitizeMemoryLogPath(transcriptPath)}]]。`;
}

function parseRawAssertion(value: unknown, index: number): RawMemoryAssertion {
	if (!isRecord(value)) {
		throw new Error(`assertions[${index}] 必须是对象。`);
	}

	const subjectType = readEnum(value.subjectType, MEMORY_SUBJECT_TYPES, `assertions[${index}].subjectType`);
	const category = readEnum(value.category, MEMORY_CATEGORIES, `assertions[${index}].category`);
	const assertion: RawMemoryAssertion = {
		subjectType,
		subjectName: readNonEmptyString(value.subjectName, `assertions[${index}].subjectName`),
		category,
		predicate: readNonEmptyString(value.predicate, `assertions[${index}].predicate`),
		value: readNonEmptyString(value.value, `assertions[${index}].value`),
		confidence: readConfidence(value.confidence, `assertions[${index}].confidence`),
		evidenceQuote: readNonEmptyString(value.evidenceQuote, `assertions[${index}].evidenceQuote`)
	};

	return assertion;
}

function isStoredAssertion(value: unknown): value is MemoryAssertion {
	return isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.observedAt === "string" &&
		typeof value.sourcePath === "string" &&
		typeof value.chunkIndex === "number" &&
		MEMORY_SUBJECT_TYPES.includes(value.subjectType as MemorySubjectType) &&
		MEMORY_CATEGORIES.includes(value.category as never) &&
		typeof value.subjectName === "string" && value.subjectName.trim().length > 0 &&
		typeof value.predicate === "string" && value.predicate.trim().length > 0 &&
		typeof value.value === "string" && value.value.trim().length > 0 &&
		typeof value.confidence === "number" && Number.isFinite(value.confidence) &&
		value.confidence >= 0 && value.confidence <= 1 &&
		typeof value.evidenceQuote === "string" && value.evidenceQuote.trim().length > 0;
}

function extractJsonObject(text: string): string {
	const withoutFence = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
	const startIndex = withoutFence.indexOf("{");
	const endIndex = withoutFence.lastIndexOf("}");
	if (startIndex === -1 || endIndex <= startIndex) {
		throw new Error("记忆提取结果中未找到 JSON 对象。");
	}
	return withoutFence.slice(startIndex, endIndex + 1);
}

function readNonEmptyString(value: unknown, path: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${path} 必须是非空字符串。`);
	}
	return value.trim();
}

function readConfidence(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
		throw new Error(`${path} 必须是 0 到 1 之间的数字。`);
	}
	return value;
}

function readEnum<T extends string>(value: unknown, values: readonly T[], path: string): T {
	if (typeof value !== "string" || !values.includes(value as T)) {
		throw new Error(`${path} 不在允许的枚举范围内。`);
	}
	return value as T;
}

function includesNormalized(source: string, quote: string): boolean {
	const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();
	return normalize(source).includes(normalize(quote));
}

function hash32(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function escapeTableCell(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function escapeYamlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function sanitizeMemoryLogPath(value: string): string {
	return value.replace(/\]\]/g, "]").replace(/\r?\n/g, " ").trim();
}

function normalizeMemoryLogText(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

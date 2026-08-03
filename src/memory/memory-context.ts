import {
	MEMORY_RELATION_TYPE_LABELS,
	getMemoryRelationEndpointKey
} from "./memory-relation";
import { createStableFingerprint, insertOrReplaceManagedBlock, normalizeEntityName } from "./memory-output";
import type { MemoryAggregationEntry } from "./memory-aggregation";
import type { MemoryPaths } from "./memory-types";

export const MEMORY_CONTEXT_MANAGED_START = "<!-- echo-memory-context:managed:start -->";
export const MEMORY_CONTEXT_MANAGED_END = "<!-- echo-memory-context:managed:end -->";
export const MEMORY_CONTEXT_MIN_CHARACTERS = 4_000;
export const MEMORY_CONTEXT_MAX_CHARACTERS = 100_000;
export const MEMORY_CONTEXT_DEFAULT_CHARACTERS = 12_000;

export interface MemoryContextFilterOptions {
	project: string;
	person: string;
	startDate: string;
	endDate: string;
	maxCharacters: number;
}

export interface MemoryContextFilterChoices {
	projects: string[];
	people: string[];
}

export interface MemoryContextPackagePreview {
	id: string;
	generatedAt: string;
	options: MemoryContextFilterOptions;
	matchingCount: number;
	includedCount: number;
	omittedCount: number;
	managedBlock: string;
}

export function createDefaultMemoryContextFilterOptions(): MemoryContextFilterOptions {
	return {
		project: "",
		person: "",
		startDate: "",
		endDate: "",
		maxCharacters: MEMORY_CONTEXT_DEFAULT_CHARACTERS
	};
}

export function getMemoryContextFilterChoices(
	entries: readonly MemoryAggregationEntry[]
): MemoryContextFilterChoices {
	return {
		projects: getUniqueSubjectNames(entries, "project"),
		people: getUniqueSubjectNames(entries, "person")
	};
}

export function buildMemoryContextPackagePreview(
	entries: readonly MemoryAggregationEntry[],
	options: MemoryContextFilterOptions,
	language: "zh" | "en",
	generatedAt = new Date().toISOString()
): MemoryContextPackagePreview {
	const normalizedOptions = validateAndNormalizeOptions(options);
	const matchingEntries = sortContextEntries(
		entries.filter((entry) => matchesContextFilters(entry, normalizedOptions))
	);
	const id = `context-${createStableFingerprint(JSON.stringify({
		options: normalizedOptions,
		entries: matchingEntries.map((entry) => ({
			endpoint: getMemoryRelationEndpointKey({
				candidateId: entry.candidateId,
				candidatePath: entry.candidatePath,
				reviewPath: entry.reviewPath,
				assertionId: entry.assertion.id,
				transcriptPath: entry.assertion.sourcePath,
				subjectType: entry.assertion.subjectType,
				subjectName: entry.assertion.subjectName,
				predicate: entry.assertion.predicate,
				effectiveValue: entry.assertion.value,
				observedAt: entry.assertion.observedAt
			}),
			assertion: {
				subjectType: entry.assertion.subjectType,
				subjectName: entry.assertion.subjectName,
				predicate: entry.assertion.predicate,
				value: entry.assertion.value,
				evidenceQuote: entry.assertion.evidenceQuote,
				observedAt: entry.assertion.observedAt,
				sourcePath: entry.assertion.sourcePath
			},
			relations: entry.relationAnnotations.map((annotation) => annotation.relationId).sort()
		}))
	}))}`;
	const included: MemoryAggregationEntry[] = [];
	for (const entry of matchingEntries) {
		const candidate = [...included, entry];
		const managedBlock = renderMemoryContextManagedBlock(
			id,
			generatedAt,
			normalizedOptions,
			candidate,
			matchingEntries.length - candidate.length,
			language
		);
		if (managedBlock.length <= normalizedOptions.maxCharacters) {
			included.push(entry);
		}
	}

	let managedBlock = renderMemoryContextManagedBlock(
		id,
		generatedAt,
		normalizedOptions,
		included,
		matchingEntries.length - included.length,
		language
	);
	while (managedBlock.length > normalizedOptions.maxCharacters && included.length > 0) {
		included.pop();
		managedBlock = renderMemoryContextManagedBlock(
			id,
			generatedAt,
			normalizedOptions,
			included,
			matchingEntries.length - included.length,
			language
		);
	}
	if (managedBlock.length > normalizedOptions.maxCharacters) {
		throw new Error("上下文包基础元数据超过字符预算，请缩短筛选名称或提高字符上限。");
	}

	return {
		id,
		generatedAt,
		options: normalizedOptions,
		matchingCount: matchingEntries.length,
		includedCount: included.length,
		omittedCount: matchingEntries.length - included.length,
		managedBlock
	};
}

export function getMemoryContextPackagePath(
	paths: MemoryPaths,
	preview: MemoryContextPackagePreview,
	language: "zh" | "en"
): string {
	const date = /^\d{4}-\d{2}-\d{2}/.exec(preview.generatedAt)?.[0] ?? "undated";
	const prefix = language === "en" ? "Context" : "上下文";
	return `${paths.contextPackagesDir}/${prefix} ${date} ${preview.id.slice("context-".length, "context-".length + 10)}.md`;
}

export function renderInitialMemoryContextPackage(
	preview: MemoryContextPackagePreview,
	language: "zh" | "en"
): string {
	return [
		"---",
		"echo_memory_type: context-package",
		`echo_memory_context_id: ${preview.id}`,
		`created: ${preview.generatedAt}`,
		"---",
		"",
		`# ${language === "en" ? "Personal Agent Context" : "Personal Agent 上下文"}`,
		"",
		language === "en" ? "## Manual Notes" : "## 人工内容",
		"",
		preview.managedBlock,
		""
	].join("\n");
}

export function updateMemoryContextPackageDocument(
	content: string,
	preview: MemoryContextPackagePreview
): string {
	return insertOrReplaceManagedBlock(
		content,
		MEMORY_CONTEXT_MANAGED_START,
		MEMORY_CONTEXT_MANAGED_END,
		preview.managedBlock
	);
}

function renderMemoryContextManagedBlock(
	id: string,
	generatedAt: string,
	options: MemoryContextFilterOptions,
	entries: readonly MemoryAggregationEntry[],
	omittedCount: number,
	language: "zh" | "en"
): string {
	const scope = language === "en"
		? [
			`- Project: ${options.project || "Any"}`,
			`- Person: ${options.person || "Any"}`,
			`- Date range: ${options.startDate || "Any"} to ${options.endDate || "Any"}`,
			`- Character budget: ${options.maxCharacters}`
		]
		: [
			`- 项目：${options.project || "不限"}`,
			`- 人物：${options.person || "不限"}`,
			`- 时间范围：${options.startDate || "不限"} 至 ${options.endDate || "不限"}`,
			`- 字符预算：${options.maxCharacters}`
		];
	const entryLines = entries.length > 0
		? entries.flatMap((entry) => renderContextEntry(entry, language))
		: [language === "en" ? "_No matching approved memory._" : "_没有符合范围的已批准记忆。_"];
	return [
		MEMORY_CONTEXT_MANAGED_START,
		language === "en" ? "## Context scope" : "## 上下文范围",
		"",
		`- ID: ${id}`,
		`- ${language === "en" ? "Generated" : "生成时间"}：${generatedAt}`,
		...scope,
		"",
		language === "en" ? "## Approved memory" : "## 已批准记忆",
		"",
		...entryLines,
		"",
		`- ${language === "en" ? "Included" : "已纳入"}：${entries.length}`,
		`- ${language === "en" ? "Omitted by budget" : "因预算省略"}：${omittedCount}`,
		MEMORY_CONTEXT_MANAGED_END
	].join("\n");
}

function renderContextEntry(entry: MemoryAggregationEntry, language: "zh" | "en"): string[] {
	const assertion = entry.assertion;
	const lines = [
		`- ${escapeMarkdownInline(assertion.observedAt)} · **${escapeMarkdownInline(assertion.subjectName)} · ${escapeMarkdownInline(assertion.predicate)}**：${escapeMarkdownInline(assertion.value)}`,
		`  - ${language === "en" ? "Evidence" : "证据"}：“${escapeMarkdownInline(assertion.evidenceQuote)}”`,
		`  - ${language === "en" ? "Sources" : "来源"}：[[${assertion.sourcePath}|transcript]] · [[${entry.candidatePath}|${entry.candidateId}]] · [[${entry.reviewPath}|review]]`
	];
	for (const annotation of entry.relationAnnotations) {
		const label = language === "en" ? annotation.type : MEMORY_RELATION_TYPE_LABELS[annotation.type];
		lines.push(
			`  - ${language === "en" ? "Relation" : "关系"}：${label}（${annotation.relationId}）`,
			`    - ${language === "en" ? "Linked memory" : "关联记忆"}：${escapeMarkdownInline(annotation.counterpart.effectiveValue)} · [[${annotation.counterpart.transcriptPath}|transcript]] · [[${annotation.counterpart.candidatePath}|candidate]] · [[${annotation.counterpart.reviewPath}|review]]`
		);
	}
	return lines;
}

function validateAndNormalizeOptions(options: MemoryContextFilterOptions): MemoryContextFilterOptions {
	const normalized = {
		project: normalizeDisplayName(options.project),
		person: normalizeDisplayName(options.person),
		startDate: options.startDate.trim(),
		endDate: options.endDate.trim(),
		maxCharacters: Math.round(options.maxCharacters)
	};
	if (
		!Number.isFinite(normalized.maxCharacters) ||
		normalized.maxCharacters < MEMORY_CONTEXT_MIN_CHARACTERS ||
		normalized.maxCharacters > MEMORY_CONTEXT_MAX_CHARACTERS
	) {
		throw new Error(`上下文字符预算必须在 ${MEMORY_CONTEXT_MIN_CHARACTERS} 到 ${MEMORY_CONTEXT_MAX_CHARACTERS} 之间。`);
	}
	for (const [label, value] of [["开始日期", normalized.startDate], ["结束日期", normalized.endDate]]) {
		if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
			throw new Error(`${label}必须使用 YYYY-MM-DD 格式。`);
		}
	}
	if (normalized.startDate && normalized.endDate && normalized.startDate > normalized.endDate) {
		throw new Error("上下文开始日期不能晚于结束日期。");
	}
	return normalized;
}

function matchesContextFilters(
	entry: MemoryAggregationEntry,
	options: MemoryContextFilterOptions
): boolean {
	const subjectFilters = [
		...(options.project ? [`project:${normalizeEntityName(options.project)}`] : []),
		...(options.person ? [`person:${normalizeEntityName(options.person)}`] : [])
	];
	const entrySubject = `${entry.assertion.subjectType}:${normalizeEntityName(entry.assertion.subjectName)}`;
	if (subjectFilters.length > 0 && !subjectFilters.includes(entrySubject)) {
		return false;
	}
	if (!options.startDate && !options.endDate) {
		return true;
	}
	const observedDate = /^(\d{4}-\d{2}-\d{2})/.exec(entry.assertion.observedAt)?.[1];
	return Boolean(
		observedDate &&
		(!options.startDate || observedDate >= options.startDate) &&
		(!options.endDate || observedDate <= options.endDate)
	);
}

function sortContextEntries(entries: readonly MemoryAggregationEntry[]): MemoryAggregationEntry[] {
	return [...entries].sort((left, right) =>
		compareObservedAtDescending(left.assertion.observedAt, right.assertion.observedAt) ||
		normalizeEntityName(left.assertion.subjectName).localeCompare(normalizeEntityName(right.assertion.subjectName)) ||
		left.assertion.predicate.localeCompare(right.assertion.predicate) ||
		left.candidateId.localeCompare(right.candidateId) ||
		left.assertion.id.localeCompare(right.assertion.id)
	);
}

function compareObservedAtDescending(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return rightTime - leftTime;
	}
	if (Number.isFinite(leftTime)) {
		return -1;
	}
	if (Number.isFinite(rightTime)) {
		return 1;
	}
	return right.localeCompare(left);
}

function getUniqueSubjectNames(
	entries: readonly MemoryAggregationEntry[],
	type: "project" | "person"
): string[] {
	const names = new Map<string, string>();
	for (const entry of sortContextEntries(entries)) {
		if (entry.assertion.subjectType !== type) {
			continue;
		}
		const displayName = normalizeDisplayName(entry.assertion.subjectName);
		names.set(normalizeEntityName(displayName), displayName);
	}
	return [...names.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, name]) => name);
}

function normalizeDisplayName(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();
}

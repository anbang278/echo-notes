import {
	MEMORY_RELATION_TYPE_LABELS,
	getMemoryRelationEndpointKey
} from "./memory-relation";
import { createStableFingerprint, insertOrReplaceManagedBlock, normalizeEntityName } from "./memory-output";
import type { MemoryAggregationEntry } from "./memory-aggregation";
import { rankMemories, type RankableMemory } from "./context/context-ranking";
import {
	MEMORY_PROPOSED_TIERS,
	MEMORY_TYPES,
	formatProposedTier,
	formatMemoryType,
	isLongTermMemory,
	type ContextPurpose,
	type MemoryPaths,
	type ProposedMemoryTier,
	type MemoryType
} from "./memory-types";

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
	memoryTypes?: MemoryType[];
	proposedTiers?: ProposedMemoryTier[];
	purpose?: ContextPurpose;
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
		, normalizedOptions.purpose ?? "general"
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
	const typeFilter = options.memoryTypes?.map((type) => formatMemoryType(type, language));
	const horizonFilter = options.proposedTiers?.map((horizon) => formatProposedTier(horizon, language));
	const scope = language === "en"
		? [
			`- Project: ${options.project || "Any"}`,
			`- Person: ${options.person || "Any"}`,
			`- Date range: ${options.startDate || "Any"} to ${options.endDate || "Any"}`,
			`- Character budget: ${options.maxCharacters}`,
			`- Purpose: ${options.purpose ?? "general"}`,
			...(typeFilter && typeFilter.length > 0 ? [`- Memory types: ${typeFilter.join(", ")}`] : []),
			...(horizonFilter && horizonFilter.length > 0 ? [`- Horizon: ${horizonFilter.join(", ")}`] : [])
		]
		: [
			`- 项目：${options.project || "不限"}`,
			`- 人物：${options.person || "不限"}`,
			`- 时间范围：${options.startDate || "不限"} 至 ${options.endDate || "不限"}`,
			`- 字符预算：${options.maxCharacters}`,
			`- 用途：${options.purpose ?? "general"}`,
			...(typeFilter && typeFilter.length > 0 ? [`- 记忆类型：${typeFilter.join("、")}`] : []),
			...(horizonFilter && horizonFilter.length > 0 ? [`- 时效：${horizonFilter.join("、")}`] : [])
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
		`  - ${language === "en" ? "Type" : "类型"}：${formatMemoryType(assertion.memoryType, language)} · ${language === "en" ? "Horizon" : "时效"}：${formatProposedTier(assertion.proposedTier, language)}`,
		`  - ${language === "en" ? "Evidence" : "证据"}：“${escapeMarkdownInline(assertion.evidenceQuote)}”`
	];
	if (assertion.whyRemember) {
		lines.push(`  - ${language === "en" ? "Why remember" : "准入理由"}：${escapeMarkdownInline(assertion.whyRemember)}`);
	}
	const temporalText = formatTemporalText(assertion.temporal, language);
	if (temporalText) {
		lines.push(`  - ${language === "en" ? "Valid" : "时间范围"}：${temporalText}`);
	}
	lines.push(`  - ${language === "en" ? "Sources" : "来源"}：[[${assertion.sourcePath}|transcript]] · [[${entry.candidatePath}|${entry.candidateId}]] · [[${entry.reviewPath}|review]]`);
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
	const memoryTypes = normalizeEnumFilter(options.memoryTypes, MEMORY_TYPES);
	const proposedTiers = normalizeEnumFilter(options.proposedTiers, MEMORY_PROPOSED_TIERS);
	return {
		...normalized,
		purpose: options.purpose ?? "general",
		...(memoryTypes.length > 0 ? { memoryTypes } : {}),
		...(proposedTiers.length > 0 ? { proposedTiers } : {})
	};
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
	if (options.memoryTypes && options.memoryTypes.length > 0) {
		if (!entry.assertion.memoryType || !options.memoryTypes.includes(entry.assertion.memoryType)) {
			return false;
		}
	}
	if (options.proposedTiers && options.proposedTiers.length > 0) {
		const matchesHorizon = options.proposedTiers.some((horizon) =>
			horizon === "working"
				? entry.assertion.proposedTier === "working"
				: isLongTermMemory(entry.assertion.proposedTier)
		);
		if (!matchesHorizon) {
			return false;
		}
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

function sortContextEntries(
	entries: readonly MemoryAggregationEntry[],
	purpose: ContextPurpose
): MemoryAggregationEntry[] {
	const wrapped = entries.map((entry) => ({
		entry,
		rankable: {
			assertion: entry.assertion,
			id: `${entry.candidateId}\n${entry.assertion.id}`,
			tier: entry.assertion.proposedTier === "working" ? "working" : "long_term",
			authority: "user_confirmed",
			validity: "active"
		} satisfies RankableMemory
	}));
	const ranked = rankMemories(wrapped.map((item) => item.rankable), purpose);
	const byId = new Map(wrapped.map((item) => [item.rankable.id, item.entry]));
	return ranked.flatMap((item) => {
		const entry = byId.get(item.entry.id);
		return entry ? [entry] : [];
	});
}

function getUniqueSubjectNames(
	entries: readonly MemoryAggregationEntry[],
	type: "project" | "person"
): string[] {
	const names = new Map<string, string>();
	for (const entry of sortContextEntries(entries, "general")) {
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

function normalizeEnumFilter<T extends string>(value: T[] | undefined, allowed: readonly T[]): T[] {
	if (!value) {
		return [];
	}
	const order = new Map(allowed.map((item, index) => [item, index]));
	return [...new Set(value.filter((item) => order.has(item)))]
		.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
}

function formatTemporalText(
	temporal: { validFrom?: string; validUntil?: string } | undefined,
	language: "zh" | "en"
): string {
	if (!temporal) {
		return "";
	}
	const parts: string[] = [];
	if (temporal.validFrom) {
		parts.push(`${language === "en" ? "from" : "从"} ${temporal.validFrom}`);
	}
	if (temporal.validUntil) {
		parts.push(`${language === "en" ? "to" : "至"} ${temporal.validUntil}`);
	}
	return parts.join(" ");
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();
}

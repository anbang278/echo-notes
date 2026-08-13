import type { TranscriptionEnhancementSnapshot, TranscriptionHotwordWeight } from "../providers/transcription-provider";
import { createStableFingerprint, insertOrReplaceManagedBlock } from "./memory-output";

export const TRANSCRIPTION_ENHANCEMENT_SCHEMA_VERSION = 1;
export const TRANSCRIPTION_ENHANCEMENT_MANAGED_START = "<!-- echo-memory-transcription-enhancement:managed:start -->";
export const TRANSCRIPTION_ENHANCEMENT_MANAGED_END = "<!-- echo-memory-transcription-enhancement:managed:end -->";
export const TRANSCRIPTION_ENHANCEMENT_DATA_START = "<!-- echo-memory-transcription-enhancement-data:start -->";
export const TRANSCRIPTION_ENHANCEMENT_DATA_END = "<!-- echo-memory-transcription-enhancement-data:end -->";
export const TRANSCRIPTION_ENHANCEMENT_MAX_HOTWORDS = 2_000;
export const TRANSCRIPTION_ENHANCEMENT_MAX_SUPER_HOTWORDS = 50;
export const TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS = 400;

export type TranscriptionEnhancementScopeType = "global" | "project" | "person" | "organization";
export type TranscriptionEnhancementStatus = "pending" | "approved" | "rejected" | "disabled";
export type TranscriptionEnhancementSource = "manual" | "memory";

export interface TranscriptionEnhancementScope {
	type: TranscriptionEnhancementScopeType;
	value?: string;
}

export interface TranscriptionEnhancementHistoryEvent {
	at: string;
	status: TranscriptionEnhancementStatus;
	note: string;
}

export interface TranscriptionEnhancementTerm {
	id: string;
	text: string;
	weight: TranscriptionHotwordWeight;
	scope: TranscriptionEnhancementScope;
	source: TranscriptionEnhancementSource;
	status: TranscriptionEnhancementStatus;
	evidence?: string;
	backlink?: string;
	approvedAt?: string;
	updatedAt: string;
	history: TranscriptionEnhancementHistoryEvent[];
}

export interface TranscriptionEnhancementPrompt {
	id: string;
	text: string;
	scope: TranscriptionEnhancementScope;
	status: TranscriptionEnhancementStatus;
	updatedAt: string;
	history: TranscriptionEnhancementHistoryEvent[];
}

export interface TranscriptionEnhancementStore {
	schemaVersion: 1;
	updatedAt: string;
	terms: Record<string, TranscriptionEnhancementTerm>;
	prompts: Record<string, TranscriptionEnhancementPrompt>;
}

export interface TranscriptionEnhancementScopes {
	projects: string[];
	people: string[];
	organizations: string[];
}

export interface ApprovedTranscriptionMemoryAssertion {
	id: string;
	text: string;
	observedAt: string;
	subjectType: "user" | "person" | "organization" | "project";
	subjectName: string;
}

export interface BuildTranscriptionEnhancementInput {
	store: TranscriptionEnhancementStore;
	scopes: TranscriptionEnhancementScopes;
	memoryAssertions: readonly ApprovedTranscriptionMemoryAssertion[];
}

export function createTranscriptionEnhancementStore(at = new Date().toISOString()): TranscriptionEnhancementStore {
	return {
		schemaVersion: TRANSCRIPTION_ENHANCEMENT_SCHEMA_VERSION,
		updatedAt: at,
		terms: {},
		prompts: {}
	};
}

export function renderTranscriptionEnhancementDocument(store: TranscriptionEnhancementStore): string {
	return [
		"---",
		"echo_memory_type: transcription-enhancement",
		"---",
		"",
		"# 术语与上下文",
		"",
		"此文件由 Echo Notes 管理。表格用于审计，JSON 托管区块是插件事实源；请优先通过设置中的管理入口修改。",
		"",
		"## 人工补充",
		"",
		renderTranscriptionEnhancementManagedBlock(store),
		""
	].join("\n");
}

export function updateTranscriptionEnhancementDocument(
	content: string,
	store: TranscriptionEnhancementStore
): string {
	return insertOrReplaceManagedBlock(
		content,
		TRANSCRIPTION_ENHANCEMENT_MANAGED_START,
		TRANSCRIPTION_ENHANCEMENT_MANAGED_END,
		renderTranscriptionEnhancementManagedBlock(store)
	);
}

export function parseTranscriptionEnhancementDocument(content: string): TranscriptionEnhancementStore {
	const managedStart = content.indexOf(TRANSCRIPTION_ENHANCEMENT_MANAGED_START);
	const managedEnd = content.lastIndexOf(TRANSCRIPTION_ENHANCEMENT_MANAGED_END);
	if (managedStart < 0 || managedEnd <= managedStart) {
		throw new Error("术语与上下文文件缺少 Echo Memory 托管区块。");
	}
	const managed = content.slice(managedStart, managedEnd + TRANSCRIPTION_ENHANCEMENT_MANAGED_END.length);
	const dataStart = managed.indexOf(TRANSCRIPTION_ENHANCEMENT_DATA_START);
	const dataEnd = managed.lastIndexOf(TRANSCRIPTION_ENHANCEMENT_DATA_END);
	if (dataStart < 0 || dataEnd <= dataStart) {
		throw new Error("术语与上下文文件缺少 JSON 数据区块。");
	}
	const json = managed.slice(dataStart + TRANSCRIPTION_ENHANCEMENT_DATA_START.length, dataEnd);
	let value: unknown;
	try {
		value = JSON.parse(extractJsonObject(json));
	} catch (error) {
		throw new Error(`术语与上下文 JSON 无法读取：${getErrorMessage(error)}`, { cause: error });
	}
	if (!isTranscriptionEnhancementStore(value)) {
		throw new Error("术语与上下文 Schema 不受支持或内容无效。");
	}
	return value;
}

export function normalizeTranscriptionEnhancementScopes(input: {
	projects?: unknown;
	people?: unknown;
	organizations?: unknown;
}): TranscriptionEnhancementScopes {
	return {
		projects: normalizeScopeValues(input.projects),
		people: normalizeScopeValues(input.people),
		organizations: normalizeScopeValues(input.organizations)
	};
}

export function buildTranscriptionEnhancementSnapshot(
	input: BuildTranscriptionEnhancementInput
): TranscriptionEnhancementSnapshot {
	const matchingTerms = Object.values(input.store.terms)
		.filter((term) => term.status === "approved" && scopeMatches(term.scope, input.scopes))
		.sort((left, right) => compareScopedRecords(left, right, input.scopes));
	const selectedByText = new Map<string, TranscriptionEnhancementTerm>();
	for (const term of matchingTerms) {
		const key = term.text.trim().toLocaleLowerCase();
		if (key && !selectedByText.has(key)) {
			selectedByText.set(key, term);
		}
	}
	const deduplicatedTerms = [...selectedByText.values()];
	const selectedTerms: TranscriptionEnhancementTerm[] = [];
	let superHotwordCount = 0;
	for (const term of deduplicatedTerms) {
		if (selectedTerms.length >= TRANSCRIPTION_ENHANCEMENT_MAX_HOTWORDS) {
			break;
		}
		if (term.weight === 50 && superHotwordCount >= TRANSCRIPTION_ENHANCEMENT_MAX_SUPER_HOTWORDS) {
			continue;
		}
		selectedTerms.push(term);
		if (term.weight === 50) {
			superHotwordCount += 1;
		}
	}

	const matchingPrompts = Object.values(input.store.prompts)
		.filter((prompt) => prompt.status === "approved" && scopeMatches(prompt.scope, input.scopes))
		.sort((left, right) => compareScopedRecords(left, right, input.scopes));
	const matchingAssertions = input.memoryAssertions
		.filter((assertion) => assertionScopeMatches(assertion, input.scopes))
		.sort((left, right) =>
			getAssertionScopeRank(right, input.scopes) - getAssertionScopeRank(left, input.scopes) ||
			right.observedAt.localeCompare(left.observedAt) ||
			left.id.localeCompare(right.id)
		);

	const contextUnits = [
		...matchingPrompts.map((prompt) => ({ id: `prompt:${prompt.id}`, text: prompt.text.trim(), kind: "prompt" as const })),
		...matchingAssertions.map((assertion) => ({ id: assertion.id, text: assertion.text.trim(), kind: "memory" as const }))
	].filter((unit) => unit.text);
	const selectedContext: typeof contextUnits = [];
	let contextText = "";
	for (const unit of contextUnits) {
		const separator = contextText ? "\n" : "";
		if (contextText.length + separator.length + unit.text.length > TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS) {
			break;
		}
		contextText += separator + unit.text;
		selectedContext.push(unit);
	}

	const scopeIds = [
		"global",
		...input.scopes.projects.map((value) => `project:${value}`),
		...input.scopes.people.map((value) => `person:${value}`),
		...input.scopes.organizations.map((value) => `organization:${value}`)
	];
	const memoryAssertionIds = selectedContext
		.filter((unit) => unit.kind === "memory")
		.map((unit) => unit.id);
	const fingerprint = createStableFingerprint(JSON.stringify({
		hotwords: selectedTerms.map(({ id, text, weight }) => ({ id, text, weight })),
		contextText,
		scopeIds,
		memoryAssertionIds
	}));
	return {
		hotwords: selectedTerms.map((term) => ({ id: term.id, text: term.text, weight: term.weight })),
		contextText: contextText || undefined,
		scopeIds,
		memoryAssertionIds,
		omittedHotwordCount: deduplicatedTerms.length - selectedTerms.length,
		omittedContextCount: contextUnits.length - selectedContext.length,
		fingerprint
	};
}

function renderTranscriptionEnhancementManagedBlock(store: TranscriptionEnhancementStore): string {
	const terms = Object.values(store.terms).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	const prompts = Object.values(store.prompts).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	return [
		TRANSCRIPTION_ENHANCEMENT_MANAGED_START,
		"## 术语",
		"",
		"| 规范词 | 权重 | 作用域 | 来源 | 状态 | 更新时间 |",
		"| --- | ---: | --- | --- | --- | --- |",
		...(terms.length > 0
			? terms.map((term) => `| ${escapeTable(term.text)} | ${term.weight} | ${formatScope(term.scope)} | ${term.source === "manual" ? "手工" : "记忆候选"} | ${formatStatus(term.status)} | ${term.updatedAt} |`)
			: ["| _暂无_ |  |  |  |  |  |"]),
		"",
		"## 固定 Prompt",
		"",
		"| 内容 | 作用域 | 状态 | 更新时间 |",
		"| --- | --- | --- | --- |",
		...(prompts.length > 0
			? prompts.map((prompt) => `| ${escapeTable(prompt.text)} | ${formatScope(prompt.scope)} | ${formatStatus(prompt.status)} | ${prompt.updatedAt} |`)
			: ["| _暂无_ |  |  |  |"]),
		"",
		TRANSCRIPTION_ENHANCEMENT_DATA_START,
		"```json",
		JSON.stringify(store, null, 2),
		"```",
		TRANSCRIPTION_ENHANCEMENT_DATA_END,
		TRANSCRIPTION_ENHANCEMENT_MANAGED_END
	].join("\n");
}

function compareScopedRecords(
	left: TranscriptionEnhancementTerm | TranscriptionEnhancementPrompt,
	right: TranscriptionEnhancementTerm | TranscriptionEnhancementPrompt,
	scopes: TranscriptionEnhancementScopes
): number {
	const scopeDifference = getScopeRank(right.scope, scopes) - getScopeRank(left.scope, scopes);
	if (scopeDifference !== 0) {
		return scopeDifference;
	}
	if ("weight" in left && "weight" in right && left.weight !== right.weight) {
		return right.weight - left.weight;
	}
	if ("source" in left && "source" in right && left.source !== right.source) {
		return left.source === "manual" ? -1 : 1;
	}
	const leftApprovedAt = "approvedAt" in left ? left.approvedAt ?? left.updatedAt : left.updatedAt;
	const rightApprovedAt = "approvedAt" in right ? right.approvedAt ?? right.updatedAt : right.updatedAt;
	return rightApprovedAt.localeCompare(leftApprovedAt) || left.id.localeCompare(right.id);
}

function scopeMatches(scope: TranscriptionEnhancementScope, scopes: TranscriptionEnhancementScopes): boolean {
	return getScopeRank(scope, scopes) > 0;
}

function getScopeRank(scope: TranscriptionEnhancementScope, scopes: TranscriptionEnhancementScopes): number {
	if (scope.type === "global") {
		return 1;
	}
	const values = scope.type === "project"
		? scopes.projects
		: scope.type === "person"
			? scopes.people
			: scopes.organizations;
	return values.some((value) => normalizeScopeValue(value) === normalizeScopeValue(scope.value ?? "")) ? 2 : 0;
}

function assertionScopeMatches(
	assertion: ApprovedTranscriptionMemoryAssertion,
	scopes: TranscriptionEnhancementScopes
): boolean {
	return assertion.subjectType === "user" || getAssertionScopeRank(assertion, scopes) > 1;
}

function getAssertionScopeRank(
	assertion: ApprovedTranscriptionMemoryAssertion,
	scopes: TranscriptionEnhancementScopes
): number {
	if (assertion.subjectType === "user") {
		return 1;
	}
	const values = assertion.subjectType === "project"
		? scopes.projects
		: assertion.subjectType === "person"
			? scopes.people
			: scopes.organizations;
	return values.some((value) => normalizeScopeValue(value) === normalizeScopeValue(assertion.subjectName)) ? 2 : 0;
}

function normalizeScopeValues(value: unknown): string[] {
	const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
	return [...new Set(values
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean))];
}

function normalizeScopeValue(value: string): string {
	return value.trim().toLocaleLowerCase();
}

function isTranscriptionEnhancementStore(value: unknown): value is TranscriptionEnhancementStore {
	if (!isRecord(value) || value.schemaVersion !== TRANSCRIPTION_ENHANCEMENT_SCHEMA_VERSION ||
		typeof value.updatedAt !== "string" || !isRecord(value.terms) || !isRecord(value.prompts)) {
		return false;
	}
	return Object.values(value.terms).every(isTerm) && Object.values(value.prompts).every(isPrompt);
}

function isTerm(value: unknown): value is TranscriptionEnhancementTerm {
	return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
		isWeight(value.weight) && isScope(value.scope) && (value.source === "manual" || value.source === "memory") &&
		isStatus(value.status) && typeof value.updatedAt === "string" && Array.isArray(value.history);
}

function isPrompt(value: unknown): value is TranscriptionEnhancementPrompt {
	return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
		isScope(value.scope) && isStatus(value.status) && typeof value.updatedAt === "string" && Array.isArray(value.history);
}

function isScope(value: unknown): value is TranscriptionEnhancementScope {
	return isRecord(value) && ["global", "project", "person", "organization"].includes(String(value.type)) &&
		(value.type === "global" || typeof value.value === "string");
}

function isStatus(value: unknown): value is TranscriptionEnhancementStatus {
	return ["pending", "approved", "rejected", "disabled"].includes(String(value));
}

function isWeight(value: unknown): value is TranscriptionHotwordWeight {
	return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 50;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractJsonObject(value: string): string {
	const start = value.indexOf("{");
	const end = value.lastIndexOf("}");
	if (start < 0 || end <= start) {
		throw new Error("未找到 JSON 对象。");
	}
	return value.slice(start, end + 1);
}

function formatScope(scope: TranscriptionEnhancementScope): string {
	return scope.type === "global" ? "全局" : `${scope.type}:${escapeTable(scope.value ?? "")}`;
}

function formatStatus(status: TranscriptionEnhancementStatus): string {
	return { pending: "待审核", approved: "已批准", rejected: "已拒绝", disabled: "已禁用" }[status];
}

function escapeTable(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

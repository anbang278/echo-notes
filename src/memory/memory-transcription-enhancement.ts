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
export const TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_START = "<!-- echo-memory-transcription-candidates:managed:start -->";
export const TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_END = "<!-- echo-memory-transcription-candidates:managed:end -->";
export const TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_START = "<!-- echo-memory-transcription-candidates-data:start -->";
export const TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_END = "<!-- echo-memory-transcription-candidates-data:end -->";

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
	effectiveText?: string;
	sortOrder?: number;
}

export interface TranscriptionEnhancementPrompt {
	id: string;
	text: string;
	scope: TranscriptionEnhancementScope;
	status: TranscriptionEnhancementStatus;
	updatedAt: string;
	history: TranscriptionEnhancementHistoryEvent[];
	sortOrder?: number;
}

export interface TranscriptionEnhancementDocumentStats {
	manualTermCount: number;
	manualPromptCount: number;
	pendingCandidateCount: number;
	approvedCandidateCount: number;
	rejectedCandidateCount: number;
	disabledCandidateCount: number;
}

export class TranscriptionEnhancementDocumentError extends Error {
	readonly filePath: string;
	readonly line: number;

	constructor(filePath: string, line: number, message: string) {
		super(`${filePath}:${line} ${message}`);
		this.name = "TranscriptionEnhancementDocumentError";
		this.filePath = filePath;
		this.line = line;
	}
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
	enableHotwords?: boolean;
	enableContext?: boolean;
}

export function createTranscriptionEnhancementStore(at = new Date().toISOString()): TranscriptionEnhancementStore {
	return {
		schemaVersion: TRANSCRIPTION_ENHANCEMENT_SCHEMA_VERSION,
		updatedAt: at,
		terms: {},
		prompts: {}
	};
}

export function renderManualTranscriptionEnhancementDocument(
	store: TranscriptionEnhancementStore = createTranscriptionEnhancementStore(),
	preservedNotes = ""
): string {
	const activeTerms = Object.values(store.terms).filter((term) => term.source === "manual" && term.status === "approved");
	const activePrompts = Object.values(store.prompts).filter((prompt) => prompt.status === "approved");
	const scopeKeys = new Map<string, TranscriptionEnhancementScope>();
	for (const item of [...activeTerms, ...activePrompts]) {
		scopeKeys.set(formatManualScopeHeading(item.scope), item.scope);
	}
	if (!scopeKeys.has("全局")) {
		scopeKeys.set("全局", { type: "global" });
	}
	const sections: string[] = [];
	for (const [heading, scope] of [...scopeKeys.entries()].sort(([left], [right]) => left === "全局" ? -1 : right === "全局" ? 1 : left.localeCompare(right))) {
		const terms = activeTerms.filter((term) => sameScope(term.scope, scope));
		const prompts = activePrompts.filter((prompt) => sameScope(prompt.scope, scope));
		sections.push(
			`## ${heading}`,
			"",
			"### 术语",
			"",
			...(terms.length > 0
				? terms.map((term) => `- ${getEffectiveTermText(term)}${term.weight === 3 ? "" : ` {weight=${term.weight}}`}`)
				: ["<!-- 每行一个术语，例如：- Echo Notes {weight=3} -->"]),
			"",
			"### 固定 Prompt",
			"",
			...(prompts.length > 0
				? prompts.flatMap((prompt) => ["```text", prompt.text, "```", ""])
				: ["<!-- 使用独立的 text 代码块维护固定 Prompt。 -->", ""])
		);
	}
	return [
		"---",
		"echo_memory_type: transcription-enhancement-manual",
		"---",
		"",
		"# 术语与上下文",
		"",
		"此文件是人工配置事实源，可直接在 Obsidian 中编辑。只有约定作用域下的术语列表和 text 代码块会生效。",
		"",
		"> [!example] 配置示例（不会被读取）",
		"> 下方每行都以 `>` 开头，仅用于说明。要使用某段示例，请复制到文件末尾并去掉每行开头的 `>`。",
		">",
		"> ## 全局",
		">",
		"> ### 术语",
		">",
		"> - Echo Notes {weight=3}",
		"> - DashScope {weight=5}",
		">",
		"> ### 固定 Prompt",
		">",
		"> ```text",
		"> 这是产品评审录音，请保留中英文产品名和人名。",
		"> ```",
		">",
		"> ## 项目：Echo Notes",
		">",
		"> ### 术语",
		">",
		"> - Echo Memory {weight=3}",
		">",
		"> ## 人物：安邦",
		">",
		"> ### 术语",
		">",
		"> - 安邦 {weight=3}",
		">",
		"> ## 组织：OpenAI",
		">",
		"> ### 术语",
		">",
		"> - OpenAI {weight=3}",
		"",
		...(preservedNotes.trim() ? ["## 说明", "", preservedNotes.trim(), ""] : []),
		...sections,
		""
	].join("\n");
}

export function parseManualTranscriptionEnhancementDocument(
	content: string,
	filePath = "术语与上下文.md"
): TranscriptionEnhancementStore {
	const store = createTranscriptionEnhancementStore("");
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	let scope: TranscriptionEnhancementScope | null = null;
	let section: "terms" | "prompts" | null = null;
	let promptStart = 0;
	let promptLines: string[] | null = null;
	let termOrder = 0;
	let promptOrder = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const lineNumber = index + 1;
		const line = lines[index];
		if (promptLines) {
			if (/^```\s*$/.test(line)) {
				const text = promptLines.join("\n").trim();
				if (!text) {
					throw new TranscriptionEnhancementDocumentError(filePath, promptStart, "固定 Prompt 不能为空。");
				}
				if (text.length > TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS) {
					throw new TranscriptionEnhancementDocumentError(filePath, promptStart, `单条固定 Prompt 不得超过 ${TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS} 字符。`);
				}
				const id = `manual-prompt-${createStableFingerprint(`${formatScopeKey(scope!)}|${promptOrder}|${text}`)}`;
				store.prompts[id] = {
					id,
					text,
					scope: { ...scope! },
					status: "approved",
					updatedAt: "",
					history: [],
					sortOrder: promptOrder++
				};
				promptLines = null;
				continue;
			}
			promptLines.push(line);
			continue;
		}
		const scopeHeading = parseManualScopeHeading(line);
		if (scopeHeading) {
			scope = scopeHeading;
			section = null;
			continue;
		}
		if (/^##\s+/.test(line)) {
			scope = null;
			section = null;
			continue;
		}
		if (/^###\s+(术语|Terms)\s*$/i.test(line)) {
			section = scope ? "terms" : null;
			if (!scope) throw new TranscriptionEnhancementDocumentError(filePath, lineNumber, "术语段必须位于约定作用域标题下。");
			continue;
		}
		if (/^###\s+(固定\s*Prompt|Fixed\s+Prompts?)\s*$/i.test(line)) {
			section = scope ? "prompts" : null;
			if (!scope) throw new TranscriptionEnhancementDocumentError(filePath, lineNumber, "固定 Prompt 段必须位于约定作用域标题下。");
			continue;
		}
		if (/^#{1,6}\s+/.test(line)) {
			section = null;
			continue;
		}
		if (section === "terms" && /^\s*[-*+]\s+/.test(line)) {
			const raw = line.replace(/^\s*[-*+]\s+/, "").trim();
			const weightMatch = /\s+\{weight=([^}]+)\}\s*$/.exec(raw);
			if (raw.includes("{weight=") && !weightMatch) {
				throw new TranscriptionEnhancementDocumentError(filePath, lineNumber, "权重格式应为 {weight=3}。");
			}
			const text = (weightMatch ? raw.slice(0, weightMatch.index) : raw).trim();
			const weight = weightMatch ? Number(weightMatch[1]) : 3;
			if (!text) throw new TranscriptionEnhancementDocumentError(filePath, lineNumber, "术语不能为空。");
			if (!isWeight(weight)) throw new TranscriptionEnhancementDocumentError(filePath, lineNumber, "权重仅允许 1、2、3、4、5 或 50。");
			const id = `manual-term-${createStableFingerprint(`${formatScopeKey(scope!)}|${termOrder}|${text}`)}`;
			store.terms[id] = {
				id,
				text,
				weight,
				scope: { ...scope! },
				source: "manual",
				status: "approved",
				updatedAt: "",
				history: [],
				sortOrder: termOrder++
			};
			continue;
		}
		if (section === "prompts" && /^```text\s*$/i.test(line)) {
			promptLines = [];
			promptStart = lineNumber;
		}
	}
	if (promptLines) throw new TranscriptionEnhancementDocumentError(filePath, promptStart, "固定 Prompt 代码块缺少结束标记 ```。");
	return store;
}

export function renderTranscriptionEnhancementCandidateDocument(
	store: TranscriptionEnhancementStore = createTranscriptionEnhancementStore()
): string {
	return [
		"---",
		"echo_memory_type: transcription-enhancement-candidates",
		"---",
		"",
		"# 术语候选",
		"",
		"此文件记录 AI 术语候选、依据与审核历史。请通过 Echo Notes 的候选审核入口修改状态。",
		"",
		"> [!example] 候选示例（不会被读取）",
		"> 候选词：EchoNote",
		"> 审核修正：Echo Notes",
		"> 权重：3 · 作用域：项目 Echo Notes · 状态：待审核",
		"> 依据：来自已批准记忆的产品名。示例只用于理解审核字段，不会出现在审核弹窗或转写请求中。",
		"",
		renderTranscriptionEnhancementCandidateManagedBlock(store),
		""
	].join("\n");
}

export function parseTranscriptionEnhancementCandidateDocument(
	content: string,
	filePath = "术语候选.md"
): TranscriptionEnhancementStore {
	let errorLine = 1;
	try {
		const dataMarkerIndex = content.indexOf(TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_START);
		if (dataMarkerIndex >= 0) errorLine = getLineNumber(content, dataMarkerIndex);
		const json = extractManagedJson(
			content,
			TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_START,
			TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_END,
			TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_START,
			TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_END
		);
		let value: unknown;
		try {
			value = JSON.parse(json);
		} catch (error) {
			const position = /position\s+(\d+)/i.exec(getErrorMessage(error));
			const jsonStart = content.indexOf("{", Math.max(0, dataMarkerIndex));
			if (position && jsonStart >= 0) errorLine = getLineNumber(content, jsonStart + Number(position[1]));
			throw error;
		}
		if (!isTranscriptionEnhancementStore(value) || Object.values(value.terms).some((term) => term.source !== "memory")) {
			throw new Error("候选 Schema 不受支持或包含非 AI 候选数据。");
		}
		return value;
	} catch (error) {
		throw new TranscriptionEnhancementDocumentError(filePath, errorLine, `术语候选文件无法读取：${getErrorMessage(error)}`);
	}
}

export function updateTranscriptionEnhancementCandidateDocument(
	content: string,
	store: TranscriptionEnhancementStore
): string {
	return insertOrReplaceManagedBlock(
		content,
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_START,
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_END,
		renderTranscriptionEnhancementCandidateManagedBlock(store)
	);
}

export function mergeTranscriptionEnhancementStores(
	manual: TranscriptionEnhancementStore,
	candidates: TranscriptionEnhancementStore
): TranscriptionEnhancementStore {
	return {
		schemaVersion: TRANSCRIPTION_ENHANCEMENT_SCHEMA_VERSION,
		updatedAt: candidates.updatedAt || manual.updatedAt,
		terms: { ...candidates.terms, ...manual.terms },
		prompts: { ...manual.prompts }
	};
}

export function getTranscriptionEnhancementDocumentStats(
	manual: TranscriptionEnhancementStore,
	candidates: TranscriptionEnhancementStore
): TranscriptionEnhancementDocumentStats {
	const candidateTerms = Object.values(candidates.terms);
	return {
		manualTermCount: Object.keys(manual.terms).length,
		manualPromptCount: Object.keys(manual.prompts).length,
		pendingCandidateCount: candidateTerms.filter((term) => term.status === "pending").length,
		approvedCandidateCount: candidateTerms.filter((term) => term.status === "approved").length,
		rejectedCandidateCount: candidateTerms.filter((term) => term.status === "rejected").length,
		disabledCandidateCount: candidateTerms.filter((term) => term.status === "disabled").length
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
	const matchingTerms = (input.enableHotwords === false ? [] : Object.values(input.store.terms))
		.filter((term) => term.status === "approved" && scopeMatches(term.scope, input.scopes))
		.sort((left, right) => compareScopedRecords(left, right, input.scopes));
	const selectedByText = new Map<string, TranscriptionEnhancementTerm>();
	for (const term of matchingTerms) {
		const key = getEffectiveTermText(term).toLocaleLowerCase();
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

	const matchingPrompts = (input.enableContext === false ? [] : Object.values(input.store.prompts))
		.filter((prompt) => prompt.status === "approved" && scopeMatches(prompt.scope, input.scopes))
		.sort((left, right) => compareScopedRecords(left, right, input.scopes));
	const matchingAssertions = (input.enableContext === false ? [] : input.memoryAssertions)
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
		hotwords: selectedTerms.map((term) => ({ id: term.id, text: getEffectiveTermText(term), weight: term.weight })),
		contextText,
		scopeIds,
		memoryAssertionIds
	}));
	return {
		hotwords: selectedTerms.map((term) => ({ id: term.id, text: getEffectiveTermText(term), weight: term.weight })),
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

function renderTranscriptionEnhancementCandidateManagedBlock(store: TranscriptionEnhancementStore): string {
	const terms = Object.values(store.terms).sort((left, right) =>
		statusRank(left.status) - statusRank(right.status) ||
		right.updatedAt.localeCompare(left.updatedAt) ||
		left.id.localeCompare(right.id)
	);
	return [
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_START,
		"## 候选摘要",
		"",
		"| 候选词 | 生效词 | 权重 | 作用域 | 状态 | 依据 | 来源 |",
		"| --- | --- | ---: | --- | --- | --- | --- |",
		...(terms.length > 0
			? terms.map((term) => `| ${escapeTable(term.text)} | ${escapeTable(getEffectiveTermText(term))} | ${term.weight} | ${formatScope(term.scope)} | ${formatStatus(term.status)} | ${escapeTable(term.evidence ?? "")} | ${term.backlink ? `[[${escapeTable(term.backlink)}]]` : ""} |`)
			: ["| _暂无_ |  |  |  |  |  |  |"]),
		"",
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_START,
		"```json",
		JSON.stringify(store, null, 2),
		"```",
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_DATA_END,
		TRANSCRIPTION_ENHANCEMENT_CANDIDATE_MANAGED_END
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
	if (!("weight" in left) && !("weight" in right)) {
		const orderDifference = (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
		if (orderDifference !== 0) {
			return orderDifference;
		}
	}
	if ("source" in left && "source" in right && left.source !== right.source) {
		return left.source === "manual" ? -1 : 1;
	}
	if ("weight" in left && "weight" in right && left.weight !== right.weight) {
		return right.weight - left.weight;
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
		isStatus(value.status) && typeof value.updatedAt === "string" && Array.isArray(value.history) &&
		(value.effectiveText === undefined || typeof value.effectiveText === "string") &&
		(value.sortOrder === undefined || typeof value.sortOrder === "number");
}

function isPrompt(value: unknown): value is TranscriptionEnhancementPrompt {
	return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
		isScope(value.scope) && isStatus(value.status) && typeof value.updatedAt === "string" && Array.isArray(value.history) &&
		(value.sortOrder === undefined || typeof value.sortOrder === "number");
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

function extractManagedJson(
	content: string,
	managedStartMarker: string,
	managedEndMarker: string,
	dataStartMarker: string,
	dataEndMarker: string
): string {
	const managedStart = content.indexOf(managedStartMarker);
	const managedEnd = content.lastIndexOf(managedEndMarker);
	if (managedStart < 0 || managedEnd <= managedStart) throw new Error("缺少 Echo Memory 托管区块。");
	const managed = content.slice(managedStart, managedEnd + managedEndMarker.length);
	const dataStart = managed.indexOf(dataStartMarker);
	const dataEnd = managed.lastIndexOf(dataEndMarker);
	if (dataStart < 0 || dataEnd <= dataStart) throw new Error("缺少 JSON 数据区块。");
	return extractJsonObject(managed.slice(dataStart + dataStartMarker.length, dataEnd));
}

function parseManualScopeHeading(line: string): TranscriptionEnhancementScope | null {
	if (/^##\s+(?:全局|Global)\s*$/i.test(line)) return { type: "global" };
	const match = /^##\s+(项目|Project|人物|Person|组织|Organization)\s*[:：]\s*(.+?)\s*$/i.exec(line);
	if (!match) return null;
	const label = match[1].toLocaleLowerCase();
	const type: TranscriptionEnhancementScopeType = label === "项目" || label === "project"
		? "project"
		: label === "人物" || label === "person"
			? "person"
			: "organization";
	return { type, value: match[2].trim() };
}

function formatManualScopeHeading(scope: TranscriptionEnhancementScope): string {
	if (scope.type === "global") return "全局";
	return `${{ project: "项目", person: "人物", organization: "组织" }[scope.type]}：${scope.value ?? ""}`;
}

function formatScopeKey(scope: TranscriptionEnhancementScope): string {
	return scope.type === "global" ? "global" : `${scope.type}:${normalizeScopeValue(scope.value ?? "")}`;
}

function sameScope(left: TranscriptionEnhancementScope, right: TranscriptionEnhancementScope): boolean {
	return formatScopeKey(left) === formatScopeKey(right);
}

export function getEffectiveTranscriptionTermText(term: TranscriptionEnhancementTerm): string {
	return term.effectiveText?.trim() || term.text.trim();
}

function getEffectiveTermText(term: TranscriptionEnhancementTerm): string {
	return getEffectiveTranscriptionTermText(term);
}

function statusRank(status: TranscriptionEnhancementStatus): number {
	return { pending: 0, approved: 1, rejected: 2, disabled: 3 }[status];
}

function getLineNumber(content: string, index: number): number {
	return content.slice(0, Math.max(0, index)).split("\n").length;
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

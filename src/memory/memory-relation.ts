import { createStableFingerprint, normalizeEntityName } from "./memory-output";
import { MEMORY_CATEGORIES, type MemoryAssertion, type MemoryCandidatePackage } from "./memory-types";

export const MEMORY_RELATION_SCHEMA_VERSION = 1;
export const MEMORY_RELATION_FILE_NAME = "echo-memory-relations.json";
export const MEMORY_RELATION_MAX_RECORDS = 5_000;
export const MEMORY_RELATION_MAX_HISTORY = 100;
export const MEMORY_RELATION_STORE_MAX_CHARACTERS = 10_000_000;

export const MEMORY_RELATION_TYPES = ["conflicts", "supplements", "refines", "supersedes", "invalidates"] as const;
export type MemoryRelationType = (typeof MEMORY_RELATION_TYPES)[number];

export const MEMORY_RELATION_TYPE_LABELS: Record<MemoryRelationType, string> = {
	conflicts: "存在冲突",
	supplements: "补充说明",
	refines: "细化",
	supersedes: "替代旧记忆",
	invalidates: "作废旧记忆"
};

export type MemoryRelationStatus = "active" | "revoked";
export type MemoryRelationEventAction = "confirmed" | "revoked";

export interface MemoryRelationEndpoint {
	candidateId: string;
	candidatePath: string;
	reviewPath: string;
	assertionId: string;
	transcriptPath: string;
	subjectType: MemoryAssertion["subjectType"];
	subjectName: string;
	predicate: string;
	effectiveValue: string;
	observedAt: string;
	/** 仅用于关系管理界面的即时对比，不改变关系存储兼容性。 */
	evidenceQuote?: string;
	category?: MemoryAssertion["category"];
	confidence?: number;
}

export interface MemoryRelationEvent {
	at: string;
	action: MemoryRelationEventAction;
	note: string;
	source: MemoryRelationEndpoint;
	target: MemoryRelationEndpoint;
}

export interface MemoryRelationRecord {
	id: string;
	type: MemoryRelationType;
	status: MemoryRelationStatus;
	source: MemoryRelationEndpoint;
	target: MemoryRelationEndpoint;
	note: string;
	createdAt: string;
	updatedAt: string;
	history: MemoryRelationEvent[];
}

export interface MemoryRelationStore {
	schemaVersion: number;
	updatedAt: string;
	relations: Record<string, MemoryRelationRecord>;
}

export interface MemoryRelationAnnotation {
	relationId: string;
	type: MemoryRelationType;
	role: "source" | "target";
	counterpart: MemoryRelationEndpoint;
}

export interface MemoryRelationResolution {
	suppressedEndpointKeys: Set<string>;
	annotations: Map<string, MemoryRelationAnnotation[]>;
	applicableRelationIds: Set<string>;
	staleRelationIds: Set<string>;
}

export function getMemoryRelationStorePath(systemDir: string): string {
	return `${systemDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${MEMORY_RELATION_FILE_NAME}`;
}

export function createMemoryRelationEndpoint(input: {
	candidate: MemoryCandidatePackage;
	candidatePath: string;
	reviewPath: string;
	assertion: MemoryAssertion;
}): MemoryRelationEndpoint {
	return {
		candidateId: input.candidate.id,
		candidatePath: input.candidatePath,
		reviewPath: input.reviewPath,
		assertionId: input.assertion.id,
		transcriptPath: input.assertion.sourcePath,
		subjectType: input.assertion.subjectType,
		subjectName: input.assertion.subjectName,
		predicate: input.assertion.predicate,
		effectiveValue: input.assertion.value,
		observedAt: input.assertion.observedAt,
		evidenceQuote: input.assertion.evidenceQuote,
		category: input.assertion.category,
		confidence: input.assertion.confidence
	};
}

export function getMemoryRelationEndpointKey(endpoint: MemoryRelationEndpoint): string {
	return `${endpoint.candidatePath}\n${endpoint.assertionId}`;
}

export function createMemoryRelationStore(updatedAt = new Date().toISOString()): MemoryRelationStore {
	return {
		schemaVersion: MEMORY_RELATION_SCHEMA_VERSION,
		updatedAt,
		relations: {}
	};
}

export function renderMemoryRelationStore(store: MemoryRelationStore): string {
	const rendered = `${JSON.stringify(stripMemoryRelationEvidence(store), null, 2)}\n`;
	if (rendered.length > MEMORY_RELATION_STORE_MAX_CHARACTERS) {
		throw new Error("Echo Memory 关系存储超过 10,000,000 字符上限，请先归档历史关系。");
	}
	return rendered;
}

/**
 * 关系端点在运行时可以带有原文证据，方便关系管理界面对比；关系 JSON 只保存
 * 结构化元数据和回链，避免把原文在关系及其事件历史中重复持久化。
 *
 * 没有证据字段时返回原对象，便于调用方判断是否需要执行惰性清理。
 */
export function stripMemoryRelationEvidence(store: MemoryRelationStore): MemoryRelationStore {
	let changed = false;
	const stripEndpoint = (endpoint: MemoryRelationEndpoint): MemoryRelationEndpoint => {
		if (typeof endpoint.evidenceQuote !== "string") {
			return endpoint;
		}
		changed = true;
		const sanitized = { ...endpoint };
		delete sanitized.evidenceQuote;
		return sanitized;
	};
	const relations = Object.fromEntries(
		Object.entries(store.relations).map(([relationId, relation]) => {
			const source = stripEndpoint(relation.source);
			const target = stripEndpoint(relation.target);
			const history = relation.history.map((event) => {
				const eventSource = stripEndpoint(event.source);
				const eventTarget = stripEndpoint(event.target);
				return eventSource === event.source && eventTarget === event.target
					? event
					: { ...event, source: eventSource, target: eventTarget };
			});
			if (
				source === relation.source &&
				target === relation.target &&
				history.every((event, index) => event === relation.history[index])
			) {
				return [relationId, relation];
			}
			return [relationId, { ...relation, source, target, history }];
		})
	);
	return changed ? { ...store, relations } : store;
}

export function parseMemoryRelationStore(content: string): MemoryRelationStore | null {
	if (!content.trim() || content.length > MEMORY_RELATION_STORE_MAX_CHARACTERS) {
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
		value.schemaVersion !== MEMORY_RELATION_SCHEMA_VERSION ||
		!isNonEmptyString(value.updatedAt) ||
		!isRecord(value.relations)
	) {
		return null;
	}
	const entries = Object.entries(value.relations);
	if (entries.length > MEMORY_RELATION_MAX_RECORDS) {
		return null;
	}
	const relations: Array<[string, MemoryRelationRecord]> = [];
	for (const [relationId, relationValue] of entries) {
		const relation = parseMemoryRelationRecord(relationValue);
		if (!relation || relation.id !== relationId || relation.id !== getMemoryRelationId(relation.type, relation.source, relation.target)) {
			return null;
		}
		relations.push([relationId, relation]);
	}
	const store = {
		schemaVersion: MEMORY_RELATION_SCHEMA_VERSION,
		updatedAt: value.updatedAt,
		relations: Object.fromEntries(relations)
	};
	return hasValidActiveRelationGraph(store) ? store : null;
}

export function confirmMemoryRelation(
	store: MemoryRelationStore,
	type: MemoryRelationType,
	source: MemoryRelationEndpoint,
	target: MemoryRelationEndpoint,
	note: string,
	at = new Date().toISOString()
): MemoryRelationStore {
	if (!MEMORY_RELATION_TYPES.includes(type)) {
		throw new Error("记忆关系类型无效。");
	}
	if (!parseMemoryRelationEndpoint(source) || !parseMemoryRelationEndpoint(target)) {
		throw new Error("记忆关系端点内容无效或超过长度上限。");
	}
	if (note.length > 4_000) {
		throw new Error("记忆关系备注不能超过 4,000 字符。");
	}
	assertCompatibleEndpoints(source, target);
	const sourceKey = getMemoryRelationEndpointKey(source);
	const targetKey = getMemoryRelationEndpointKey(target);
	const relationId = getMemoryRelationId(type, source, target);
	const normalizedNote = note.trim();
	const activeForPair = Object.values(store.relations).find((relation) =>
		relation.status === "active" &&
		relation.id !== relationId &&
		hasSameEndpointPair(relation.source, relation.target, source, target)
	);
	if (activeForPair) {
		throw new Error(`这两条断言已有“${MEMORY_RELATION_TYPE_LABELS[activeForPair.type]}”关系，请先撤销。`);
	}
	if (
		(type === "supersedes" || type === "invalidates") &&
		createsSuppressionCycle(store, sourceKey, targetKey)
	) {
		throw new Error("该关系会形成环形替代或作废链，已拒绝保存。");
	}
	const existing = store.relations[relationId];
	if (
		existing?.status === "active" &&
		existing.note === normalizedNote &&
		matchesMemoryRelationEndpoint(existing.source, source) &&
		matchesMemoryRelationEndpoint(existing.target, target)
	) {
		return store;
	}
	const history = existing?.history ?? [];
	if (history.length >= MEMORY_RELATION_MAX_HISTORY) {
		throw new Error(`关系 ${relationId} 的事件历史已达到 ${MEMORY_RELATION_MAX_HISTORY} 条上限。`);
	}
	const event: MemoryRelationEvent = { at, action: "confirmed", note: normalizedNote, source, target };
	const relation: MemoryRelationRecord = {
		id: relationId,
		type,
		status: "active",
		source,
		target,
		note: normalizedNote,
		createdAt: existing?.createdAt ?? at,
		updatedAt: at,
		history: [...history, event]
	};
	return upsertMemoryRelation(store, relation, at);
}

export function revokeMemoryRelation(
	store: MemoryRelationStore,
	relationId: string,
	note: string,
	at = new Date().toISOString()
): MemoryRelationStore {
	if (note.length > 4_000) {
		throw new Error("关系撤销备注不能超过 4,000 字符。");
	}
	const existing = store.relations[relationId];
	if (!existing) {
		throw new Error(`找不到记忆关系：${relationId}`);
	}
	if (existing.status === "revoked") {
		return store;
	}
	if (existing.history.length >= MEMORY_RELATION_MAX_HISTORY) {
		throw new Error(`关系 ${relationId} 的事件历史已达到 ${MEMORY_RELATION_MAX_HISTORY} 条上限。`);
	}
	const event: MemoryRelationEvent = {
		at,
		action: "revoked",
		note: note.trim(),
		source: existing.source,
		target: existing.target
	};
	return upsertMemoryRelation(store, {
		...existing,
		status: "revoked",
		updatedAt: at,
		history: [...existing.history, event]
	}, at);
}

export function resolveMemoryRelations(
	store: MemoryRelationStore,
	approvedEndpoints: readonly MemoryRelationEndpoint[]
): MemoryRelationResolution {
	const approved = new Map(approvedEndpoints.map((endpoint) => [getMemoryRelationEndpointKey(endpoint), endpoint]));
	const resolution: MemoryRelationResolution = {
		suppressedEndpointKeys: new Set(),
		annotations: new Map(),
		applicableRelationIds: new Set(),
		staleRelationIds: new Set()
	};
	for (const relation of Object.values(store.relations)) {
		if (relation.status !== "active") {
			continue;
		}
		const sourceKey = getMemoryRelationEndpointKey(relation.source);
		const targetKey = getMemoryRelationEndpointKey(relation.target);
		const currentSource = approved.get(sourceKey);
		const currentTarget = approved.get(targetKey);
		if (
			!currentSource || !currentTarget ||
			!matchesMemoryRelationEndpoint(relation.source, currentSource) ||
			!matchesMemoryRelationEndpoint(relation.target, currentTarget)
		) {
			resolution.staleRelationIds.add(relation.id);
			continue;
		}
		resolution.applicableRelationIds.add(relation.id);
		addAnnotation(resolution.annotations, sourceKey, {
			relationId: relation.id,
			type: relation.type,
			role: "source",
			counterpart: relation.target
		});
		if (relation.type === "conflicts" || relation.type === "supplements" || relation.type === "refines") {
			addAnnotation(resolution.annotations, targetKey, {
				relationId: relation.id,
				type: relation.type,
				role: "target",
				counterpart: relation.source
			});
		} else {
			resolution.suppressedEndpointKeys.add(targetKey);
		}
	}
	return resolution;
}

export function matchesMemoryRelationEndpoint(
	stored: MemoryRelationEndpoint,
	current: MemoryRelationEndpoint
): boolean {
	return stored.candidateId === current.candidateId &&
		stored.candidatePath === current.candidatePath &&
		stored.reviewPath === current.reviewPath &&
		stored.assertionId === current.assertionId &&
		stored.transcriptPath === current.transcriptPath &&
		stored.subjectType === current.subjectType &&
		normalizeEntityName(stored.subjectName) === normalizeEntityName(current.subjectName) &&
		stored.predicate === current.predicate &&
		stored.effectiveValue === current.effectiveValue &&
		stored.observedAt === current.observedAt;
}

function upsertMemoryRelation(
	store: MemoryRelationStore,
	relation: MemoryRelationRecord,
	updatedAt: string
): MemoryRelationStore {
	if (!store.relations[relation.id] && Object.keys(store.relations).length >= MEMORY_RELATION_MAX_RECORDS) {
		throw new Error(`Echo Memory 关系记录已达到 ${MEMORY_RELATION_MAX_RECORDS} 条上限。`);
	}
	return {
		schemaVersion: MEMORY_RELATION_SCHEMA_VERSION,
		updatedAt,
		relations: { ...store.relations, [relation.id]: relation }
	};
}

export function getMemoryRelationId(
	type: MemoryRelationType,
	source: MemoryRelationEndpoint,
	target: MemoryRelationEndpoint
): string {
	const sourceKey = getMemoryRelationEndpointKey(source);
	const targetKey = getMemoryRelationEndpointKey(target);
	const endpointKeys = type === "conflicts" || type === "supplements"
		? [sourceKey, targetKey].sort()
		: [sourceKey, targetKey];
	return `relation-${createStableFingerprint([type, ...endpointKeys].join("\n"))}`;
}

function assertCompatibleEndpoints(source: MemoryRelationEndpoint, target: MemoryRelationEndpoint): void {
	if (getMemoryRelationEndpointKey(source) === getMemoryRelationEndpointKey(target)) {
		throw new Error("不能把断言与自身建立关系。");
	}
	if (
		source.subjectType !== target.subjectType ||
		normalizeEntityName(source.subjectName) !== normalizeEntityName(target.subjectName)
	) {
		throw new Error("只能在同一主体的已批准断言之间建立关系。");
	}
}

function hasSameEndpointPair(
	leftSource: MemoryRelationEndpoint,
	leftTarget: MemoryRelationEndpoint,
	rightSource: MemoryRelationEndpoint,
	rightTarget: MemoryRelationEndpoint
): boolean {
	const left = [getMemoryRelationEndpointKey(leftSource), getMemoryRelationEndpointKey(leftTarget)].sort();
	const right = [getMemoryRelationEndpointKey(rightSource), getMemoryRelationEndpointKey(rightTarget)].sort();
	return left[0] === right[0] && left[1] === right[1];
}

function createsSuppressionCycle(
	store: MemoryRelationStore,
	sourceKey: string,
	targetKey: string
): boolean {
	const edges = new Map<string, Set<string>>();
	for (const relation of Object.values(store.relations)) {
		if (relation.status !== "active" || (relation.type !== "supersedes" && relation.type !== "invalidates")) {
			continue;
		}
		const from = getMemoryRelationEndpointKey(relation.source);
		const to = getMemoryRelationEndpointKey(relation.target);
		const targets = edges.get(from) ?? new Set<string>();
		targets.add(to);
		edges.set(from, targets);
	}
	const pending = [targetKey];
	const visited = new Set<string>();
	while (pending.length > 0) {
		const current = pending.pop();
		if (!current || visited.has(current)) {
			continue;
		}
		if (current === sourceKey) {
			return true;
		}
		visited.add(current);
		pending.push(...(edges.get(current) ?? []));
	}
	return false;
}

function addAnnotation(
	annotations: Map<string, MemoryRelationAnnotation[]>,
	key: string,
	annotation: MemoryRelationAnnotation
): void {
	annotations.set(key, [...(annotations.get(key) ?? []), annotation]);
}

function parseMemoryRelationRecord(value: unknown): MemoryRelationRecord | null {
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!isMemoryRelationType(value.type) ||
		(value.status !== "active" && value.status !== "revoked") ||
		!isNonEmptyString(value.createdAt) ||
		!isNonEmptyString(value.updatedAt) ||
		typeof value.note !== "string" || value.note.length > 4_000 ||
		!Array.isArray(value.history) || value.history.length === 0 ||
		value.history.length > MEMORY_RELATION_MAX_HISTORY
	) {
		return null;
	}
	const source = parseMemoryRelationEndpoint(value.source);
	const target = parseMemoryRelationEndpoint(value.target);
	const history = value.history.map(parseMemoryRelationEvent);
	if (!source || !target || history.some((event) => event === null)) {
		return null;
	}
	try {
		assertCompatibleEndpoints(source, target);
	} catch {
		return null;
	}
	const relationId = value.id;
	const relationType = value.type;
	const events = history as MemoryRelationEvent[];
	const latest = events[events.length - 1];
	const expectedStatus = latest.action === "confirmed" ? "active" : "revoked";
	const latestConfirmation = [...events].reverse().find((event) => event.action === "confirmed");
	if (
		events[0].action !== "confirmed" ||
		!latestConfirmation ||
		value.status !== expectedStatus ||
		value.updatedAt !== latest.at ||
		value.createdAt !== events[0].at ||
		value.note !== latestConfirmation.note ||
		!matchesMemoryRelationEndpoint(source, latestConfirmation.source) ||
		!matchesMemoryRelationEndpoint(target, latestConfirmation.target) ||
		events.some((event) => getMemoryRelationId(relationType, event.source, event.target) !== relationId)
	) {
		return null;
	}
	return {
		id: relationId,
		type: relationType,
		status: value.status,
		source,
		target,
		note: value.note,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		history: events
	};
}

function parseMemoryRelationEndpoint(value: unknown): MemoryRelationEndpoint | null {
	if (
		!isRecord(value) ||
		!isBoundedString(value.candidateId, 512) ||
		!isBoundedString(value.candidatePath, 4_096) ||
		!isBoundedString(value.reviewPath, 4_096) ||
		!isBoundedString(value.assertionId, 512) ||
		!isBoundedString(value.transcriptPath, 4_096) ||
		!isSubjectType(value.subjectType) ||
		!isBoundedString(value.subjectName, 2_048) ||
		!isBoundedString(value.predicate, 2_048) ||
		!isBoundedString(value.effectiveValue, 24_000) ||
		!isBoundedString(value.observedAt, 256)
	) {
		return null;
	}
	const endpoint: MemoryRelationEndpoint = {
		candidateId: value.candidateId,
		candidatePath: value.candidatePath,
		reviewPath: value.reviewPath,
		assertionId: value.assertionId,
		transcriptPath: value.transcriptPath,
		subjectType: value.subjectType,
		subjectName: value.subjectName,
		predicate: value.predicate,
		effectiveValue: value.effectiveValue,
		observedAt: value.observedAt
	};
	if (value.evidenceQuote !== undefined) {
		if (!isBoundedString(value.evidenceQuote, 24_000)) {
			return null;
		}
		endpoint.evidenceQuote = value.evidenceQuote;
	}
	if (value.category !== undefined) {
		if (typeof value.category !== "string" || !MEMORY_CATEGORIES.includes(value.category as never)) {
			return null;
		}
		endpoint.category = value.category as MemoryAssertion["category"];
	}
	if (value.confidence !== undefined) {
		if (
			typeof value.confidence !== "number" ||
			!Number.isFinite(value.confidence) ||
			value.confidence < 0 ||
			value.confidence > 1
		) {
			return null;
		}
		endpoint.confidence = value.confidence;
	}
	return endpoint;
}

function parseMemoryRelationEvent(value: unknown): MemoryRelationEvent | null {
	if (
		!isRecord(value) ||
		!isBoundedString(value.at, 256) ||
		(value.action !== "confirmed" && value.action !== "revoked") ||
		typeof value.note !== "string" || value.note.length > 4_000
	) {
		return null;
	}
	const source = parseMemoryRelationEndpoint(value.source);
	const target = parseMemoryRelationEndpoint(value.target);
	if (!source || !target) {
		return null;
	}
	try {
		assertCompatibleEndpoints(source, target);
	} catch {
		return null;
	}
	return { at: value.at, action: value.action, note: value.note, source, target };
}

function hasValidActiveRelationGraph(store: MemoryRelationStore): boolean {
	const activePairs = new Set<string>();
	for (const relation of Object.values(store.relations)) {
		if (relation.status !== "active") {
			continue;
		}
		const pairKey = [
			getMemoryRelationEndpointKey(relation.source),
			getMemoryRelationEndpointKey(relation.target)
		].sort().join("\n---\n");
		if (activePairs.has(pairKey)) {
			return false;
		}
		activePairs.add(pairKey);
		if (
			(relation.type === "supersedes" || relation.type === "invalidates") &&
			createsSuppressionCycle(
				store,
				getMemoryRelationEndpointKey(relation.source),
				getMemoryRelationEndpointKey(relation.target)
			)
		) {
			return false;
		}
	}
	return true;
}

function isMemoryRelationType(value: unknown): value is MemoryRelationType {
	return typeof value === "string" && MEMORY_RELATION_TYPES.includes(value as MemoryRelationType);
}

function isSubjectType(value: unknown): value is MemoryAssertion["subjectType"] {
	return value === "user" || value === "person" || value === "organization" || value === "project";
}

function isBoundedString(value: unknown, maxLength: number): value is string {
	return isNonEmptyString(value) && value.length <= maxLength;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && Boolean(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

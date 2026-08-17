import { normalizeEntityName } from "../memory-output";
import {
	getMemoryRelationEndpointKey,
	type MemoryRelationEndpoint,
	type MemoryRelationType
} from "../memory-relation";

export type MemoryRelationSuggestionKind =
	| "repeated_evidence"
	| "potential_conflict"
	| "time_order";

export interface MemoryRelationSuggestion {
	kind: MemoryRelationSuggestionKind;
	source: MemoryRelationEndpoint;
	target: MemoryRelationEndpoint;
	reason: string;
	suggestedTypes: MemoryRelationType[];
	/** 仅用于展示，不会自动写入关系存储。 */
	authorityHint?: "A1_to_A2";
}

export function suggestMemoryRelations(
	current: MemoryRelationEndpoint,
	candidates: readonly MemoryRelationEndpoint[]
): MemoryRelationSuggestion[] {
	const suggestions: MemoryRelationSuggestion[] = [];
	const sameSubject = candidates.filter((candidate) =>
		normalizeEntityName(candidate.subjectName) === normalizeEntityName(current.subjectName) &&
		candidate.subjectType === current.subjectType &&
		getMemoryRelationEndpointKey(candidate) !== getMemoryRelationEndpointKey(current)
	);

	for (const candidate of sameSubject) {
		if (candidate.predicate.trim() !== current.predicate.trim()) {
			continue;
		}
		const sameValue = normalizeEntityName(candidate.effectiveValue) === normalizeEntityName(current.effectiveValue);
		const timeOrdered = compareObservedAt(current.observedAt, candidate.observedAt);
		if (sameValue) {
			suggestions.push({
				kind: "repeated_evidence",
				source: current,
				target: candidate,
				reason: "同一主体、相近属性且内容一致，可能属于重复证据或强化证据。",
				suggestedTypes: ["supplements"],
				authorityHint: "A1_to_A2"
			});
			continue;
		}
		const suggestedTypes: MemoryRelationType[] = timeOrdered > 0
			? ["supersedes", "refines", "invalidates", "conflicts"]
			: ["refines", "conflicts", "supplements"];
		suggestions.push({
			kind: "potential_conflict",
			source: current,
			target: candidate,
			reason: timeOrdered > 0
				? "同一主体、相近属性但内容不同，且当前记录发生在旧记录之后。"
				: "同一主体、相近属性但内容不同，可能存在冲突、细化或补充关系。",
			suggestedTypes
		});
	}

	for (const candidate of sameSubject) {
		if (candidate.predicate.trim() === current.predicate.trim()) {
			continue;
		}
		if (compareObservedAt(current.observedAt, candidate.observedAt) > 0) {
			suggestions.push({
				kind: "time_order",
				source: current,
				target: candidate,
				reason: "当前记录发生在历史记录之后，时间先后本身不能自动推出替代关系。",
				suggestedTypes: []
			});
		}
	}

	return suggestions;
}

function compareObservedAt(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return leftTime - rightTime;
	}
	if (Number.isFinite(leftTime)) {
		return 1;
	}
	if (Number.isFinite(rightTime)) {
		return -1;
	}
	return 0;
}

import {
	type ContextPurpose,
	type MemoryAssertion,
	type MemoryAuthority,
	type MemoryTier,
	type MemoryType,
	type MemoryValidity
} from "../memory-types";

export interface RankableMemory {
	assertion: MemoryAssertion;
	tier: MemoryTier;
	authority: MemoryAuthority;
	validity: MemoryValidity;
	id: string;
}

export interface MemoryRankedEntry<T extends RankableMemory> {
	entry: T;
	score: number;
	reasons: string[];
}

const TIER_WEIGHTS: Record<MemoryTier, number> = {
	core: 50,
	long_term: 30,
	working: 10
};

const AUTHORITY_WEIGHTS: Record<MemoryAuthority, number> = {
	inferred: 0,
	evidence_backed: 10,
	repeated_evidence: 20,
	user_confirmed: 30,
	core_declared: 40
};

const VALIDITY_WEIGHTS: Record<MemoryValidity, number> = {
	active: 20,
	uncertain: -10,
	historical: -20
};

const TYPE_WEIGHTS: Record<ContextPurpose, Partial<Record<MemoryType, number>>> = {
	general: {},
	planning: { goal: 15, decision: 12, belief: 10, experience: 8 },
	decision: { decision: 15, experience: 12, belief: 10, preference: 8 },
	retrospective: { experience: 15, belief: 10, decision: 8 },
	self_profile: { belief: 15, preference: 12, goal: 10, experience: 8 }
};

export function rankMemories<T extends RankableMemory>(
	entries: readonly T[],
	purpose: ContextPurpose
): Array<MemoryRankedEntry<T>> {
	return entries
		.map((entry) => scoreMemory(entry, purpose))
		.sort((left, right) =>
			right.score - left.score ||
			compareObservedAtDescending(left.entry.assertion.observedAt, right.entry.assertion.observedAt) ||
			left.entry.id.localeCompare(right.entry.id)
		);
}

function scoreMemory<T extends RankableMemory>(
	entry: T,
	purpose: ContextPurpose
): MemoryRankedEntry<T> {
	const tierWeight = TIER_WEIGHTS[entry.tier];
	const authorityWeight = AUTHORITY_WEIGHTS[entry.authority];
	const validityWeight = VALIDITY_WEIGHTS[entry.validity];
	const typeWeight = entry.assertion.memoryType
		? (TYPE_WEIGHTS[purpose][entry.assertion.memoryType] ?? 0)
		: 0;
	const score = tierWeight + authorityWeight + validityWeight + typeWeight;
	const reasons = [
		`层级 ${entry.tier} +${tierWeight}`,
		`权威 ${entry.authority} +${authorityWeight}`,
		`有效性 ${entry.validity} ${validityWeight >= 0 ? "+" : ""}${validityWeight}`,
		`类型权重 +${typeWeight}`
	];
	return { entry, score, reasons };
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
	return left.localeCompare(right);
}

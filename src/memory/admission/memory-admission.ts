import { normalizeEntityName } from "../memory-output";
import {
	type MemoryAdmissionDimensions,
	type MemoryAdmissionRecommendation,
	type MemoryAdmissionResult,
	type MemoryAssertion,
	type MemoryCategory,
	type MemoryTemporalScope,
	type MemoryType
} from "../memory-types";

export const MEMORY_ADMISSION_EVALUATOR_VERSION = "1";

const FUTURE_ORIENTED_TYPES: ReadonlySet<MemoryType | undefined> = new Set([
	"goal",
	"decision",
	"belief",
	"experience"
]);
const PERSISTENT_TYPES: ReadonlySet<MemoryType | undefined> = new Set([
	"decision",
	"belief",
	"preference",
	"experience"
]);
const HIGH_IMPACT_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
	"mission-goal",
	"decision-principle",
	"mental-model",
	"privacy-boundary"
]);
const MEDIUM_IMPACT_CATEGORIES: ReadonlySet<MemoryCategory> = new Set([
	"lesson",
	"idea-challenge",
	"relationship",
	"responsibility",
	"writing-collaboration",
	"background"
]);
const TRANSIENT_CATEGORIES: ReadonlySet<MemoryCategory> = new Set(["status", "other"]);

export interface MemoryAdmissionInput {
	assertion: MemoryAssertion;
	existingAssertions?: readonly MemoryAssertion[];
}

export function evaluateMemoryAdmission(
	input: MemoryAdmissionInput,
	at = new Date().toISOString()
): MemoryAdmissionResult {
	const { assertion } = input;
	const existing = input.existingAssertions ?? [];
	const dimensions: MemoryAdmissionDimensions = {
		futureRelevance: scoreFutureRelevance(assertion),
		personalSpecificity: scorePersonalSpecificity(assertion),
		persistence: scorePersistence(assertion),
		impact: scoreImpact(assertion),
		evidenceQuality: scoreEvidenceQuality(assertion),
		novelty: scoreNovelty(assertion, existing)
	};
	const score =
		dimensions.futureRelevance +
		dimensions.personalSpecificity +
		dimensions.persistence +
		dimensions.impact +
		dimensions.evidenceQuality +
		dimensions.novelty;
	return {
		score,
		recommendation: recommendAdmission(score),
		dimensions,
		reasons: buildAdmissionReasons(assertion, dimensions, score),
		evaluatorVersion: MEMORY_ADMISSION_EVALUATOR_VERSION,
		evaluatedAt: at
	};
}

export function recommendAdmission(score: number): MemoryAdmissionRecommendation {
	if (score <= 3) {
		return "low_priority";
	}
	if (score <= 7) {
		return "working_candidate";
	}
	if (score <= 10) {
		return "long_term_candidate";
	}
	return "core_candidate";
}

function scoreFutureRelevance(assertion: MemoryAssertion): number {
	const base = FUTURE_ORIENTED_TYPES.has(assertion.memoryType) ? 2 : 1;
	return TRANSIENT_CATEGORIES.has(assertion.category) ? Math.max(0, base - 1) : base;
}

function scorePersonalSpecificity(assertion: MemoryAssertion): number {
	if (assertion.subjectType === "user" || assertion.subjectType === "person") {
		return 2;
	}
	if (assertion.category === "other") {
		return 0;
	}
	return 1;
}

function scorePersistence(assertion: MemoryAssertion): number {
	let score = scoreTemporalPersistence(assertion.temporal?.scope);
	if (PERSISTENT_TYPES.has(assertion.memoryType)) {
		score += 1;
	}
	if (assertion.proposedTier === "core_candidate" || assertion.proposedTier === "long_term") {
		score += 1;
	}
	if (assertion.proposedTier === "working") {
		score -= 1;
	}
	return clampDimension(score);
}

function scoreTemporalPersistence(scope: MemoryTemporalScope | undefined): number {
	if (scope === "ongoing" || scope === "interval") {
		return 2;
	}
	if (scope === "point") {
		return 0;
	}
	return 1;
}

function scoreImpact(assertion: MemoryAssertion): number {
	if (HIGH_IMPACT_CATEGORIES.has(assertion.category)) {
		return 2;
	}
	if (MEDIUM_IMPACT_CATEGORIES.has(assertion.category)) {
		return 1;
	}
	return 0;
}

function scoreEvidenceQuality(assertion: MemoryAssertion): number {
	let score = assertion.confidence >= 0.75 ? 1 : 0;
	if (assertion.evidenceQuote.trim().length >= 20) {
		score += 1;
	}
	return clampDimension(score);
}

function scoreNovelty(
	assertion: MemoryAssertion,
	existing: readonly MemoryAssertion[]
): number {
	const sameSubjectPredicate = existing.filter((item) =>
		normalizeEntityName(item.subjectName) === normalizeEntityName(assertion.subjectName) &&
		item.predicate.trim() === assertion.predicate.trim()
	);
	if (sameSubjectPredicate.length === 0) {
		return 2;
	}
	const sameValue = sameSubjectPredicate.some((item) =>
		normalizeEntityName(item.value) === normalizeEntityName(assertion.value)
	);
	return sameValue ? 0 : 1;
}

function buildAdmissionReasons(
	assertion: MemoryAssertion,
	dimensions: MemoryAdmissionDimensions,
	score: number
): string[] {
	const reasons: string[] = [];
	if (FUTURE_ORIENTED_TYPES.has(assertion.memoryType)) {
		reasons.push("与长期目标、决策或经验有关");
	}
	if (dimensions.personalSpecificity >= 2) {
		reasons.push("与用户或具体人物直接相关");
	}
	if (dimensions.persistence >= 2) {
		reasons.push("具有跨时间的持续有效性");
	}
	if (dimensions.impact >= 2) {
		reasons.push("影响长期目标、原则或隐私边界");
	}
	if (dimensions.evidenceQuality >= 1) {
		reasons.push("有可定位的原始证据");
	}
	if (dimensions.novelty === 0) {
		reasons.push("与已有记忆重复");
	} else if (dimensions.novelty === 1) {
		reasons.push("与已有记忆存在潜在变化");
	} else {
		reasons.push("属于新的记忆内容");
	}
	if (reasons.length === 0) {
		reasons.push("当前信息对未来长期记忆的增益有限");
	}
	reasons.push(`准入评分 ${score}/12`);
	return reasons;
}

function clampDimension(value: number): number {
	return Math.max(0, Math.min(2, value));
}

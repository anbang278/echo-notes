import { insertOrReplaceManagedBlock } from "./memory-output";
import {
	MEMORY_REVIEW_SCHEMA_VERSION,
	MEMORY_REVIEW_STATUSES,
	type MemoryAssertion,
	type MemoryAssertionReview,
	type MemoryCandidatePackage,
	type MemoryReviewEvent,
	type MemoryReviewPackage,
	type MemoryReviewStatus,
	type MemoryReviewUpdate
} from "./memory-types";

export const MEMORY_REVIEW_MANAGED_START = "<!-- echo-memory-review:managed:start -->";
export const MEMORY_REVIEW_MANAGED_END = "<!-- echo-memory-review:managed:end -->";
export const MEMORY_REVIEW_DATA_START = "<!-- echo-memory-review-data:start -->";
export const MEMORY_REVIEW_DATA_END = "<!-- echo-memory-review-data:end -->";

export interface ApprovedMemoryAssertion {
	assertion: MemoryAssertion;
	review: MemoryReviewPackage["reviews"][string];
}

export function getMemoryReviewPath(candidatePath: string): string {
	if (!candidatePath.toLocaleLowerCase().endsWith(".md") || candidatePath.toLocaleLowerCase().endsWith(".review.md")) {
		throw new Error("记忆候选路径必须是非审核 Markdown 文件。");
	}
	return `${candidatePath.slice(0, -3)}.review.md`;
}

export function getCandidatePathFromReviewPath(reviewPath: string): string {
	if (!reviewPath.toLocaleLowerCase().endsWith(".review.md")) {
		throw new Error("审核路径必须以 .review.md 结尾。");
	}
	return `${reviewPath.slice(0, -".review.md".length)}.md`;
}

export function createMemoryReview(
	candidate: MemoryCandidatePackage,
	candidatePath: string,
	at = new Date().toISOString()
): MemoryReviewPackage {
	const reviews: MemoryReviewPackage["reviews"] = {};
	for (const assertion of candidate.assertions) {
		const event: MemoryReviewEvent = {
			at,
			status: "pending",
			effectiveValue: assertion.value,
			note: ""
		};
		reviews[assertion.id] = {
			assertionId: assertion.id,
			status: event.status,
			effectiveValue: event.effectiveValue,
			note: event.note,
			reviewedAt: at,
			history: [event]
		};
	}
	return {
		schemaVersion: MEMORY_REVIEW_SCHEMA_VERSION,
		candidateId: candidate.id,
		candidateFingerprint: candidate.fingerprint,
		candidatePath,
		updatedAt: at,
		reviews
	};
}

export function reconcileMemoryReview(
	review: MemoryReviewPackage,
	candidate: MemoryCandidatePackage,
	candidatePath: string,
	at = new Date().toISOString()
): MemoryReviewPackage {
	validateMemoryReviewForCandidate(review, candidate, candidatePath);
	const missing = candidate.assertions.filter((assertion) => !review.reviews[assertion.id]);
	if (missing.length === 0) {
		return review;
	}
	const created = createMemoryReview(candidate, candidatePath, at);
	return {
		...review,
		updatedAt: at,
		reviews: {
			...created.reviews,
			...review.reviews
		}
	};
}

export function applyMemoryReviewUpdates(
	review: MemoryReviewPackage,
	candidate: MemoryCandidatePackage,
	updates: readonly MemoryReviewUpdate[],
	at = new Date().toISOString()
): MemoryReviewPackage {
	const reconciled = reconcileMemoryReview(review, candidate, review.candidatePath, at);
	const nextReviews = { ...reconciled.reviews };
	const seen = new Set<string>();
	let changed = reconciled !== review;

	for (const update of updates) {
		if (seen.has(update.assertionId)) {
			throw new Error(`审核更新包含重复断言：${update.assertionId}`);
		}
		seen.add(update.assertionId);
		const assertion = candidate.assertions.find((item) => item.id === update.assertionId);
		const current = nextReviews[update.assertionId];
		if (!assertion || !current) {
			throw new Error(`审核更新引用了未知断言：${update.assertionId}`);
		}
		const effectiveValue = update.effectiveValue.trim();
		if (!effectiveValue) {
			throw new Error(`断言 ${update.assertionId} 的修正值不能为空。`);
		}
		const note = update.note.trim();
		if (
			current.status === update.status &&
			current.effectiveValue === effectiveValue &&
			current.note === note
		) {
			continue;
		}
		const event: MemoryReviewEvent = { at, status: update.status, effectiveValue, note };
		nextReviews[update.assertionId] = {
			assertionId: update.assertionId,
			status: update.status,
			effectiveValue,
			note,
			reviewedAt: at,
			history: [...current.history, event]
		};
		changed = true;
	}

	return changed
		? { ...reconciled, updatedAt: at, reviews: nextReviews }
		: reconciled;
}

export function getApprovedMemoryAssertions(
	candidate: MemoryCandidatePackage,
	review: MemoryReviewPackage,
	candidatePath: string
): ApprovedMemoryAssertion[] {
	validateMemoryReviewForCandidate(review, candidate, candidatePath);
	return candidate.assertions.flatMap((assertion) => {
		const assertionReview = review.reviews[assertion.id];
		if (!assertionReview || assertionReview.status !== "approved") {
			return [];
		}
		return [{
			assertion: { ...assertion, value: assertionReview.effectiveValue },
			review: assertionReview
		}];
	});
}

export function renderMemoryReview(
	review: MemoryReviewPackage,
	candidate: MemoryCandidatePackage
): string {
	return [
		"---",
		"echo_memory_type: review",
		`candidate: "[[${escapeYamlString(review.candidatePath)}]]"`,
		"---",
		"",
		`# 候选审核 · ${candidate.source.transcriptTitle}`,
		"",
		`候选包：[[${review.candidatePath}]]`,
		"",
		"## 人工补充",
		"",
		renderMemoryReviewManagedBlock(review, candidate),
		""
	].join("\n");
}

export function updateMemoryReviewDocument(
	content: string,
	review: MemoryReviewPackage,
	candidate: MemoryCandidatePackage
): string {
	return insertOrReplaceManagedBlock(
		content,
		MEMORY_REVIEW_MANAGED_START,
		MEMORY_REVIEW_MANAGED_END,
		renderMemoryReviewManagedBlock(review, candidate)
	);
}

export function parseMemoryReview(content: string): MemoryReviewPackage {
	const managedStartIndex = content.indexOf(MEMORY_REVIEW_MANAGED_START);
	const managedEndIndex = content.lastIndexOf(MEMORY_REVIEW_MANAGED_END);
	if (managedStartIndex === -1 || managedEndIndex <= managedStartIndex) {
		throw new Error("审核文件缺少 Echo Memory 托管区块。");
	}
	const managedBlock = content.slice(managedStartIndex, managedEndIndex + MEMORY_REVIEW_MANAGED_END.length);
	const startIndex = managedBlock.indexOf(MEMORY_REVIEW_DATA_START);
	const endIndex = managedBlock.lastIndexOf(MEMORY_REVIEW_DATA_END);
	if (startIndex === -1 || endIndex <= startIndex) {
		throw new Error("审核文件缺少 Echo Memory 数据区块。");
	}
	const block = managedBlock.slice(startIndex + MEMORY_REVIEW_DATA_START.length, endIndex);
	let parsed: unknown;
	try {
		parsed = JSON.parse(extractJsonObject(block)) as unknown;
	} catch (error) {
		throw new Error(`审核文件 JSON 无法读取：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (!isMemoryReviewPackage(parsed)) {
		throw new Error("审核文件 Schema 不受支持或内容无效。");
	}
	return parsed;
}

export function validateMemoryReviewForCandidate(
	review: MemoryReviewPackage,
	candidate: MemoryCandidatePackage,
	candidatePath: string
): void {
	if (
		review.candidateId !== candidate.id ||
		review.candidateFingerprint !== candidate.fingerprint ||
		review.candidatePath !== candidatePath
	) {
		throw new Error("审核文件与当前候选包不匹配。");
	}
	const assertionIds = new Set(candidate.assertions.map((assertion) => assertion.id));
	for (const assertionId of Object.keys(review.reviews)) {
		if (!assertionIds.has(assertionId)) {
			throw new Error(`审核文件包含当前候选包中不存在的断言：${assertionId}`);
		}
	}
}

export function countMemoryReviewStatuses(review: MemoryReviewPackage): Record<MemoryReviewStatus, number> {
	const counts: Record<MemoryReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
	for (const item of Object.values(review.reviews)) {
		counts[item.status] += 1;
	}
	return counts;
}

function renderMemoryReviewManagedBlock(review: MemoryReviewPackage, candidate: MemoryCandidatePackage): string {
	const counts = countMemoryReviewStatuses(review);
	const rows = candidate.assertions.length > 0
		? candidate.assertions.map((assertion) => {
			const item = review.reviews[assertion.id];
			return [
				item ? getReviewStatusLabel(item.status) : "待审核",
				assertion.subjectName,
				assertion.predicate,
				item?.effectiveValue ?? assertion.value,
				item?.note ?? ""
			].map(escapeTableCell).join(" | ");
		})
		: ["- | - | - | 无候选断言 | -"];
	return [
		MEMORY_REVIEW_MANAGED_START,
		"## 审核状态",
		"",
		`待审核 ${counts.pending} · 已批准 ${counts.approved} · 已拒绝 ${counts.rejected}`,
		"",
		"| 状态 | 主体 | 关系/属性 | 生效内容 | 审核备注 |",
		"| --- | --- | --- | --- | --- |",
		...rows.map((row) => `| ${row} |`),
		"",
		MEMORY_REVIEW_DATA_START,
		"```json",
		JSON.stringify(review, null, 2),
		"```",
		MEMORY_REVIEW_DATA_END,
		MEMORY_REVIEW_MANAGED_END
	].join("\n");
}

function isMemoryReviewPackage(value: unknown): value is MemoryReviewPackage {
	if (!isRecord(value) || value.schemaVersion !== MEMORY_REVIEW_SCHEMA_VERSION) {
		return false;
	}
	if (
		typeof value.candidateId !== "string" || !value.candidateId ||
		typeof value.candidateFingerprint !== "string" || !value.candidateFingerprint ||
		typeof value.candidatePath !== "string" || !value.candidatePath ||
		typeof value.updatedAt !== "string" || !value.updatedAt ||
		!isRecord(value.reviews)
	) {
		return false;
	}
	return Object.entries(value.reviews).every(([assertionId, review]) =>
		isAssertionReview(review) && review.assertionId === assertionId
	);
}

function isAssertionReview(value: unknown): value is MemoryAssertionReview {
	if (!isRecord(value) || typeof value.assertionId !== "string") {
		return false;
	}
	if (
		!isReviewStatus(value.status) ||
		typeof value.effectiveValue !== "string" || !value.effectiveValue.trim() ||
		typeof value.note !== "string" ||
		typeof value.reviewedAt !== "string" || !value.reviewedAt ||
		!Array.isArray(value.history) || value.history.length === 0
	) {
		return false;
	}
	if (!value.history.every((event) =>
		isRecord(event) &&
		typeof event.at === "string" && Boolean(event.at) &&
		isReviewStatus(event.status) &&
		typeof event.effectiveValue === "string" && Boolean(event.effectiveValue.trim()) &&
		typeof event.note === "string"
	)) {
		return false;
	}
	const latest = value.history[value.history.length - 1] as MemoryReviewEvent;
	return latest.at === value.reviewedAt &&
		latest.status === value.status &&
		latest.effectiveValue === value.effectiveValue &&
		latest.note === value.note;
}

function isReviewStatus(value: unknown): value is MemoryReviewStatus {
	return typeof value === "string" && MEMORY_REVIEW_STATUSES.includes(value as MemoryReviewStatus);
}

function extractJsonObject(text: string): string {
	const startIndex = text.indexOf("{");
	const endIndex = text.lastIndexOf("}");
	if (startIndex === -1 || endIndex <= startIndex) {
		throw new Error("审核文件托管区块中未找到 JSON 对象。");
	}
	return text.slice(startIndex, endIndex + 1);
}

function getReviewStatusLabel(status: MemoryReviewStatus): string {
	switch (status) {
		case "approved":
			return "已批准";
		case "rejected":
			return "已拒绝";
		default:
			return "待审核";
	}
}

function escapeTableCell(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
}

function escapeYamlString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

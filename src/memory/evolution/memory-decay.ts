export const WORKING_MEMORY_REVIEW_AFTER_DAYS = 30;

export interface WorkingMemoryReviewState {
	reviewAfter?: string;
	needsReview: boolean;
}

export function computeReviewAfter(
	approvedAt: string,
	days = WORKING_MEMORY_REVIEW_AFTER_DAYS
): string {
	const date = new Date(approvedAt);
	if (Number.isNaN(date.getTime())) {
		return approvedAt;
	}
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString();
}

export function getWorkingMemoryReviewState(
	review: {
		effectiveTier?: "working" | "long_term" | "core";
		reviewAfter?: string;
		reviewedAt: string;
	},
	now = new Date()
): WorkingMemoryReviewState {
	if (review.effectiveTier !== "working") {
		return { needsReview: false };
	}
	const reviewAfter = review.reviewAfter ?? computeReviewAfter(review.reviewedAt);
	const parsed = Date.parse(reviewAfter);
	if (!Number.isFinite(parsed)) {
		return { reviewAfter, needsReview: false };
	}
	return { reviewAfter, needsReview: parsed <= now.getTime() };
}

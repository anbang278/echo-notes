import { AnalysisError } from "./analysis-provider";
import { waitForRequestBeforeDeadline } from "../network/request-deadline";

export const ANALYSIS_TASK_TIMEOUT_MS = 15 * 60 * 1000;

export function createAnalysisDeadline(now = Date.now()): number {
	return now + ANALYSIS_TASK_TIMEOUT_MS;
}

export function waitForAnalysisResponse<T>(createRequest: () => Promise<T>, deadlineAt: number): Promise<T> {
	return waitForRequestBeforeDeadline(createRequest, {
		deadlineAt,
		createTimeoutError: createAnalysisTimeoutError
	});
}

function createAnalysisTimeoutError(): AnalysisError {
	return new AnalysisError("timeout", "AI 分析超过 15 分钟仍未完成，已自动停止等待，请稍后重试。");
}

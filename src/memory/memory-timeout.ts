import { waitForRequestBeforeDeadline } from "../network/request-deadline";

export const MEMORY_TASK_TIMEOUT_MS = 15 * 60 * 1000;

export function createMemoryDeadline(now = Date.now()): number {
	return now + MEMORY_TASK_TIMEOUT_MS;
}

export function waitForMemoryResponse<T>(
	createRequest: () => Promise<T>,
	deadlineAt: number,
	signal?: AbortSignal
): Promise<T> {
	return waitForRequestBeforeDeadline(createRequest, {
		deadlineAt,
		signal,
		createTimeoutError: () => new Error("记忆提取超过 15 分钟仍未完成，已自动停止等待，请重试。")
	});
}

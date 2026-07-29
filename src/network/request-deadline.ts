export interface RequestDeadlineOptions {
	deadlineAt: number;
	createTimeoutError: () => Error;
	signal?: AbortSignal;
}

export function waitForRequestBeforeDeadline<T>(
	createRequest: () => Promise<T>,
	options: RequestDeadlineOptions
): Promise<T> {
	const remainingMs = options.deadlineAt - Date.now();
	if (options.signal?.aborted) {
		return Promise.reject(getAbortReason(options.signal));
	}
	if (remainingMs <= 0) {
		return Promise.reject(options.createTimeoutError());
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const onAbort = (): void => finish(() => reject(getAbortReason(options.signal)));
		const cleanup = (): void => {
			window.clearTimeout(timeoutId);
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (settle: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			settle();
		};
		const timeoutId = window.setTimeout(() => {
			finish(() => reject(options.createTimeoutError()));
		}, remainingMs);

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
			return;
		}
		let request: Promise<T>;
		try {
			request = createRequest();
		} catch (error) {
			finish(() => reject(toRequestError(error)));
			return;
		}
		request.then(
			(value) => finish(() => resolve(value)),
			(error: unknown) => finish(() => reject(toRequestError(error)))
		);
	});
}

function getAbortReason(signal: AbortSignal | undefined): Error {
	return signal?.reason instanceof Error ? signal.reason : new Error("任务已取消。");
}

function toRequestError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

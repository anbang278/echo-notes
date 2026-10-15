/** Desktop loopback HTTP only. Implementations must never follow redirects. */
export interface LocalLoopbackResponse {
	status: number;
	headers: Record<string, string>;
	bodyText: string;
}

export interface LocalHttpRequest {
	method: string;
	headers?: Record<string, string>;
	body?: ArrayBuffer | Uint8Array | string | AsyncIterable<Uint8Array>;
	/** Required for streaming bodies; includes every multipart header and boundary. */
	contentLength?: number;
	timeoutMs?: number;
	connectTimeoutMs?: number;
	uploadIdleTimeoutMs?: number;
	responseTimeoutMs?: number;
	signal?: AbortSignal;
	onUploadProgress?: (bytes: number) => Promise<void> | void;
}

export interface LocalLoopbackHttp {
	request(url: string, init: LocalHttpRequest): Promise<LocalLoopbackResponse>;
}

export const LOCAL_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

/** Reject numeric shorthand, credentials and routing information before URL normalization. */
export function parseLoopbackUrl(target: string): URL {
	if (!/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(target)) {
		throw new Error("本地服务只支持 localhost、127.0.0.1 或 [::1] 回环地址。");
	}
	const parsed = new URL(target);
	if (parsed.username || parsed.password || parsed.search || parsed.hash) {
		throw new Error("本地服务地址不能包含凭据、查询参数或片段。");
	}
	return parsed;
}

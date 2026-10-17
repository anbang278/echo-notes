import type { OfflineTranscriptionProviderId } from "../settings/settings";
import { parseLoopbackUrl } from "../network/local-http";

/** 管理器规则2：探测结果四类。仅 connection-refused 允许启动。 */
export type LocalAsrProbeOutcome =
	| { kind: "ready" }
	| { kind: "responding"; status: number }
	| { kind: "connection-refused" }
	| { kind: "network-error" }
	| { kind: "invalid-config" };

/** 探测结果：ready/responding/connection-refused/network-error/invalid-config，可能携带 instance_id。 */
export type LocalAsrProbeResult = LocalAsrProbeOutcome & { instanceId?: string };

/** 受限就绪探测：单次最多2秒。实现必须复用 loopback 适配器边界（不跟随重定向）。 */
export type LocalAsrProbe = (url: string, signal?: AbortSignal) => Promise<LocalAsrProbeResult>;

export interface LocalAsrCommandSpec {
	provider: OfflineTranscriptionProviderId;
	baseUrl: string;
	readinessUrl: string;
	startCommand: string;
	stopCommand: string;
	workingDirectory: string;
	startupTimeoutSeconds: number;
	idleTimeoutSeconds: number;
	shutdownTimeoutSeconds: number;
}

export interface LocalAsrCommandHandle {
	/** 规则：超时或中止只终止本次命令句柄。 */
	cancel(): void;
	exited: Promise<{ code: number | null; signal: string | null }>;
}

export type LocalAsrCommandRunner = (spec: {
	command: string;
	workingDirectory: string;
	timeoutMs: number;
	signal?: AbortSignal;
}) => Promise<LocalAsrCommandHandle>;

export interface LocalAsrTimers {
	setTimeout(handler: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface LocalAsrClock {
	now(): number;
}

/** 脱敏通知 sink：只接收阶段与错误码，不接收命令或原始输出。 */
export interface LocalAsrNoticeSink {
	notify(stage: LocalAsrStage, errorCode?: string): void;
}

export type LocalAsrStage =
	| "probing" | "starting" | "waiting-ready" | "in-use" | "idle-countdown"
	| "stopping" | "stopped" | "stop-failed" | "external-service" | "blocked";

export const LOCAL_ASR_PROBE_INTERVAL_MS = 1000;
export const LOCAL_ASR_PROBE_TIMEOUT_MS = 2000;

/** 有限可测试错误分类（规则3）：保留 ECONNREFUSED 与 timeout/abort 的区别。 */
export type LocalAsrNetworkErrorKind = "connection-refused" | "timeout" | "aborted" | "unreachable";

export function classifyLocalAsrNetworkError(error: unknown): LocalAsrNetworkErrorKind {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string") {
		if (code.includes("ECONNREFUSED")) return "connection-refused";
		if (code === "ETIMEDOUT" || code === "ECONNABORTED" || code === "EAI_AGAIN" || code === "ENOTFOUND") return "timeout";
		if (code === "ERR_ABORTED" || code === "ABORT_ERR") return "aborted";
		if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EACCES") return "unreachable";
	}
	if (error instanceof DOMException && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return error.name === "AbortError" ? "aborted" : "timeout";
	}
	if (error instanceof Error) {
		if (error.name === "AbortError") return "aborted";
		if (/超时/.test(error.message) && /timeout|timed?\s*out/i.test(error.message)) return "timeout";
	}
	return "unreachable";
}

/** 用具体 HTTP 状态码把探测响应归类（规则2）。 */
export function classifyLocalAsrHttpStatus(status: number): LocalAsrProbeOutcome {
	if (status >= 200 && status < 300) return { kind: "ready" };
	if (status === 401 || status === 403 || status === 404 || status === 410) return { kind: "invalid-config" };
	if (status >= 300 && status < 400) return { kind: "invalid-config" };
	if (status === 503 || status === 429 || status >= 500) return { kind: "responding", status };
	return { kind: "responding", status };
}

/** 规范化回环 origin（localhost → 127.0.0.1）。 */
export function normalizeLocalAsrOrigin(baseUrl: string): string {
	const parsed = parseLoopbackUrl(baseUrl.trim());
	if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
	return parsed.origin;
}

/** 探测结果中若带实例ID，作为唯一托管证据（规则7）。 */
export function parseLocalAsrInstanceId(bodyText: string): string | undefined {
	try {
		const data = JSON.parse(bodyText) as unknown;
		if (typeof data === "object" && data !== null && !Array.isArray(data)) {
			const instanceId = (data as Record<string, unknown>).instance_id;
			if (typeof instanceId === "string" && instanceId.length > 0 && instanceId.length <= 128) return instanceId;
		}
	} catch { /* not JSON or no instance id: ownership evidence absent */ }
	return undefined;
}

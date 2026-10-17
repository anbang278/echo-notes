import { createLoopbackHttpAdapter } from "../network/loopback-http-adapter";
import type { LocalLoopbackHttp } from "../network/local-http";
import {
	LOCAL_ASR_PROBE_TIMEOUT_MS,
	classifyLocalAsrHttpStatus,
	parseLocalAsrInstanceId,
	type LocalAsrProbe,
	type LocalAsrProbeResult
} from "./lifecycle-contracts";
import { classifyLocalAsrNetworkError } from "./lifecycle-contracts";

/**
 * 就绪探测（规则2）：复用受限 loopback HTTP 适配器；单次最多2秒；
 * 200–299 就绪；任意HTTP响应=已有服务；连接超时/DNS 不得判作未启动；仅连接拒绝可启动。
 */
export function createLocalAsrProbe(http?: LocalLoopbackHttp): LocalAsrProbe {
	const adapter = http ?? createLoopbackHttpAdapter();
	return async (url, signal): Promise<LocalAsrProbeResult> => {
		if (!adapter) throw new Error("本地服务探测需要桌面版 Obsidian。");
		try {
			const response = await adapter.request(url, { method: "GET", timeoutMs: LOCAL_ASR_PROBE_TIMEOUT_MS, signal });
			const outcome = classifyLocalAsrHttpStatus(response.status);
			if (outcome.kind === "ready") {
				const instanceId = parseLocalAsrInstanceId(response.bodyText);
				return { ...outcome, instanceId };
			}
			return outcome;
		} catch (error) {
			const kind = classifyLocalAsrNetworkError(error);
			if (kind === "connection-refused") return { kind: "connection-refused" };
			if (kind === "aborted") return { kind: "network-error" };
			return { kind: "network-error" };
		}
	};
}

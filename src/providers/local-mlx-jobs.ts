import type { TFile } from "obsidian";
import type { OfflineTranscriptionProviderId, TranscriptionConfig } from "../settings/settings";
import { parseLocalMlxResult } from "./local-mlx-result";
import { getAudioMimeType } from "../audio/audio-detector";
import { captureLocalSource, verifyLocalSource, type LocalDesktopFiles } from "../network/local-desktop-files";
import { LOCAL_UPLOAD_CHUNK_BYTES, parseLoopbackUrl, type LocalLoopbackHttp, type LocalLoopbackResponse } from "../network/local-http";
import {
	TranscriptionError, createHttpTranscriptionError, type LocalTaskControlResult,
	type LocalTranscriptionPhase, type LocalTranscriptionTaskResume, type TranscriptionProgress, type TranscriptionUtterance
} from "./transcription-provider";

export type { LocalDesktopFiles, LocalVaultFileHandle } from "../network/local-desktop-files";
export { createDesktopFiles } from "../network/local-desktop-files";
export type { LocalLoopbackHttp, LocalLoopbackResponse } from "../network/local-http";
export type LocalMlxCheckpoint = LocalTranscriptionTaskResume;

const PREFIX = "/v1/local-asr";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_DURATION_SECONDS = 8 * 3600;
const STATES = new Set(["uploading", "queued", "running", "canceling", "succeeded", "failed", "canceled"]);

export interface LocalAsrCapabilities {
	instanceId: string;
	version: string;
	maxFileBytes: number;
	maxDurationSeconds: number;
	chunkBytes: number;
}

export function isEligibleLocalMlxEndpoint(baseUrl: string): boolean {
	try {
		const parsed = parseLoopbackUrl(baseUrl);
		return parsed.protocol === "http:" && ["18080", "18081"].includes(parsed.port)
			&& parsed.pathname.replace(/\/+$/, "") === "/v1";
	} catch { return false; }
}

export function normalizeLoopbackOrigin(baseUrl: string): string {
	const parsed = parseLoopbackUrl(baseUrl);
	if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
	return parsed.origin;
}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(response: LocalLoopbackResponse, context: string): Record<string, unknown> {
	if (response.status >= 300 && response.status < 400) {
		throw new TranscriptionError("api_error", `${context}：服务返回重定向（HTTP ${response.status}），已拒绝跟随。`, undefined, response.status);
	}
	if (response.status === 404 || response.status === 410) {
		throw new TranscriptionError("local_task_expired", "本地任务已过期或服务已重启；请重新上传音频。", undefined, response.status);
	}
	if (response.status < 200 || response.status >= 300) {
		throw createHttpTranscriptionError(context, response.status, response.bodyText);
	}
	let value: unknown;
	try { value = JSON.parse(response.bodyText); } catch { /* handled below */ }
	if (!object(value)) throw new TranscriptionError("invalid_response", `${context}：响应不是 JSON 对象。`);
	return value;
}

export class LocalMlxCapabilityCache {
	/** Probe on every invocation: a cached instance ID cannot establish safe recovery. */
	async probe(http: LocalLoopbackHttp, origin: string, model: string, signal?: AbortSignal, apiKey = ""): Promise<LocalAsrCapabilities | null> {
		let response: LocalLoopbackResponse;
		try {
			response = await http.request(`${origin}${PREFIX}/capabilities`, {
				method: "GET", headers: authorization(apiKey), timeoutMs: 3000, signal
			});
		} catch { throwIfAborted(signal); return null; }
		if (response.status >= 300 && response.status < 400) parseJson(response, "能力探测");
		if (response.status !== 200) return null;
		let data: unknown;
		try { data = JSON.parse(response.bodyText); } catch { return null; }
		if (!object(data) || data.service !== "echonotes-mlx-asr" || data.protocol !== 1
			|| typeof data.instance_id !== "string" || !data.instance_id || data.instance_id.length > 128
			|| !Array.isArray(data.models) || !data.models.every((m) => typeof m === "string") || !data.models.includes(model)
			|| typeof data.max_file_bytes !== "number" || !Number.isSafeInteger(data.max_file_bytes) || data.max_file_bytes <= 0
			|| typeof data.max_duration_seconds !== "number" || !Number.isInteger(data.max_duration_seconds) || data.max_duration_seconds <= 0
			|| typeof data.chunk_bytes !== "number" || !Number.isInteger(data.chunk_bytes) || data.chunk_bytes < 64 * 1024) return null;
		return {
			instanceId: data.instance_id, version: typeof data.version === "string" ? data.version : "",
			maxFileBytes: Math.min(data.max_file_bytes, MAX_FILE_BYTES),
			maxDurationSeconds: Math.min(data.max_duration_seconds, MAX_DURATION_SECONDS),
			chunkBytes: Math.min(data.chunk_bytes, LOCAL_UPLOAD_CHUNK_BYTES)
		};
	}
}

function authorization(key: string): Record<string, string> {
	return key.trim() ? { Authorization: `Bearer ${key.trim()}` } : {};
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new TranscriptionError("cancelled", "客户端连接已中断，本地任务恢复信息已保留。");
}

const fallbackTimers = { setTimeout, clearTimeout };
const timers = typeof window === "undefined" ? fallbackTimers : window;

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const abort = () => { timers.clearTimeout(timer); reject(new TranscriptionError("cancelled", "客户端连接已中断。")); };
		const timer = timers.setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
		signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function localConfigurationFingerprint(model: string, language: string, origin: string): Promise<string> {
	return sha256(new TextEncoder().encode(JSON.stringify(["local-openai-compatible", model, language, origin])));
}

async function sha256(bytes: Uint8Array): Promise<string> {
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer)))
		.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function jobUrl(task: LocalTranscriptionTaskResume): string {
	if (!isEligibleLocalMlxEndpoint(`${task.origin}/v1`) || !validId(task.jobId)) {
		throw new TranscriptionError("invalid_response", "本地任务恢复标识无效。");
	}
	return `${task.origin}${PREFIX}/jobs/${task.jobId}`;
}

interface JobStatus {
	state: string;
	stage: string;
	receivedBytes: number;
	processedSeconds?: number;
	totalSeconds?: number;
	error?: string;
}

function statusFrom(data: Record<string, unknown>, task: LocalTranscriptionTaskResume): JobStatus {
	if (data.instance_id !== task.instanceId) throw new TranscriptionError("local_task_expired", "本地服务已重启，请重新上传音频。");
	if (data.job_id !== task.jobId || typeof data.state !== "string" || !STATES.has(data.state)) {
		throw new TranscriptionError("invalid_response", "本地服务返回了不匹配的任务状态。");
	}
	const offset = data.received_bytes ?? data.next_offset;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > task.sourceSize
		|| (data.total_bytes !== undefined && data.total_bytes !== task.sourceSize)) {
		throw new TranscriptionError("invalid_response", "本地服务上传偏移或文件长度无效。");
	}
	const processedSeconds = typeof data.processed_seconds === "number" && Number.isFinite(data.processed_seconds) && data.processed_seconds >= 0 ? data.processed_seconds : undefined;
	const totalSeconds = typeof data.duration_seconds === "number" && Number.isFinite(data.duration_seconds) && data.duration_seconds >= 0 ? data.duration_seconds : undefined;
	return {
		state: data.state, stage: typeof data.stage === "string" ? data.stage : data.state,
		receivedBytes: offset, processedSeconds, totalSeconds,
		error: object(data.error) && typeof data.error.message === "string" ? data.error.message : undefined
	};
}

function phaseFor(status: JobStatus): LocalTranscriptionPhase {
	if (status.state === "succeeded") return "saving";
	if (status.state === "canceled") return "canceled";
	if (status.state === "canceling") return "canceling";
	if (status.state === "uploading") return "uploading";
	if (["decoding", "diarizing", "transcribing", "aligning"].includes(status.stage)) return status.stage as LocalTranscriptionPhase;
	return "waiting";
}

export interface LocalMlxTranscribeDeps {
	http: LocalLoopbackHttp;
	files: LocalDesktopFiles;
	capabilities: LocalAsrCapabilities;
	origin: string;
	apiKey: string;
	configurationFingerprint?: string;
	onProgress?: (event: TranscriptionProgress) => Promise<void> | void;
	onCheckpoint?: (task: LocalTranscriptionTaskResume) => Promise<void> | void;
	signal?: AbortSignal;
	checkpoint?: LocalTranscriptionTaskResume;
	/** Deterministic short waits for fault injection tests; production uses the defaults. */
	pollIntervalMs?: number;
	retryDelayMs?: number;
}

/** No DELETE on success, failure or abort. The caller owns durable save acknowledgement. */
export async function runLocalMlxJob(audioFile: TFile, config: TranscriptionConfig<OfflineTranscriptionProviderId>, deps: LocalMlxTranscribeDeps): Promise<{ text: string; utterances?: TranscriptionUtterance[]; localTask: LocalTranscriptionTaskResume }> {
	const { http, files, capabilities, signal, origin } = deps;
	throwIfAborted(signal);
	if (!isEligibleLocalMlxEndpoint(`${origin}/v1`)) throw new TranscriptionError("unsupported_audio", "本机任务服务地址无效。");
	const language = (config.language || "auto").toLowerCase();
	const fingerprint = deps.configurationFingerprint ?? await localConfigurationFingerprint(config.model, language, origin);
	const handle = await files.openVaultFile(audioFile.path);
	try {
		const source = await captureLocalSource(handle);
		if (source.sourceSize > Math.min(capabilities.maxFileBytes, MAX_FILE_BYTES)) {
			throw new TranscriptionError("file_too_large", `音频超过本机服务上限（${Math.min(capabilities.maxFileBytes, MAX_FILE_BYTES)} 字节）。`);
		}
		const previous = deps.checkpoint;
		if (previous && (previous.model !== config.model || previous.language !== language || previous.origin !== origin
			|| previous.configurationFingerprint !== fingerprint)) {
			throw new TranscriptionError("local_configuration_changed", "本地任务的转写配置已变化，请切回原配置继续，或取消旧任务后重新转写。");
		}
		if (previous && (previous.instanceId !== capabilities.instanceId)) {
			throw new TranscriptionError("local_task_expired", "本地服务已重启，请重新上传音频。");
		}
		if (previous && (previous.sourcePath !== audioFile.path || previous.sourceSize !== source.sourceSize
			|| previous.sourceMtimeMs !== source.sourceMtimeMs || previous.sourceIdentity !== source.sourceIdentity
			|| previous.protocol !== 1)) {
			throw new TranscriptionError("source_changed", "源音频已变化，不能续接旧任务；请取消旧任务后重新发起转写。");
		}
		if (previous?.cancelRequested) throw new TranscriptionError("cancelled", "本地任务正在取消，不能重新提交。");
		let task: LocalTranscriptionTaskResume = previous ? { ...previous } : {
			protocol: 1, origin, clientRequestId: crypto.randomUUID(), instanceId: capabilities.instanceId,
			sourcePath: audioFile.path, ...source, model: config.model, language,
			configurationFingerprint: fingerprint, confirmedOffset: 0, phase: "creating"
		};
		const persist = async (patch: Partial<LocalTranscriptionTaskResume> = {}) => {
			task = { ...task, ...patch }; await deps.onCheckpoint?.({ ...task }); throwIfAborted(signal);
		};
		const request = async (url: string, init: Parameters<LocalLoopbackHttp["request"]>[1]): Promise<LocalLoopbackResponse> => {
			for (let attempt = 0; ; attempt++) {
				throwIfAborted(signal);
				try {
					const response = await http.request(url, { ...init, headers: { ...authorization(deps.apiKey), ...init.headers }, timeoutMs: REQUEST_TIMEOUT_MS, signal });
					if (response.status < 500 || attempt >= 2) return response;
				} catch (error) {
					throwIfAborted(signal);
					if (error instanceof TranscriptionError || attempt >= 2) throw error;
				}
				await delay(deps.retryDelayMs ?? 1000, signal);
			}
		};
		const readStatus = async () => statusFrom(parseJson(await request(jobUrl(task), { method: "GET" }), "查询本地任务"), task);
		let status: JobStatus;
		if (!task.jobId) {
			// The idempotency key must be durable before the server can create any work.
			await persist();
			const created = parseJson(await request(`${origin}${PREFIX}/jobs`, {
				method: "POST", headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ client_request_id: task.clientRequestId, model: config.model, language,
					total_bytes: source.sourceSize, media_type: getAudioMimeType(audioFile) })
			}), "创建本地任务");
			if (!validId(created.job_id)) throw new TranscriptionError("invalid_response", "创建任务响应缺少合法 job_id。");
			task = { ...task, jobId: created.job_id };
			status = statusFrom(created, task);
		} else { status = await readStatus(); }
		await persist({ confirmedOffset: status.receivedBytes, phase: phaseFor(status) });
		const publish = async () => {
			await deps.onProgress?.({ type: "local-asr-progress", phase: task.phase,
				uploadedBytes: task.confirmedOffset, totalBytes: source.sourceSize,
				processedSeconds: status.processedSeconds, totalSeconds: status.totalSeconds });
			throwIfAborted(signal);
		};
		await publish();
		if (status.state === "uploading") {
			while (task.confirmedOffset < source.sourceSize) {
				throwIfAborted(signal); await verifyLocalSource(handle, source);
				const offset = task.confirmedOffset;
				const length = Math.min(capabilities.chunkBytes, LOCAL_UPLOAD_CHUNK_BYTES, source.sourceSize - offset);
				const payload = await handle.readRange(offset, length);
				if (payload.byteLength !== length) throw new TranscriptionError("source_changed", "音频读取不完整。");
				const digest = await sha256(payload);
				const response = await request(`${jobUrl(task)}/audio`, {
					method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Offset": String(offset),
						"X-Total-Bytes": String(source.sourceSize), "Content-Range": `bytes ${offset}-${offset + length - 1}/${source.sourceSize}`, "X-Chunk-SHA256": digest }, body: payload
				});
				if (response.status === 409) {
					status = await readStatus();
					// Only this exact block may have been acknowledged while its response was lost.
					if (status.state !== "uploading" || status.receivedBytes !== offset + length) {
						throw new TranscriptionError("invalid_response", "服务端上传偏移冲突，请保留任务并重试。");
					}
				} else {
					const ack = parseJson(response, "上传音频块");
					if (ack.next_offset !== offset + length) throw new TranscriptionError("invalid_response", "上传确认偏移不匹配。");
					if (ack.job_id !== undefined && ack.job_id !== task.jobId) throw new TranscriptionError("invalid_response", "上传确认任务不匹配。");
					if (ack.instance_id !== undefined && ack.instance_id !== task.instanceId) throw new TranscriptionError("local_task_expired", "本地服务已重启。");
					status = { ...status, receivedBytes: offset + length };
				}
				await persist({ confirmedOffset: status.receivedBytes, phase: "uploading" }); await publish();
			}
			await verifyLocalSource(handle, source);
			parseJson(await request(`${jobUrl(task)}/commit`, { method: "POST" }), "提交本地任务");
			await persist({ phase: "waiting" });
			status = await readStatus();
		}
		const deadline = Date.now() + 12 * 3600 * 1000;
		while (true) {
			throwIfAborted(signal);
			if (status.state === "failed") throw new TranscriptionError("api_error", `本地转写失败：${status.error ?? "未知错误"}`);
			if (status.state === "canceled" || status.state === "canceling") throw new TranscriptionError("cancelled", "本地任务已取消或正在取消。");
			await persist({ phase: phaseFor(status), confirmedOffset: status.receivedBytes }); await publish();
			if (status.state === "succeeded") {
				await verifyLocalSource(handle, source);
				const result = parseJson(await request(`${jobUrl(task)}/result`, { method: "GET" }), "取回本地结果");
				throwIfAborted(signal); await verifyLocalSource(handle, source);
				return { ...parseLocalMlxResult(result, config.model), localTask: { ...task } };
			}
			if (Date.now() >= deadline) throw new TranscriptionError("network_error", "本地任务等待超过 12 小时，恢复信息已保留。");
			await delay(deps.pollIntervalMs ?? 1500, signal); status = await readStatus();
		}
	} finally { await handle.close(); }
}

async function currentInstance(http: LocalLoopbackHttp, task: LocalTranscriptionTaskResume, apiKey: string): Promise<"same" | "restarted" | "unavailable"> {
	if (!isEligibleLocalMlxEndpoint(`${task.origin}/v1`)) return "unavailable";
	const caps = await new LocalMlxCapabilityCache().probe(http, task.origin, task.model, undefined, apiKey);
	return !caps ? "unavailable" : caps.instanceId === task.instanceId ? "same" : "restarted";
}

/** A 202 means cancellation requested, not confirmed. Call again to poll after reload. */
export async function cancelLocalMlxTask(http: LocalLoopbackHttp, source: LocalTranscriptionTaskResume, apiKey = ""): Promise<LocalTaskControlResult> {
	let task: LocalTranscriptionTaskResume = { ...source, cancelRequested: true, phase: "canceling" };
	try {
		const instance = await currentInstance(http, task, apiKey);
		if (instance === "unavailable") return { confirmed: false, task };
		if (instance === "restarted") return { confirmed: true, expired: true, task: { ...task, phase: "canceled" } };
		const headers = authorization(apiKey);
		if (!task.jobId) {
			// Recover an acknowledged-or-lost creation by its already persisted idempotency key.
			const created = parseJson(await http.request(`${task.origin}${PREFIX}/jobs`, { method: "POST", timeoutMs: REQUEST_TIMEOUT_MS,
				headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ client_request_id: task.clientRequestId,
					model: task.model, language: task.language, total_bytes: task.sourceSize,
					media_type: getAudioMimeType({ extension: task.sourcePath.split(".").pop() ?? "" }) }) }), "恢复待取消任务");
			if (!validId(created.job_id) || created.instance_id !== task.instanceId) return { confirmed: false, task };
			task = { ...task, jobId: created.job_id };
		}
		const response = await http.request(jobUrl(task), { method: "DELETE", headers, timeoutMs: REQUEST_TIMEOUT_MS });
		if ([204, 404, 410].includes(response.status)) return { confirmed: true, task: { ...task, phase: "canceled" } };
		if (response.status !== 202) return { confirmed: false, task };
		const status = statusFrom(parseJson(await http.request(jobUrl(task), { method: "GET", headers, timeoutMs: REQUEST_TIMEOUT_MS }), "确认取消"), task);
		return { confirmed: status.state === "canceled", task: { ...task, phase: status.state === "canceled" ? "canceled" : "canceling" } };
	} catch { return { confirmed: false, task }; }
}

/** Only call after durable transcript save. Failure cannot reverse an already saved result. */
export async function acknowledgeLocalMlxResult(http: LocalLoopbackHttp, source: LocalTranscriptionTaskResume, apiKey = ""): Promise<LocalTaskControlResult> {
	const task: LocalTranscriptionTaskResume = { ...source, phase: "cleanup-pending" };
	try {
		if (!task.jobId || task.cancelRequested) return { confirmed: false, task };
		const instance = await currentInstance(http, task, apiKey);
		if (instance === "unavailable") return { confirmed: false, task };
		if (instance === "restarted") return { confirmed: true, expired: true, task };
		const headers = authorization(apiKey);
		const response = await http.request(jobUrl(task), { method: "GET", headers, timeoutMs: REQUEST_TIMEOUT_MS });
		if ([404, 410].includes(response.status)) return { confirmed: true, task };
		const status = statusFrom(parseJson(response, "确认已保存结果"), task);
		if (status.state !== "succeeded") return { confirmed: false, task };
		const removed = await http.request(jobUrl(task), { method: "DELETE", headers, timeoutMs: REQUEST_TIMEOUT_MS });
		return { confirmed: [204, 404, 410].includes(removed.status), task };
	} catch { return { confirmed: false, task }; }
}

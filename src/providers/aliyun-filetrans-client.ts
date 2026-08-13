import { buildMultipartFormDataBody, createSafeUploadFileName } from "../network/multipart-form-data";
import type {
	RemoteTranscriptionTaskResume,
	RemoteTranscriptionTaskStatus,
	TranscriptionEnhancementSnapshot,
	TranscriptionUtterance,
	TranscriptionWord
} from "./transcription-provider";

export const ALIYUN_FILETRANS_TEMP_UPLOAD_MAX_BYTES = 1024 * 1024 * 1024;
export const ALIYUN_FILETRANS_CONTEXT_MAX_CHARACTERS = 400;
export const ALIYUN_FILETRANS_MAX_HOTWORDS = 2000;
export const ALIYUN_FILETRANS_MAX_SUPER_HOTWORDS = 50;
export const ALIYUN_FILETRANS_DIARIZATION_MAX_SECONDS = 2 * 60 * 60;

export interface AliyunHttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string | ArrayBuffer;
	throw?: boolean;
}

export interface AliyunHttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
	json: unknown;
	arrayBuffer: ArrayBuffer;
}

export type AliyunHttpRequester = (request: AliyunHttpRequest) => Promise<AliyunHttpResponse>;

export interface AliyunUploadPolicy {
	ossAccessKeyId: string;
	signature: string;
	policy: string;
	objectAcl: string;
	forbidOverwrite: string;
	uploadDir: string;
	uploadHost: string;
}

export interface AliyunFiletransSubmitOptions {
	baseUrl: string;
	apiKey: string;
	model: string;
	fileUrl: string;
	language?: string;
	diarizationEnabled: boolean;
	speakerCount?: number;
	enhancement?: TranscriptionEnhancementSnapshot;
}

export interface AliyunFiletransTaskQuery {
	task: RemoteTranscriptionTaskResume;
	requestId?: string;
	results?: AliyunFiletransSubtask[];
	retryAfter?: string;
}

export interface AliyunFiletransSubtask {
	subtaskStatus?: string;
	transcriptionUrl?: string;
	code?: string;
	message?: string;
}

export interface AliyunFiletransParsedResult {
	text: string;
	utterances?: TranscriptionUtterance[];
	raw: unknown;
}

export class AliyunFiletransProtocolError extends Error {
	status?: number;
	requestId?: string;
	remoteStatus?: RemoteTranscriptionTaskStatus;

	constructor(message: string, options: { status?: number; requestId?: string; remoteStatus?: RemoteTranscriptionTaskStatus } = {}) {
		super(message);
		this.name = "AliyunFiletransProtocolError";
		this.status = options.status;
		this.requestId = options.requestId;
		this.remoteStatus = options.remoteStatus;
	}
}

export function buildAliyunApiUrl(baseUrl: string, path: string): string {
	const url = new URL(baseUrl);
	const normalizedPath = path.startsWith("/") ? path : `/${path}`;
	return `${url.origin}${normalizedPath}`;
}

export function buildAliyunLegacyChatCompletionsUrl(baseUrl: string): string {
	const normalized = baseUrl.replace(/\/+$/, "");
	if (normalized.endsWith("/chat/completions")) {
		return normalized;
	}
	if (normalized.endsWith("/compatible-mode/v1")) {
		return `${normalized}/chat/completions`;
	}
	return `${new URL(baseUrl).origin}/compatible-mode/v1/chat/completions`;
}

export async function getAliyunTemporaryUploadPolicy(
	request: AliyunHttpRequester,
	baseUrl: string,
	apiKey: string,
	model: string
): Promise<AliyunUploadPolicy> {
	const response = await request({
		url: `${buildAliyunApiUrl(baseUrl, "/api/v1/uploads")}?action=getPolicy&model=${encodeURIComponent(model)}`,
		method: "GET",
		throw: false,
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json"
		}
	});
	if (!isSuccessful(response.status)) {
		throw createProtocolHttpError("获取百炼临时上传凭证失败", response);
	}
	const root = asRecord(response.json);
	const data = asRecord(root?.data);
	const parsed: AliyunUploadPolicy = {
		ossAccessKeyId: readString(data?.oss_access_key_id),
		signature: readString(data?.signature),
		policy: readString(data?.policy),
		objectAcl: readString(data?.x_oss_object_acl),
		forbidOverwrite: readString(data?.x_oss_forbid_overwrite),
		uploadDir: readString(data?.upload_dir),
		uploadHost: readString(data?.upload_host)
	};
	if (Object.values(parsed).some((value) => !value)) {
		throw new AliyunFiletransProtocolError("百炼临时上传凭证响应缺少 OSS 表单字段。", {
			requestId: readOptionalString(root?.request_id)
		});
	}
	return parsed;
}

export async function uploadAliyunTemporaryAudio(
	request: AliyunHttpRequester,
	policy: AliyunUploadPolicy,
	fileName: string,
	mimeType: string,
	audioBuffer: ArrayBuffer
): Promise<string> {
	if (audioBuffer.byteLength > ALIYUN_FILETRANS_TEMP_UPLOAD_MAX_BYTES) {
		throw new AliyunFiletransProtocolError("音频超过百炼临时上传 1GB 上限。");
	}
	const uploadFileName = createSafeUploadFileName(fileName);
	const key = `${policy.uploadDir.replace(/\/+$/, "")}/${uploadFileName}`;
	const boundary = `----EchoNotes${createBoundaryId()}`;
	const body = buildMultipartFormDataBody(boundary, [
		{ name: "OSSAccessKeyId", value: policy.ossAccessKeyId },
		{ name: "Signature", value: policy.signature },
		{ name: "policy", value: policy.policy },
		{ name: "x-oss-object-acl", value: policy.objectAcl },
		{ name: "x-oss-forbid-overwrite", value: policy.forbidOverwrite },
		{ name: "key", value: key },
		{ name: "success_action_status", value: "200" },
		{ name: "file", fileName: uploadFileName, contentType: mimeType, value: audioBuffer }
	]);
	const response = await request({
		url: policy.uploadHost,
		method: "POST",
		throw: false,
		headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
		body
	});
	if (!isSuccessful(response.status)) {
		throw createProtocolHttpError("上传音频到百炼临时存储失败", response);
	}
	return `oss://${key}`;
}

export function buildAliyunFiletransRequestBody(options: AliyunFiletransSubmitOptions): Record<string, unknown> {
	const vocabulary = Object.fromEntries(
		(options.enhancement?.hotwords ?? [])
			.slice(0, ALIYUN_FILETRANS_MAX_HOTWORDS)
			.map((hotword) => [hotword.text, hotword.weight])
	);
	const contextText = options.enhancement?.contextText?.trim().slice(0, ALIYUN_FILETRANS_CONTEXT_MAX_CHARACTERS);
	const input: Record<string, unknown> = { file_urls: [options.fileUrl] };
	if (contextText) {
		input.context = [{
			role: "user",
			content: [{ type: "input_text", text: contextText }]
		}];
	}
	const parameters: Record<string, unknown> = {
		diarization_enabled: options.diarizationEnabled
	};
	if (Object.keys(vocabulary).length > 0) {
		parameters.vocabulary = vocabulary;
	}
	if (options.diarizationEnabled && options.speakerCount !== undefined) {
		parameters.speaker_count = options.speakerCount;
	}
	if (options.language && options.language !== "auto") {
		parameters.language_hints = [options.language];
	}
	return {
		model: options.model,
		input,
		parameters
	};
}

export async function submitAliyunFiletransTask(
	request: AliyunHttpRequester,
	options: AliyunFiletransSubmitOptions,
	configurationFingerprint: string,
	submittedAt = Date.now()
): Promise<{ task: RemoteTranscriptionTaskResume; requestId?: string }> {
	const response = await request({
		url: buildAliyunApiUrl(options.baseUrl, "/api/v1/services/audio/asr/transcription"),
		method: "POST",
		throw: false,
		headers: {
			Authorization: `Bearer ${options.apiKey}`,
			"Content-Type": "application/json",
			"X-DashScope-Async": "enable",
			"X-DashScope-OssResourceResolve": "enable"
		},
		body: JSON.stringify(buildAliyunFiletransRequestBody(options))
	});
	if (!isSuccessful(response.status)) {
		throw createProtocolHttpError("提交百炼异步转写任务失败", response);
	}
	const root = asRecord(response.json);
	const output = asRecord(root?.output);
	const taskId = readOptionalString(output?.task_id);
	const status = normalizeRemoteTaskStatus(output?.task_status);
	if (!taskId || status !== "PENDING") {
		throw new AliyunFiletransProtocolError("百炼提交响应缺少 PENDING task_id。", {
			requestId: readOptionalString(root?.request_id)
		});
	}
	return {
		task: { taskId, status, submittedAt, configurationFingerprint },
		requestId: readOptionalString(root?.request_id)
	};
}

export async function queryAliyunFiletransTask(
	request: AliyunHttpRequester,
	baseUrl: string,
	apiKey: string,
	task: RemoteTranscriptionTaskResume
): Promise<AliyunFiletransTaskQuery> {
	const response = await withAliyunQuerySlot(() => request({
		url: buildAliyunApiUrl(baseUrl, `/api/v1/tasks/${encodeURIComponent(task.taskId)}`),
		method: "GET",
		throw: false,
		headers: { Authorization: `Bearer ${apiKey}` }
	}));
	if (!isSuccessful(response.status)) {
		throw createProtocolHttpError("查询百炼异步转写任务失败", response);
	}
	const root = asRecord(response.json);
	const output = asRecord(root?.output) ?? root;
	const status = normalizeRemoteTaskStatus(output?.task_status);
	const taskId = readOptionalString(output?.task_id) ?? task.taskId;
	const results = Array.isArray(output?.results)
		? output.results.map(parseSubtask).filter((value): value is AliyunFiletransSubtask => Boolean(value))
		: undefined;
	return {
		task: { ...task, taskId, status },
		requestId: readOptionalString(root?.request_id),
		results,
		retryAfter: readHeader(response.headers, "retry-after")
	};
}

export async function cancelAliyunFiletransTask(
	request: AliyunHttpRequester,
	baseUrl: string,
	apiKey: string,
	task: RemoteTranscriptionTaskResume
): Promise<{ requestId?: string }> {
	const response = await request({
		url: buildAliyunApiUrl(baseUrl, `/api/v1/tasks/${encodeURIComponent(task.taskId)}/cancel`),
		method: "POST",
		throw: false,
		headers: { Authorization: `Bearer ${apiKey}` }
	});
	if (!isSuccessful(response.status)) {
		throw createProtocolHttpError("取消百炼异步转写任务失败", response, task.status);
	}
	const root = asRecord(response.json);
	const output = asRecord(root?.output);
	if (!output || output.task_status !== "CANCELED") {
		throw new AliyunFiletransProtocolError("百炼取消接口未确认任务状态为 CANCELED。", {
			requestId: readOptionalString(root?.request_id),
			remoteStatus: normalizeRemoteTaskStatus(output?.task_status)
		});
	}
	return { requestId: readOptionalString(root?.request_id) };
}

export function getAliyunFiletransResultUrl(query: AliyunFiletransTaskQuery): string {
	if (query.task.status !== "SUCCEEDED") {
		throw new AliyunFiletransProtocolError(`百炼任务尚未成功：${query.task.status}`, {
			requestId: query.requestId,
			remoteStatus: query.task.status
		});
	}
	const results = query.results ?? [];
	const failedResult = results.find((result) => result.subtaskStatus !== "SUCCEEDED" || !result.transcriptionUrl);
	const result = results[0];
	if (!result?.transcriptionUrl || failedResult) {
		const detail = failedResult?.message || failedResult?.code || failedResult?.subtaskStatus || "缺少转写结果地址";
		throw new AliyunFiletransProtocolError(`百炼子任务失败：${detail}`, {
			requestId: query.requestId,
			remoteStatus: query.task.status
		});
	}
	return result.transcriptionUrl;
}

export async function downloadAliyunFiletransResult(
	request: AliyunHttpRequester,
	url: string
): Promise<AliyunFiletransParsedResult> {
	const response = await request({ url, method: "GET", throw: false });
	if (!isSuccessful(response.status)) {
		const prefix = response.status === 403 || response.status === 404
			? "百炼转写结果地址可能已过 24 小时有效期，请重新转写原音频"
			: "下载百炼转写结果失败";
		throw createProtocolHttpError(prefix, response);
	}
	return parseAliyunFiletransResult(response.json);
}

export function exceedsAliyunDiarizationDuration(wavByteLength: number): boolean {
	const pcmByteLength = Math.max(0, wavByteLength - 44);
	return pcmByteLength / (16_000 * 2) > ALIYUN_FILETRANS_DIARIZATION_MAX_SECONDS;
}

export function parseAliyunFiletransResult(value: unknown): AliyunFiletransParsedResult {
	const root = asRecord(value);
	const transcripts = Array.isArray(root?.transcripts) ? root.transcripts.map(asRecord).filter(Boolean) : [];
	const text = transcripts
		.map((transcript) => readOptionalString(transcript?.text))
		.filter((item): item is string => Boolean(item))
		.join("\n")
		.trim();
	if (!text) {
		throw new AliyunFiletransProtocolError("百炼转写结果缺少 transcripts[].text。");
	}
	const sentences = transcripts.flatMap((transcript) =>
		Array.isArray(transcript?.sentences) ? transcript.sentences.map(asRecord).filter(Boolean) : []
	);
	const hasSpeakers = sentences.some((sentence) =>
		typeof sentence?.speaker_id === "number" || typeof sentence?.speaker_id === "string"
	);
	const utterances = hasSpeakers
		? sentences.map((sentence, index): TranscriptionUtterance | null => {
			const sentenceText = readOptionalString(sentence?.text);
			if (!sentenceText) {
				return null;
			}
			const rawSpeaker = sentence?.speaker_id;
			const words = Array.isArray(sentence?.words)
				? sentence.words.map(parseWord).filter((item): item is TranscriptionWord => Boolean(item))
				: undefined;
			return {
				speakerId: typeof rawSpeaker === "number" || typeof rawSpeaker === "string" ? String(rawSpeaker) : String(index),
				text: sentenceText,
				startSeconds: readMilliseconds(sentence?.begin_time),
				endSeconds: readMilliseconds(sentence?.end_time),
				words: words?.length ? words : undefined
			};
		}).filter((item): item is TranscriptionUtterance => Boolean(item))
		: undefined;
	return { text, utterances: utterances?.length ? utterances : undefined, raw: value };
}

export function getAliyunPollDelayMs(attempt: number, retryAfterHeader?: string): number {
	const retryAfterSeconds = Number(retryAfterHeader);
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
		return Math.min(60_000, Math.max(2_000, Math.round(retryAfterSeconds * 1000)));
	}
	if (retryAfterHeader) {
		const retryAt = Date.parse(retryAfterHeader);
		if (Number.isFinite(retryAt)) {
			return Math.min(60_000, Math.max(2_000, retryAt - Date.now()));
		}
	}
	if (attempt < 3) {
		return 2_000;
	}
	if (attempt < 6) {
		return 5_000;
	}
	return 10_000;
}

export function waitForAliyunPollDelay(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) {
		return Promise.reject(getAbortReason(signal));
	}
	return new Promise((resolve, reject) => {
		const onAbort = (): void => {
			window.clearTimeout(timer);
			reject(signal ? getAbortReason(signal) : new Error("任务已停止。"));
		};
		const timer = window.setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function parseSubtask(value: unknown): AliyunFiletransSubtask | null {
	const record = asRecord(value);
	if (!record) {
		return null;
	}
	return {
		subtaskStatus: readOptionalString(record.subtask_status),
		transcriptionUrl: readOptionalString(record.transcription_url, 20_000),
		code: readOptionalString(record.code),
		message: readOptionalString(record.message, 4_000)
	};
}

function parseWord(value: unknown): TranscriptionWord | null {
	const record = asRecord(value);
	const text = readOptionalString(record?.text ?? record?.word);
	return text
		? {
			text,
			startSeconds: readMilliseconds(record?.begin_time),
			endSeconds: readMilliseconds(record?.end_time)
		}
		: null;
}

function normalizeRemoteTaskStatus(value: unknown): RemoteTranscriptionTaskStatus {
	return value === "PENDING" || value === "RUNNING" || value === "SUCCEEDED" || value === "FAILED" || value === "CANCELED"
		? value
		: "UNKNOWN";
}

function createProtocolHttpError(
	prefix: string,
	response: AliyunHttpResponse,
	remoteStatus?: RemoteTranscriptionTaskStatus
): AliyunFiletransProtocolError {
	const root = asRecord(response.json);
	const output = asRecord(root?.output);
	const code = readOptionalString(root?.code) ?? readOptionalString(output?.code);
	const message = readOptionalString(root?.message, 4_000) ?? readOptionalString(output?.message, 4_000) ?? response.text;
	return new AliyunFiletransProtocolError(
		`${prefix}：HTTP ${response.status}${code ? ` ${code}` : ""}${message ? ` ${message.slice(0, 4_000)}` : ""}`,
		{
			status: response.status,
			requestId: readOptionalString(root?.request_id),
			remoteStatus
		}
	);
}

function createBoundaryId(): string {
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
}

function readMilliseconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1000 : undefined;
}

function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function readOptionalString(value: unknown, maxLength = 1_000): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().slice(0, maxLength) : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function isSuccessful(status: number): boolean {
	return status >= 200 && status < 300;
}

const ALIYUN_QUERY_CONCURRENCY = 2;
let activeAliyunQueries = 0;
const aliyunQueryWaiters: Array<() => void> = [];

async function withAliyunQuerySlot<T>(run: () => Promise<T>): Promise<T> {
	if (activeAliyunQueries >= ALIYUN_QUERY_CONCURRENCY) {
		await new Promise<void>((resolve) => aliyunQueryWaiters.push(resolve));
	}
	activeAliyunQueries += 1;
	try {
		return await run();
	} finally {
		activeAliyunQueries -= 1;
		aliyunQueryWaiters.shift()?.();
	}
}

function readHeader(headers: Record<string, string>, name: string): string | undefined {
	const target = name.toLocaleLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (key.toLocaleLowerCase() === target && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function getAbortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("任务已停止。");
}

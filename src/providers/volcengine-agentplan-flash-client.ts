import {
	type RequestUrlParam,
	type RequestUrlResponse
} from "obsidian";
import {
	mapAgentPlanLanguage,
	type AgentPlanResponsePayload
} from "./volcengine-agentplan-protocol";
import {
	createNetworkTranscriptionError,
	TranscriptionError
} from "./transcription-provider";

export const AGENTPLAN_FLASH_RESOURCE_ID = "volc.bigasr.auc_turbo";
export const AGENTPLAN_FLASH_SUCCESS_CODE = "20000000";
export const AGENTPLAN_FLASH_MAX_AUDIO_BYTES = 100 * 1024 * 1024;
export const AGENTPLAN_FLASH_MAX_DURATION_SECONDS = 2 * 60 * 60;

export type AgentPlanFlashRequest = (
	request: RequestUrlParam | string
) => Promise<RequestUrlResponse>;

export interface AgentPlanFlashClientOptions {
	url: string;
	apiKey: string;
	language: string;
	audioBytes: Uint8Array;
	request: AgentPlanFlashRequest;
	createRequestId?: () => string;
}

export interface AgentPlanFlashClientResult {
	text: string;
	traceId?: string;
	raw: AgentPlanResponsePayload;
}

export async function transcribeAgentPlanFlash(
	options: AgentPlanFlashClientOptions
): Promise<AgentPlanFlashClientResult> {
	const requestId = options.createRequestId?.() ?? crypto.randomUUID();
	const audioData = encodeAudioBase64(options.audioBytes);
	const language = mapAgentPlanLanguage(options.language);
	let response: RequestUrlResponse;

	try {
		response = await options.request({
			url: options.url,
			method: "POST",
			throw: false,
			headers: {
				"Content-Type": "application/json",
				"X-Api-Key": options.apiKey,
				"X-Api-Resource-Id": AGENTPLAN_FLASH_RESOURCE_ID,
				"X-Api-Request-Id": requestId,
				"X-Api-Sequence": "-1"
			},
			body: JSON.stringify({
				user: {
					uid: "echo-notes"
				},
				audio: {
					data: audioData,
					...(language ? { language } : {})
				},
				request: {
					model_name: "bigmodel",
					enable_itn: true,
					enable_punc: true,
					enable_ddc: true,
					show_utterances: true,
					enable_speaker_info: true,
					ssd_version: "200"
				}
			})
		});
	} catch (error) {
		throw createNetworkTranscriptionError("火山引擎 AgentPlan 极速版", error);
	}

	const traceId = readHeader(response.headers, "x-tt-logid");
	const payload = tryReadResponsePayload(response);
	const serviceCode =
		readHeader(response.headers, "x-api-status-code") ??
		(typeof payload?.code === "number" ? String(payload.code) : undefined);
	const serviceMessage =
		readHeader(response.headers, "x-api-message") ??
		(typeof payload?.message === "string" ? payload.message : undefined);

	if (
		response.status < 200 ||
		response.status >= 300 ||
		(serviceCode !== undefined && serviceCode !== AGENTPLAN_FLASH_SUCCESS_CODE)
	) {
		throw createAgentPlanFlashResponseError({
			httpStatus: response.status,
			serviceCode,
			serviceMessage,
			responseText: response.text,
			traceId
		});
	}
	if (!payload) {
		throw new TranscriptionError(
			"invalid_response",
			"火山引擎 AgentPlan 极速版返回了无效 JSON。",
			traceId,
			response.status
		);
	}

	const text = payload.result?.text;
	if (typeof text !== "string" || !text.trim()) {
		throw new TranscriptionError(
			"invalid_response",
			"火山引擎 AgentPlan 极速版响应中缺少 result.text。",
			traceId
		);
	}

	return {
		text: text.trim(),
		traceId,
		raw: payload
	};
}

function tryReadResponsePayload(
	response: RequestUrlResponse
): AgentPlanResponsePayload | undefined {
	try {
		const payload = response.json as unknown;
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			return payload as AgentPlanResponsePayload;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function createAgentPlanFlashResponseError(input: {
	httpStatus: number;
	serviceCode?: string;
	serviceMessage?: string;
	responseText: string;
	traceId?: string;
}): TranscriptionError {
	const detail = [
		input.serviceCode ? `服务码 ${input.serviceCode}` : undefined,
		input.serviceMessage?.trim() || input.responseText.trim() || "未知错误"
	].filter(Boolean).join("：");
	const normalized = detail.toLowerCase();
	let code: ConstructorParameters<typeof TranscriptionError>[0] = "api_error";

	if (input.httpStatus === 401 || input.httpStatus === 403 || /unauthorized|forbidden|permission|鉴权|权限/.test(normalized)) {
		code = "authentication_failed";
	} else if (input.httpStatus === 413 || /too large|file size|超过.*100\s*mb/.test(normalized)) {
		code = "file_too_large";
	} else if (
		input.httpStatus === 429 ||
		input.serviceCode === "55000031" ||
		/rate.?limit|too many requests|server busy|服务繁忙|系统繁忙/.test(normalized)
	) {
		code = "rate_limited";
	} else if (/quota|billing|credit|balance|额度|余额/.test(normalized)) {
		code = "quota_exceeded";
	} else if (input.httpStatus >= 500) {
		code = "network_error";
	}

	const activationHint =
		code === "authentication_failed" &&
		/resource|auc_turbo|not enabled|not open|未开通|无权访问/.test(normalized)
			? " 请确认该 Key 已单独开通录音文件极速版资源 volc.bigasr.auc_turbo。"
			: "";
	return new TranscriptionError(
		code,
		`火山引擎 AgentPlan 极速版请求失败：HTTP ${input.httpStatus} ${detail}。${activationHint}`,
		input.traceId,
		input.httpStatus
	);
}

function encodeAudioBase64(bytes: Uint8Array): string {
	const nodeBuffer = (globalThis as typeof globalThis & {
		Buffer?: {
			from(input: Uint8Array): { toString(encoding: "base64"): string };
		};
	}).Buffer;
	if (nodeBuffer) {
		return nodeBuffer.from(bytes).toString("base64");
	}

	const chunkSize = 3 * 0x4000;
	const encodedChunks: string[] = [];
	for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
		const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
		let binary = "";
		for (let index = 0; index < chunk.byteLength; index += 1) {
			binary += String.fromCharCode(chunk[index]);
		}
		encodedChunks.push(btoa(binary));
	}
	return encodedChunks.join("");
}

function readHeader(
	headers: Record<string, string>,
	name: string
): string | undefined {
	const key = Object.keys(headers).find(
		(candidate) => candidate.toLowerCase() === name.toLowerCase()
	);
	return key ? headers[key] : undefined;
}

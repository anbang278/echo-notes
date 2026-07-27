import {
	buildAgentPlanFullRequestPayload,
	encodeAgentPlanAudioRequest,
	encodeAgentPlanFullRequest,
	getAgentPlanDefiniteResult,
	getAgentPlanWavDurationSeconds,
	parseAgentPlanResponseFrame,
	splitAgentPlanAudio,
	type AgentPlanRequestMode,
	type AgentPlanResponsePayload
} from "./volcengine-agentplan-protocol";
import { TranscriptionError, type TranscriptionUtterance } from "./transcription-provider";

export const AGENTPLAN_RESOURCE_ID = "volc.seedasr.sauc.duration";
export const AGENTPLAN_PACKET_DURATION_MS = 200;
export const AGENTPLAN_HANDSHAKE_TIMEOUT_MS = 15000;
export const AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS = 30000;
export const AGENTPLAN_PROGRESS_INTERVAL_MS = 2000;

export interface AgentPlanSocket {
	onOpen(listener: () => void): void;
	onMessage(listener: (data: Uint8Array) => void): void;
	onError(listener: (error: unknown) => void): void;
	onClose(listener: (code: number, reason: string) => void): void;
	onUpgrade(listener: (headers: Record<string, string | string[] | undefined>) => void): void;
	send(data: Uint8Array): void;
	close(): void;
	terminate(): void;
	getBufferedAmount?(): number;
}

export type AgentPlanSocketFactory = (url: string, headers: Record<string, string>) => AgentPlanSocket;

export interface AgentPlanClientOptions {
	url: string;
	apiKey: string;
	language: string;
	requestMode?: AgentPlanRequestMode;
	wavBytes: Uint8Array;
	createSocket: AgentPlanSocketFactory;
	sleep?: (milliseconds: number) => Promise<void>;
	now?: () => number;
	handshakeTimeoutMs?: number;
	finalResponseTimeoutMs?: number;
	onProgress?: (progress: AgentPlanClientProgress) => Promise<void> | void;
}

export interface AgentPlanClientProgress {
	text: string;
	utterances?: TranscriptionUtterance[];
	processedSeconds: number;
	totalSeconds: number;
	traceId?: string;
}

export interface AgentPlanClientResult {
	text: string;
	traceId?: string;
	raw: AgentPlanResponsePayload;
}

export class AgentPlanClientError extends Error {
	serverCode?: number;
	traceId?: string;

	constructor(message: string, serverCode?: number, traceId?: string) {
		super(message);
		this.name = "AgentPlanClientError";
		this.serverCode = serverCode;
		this.traceId = traceId;
	}
}

export function normalizeAgentPlanError(error: unknown): TranscriptionError {
	if (error instanceof TranscriptionError) {
		return error;
	}
	if (!(error instanceof AgentPlanClientError)) {
		return new TranscriptionError(
			"network_error",
			`火山引擎 AgentPlan ASR 调用失败：${error instanceof Error ? error.message : String(error)}`
		);
	}

	const normalized = error.message.toLowerCase();
	let code: ConstructorParameters<typeof TranscriptionError>[0] = "api_error";
	let prefix = "火山引擎 AgentPlan ASR 调用失败";
	if (/401|403|unauthorized|api key|authentication|permission/.test(normalized)) {
		code = "authentication_failed";
		prefix = "火山引擎 AgentPlan 鉴权失败";
	} else if (/429|rate.?limit|server busy|55000031/.test(normalized)) {
		code = "rate_limited";
		prefix = "火山引擎 AgentPlan 请求受限";
	} else if (/quota|billing|credit|balance|exceeded/.test(normalized)) {
		code = "quota_exceeded";
		prefix = "火山引擎 AgentPlan 额度不足";
	} else if (/timeout|超时|websocket|异常关闭/.test(normalized)) {
		code = "network_error";
		prefix = "火山引擎 AgentPlan 连接失败";
	} else if (/result\.text|invalid json|响应帧/.test(normalized)) {
		code = "invalid_response";
		prefix = "火山引擎 AgentPlan 响应无效";
	}
	return new TranscriptionError(code, `${prefix}：${error.message}`, error.traceId);
}

export async function transcribeAgentPlanWav(options: AgentPlanClientOptions): Promise<AgentPlanClientResult> {
	const requestId = crypto.randomUUID();
	const headers = {
		"X-Api-Key": options.apiKey,
		"X-Api-Resource-Id": AGENTPLAN_RESOURCE_ID,
		"X-Api-Request-Id": requestId,
		"X-Api-Connect-Id": requestId,
		"X-Api-Sequence": "-1"
	};
	const socket = options.createSocket(options.url, headers);
	const sleep = options.sleep ?? delay;
	const now = options.now ?? (() => performance.now());
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? AGENTPLAN_HANDSHAKE_TIMEOUT_MS;
	const finalResponseTimeoutMs = options.finalResponseTimeoutMs ?? AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS;
	let traceId: string | undefined;
	let settled = false;
	let audioStarted = false;
	let latestPayload: AgentPlanResponsePayload = {};
	let latestText = "";
	let processedSeconds = 0;
	let lastProgressSeconds = -Infinity;
	let lastDefiniteSignature = "";
	const totalSeconds = getAgentPlanWavDurationSeconds(options.wavBytes);
	let progressQueue = Promise.resolve();
	let handshakeTimer: number | undefined;
	let finalResponseTimer: number | undefined;

	return new Promise<AgentPlanClientResult>((resolve, reject) => {
		const cleanup = (): void => {
			if (handshakeTimer) {
				window.clearTimeout(handshakeTimer);
			}
			if (finalResponseTimer) {
				window.clearTimeout(finalResponseTimer);
			}
		};

		const fail = (error: AgentPlanClientError): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			error.traceId ??= traceId;
			socket.terminate();
			reject(error);
		};

		const emitProgress = (force = false): void => {
			if (!options.onProgress || settled) {
				return;
			}
			const definiteResult = getAgentPlanDefiniteResult(latestPayload);
			const signature = JSON.stringify({
				text: definiteResult.text,
				utterances: definiteResult.utterances
			});
			const hasNewDefiniteResult = signature !== lastDefiniteSignature && Boolean(definiteResult.text);
			const hasProgressInterval =
				processedSeconds >= totalSeconds ||
				processedSeconds - lastProgressSeconds >= AGENTPLAN_PROGRESS_INTERVAL_MS / 1000;
			if (!force && !hasNewDefiniteResult && !hasProgressInterval) {
				return;
			}

			lastDefiniteSignature = signature;
			lastProgressSeconds = processedSeconds;
			const progress: AgentPlanClientProgress = {
				text: definiteResult.text,
				utterances: definiteResult.utterances,
				processedSeconds: Math.min(processedSeconds, totalSeconds),
				totalSeconds,
				traceId
			};
			progressQueue = progressQueue
				.then(() => options.onProgress?.(progress))
				.catch(() => undefined);
		};

		const succeed = async (): Promise<void> => {
			if (settled) {
				return;
			}
			if (!latestText) {
				fail(new AgentPlanClientError("AgentPlan ASR 响应中缺少 result.text。", undefined, traceId));
				return;
			}
			emitProgress(true);
			settled = true;
			cleanup();
			await progressQueue;
			socket.close();
			resolve({ text: latestText, traceId, raw: latestPayload });
		};

		const sendAudio = async (): Promise<void> => {
			try {
				const packets = splitAgentPlanAudio(options.wavBytes, AGENTPLAN_PACKET_DURATION_MS);
				if (packets.length === 0) {
					throw new AgentPlanClientError("待转写 WAV 音频为空。", undefined, traceId);
				}
				const streamStartedAt = now();
				for (let packetIndex = 0; packetIndex < packets.length; packetIndex += 1) {
					if (settled) {
						return;
					}
					const isLastPackage = packetIndex === packets.length - 1;
					const frame = await encodeAgentPlanAudioRequest(packets[packetIndex], packetIndex + 2, isLastPackage);
					socket.send(frame);
					processedSeconds = Math.min((packetIndex + 1) * AGENTPLAN_PACKET_DURATION_MS / 1000, totalSeconds);
					emitProgress(isLastPackage);
					if (!isLastPackage) {
						const nextPacketTargetAt =
							streamStartedAt + (packetIndex + 1) * AGENTPLAN_PACKET_DURATION_MS;
						await sleep(Math.max(0, nextPacketTargetAt - now()));
					}
				}
				if (!settled) {
					finalResponseTimer = window.setTimeout(
						() => fail(new AgentPlanClientError("AgentPlan ASR 等待最终识别结果超时。", undefined, traceId)),
						finalResponseTimeoutMs
					);
				}
			} catch (error) {
				fail(
					error instanceof AgentPlanClientError
						? error
						: new AgentPlanClientError(error instanceof Error ? error.message : String(error), undefined, traceId)
				);
			}
		};

		handshakeTimer = window.setTimeout(
			() => fail(new AgentPlanClientError("AgentPlan ASR WebSocket 连接超时。", undefined, traceId)),
			handshakeTimeoutMs
		);

		socket.onUpgrade((headers) => {
			traceId = readHeader(headers, "x-tt-logid") ?? traceId;
		});
		socket.onOpen(() => {
			void encodeAgentPlanFullRequest(
				buildAgentPlanFullRequestPayload(
					options.language,
					"wav",
					options.requestMode ?? "async"
				)
			)
				.then((frame) => socket.send(frame))
				.catch((error) => fail(new AgentPlanClientError(error instanceof Error ? error.message : String(error), undefined, traceId)));
		});
		socket.onMessage((data) => {
			void parseAgentPlanResponseFrame(data)
				.then((frame) => {
					if (settled) {
						return;
					}
					if (frame.messageType === "error") {
						const detail = frame.payload?.message ?? frame.rawPayloadText ?? "未知错误";
						fail(new AgentPlanClientError(`AgentPlan ASR 服务端错误 ${frame.errorCode ?? ""}：${detail}`, frame.errorCode, traceId));
						return;
					}
					if (frame.payload) {
						const responseText = frame.payload.result?.text?.trim();
						if (responseText) {
							latestText = responseText;
							latestPayload = frame.payload;
						} else if (!latestText) {
							latestPayload = frame.payload;
						}
						emitProgress();
					}
					if (!audioStarted) {
						audioStarted = true;
						if (handshakeTimer) {
							window.clearTimeout(handshakeTimer);
						}
						void sendAudio();
					}
					if (frame.isLastPackage) {
						void succeed();
					}
				})
				.catch((error) => fail(new AgentPlanClientError(error instanceof Error ? error.message : String(error), undefined, traceId)));
		});
		socket.onError((error) => {
			fail(new AgentPlanClientError(`AgentPlan ASR WebSocket 错误：${error instanceof Error ? error.message : String(error)}`, undefined, traceId));
		});
		socket.onClose((code, reason) => {
			if (!settled) {
				fail(new AgentPlanClientError(`AgentPlan ASR WebSocket 异常关闭：${code} ${reason}`.trim(), undefined, traceId));
			}
		});
	});
}

function readHeader(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
	const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
	const value = key ? headers[key] : undefined;
	return Array.isArray(value) ? value[0] : value;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

import {
	buildAgentPlanFullRequestPayload,
	encodeAgentPlanAudioRequest,
	encodeAgentPlanFullRequest,
	parseAgentPlanResponseFrame,
	splitAgentPlanAudio,
	type AgentPlanResponsePayload
} from "./volcengine-agentplan-protocol";

export const AGENTPLAN_RESOURCE_ID = "volc.seedasr.sauc.duration";
export const AGENTPLAN_PACKET_DURATION_MS = 200;
export const AGENTPLAN_HANDSHAKE_TIMEOUT_MS = 15000;
export const AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS = 30000;

export interface AgentPlanSocket {
	onOpen(listener: () => void): void;
	onMessage(listener: (data: Uint8Array) => void): void;
	onError(listener: (error: unknown) => void): void;
	onClose(listener: (code: number, reason: string) => void): void;
	onUpgrade(listener: (headers: Record<string, string | string[] | undefined>) => void): void;
	send(data: Uint8Array): void;
	close(): void;
	terminate(): void;
}

export type AgentPlanSocketFactory = (url: string, headers: Record<string, string>) => AgentPlanSocket;

export interface AgentPlanClientOptions {
	url: string;
	apiKey: string;
	language: string;
	wavBytes: Uint8Array;
	createSocket: AgentPlanSocketFactory;
	sleep?: (milliseconds: number) => Promise<void>;
	handshakeTimeoutMs?: number;
	finalResponseTimeoutMs?: number;
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
	const handshakeTimeoutMs = options.handshakeTimeoutMs ?? AGENTPLAN_HANDSHAKE_TIMEOUT_MS;
	const finalResponseTimeoutMs = options.finalResponseTimeoutMs ?? AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS;
	let traceId: string | undefined;
	let settled = false;
	let audioStarted = false;
	let latestPayload: AgentPlanResponsePayload = {};
	let latestText = "";
	let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
	let finalResponseTimer: ReturnType<typeof setTimeout> | undefined;

	return new Promise<AgentPlanClientResult>((resolve, reject) => {
		const cleanup = (): void => {
			if (handshakeTimer) {
				clearTimeout(handshakeTimer);
			}
			if (finalResponseTimer) {
				clearTimeout(finalResponseTimer);
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

		const succeed = (): void => {
			if (settled) {
				return;
			}
			if (!latestText) {
				fail(new AgentPlanClientError("AgentPlan ASR 响应中缺少 result.text。", undefined, traceId));
				return;
			}
			settled = true;
			cleanup();
			socket.close();
			resolve({ text: latestText, traceId, raw: latestPayload });
		};

		const sendAudio = async (): Promise<void> => {
			try {
				const packets = splitAgentPlanAudio(options.wavBytes, AGENTPLAN_PACKET_DURATION_MS);
				if (packets.length === 0) {
					throw new AgentPlanClientError("待转写 WAV 音频为空。", undefined, traceId);
				}
				for (let packetIndex = 0; packetIndex < packets.length; packetIndex += 1) {
					if (settled) {
						return;
					}
					const isLastPackage = packetIndex === packets.length - 1;
					const frame = await encodeAgentPlanAudioRequest(packets[packetIndex], packetIndex + 2, isLastPackage);
					socket.send(frame);
					if (!isLastPackage) {
						await sleep(AGENTPLAN_PACKET_DURATION_MS);
					}
				}
				finalResponseTimer = setTimeout(
					() => fail(new AgentPlanClientError("AgentPlan ASR 等待最终识别结果超时。", undefined, traceId)),
					finalResponseTimeoutMs
				);
			} catch (error) {
				fail(
					error instanceof AgentPlanClientError
						? error
						: new AgentPlanClientError(error instanceof Error ? error.message : String(error), undefined, traceId)
				);
			}
		};

		handshakeTimer = setTimeout(
			() => fail(new AgentPlanClientError("AgentPlan ASR WebSocket 连接超时。", undefined, traceId)),
			handshakeTimeoutMs
		);

		socket.onUpgrade((headers) => {
			traceId = readHeader(headers, "x-tt-logid") ?? traceId;
		});
		socket.onOpen(() => {
			void encodeAgentPlanFullRequest(buildAgentPlanFullRequestPayload(options.language))
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
					}
					if (!audioStarted) {
						audioStarted = true;
						if (handshakeTimer) {
							clearTimeout(handshakeTimer);
						}
						void sendAudio();
					}
					if (frame.isLastPackage) {
						succeed();
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
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

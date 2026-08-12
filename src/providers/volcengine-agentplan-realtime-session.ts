import {
	AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS,
	AGENTPLAN_HANDSHAKE_TIMEOUT_MS,
	AGENTPLAN_RESOURCE_ID,
	AgentPlanClientError,
	type AgentPlanSocket,
	type AgentPlanSocketFactory
} from "./volcengine-agentplan-client";
import {
	buildAgentPlanFullRequestPayload,
	encodeAgentPlanAudioRequest,
	encodeAgentPlanFullRequest,
	getAgentPlanRealtimeResult,
	parseAgentPlanResponseFrame,
	type AgentPlanResponsePayload
} from "./volcengine-agentplan-protocol";
import type { TranscriptionUtterance } from "./transcription-provider";
import type { DiagnosticSink } from "../diagnostics/diagnostic-types";

const MAX_BUFFERED_SOCKET_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_PCM_PACKETS = 150;

export interface AgentPlanRealtimeProgress {
	text: string;
	utterances?: TranscriptionUtterance[];
	provisionalText: string;
	traceId?: string;
}

export interface AgentPlanRealtimeSessionOptions {
	url: string;
	apiKey: string;
	language: string;
	createSocket: AgentPlanSocketFactory;
	handshakeTimeoutMs?: number;
	finalResponseTimeoutMs?: number;
	onProgress?: (progress: AgentPlanRealtimeProgress) => Promise<void> | void;
	diagnostics?: DiagnosticSink;
}

export interface AgentPlanRealtimeSessionResult {
	text: string;
	utterances?: TranscriptionUtterance[];
	traceId?: string;
	raw: AgentPlanResponsePayload;
}

export class AgentPlanRealtimeSession {
	private options: AgentPlanRealtimeSessionOptions;
	private socket: AgentPlanSocket | null = null;
	private readyPromise: Promise<void> | null = null;
	private resolveReady: (() => void) | null = null;
	private rejectReady: ((error: AgentPlanClientError) => void) | null = null;
	private finishPromise: Promise<AgentPlanRealtimeSessionResult> | null = null;
	private resolveFinish: ((result: AgentPlanRealtimeSessionResult) => void) | null = null;
	private rejectFinish: ((error: AgentPlanClientError) => void) | null = null;
	private sendQueue = Promise.resolve();
	private queuedBeforeReady: Uint8Array[] = [];
	private pendingPacket: Uint8Array | null = null;
	private nextSequence = 2;
	private traceId: string | undefined;
	private latestPayload: AgentPlanResponsePayload = {};
	private latestText = "";
	private latestUtterances: TranscriptionUtterance[] | undefined;
	private failedError: AgentPlanClientError | null = null;
	private finishing = false;
	private settled = false;
	private handshakeTimer: number | null = null;
	private finalTimer: number | null = null;
	private progressQueue = Promise.resolve();
	private responseQueue = Promise.resolve();
	private connectionStartedAt: number | null = null;

	constructor(options: AgentPlanRealtimeSessionOptions) {
		this.options = options;
	}

	start(): Promise<void> {
		if (this.readyPromise) {
			return this.readyPromise;
		}

		this.readyPromise = new Promise<void>((resolve, reject) => {
			this.resolveReady = resolve;
			this.rejectReady = reject;
		});
		const requestId = crypto.randomUUID();
		this.connectionStartedAt = Date.now();
		this.options.diagnostics?.event("request", "agentplan-websocket-connecting", {
			endpoint: this.options.url,
			language: this.options.language,
			protocol: "agentplan-websocket"
		});
		this.socket = this.options.createSocket(this.options.url, {
			"X-Api-Key": this.options.apiKey,
			"X-Api-Resource-Id": AGENTPLAN_RESOURCE_ID,
			"X-Api-Request-Id": requestId,
			"X-Api-Connect-Id": requestId,
			"X-Api-Sequence": "-1"
		});
		this.bindSocket(this.socket);
		this.handshakeTimer = window.setTimeout(
			() => this.fail(new AgentPlanClientError("AgentPlan 实时 ASR WebSocket 连接超时。", undefined, this.traceId)),
			this.options.handshakeTimeoutMs ?? AGENTPLAN_HANDSHAKE_TIMEOUT_MS
		);
		return this.readyPromise;
	}

	pushPcm(packet: Uint8Array): void {
		if (packet.byteLength === 0 || this.finishing) {
			return;
		}
		if (this.failedError) {
			throw this.failedError;
		}
		if (this.settled) {
			return;
		}
		if (!this.readyPromise) {
			void this.start();
		}
		if (!this.isReady()) {
			if (this.queuedBeforeReady.length >= MAX_PENDING_PCM_PACKETS) {
				this.fail(new AgentPlanClientError("AgentPlan 连接建立过慢，实时音频缓冲已超过 30 秒。", undefined, this.traceId));
				return;
			}
			this.queuedBeforeReady.push(Uint8Array.from(packet));
			this.options.diagnostics?.event("progress", "agentplan-packet-buffered", {
				queuedPackets: this.queuedBeforeReady.length
			});
			return;
		}
		this.enqueuePacket(packet);
	}

	finish(): Promise<AgentPlanRealtimeSessionResult> {
		if (this.finishPromise) {
			return this.finishPromise;
		}
		if (this.failedError) {
			return Promise.reject(this.failedError);
		}
		this.finishing = true;
		this.finishPromise = new Promise<AgentPlanRealtimeSessionResult>((resolve, reject) => {
			this.resolveFinish = resolve;
			this.rejectFinish = reject;
		});

		void (async () => {
			try {
				await this.start();
				this.flushQueuedPackets();
				if (!this.pendingPacket) {
					throw new AgentPlanClientError("本次实时录音没有可发送的语音数据。", undefined, this.traceId);
				}
				const finalPacket = this.pendingPacket;
				this.pendingPacket = null;
				this.sendQueue = this.sendQueue.then(async () => {
					this.assertSocketWritable();
					const frame = await encodeAgentPlanAudioRequest(finalPacket, this.nextSequence, true);
					this.nextSequence += 1;
					this.socket?.send(frame);
				});
				await this.sendQueue;
				this.finalTimer = window.setTimeout(
					() => this.fail(new AgentPlanClientError("AgentPlan 实时 ASR 等待最终识别结果超时。", undefined, this.traceId)),
					this.options.finalResponseTimeoutMs ?? AGENTPLAN_FINAL_RESPONSE_TIMEOUT_MS
				);
			} catch (error) {
				this.fail(toSessionError(error, this.traceId));
			}
		})();
		return this.finishPromise;
	}

	abort(reason = "AgentPlan 实时 ASR 已中止。"): void {
		this.fail(new AgentPlanClientError(reason, undefined, this.traceId));
	}

	private bindSocket(socket: AgentPlanSocket): void {
		socket.onUpgrade((headers) => {
			this.traceId = readHeader(headers, "x-tt-logid") ?? this.traceId;
			this.options.diagnostics?.event("request", "agentplan-websocket-upgraded", { traceId: this.traceId });
		});
		socket.onOpen(() => {
			this.options.diagnostics?.event("request", "agentplan-websocket-opened", {
				connectionDurationMs: this.connectionStartedAt === null ? undefined : Date.now() - this.connectionStartedAt
			});
			void encodeAgentPlanFullRequest(buildAgentPlanFullRequestPayload(this.options.language, "pcm"))
				.then((frame) => socket.send(frame))
				.catch((error) => this.fail(toSessionError(error, this.traceId)));
		});
		socket.onMessage((data) => {
			this.responseQueue = this.responseQueue
				.then(() => parseAgentPlanResponseFrame(data))
				.then((frame) => {
					if (this.settled) {
						return;
					}
					if (frame.messageType === "error") {
						const detail = frame.payload?.message ?? frame.rawPayloadText ?? "未知错误";
						this.fail(
							new AgentPlanClientError(
								`AgentPlan 实时 ASR 服务端错误 ${frame.errorCode ?? ""}：${detail}`,
								frame.errorCode,
								this.traceId
							)
						);
						return;
					}
					if (!this.isReady()) {
						this.markReady();
					}
					if (frame.payload) {
						this.updateResult(frame.payload);
					}
					if (frame.isLastPackage) {
						void this.succeed();
					}
				})
				.catch((error) => this.fail(toSessionError(error, this.traceId)));
		});
		socket.onError((error) => {
			this.fail(
				new AgentPlanClientError(
					`AgentPlan 实时 ASR WebSocket 错误：${error instanceof Error ? error.message : String(error)}`,
					undefined,
					this.traceId
				)
			);
		});
		socket.onClose((code, reason) => {
			this.options.diagnostics?.event("result", "agentplan-websocket-closed", { code, reason });
			if (!this.settled) {
				this.fail(
					new AgentPlanClientError(
						`AgentPlan 实时 ASR WebSocket 异常关闭：${code} ${reason}`.trim(),
						undefined,
						this.traceId
					)
				);
			}
		});
	}

	private markReady(): void {
		if (this.handshakeTimer) {
			window.clearTimeout(this.handshakeTimer);
			this.handshakeTimer = null;
		}
		this.resolveReady?.();
		this.options.diagnostics?.event("lifecycle", "agentplan-websocket-ready", {
			traceId: this.traceId,
			handshakeDurationMs: this.connectionStartedAt === null ? undefined : Date.now() - this.connectionStartedAt
		});
		this.resolveReady = null;
		this.rejectReady = null;
		this.flushQueuedPackets();
	}

	private isReady(): boolean {
		return this.readyPromise !== null && this.resolveReady === null && !this.failedError;
	}

	private flushQueuedPackets(): void {
		const queued = this.queuedBeforeReady;
		this.queuedBeforeReady = [];
		for (const packet of queued) {
			this.enqueuePacket(packet);
		}
	}

	private enqueuePacket(packet: Uint8Array): void {
		if (this.pendingPacket) {
			const packetToSend = this.pendingPacket;
			this.sendQueue = this.sendQueue.then(async () => {
				this.assertSocketWritable();
				const frame = await encodeAgentPlanAudioRequest(packetToSend, this.nextSequence, false);
				this.nextSequence += 1;
				this.socket?.send(frame);
			}).catch((error) => {
				this.fail(toSessionError(error, this.traceId));
			});
		}
		this.pendingPacket = Uint8Array.from(packet);
	}

	private assertSocketWritable(): void {
		if (!this.socket || this.failedError) {
			throw this.failedError ?? new AgentPlanClientError("AgentPlan 实时 ASR 连接不可用。", undefined, this.traceId);
		}
		const bufferedAmount = this.socket.getBufferedAmount?.() ?? 0;
		this.options.diagnostics?.event("progress", "agentplan-socket-buffered-amount", { bufferedAmount });
		if (bufferedAmount > MAX_BUFFERED_SOCKET_BYTES) {
			throw new AgentPlanClientError("AgentPlan 实时 ASR 网络发送积压超过安全上限。", undefined, this.traceId);
		}
	}

	private updateResult(payload: AgentPlanResponsePayload): void {
		this.latestPayload = payload;
		const rawText = payload.result?.text?.trim();
		if (rawText) {
			this.latestText = rawText;
		}
		const realtime = getAgentPlanRealtimeResult(payload);
		if (realtime.utterances) {
			this.latestUtterances = realtime.utterances;
		}
		if (!this.options.onProgress) {
			return;
		}
		const progress: AgentPlanRealtimeProgress = {
			text: realtime.text,
			utterances: realtime.utterances,
			provisionalText: realtime.provisionalText,
			traceId: this.traceId
		};
		this.progressQueue = this.progressQueue
			.then(() => this.options.onProgress?.(progress))
			.catch(() => undefined);
	}

	private async succeed(): Promise<void> {
		if (this.settled) {
			return;
		}
		this.settled = true;
		this.clearTimers();
		await this.progressQueue;
		const finalResult = getAgentPlanRealtimeResult(this.latestPayload);
		const text = finalResult.text || this.latestText;
		if (!text) {
			this.rejectFinish?.(
				new AgentPlanClientError("AgentPlan 实时 ASR 响应中缺少 result.text。", undefined, this.traceId)
			);
		} else {
			this.options.diagnostics?.event("result", "agentplan-realtime-completed", { traceId: this.traceId, utteranceCount: finalResult.utterances?.length ?? 0 });
			this.resolveFinish?.({
				text,
				utterances: finalResult.utterances ?? this.latestUtterances,
				traceId: this.traceId,
				raw: this.latestPayload
			});
		}
		this.socket?.close();
	}

	private fail(error: AgentPlanClientError): void {
		if (this.settled) {
			return;
		}
		this.failedError = error;
		this.options.diagnostics?.event("result", "agentplan-realtime-failed", {
			error: error.message,
			traceId: error.traceId,
			serverCode: error.serverCode
		});
		error.traceId ??= this.traceId;
		this.settled = true;
		this.clearTimers();
		this.rejectReady?.(error);
		this.rejectFinish?.(error);
		this.socket?.terminate();
	}

	private clearTimers(): void {
		if (this.handshakeTimer) {
			window.clearTimeout(this.handshakeTimer);
		}
		if (this.finalTimer) {
			window.clearTimeout(this.finalTimer);
		}
		this.handshakeTimer = null;
		this.finalTimer = null;
	}
}

function readHeader(
	headers: Record<string, string | string[] | undefined>,
	name: string
): string | undefined {
	const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
	return Array.isArray(value) ? value[0] : value;
}

function toSessionError(error: unknown, traceId?: string): AgentPlanClientError {
	if (error instanceof AgentPlanClientError) {
		error.traceId ??= traceId;
		return error;
	}
	return new AgentPlanClientError(
		error instanceof Error ? error.message : String(error),
		undefined,
		traceId
	);
}

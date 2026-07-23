import { App, Platform } from "obsidian";
import type { RawData } from "ws";
import { createWavAudioBuffer } from "../audio/audio-segmenter";
import { isSupportedAudioFile } from "../audio/audio-detector";
import type { EchoNotesSettings } from "../settings/settings";
import {
	AgentPlanClientError,
	transcribeAgentPlanWav,
	type AgentPlanSocket,
	type AgentPlanSocketFactory
} from "./volcengine-agentplan-client";
import {
	TranscriptionError,
	type TranscriptionInput,
	type TranscriptionProvider,
	type TranscriptionResult
} from "./transcription-provider";
import { normalizeAgentPlanUtterances } from "./volcengine-agentplan-protocol";

export class VolcengineAgentPlanAsrProvider implements TranscriptionProvider {
	id = "volcengine-agentplan";
	name = "火山引擎 AgentPlan";

	private app: App;
	private settings: EchoNotesSettings;
	private apiKey: string;

	constructor(app: App, settings: EchoNotesSettings, apiKey: string) {
		this.app = app;
		this.settings = settings;
		this.apiKey = apiKey;
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new TranscriptionError("missing_api_key", "请先在 Echo Notes 设置中配置火山引擎 AgentPlan 专属 API Key。");
		}
		if (Platform.isMobile) {
			throw new TranscriptionError(
				"unsupported_audio",
				"火山引擎 AgentPlan 转写仅支持 Obsidian 桌面端；移动端无法为 WebSocket 握手写入鉴权请求头。"
			);
		}
		if (!isSupportedAudioFile(input.audioFile)) {
			throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		}

		const sourceAudioBuffer = await this.app.vault.readBinary(input.audioFile);
		const createSocket = await loadAgentPlanSocketFactory();
		let wavAudioBuffer: ArrayBuffer;
		try {
			wavAudioBuffer = await createWavAudioBuffer(sourceAudioBuffer);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new TranscriptionError("audio_decode_error", `音频解码失败，无法转换为 AgentPlan 所需的 16 kHz mono WAV：${message}`);
		}

		let result;
		try {
			result = await transcribeAgentPlanWav({
				url: this.settings.baseUrl.trim(),
				apiKey,
				language: input.language ?? this.settings.language,
				wavBytes: new Uint8Array(wavAudioBuffer),
				createSocket
			});
		} catch (error) {
			throw toTranscriptionError(error);
		}

		return {
			text: result.text,
			provider: this.id,
			model: this.settings.model,
			traceId: result.traceId,
			utterances: normalizeAgentPlanUtterances(result.raw.result?.utterances),
			raw: result.raw
		};
	}
}

async function loadAgentPlanSocketFactory(): Promise<AgentPlanSocketFactory> {
	const wsModule = (await import("ws")) as unknown as {
		default?: NodeWebSocketConstructor;
	};
	const NodeWebSocket = wsModule.default ?? (wsModule as unknown as NodeWebSocketConstructor);
	return (url, headers) => adaptNodeWebSocket(new NodeWebSocket(url, { headers, handshakeTimeout: 15000 }));
}

type NodeWebSocketInstance = import("ws");
type NodeWebSocketConstructor = new (
	url: string,
	options: import("ws").ClientOptions
) => NodeWebSocketInstance;

function adaptNodeWebSocket(socket: NodeWebSocketInstance): AgentPlanSocket {
	return {
		onOpen: (listener) => {
			socket.on("open", listener);
		},
		onMessage: (listener) => {
			socket.on("message", (data) => listener(rawDataToBytes(data)));
		},
		onError: (listener) => {
			socket.on("error", listener);
		},
		onClose: (listener) => {
			socket.on("close", (code, reason) => listener(code, reason.toString("utf8")));
		},
		onUpgrade: (listener) => {
			socket.on("upgrade", (response) => listener(response.headers));
		},
		send: (data) => {
			socket.send(data);
		},
		close: () => {
			socket.close();
		},
		terminate: () => {
			socket.terminate();
		}
	};
}

function rawDataToBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	if (Array.isArray(data)) {
		return Uint8Array.from(Buffer.concat(data));
	}
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function toTranscriptionError(error: unknown): TranscriptionError {
	if (error instanceof TranscriptionError) {
		return error;
	}
	if (!(error instanceof AgentPlanClientError)) {
		return new TranscriptionError("network_error", `火山引擎 AgentPlan ASR 调用失败：${error instanceof Error ? error.message : String(error)}`);
	}

	const normalized = error.message.toLowerCase();
	let code: ConstructorParameters<typeof TranscriptionError>[0] = "api_error";
	if (/401|403|unauthorized|api key|authentication|permission/.test(normalized)) {
		code = "authentication_failed";
	} else if (/429|rate.?limit|server busy|55000031/.test(normalized)) {
		code = "rate_limited";
	} else if (/quota|billing|credit|balance|exceeded/.test(normalized)) {
		code = "quota_exceeded";
	} else if (/timeout|超时/.test(normalized)) {
		code = "network_error";
	} else if (/result\.text|invalid json|响应帧/.test(normalized)) {
		code = "invalid_response";
	}
	return new TranscriptionError(code, error.message, error.traceId);
}

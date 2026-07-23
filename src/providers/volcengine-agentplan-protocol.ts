const PROTOCOL_VERSION_AND_HEADER_SIZE = 0x11;
const FULL_CLIENT_REQUEST = 0x1;
const AUDIO_ONLY_REQUEST = 0x2;
const FULL_SERVER_RESPONSE = 0x9;
const SERVER_ERROR_RESPONSE = 0xf;
const FLAG_POSITIVE_SEQUENCE = 0x1;
const FLAG_LAST_PACKAGE = 0x2;
const JSON_SERIALIZATION = 0x1;
const GZIP_COMPRESSION = 0x1;

export interface AgentPlanFullRequestPayload {
	user: {
		uid: string;
	};
	audio: {
		format: "wav";
		codec: "raw";
		rate: 16000;
		bits: 16;
		channel: 1;
		language?: string;
	};
	request: {
		model_name: "bigmodel";
		enable_itn: true;
		enable_punc: true;
		enable_ddc: true;
		show_utterances: true;
		enable_nonstream: false;
		enable_speaker_info: true;
		ssd_version: "200";
	};
}

export interface AgentPlanResponseUtterance {
	text?: unknown;
	start_time?: unknown;
	end_time?: unknown;
	definite?: unknown;
	additions?: {
		speaker_id?: unknown;
		[key: string]: unknown;
	};
	[key: string]: unknown;
}

export interface AgentPlanResponsePayload {
	audio_info?: {
		duration?: number;
	};
	result?: {
		text?: string;
		utterances?: AgentPlanResponseUtterance[];
		additions?: Record<string, unknown>;
	};
	message?: string;
	code?: number;
	[key: string]: unknown;
}

export interface AgentPlanResponseFrame {
	messageType: "response" | "error";
	sequence?: number;
	isLastPackage: boolean;
	errorCode?: number;
	payload?: AgentPlanResponsePayload;
	rawPayloadText?: string;
}

export function buildAgentPlanFullRequestPayload(language: string): AgentPlanFullRequestPayload {
	const mappedLanguage = mapAgentPlanLanguage(language);
	return {
		user: {
			uid: "echo-notes"
		},
		audio: {
			format: "wav",
			codec: "raw",
			rate: 16000,
			bits: 16,
			channel: 1,
			...(mappedLanguage ? { language: mappedLanguage } : {})
		},
		request: {
			model_name: "bigmodel",
			enable_itn: true,
			enable_punc: true,
			enable_ddc: true,
			show_utterances: true,
			enable_nonstream: false,
			enable_speaker_info: true,
			ssd_version: "200"
		}
	};
}

export function mapAgentPlanLanguage(language: string): string | undefined {
	const normalized = language.trim();
	return normalized === "zh" || normalized === "zh-CN" ? "zh-CN" : undefined;
}

export function normalizeAgentPlanUtterances(
	utterances: AgentPlanResponseUtterance[] | undefined
): TranscriptionUtterance[] | undefined {
	if (!Array.isArray(utterances)) {
		return undefined;
	}

	const normalized = utterances.flatMap((utterance): TranscriptionUtterance[] => {
		const text = typeof utterance.text === "string" ? utterance.text.trim() : "";
		const rawSpeakerId = utterance.additions?.speaker_id;
		if (!text || (typeof rawSpeakerId !== "string" && typeof rawSpeakerId !== "number")) {
			return [];
		}

		const speakerId = String(rawSpeakerId).trim();
		if (!speakerId) {
			return [];
		}

		const startSeconds = millisecondsToSeconds(utterance.start_time);
		const endSeconds = millisecondsToSeconds(utterance.end_time);
		return [{
			speakerId,
			text,
			...(startSeconds !== undefined ? { startSeconds } : {}),
			...(endSeconds !== undefined && (startSeconds === undefined || endSeconds >= startSeconds) ? { endSeconds } : {})
		}];
	});

	return normalized.length > 0 ? normalized : undefined;
}

export async function encodeAgentPlanFullRequest(
	payload: AgentPlanFullRequestPayload,
	sequence = 1
): Promise<Uint8Array> {
	const compressedPayload = await gzipBytes(new TextEncoder().encode(JSON.stringify(payload)));
	return createFrame(
		FULL_CLIENT_REQUEST,
		FLAG_POSITIVE_SEQUENCE,
		JSON_SERIALIZATION,
		GZIP_COMPRESSION,
		sequence,
		compressedPayload
	);
}

export async function encodeAgentPlanAudioRequest(
	audioBytes: Uint8Array,
	sequence: number,
	isLastPackage: boolean
): Promise<Uint8Array> {
	const compressedPayload = await gzipBytes(audioBytes);
	return createFrame(
		AUDIO_ONLY_REQUEST,
		isLastPackage ? FLAG_POSITIVE_SEQUENCE | FLAG_LAST_PACKAGE : FLAG_POSITIVE_SEQUENCE,
		0,
		GZIP_COMPRESSION,
		isLastPackage ? -Math.abs(sequence) : Math.abs(sequence),
		compressedPayload
	);
}

export async function parseAgentPlanResponseFrame(frame: Uint8Array): Promise<AgentPlanResponseFrame> {
	if (frame.byteLength < 4) {
		throw new Error("AgentPlan 响应帧长度不足。");
	}

	const headerSize = (frame[0] & 0x0f) * 4;
	const messageType = frame[1] >> 4;
	const flags = frame[1] & 0x0f;
	const serialization = frame[2] >> 4;
	const compression = frame[2] & 0x0f;
	if (headerSize < 4 || frame.byteLength < headerSize) {
		throw new Error("AgentPlan 响应帧头无效。");
	}

	let offset = headerSize;
	let sequence: number | undefined;
	if ((flags & FLAG_POSITIVE_SEQUENCE) !== 0) {
		assertAvailable(frame, offset, 4);
		sequence = new DataView(frame.buffer, frame.byteOffset + offset, 4).getInt32(0, false);
		offset += 4;
	}
	if ((flags & 0x4) !== 0) {
		assertAvailable(frame, offset, 4);
		offset += 4;
	}

	if (messageType !== FULL_SERVER_RESPONSE && messageType !== SERVER_ERROR_RESPONSE) {
		throw new Error(`AgentPlan 返回了不支持的消息类型：${messageType}。`);
	}

	let errorCode: number | undefined;
	if (messageType === SERVER_ERROR_RESPONSE) {
		assertAvailable(frame, offset, 4);
		errorCode = new DataView(frame.buffer, frame.byteOffset + offset, 4).getUint32(0, false);
		offset += 4;
	}

	assertAvailable(frame, offset, 4);
	const payloadSize = new DataView(frame.buffer, frame.byteOffset + offset, 4).getUint32(0, false);
	offset += 4;
	assertAvailable(frame, offset, payloadSize);
	let payloadBytes = frame.subarray(offset, offset + payloadSize);
	if (compression === GZIP_COMPRESSION && payloadBytes.byteLength > 0) {
		payloadBytes = await gunzipBytes(payloadBytes);
	}

	const rawPayloadText = payloadBytes.byteLength > 0 ? new TextDecoder().decode(payloadBytes) : "";
	let payload: AgentPlanResponsePayload | undefined;
	if (rawPayloadText && serialization === JSON_SERIALIZATION) {
		try {
			payload = JSON.parse(rawPayloadText) as AgentPlanResponsePayload;
		} catch {
			throw new Error("AgentPlan 响应中包含无效 JSON。");
		}
	}

	return {
		messageType: messageType === SERVER_ERROR_RESPONSE ? "error" : "response",
		sequence,
		isLastPackage: (flags & FLAG_LAST_PACKAGE) !== 0,
		errorCode,
		payload,
		rawPayloadText
	};
}

export function getAgentPlanPcmPacketByteLength(durationMs = 200): number {
	return Math.round((16000 * 16 * durationMs) / 8 / 1000);
}

export function splitAgentPlanAudio(audioBytes: Uint8Array, packetDurationMs = 200): Uint8Array[] {
	const packetByteLength = getAgentPlanPcmPacketByteLength(packetDurationMs);
	if (packetByteLength <= 0 || audioBytes.byteLength === 0) {
		return [];
	}

	const packets: Uint8Array[] = [];
	for (let offset = 0; offset < audioBytes.byteLength; offset += packetByteLength) {
		packets.push(audioBytes.subarray(offset, Math.min(offset + packetByteLength, audioBytes.byteLength)));
	}
	return packets;
}

function createFrame(
	messageType: number,
	flags: number,
	serialization: number,
	compression: number,
	sequence: number,
	payload: Uint8Array
): Uint8Array {
	const frame = new Uint8Array(12 + payload.byteLength);
	frame[0] = PROTOCOL_VERSION_AND_HEADER_SIZE;
	frame[1] = (messageType << 4) | flags;
	frame[2] = (serialization << 4) | compression;
	frame[3] = 0;
	const view = new DataView(frame.buffer);
	view.setInt32(4, sequence, false);
	view.setUint32(8, payload.byteLength, false);
	frame.set(payload, 12);
	return frame;
}

async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	return transformBytes(bytes, new CompressionStream("gzip"));
}

async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
	return transformBytes(bytes, new DecompressionStream("gzip"));
}

async function transformBytes(
	bytes: Uint8Array,
	transform: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
	const sourceBytes = Uint8Array.from(bytes);
	const stream = new Blob([sourceBytes]).stream().pipeThrough(transform);
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

function assertAvailable(frame: Uint8Array, offset: number, byteLength: number): void {
	if (byteLength < 0 || offset < 0 || offset + byteLength > frame.byteLength) {
		throw new Error("AgentPlan 响应帧载荷长度无效。");
	}
}

function millisecondsToSeconds(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value / 1000 : undefined;
}
import type { TranscriptionUtterance } from "./transcription-provider";

import type { RawData } from "ws";
import type {
	AgentPlanSocket,
	AgentPlanSocketFactory
} from "./volcengine-agentplan-client";

export async function loadAgentPlanSocketFactory(): Promise<AgentPlanSocketFactory> {
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
		},
		getBufferedAmount: () => socket.bufferedAmount
	};
}

function rawDataToBytes(data: RawData): Uint8Array {
	if (data instanceof ArrayBuffer) {
		return new Uint8Array(data);
	}
	if (Array.isArray(data)) {
		const bytes = new Uint8Array(data.reduce((total, chunk) => total + chunk.byteLength, 0));
		let offset = 0;
		for (const chunk of data) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	}
	return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

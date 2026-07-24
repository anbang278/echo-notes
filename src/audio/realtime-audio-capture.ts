import { App, FileSystemAdapter, Platform, TFile } from "obsidian";
import { FileService, getParentPath } from "../obsidian/file-service";
import { SequentialBlobWriteQueue } from "./realtime-blob-write-queue";
import {
	downmixAudioChannels,
	Pcm16Packetizer,
	REALTIME_PCM_SAMPLE_RATE,
	StreamingMonoResampler
} from "./realtime-pcm";

export {
	Pcm16Packetizer,
	REALTIME_PCM_PACKET_BYTES,
	REALTIME_PCM_PACKET_DURATION_MS,
	REALTIME_PCM_SAMPLE_RATE,
	StreamingMonoResampler
} from "./realtime-pcm";

export const REALTIME_RECORDING_MIME_TYPE = "audio/webm;codecs=opus";
export const REALTIME_RECORDING_EXTENSION = "webm";

export interface AudioInputDevice {
	deviceId: string;
	label: string;
}

export async function requestRealtimeMicrophone(deviceId: string): Promise<MediaStream> {
	if (!navigator.mediaDevices?.getUserMedia) {
		throw new Error("当前环境不支持麦克风采集。");
	}
	const audio: MediaTrackConstraints = {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		...(deviceId ? { deviceId: { exact: deviceId } } : {})
	};
	try {
		return await navigator.mediaDevices.getUserMedia({ audio, video: false });
	} catch (error) {
		if (!deviceId) {
			throw error;
		}
		return navigator.mediaDevices.getUserMedia({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				autoGainControl: true
			},
			video: false
		});
	}
}

export async function listAudioInputDevices(requestPermission = false): Promise<AudioInputDevice[]> {
	let permissionStream: MediaStream | null = null;
	if (requestPermission) {
		permissionStream = await requestRealtimeMicrophone("");
	}
	try {
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices
			.filter((device) => device.kind === "audioinput")
			.map((device) => ({ deviceId: device.deviceId, label: device.label }));
	} finally {
		permissionStream?.getTracks().forEach((track) => track.stop());
	}
}

export class VaultRecordingSink {
	readonly file: TFile;
	private app: App;
	private writeQueue: SequentialBlobWriteQueue;

	private constructor(app: App, file: TFile, fullPath: string) {
		this.app = app;
		this.file = file;
		this.writeQueue = new SequentialBlobWriteQueue(async (bytes) => {
			if (!Platform.isDesktop || !Platform.isDesktopApp) {
				throw new Error("实时录音文件写入仅支持 Obsidian 桌面端。");
			}
			const fs = await import("node:fs/promises");
			await fs.appendFile(fullPath, bytes);
		});
	}

	static async create(app: App, path: string): Promise<VaultRecordingSink> {
		if (!Platform.isDesktop || !Platform.isDesktopApp || !(app.vault.adapter instanceof FileSystemAdapter)) {
			throw new Error("实时录音仅支持本地文件系统 Vault。");
		}
		await new FileService(app).ensureFolder(getParentPath(path));
		const file = await app.vault.createBinary(path, new ArrayBuffer(0));
		return new VaultRecordingSink(app, file, app.vault.adapter.getFullPath(path));
	}

	append(blob: Blob): void {
		this.writeQueue.append(blob);
	}

	async finish(): Promise<number> {
		const byteCount = await this.writeQueue.finish();
		const stat = await this.app.vault.adapter.stat(this.file.path);
		if (stat) {
			Object.assign(this.file.stat, stat);
		}
		return byteCount;
	}
}

export class ChunkedMediaRecorder {
	private stream: MediaStream;
	private sink: VaultRecordingSink;
	private recorder: MediaRecorder | null = null;
	private stopPromise: Promise<number> | null = null;

	constructor(stream: MediaStream, sink: VaultRecordingSink) {
		this.stream = stream;
		this.sink = sink;
	}

	start(): void {
		if (!MediaRecorder.isTypeSupported(REALTIME_RECORDING_MIME_TYPE)) {
			throw new Error(`当前 Obsidian 不支持 ${REALTIME_RECORDING_MIME_TYPE} 实时录音。`);
		}
		this.recorder = new MediaRecorder(this.stream, { mimeType: REALTIME_RECORDING_MIME_TYPE });
		this.recorder.addEventListener("dataavailable", (event) => {
			this.sink.append(event.data);
		});
		this.recorder.start(1000);
	}

	stop(): Promise<number> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		this.stopPromise = new Promise<number>((resolve, reject) => {
			const recorder = this.recorder;
			if (!recorder || recorder.state === "inactive") {
				void this.sink.finish().then(resolve, reject);
				return;
			}
			recorder.addEventListener("error", (event) => {
				const message = event instanceof ErrorEvent && event.message ? event.message : "未知错误";
				reject(new Error(`本地录音失败：${message}`));
			}, { once: true });
			recorder.addEventListener("stop", () => {
				void this.sink.finish().then(resolve, reject);
			}, { once: true });
			recorder.stop();
		});
		return this.stopPromise;
	}
}

export class RealtimePcmCapture {
	private stream: MediaStream;
	private onPacket: (packet: Uint8Array) => void;
	private audioContext: AudioContext | null = null;
	private sourceNode: MediaStreamAudioSourceNode | null = null;
	private captureNode: AudioNode | null = null;
	private silentGain: GainNode | null = null;
	private workletUrl: string | null = null;
	private packetizer = new Pcm16Packetizer();
	private resampler: StreamingMonoResampler | null = null;

	constructor(stream: MediaStream, onPacket: (packet: Uint8Array) => void) {
		this.stream = stream;
		this.onPacket = onPacket;
	}

	async start(): Promise<void> {
		const AudioContextConstructor = window.AudioContext;
		if (!AudioContextConstructor) {
			throw new Error("当前环境不支持 Web Audio。");
		}
		this.audioContext = new AudioContextConstructor();
		if (this.audioContext.state === "suspended") {
			await this.audioContext.resume();
		}
		this.resampler = new StreamingMonoResampler(this.audioContext.sampleRate, REALTIME_PCM_SAMPLE_RATE);
		this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);
		this.silentGain = this.audioContext.createGain();
		this.silentGain.gain.value = 0;

		if (this.audioContext.audioWorklet && typeof AudioWorkletNode !== "undefined") {
			try {
				await this.startAudioWorklet();
			} catch {
				if (this.workletUrl) {
					URL.revokeObjectURL(this.workletUrl);
					this.workletUrl = null;
				}
				this.startScriptProcessor();
			}
		} else {
			this.startScriptProcessor();
		}
	}

	async stop(): Promise<Uint8Array | null> {
		this.captureNode?.disconnect();
		this.sourceNode?.disconnect();
		this.silentGain?.disconnect();
		this.captureNode = null;
		this.sourceNode = null;
		this.silentGain = null;
		if (this.workletUrl) {
			URL.revokeObjectURL(this.workletUrl);
			this.workletUrl = null;
		}
		if (this.audioContext) {
			await this.audioContext.close();
			this.audioContext = null;
		}
		const remainder = this.packetizer.flush();
		return remainder?.byteLength ? remainder : null;
	}

	private async startAudioWorklet(): Promise<void> {
		if (!this.audioContext || !this.sourceNode || !this.silentGain) {
			return;
		}
		const workletSource = `
			class EchoNotesPcmCapture extends AudioWorkletProcessor {
				process(inputs) {
					const channels = inputs[0];
					if (!channels || channels.length === 0 || channels[0].length === 0) return true;
					const mono = new Float32Array(channels[0].length);
					for (let channel = 0; channel < channels.length; channel += 1) {
						const samples = channels[channel];
						for (let index = 0; index < mono.length; index += 1) mono[index] += samples[index] / channels.length;
					}
					this.port.postMessage(mono, [mono.buffer]);
					return true;
				}
			}
			registerProcessor("echo-notes-pcm-capture", EchoNotesPcmCapture);
		`;
		this.workletUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
		await this.audioContext.audioWorklet.addModule(this.workletUrl);
		const node = new AudioWorkletNode(this.audioContext, "echo-notes-pcm-capture");
		node.port.onmessage = (event: MessageEvent<Float32Array>) => {
			this.handleMonoSamples(event.data);
		};
		this.sourceNode.connect(node);
		node.connect(this.silentGain);
		this.silentGain.connect(this.audioContext.destination);
		this.captureNode = node;
	}

	private startScriptProcessor(): void {
		if (!this.audioContext || !this.sourceNode || !this.silentGain) {
			return;
		}
		const node = this.audioContext.createScriptProcessor(4096, 2, 1);
		node.onaudioprocess = (event) => {
			const input = event.inputBuffer;
			const channels: Float32Array[] = [];
			for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
				channels.push(input.getChannelData(channel));
			}
			this.handleMonoSamples(downmixAudioChannels(channels));
		};
		this.sourceNode.connect(node);
		node.connect(this.silentGain);
		this.silentGain.connect(this.audioContext.destination);
		this.captureNode = node;
	}

	private handleMonoSamples(samples: Float32Array): void {
		const resampled = this.resampler?.process(samples);
		if (!resampled?.length) {
			return;
		}
		for (const packet of this.packetizer.push(resampled)) {
			this.onPacket(packet);
		}
	}
}

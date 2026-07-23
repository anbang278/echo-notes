export const REALTIME_PCM_SAMPLE_RATE = 16000;
export const REALTIME_PCM_PACKET_DURATION_MS = 200;
export const REALTIME_PCM_PACKET_BYTES = 6400;

export function downmixAudioChannels(channels: readonly Float32Array[]): Float32Array {
	if (channels.length === 0) {
		return new Float32Array(0);
	}
	const frameLength = Math.min(...channels.map((channel) => channel.length));
	const mono = new Float32Array(frameLength);
	for (const channel of channels) {
		for (let index = 0; index < frameLength; index += 1) {
			mono[index] += channel[index] / channels.length;
		}
	}
	return mono;
}

export class StreamingMonoResampler {
	private step: number;
	private samples: number[] = [];
	private readPosition = 0;

	constructor(inputSampleRate: number, outputSampleRate: number) {
		if (inputSampleRate <= 0 || outputSampleRate <= 0) {
			throw new Error("音频采样率无效。");
		}
		this.step = inputSampleRate / outputSampleRate;
	}

	process(chunk: Float32Array): Float32Array {
		for (const sample of chunk) {
			this.samples.push(sample);
		}
		const output: number[] = [];
		while (this.readPosition + 1 < this.samples.length) {
			const leftIndex = Math.floor(this.readPosition);
			const fraction = this.readPosition - leftIndex;
			const left = this.samples[leftIndex] ?? 0;
			const right = this.samples[leftIndex + 1] ?? left;
			output.push(left + (right - left) * fraction);
			this.readPosition += this.step;
		}
		const consumed = Math.floor(this.readPosition);
		if (consumed > 0) {
			this.samples.splice(0, consumed);
			this.readPosition -= consumed;
		}
		return Float32Array.from(output);
	}
}

export class Pcm16Packetizer {
	private pending: number[] = [];

	push(samples: Float32Array): Uint8Array[] {
		for (const sample of samples) {
			const clamped = Math.max(-1, Math.min(1, sample));
			const value = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
			this.pending.push(value & 0xff, (value >> 8) & 0xff);
		}
		const packets: Uint8Array[] = [];
		while (this.pending.length >= REALTIME_PCM_PACKET_BYTES) {
			packets.push(Uint8Array.from(this.pending.splice(0, REALTIME_PCM_PACKET_BYTES)));
		}
		return packets;
	}

	flush(): Uint8Array | null {
		if (this.pending.length === 0) {
			return null;
		}
		const packet = Uint8Array.from(this.pending);
		this.pending = [];
		return packet;
	}
}

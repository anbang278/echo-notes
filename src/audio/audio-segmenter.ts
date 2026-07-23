import type { TranscriptionSegmentRange } from "../providers/transcription-provider";
import type { AudioChunk } from "./audio-chunk-pipeline";

export const LONG_AUDIO_TARGET_SEGMENT_SECONDS = 180;
export const LONG_AUDIO_SILENCE_SEARCH_SECONDS = 10;
export const LONG_AUDIO_MIN_SEGMENT_SECONDS = 30;
export const LONG_AUDIO_SILENCE_WINDOW_SECONDS = 0.2;
export const LONG_AUDIO_SILENCE_RMS_THRESHOLD = 0.015;
export const WAV_SEGMENT_SAMPLE_RATE = 16000;
export const WAV_SEGMENT_MIME_TYPE = "audio/wav";

export type AudioSegmentRange = TranscriptionSegmentRange;

export interface AudioSegmentRangeOptions {
	targetSegmentSeconds?: number;
	minSegmentSeconds?: number;
}

export type WavAudioSegment = AudioChunk;

interface SilenceSearchOptions {
	searchWindowSeconds: number;
	silenceWindowSeconds: number;
	silenceRmsThreshold: number;
}

export function estimateBase64DataUrlByteLength(binaryByteLength: number, mimeType: string): number {
	const prefix = `data:${mimeType};base64,`;
	return new TextEncoder().encode(prefix).byteLength + Math.ceil(binaryByteLength / 3) * 4;
}

export function formatSegmentTimestamp(seconds: number): string {
	const totalSeconds = Math.max(0, Math.round(seconds));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const remainingSeconds = totalSeconds % 60;

	if (hours > 0) {
		return [hours, minutes, remainingSeconds].map((value) => value.toString().padStart(2, "0")).join(":");
	}

	return [minutes, remainingSeconds].map((value) => value.toString().padStart(2, "0")).join(":");
}

export function formatSegmentTimeRange(segment: Pick<AudioSegmentRange, "startSeconds" | "endSeconds">): string {
	return `${formatSegmentTimestamp(segment.startSeconds)}-${formatSegmentTimestamp(segment.endSeconds)}`;
}

export function createAudioSegmentRanges(
	durationSeconds: number,
	options: AudioSegmentRangeOptions = {},
	resolveBoundary?: (targetSeconds: number, startSeconds: number, durationSeconds: number) => number | null
): AudioSegmentRange[] {
	const targetSegmentSeconds = options.targetSegmentSeconds ?? LONG_AUDIO_TARGET_SEGMENT_SECONDS;
	const minSegmentSeconds = options.minSegmentSeconds ?? LONG_AUDIO_MIN_SEGMENT_SECONDS;
	const safeDurationSeconds = Math.max(0, durationSeconds);
	const ranges: Array<Omit<AudioSegmentRange, "index" | "total">> = [];
	let startSeconds = 0;

	while (safeDurationSeconds - startSeconds > targetSegmentSeconds + minSegmentSeconds) {
		const targetSeconds = startSeconds + targetSegmentSeconds;
		const resolvedBoundary = resolveBoundary?.(targetSeconds, startSeconds, safeDurationSeconds);
		const boundarySeconds = normalizeBoundary(
			resolvedBoundary ?? targetSeconds,
			targetSeconds,
			startSeconds,
			safeDurationSeconds,
			minSegmentSeconds
		);

		ranges.push({
			startSeconds,
			endSeconds: boundarySeconds
		});
		startSeconds = boundarySeconds;
	}

	if (safeDurationSeconds > startSeconds) {
		ranges.push({
			startSeconds,
			endSeconds: safeDurationSeconds
		});
	}

	return ranges.map((range, rangeIndex) => ({
		...range,
		index: rangeIndex + 1,
		total: ranges.length
	}));
}

export async function createWavAudioSegments(
	sourceAudioBuffer: ArrayBuffer,
	options: AudioSegmentRangeOptions = {}
): Promise<WavAudioSegment[]> {
	const decodedAudio = await decodeAudio(sourceAudioBuffer);
	const ranges = createAudioSegmentRanges(
		decodedAudio.duration,
		{
			targetSegmentSeconds: options.targetSegmentSeconds ?? LONG_AUDIO_TARGET_SEGMENT_SECONDS,
			minSegmentSeconds: options.minSegmentSeconds ?? LONG_AUDIO_MIN_SEGMENT_SECONDS
		},
		(targetSeconds) =>
			findLowEnergyBoundary(decodedAudio, targetSeconds, {
				searchWindowSeconds: LONG_AUDIO_SILENCE_SEARCH_SECONDS,
				silenceWindowSeconds: LONG_AUDIO_SILENCE_WINDOW_SECONDS,
				silenceRmsThreshold: LONG_AUDIO_SILENCE_RMS_THRESHOLD
			})
	);

	return ranges.map((range) => ({
		...range,
		audioBuffer: encodeAudioSegmentToWav(decodedAudio, range, WAV_SEGMENT_SAMPLE_RATE),
		mimeType: WAV_SEGMENT_MIME_TYPE
	}));
}

export async function createWavAudioBuffer(sourceAudioBuffer: ArrayBuffer): Promise<ArrayBuffer> {
	const decodedAudio = await decodeAudio(sourceAudioBuffer);
	return encodeAudioSegmentToWav(
		decodedAudio,
		{
			startSeconds: 0,
			endSeconds: decodedAudio.duration
		},
		WAV_SEGMENT_SAMPLE_RATE
	);
}

export function splitWavAudioSegment(segment: WavAudioSegment): WavAudioSegment[] {
	const wav = readPcm16MonoWav(segment.audioBuffer);
	const midpointSample = Math.floor(wav.sampleCount / 2);
	if (midpointSample <= 0 || midpointSample >= wav.sampleCount) {
		throw new Error("WAV 分段过短，无法继续拆分。");
	}

	const durationSeconds = segment.endSeconds - segment.startSeconds;
	const midpointSeconds = segment.startSeconds + durationSeconds * (midpointSample / wav.sampleCount);
	const firstPcm = wav.pcmBytes.slice(0, midpointSample * 2);
	const secondPcm = wav.pcmBytes.slice(midpointSample * 2);

	return [
		{
			index: segment.index,
			total: segment.total + 1,
			startSeconds: segment.startSeconds,
			endSeconds: midpointSeconds,
			audioBuffer: encodePcm16MonoToWav(firstPcm, wav.sampleRate),
			mimeType: WAV_SEGMENT_MIME_TYPE
		},
		{
			index: segment.index + 1,
			total: segment.total + 1,
			startSeconds: midpointSeconds,
			endSeconds: segment.endSeconds,
			audioBuffer: encodePcm16MonoToWav(secondPcm, wav.sampleRate),
			mimeType: WAV_SEGMENT_MIME_TYPE
		}
	];
}

function normalizeBoundary(
	boundarySeconds: number,
	fallbackSeconds: number,
	startSeconds: number,
	durationSeconds: number,
	minSegmentSeconds: number
): number {
	if (
		!Number.isFinite(boundarySeconds) ||
		boundarySeconds <= startSeconds + minSegmentSeconds ||
		durationSeconds - boundarySeconds < minSegmentSeconds
	) {
		return fallbackSeconds;
	}

	return Math.min(Math.max(boundarySeconds, startSeconds + minSegmentSeconds), durationSeconds - minSegmentSeconds);
}

async function decodeAudio(sourceAudioBuffer: ArrayBuffer): Promise<AudioBuffer> {
	const AudioContextConstructor = getAudioContextConstructor();
	const audioContext = new AudioContextConstructor();

	try {
		return await audioContext.decodeAudioData(sourceAudioBuffer.slice(0));
	} finally {
		await audioContext.close().catch(() => undefined);
	}
}

function getAudioContextConstructor(): typeof AudioContext {
	const browserWindow = typeof window === "undefined" ? undefined : (window as WindowWithWebkitAudioContext);
	const AudioContextConstructor = browserWindow?.AudioContext ?? browserWindow?.webkitAudioContext;
	if (!AudioContextConstructor) {
		throw new Error("当前环境不支持 Web Audio API，无法对长音频进行本地分段。");
	}

	return AudioContextConstructor;
}

type WindowWithWebkitAudioContext = Window & {
	AudioContext?: typeof AudioContext;
	webkitAudioContext?: typeof AudioContext;
};

function findLowEnergyBoundary(
	audioBuffer: AudioBuffer,
	targetSeconds: number,
	options: SilenceSearchOptions
): number | null {
	const sampleRate = audioBuffer.sampleRate;
	const searchStartSample = Math.max(0, Math.floor((targetSeconds - options.searchWindowSeconds) * sampleRate));
	const searchEndSample = Math.min(
		audioBuffer.length,
		Math.ceil((targetSeconds + options.searchWindowSeconds) * sampleRate)
	);
	const windowSampleCount = Math.max(1, Math.round(options.silenceWindowSeconds * sampleRate));
	const stepSampleCount = Math.max(1, Math.round(windowSampleCount / 2));
	const channelData = getChannelData(audioBuffer);
	let bestRms = Number.POSITIVE_INFINITY;
	let bestSample = -1;

	for (
		let sampleIndex = searchStartSample;
		sampleIndex + windowSampleCount <= searchEndSample;
		sampleIndex += stepSampleCount
	) {
		const rms = calculateMixedRms(channelData, sampleIndex, windowSampleCount);
		if (rms < bestRms) {
			bestRms = rms;
			bestSample = sampleIndex + Math.floor(windowSampleCount / 2);
		}
	}

	if (bestSample < 0 || bestRms > options.silenceRmsThreshold) {
		return null;
	}

	return bestSample / sampleRate;
}

function encodeAudioSegmentToWav(
	audioBuffer: AudioBuffer,
	range: Pick<AudioSegmentRange, "startSeconds" | "endSeconds">,
	targetSampleRate: number
): ArrayBuffer {
	const sourceSampleRate = audioBuffer.sampleRate;
	const channelData = getChannelData(audioBuffer);
	const startSample = Math.max(0, Math.floor(range.startSeconds * sourceSampleRate));
	const endSample = Math.min(audioBuffer.length, Math.ceil(range.endSeconds * sourceSampleRate));
	const durationSeconds = Math.max(0, (endSample - startSample) / sourceSampleRate);
	const outputSampleCount = Math.max(1, Math.round(durationSeconds * targetSampleRate));
	const buffer = new ArrayBuffer(44 + outputSampleCount * 2);
	const view = new DataView(buffer);

	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + outputSampleCount * 2, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, targetSampleRate, true);
	view.setUint32(28, targetSampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, outputSampleCount * 2, true);

	for (let outputIndex = 0; outputIndex < outputSampleCount; outputIndex += 1) {
		const sourcePosition = startSample + (outputIndex * sourceSampleRate) / targetSampleRate;
		const sample = clampSample(readMixedSample(channelData, sourcePosition));
		const pcmValue = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		view.setInt16(44 + outputIndex * 2, pcmValue, true);
	}

	return buffer;
}

function getChannelData(audioBuffer: AudioBuffer): Float32Array[] {
	const channelData: Float32Array[] = [];
	for (let channelIndex = 0; channelIndex < audioBuffer.numberOfChannels; channelIndex += 1) {
		channelData.push(audioBuffer.getChannelData(channelIndex));
	}
	return channelData;
}

function calculateMixedRms(channelData: Float32Array[], startSample: number, sampleCount: number): number {
	let sumSquares = 0;
	for (let sampleOffset = 0; sampleOffset < sampleCount; sampleOffset += 1) {
		const sample = readMixedSample(channelData, startSample + sampleOffset);
		sumSquares += sample * sample;
	}

	return Math.sqrt(sumSquares / sampleCount);
}

function readMixedSample(channelData: Float32Array[], samplePosition: number): number {
	const lowSample = Math.max(0, Math.floor(samplePosition));
	const interpolation = samplePosition - lowSample;
	let mixedSample = 0;

	for (const channel of channelData) {
		const boundedLowSample = Math.min(lowSample, channel.length - 1);
		const boundedHighSample = Math.min(boundedLowSample + 1, channel.length - 1);
		const lowValue = channel[boundedLowSample] ?? 0;
		const highValue = channel[boundedHighSample] ?? lowValue;
		mixedSample += lowValue + (highValue - lowValue) * interpolation;
	}

	return mixedSample / Math.max(1, channelData.length);
}

function clampSample(sample: number): number {
	return Math.min(1, Math.max(-1, sample));
}

function writeAscii(view: DataView, offset: number, value: string): void {
	for (let index = 0; index < value.length; index += 1) {
		view.setUint8(offset + index, value.charCodeAt(index));
	}
}

function readPcm16MonoWav(buffer: ArrayBuffer): {
	sampleRate: number;
	sampleCount: number;
	pcmBytes: Uint8Array;
} {
	const view = new DataView(buffer);
	if (buffer.byteLength < 44 || readAscii(view, 0, 4) !== "RIFF" || readAscii(view, 8, 4) !== "WAVE") {
		throw new Error("仅支持拆分标准 PCM WAV 分段。");
	}

	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bitsPerSample = 0;
	let audioFormat = 0;
	let pcmBytes: Uint8Array | undefined;

	while (offset + 8 <= buffer.byteLength) {
		const chunkId = readAscii(view, offset, 4);
		const chunkSize = view.getUint32(offset + 4, true);
		const dataOffset = offset + 8;
		if (dataOffset + chunkSize > buffer.byteLength) {
			break;
		}

		if (chunkId === "fmt " && chunkSize >= 16) {
			audioFormat = view.getUint16(dataOffset, true);
			channels = view.getUint16(dataOffset + 2, true);
			sampleRate = view.getUint32(dataOffset + 4, true);
			bitsPerSample = view.getUint16(dataOffset + 14, true);
		} else if (chunkId === "data") {
			pcmBytes = new Uint8Array(buffer.slice(dataOffset, dataOffset + chunkSize));
		}

		offset = dataOffset + chunkSize + (chunkSize % 2);
	}

	if (audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16 || !sampleRate || !pcmBytes) {
		throw new Error("仅支持拆分 16-bit 单声道 PCM WAV 分段。");
	}

	return {
		sampleRate,
		sampleCount: Math.floor(pcmBytes.byteLength / 2),
		pcmBytes
	};
}

function encodePcm16MonoToWav(pcmBytes: Uint8Array, sampleRate: number): ArrayBuffer {
	const buffer = new ArrayBuffer(44 + pcmBytes.byteLength);
	const view = new DataView(buffer);
	writeAscii(view, 0, "RIFF");
	view.setUint32(4, 36 + pcmBytes.byteLength, true);
	writeAscii(view, 8, "WAVE");
	writeAscii(view, 12, "fmt ");
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, 1, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	writeAscii(view, 36, "data");
	view.setUint32(40, pcmBytes.byteLength, true);
	new Uint8Array(buffer, 44).set(pcmBytes);
	return buffer;
}

function readAscii(view: DataView, offset: number, length: number): string {
	let value = "";
	for (let index = 0; index < length; index += 1) {
		value += String.fromCharCode(view.getUint8(offset + index));
	}
	return value;
}

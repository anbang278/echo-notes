import type { TFile } from "obsidian";
import type { TranscriptionSegment, TranscriptionUtterance } from "../providers/transcription-provider";
import type { TranscriptionConfig } from "../settings/settings";
import { createSourceAudioMetadata, type SourceAudioMetadata } from "./transcript-source-metadata";

export const TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION = 1;
export const TRANSCRIPTION_SEGMENTATION_VERSION = 1;
export const TRANSCRIPTION_CHECKPOINT_START = "%% echo-notes-checkpoint:start";
export const TRANSCRIPTION_CHECKPOINT_END = "echo-notes-checkpoint:end %%";

const MAX_CHECKPOINT_SEGMENTS = 1000;
const RANGE_TOLERANCE_SECONDS = 0.001;

export interface TranscriptionCheckpointIdentity {
	sourceAudio: SourceAudioMetadata;
	provider: string;
	model: string;
	configurationFingerprint: string;
}

export interface TranscriptionCheckpoint extends TranscriptionCheckpointIdentity {
	schemaVersion: number;
	segmentationVersion: number;
	updatedAt: string;
	segments: TranscriptionSegment[];
}

export function createTranscriptionCheckpointIdentity(
	audioFile: TFile,
	config: TranscriptionConfig
): TranscriptionCheckpointIdentity {
	return {
		sourceAudio: createSourceAudioMetadata(audioFile),
		provider: config.provider,
		model: config.model,
		configurationFingerprint: createTranscriptionConfigurationFingerprint(config)
	};
}

export function createTranscriptionConfigurationFingerprint(config: TranscriptionConfig): string {
	return createStableFingerprint(JSON.stringify({
		segmentationVersion: TRANSCRIPTION_SEGMENTATION_VERSION,
		provider: config.provider,
		baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
		model: config.model.trim(),
		language: config.language.trim()
	}));
}

export function createTranscriptionCheckpoint(
	identity: TranscriptionCheckpointIdentity,
	segments: readonly TranscriptionSegment[],
	updatedAt = new Date().toISOString()
): TranscriptionCheckpoint {
	return {
		schemaVersion: TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION,
		segmentationVersion: TRANSCRIPTION_SEGMENTATION_VERSION,
		...identity,
		updatedAt,
		segments: segments.map(cloneSegment)
	};
}

export function renderTranscriptionCheckpoint(checkpoint: TranscriptionCheckpoint): string {
	const json = JSON.stringify(checkpoint, null, 2).replace(/%%/g, "%\\u0025");
	return [TRANSCRIPTION_CHECKPOINT_START, json, TRANSCRIPTION_CHECKPOINT_END].join("\n");
}

export function readResumableTranscriptionSegments(
	content: string,
	expected: TranscriptionCheckpointIdentity
): TranscriptionSegment[] {
	const checkpoint = parseTranscriptionCheckpoint(content);
	if (!checkpoint || !matchesIdentity(checkpoint, expected)) {
		return [];
	}
	return isContinuousSegmentPrefix(checkpoint.segments)
		? checkpoint.segments.map(cloneSegment)
		: [];
}

export function parseTranscriptionCheckpoint(content: string): TranscriptionCheckpoint | null {
	const startIndex = content.indexOf(TRANSCRIPTION_CHECKPOINT_START);
	const endIndex = content.indexOf(
		TRANSCRIPTION_CHECKPOINT_END,
		startIndex + TRANSCRIPTION_CHECKPOINT_START.length
	);
	if (startIndex === -1 || endIndex === -1) {
		return null;
	}
	const json = content.slice(startIndex + TRANSCRIPTION_CHECKPOINT_START.length, endIndex).trim();
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return null;
	}
	return parseCheckpoint(value);
}

function parseCheckpoint(value: unknown): TranscriptionCheckpoint | null {
	if (
		!isRecord(value) ||
		value.schemaVersion !== TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION ||
		value.segmentationVersion !== TRANSCRIPTION_SEGMENTATION_VERSION ||
		!isRecord(value.sourceAudio) ||
		typeof value.sourceAudio.path !== "string" ||
		!isNonNegativeNumber(value.sourceAudio.size) ||
		!isNonNegativeNumber(value.sourceAudio.mtime) ||
		typeof value.provider !== "string" ||
		typeof value.model !== "string" ||
		typeof value.configurationFingerprint !== "string" ||
		typeof value.updatedAt !== "string" ||
		!Array.isArray(value.segments) ||
		value.segments.length > MAX_CHECKPOINT_SEGMENTS
	) {
		return null;
	}
	const segments = value.segments.map(parseSegment);
	if (segments.some((segment) => segment === null)) {
		return null;
	}
	return {
		schemaVersion: TRANSCRIPTION_CHECKPOINT_SCHEMA_VERSION,
		segmentationVersion: TRANSCRIPTION_SEGMENTATION_VERSION,
		sourceAudio: {
			path: value.sourceAudio.path,
			size: value.sourceAudio.size,
			mtime: value.sourceAudio.mtime
		},
		provider: value.provider,
		model: value.model,
		configurationFingerprint: value.configurationFingerprint,
		updatedAt: value.updatedAt,
		segments: segments as TranscriptionSegment[]
	};
}

function parseSegment(value: unknown): TranscriptionSegment | null {
	if (
		!isRecord(value) ||
		!isPositiveInteger(value.index) ||
		!isPositiveInteger(value.total) ||
		!isNonNegativeNumber(value.startSeconds) ||
		!isNonNegativeNumber(value.endSeconds) ||
		value.endSeconds <= value.startSeconds ||
		typeof value.text !== "string"
	) {
		return null;
	}
	let utterances: TranscriptionUtterance[] | undefined;
	if (value.utterances !== undefined) {
		if (!Array.isArray(value.utterances)) {
			return null;
		}
		const parsedUtterances = value.utterances.map(parseUtterance);
		if (parsedUtterances.some((utterance) => utterance === null)) {
			return null;
		}
		utterances = parsedUtterances as TranscriptionUtterance[];
	}
	return {
		index: value.index,
		total: value.total,
		startSeconds: value.startSeconds,
		endSeconds: value.endSeconds,
		text: value.text,
		traceId: typeof value.traceId === "string" ? value.traceId : undefined,
		utterances
	};
}

function parseUtterance(value: unknown): TranscriptionUtterance | null {
	if (
		!isRecord(value) ||
		typeof value.speakerId !== "string" ||
		typeof value.text !== "string" ||
		(value.startSeconds !== undefined && !isNonNegativeNumber(value.startSeconds)) ||
		(value.endSeconds !== undefined && !isNonNegativeNumber(value.endSeconds))
	) {
		return null;
	}
	return {
		speakerId: value.speakerId,
		text: value.text,
		startSeconds: typeof value.startSeconds === "number" ? value.startSeconds : undefined,
		endSeconds: typeof value.endSeconds === "number" ? value.endSeconds : undefined
	};
}

function matchesIdentity(
	checkpoint: TranscriptionCheckpointIdentity,
	expected: TranscriptionCheckpointIdentity
): boolean {
	return checkpoint.sourceAudio.path === expected.sourceAudio.path &&
		checkpoint.sourceAudio.size === expected.sourceAudio.size &&
		checkpoint.sourceAudio.mtime === expected.sourceAudio.mtime &&
		checkpoint.provider === expected.provider &&
		checkpoint.model === expected.model &&
		checkpoint.configurationFingerprint === expected.configurationFingerprint;
}

function isContinuousSegmentPrefix(segments: readonly TranscriptionSegment[]): boolean {
	let expectedStart = 0;
	for (const segment of segments) {
		if (Math.abs(segment.startSeconds - expectedStart) > RANGE_TOLERANCE_SECONDS) {
			return false;
		}
		expectedStart = segment.endSeconds;
	}
	return true;
}

function cloneSegment(segment: TranscriptionSegment): TranscriptionSegment {
	return {
		...segment,
		utterances: segment.utterances?.map((utterance) => ({ ...utterance }))
	};
}

function createStableFingerprint(value: string): string {
	return `${hash32(value, 0x811c9dc5)}${hash32(value, 0x9e3779b9)}${value.length.toString(16).padStart(8, "0")}`;
}

function hash32(value: string, seed: number): string {
	let hash = seed >>> 0;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

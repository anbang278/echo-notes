import {
	TranscriptionError, type LocalSpeakerAttribution, type LocalSpeakerNumber, type TranscriptionUtterance
} from "./transcription-provider";

import { LOCAL_OPENAI_DIARIZATION_MODEL } from "../settings/settings";
const ROUNDING_TOLERANCE = 0.001;

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never {
	throw new TranscriptionError("invalid_response", "本地分离结果的说话人、时间轴或正文不完整；结果仍保留在服务端。");
}
function time(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function speaker(value: unknown): value is LocalSpeakerNumber {
	return value === 1 || value === 2 || value === 3 || value === 4;
}

/** Accept only the verified MLX diarization schema, never arbitrary raw provider objects. */
export function parseLocalMlxResult(payload: unknown, model: string): { text: string; utterances?: TranscriptionUtterance[] } {
	if (!object(payload) || typeof payload.text !== "string") {
		throw new TranscriptionError("invalid_response", "本地服务结果缺少 text 字段。");
	}
	if (model !== LOCAL_OPENAI_DIARIZATION_MODEL) return { text: payload.text };
	if (!Array.isArray(payload.segments) || typeof payload.transcript !== "string"
		|| !time(payload.duration) || payload.duration <= 0 || payload.duration > 8 * 3600
		|| typeof payload.speaker_count !== "number" || !Number.isInteger(payload.speaker_count)
		|| payload.speaker_count < 0 || payload.speaker_count > 4) invalid();
	const speakerCount = payload.speaker_count;
	let previousEnd = 0;
	const utterances: TranscriptionUtterance[] = [];
	for (const segment of payload.segments) {
		if (!object(segment) || typeof segment.text !== "string" || !segment.text.trim()
			|| !time(segment.start) || !time(segment.end) || segment.end < segment.start
			|| segment.end > payload.duration + ROUNDING_TOLERANCE || segment.start < previousEnd - ROUNDING_TOLERANCE
			|| !Array.isArray(segment.speakers) || !segment.speakers.every(speaker) || typeof segment.overlap !== "boolean") invalid();
		const speakers: LocalSpeakerNumber[] = segment.speakers;
		if (speakers.some((number, index) => number > speakerCount || (index > 0 && number <= speakers[index - 1]))) invalid();
		if (speakers.length === 1 ? segment.speaker !== `speaker_${speakers[0]}` || segment.overlap : segment.speaker !== null) invalid();
		if (speakers.length < 2 && segment.overlap) invalid();
		const kind: LocalSpeakerAttribution["kind"] = speakers.length === 0 ? "unassigned"
			: speakers.length === 1 ? "identified" : segment.overlap ? "overlap" : "boundary";
		utterances.push({
			speakerId: `local-mlx-${kind}-${speakers.join("-") || "unknown"}`,
			text: segment.text, startSeconds: segment.start, endSeconds: segment.end,
			localSpeaker: { kind, speakers: [...speakers] }
		});
		previousEnd = segment.end;
	}
	// The service inserts newlines between inference windows, not additional speech.
	const withoutLineBreaks = (text: string) => text.replace(/[\r\n]/g, "");
	if (withoutLineBreaks(utterances.map((u) => u.text).join("")) !== withoutLineBreaks(payload.transcript)) invalid();
	if (utterances.length === 0 && (payload.text !== "" || payload.transcript !== "")) invalid();
	if (utterances.length > 0 && !payload.text.trim()) invalid();
	return { text: payload.text, ...(utterances.length > 0 ? { utterances } : {}) };
}

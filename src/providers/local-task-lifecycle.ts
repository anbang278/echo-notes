import type { LocalTranscriptionPhase, LocalTranscriptionTaskResume, TranscriptionProgress } from "./transcription-provider";

export const LOCAL_TRANSCRIPT_SAVE_STAGE = "保存转写稿";

const PHASE_LABELS: Record<LocalTranscriptionPhase, string> = {
	creating: "创建本地任务", uploading: "上传音频", waiting: "等待服务返回", decoding: "解码音频",
	diarizing: "分离说话人", transcribing: "转写音频", aligning: "对齐时间轴", saving: LOCAL_TRANSCRIPT_SAVE_STAGE,
	canceling: "正在取消，等待服务确认", canceled: "本地任务已取消", "cleanup-pending": "转写稿已保存，服务端清理待重试"
};

/** Whitelist persistent metadata, including when loaded from an older plugin. */
export function parseLocalTask(value: unknown): LocalTranscriptionTaskResume | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const v = value as Record<string, unknown>;
	if (v.protocol !== 1 || typeof v.origin !== "string" || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):1808[01]$/.test(v.origin)) return undefined;
	const text = (key: string): string | undefined => typeof v[key] === "string" && v[key].length > 0 && v[key].length <= 2000 ? v[key] : undefined;
	const clientRequestId = text("clientRequestId"), instanceId = text("instanceId"), sourcePath = text("sourcePath");
	const sourceIdentity = text("sourceIdentity"), model = text("model"), language = text("language"), configurationFingerprint = text("configurationFingerprint");
	const phase = text("phase") as LocalTranscriptionPhase | undefined;
	if (!clientRequestId || !instanceId || !sourcePath || !sourceIdentity || !model || !language || !configurationFingerprint || !phase || !Object.hasOwn(PHASE_LABELS, phase)) return undefined;
	if (["sourceSize", "sourceMtimeMs", "confirmedOffset"].some(k => typeof v[k] !== "number" || !Number.isFinite(v[k]) || v[k] < 0)) return undefined;
	const sourceSize = v.sourceSize as number, confirmedOffset = v.confirmedOffset as number;
	if (!Number.isSafeInteger(sourceSize) || !Number.isSafeInteger(confirmedOffset) || confirmedOffset > sourceSize) return undefined;
	return {
		protocol: 1, origin: v.origin, clientRequestId, instanceId, sourcePath, sourceSize,
		sourceMtimeMs: v.sourceMtimeMs as number, sourceIdentity, model, language, configurationFingerprint,
		confirmedOffset, phase, ...(text("jobId") ? { jobId: text("jobId") } : {}), ...(v.cancelRequested === true ? { cancelRequested: true } : {})
	};
}

export function formatLocalProgress(progress: Extract<TranscriptionProgress, { type: "local-asr-progress" }>): string {
	const label = PHASE_LABELS[progress.phase];
	if (progress.phase === "uploading" && progress.totalBytes) {
		return `${label} ${Math.min(100, Math.floor((progress.uploadedBytes ?? 0) / progress.totalBytes * 100))}%`;
	}
	if (progress.totalSeconds && progress.processedSeconds !== undefined) {
		return `${label} ${Math.min(100, Math.floor(progress.processedSeconds / progress.totalSeconds * 100))}%`;
	}
	return label;
}

/** Never let a late upload acknowledgement erase the durable cancel intent. */
export function mergeLocalCheckpoint(previous: LocalTranscriptionTaskResume | undefined, next: LocalTranscriptionTaskResume): LocalTranscriptionTaskResume {
	return previous?.cancelRequested && previous.clientRequestId === next.clientRequestId
		? { ...next, cancelRequested: true, phase: previous.phase === "canceled" ? "canceled" : "canceling" }
		: { ...next };
}

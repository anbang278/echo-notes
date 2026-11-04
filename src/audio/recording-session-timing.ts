export interface RecordingSessionTiming {
	startedAt: number;
	endedAt: number;
	durationMs: number;
}

/** A wall-clock jump must not turn the displayed interval into a misleading duration. */
export function formatRecordingSessionTiming(timing: RecordingSessionTiming): string | null {
	const { startedAt, endedAt, durationMs } = timing;
	if (![startedAt, endedAt, durationMs].every(Number.isFinite)
		|| durationMs < 0 || endedAt < startedAt
		|| Math.abs(endedAt - startedAt - durationMs) > 5000) return null;
	const start = new Date(startedAt);
	const end = new Date(endedAt);
	if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
	const date = (value: Date) => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
	const time = (value: Date) => `${pad(value.getHours())}:${pad(value.getMinutes())}`;
	const sameDay = date(start) === date(end);
	const from = sameDay ? time(start) : `${date(start)} ${time(start)}`;
	const to = sameDay ? time(end) : `${date(end)} ${time(end)}`;
	const minutes = Math.floor(durationMs / 60000);
	const hours = Math.floor(minutes / 60);
	const remainder = minutes % 60;
	let duration = "不到1分钟";
	if (hours > 0) duration = `${hours}小时${remainder ? `${remainder}分钟` : ""}`;
	else if (minutes > 0) duration = `${minutes}分钟`;
	return `录音时间：${from}–${to}（${duration}）`;
}

function pad(value: number): string {
	return String(value).padStart(2, "0");
}

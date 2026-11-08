import type { CatalogQuery, MeetingRecord, MeetingTime } from "./catalog-types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isCalendarDate(value: string): boolean {
	if (!DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T12:00:00Z`);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function isInstant(value: string): boolean {
	return INSTANT_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

export function validateMeetingTime(time: MeetingTime): void {
	if (time.precision === "unknown") return;
	if (time.precision === "date") {
		if (!isCalendarDate(time.date)) throw new Error("会议日期无效，请使用 YYYY-MM-DD。");
		return;
	}
	if (!isInstant(time.startedAt) || (time.endedAt !== undefined && (!isInstant(time.endedAt) || Date.parse(time.endedAt) < Date.parse(time.startedAt)))) {
		throw new Error("会议时间必须包含时区，且结束时间不能早于开始时间。");
	}
	if (time.timezone) validateDisplayTimezone(time.timezone);
}

export function validateDisplayTimezone(timezone: string): void {
	if (/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(timezone)) return;
	try {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format(new Date(0));
	} catch {
		throw new Error("显示时区无效，请选择有效的 IANA 时区或固定 UTC 偏移。");
	}
}

export function instantDate(value: number | string, timezone: string): string {
	validateDisplayTimezone(timezone);
	const date = new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error("无法投影无效时间。");
	if (/^[+-]\d{2}:\d{2}$/.test(timezone)) {
		const sign = timezone.startsWith("-") ? -1 : 1;
		const minutes = Number(timezone.slice(1, 3)) * 60 + Number(timezone.slice(4));
		return new Date(date.getTime() + sign * minutes * 60_000).toISOString().slice(0, 10);
	}
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
	const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
	return `${part("year")}-${part("month")}-${part("day")}`;
}

export function nextCalendarDate(value: string): string {
	if (!isCalendarDate(value)) throw new Error("日期无效。");
	const next = new Date(`${value}T12:00:00Z`);
	next.setUTCDate(next.getUTCDate() + 1);
	return next.toISOString().slice(0, 10);
}

/** Find an actual local-day boundary without assuming a day contains 24 hours. */
export function localDayBounds(date: string, timezone: string): { start: number; end: number } {
	if (!isCalendarDate(date)) throw new Error("日期无效。");
	validateDisplayTimezone(timezone);
	const find = (target: string): number => {
		const center = Date.parse(`${target}T12:00:00Z`);
		let low = center - 48 * 3_600_000;
		let high = center + 48 * 3_600_000;
		while (high - low > 1) {
			const midpoint = Math.floor((low + high) / 2);
			if (instantDate(midpoint, timezone) < target) low = midpoint;
			else high = midpoint;
		}
		return high;
	};
	return { start: find(date), end: find(nextCalendarDate(date)) };
}

export function meetingDates(time: MeetingTime, timezone: string): string[] {
	validateMeetingTime(time);
	if (time.precision === "unknown") return [];
	if (time.precision === "date") return [time.date];
	const start = Date.parse(time.startedAt);
	const end = time.endedAt ? Date.parse(time.endedAt) : start;
	const first = instantDate(start, timezone);
	const last = instantDate(end > start ? end - 1 : start, timezone);
	const dates = [first];
	let current = first;
	while (current < last && dates.length < 3660) {
		current = nextCalendarDate(current);
		dates.push(current);
	}
	if (current !== last) throw new Error("会议区间过长，请检查实际起止时间。");
	return dates;
}

export function filterMeetings(meetings: readonly MeetingRecord[], query: CatalogQuery): MeetingRecord[] {
	validateDisplayTimezone(query.timezone);
	const search = query.search?.trim().toLocaleLowerCase();
	return meetings.filter((meeting) => {
		if (meeting.stages.recording === "canceled") return false;
		const dates = meetingDates(meeting.time, query.timezone);
		if (query.undated && dates.length !== 0) return false;
		if (query.date && !dates.includes(query.date)) return false;
		if (query.fromDate && !dates.some((date) => date >= query.fromDate!)) return false;
		if (query.toDate && !dates.some((date) => date <= query.toDate!)) return false;
		if (query.unlinked && meeting.projectIds.length !== 0) return false;
		if (query.projectIds?.length && !query.projectIds.some((id) => meeting.projectIds.includes(id))) return false;
		if (query.tags?.length && !query.tags.some((tag) => meeting.tags.includes(tag))) return false;
		return !search || `${meeting.title}\n${meeting.excerpt ?? ""}\n${meeting.summary ?? ""}\n${meeting.tags.join(" ")}`.toLocaleLowerCase().includes(search);
	}).sort((left, right) => {
		if (left.time.precision === "instant" && right.time.precision === "instant") return Date.parse(right.time.startedAt) - Date.parse(left.time.startedAt) || left.id.localeCompare(right.id);
		const a = left.time.precision === "instant" ? instantDate(left.time.startedAt, query.timezone) : left.time.precision === "date" ? left.time.date : "";
		const b = right.time.precision === "instant" ? instantDate(right.time.startedAt, query.timezone) : right.time.precision === "date" ? right.time.date : "";
		return b.localeCompare(a) || left.id.localeCompare(right.id);
	});
}

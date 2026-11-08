import type { CatalogSnapshot, MeetingRecord } from "../catalog/catalog-types";
import { filterMeetings } from "../catalog/catalog-time";

export type MeetingWorkspaceMode = "reader" | "projects";
export type WorkspaceDateMode = "day" | "week" | "all" | "undated";

export interface MeetingWorkspaceState {
	mode: MeetingWorkspaceMode;
	date: string;
	dateMode: WorkspaceDateMode;
	projectIds: string[];
	tags: string[];
	search: string;
	unlinked: boolean;
	selectedMeetingId: string | null;
	detailTab: "summary" | "transcript" | "memory";
	mobileDetail: boolean;
}

export function localDateKey(date: Date, timezone: string): string {
	const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
	const value = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
	return `${value("year")}-${value("month")}-${value("day")}`;
}

export function shiftDateKey(date: string, days: number): string {
	const value = new Date(`${date}T12:00:00Z`);
	value.setUTCDate(value.getUTCDate() + days);
	return value.toISOString().slice(0, 10);
}

export function createMeetingWorkspaceState(mode: MeetingWorkspaceMode, timezone: string): MeetingWorkspaceState {
	return { mode, date: localDateKey(new Date(), timezone), dateMode: "day", projectIds: [], tags: [], search: "", unlinked: false, selectedMeetingId: null, detailTab: "summary", mobileDetail: false };
}

export function visibleWorkspaceMeetings(snapshot: CatalogSnapshot, state: MeetingWorkspaceState, timezone: string): MeetingRecord[] {
	return filterMeetings(snapshot.meetings.filter((meeting) => !meeting.missing), {
		timezone,
		...(state.dateMode === "day" ? { date: state.date } : {}),
		...(state.dateMode === "week" ? { fromDate: shiftDateKey(state.date, -6), toDate: state.date } : {}),
		undated: state.dateMode === "undated",
		projectIds: state.projectIds,
		tags: state.tags,
		search: state.search,
		unlinked: state.unlinked
	});
}

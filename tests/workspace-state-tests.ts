import assert from "node:assert/strict";
import type { CatalogSnapshot, MeetingRecord, MeetingTime } from "../src/catalog/catalog-types";
import { createMeetingWorkspaceState, localDateKey, shiftDateKey, visibleWorkspaceMeetings } from "../src/workspace/workspace-state";

function meeting(id: string, time: MeetingTime, projectIds: string[], tags: string[], extra: Partial<MeetingRecord> = {}): MeetingRecord {
	return { id, path: `Meetings/${id}.md`, title: `会议 ${id}`, time, projectIds, tags, sourceIds: [], recordingIds: [], stages: { recording: "saved", transcription: "done", analysis: "none", memory: "none" }, ...extra };
}

export function runWorkspaceStateTests(): void {
	const snapshot: CatalogSnapshot = {
		schemaVersion: 1, projects: [], sources: [], recordings: [], issues: [], meetings: [
			meeting("cross", { precision: "instant", startedAt: "2026-11-07T23:30:00+08:00", endedAt: "2026-11-08T00:30:00+08:00", timezone: "Asia/Taipei", source: "recording", confirmed: false }, ["p1", "p2"], ["风险", "评审"]),
			meeting("midnight", { precision: "instant", startedAt: "2026-11-07T23:30:00+08:00", endedAt: "2026-11-08T00:00:00+08:00", timezone: "Asia/Taipei", source: "recording", confirmed: false }, ["p2"], ["风险"]),
			meeting("date", { precision: "date", date: "2026-11-08", source: "user", confirmed: true }, ["p1"], ["决策"], { excerpt: "人工描述中的试点" }),
			meeting("unknown", { precision: "unknown" }, [], ["导入"]),
			meeting("missing", { precision: "date", date: "2026-11-08", source: "user", confirmed: true }, ["p1"], ["风险"], { missing: true }),
			meeting("canceled", { precision: "date", date: "2026-11-08", source: "user", confirmed: true }, [], [], { stages: { recording: "canceled", transcription: "none", analysis: "none", memory: "none" } })
		]
	};
	const state = createMeetingWorkspaceState("reader", "Asia/Taipei");
	assert.equal(state.mode, "reader");
	assert.match(state.date, /^\d{4}-\d{2}-\d{2}$/);
	state.date = "2026-11-08";
	state.projectIds = ["p1", "p2"];
	state.tags = ["评审", "决策"];
	state.selectedMeetingId = "cross";
	state.detailTab = "transcript";
	state.mobileDetail = true;
	const before = visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id);
	assert.deepEqual(new Set(before), new Set(["cross", "date"]), "same dimension is OR, different dimensions are AND");
	const projectReference = state.projectIds;
	const tagsReference = state.tags;
	state.mode = "projects";
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), before, "B/C switch must reuse the same data selection");
	assert.equal(state.projectIds, projectReference);
	assert.equal(state.tags, tagsReference);
	assert.equal(state.date, "2026-11-08");
	assert.equal(state.selectedMeetingId, "cross");
	assert.equal(state.detailTab, "transcript");
	assert.equal(state.mobileDetail, true);
	state.mode = "reader";
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), before);
	state.tags = ["风险"];
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), ["cross"], "zero-duration overlap at midnight must not add the meeting to the next day");
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "America/New_York"), [], "instant meetings should project using the chosen display timezone");
	state.tags = ["决策"];
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "America/New_York").map((item) => item.id), ["date"], "date-only meetings must not drift with timezone");
	state.tags = [];
	state.projectIds = [];
	state.dateMode = "undated";
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), ["unknown"]);
	state.dateMode = "all";
	state.unlinked = true;
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), ["unknown"]);
	state.unlinked = false;
	state.search = "试点";
	assert.deepEqual(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").map((item) => item.id), ["date"]);
	state.search = "";
	state.dateMode = "week";
	assert.equal(visibleWorkspaceMeetings(snapshot, state, "Asia/Taipei").length, 3, "week lists deduplicate a cross-day meeting by its stable ID");
	assert.equal(shiftDateKey("2026-03-09", -1), "2026-03-08");
	assert.equal(localDateKey(new Date("2026-11-07T23:30:00Z"), "Asia/Taipei"), "2026-11-08");
	assert.equal(localDateKey(new Date("2026-11-07T23:30:00Z"), "America/New_York"), "2026-11-07");
	const offsets: CatalogSnapshot = { ...snapshot, meetings: [
		meeting("offset", { precision: "instant", startedAt: "2026-11-08T01:00:00+08:00", source: "user", confirmed: true }, [], []),
		meeting("utc", { precision: "instant", startedAt: "2026-11-07T18:00:00Z", source: "user", confirmed: true }, [], [])
	] };
	state.dateMode = "all";
	assert.deepEqual(visibleWorkspaceMeetings(offsets, state, "Asia/Taipei").map((item) => item.id), ["utc", "offset"], "offset strings must sort by actual instant rather than ISO string spelling");
	console.log("Workspace B/C shared state, AND/OR, undated, timezone and calendar tests passed.");
}

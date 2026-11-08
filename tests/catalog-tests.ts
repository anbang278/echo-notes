import assert from "node:assert/strict";
import { CatalogRepository } from "../src/catalog/catalog-repository";
import { catalogSha256, parseCatalogDocument, updateCatalogDocument } from "../src/catalog/catalog-document";
import { filterMeetings, instantDate, localDayBounds, meetingDates } from "../src/catalog/catalog-time";
import type { CatalogStorage, CatalogYamlCodec } from "../src/catalog/catalog-types";

export const catalogTestYaml: CatalogYamlCodec = {
	parse: (source) => JSON.parse(source) as unknown,
	stringify: (properties) => JSON.stringify(properties, null, 2)
};

export class CatalogTestStorage implements CatalogStorage {
	readonly files = new Map<string, string>();
	readonly folders = new Set<string>();
	readonly writes: string[] = [];
	failPath: string | null = null;
	async ensureFolder(folder: string): Promise<void> { this.folders.add(folder); }
	async read(path: string): Promise<string | null> { return this.files.get(path) ?? null; }
	async list(folder: string): Promise<string[]> { return [...this.files.keys()].filter((path) => path.startsWith(`${folder}/`)).sort(); }
	async create(path: string, content: string): Promise<void> {
		if (this.failPath === path) throw new Error("injected write failure");
		if (this.files.has(path)) throw new Error("already exists");
		this.files.set(path, content); this.writes.push(path);
	}
	async write(path: string, content: string): Promise<void> {
		if (this.failPath === path) throw new Error("injected write failure");
		this.files.set(path, content); this.writes.push(path);
	}
	async process(path: string, update: (current: string) => string): Promise<string> {
		if (this.failPath === path) throw new Error("injected write failure");
		const current = this.files.get(path);
		if (current === undefined) throw new Error("missing document");
		const next = update(current); this.files.set(path, next); this.writes.push(path); return next;
	}
	async remove(path: string): Promise<void> { this.files.delete(path); this.writes.push(path); }
}

export function createCatalogTestRepository(language: "zh" | "en" = "zh"): { repository: CatalogRepository; storage: CatalogTestStorage } {
	const storage = new CatalogTestStorage();
	let sequence = 0;
	const repository = new CatalogRepository({ storage, yaml: catalogTestYaml, rootFolder: "Echo Memory", language, transcriptFolders: ["Transcripts"], now: () => "2026-11-08T02:00:00Z", createId: (kind) => `${kind}_${String(++sequence).padStart(8, "0")}-0000-4000-8000-000000000000` });
	return { repository, storage };
}

export function catalogTestDocument(properties: Record<string, unknown>, body: string): string {
	return `---\n${JSON.stringify(properties, null, 2)}\n---\n${body}`;
}

export async function runCatalogTests(): Promise<void> {
	const { repository, storage } = createCatalogTestRepository();
	await repository.initialize();
	assert.ok(storage.folders.has(repository.paths.questionsDir));
	assert.ok(storage.folders.has(repository.paths.evidenceDir));
	assert.equal(await storage.read(repository.paths.memory.manifest), null, "catalog bootstrap must not initialize Memory profiles");
	const recording = await repository.startRecording({ sessionKey: "session-1", title: "会议 A", startedAt: "2026-11-07T23:30:00+08:00", timezone: "Asia/Taipei" });
	assert.equal((await repository.startRecording({ sessionKey: "session-1" })).id, recording.id, "retrying a recording session must reuse its identity");
	let snapshot = await repository.snapshot();
	assert.equal(snapshot.meetings.length, 1);
	assert.equal(snapshot.meetings[0].stages.recording, "recording");
	assert.equal(snapshot.meetings[0].time.precision, "instant");
	await repository.finishRecording(recording.id, { audioPath: "Audio/会议 A.webm", endedAt: "2026-11-08T00:00:00+08:00", durationMs: 30 * 60_000 });
	snapshot = await repository.snapshot();
	assert.deepEqual(meetingDates(snapshot.meetings[0].time, "Asia/Taipei"), ["2026-11-07"], "midnight endpoint is exclusive");
	const sameMeeting = await repository.ensureMeetingForAudio("Audio/会议 A.webm");
	assert.equal(sameMeeting.id, recording.meetingId);
	assert.equal((await repository.snapshot()).meetings.length, 1);
	await storage.create("Transcripts/会议 A.transcript.md", catalogTestDocument({ type: "audio-transcript", status: "failed", custom: { keep: ["a", "b"] } }, "# 转写\n\n## 转写正文\n原文。\n"));
	const source = await repository.registerTranscript({ transcriptPath: "Transcripts/会议 A.transcript.md", audioPath: "Audio/会议 A.webm" });
	assert.equal(source.meetingId, recording.meetingId);
	assert.equal((await repository.registerTranscript({ transcriptPath: source.path, audioPath: "Audio/会议 A.webm" })).id, source.id);
	assert.equal((await repository.snapshot()).meetings[0].stages.transcription, "failed");
	assert.ok((await storage.read((await repository.snapshot()).meetings[0].path))!.includes(`[[${source.path}]]`), "meeting Markdown must expose registered transcript resources");
	await storage.process(source.path, (current) => updateCatalogDocument(current, { analysis_status: "analysis_failed", analysis_failed_template_ids: ["new-template"] }, catalogTestYaml));
	assert.equal((await repository.snapshot()).meetings[0].stages.analysis, "failed", "a failed analysis must not be presented as never started");
	await storage.process(source.path, (current) => `${current}\n<!-- echo-notes-analysis:start -->\n<!-- echo-notes-analysis-item:start work-minutes -->\n既有成功分析\n<!-- echo-notes-analysis-item:end work-minutes -->\n<!-- echo-notes-analysis:end -->\n`);
	assert.equal((await repository.snapshot()).meetings[0].stages.analysis, "partial_failed", "a preserved success and a newly failed template must remain distinguishable");
	await storage.process(source.path, (current) => updateCatalogDocument(current, { analysis_status: "analysis_pending", analysis_pending_template_ids: ["retry-template"] }, catalogTestYaml));
	assert.equal((await repository.snapshot()).meetings[0].stages.analysis, "running");
	assert.deepEqual(parseCatalogDocument((await storage.read(source.path))!, catalogTestYaml).properties.custom, { keep: ["a", "b"] });
	assert.match((await repository.readSourceContent(source.id))!, /原文/);
	await repository.updateMeetingMetadata(recording.meetingId, { time: { precision: "date", date: "2026-11-01", source: "user", confirmed: true }, excerpt: "人工简述", tags: ["决策", "风险"] });
	await repository.finishRecording(recording.id, { audioPath: "Audio/会议 A.webm", endedAt: "2026-11-08T00:01:00+08:00", durationMs: 31 * 60_000 });
	assert.equal((await repository.snapshot()).meetings[0].time.precision, "date", "recording updates cannot overwrite user-confirmed meeting time");
	await repository.setRecordingState(recording.id, "interrupted");
	assert.equal((await repository.snapshot()).recordings[0].state, "saved", "a delayed interruption callback must not regress an already saved recording");
	const first = await repository.registerProject("项目/同名.md", "同名项目");
	const second = await repository.registerProject("归档/同名.md", "同名项目");
	assert.notEqual(first.id, second.id);
	await repository.setMeetingProjects(recording.meetingId, [first.id, second.id]);
	snapshot = await repository.snapshot();
	assert.deepEqual(snapshot.meetings[0].projectIds, [first.id, second.id]);
	assert.ok((await storage.read(first.path))!.includes(snapshot.meetings[0].path), "project Markdown timeline must be a managed projection of meeting relationships");
	assert.equal(filterMeetings(snapshot.meetings, { timezone: "Asia/Taipei", projectIds: [first.id], tags: ["风险", "不存在"] }).length, 1);
	assert.equal(filterMeetings(snapshot.meetings, { timezone: "Asia/Taipei", projectIds: [first.id], tags: ["不存在"] }).length, 0);
	await assert.rejects(repository.setMeetingProjects(recording.meetingId, [first.id, first.id]), /重复/);
	await assert.rejects(repository.setMeetingProjects(recording.meetingId, ["prj_unknown-00000000"]), /不存在/);
	const meetingPath = snapshot.meetings[0].path;
	await storage.process(meetingPath, (current) => updateCatalogDocument(current, { echo_project_ids: undefined }, catalogTestYaml));
	assert.deepEqual((await repository.snapshot()).meetings[0].projectIds, [], "deleting v1 relationship must not revive legacy names");
	await repository.refreshProjections();
	assert.ok(!(await storage.read(first.path))!.includes(meetingPath), "manual relationship edits must refresh the native project Markdown projection");
	const writesBeforeProjection = storage.writes.length;
	await repository.refreshProjections();
	assert.equal(storage.writes.length, writesBeforeProjection, "unchanged projections must not write files and trigger a refresh loop");
	storage.failPath = first.path;
	await storage.process(meetingPath, (current) => updateCatalogDocument(current, { echo_project_ids: [first.id] }, catalogTestYaml));
	await repository.refreshProjections();
	assert.ok((await repository.snapshot()).issues.some((issue) => issue.code === "INVALID_METADATA" && issue.path === first.path), "partial projection failures must be reported while other projections proceed");
	storage.failPath = null;
	await repository.refreshProjections();
	const moved = "归档/已移动项目.md";
	storage.files.set(moved, storage.files.get(first.path)!); storage.files.delete(first.path);
	await repository.notifyRename(first.path, moved);
	assert.equal((await repository.snapshot()).projects.find((project) => project.id === first.id)?.path, moved);
	await repository.setMeetingProjects(recording.meetingId, [first.id]);
	storage.files.delete(moved);
	assert.ok((await repository.snapshot()).issues.some((issue) => issue.code === "PROJECT_MISSING"));
	const rebuilt = await repository.registerProject(moved, "同名项目");
	assert.notEqual(rebuilt.id, first.id, "same-name recreation does not inherit project identity");
	assert.deepEqual((await repository.snapshot()).meetings[0].projectIds, [first.id]);
	storage.files.set("Echo Memory/01 会议/副本.md", storage.files.get(meetingPath)!);
	assert.ok((await repository.snapshot()).issues.some((issue) => issue.code === "IDENTITY_CONFLICT"));
	storage.files.delete("Echo Memory/01 会议/副本.md");
	storage.files.delete(meetingPath);
	assert.ok((await repository.snapshot()).meetings[0].missing);
	await assert.rejects(repository.ensureMeetingForAudio("Audio/会议 A.webm"), /缺失/);
	assert.equal(await storage.read(meetingPath), null, "refresh and retries must not recreate deliberately deleted meeting files");

	const interrupted = createCatalogTestRepository();
	await interrupted.repository.initialize();
	interrupted.storage.failPath = `${interrupted.repository.paths.meetingsDir}/恢复测试 00000000.md`;
	await assert.rejects(interrupted.repository.startRecording({ sessionKey: "recover", title: "恢复测试" }), /injected/);
	interrupted.storage.failPath = null;
	const resumedRecording = await interrupted.repository.startRecording({ sessionKey: "recover", title: "恢复测试" });
	assert.equal((await interrupted.repository.snapshot()).meetings.length, 1, "retry after reserved identity / document create failure must not allocate a second meeting");
	assert.equal(resumedRecording.meetingId, "mtg_00000001-0000-4000-8000-000000000000");
	const recoveredRepository = new CatalogRepository({ storage: interrupted.storage, yaml: catalogTestYaml, rootFolder: "Echo Memory", language: "zh" });
	await recoveredRepository.initialize();
	assert.equal((await recoveredRepository.snapshot()).recordings[0].state, "interrupted", "a saved recording-in-progress state must not appear still recording after restart");
	const writesBeforeRefresh = interrupted.storage.writes.length;
	await recoveredRepository.initialize();
	assert.equal(interrupted.storage.writes.length, writesBeforeRefresh, "repeated initialization must not emit unnecessary modify events");
	const concurrent = createCatalogTestRepository();
	await Promise.all([concurrent.repository.ensureMeetingForAudio("Audio/same.mp3"), concurrent.repository.ensureMeetingForAudio("Audio/same.mp3")]);
	assert.equal((await concurrent.repository.snapshot()).meetings.length, 1, "concurrent requests share the same stable recording relation");
	const readonlyMeeting = (await concurrent.repository.snapshot()).meetings[0];
	const readonlyProject = await concurrent.repository.registerProject("项目/readonly.md", "Read only");
	concurrent.storage.failPath = readonlyMeeting.path;
	const batch = await concurrent.repository.batchSetMeetingProjects([readonlyMeeting.id], [readonlyProject.id]);
	assert.equal(batch.failed.length, 1);
	assert.equal(batch.succeeded.length, 0);

	const directMemory = createCatalogTestRepository();
	directMemory.storage.files.set("Transcripts/direct.transcript.md", catalogTestDocument({ type: "audio-transcript", status: "done" }, "# 旧转写\n\n## 转写正文\n原文\n"));
	const directSource = await directMemory.repository.registerTranscript({ transcriptPath: "Transcripts/direct.transcript.md", meetingPath: `${directMemory.repository.paths.meetingsDir}/not-created-yet.md` });
	assert.equal((await directMemory.repository.snapshot()).meetings[0].id, directSource.meetingId, "the Memory resolver's uncreated legacy filename is a hint, not a missing registered meeting");
	const badClock = createCatalogTestRepository();
	const badClockRecording = await badClock.repository.startRecording({ startedAt: "2026-11-08T01:00:00Z" });
	await badClock.repository.finishRecording(badClockRecording.id, { audioPath: "Audio/clock-jump.webm" });
	const badClockSnapshot = await badClock.repository.snapshot();
	assert.equal(badClockSnapshot.recordings[0].state, "saved");
	assert.equal(badClockSnapshot.recordings[0].endedAt, undefined, "a missing reliable stop timestamp must not be replaced by now");
	assert.equal(badClockSnapshot.recordings[0].durationMs, undefined);
	assert.equal(badClockSnapshot.meetings[0].time.precision === "instant" && badClockSnapshot.meetings[0].time.endedAt, undefined);
	const projectionFailure = createCatalogTestRepository();
	const originalProcess = projectionFailure.storage.process.bind(projectionFailure.storage);
	projectionFailure.storage.process = async (path, update) => {
		if (path.startsWith(`${projectionFailure.repository.paths.meetingsDir}/`)) throw new Error("injected meeting projection failure");
		return originalProcess(path, update);
	};
	const primaryRecording = await projectionFailure.repository.startRecording({ sessionKey: "primary-committed", startedAt: "2026-11-08T01:00:00Z" });
	assert.ok(primaryRecording.id, "committed recording identity must be returned even when derived resources cannot be written");
	assert.ok((await projectionFailure.repository.snapshot()).issues.some((issue) => issue.message.includes("projection failure")));
	const primarySaved = await projectionFailure.repository.finishRecording(primaryRecording.id, { audioPath: "Audio/primary-committed.webm", endedAt: "2026-11-08T01:02:00Z", durationMs: 120_000 });
	assert.equal(primarySaved.id, primaryRecording.id);
	assert.equal(primarySaved.state, "saved");
	const ensuredAfterProjectionFailure = await projectionFailure.repository.ensureMeetingForAudio("Audio/primary-committed.webm");
	assert.equal(ensuredAfterProjectionFailure.id, primaryRecording.meetingId);
	projectionFailure.storage.files.set("Transcripts/primary-committed.transcript.md", catalogTestDocument({ type: "audio-transcript", status: "done" }, "# Transcript\n原文\n"));
	const primarySource = await projectionFailure.repository.registerTranscript({ transcriptPath: "Transcripts/primary-committed.transcript.md", audioPath: "Audio/primary-committed.webm" });
	assert.equal(primarySource.meetingId, primaryRecording.meetingId);
	assert.equal((await projectionFailure.repository.snapshot()).meetings.length, 1, "a derived-write failure cannot create another meeting on save or transcript registration");
	const separateAudio = await projectionFailure.repository.ensureMeetingForAudio("Audio/separate-committed.webm", { title: "独立资源失败" });
	assert.ok(separateAudio.id, "audio registration must return its committed identity when only the resource projection fails");
	const metadataHashes = createCatalogTestRepository();
	const metadataMeeting = await metadataHashes.repository.ensureMeetingForAudio("Audio/hash.mp3", { title: "Metadata hash" });
	const metadataProject = await metadataHashes.repository.registerProject("Projects/hash.md", "Hash project");
	const metadataSnapshot = await metadataHashes.repository.snapshot();
	const originalMeetingContent = (await metadataHashes.storage.read(metadataMeeting.path))!;
	assert.equal(metadataSnapshot.meetings[0].sourceRevision, await catalogSha256(originalMeetingContent.replace(/\r\n/g, "\n")));
	assert.equal(metadataSnapshot.projects[0].sourceRevision, await catalogSha256((await metadataHashes.storage.read(metadataProject.path))!.replace(/\r\n/g, "\n")));
	metadataHashes.storage.files.set(metadataMeeting.path, originalMeetingContent.replace(/\n/g, "\r\n"));
	assert.equal((await metadataHashes.repository.snapshot()).meetings[0].sourceRevision, metadataSnapshot.meetings[0].sourceRevision, "metadata revisions share the source protocol CRLF normalization");
	metadataHashes.storage.files.set(metadataProject.path, (await metadataHashes.storage.read(metadataProject.path))! + "\n项目元数据人工说明更新。\n");
	assert.notEqual((await metadataHashes.repository.snapshot()).projects[0].sourceRevision, metadataSnapshot.projects[0].sourceRevision, "project changes must invalidate the published metadata dependency");
	const isolated = createCatalogTestRepository("en");
	await isolated.repository.initialize();
	const independent = await isolated.repository.ensureMeetingForAudio("Audio/import.mp3", { title: "Imported" });
	assert.equal(independent.time.precision, "unknown");
	assert.equal(isolated.repository.paths.questionsDir, "Echo Memory/08 Questions");
	const cancel = await isolated.repository.startRecording({ sessionKey: "cancel" });
	await isolated.repository.setRecordingState(cancel.id, "canceled");
	assert.equal((await isolated.repository.query({ timezone: "UTC" })).length, 1);
	assert.deepEqual(meetingDates({ precision: "date", date: "2026-11-07", source: "user", confirmed: true }, "America/New_York"), ["2026-11-07"]);
	assert.deepEqual(meetingDates({ precision: "unknown" }, "UTC"), []);
	const bounds = localDayBounds("2026-03-08", "America/New_York");
	assert.equal(new Date(bounds.start).toISOString(), "2026-03-08T05:00:00.000Z");
	assert.equal(bounds.end - bounds.start, 23 * 3_600_000);
	assert.equal(localDayBounds("2026-11-01", "America/New_York").end - localDayBounds("2026-11-01", "America/New_York").start, 25 * 3_600_000);
	assert.equal(instantDate("2026-11-07T23:00:00Z", "+08:00"), "2026-11-08");
	assert.throws(() => meetingDates({ precision: "instant", startedAt: "2026-11-07T09:00", source: "user", confirmed: true }, "UTC"), /时区/);
	assert.throws(() => meetingDates({ precision: "date", date: "2026-02-31", source: "user", confirmed: true }, "UTC"), /日期/);
	assert.equal((await catalogSha256("中文🙂")).length, 64);
	console.log("Catalog identity, metadata, relation, recording and time tests passed.");
}

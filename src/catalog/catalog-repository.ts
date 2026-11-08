import { extractTranscriptAnalyses } from "../analysis/analysis-output";
import { readTranscriptRecordingSummary } from "../analysis/analysis-technical";
import { normalizeCatalogPath, buildCatalogPaths } from "./catalog-paths";
import { catalogDocumentTitle, catalogSha256, createCatalogId, meetingTimeProperties, parseCatalogDocument, replaceCatalogManagedBlock, readMeetingTime, stringListProperty, stringProperty, updateCatalogDocument } from "./catalog-document";
import type { CatalogIssue, CatalogMigrationPlan, CatalogMigrationResult, CatalogPaths, CatalogQuery, CatalogRepositoryOptions, CatalogSnapshot, CatalogSourceRecord, CatalogStorage, MeetingRecord, MeetingRegistration, MeetingStages, MeetingTime, ProjectRecord, RecordingRecord, RecordingRegistration, TranscriptRegistration } from "./catalog-types";
import { filterMeetings, isInstant } from "./catalog-time";

export interface CatalogRegistry {
	schemaVersion: 1;
	meetingPaths: Record<string, string>;
	projectPaths: Record<string, string>;
	sourcePaths: Record<string, string>;
	recordings: Record<string, RecordingRecord>;
	legacyMeetings: Record<string, string>;
	pendingMeetings: Record<string, string>;
	intentMeetings: Record<string, string>;
}

interface RegistryRead { value: CatalogRegistry; content: string | null }

const EMPTY_STAGES: MeetingStages = { recording: "none", transcription: "none", analysis: "none", memory: "none" };
const RECORDING_STATES: RecordingRecord["state"][] = ["none", "recording", "saved", "interrupted", "canceled"];

export class CatalogRepository {
	readonly paths: CatalogPaths;
	readonly storage: CatalogStorage;
	private queue: Promise<unknown> = Promise.resolve();
	private initialized = false;
	private projectionIssues: CatalogIssue[] = [];
	private readonly activeRecordingIds = new Set<string>();
	private readonly now: () => string;
	private readonly createId: NonNullable<CatalogRepositoryOptions["createId"]>;

	constructor(private options: CatalogRepositoryOptions) {
		this.storage = options.storage;
		this.paths = buildCatalogPaths(options);
		this.now = options.now ?? (() => new Date().toISOString());
		this.createId = options.createId ?? createCatalogId;
	}

	initialize(): Promise<void> {
		return this.exclusive(async () => {
			for (const folder of [this.paths.meetingsDir, this.paths.projectsDir, this.paths.questionsDir, this.paths.evidenceDir, this.paths.systemDir]) await this.storage.ensureFolder?.(folder);
			const state = await this.readRegistry();
			const { findUnfinishedCatalogMigration } = await import("./catalog-migration");
			if (await findUnfinishedCatalogMigration(this.options, this.paths)) return;
			for (const [id, content] of Object.entries(state.value.pendingMeetings)) {
				const path = state.value.meetingPaths[id];
				if (!path) throw new Error("待恢复会议缺少登记路径。");
				const existing = await this.storage.read(path);
				if (existing === null) await this.storage.create(path, content);
				else if (existing !== content) throw new Error("待恢复会议已经被编辑，请核对身份登记。");
				delete state.value.pendingMeetings[id];
			}
			if (!this.initialized) for (const recording of Object.values(state.value.recordings)) {
				if (recording.state === "recording" && !this.activeRecordingIds.has(recording.id)) recording.state = "interrupted";
			}
			await this.saveRegistry(state);
			this.initialized = true;
		}, true);
	}

	async snapshot(): Promise<CatalogSnapshot> {
		const registry = (await this.readRegistry()).value;
		const issues: CatalogIssue[] = [];
		const meetings: MeetingRecord[] = [];
		const projects: ProjectRecord[] = [];
		const sources: CatalogSourceRecord[] = [];
		const documents = new Map<string, string>();
		const paths = new Set<string>([
			...Object.values(registry.meetingPaths), ...Object.values(registry.projectPaths), ...Object.values(registry.sourcePaths),
			...await this.storage.list(this.paths.meetingsDir), ...await this.storage.list(this.paths.projectsDir)
		]);
		for (const folder of this.options.transcriptFolders ?? []) {
			for (const path of await this.storage.list(normalizeCatalogPath(folder))) if (path.toLocaleLowerCase().endsWith(".transcript.md")) paths.add(path);
		}
		for (const path of [...paths].sort()) {
			if (!path.toLocaleLowerCase().endsWith(".md")) continue;
			try {
				const content = await this.storage.read(path);
				if (content === null) {
					issues.push({ code: "SOURCE_MISSING", path, message: "已登记资料不存在。" });
					continue;
				}
				documents.set(path, content);
				const { properties } = parseCatalogDocument(content, this.options.yaml);
				if (properties.echo_kind === "meeting" || properties.echo_memory_type === "meeting") {
					meetings.push(await this.readMeeting(path, content, registry));
				} else if (properties.echo_kind === "project" || registry.projectPaths[stringProperty(properties.echo_project_id) ?? ""] === path) {
					projects.push(this.readProject(path, content));
				} else if (properties.echo_source_id !== undefined) {
					const id = this.requireId(properties.echo_source_id, "src");
					const meetingId = this.requireId(properties.echo_meeting_id, "mtg");
					sources.push({ id, path, meetingId, kind: "transcript" });
				}
			} catch (error) {
				issues.push({ code: "PARSE_ERROR", path, message: error instanceof Error ? error.message : "资料无法解析。" });
			}
		}
		for (const [map, items] of [[registry.meetingPaths, meetings], [registry.projectPaths, projects], [registry.sourcePaths, sources]] as const) {
			for (const [id, path] of Object.entries(map)) {
				const item = items.find((entry) => entry.path === path);
				if (item && item.id !== id) issues.push({ code: "IDENTITY_CONFLICT", path, message: "文件身份与已登记身份不一致，请核对手动编辑或同步冲突。" });
			}
		}
		const validMeetings = this.removeDuplicateIds(meetings, issues);
		const validProjects = this.removeDuplicateIds(projects, issues);
		const validSources = this.removeDuplicateIds(sources, issues);
		for (const [id, path] of Object.entries(registry.meetingPaths)) {
			if (!meetings.some((meeting) => meeting.id === id) && await this.storage.read(path) === null) {
				validMeetings.push({ id, path, title: catalogDocumentTitle("", path), time: { precision: "unknown", reason: "会议记录缺失" }, projectIds: [], tags: [], sourceIds: [], recordingIds: [], stages: { ...EMPTY_STAGES }, missing: true });
			}
		}
		for (const [id, path] of Object.entries(registry.projectPaths)) {
			if (!projects.some((project) => project.id === id) && await this.storage.read(path) === null) validProjects.push({ id, path, name: catalogDocumentTitle("", path), aliases: [], status: "active", missing: true });
		}
		for (const [id, path] of Object.entries(registry.sourcePaths)) {
			if (!sources.some((source) => source.id === id) && await this.storage.read(path) === null) validSources.push({ id, path, meetingId: registry.legacyMeetings[path] ?? "", kind: "transcript", missing: true });
		}
		for (const record of [...validMeetings, ...validProjects]) {
			const content = documents.get(record.path);
			if (content !== undefined && !record.missing) record.sourceRevision = await catalogSha256(content.replace(/\r\n/g, "\n"));
		}
		for (const meeting of validMeetings) {
			meeting.sourceIds = validSources.filter((source) => source.meetingId === meeting.id).map((source) => source.id);
			for (const id of meeting.projectIds) if (!validProjects.some((project) => project.id === id && !project.missing)) issues.push({ code: "PROJECT_MISSING", path: meeting.path, message: `关联项目不存在或身份冲突 ${id}` });
		}
		for (const source of validSources) {
			const meeting = validMeetings.find((item) => item.id === source.meetingId);
			if (!meeting) {
				issues.push({ code: "RELATION_CONFLICT", path: source.path, message: "来源引用的会议记录不存在或身份冲突。" });
				continue;
			}
			const content = documents.get(source.path);
			if (content === undefined) continue;
			const properties = parseCatalogDocument(content, this.options.yaml).properties;
			if (properties.status === "done") meeting.stages.transcription = "done";
			else if (properties.status === "failed" && meeting.stages.transcription !== "done") meeting.stages.transcription = "failed";
			else if (["transcribing", "processing"].includes(String(properties.status)) && meeting.stages.transcription === "none") meeting.stages.transcription = "running";
			const status = properties.analysis_status;
			const pending = status === "analysis_pending" || stringListProperty(properties.analysis_pending_template_ids).length > 0;
			const done = status === "analysis_done" || status === "analysis_partial_failed" || stringListProperty(properties.analysis_done_template_ids).length > 0 || content.includes("<!-- echo-notes-analysis-item:start");
			const failed = status === "analysis_failed" || status === "analysis_partial_failed" || stringListProperty(properties.analysis_failed_template_ids).length > 0;
			const previous = meeting.stages.analysis;
			if (pending || previous === "running") meeting.stages.analysis = "running";
			else if ((failed || previous === "failed" || previous === "partial_failed") && (done || previous === "done" || previous === "partial_failed")) meeting.stages.analysis = "partial_failed";
			else if (failed || previous === "failed") meeting.stages.analysis = "failed";
			else if (done || previous === "done") meeting.stages.analysis = "done";
			for (const analysis of extractTranscriptAnalyses(content)) meeting.summary ??= readTranscriptRecordingSummary(content, analysis.templateId);
		}
		return { schemaVersion: 1, meetings: validMeetings, projects: validProjects, sources: validSources, recordings: Object.values(registry.recordings), issues: [...issues, ...this.projectionIssues] };
	}

	async query(query: CatalogQuery): Promise<MeetingRecord[]> {
		return filterMeetings((await this.snapshot()).meetings, query);
	}

	ensureMeetingForAudio(audioPath: string, registration: MeetingRegistration = {}): Promise<MeetingRecord> {
		return this.exclusive(async () => {
			const path = normalizeCatalogPath(audioPath);
			const state = await this.readRegistry();
			const existing = Object.values(state.value.recordings).find((recording) => recording.path === path);
			if (existing) return this.getRegisteredMeeting(existing.meetingId, state.value);
			const meeting = await this.ensureMeeting(state, registration, `audio:${path}`);
			const recording: RecordingRecord = { id: this.createId("rec"), meetingId: meeting.id, path, state: "saved" };
			state.value.recordings[recording.id] = recording;
			await this.saveRegistry(state);
			await this.refreshMeetingResourcesSafely(meeting.id, meeting.path);
			return { ...meeting, recordingIds: [...meeting.recordingIds, recording.id], stages: { ...meeting.stages, recording: "saved" } };
		});
	}

	startRecording(input: RecordingRegistration = {}): Promise<RecordingRecord> {
		return this.exclusive(async () => {
			const state = await this.readRegistry();
			const existing = Object.values(state.value.recordings).find((recording) => input.sessionKey && recording.sessionKey === input.sessionKey);
			if (existing) return existing;
			const startedAt = input.startedAt ?? this.now();
			if (!isInstant(startedAt)) throw new Error("录音开始时间必须包含明确时区。");
			const time: MeetingTime = { precision: "instant", startedAt, timezone: input.timezone, source: "recording", confirmed: false };
			const meeting = await this.ensureMeeting(state, { ...input, time: input.time ?? time }, input.sessionKey ? `session:${input.sessionKey}` : undefined);
			const recording: RecordingRecord = { id: this.createId("rec"), meetingId: meeting.id, path: input.audioPath ? normalizeCatalogPath(input.audioPath) : undefined, sessionKey: input.sessionKey, startedAt, state: "recording" };
			state.value.recordings[recording.id] = recording;
			await this.saveRegistry(state);
			this.activeRecordingIds.add(recording.id);
			await this.refreshMeetingResourcesSafely(meeting.id, meeting.path);
			return recording;
		});
	}

	finishRecording(recordingId: string, update: { audioPath: string; endedAt?: string; durationMs?: number }): Promise<RecordingRecord> {
		return this.exclusive(async () => {
			const state = await this.readRegistry();
			const recording = state.value.recordings[recordingId];
			if (!recording) throw new Error("录音身份不存在。");
			const path = normalizeCatalogPath(update.audioPath);
			if (Object.values(state.value.recordings).some((item) => item.id !== recordingId && item.path === path)) throw new Error("该音频已经登记，请核对来源归属。");
			const endedAt = update.endedAt ?? recording.endedAt;
			if ((endedAt !== undefined && (!isInstant(endedAt) || (recording.startedAt && Date.parse(endedAt) < Date.parse(recording.startedAt)))) || (update.durationMs !== undefined && (!Number.isFinite(update.durationMs) || update.durationMs < 0))) throw new Error("录音结束时间或时长无效。");
			Object.assign(recording, { path, state: "saved" });
			if (endedAt !== undefined) recording.endedAt = endedAt;
			if (update.durationMs !== undefined) recording.durationMs = update.durationMs;
			this.activeRecordingIds.delete(recordingId);
			await this.saveRegistry(state);
			try {
				const meeting = await this.getRegisteredMeeting(recording.meetingId, state.value);
				if (endedAt !== undefined && meeting.time.precision === "instant" && !meeting.time.confirmed && meeting.time.source === "recording") {
					await this.changeProperties(meeting.path, meetingTimeProperties({ ...meeting.time, endedAt }));
				}
			} catch (error) { this.reportProjectionFailure(state.value.meetingPaths[recording.meetingId] ?? this.paths.registry, error); }
			await this.refreshMeetingResourcesSafely(recording.meetingId, state.value.meetingPaths[recording.meetingId]);
			return recording;
		});
	}

	setRecordingState(recordingId: string, value: RecordingRecord["state"]): Promise<void> {
		return this.exclusive(async () => {
			if (!RECORDING_STATES.includes(value)) throw new Error("录音状态无效。");
			const state = await this.readRegistry();
			const recording = state.value.recordings[recordingId];
			if (!recording) throw new Error("录音身份不存在。");
			if (recording.state === "saved" && value === "interrupted") return;
			recording.state = value;
			if (value !== "recording") this.activeRecordingIds.delete(recordingId);
			await this.saveRegistry(state);
		});
	}

	registerTranscript(input: TranscriptRegistration): Promise<CatalogSourceRecord> {
		return this.exclusive(async () => {
			const path = normalizeCatalogPath(input.transcriptPath);
			const content = await this.storage.read(path);
			if (content === null) throw new Error("转写来源不存在。");
			const properties = parseCatalogDocument(content, this.options.yaml).properties;
			const state = await this.readRegistry();
			const existingMeetingId = stringProperty(properties.echo_meeting_id);
			let meeting: MeetingRecord;
			if (existingMeetingId) {
				if (input.meetingId && input.meetingId !== existingMeetingId) throw new Error("转写已属于另一场会议，请使用显式归属变更操作。");
				meeting = await this.getRegisteredMeeting(existingMeetingId, state.value);
			} else {
				const audio = input.audioPath && Object.values(state.value.recordings).find((recording) => recording.path === input.audioPath);
				const legacy = await this.findLegacyMeetingPath(path);
				let meetingPath = input.meetingPath;
				if (meetingPath && await this.storage.read(normalizeCatalogPath(meetingPath)) === null && !legacy) meetingPath = undefined;
				meeting = await this.ensureMeeting(state, { ...input, meetingId: input.meetingId ?? (audio ? audio.meetingId : state.value.legacyMeetings[path]), meetingPath: meetingPath ?? legacy }, `transcript:${path}`);
			}
			if (input.audioPath) {
				const audioPath = normalizeCatalogPath(input.audioPath);
				const recording = Object.values(state.value.recordings).find((item) => item.path === audioPath);
				if (recording && recording.meetingId !== meeting.id) throw new Error("音频与转写的会议归属冲突，请核对后重试。");
				if (!recording) {
					const id = this.createId("rec");
					state.value.recordings[id] = { id, path: audioPath, meetingId: meeting.id, state: "saved" };
				}
			}
			const sourceId = properties.echo_source_id !== undefined ? this.requireId(properties.echo_source_id, "src") : this.createId("src");
			const snapshot = await this.snapshot();
			if (snapshot.issues.some((issue) => issue.code === "IDENTITY_CONFLICT" && issue.path === path) || snapshot.sources.some((source) => source.id === sourceId && source.path !== path)) throw new Error("转写来源身份重复，请先处理复制冲突。");
			await this.changeProperties(path, { echo_schema: 1, echo_source_id: sourceId, echo_meeting_id: meeting.id });
			state.value.sourcePaths[sourceId] = path;
			state.value.legacyMeetings[path] = meeting.id;
			await this.saveRegistry(state);
			await this.refreshMeetingResourcesSafely(meeting.id, meeting.path);
			return { id: sourceId, path, meetingId: meeting.id, kind: "transcript" };
		});
	}

	resolveLegacyMeeting(transcriptPath: string, legacyMeetingPath?: string): Promise<MeetingRecord> {
		return this.exclusive(async () => {
			const sourcePath = normalizeCatalogPath(transcriptPath);
			const state = await this.readRegistry();
			const content = await this.storage.read(sourcePath);
			const properties = content === null ? {} : parseCatalogDocument(content, this.options.yaml).properties;
			const meetingId = stringProperty(properties.echo_meeting_id) ?? state.value.legacyMeetings[sourcePath];
			const meeting = await this.ensureMeeting(state, { meetingId, meetingPath: legacyMeetingPath ?? await this.findLegacyMeetingPath(sourcePath), title: content === null ? undefined : catalogDocumentTitle(content, sourcePath) }, `transcript:${sourcePath}`);
			state.value.legacyMeetings[sourcePath] = meeting.id;
			await this.saveRegistry(state);
			return meeting;
		});
	}

	async readSourceContent(sourceId: string, snapshot?: CatalogSnapshot): Promise<string | null> {
		const source = (snapshot ?? await this.snapshot()).sources.find((item) => item.id === sourceId);
		if (!source || source.missing) return null;
		const content = await this.storage.read(source.path);
		if (content === null) return null;
		const properties = parseCatalogDocument(content, this.options.yaml).properties;
		if (properties.echo_source_id !== sourceId || properties.echo_meeting_id !== source.meetingId) throw new Error("来源身份或归属已变化，请刷新后重试。");
		return content;
	}

	registerProject(path: string, name?: string): Promise<ProjectRecord> {
		return this.exclusive(async () => {
			const normalized = normalizeCatalogPath(path);
			const state = await this.readRegistry();
			let content = await this.storage.read(normalized);
			if (content === null) {
				if (!name?.trim()) throw new Error("请选择已有项目笔记或填写项目名称。");
				content = `# ${name.trim().replace(/[\r\n]/g, " ")}\n\n`;
				await this.storage.create(normalized, content);
			}
			const properties = parseCatalogDocument(content, this.options.yaml).properties;
			const id = properties.echo_project_id === undefined ? this.createId("prj") : this.requireId(properties.echo_project_id, "prj");
			const snapshot = await this.snapshot();
			if (snapshot.issues.some((issue) => issue.code === "IDENTITY_CONFLICT" && issue.path === normalized) || snapshot.projects.some((project) => project.id === id && project.path !== normalized)) throw new Error("项目身份重复，请先处理复制冲突。");
			await this.changeProperties(normalized, { echo_schema: 1, echo_kind: "project", echo_project_id: id, echo_project_status: properties.echo_project_status ?? "active" });
			state.value.projectPaths[id] = normalized;
			await this.saveRegistry(state);
			return this.readProject(normalized, (await this.storage.read(normalized))!);
		});
	}

	setMeetingProjects(meetingId: string, projectIds: string[]): Promise<void> {
		return this.exclusive(async () => {
			if (new Set(projectIds).size !== projectIds.length) throw new Error("项目身份列表存在重复项。");
			const snapshot = await this.snapshot();
			for (const id of projectIds) if (!snapshot.projects.some((project) => project.id === id && !project.missing)) throw new Error(`项目不存在或身份冲突 ${id}`);
			const meeting = snapshot.meetings.find((item) => item.id === meetingId && !item.missing && !item.legacy);
			if (!meeting) throw new Error("会议尚未登记或记录缺失，请先接管旧记录。");
			await this.changeProperties(meeting.path, { echo_project_ids: projectIds });
			await this.refreshMeetingResourcesSafely(meetingId, meeting.path);
			await this.refreshProjectPagesSafely();
		});
	}

	async batchSetMeetingProjects(meetingIds: string[], projectIds: string[]): Promise<{ succeeded: string[]; failed: Array<{ id: string; message: string }> }> {
		const result: { succeeded: string[]; failed: Array<{ id: string; message: string }> } = { succeeded: [], failed: [] };
		for (const id of [...new Set(meetingIds)]) {
			try { await this.setMeetingProjects(id, projectIds); result.succeeded.push(id); }
			catch (error) { result.failed.push({ id, message: error instanceof Error ? error.message : "关联失败。" }); }
		}
		return result;
	}

	updateMeetingMetadata(meetingId: string, changes: { time?: MeetingTime; excerpt?: string; tags?: string[] }): Promise<void> {
		return this.exclusive(async () => {
			const meeting = await this.getRegisteredMeeting(meetingId, (await this.readRegistry()).value);
			const properties: Record<string, unknown> = {};
			if (changes.time) Object.assign(properties, meetingTimeProperties(changes.time));
			if (changes.excerpt !== undefined) properties.echo_excerpt = changes.excerpt;
			if (changes.tags !== undefined) properties.tags = [...new Set(changes.tags)];
			await this.changeProperties(meeting.path, properties);
		});
	}

	notifyRename(oldPath: string, newPath: string): Promise<void> {
		return this.exclusive(async () => {
			const from = normalizeCatalogPath(oldPath), to = normalizeCatalogPath(newPath);
			const state = await this.readRegistry();
			for (const map of [state.value.meetingPaths, state.value.projectPaths, state.value.sourcePaths]) for (const [id, path] of Object.entries(map)) if (path === from) map[id] = to;
			for (const recording of Object.values(state.value.recordings)) if (recording.path === from) recording.path = to;
			if (state.value.legacyMeetings[from]) { state.value.legacyMeetings[to] = state.value.legacyMeetings[from]; delete state.value.legacyMeetings[from]; }
			await this.saveRegistry(state);
		});
	}

	async dryRunMigration(explicitPaths: string[] = []): Promise<CatalogMigrationPlan> {
		const { createCatalogMigrationPlan } = await import("./catalog-migration");
		return createCatalogMigrationPlan(this.options, this.paths, explicitPaths);
	}

	applyMigration(plan: CatalogMigrationPlan): Promise<CatalogMigrationResult> {
		return this.exclusive(async () => {
			const { applyCatalogMigration } = await import("./catalog-migration");
			return applyCatalogMigration(this.options, this.paths, plan);
		}, true);
	}

	rollbackMigration(id: string): Promise<CatalogMigrationResult> {
		return this.exclusive(async () => {
			const { rollbackCatalogMigration } = await import("./catalog-migration");
			return rollbackCatalogMigration(this.options, this.paths, id);
		}, true);
	}

	async refreshProjectPages(): Promise<void> {
		const snapshot = await this.snapshot();
		for (const project of snapshot.projects.filter((item) => !item.missing)) await this.refreshProjectPage(project, snapshot);
	}

	refreshProjections(): Promise<void> {
		return this.exclusive(async () => {
			this.projectionIssues = [];
			const snapshot = await this.snapshot();
			for (const meeting of snapshot.meetings.filter((item) => !item.missing && !item.legacy)) {
				try { await this.refreshMeetingResources(meeting.id, snapshot); }
				catch (error) { this.projectionIssues.push({ code: "INVALID_METADATA", path: meeting.path, message: error instanceof Error ? error.message : "会议资源投影更新失败。" }); }
			}
			for (const project of snapshot.projects.filter((item) => !item.missing)) {
				try { await this.refreshProjectPage(project, snapshot); }
				catch (error) { this.projectionIssues.push({ code: "INVALID_METADATA", path: project.path, message: error instanceof Error ? error.message : "项目会议投影更新失败。" }); }
			}
		});
	}

	private async refreshMeetingResourcesSafely(meetingId: string, meetingPath?: string): Promise<void> {
		try { await this.refreshMeetingResources(meetingId); }
		catch (error) {
			this.reportProjectionFailure(meetingPath ?? this.paths.registry, error);
		}
	}

	private async refreshProjectPagesSafely(): Promise<void> {
		let snapshot: CatalogSnapshot;
		try { snapshot = await this.snapshot(); }
		catch (error) { this.reportProjectionFailure(this.paths.registry, error); return; }
		for (const project of snapshot.projects.filter((item) => !item.missing)) {
			try { await this.refreshProjectPage(project, snapshot); }
			catch (error) { this.reportProjectionFailure(project.path, error); }
		}
	}

	private reportProjectionFailure(path: string, error: unknown): void {
		const message = error instanceof Error ? error.message : "派生导航更新失败，请检查维护提示。";
		if (!this.projectionIssues.some((issue) => issue.path === path && issue.message === message)) this.projectionIssues.push({ code: "INVALID_METADATA", path, message });
	}

	private async refreshProjectPage(project: ProjectRecord, snapshot: CatalogSnapshot): Promise<void> {
		const start = "<!-- echo-catalog-project-meetings:start -->";
		const end = "<!-- echo-catalog-project-meetings:end -->";
		const rows = snapshot.meetings.filter((meeting) => meeting.projectIds.includes(project.id)).sort((a, b) => a.id.localeCompare(b.id)).map((meeting) => `- [[${meeting.path}|${this.linkLabel(meeting.title)}]]${meeting.missing ? " · 会议记录缺失" : ""}`);
		const block = [start, this.options.language === "en" ? "## Meetings" : "## 关联会议", "", ...(rows.length ? rows : [this.options.language === "en" ? "No linked meetings." : "暂无关联会议。"]), end].join("\n");
		await this.writeProjection(project.path, start, end, block);
	}

	private async refreshMeetingResources(meetingId: string, currentSnapshot?: CatalogSnapshot): Promise<void> {
		const snapshot = currentSnapshot ?? await this.snapshot();
		const meeting = snapshot.meetings.find((item) => item.id === meetingId && !item.missing);
		if (!meeting) return;
		const start = "<!-- echo-meeting-resources:start -->";
		const end = "<!-- echo-meeting-resources:end -->";
		const projectLines = meeting.projectIds.map((id) => {
			const project = snapshot.projects.find((item) => item.id === id);
			return project && !project.missing ? `- [[${project.path}|${this.linkLabel(project.name)}]]` : `- 项目缺失 ${id}`;
		});
		const recordingLines = snapshot.recordings.filter((item) => item.meetingId === meetingId).map((item) => item.path ? `- [[${item.path}]]` : `- ${item.state === "recording" ? "录音中" : "录音待恢复"}`);
		const sourceLines = snapshot.sources.filter((item) => item.meetingId === meetingId).map((item) => `- [[${item.path}]]${item.missing ? " · 来源缺失" : ""}`);
		const block = [start, this.options.language === "en" ? "## Resources" : "## 会议资源", "", ...projectLines, ...recordingLines, ...sourceLines, end].join("\n");
		await this.writeProjection(meeting.path, start, end, block);
	}

	private async writeProjection(path: string, start: string, end: string, block: string): Promise<void> {
		const content = await this.storage.read(path);
		if (content === null) throw new Error("会议导航记录缺失。");
		if (replaceCatalogManagedBlock(content, start, end, block) === content) return;
		await this.storage.process(path, (latest) => replaceCatalogManagedBlock(latest, start, end, block));
	}

	private linkLabel(value: string): string {
		return value.replace(/[|\r\n]/g, " ").replaceAll("[", " ").replaceAll("]", " ");
	}

	private exclusive<T>(operation: () => Promise<T>, allowMigration = false): Promise<T> {
		const result = this.queue.then(async () => {
			if (!allowMigration) {
				const { findUnfinishedCatalogMigration } = await import("./catalog-migration");
				const pending = await findUnfinishedCatalogMigration(this.options, this.paths);
				if (pending) throw new Error(`迁移 ${pending.id} 尚未完成，请先在维护入口继续原迁移。`);
			}
			return operation();
		});
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async ensureMeeting(state: RegistryRead, input: MeetingRegistration, intentKey?: string): Promise<MeetingRecord> {
		const reservedId = intentKey && state.value.intentMeetings[intentKey];
		if (!input.meetingId && reservedId) {
			const pending = state.value.pendingMeetings[reservedId];
			const path = state.value.meetingPaths[reservedId];
			if (pending !== undefined && path) {
				const existing = await this.storage.read(path);
				if (existing === null) await this.storage.create(path, pending);
				else if (existing !== pending) throw new Error("会议恢复内容已发生变化，请先检查记录。");
				delete state.value.pendingMeetings[reservedId];
				await this.saveRegistry(state);
			}
			return this.getRegisteredMeeting(reservedId, state.value);
		}
		if (input.meetingId) return this.getRegisteredMeeting(input.meetingId, state.value);
		const existingPath = input.meetingPath && normalizeCatalogPath(input.meetingPath);
		const existingContent = existingPath ? await this.storage.read(existingPath) : null;
		if (existingPath && existingContent === null) throw new Error("指定的旧会议记录不存在，无法自动重建。");
		const existingProperties = existingContent === null ? {} : parseCatalogDocument(existingContent, this.options.yaml).properties;
		const existingId = stringProperty(existingProperties.echo_meeting_id);
		if (existingId && existingPath) {
			state.value.meetingPaths[existingId] = existingPath;
			return this.readMeeting(existingPath, existingContent!, state.value);
		}
		const id = this.createId("mtg");
		const title = input.title?.trim().replace(/[\r\n]/g, " ") || (this.options.language === "en" ? "Meeting" : "会议记录");
		const path = existingPath ?? `${this.paths.meetingsDir}/${this.safeName(title)} ${id.slice(-8)}.md`;
		const properties: Record<string, unknown> = { echo_schema: 1, echo_kind: "meeting", echo_meeting_id: id };
		if (existingProperties.echo_project_ids === undefined) properties.echo_project_ids = input.projectIds ?? [];
		if (existingProperties.echo_time_precision === undefined) Object.assign(properties, meetingTimeProperties(input.time ?? { precision: "unknown", reason: "会议发生时间尚未确认" }));
		const content = updateCatalogDocument(existingContent ?? `\n# ${title}\n\n## ${this.options.language === "en" ? "Notes" : "人工补充"}\n\n`, properties, this.options.yaml);
		state.value.meetingPaths[id] = path;
		if (intentKey) state.value.intentMeetings[intentKey] = id;
		if (existingContent === null) {
			state.value.pendingMeetings[id] = content;
			await this.saveRegistry(state);
			await this.storage.create(path, content);
			delete state.value.pendingMeetings[id];
		} else {
			await this.storage.process(path, (current) => {
				if (current !== existingContent) throw new Error("会议记录在接管期间发生变化，请重试。");
				return content;
			});
		}
		await this.saveRegistry(state);
		return this.readMeeting(path, content, state.value);
	}

	private async getRegisteredMeeting(id: string, registry: CatalogRegistry): Promise<MeetingRecord> {
		const matches: string[] = [];
		for (const candidate of new Set([...await this.storage.list(this.paths.meetingsDir), ...(registry.meetingPaths[id] ? [registry.meetingPaths[id]] : [])])) {
			if (!candidate.endsWith(".md")) continue;
			const candidateContent = await this.storage.read(candidate);
			if (candidateContent !== null) {
				const properties = parseCatalogDocument(candidateContent, this.options.yaml).properties;
				if ((properties.echo_kind === "meeting" || properties.echo_memory_type === "meeting") && properties.echo_meeting_id === id) matches.push(candidate);
			}
		}
		if (matches.length > 1) throw new Error("会议稳定身份重复，请先处理复制冲突。");
		const path = registry.meetingPaths[id];
		if (!path) {
			for (const candidate of await this.storage.list(this.paths.meetingsDir)) {
				const content = await this.storage.read(candidate);
				if (content !== null) {
					const properties = parseCatalogDocument(content, this.options.yaml).properties;
					if ((properties.echo_kind === "meeting" || properties.echo_memory_type === "meeting") && properties.echo_meeting_id === id) return this.readMeeting(candidate, content, registry);
				}
			}
			throw new Error("会议身份尚未登记。");
		}
		const content = await this.storage.read(path);
		if (content === null) throw new Error("会议记录缺失，请恢复原文件或明确处理登记。");
		const meeting = await this.readMeeting(path, content, registry);
		if (meeting.id !== id) throw new Error("会议记录身份已改变，请先处理冲突。");
		return meeting;
	}

	private async readMeeting(path: string, content: string, registry: CatalogRegistry): Promise<MeetingRecord> {
		const properties = parseCatalogDocument(content, this.options.yaml).properties;
		const legacy = properties.echo_kind !== "meeting" || properties.echo_meeting_id === undefined;
		if (!legacy && Array.isArray(properties.echo_project_ids) && new Set(properties.echo_project_ids).size !== properties.echo_project_ids.length) throw new Error("会议项目身份列表存在重复项。");
		const id = properties.echo_meeting_id === undefined ? `legacy_${(await catalogSha256(path)).slice(0, 24)}` : this.requireId(properties.echo_meeting_id, "mtg");
		const recordings = Object.values(registry.recordings).filter((recording) => recording.meetingId === id);
		const stages: MeetingStages = { ...EMPTY_STAGES };
		if (recordings.some((recording) => recording.state === "recording")) stages.recording = "recording";
		else if (recordings.some((recording) => recording.state === "saved")) stages.recording = "saved";
		else if (recordings.length) stages.recording = recordings[recordings.length - 1].state;

		if (content.includes("<!-- echo-memory-meeting:start -->")) stages.memory = "available";
		return { id, path, title: catalogDocumentTitle(content, path), time: readMeetingTime(properties), projectIds: stringListProperty(properties.echo_project_ids), tags: stringListProperty(properties.tags), excerpt: stringProperty(properties.echo_excerpt), sourceIds: Object.entries(registry.sourcePaths).filter(([, sourcePath]) => registry.legacyMeetings[sourcePath] === id).map(([sourceId]) => sourceId), recordingIds: recordings.map((recording) => recording.id), stages, legacy };
	}

	private readProject(path: string, content: string): ProjectRecord {
		const properties = parseCatalogDocument(content, this.options.yaml).properties;
		return { id: this.requireId(properties.echo_project_id, "prj"), path, name: catalogDocumentTitle(content, path), aliases: stringListProperty(properties.aliases), status: properties.echo_project_status === "archived" ? "archived" : "active" };
	}

	private removeDuplicateIds<T extends { id: string; path: string }>(items: T[], issues: CatalogIssue[]): T[] {
		const duplicates = new Set(items.filter((item, index) => items.findIndex((other) => other.id === item.id) !== index).map((item) => item.id));
		for (const item of items) if (duplicates.has(item.id)) issues.push({ code: "IDENTITY_CONFLICT", path: item.path, message: `稳定身份重复 ${item.id}` });
		return items.filter((item) => !duplicates.has(item.id));
	}

	private async findLegacyMeetingPath(transcriptPath: string): Promise<string | undefined> {
		const content = await this.storage.read(this.paths.memory.manifest);
		if (content === null) return undefined;
		let parsed: unknown;
		try { parsed = JSON.parse(content); } catch { throw new Error("旧 Memory 清单无法解析，请先修复后接管会议。"); }
		if (typeof parsed !== "object" || parsed === null || !("runs" in parsed) || typeof parsed.runs !== "object" || parsed.runs === null) return undefined;
		const paths = new Set<string>();
		for (const entry of Object.values(parsed.runs as Record<string, unknown>)) {
			if (typeof entry === "object" && entry !== null && "transcriptPath" in entry && entry.transcriptPath === transcriptPath && "meetingPath" in entry && typeof entry.meetingPath === "string") paths.add(normalizeCatalogPath(entry.meetingPath));
		}
		if (paths.size > 1) throw new Error("多个旧会议记录指向同一转写，请先处理归属冲突。");
		return [...paths][0];
	}

	private async changeProperties(path: string, changes: Record<string, unknown>): Promise<void> {
		if (this.storage.updateProperties) await this.storage.updateProperties(path, changes);
		else await this.storage.process(path, (current) => updateCatalogDocument(current, changes, this.options.yaml));
	}

	private async readRegistry(): Promise<RegistryRead> {
		const content = await this.storage.read(this.paths.registry);
		if (content === null) return { content, value: { schemaVersion: 1, meetingPaths: {}, projectPaths: {}, sourcePaths: {}, recordings: {}, legacyMeetings: {}, pendingMeetings: {}, intentMeetings: {} } };
		let parsed: unknown;
		try { parsed = JSON.parse(content); } catch { throw new Error("会议身份登记损坏，请恢复备份后重试。"); }
		if (typeof parsed !== "object" || parsed === null || !("schemaVersion" in parsed) || parsed.schemaVersion !== 1) throw new Error("会议身份登记版本不支持。");
		const value = parsed as CatalogRegistry;
		value.intentMeetings ??= {};
		for (const field of ["meetingPaths", "projectPaths", "sourcePaths", "recordings", "legacyMeetings", "pendingMeetings", "intentMeetings"] as const) {
			if (typeof value[field] !== "object" || value[field] === null || Array.isArray(value[field])) throw new Error("会议身份登记结构无效。");
		}
		for (const map of [value.meetingPaths, value.projectPaths, value.sourcePaths]) for (const path of Object.values(map)) {
			if (typeof path !== "string") throw new Error("会议身份登记路径无效。");
			normalizeCatalogPath(path);
		}
		for (const [id, recording] of Object.entries(value.recordings)) {
			if (typeof recording !== "object" || recording === null || recording.id !== id || typeof recording.meetingId !== "string" || !RECORDING_STATES.includes(recording.state)) throw new Error("录音身份登记无效。");
			if (recording.path !== undefined) normalizeCatalogPath(recording.path);
		}
		for (const map of [value.legacyMeetings, value.pendingMeetings, value.intentMeetings]) if (Object.values(map).some((entry) => typeof entry !== "string")) throw new Error("会议恢复登记无效。");
		return { content, value };
	}

	private async saveRegistry(state: RegistryRead): Promise<void> {
		const content = `${JSON.stringify(state.value, null, 2)}\n`;
		if (state.content === content) return;
		if (state.content === null) await this.storage.create(this.paths.registry, content);
		else await this.storage.process(this.paths.registry, (current) => {
			if (current !== state.content) throw new Error("会议登记正在被其他任务更新，请重试。");
			return content;
		});
		state.content = content;
	}

	private requireId(value: unknown, kind: string): string {
		if (typeof value !== "string" || !new RegExp(`^${kind}_[a-zA-Z0-9-]{8,128}$`).test(value)) throw new Error(`无效的 ${kind} 稳定身份。`);
		return value;
	}

	private safeName(value: string): string {
		return value.replace(/[\\/:*?"<>|\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Meeting";
	}
}

import { FileSystemAdapter, TFile, type App, type EventRef } from "obsidian";
import type { EchoNotesSettings } from "../settings/settings";
import { createObsidianCatalogRepository } from "../obsidian/catalog-store";
import type { CatalogRepository } from "../catalog/catalog-repository";
import type { CatalogMigrationPlan, CatalogMigrationResult, CatalogSnapshot, MeetingRecord, RecordingRecord } from "../catalog/catalog-types";
import { meetingDates } from "../catalog/catalog-time";
import { AgentExportPublisher, MemoryReader, readMemoryProjection, type AgentMemoryStorage, type AgentAccessPolicy } from "../agent-memory";
import { createStableFingerprint, sanitizeMemoryFileName } from "../memory/memory-output";
import { getMemoryRelationStorePath } from "../memory/memory-relation";
import type { EvidenceKind, EvidenceMemory } from "../evidence";
import { createEvidenceQuery, freezeEvidencePackage, parseQuestionDocument, renderEvidenceMarkdown, renderQuestionDocument, searchEvidence, validateEvidence, type EvidenceDocument, type EvidenceItem, type EvidenceQueryV1, type EvidenceSearchResult, type QuestionRecord } from "../evidence";

function readVaultIdentity(raw: string): string {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || !("schemaVersion" in value) || value.schemaVersion !== 1 || !("vaultId" in value) || typeof value.vaultId !== "string") throw new Error("外部读取身份登记损坏，请检查维护记录。");
	return value.vaultId;
}

export class MeetingWorkspaceService {
	private repository: CatalogRepository | null = null;
	private repositoryKey = "";
	private listeners = new Set<() => void>();
	private events: EventRef[] = [];
	private refreshTimer: number | null = null;
	private disposed = false;
	private lastPublishError = "";
	private registeredPaths = new Set<string>();
	private publishing: Promise<string> | null = null;

	constructor(private app: App, private settings: () => EchoNotesSettings, private persistSettings: () => Promise<void>) {}

	get timezone(): string {
		return this.settings().meetingDisplayTimezone;
	}

	get catalog(): CatalogRepository {
		const settings = this.settings();
		const key = `${settings.memoryRootFolder}\n${settings.memoryPathLanguage}`;
		if (!this.repository || key !== this.repositoryKey) {
			this.repository = createObsidianCatalogRepository(this.app, { rootFolder: settings.memoryRootFolder, language: settings.memoryPathLanguage, transcriptFolders: settings.outputStrategy === "custom-folder" && settings.customOutputFolder.trim() ? [settings.customOutputFolder.trim()] : [] });
			this.repositoryKey = key;
		}
		return this.repository;
	}

	start(): void {
		const changed = (path: string): void => {
			const root = this.settings().memoryRootFolder.replace(/\/$/, "");
			if ((path.endsWith(".md") && (this.registeredPaths.has(path) || path.endsWith(".transcript.md") || path.startsWith(`${root}/`))) || path.endsWith("/echo-memory-relations.json")) this.scheduleRefresh();
		};
		this.events = [
			this.app.vault.on("create", (file) => changed(file.path)),
			this.app.vault.on("modify", (file) => {
				if ((file instanceof TFile && file.extension === "md") || file.name === "echo-memory-relations.json") changed(file.path);
			}),
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.repository) void this.repository.notifyRename(oldPath, file.path).then(() => this.scheduleRefresh()).catch((error: unknown) => { this.lastPublishError = error instanceof Error ? error.message : String(error); this.notify(); });
				changed(oldPath); changed(file.path);
			}),
			this.app.vault.on("delete", (file) => changed(file.path))
		];
	}

	dispose(): void {
		this.disposed = true;
		for (const ref of this.events) this.app.vault.offref(ref);
		this.events = [];
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.listeners.clear();
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notify(): void {
		if (!this.disposed) for (const listener of this.listeners) listener();
	}

	private scheduleRefresh(): void {
		if (this.disposed) return;
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => {
			this.refreshTimer = null;
			if (this.repository) void this.catalog.refreshProjections().then(async () => { this.notify(); await this.refreshEnabledAgentSnapshot(); }).catch((error: unknown) => { this.lastPublishError = error instanceof Error ? error.message : String(error); this.notify(); });
			else this.notify();
		}, 350);
	}

	async snapshot(): Promise<CatalogSnapshot> {
		await this.catalog.initialize();
		const snapshot = await this.catalog.snapshot();
		this.registeredPaths = new Set([...snapshot.meetings, ...snapshot.projects, ...snapshot.sources].map((record) => record.path));
		return snapshot;
	}

	async ensureAudio(audioPath: string, title?: string): Promise<MeetingRecord> {
		const result = await this.catalog.ensureMeetingForAudio(audioPath, { title });
		this.notify();
		return result;
	}

	async registerTranscript(transcriptPath: string, audioPath?: string, meetingPath?: string, title?: string): Promise<string> {
		const result = await this.catalog.registerTranscript({ transcriptPath, audioPath, meetingPath, title });
		this.notify();
		const meeting = (await this.catalog.snapshot()).meetings.find((entry) => entry.id === result.meetingId);
		if (!meeting) throw new Error("转写已登记，但会议记录缺失，请检查维护提示。");
		return meeting.path;
	}

	async recordingStarted(startedAt: number, audioPath?: string): Promise<RecordingRecord> {
		const record = await this.catalog.startRecording({ startedAt: new Date(startedAt).toISOString(), timezone: this.timezone, audioPath });
		this.notify();
		return record;
	}

	async recordingSaved(recordingId: string, audioPath: string, endedAt?: number, durationMs?: number): Promise<void> {
		await this.catalog.finishRecording(recordingId, { audioPath, ...(endedAt === undefined ? {} : { endedAt: new Date(endedAt).toISOString() }), ...(durationMs === undefined ? {} : { durationMs }) });
		this.notify();
	}

	async documents(snapshot?: CatalogSnapshot): Promise<EvidenceDocument[]> {
		const current = snapshot ?? await this.snapshot();
		const meetings = new Map(current.meetings.map((meeting) => [meeting.id, meeting]));
		const documents: EvidenceDocument[] = [];
		for (const source of current.sources) {
			const meeting = meetings.get(source.meetingId);
			const content = await this.catalog.readSourceContent(source.id, current);
			if (!meeting) continue;
			const dates = meetingDates(meeting.time, this.timezone);
			documents.push({ sourceId: source.id, sourcePath: source.path, meetingId: source.meetingId, content: content ?? "", missing: source.missing || content === null, title: meeting.title, meetingTime: meeting.time, meetingDate: dates[0], meetingDates: dates, projectIds: meeting.projectIds, tags: meeting.tags });
		}
		return documents;
	}

	newQuery(question = ""): EvidenceQueryV1 {
		return createEvidenceQuery(question, { filters: { projectIds: [], meetingIds: [], timezone: this.timezone, sourceKinds: ["transcript", "approved_memory"] } });
	}

	async search(query: EvidenceQueryV1): Promise<EvidenceSearchResult> {
		const documents = await this.documents();
		return searchEvidence(documents, query, query.filters.sourceKinds.includes("approved_memory") ? await this.memoryEvidence(documents) : []);
	}

	async exportEvidence(query: EvidenceQueryV1, selection: readonly EvidenceItem[]): Promise<{ path: string; markdown: string }> {
		const now = new Date().toISOString();
		const id = `pkg_${crypto.randomUUID()}`;
		const documents = await this.documents();
		const before = query.filters.sourceKinds.includes("approved_memory") ? await this.memoryProjection(documents) : null;
		const snapshot = await freezeEvidencePackage(documents, query, { packageId: id, frozenAt: now, selection, memories: before?.items ?? [] });
		const currentDocuments = await this.documents();
		const validation = await validateEvidence(snapshot.items, currentDocuments);
		if (!validation.valid) throw new Error(`来源在核验期间发生变化，请刷新材料后重新导出。${validation.issues.map((issue) => `${issue.code} ${issue.sourcePath ?? ""}`).join("、")}`);
		if (before) {
			const after = await this.memoryProjection(currentDocuments);
			const signature = (value: typeof before): string => JSON.stringify({ dependencies: value.dependencyHashes, items: value.items.map((item) => [item.id, item.approval, item.resolvedValidity, item.sourceCheck]) });
			if (signature(before) !== signature(after)) throw new Error("审核或关系在核验期间发生变化，请刷新材料后重新导出。");
		}
		const markdown = renderEvidenceMarkdown(snapshot);
		const path = `${this.catalog.paths.evidenceDir}/${now.slice(0, 10)} ${id}.md`;
		await this.catalog.storage.create(path, markdown);
		return { path, markdown };
	}

	async saveQuestion(query: EvidenceQueryV1, items: readonly EvidenceItem[], previous?: QuestionRecord): Promise<QuestionRecord> {
		const now = new Date().toISOString();
		const question: QuestionRecord = {
			schemaVersion: 1,
			id: previous?.id ?? `q_${crypto.randomUUID()}`,
			createdAt: previous?.createdAt ?? now,
			updatedAt: now,
			query,
			pinnedEvidence: items.filter((item) => query.pinnedEvidenceIds.includes(item.evidenceId)).map(({ evidenceId, sourceId, sourceRevision, sourceRange }) => ({ evidenceId, sourceId, sourceRevision, sourceRange })),
			notes: previous?.notes ?? ""
		};
		const path = `${this.catalog.paths.questionsDir}/${question.id}.md`;
		const content = renderQuestionDocument(question);
		const existing = await this.catalog.storage.read(path);
		if (existing === null) await this.catalog.storage.create(path, content);
		else await this.catalog.storage.process(path, (current) => renderQuestionDocument(question, current));
		this.notify();
		return question;
	}

	async questions(): Promise<QuestionRecord[]> {
		await this.catalog.initialize();
		const paths = await this.catalog.storage.list(this.catalog.paths.questionsDir);
		const records: QuestionRecord[] = [];
		for (const path of paths.filter((name) => name.endsWith(".md"))) {
			const content = await this.catalog.storage.read(path);
			if (content === null) continue;
			const question = parseQuestionDocument(content);
			if (question) records.push(question);
		}
		return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	}

	async open(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) throw new Error("来源文件不存在，请检查维护提示。");
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	async migrationPlan(explicitPaths?: string[]): Promise<CatalogMigrationPlan> {
		return this.catalog.dryRunMigration(explicitPaths);
	}

	async applyMigration(plan: CatalogMigrationPlan): Promise<CatalogMigrationResult> {
		const result = await this.catalog.applyMigration(plan);
		this.notify();
		return result;
	}

	async createProject(name: string): Promise<void> {
		if (!name.trim()) throw new Error("请输入项目名称。");
		const path = `${this.catalog.paths.projectsDir}/${sanitizeMemoryFileName(name)} ${crypto.randomUUID().slice(0, 8)}.md`;
		await this.catalog.registerProject(path, name.trim());
		this.notify();
	}

	async registerExistingProject(path: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(path.trim());
		if (!(file instanceof TFile) || file.extension !== "md") throw new Error("请输入已有 Markdown 项目笔记的 Vault 相对路径。");
		await this.catalog.registerProject(file.path);
		this.notify();
	}

	private agentStorage(): AgentMemoryStorage {
		const storage = this.catalog.storage;
		return {
			read: (path) => storage.read(path),
			list: (path) => storage.list(path),
			write: async (path, content, options) => {
				if (options?.exclusive) await storage.create(path, content);
				else await storage.write(path, content);
			}
		};
	}

	private async agentPublisher(): Promise<AgentExportPublisher> {
		await this.catalog.initialize();
		const storage = this.agentStorage();
		const identityPath = `${this.catalog.paths.systemDir}/agent-reader/vault-id.json`;
		let raw = await storage.read(identityPath);
		if (raw === null) {
			const identity = JSON.stringify({ schemaVersion: 1, vaultId: `vault_${crypto.randomUUID()}` });
			try { await storage.write(identityPath, identity, { exclusive: true }); }
			catch (error) { if (await storage.read(identityPath) === null) throw error; }
			raw = await storage.read(identityPath);
		}
		const vaultId = readVaultIdentity(raw ?? "null");
		return new AgentExportPublisher(storage, { systemDir: this.catalog.paths.systemDir, vaultId });
	}

	private async memoryProjection(documents: EvidenceDocument[]) {
		return readMemoryProjection(this.agentStorage(), {
			authorityRoots: [this.catalog.paths.memory.candidatesDir],
			relationPath: getMemoryRelationStorePath(this.catalog.paths.systemDir),
			documents,
			checkedAt: new Date().toISOString()
		});
	}

	async memoryEvidence(documents?: EvidenceDocument[]): Promise<EvidenceMemory[]> {
		return (await this.memoryProjection(documents ?? await this.documents())).items;
	}

	async setAgentAccess(enabled: boolean, sourceKinds: EvidenceKind[]): Promise<void> {
		const publisher = await this.agentPublisher();
		const snapshot = await this.snapshot();
		const allowedRoots = [...new Set([
			this.catalog.paths.meetingsDir,
			this.catalog.paths.projectsDir,
			this.catalog.paths.memory.candidatesDir,
			getMemoryRelationStorePath(this.catalog.paths.systemDir),
			...snapshot.meetings.map((meeting) => meeting.path),
			...snapshot.projects.map((project) => project.path),
			...snapshot.sources.map((source) => source.path)
		])];
		await publisher.setPolicy({ enabled, sourceKinds, allowedRoots });
	}

	async agentPolicy(): Promise<AgentAccessPolicy | null> {
		return (await this.agentPublisher()).getPolicy();
	}

	async publishAgentSnapshot(): Promise<string> {
		if (this.publishing) return this.publishing;
		const operation = this.performPublish();
		this.publishing = operation;
		try { return await operation; }
		finally { if (this.publishing === operation) this.publishing = null; }
	}

	private async performPublish(): Promise<string> {
		const publisher = await this.agentPublisher();
		const policy = await publisher.getPolicy();
		if (!policy?.enabled) throw new Error("只读导出尚未开启，请先选择允许范围。");
		const snapshot = await this.snapshot();
		const allowed = (path: string): boolean => policy.allowedRoots.some((root) => path === root || path.startsWith(`${root}/`));
		const generation = await publisher.publish({
			documents: (await this.documents(snapshot)).filter((source) => allowed(source.sourcePath)),
			meetings: snapshot.meetings.filter((meeting) => allowed(meeting.path)).map((meeting) => ({ id: meeting.id, path: meeting.path, sourceRevision: meeting.sourceRevision, title: meeting.title, projectIds: meeting.projectIds, time: meeting.time, date: meetingDates(meeting.time, this.timezone)[0] })),
			projects: snapshot.projects.filter((project) => allowed(project.path)),
			authorityRoots: [this.catalog.paths.memory.candidatesDir],
			relationPath: getMemoryRelationStorePath(this.catalog.paths.systemDir)
		});
		this.lastPublishError = "";
		return `已发布完整快照 ${generation.generationId}\n${generation.generatedAt}\n允许 ${policy.sourceKinds.join("、")}\n${generation.meetings.length} 场会议、${generation.documents.length} 份来源`;
	}

	private async refreshEnabledAgentSnapshot(): Promise<void> {
		try {
			const policy = await this.agentPolicy();
			if (policy?.enabled && !this.disposed) await this.publishAgentSnapshot();
		} catch (error) { this.lastPublishError = error instanceof Error ? error.message : String(error); }
	}

	async agentStatus(): Promise<string> {
		const publisher = await this.agentPublisher();
		const result = await new MemoryReader(this.agentStorage(), { policyPath: publisher.policyPath }).execute({ command: "doctor" });
		return JSON.stringify({ ...result, ...(this.lastPublishError ? { lastPublishError: this.lastPublishError } : {}) }, null, 2);
	}

	agentConnectionInstructions(sourceKinds: EvidenceKind[]): string {
		if (!sourceKinds.length) return "请先选择资料范围并生成快照。";
		const vaultPath = this.app.vault.adapter instanceof FileSystemAdapter ? this.app.vault.adapter.getBasePath() : "当前移动端 Vault，需在可访问其文件的桌面端连接";
		const quote = (value: string): string => "'" + value.replace(/'/g, "'\\''") + "'";
		const alias = `echo-${createStableFingerprint(vaultPath).slice(0, 8)}`;
		const kinds = [...new Set(sourceKinds)].map((kind) => `--kind ${quote(kind)}`).join(" ");
		const args = `setup --vault ${quote(vaultPath)} --alias ${quote(alias)} --policy ${quote(`${this.catalog.paths.systemDir}/agent-reader/policy.json`)} ${kinds}`;
		return `先安装完整 Skill，再在本机终端执行所选宿主的命令。\n\nCodex 默认用户目录\nnode "$HOME/.agents/skills/echo-notes-memory/scripts/echo-memory.mjs" ${args}\n\nHermes 使用明确选定的 profile\n先将 HERMES_HOME 设为该 profile 的绝对目录，安装和查询使用同一目录。\nnode "$HERMES_HOME/skills/echo-notes-memory/scripts/echo-memory.mjs" ${args}\n\n运行 doctor → search → read → source 核对结果。当前连接仅允许插件策略与 setup 范围的交集。`;
	}

	async setDisplayTimezone(timezone: string): Promise<void> {
		new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
		this.settings().meetingDisplayTimezone = timezone;
		await this.persistSettings();
		this.notify();
	}

	async reconfigure(): Promise<void> {
		const next = `${this.settings().memoryRootFolder}\n${this.settings().memoryPathLanguage}`;
		if (!this.repository || next === this.repositoryKey) return;
		const old = this.repository;
		const oldIdentity = await old.storage.read(`${old.paths.systemDir}/agent-reader/vault-id.json`);
		const policyPath = `${old.paths.systemDir}/agent-reader/policy.json`;
		const raw = await old.storage.read(policyPath);
		if (raw !== null) {
			const policy = JSON.parse(raw) as AgentAccessPolicy;
			const publisher = new AgentExportPublisher({ read: (path) => old.storage.read(path), list: (path) => old.storage.list(path), write: (path, content) => old.storage.write(path, content) }, { systemDir: old.paths.systemDir, vaultId: policy.vaultId });
			await publisher.setPolicy({ enabled: false, sourceKinds: policy.sourceKinds, allowedRoots: policy.allowedRoots });
		}
		this.repository = null;
		this.repositoryKey = "";
		if (oldIdentity !== null) {
			const identityPath = `${this.catalog.paths.systemDir}/agent-reader/vault-id.json`;
			const existing = await this.catalog.storage.read(identityPath);
			if (existing === null) await this.catalog.storage.create(identityPath, oldIdentity);
			else if (readVaultIdentity(existing) !== readVaultIdentity(oldIdentity)) throw new Error("新根目录已有另一份 Vault 身份，请核对后再连接外部读取器。");
		}
		this.notify();
	}

}

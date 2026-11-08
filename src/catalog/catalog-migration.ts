import type { CatalogRegistry } from "./catalog-repository";
import type { CatalogMigrationItem, CatalogMigrationPlan, CatalogMigrationResult, CatalogPaths, CatalogRepositoryOptions } from "./catalog-types";
import { catalogDocumentTitle, catalogSha256, createCatalogId, meetingTimeProperties, parseCatalogDocument, stringProperty, updateCatalogDocument } from "./catalog-document";
import { normalizeCatalogPath } from "./catalog-paths";

interface MigrationJournal {
	schemaVersion: 1;
	state?: "applying" | "completed" | "rolling_back" | "rolled_back";
	plan: CatalogMigrationPlan;
	items: Record<string, { state: "planned" | "backed_up" | "written" | "verified" | "conflict" | "rolled_back"; backupPath?: string; message?: string }>;
}

function parseRegistry(content: string | null): CatalogRegistry {
	if (content === null) return { schemaVersion: 1, meetingPaths: {}, projectPaths: {}, sourcePaths: {}, recordings: {}, legacyMeetings: {}, pendingMeetings: {}, intentMeetings: {} };
	const value: unknown = JSON.parse(content);
	if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1) throw new Error("身份登记不支持迁移，请先修复。");
	const registry = value as CatalogRegistry;
	registry.intentMeetings ??= {};
	for (const field of ["meetingPaths", "projectPaths", "sourcePaths", "recordings", "legacyMeetings", "pendingMeetings", "intentMeetings"] as const) {
		if (typeof registry[field] !== "object" || registry[field] === null || Array.isArray(registry[field])) throw new Error("身份登记结构无效。");
	}
	return registry;
}

export async function findUnfinishedCatalogMigration(options: Pick<CatalogRepositoryOptions, "storage">, paths: CatalogPaths): Promise<CatalogMigrationPlan | null> {
	const pending: CatalogMigrationPlan[] = [];
	for (const path of (await options.storage.list(paths.migrationDir)).filter((entry) => entry.endsWith("/journal.json")).sort()) {
		const content = await options.storage.read(path);
		if (content === null) continue;
		let journal: MigrationJournal;
		try { journal = JSON.parse(content) as MigrationJournal; } catch { throw new Error("迁移 journal 损坏，请先恢复记录后再盘点。"); }
		if (journal.schemaVersion !== 1 || !journal.plan || journal.plan.schemaVersion !== 1 || !journal.items || typeof journal.items !== "object") throw new Error("迁移 journal 版本或格式不支持。");
		const states = Object.values(journal.items).map((item) => item.state);
		if (journal.state === "completed" || journal.state === "rolled_back") continue;
		if (journal.state === "rolling_back") throw new Error(`迁移 ${journal.plan.id} 存在未完成回滚，请先处理冲突，当前不能创建新迁移。`);
		if (states.every((state) => state === "verified") || states.every((state) => state === "rolled_back")) continue;
		if (states.some((state) => state === "rolled_back")) throw new Error(`迁移 ${journal.plan.id} 存在未完成回滚，请先处理冲突，当前不能创建新迁移。`);
		pending.push(journal.plan);
	}
	if (pending.length > 1) throw new Error("存在多个未完成迁移，请先恢复原运行记录，不能自动选择或新建迁移。");
	return pending[0] ?? null;
}

export async function createCatalogMigrationPlan(options: CatalogRepositoryOptions, paths: CatalogPaths, explicitPaths: string[] = []): Promise<CatalogMigrationPlan> {
	const unfinished = await findUnfinishedCatalogMigration(options, paths);
	if (unfinished) return unfinished;
	const createId = options.createId ?? createCatalogId;
	const plan: CatalogMigrationPlan = { schemaVersion: 1, id: createId("migration"), createdAt: options.now?.() ?? new Date().toISOString(), items: [], issues: [] };
	const registryBefore = await options.storage.read(paths.registry);
	const registry = parseRegistry(registryBefore);
	const documents = new Map<string, string>();
	const sourceMeetings = new Map<string, Set<string>>();
	const legacyProjects = new Set<string>();
	const addRelation = (source: string, meeting: string): void => {
		const sourcePath = normalizeCatalogPath(source), meetingPath = normalizeCatalogPath(meeting);
		const existing = sourceMeetings.get(sourcePath) ?? new Set();
		existing.add(meetingPath);
		sourceMeetings.set(sourcePath, existing);
	};
	const legacyManifest = await options.storage.read(paths.memory.manifest);
	if (legacyManifest !== null) {
		let parsed: unknown;
		try { parsed = JSON.parse(legacyManifest); } catch { plan.issues.push({ code: "PARSE_ERROR", path: paths.memory.manifest, message: "旧 Memory 清单无法解析。" }); }
		if (typeof parsed === "object" && parsed !== null) {
			if ("runs" in parsed && typeof parsed.runs === "object" && parsed.runs !== null) {
				for (const entry of Object.values(parsed.runs as Record<string, unknown>)) {
					if (typeof entry === "object" && entry !== null && "transcriptPath" in entry && typeof entry.transcriptPath === "string" && "meetingPath" in entry && typeof entry.meetingPath === "string") {
						try { addRelation(entry.transcriptPath, entry.meetingPath); } catch { plan.issues.push({ code: "INVALID_METADATA", path: paths.memory.manifest, message: "旧来源路径无效。" }); }
					}
				}
			}
			if ("entityIndex" in parsed && typeof parsed.entityIndex === "object" && parsed.entityIndex !== null) {
				for (const [key, value] of Object.entries(parsed.entityIndex)) if (key.startsWith("project:") && typeof value === "string") legacyProjects.add(normalizeCatalogPath(value));
			}
		}
	}
	const inventory = new Set<string>([
		...await options.storage.list(paths.meetingsDir), ...await options.storage.list(paths.projectsDir),
		...Object.values(registry.meetingPaths), ...Object.values(registry.projectPaths), ...Object.values(registry.sourcePaths),
		...legacyProjects, ...explicitPaths.map(normalizeCatalogPath)
	]);
	for (const [source, meetings] of sourceMeetings) { inventory.add(source); for (const meeting of meetings) inventory.add(meeting); }
	for (const folder of options.transcriptFolders ?? []) for (const path of await options.storage.list(normalizeCatalogPath(folder))) if (path.toLocaleLowerCase().endsWith(".transcript.md")) inventory.add(path);
	for (const path of [...inventory].sort()) {
		if (!path.toLocaleLowerCase().endsWith(".md")) continue;
		const content = await options.storage.read(path);
		if (content === null) { plan.issues.push({ code: "SOURCE_MISSING", path, message: "旧资料缺失，保留未处理。" }); continue; }
		documents.set(path, content);
	}
	for (const [path, content] of documents) {
		try {
			const properties = parseCatalogDocument(content, options.yaml).properties;
			if (properties.echo_kind !== "meeting" && properties.echo_memory_type !== "meeting") continue;
			const source = stringProperty(properties.source);
			const link = source && /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(source);
			if (link) addRelation(link[1], path);
		} catch { /* The parse pass below records malformed documents. */ }
	}
	for (const [source, meetings] of sourceMeetings) for (const path of [source, ...meetings]) {
		if (documents.has(path)) continue;
		const content = await options.storage.read(path);
		if (content === null) plan.issues.push({ code: "SOURCE_MISSING", path, message: "旧来源或会议记录缺失。" });
		else documents.set(path, content);
	}
	const identities = new Map<string, string[]>();
	for (const [path, content] of documents) {
		try {
			const properties = parseCatalogDocument(content, options.yaml).properties;
			const ownKeys: string[] = [];
			if (properties.echo_kind === "meeting" || properties.echo_memory_type === "meeting") ownKeys.push("echo_meeting_id");
			if (properties.echo_kind === "project" || legacyProjects.has(path)) ownKeys.push("echo_project_id");
			if (properties.echo_source_id !== undefined) ownKeys.push("echo_source_id");
			for (const key of ownKeys) {
				const id = stringProperty(properties[key]);
				if (id) identities.set(id, [...(identities.get(id) ?? []), path]);
			}
		} catch (error) { plan.issues.push({ code: "PARSE_ERROR", path, message: error instanceof Error ? error.message : "资料无法解析。" }); }
	}
	const blocked = new Set<string>();
	for (const [id, locations] of identities) if (new Set(locations).size > 1) for (const path of locations) { blocked.add(path); plan.issues.push({ code: "IDENTITY_CONFLICT", path, message: `稳定身份重复 ${id}` }); }
	const staged = new Map<string, { before: string | null; after: string; kind: CatalogMigrationItem["kind"] }>();
	const meetingIds = new Map<string, string>();
	const stage = (path: string, before: string | null, changes: Record<string, unknown>, kind: CatalogMigrationItem["kind"], initial = ""): void => {
		const current = staged.get(path);
		staged.set(path, { before: current?.before ?? before, after: updateCatalogDocument(current?.after ?? before ?? initial, changes, options.yaml), kind });
	};
	for (const [path, content] of documents) {
		if (blocked.has(path)) continue;
		try {
			const properties = parseCatalogDocument(content, options.yaml).properties;
			if (properties.echo_kind === "meeting" || properties.echo_memory_type === "meeting") {
				const id = stringProperty(properties.echo_meeting_id) ?? createId("mtg");
				meetingIds.set(path, id);
				registry.meetingPaths[id] = path;
				const changes: Record<string, unknown> = { echo_schema: 1, echo_kind: "meeting", echo_meeting_id: id };
				if (properties.echo_project_ids === undefined) changes.echo_project_ids = [];
				if (properties.echo_time_precision === undefined) Object.assign(changes, meetingTimeProperties({ precision: "unknown", reason: "旧会议发生时间尚未确认" }));
				stage(path, content, changes, "meeting");
				const source = stringProperty(properties.source);
				const link = source && /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(source);
				if (link) addRelation(link[1], path);
			} else if (properties.echo_kind === "project" || legacyProjects.has(path)) {
				const id = stringProperty(properties.echo_project_id) ?? createId("prj");
				registry.projectPaths[id] = path;
				stage(path, content, { echo_schema: 1, echo_kind: "project", echo_project_id: id, echo_project_status: properties.echo_project_status ?? "active" }, "project");
			}
		} catch (error) { blocked.add(path); plan.issues.push({ code: "PARSE_ERROR", path, message: error instanceof Error ? error.message : "资料无法解析。" }); }
	}
	for (const [path, content] of documents) {
		if (blocked.has(path)) continue;
		try {
			const properties = parseCatalogDocument(content, options.yaml).properties;
			if (properties.type !== "audio-transcript" && !path.toLocaleLowerCase().endsWith(".transcript.md") && properties.echo_source_id === undefined) continue;
			const oldRelations = sourceMeetings.get(path);
			if (oldRelations && oldRelations.size > 1) { plan.issues.push({ code: "RELATION_CONFLICT", path, message: "多个旧会议引用同一来源，请人工确认归属。" }); continue; }
			let meetingId: string | undefined = stringProperty(properties.echo_meeting_id) ?? registry.legacyMeetings[path];
			const oldPath = oldRelations && [...oldRelations][0];
			if (!meetingId && oldPath) {
				meetingId = meetingIds.get(oldPath);
				if (!meetingId) { plan.issues.push({ code: "RELATION_CONFLICT", path, message: "关联的旧会议缺失或无法接管。" }); continue; }
			}
			const audioPathValue = stringProperty(properties.source_audio_path);
			const audioPath = audioPathValue ? normalizeCatalogPath(audioPathValue) : undefined;
			const audio = audioPath && Object.values(registry.recordings).find((item) => item.path === audioPath);
			if (audio) {
				if (meetingId && meetingId !== audio.meetingId) { plan.issues.push({ code: "RELATION_CONFLICT", path, message: "音频与转写会议归属冲突。" }); continue; }
				meetingId = audio.meetingId;
			}
			if (!meetingId) {
				meetingId = createId("mtg");
				const title = catalogDocumentTitle(content, path);
				const meetingPath = `${paths.meetingsDir}/${title.replace(/[\\/:*?"<>|\r\n]/g, " ").slice(0, 100)} ${meetingId.slice(-8)}.md`;
				if (await options.storage.read(meetingPath) !== null || staged.has(meetingPath)) throw new Error("新会议路径冲突。");
				registry.meetingPaths[meetingId] = meetingPath;
				stage(meetingPath, null, { echo_schema: 1, echo_kind: "meeting", echo_meeting_id: meetingId, echo_project_ids: [], ...meetingTimeProperties({ precision: "unknown", reason: "导入会议发生时间尚未确认" }) }, "meeting", `\n# ${title}\n\n## ${options.language === "en" ? "Notes" : "人工补充"}\n\n`);
			}
			const sourceId = stringProperty(properties.echo_source_id) ?? createId("src");
			registry.sourcePaths[sourceId] = path;
			registry.legacyMeetings[path] = meetingId;
			if (audioPath && !audio) { const id = createId("rec"); registry.recordings[id] = { id, path: audioPath, meetingId, state: "saved" }; }
			stage(path, content, { echo_schema: 1, echo_source_id: sourceId, echo_meeting_id: meetingId }, "source");
		} catch (error) { plan.issues.push({ code: "PARSE_ERROR", path, message: error instanceof Error ? error.message : "来源无法接管。" }); }
	}
	for (const [path, item] of staged) {
		if (item.before === item.after) continue;
		plan.items.push({ path, beforeHash: item.before === null ? null : await catalogSha256(item.before), beforeContent: item.before, afterContent: item.after, afterHash: await catalogSha256(item.after), kind: item.kind });
	}
	const registryAfter = `${JSON.stringify(registry, null, 2)}\n`;
	if (registryAfter !== registryBefore) plan.items.push({ path: paths.registry, beforeHash: registryBefore === null ? null : await catalogSha256(registryBefore), beforeContent: registryBefore, afterContent: registryAfter, afterHash: await catalogSha256(registryAfter), kind: "registry" });
	return plan;
}

function migrationPath(paths: CatalogPaths, id: string): string {
	if (!/^[a-zA-Z0-9_-]{8,160}$/.test(id)) throw new Error("迁移运行身份无效。");
	return `${paths.migrationDir}/${id}`;
}

export async function applyCatalogMigration(options: CatalogRepositoryOptions, paths: CatalogPaths, plan: CatalogMigrationPlan): Promise<CatalogMigrationResult> {
	if (plan.schemaVersion !== 1) throw new Error("迁移计划版本不支持。");
	const base = migrationPath(paths, plan.id);
	const journalPath = `${base}/journal.json`;
	const existing = await options.storage.read(journalPath);
	let journal: MigrationJournal;
	if (existing !== null) {
		journal = JSON.parse(existing) as MigrationJournal;
		if (journal.schemaVersion !== 1 || JSON.stringify(journal.plan) !== JSON.stringify(plan)) throw new Error("迁移身份对应另一份计划，请使用原计划继续。");
		if (journal.state === "rolling_back" || journal.state === "rolled_back" || Object.values(journal.items).some((item) => item.state === "rolled_back")) throw new Error("本次迁移已进入回滚，不能重放原执行计划。请先完成恢复并重新盘点。");
		if (journal.state === "completed" || plan.items.every((item) => journal.items[item.path]?.state === "verified")) {
			return { id: plan.id, written: [], skipped: plan.items.map((item) => item.path), conflicts: [] };
		}
	} else {
		journal = { schemaVersion: 1, state: "applying", plan, items: {} };
		for (const item of plan.items) journal.items[item.path] = { state: "planned" };
		await options.storage.create(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	}
	const result: CatalogMigrationResult = { id: plan.id, written: [], skipped: [], conflicts: [] };
	const save = (): Promise<void> => options.storage.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	for (const [index, item] of plan.items.entries()) {
		const path = normalizeCatalogPath(item.path);
		const status = journal.items[path];
		try {
			if (!status) throw new Error("迁移清单缺少项目状态。");
			if (await catalogSha256(item.afterContent) !== item.afterHash || (item.beforeContent !== null && await catalogSha256(item.beforeContent) !== item.beforeHash)) throw new Error("迁移计划内容哈希不匹配。");
			const current = await options.storage.read(path);
			const currentHash = current === null ? null : await catalogSha256(current);
			if (currentHash === item.afterHash) { status.state = "verified"; result.skipped.push(path); await save(); continue; }
			if (currentHash !== item.beforeHash || status.state === "rolled_back") throw new Error("资料在迁移预览之后发生变化，已保留当前内容。");
			if (current !== null) {
				const backupPath = `${base}/backups/${String(index).padStart(5, "0")}.md`;
				const backup = await options.storage.read(backupPath);
				if (backup === null) await options.storage.create(backupPath, current);
				else if (backup !== current) throw new Error("迁移前镜像与当前资料不一致。");
				status.backupPath = backupPath;
			}
			status.state = "backed_up";
			await save();
			if (current === null) await options.storage.create(path, item.afterContent);
			else await options.storage.process(path, (latest) => {
				if (latest !== current) throw new Error("备份后资料又有编辑，已停止该项写入。");
				return item.afterContent;
			});
			status.state = "written";
			await save();
			const verified = await options.storage.read(path);
			if (verified === null || await catalogSha256(verified) !== item.afterHash) throw new Error("迁移写入后核验失败。");
			status.state = "verified";
			delete status.message;
			result.written.push(path);
			await save();
		} catch (error) {
			const message = error instanceof Error ? error.message : "迁移失败。";
			if (status) { status.state = "conflict"; status.message = message; }
			result.conflicts.push({ path, message });
			await save();
			// The registry is the final publication point. Never publish references after a failed business write.
			if (item.kind === "registry") break;
		}
		if (result.conflicts.length && plan.items[index + 1]?.kind === "registry") {
			result.conflicts.push({ path: paths.registry, message: "存在未完成资料，身份清单尚未发布。" });
			break;
		}
	}
	if (result.conflicts.length === 0 && plan.items.every((item) => journal.items[item.path]?.state === "verified")) {
		journal.state = "completed";
		await save();
	}
	return result;
}

export async function rollbackCatalogMigration(options: CatalogRepositoryOptions, paths: CatalogPaths, id: string): Promise<CatalogMigrationResult> {
	const journalPath = `${migrationPath(paths, id)}/journal.json`;
	const content = await options.storage.read(journalPath);
	if (content === null) throw new Error("迁移记录不存在。");
	const journal = JSON.parse(content) as MigrationJournal;
	if (journal.schemaVersion !== 1 || journal.plan.id !== id) throw new Error("迁移记录版本或身份不符。");
	if (journal.state === "rolled_back") return { id, written: [], skipped: journal.plan.items.map((item) => item.path), conflicts: [] };
	journal.state = "rolling_back";
	await options.storage.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	const result: CatalogMigrationResult = { id, written: [], skipped: [], conflicts: [] };
	for (const item of [...journal.plan.items].reverse()) {
		const status = journal.items[item.path];
		const path = normalizeCatalogPath(item.path);
		try {
			if (!status || status.state === "planned" || status.state === "rolled_back") { result.skipped.push(path); continue; }
			const current = await options.storage.read(path);
			const hash = current === null ? null : await catalogSha256(current);
			if (hash === item.beforeHash) { status.state = "rolled_back"; result.skipped.push(path); continue; }
			if (hash !== item.afterHash) throw new Error("迁移后存在后续编辑，已跳过整篇恢复。");
			if (item.beforeContent === null) {
				// A new meeting can acquire links outside the bounded migration set. Keep it for explicit review.
				if (item.kind === "meeting" || item.kind === "project") throw new Error("新建业务笔记保留供人工检查引用，未自动删除。");
				await options.storage.remove(path);
			} else {
				const backup = status.backupPath ? await options.storage.read(status.backupPath) : null;
				if (backup === null || await catalogSha256(backup) !== item.beforeHash) throw new Error("迁移前镜像缺失或损坏，已停止恢复。");
				await options.storage.process(path, (latest) => {
					if (latest !== current) throw new Error("回滚期间资料发生变化，已保留编辑。");
					return backup;
				});
			}
			status.state = "rolled_back";
			result.written.push(path);
		} catch (error) {
			result.conflicts.push({ path, message: error instanceof Error ? error.message : "恢复失败。" });
		}
		await options.storage.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	}
	if (result.conflicts.length === 0) journal.state = "rolled_back";
	await options.storage.write(journalPath, `${JSON.stringify(journal, null, 2)}\n`);
	return result;
}

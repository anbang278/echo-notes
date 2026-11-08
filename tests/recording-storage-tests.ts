import assert from "node:assert/strict";
import { mock } from "node:test";
import { formatRecordingSessionTiming } from "../src/audio/recording-session-timing";
import type { App, MarkdownView, TFile } from "obsidian";
import { normalizeRecordingStorageSettings, type RecordingStorageSettings } from "../src/settings/settings";
import { resolveRecordingFolder, validateRecordingStorage } from "../src/audio/recording-storage-path";
import { RecordingStorageService, RecordingMayExistError } from "../src/audio/recording-storage-service";
import { CoreRecordingStorageAdapter } from "../src/audio/core-recording-storage-adapter";

const defaults = (): RecordingStorageSettings => ({ strategy: "obsidian", subfolder: "Recordings", customFolder: "Recordings" });

type CatalogCallbacks = Partial<Pick<ConstructorParameters<typeof CoreRecordingStorageAdapter>[0], "onSessionStart" | "onSessionSaved" | "onSessionInterrupted">>;

function fixture(callbacks: CatalogCallbacks = {}) {
	const files = new Map<string, TFile>();
	const bytes = new Map<string, ArrayBuffer>();
	const contents = new Map<string, string>();
	const folders = new Set<string>();
	const listeners = new Set<(file: TFile) => void>();
	const notices: string[] = [];
	const opened: string[] = [];
	let active: TFile | null = null;
	let view: MarkdownView | null = null;
	let afterCreate: (() => void) | null = null;
	let settings = defaults();
	const makeFile = (path: string) => ({ path, extension: path.split(".").pop() ?? "", name: path.split("/").pop(), stat: { size: 3 } }) as TFile;
	const app = {
		vault: {
			configDir: ".obsidian",
			getAbstractFileByPath: (path: string) => files.get(path),
			getFileByPath: (path: string) => files.get(path),
			adapter: { exists: async (path: string) => files.has(path) || folders.has(path) },
			createBinary: async (path: string, data: ArrayBuffer) => {
				assert.equal(files.has(path), false, "禁止覆盖已有文件");
				const file = makeFile(path);
				files.set(path, file);
				bytes.set(path, data);
				listeners.forEach((callback) => callback(file));
				afterCreate?.();
				return file;
			},
			on: (_event: string, callback: (file: TFile) => void) => { listeners.add(callback); return callback; },
			offref: (callback: (file: TFile) => void) => listeners.delete(callback),
			readBinary: async (file: TFile) => bytes.get(file.path),
			process: async (file: TFile, fn: (content: string) => string) => contents.set(file.path, fn(contents.get(file.path) ?? ""))
		},
		fileManager: {
			getAvailablePathForAttachment: async (name: string, sourcePath?: string) => `Attachments/${sourcePath ? "note-" : ""}${name}`,
			generateMarkdownLink: (file: TFile) => `[[${file.path}]]`
		},
		workspace: {
			getActiveFile: () => active,
			getLeaf: () => ({ openFile: async (file: TFile) => { opened.push(file.path); } })
		}
	} as unknown as App;
	const storage = new RecordingStorageService(app, async (path) => {
		const parts = path.split("/");
		for (let index = 1; index <= parts.length; index++) {
			const folder = parts.slice(0, index).join("/");
			if (files.has(folder)) throw new Error("目录被文件占用");
			folders.add(folder);
		}
	});
	let nativeCalls = 0;
	const native = async (data: ArrayBuffer) => {
		nativeCalls++;
		return app.vault.createBinary(`Native/fallback-${nativeCalls}.webm`, data);
	};
	const makeRecorder = () => ({ saveRecording: native, onStartRecording: () => undefined, onStopRecording: () => undefined, extension: "webm" });
	let recorder: unknown = makeRecorder();
	const adapter = new CoreRecordingStorageAdapter({ app, storage, getRecorder: () => recorder, getSettings: () => settings, getView: () => view, notify: (message) => notices.push(message), ...callbacks });
	return {
		app, storage, adapter, files, bytes, contents, notices, opened, native, makeRecorder,
		getRecorder: () => recorder as ReturnType<typeof makeRecorder>,
		setRecorder: (value: unknown) => { recorder = value; },
		setSettings: (value: RecordingStorageSettings) => { settings = value; },
		setAfterCreate: (callback: (() => void) | null) => { afterCreate = callback; },
		nativeCalls: () => nativeCalls,
		listenerCount: () => listeners.size,
		setNote: (path: string | null) => {
			active = path ? makeFile(path) : null;
			if (active) files.set(active.path, active);
			return active;
		},
		setView: (value: MarkdownView | null) => { view = value; }
	};
}

export async function runRecordingStorageTests(): Promise<void> {
	const legacy = normalizeRecordingStorageSettings(undefined);
	assert.deepEqual(legacy, defaults());
	assert.equal(normalizeRecordingStorageSettings({ strategy: "unknown" }).strategy, "obsidian");
	legacy.subfolder = "changed";
	assert.equal(normalizeRecordingStorageSettings(undefined).subfolder, "Recordings");
	assert.equal(normalizeRecordingStorageSettings({ strategy: "custom-folder", customFolder: "../bad" }).customFolder, "../bad");
	assert.equal(resolveRecordingFolder(defaults(), "会议/计划.md"), null);
	assert.equal(resolveRecordingFolder({ ...defaults(), strategy: "same-folder" }, "会议/计划.md"), "会议");
	assert.equal(resolveRecordingFolder({ ...defaults(), strategy: "same-folder" }, "计划.md"), "");
	assert.equal(resolveRecordingFolder({ ...defaults(), strategy: "note-subfolder", subfolder: "录音/九月" }, "会议/计划.md"), "会议/录音/九月");
	assert.equal(resolveRecordingFolder({ ...defaults(), strategy: "note-subfolder" }), "Recordings");
	assert.equal(resolveRecordingFolder({ ...defaults(), strategy: "custom-folder", customFolder: "." }), "");
	for (const path of ["", "..", "../bad", "/outside", "C:\\audio", "https://a", "a//b", "a/./b", "a/../b", "a?b", "a\u0000b", "CON", "a/ ", "a."]) {
		assert.ok(validateRecordingStorage({ ...defaults(), strategy: "custom-folder", customFolder: path }), `应拒绝 ${JSON.stringify(path)}`);
	}
	const data = new Uint8Array([1, 2, 3]).buffer;
	const f = fixture();
	assert.match(f.storage.validate({ ...defaults(), strategy: "custom-folder", customFolder: ".obsidian/audio" }, "") ?? "", /配置目录/);
	const settings: RecordingStorageSettings = { ...defaults(), strategy: "custom-folder", customFolder: "中文/音频" };
	const request = { settings, sourcePath: "会议/a.md", name: "Recording", extension: "webm" };
	const saves = Array.from({ length: 4 }, () => f.storage.createBinary(request, data));
	settings.customFolder = "稍后修改";
	assert.deepEqual((await Promise.all(saves)).map((file) => file.path), ["中文/音频/Recording.webm", "中文/音频/Recording 1.webm", "中文/音频/Recording 2.webm", "中文/音频/Recording 3.webm"]);
	assert.equal((await f.storage.createBinary({ ...request, settings: defaults() }, data)).path, "Attachments/note-Recording.webm");
	f.setNote("Occupied");
	await assert.rejects(f.storage.createBinary({ ...request, settings: { ...defaults(), strategy: "custom-folder", customFolder: "Occupied/sub" } }, data), /目录被文件占用/);
	f.app.vault.configDir = "配置";
	assert.match(f.storage.validate({ ...defaults(), strategy: "custom-folder", customFolder: "配置/sub" }, "") ?? "", /配置目录/);
	await assert.rejects(f.storage.createBinary({ ...request, settings: { ...defaults(), strategy: "custom-folder", customFolder: "配置/sub" } }, data), /配置目录/);
	f.setAfterCreate(() => { throw new Error("创建后失败"); });
	await assert.rejects(f.storage.createBinary(request, data), RecordingMayExistError);
	f.setAfterCreate(null);
	const uncertain = fixture();
	let existenceChecks = 0;
	uncertain.app.vault.adapter.exists = async () => {
		if (++existenceChecks > 1) throw new Error("存储不可读");
		return false;
	};
	uncertain.app.vault.createBinary = async () => { throw new Error("写入状态未知"); };
	await assert.rejects(uncertain.storage.createBinary(request, data), RecordingMayExistError);

	const a = fixture();
	a.adapter.refresh();
	const wrapper = a.getRecorder().saveRecording;
	a.adapter.refresh();
	assert.equal(a.getRecorder().saveRecording, wrapper, "刷新不能重复包装");
	await wrapper(data);
	assert.equal(a.nativeCalls(), 1, "跟随模式调用原生");
	a.setSettings({ ...defaults(), strategy: "same-folder" });
	a.setNote("会议/保存时.md");
	const saved = await a.getRecorder().saveRecording(data) as TFile;
	assert.ok(saved.path.startsWith("会议/"));
	assert.ok(a.contents.get("会议/保存时.md")?.includes(saved.path));
	a.setNote("其他目录/旧录音.webm");
	const withoutNote = await a.getRecorder().saveRecording(data) as TFile;
	assert.equal(withoutNote.path.includes("/"), false);
	assert.equal(a.opened.at(-1), withoutNote.path);
	a.setNote(null);
	a.setSettings({ ...defaults(), strategy: "note-subfolder" });
	assert.ok((await a.getRecorder().saveRecording(data) as TFile).path.startsWith("Recordings/"));

	a.setSettings({ ...defaults(), strategy: "custom-folder", customFolder: "../invalid" });
	await a.getRecorder().saveRecording(data);
	assert.equal(a.nativeCalls(), 2);
	assert.ok(a.notices.at(-1)?.includes("Native/fallback-2.webm"));
	assert.equal(a.listenerCount(), 0, "回退观察器必须清理");
	a.setSettings({ ...defaults(), strategy: "custom-folder" });
	a.setAfterCreate(() => { throw new Error("创建后错误"); });
	await a.getRecorder().saveRecording(data);
	assert.equal(a.nativeCalls(), 2, "已创建后失败不得回退重复保存");
	assert.ok(a.notices.at(-1)?.includes("避免重复保存"));
	a.setAfterCreate(null);

	const originalNote = a.setNote("原笔记.md");
	const fakeView = { file: originalNote, editor: { replaceSelection: () => { throw new Error("链接失败"); } } } as unknown as MarkdownView;
	a.setView(fakeView);
	await a.getRecorder().saveRecording(data);
	assert.equal(a.nativeCalls(), 2, "回链失败不得重复保存");
	assert.ok(a.notices.at(-1)?.includes("链接插入"));
	a.setAfterCreate(() => { fakeView.file = a.setNote("第三篇.md"); });
	await a.getRecorder().saveRecording(data);
	assert.ok(a.contents.get("原笔记.md")?.includes("Recording"), "异步保存期间切换笔记仍写原来源");
	assert.equal(a.contents.get("第三篇.md"), undefined);
	a.setAfterCreate(null);

	const old = a.getRecorder();
	const replacement = a.makeRecorder();
	a.setRecorder(replacement);
	a.adapter.refresh();
	assert.equal(old.saveRecording, a.native, "重启核心后还原旧实例");
	assert.notEqual(replacement.saveRecording, a.native);
	a.adapter.dispose();
	assert.equal(replacement.saveRecording, a.native, "卸载恢复原生");
	a.adapter.refresh();
	assert.equal(replacement.saveRecording, a.native, "卸载后禁止重新绑定");
	const incompatible = fixture();
	incompatible.setSettings({ ...defaults(), strategy: "same-folder" });
	incompatible.setRecorder({ saveRecording: incompatible.native });
	incompatible.adapter.refresh();
	incompatible.adapter.refresh();
	assert.equal(incompatible.notices.length, 1, "不兼容只提示一次并保留原方法");
	assert.equal(incompatible.getRecorder().saveRecording, incompatible.native);
	await runRecordingTimingTests();
	await runCatalogRecordingFallbackTests();
}

function timedFixture(callbacks: CatalogCallbacks = {}) {
	const f = fixture(callbacks);
	let permission: () => Promise<void> = async () => undefined;
	let permissionRequests = 0;
	let releasedTracks = 0;
	let captures = 0;
	const recorder = {
		saveRecording: f.native,
		extension: "webm",
		recording: false,
		recorder: null as (EventTarget & { state: string }) | null,
		async onStartRecording() {
			permissionRequests++;
			await permission();
			this.startRecording({ getTracks: () => [{ stop: () => { releasedTracks++; } }] });
			this.recording = true;
		},
		startRecording(_stream?: unknown) {
			captures++;
			this.recorder = Object.assign(new EventTarget(), { state: "recording" });
		},
		onStopRecording() {
			assert.equal(this.recording, true, "不能重复停止");
			this.recording = false;
			this.recorder!.state = "inactive";
			this.recorder!.dispatchEvent(new Event("stop"));
		}
	};
	const originalMethods = { startRecording: recorder.startRecording, onStartRecording: recorder.onStartRecording, onStopRecording: recorder.onStopRecording };
	f.setRecorder(recorder);
	f.adapter.refresh();
	return { ...f, recorder, originalMethods, permissionRequests: () => permissionRequests, captures: () => captures,
		releasedTracks: () => releasedTracks, setPermission: (fn: () => Promise<void>) => { permission = fn; } };
}

async function runRecordingTimingTests(): Promise<void> {
	const local = (year: number, month: number, day: number, hour: number, minute: number) => new Date(year, month - 1, day, hour, minute).getTime();
	const start = local(2026, 11, 4, 14, 0);
	const format = (durationMs: number) => formatRecordingSessionTiming({ startedAt: start, endedAt: start + durationMs, durationMs });
	assert.equal(format(59999), "录音时间：14:00–14:00（不到1分钟）");
	assert.equal(format(60000), "录音时间：14:00–14:01（1分钟）");
	assert.equal(format(3600000), "录音时间：14:00–15:00（1小时）");
	assert.equal(format(5400999), "录音时间：14:00–15:30（1小时30分钟）");
	const midnight = local(2026, 12, 31, 23, 30);
	assert.equal(formatRecordingSessionTiming({ startedAt: midnight, endedAt: midnight + 3000000, durationMs: 3000000 }),
		"录音时间：2026-12-31 23:30–2027-01-01 00:20（50分钟）");
	assert.equal(formatRecordingSessionTiming({ startedAt: start, endedAt: start + 3600000, durationMs: 1000 }), null);
	assert.equal(formatRecordingSessionTiming({ startedAt: NaN, endedAt: start, durationMs: 0 }), null);
	assert.equal(formatRecordingSessionTiming({ startedAt: start, endedAt: start - 1, durationMs: -1 }), null);

	let wall = start;
	let monotonic = 0;
	const wallClock = mock.method(Date, "now", () => wall);
	const elapsedClock = mock.method(performance, "now", () => monotonic);
	const advance = (ms: number) => { wall += ms; monotonic += ms; };
	const data = new Uint8Array([4, 5, 6]).buffer;
	try {
		for (const strategy of ["obsidian", "same-folder", "note-subfolder", "custom-folder"] as const) {
			const f = timedFixture();
			const note = f.setNote("会议/测试.md");
			f.setSettings({ ...defaults(), strategy });
			let resolvePermission!: () => void;
			f.setPermission(() => new Promise<void>((resolve) => { resolvePermission = resolve; }));
			const pendingStart = f.recorder.onStartRecording();
			await f.recorder.onStartRecording();
			assert.equal(f.permissionRequests(), 1, "启动期间应阻止重复麦克风申请");
			advance(120000);
			resolvePermission();
			await pendingStart;
			let text = "前文保留选中文字后文";
			const view = { file: note, editor: {
				getCursor: () => ({ line: 0, ch: 2 }),
				replaceRange: (value: string) => { text = text.slice(0, 2) + value + text.slice(2); },
				replaceSelection: () => { throw new Error("不得覆盖选择正文"); }
			} } as unknown as MarkdownView;
			f.setView(view);
			advance(5400000);
			f.recorder.onStopRecording();
			f.recorder.onStopRecording();
			await f.recorder.onStartRecording();
			assert.equal(f.permissionRequests(), 1, "保存前应阻止下一段录音");
			advance(120000);
			const saved = await f.recorder.saveRecording(data) as TFile;
			assert.equal(f.nativeCalls(), 0, "有计时的默认附件模式也必须经过统一存储");
			assert.equal((text.match(/录音时间：/g) ?? []).length, 1);
			assert.ok(text.includes("（1小时30分钟）"), "授权等待与保存延迟不得计入录音");
			assert.ok(text.includes(saved.path));
			assert.ok(text.endsWith("保留选中文字后文"));
			f.setPermission(async () => undefined);
			await f.recorder.onStartRecording();
			advance(500);
			f.recorder.onStopRecording();
			await f.recorder.saveRecording(data);
			assert.equal((text.match(/录音时间：/g) ?? []).length, 2, "第二段应独立生成时间");
			f.adapter.dispose();
		}

		const linkedSource = timedFixture();
		const linkedNote = linkedSource.setNote("创建事件来源.md");
		let sourceReady: Promise<TFile | null> | undefined;
		linkedSource.app.vault.on("create", (file) => {
			sourceReady = linkedSource.adapter.getPendingSource(file.path);
			assert.ok(sourceReady, "create事件触发前应登记来源就绪Promise");
			assert.equal(linkedSource.contents.get(linkedNote!.path), undefined, "创建时尚未插入来源区块");
		});
		await linkedSource.recorder.onStartRecording();
		linkedSource.recorder.onStopRecording();
		const linkedAudio = await linkedSource.recorder.saveRecording(data) as TFile;
		assert.equal(await sourceReady, linkedNote);
		assert.match(linkedSource.contents.get(linkedNote!.path) ?? "", /录音时间：/);
		assert.equal(linkedSource.adapter.getPendingSource(linkedAudio.path), undefined, "保存结束应清理运行态关联");

		const failedSource = timedFixture();
		const removedNote = failedSource.setNote("创建后删除.md")!;
		let failedReady: Promise<TFile | null> | undefined;
		failedSource.app.vault.on("create", (file) => {
			failedReady = failedSource.adapter.getPendingSource(file.path);
			failedSource.files.delete(removedNote.path);
		});
		await failedSource.recorder.onStartRecording();
		failedSource.recorder.onStopRecording();
		const failedAudio = await failedSource.recorder.saveRecording(data) as TFile;
		assert.ok(failedSource.files.has(failedAudio.path));
		assert.equal(await failedReady, null, "来源插入失败仍应结算等待者");
		assert.equal(failedSource.adapter.getPendingSource(failedAudio.path), undefined);

		const disposedSource = timedFixture();
		disposedSource.setNote("创建时卸载.md");
		let disposedReady: Promise<TFile | null> | undefined;
		disposedSource.app.vault.on("create", (file) => {
			disposedReady = disposedSource.adapter.getPendingSource(file.path);
			disposedSource.adapter.dispose();
		});
		await disposedSource.recorder.onStartRecording();
		disposedSource.recorder.onStopRecording();
		await disposedSource.recorder.saveRecording(data);
		assert.equal(await disposedReady, null, "卸载应结算来源等待者");

		const switched = timedFixture();
		switched.setNote("停止时.md");
		await switched.recorder.onStartRecording();
		advance(60000);
		switched.recorder.onStopRecording();
		switched.setNote("保存时.md");
		await switched.recorder.saveRecording(data);
		assert.match(switched.contents.get("停止时.md") ?? "", /录音时间：/);
		assert.equal(switched.contents.get("保存时.md"), undefined);
		assert.match(switched.notices.at(-1) ?? "", /笔记末尾/);

		const deleted = timedFixture();
		const note = deleted.setNote("已删除.md")!;
		await deleted.recorder.onStartRecording();
		deleted.recorder.onStopRecording();
		deleted.files.delete(note.path);
		const orphan = await deleted.recorder.saveRecording(data) as TFile;
		assert.ok(deleted.files.has(orphan.path));
		assert.match(deleted.notices.at(-1) ?? "", /插入或打开失败/);

		const fallback = timedFixture();
		fallback.setNote("回退.md");
		fallback.setSettings({ ...defaults(), strategy: "custom-folder", customFolder: "../invalid" });
		await fallback.recorder.onStartRecording();
		fallback.recorder.onStopRecording();
		const attachment = await fallback.recorder.saveRecording(data) as TFile;
		assert.ok(attachment.path.startsWith("Attachments/"));
		assert.match(fallback.contents.get("回退.md") ?? "", /录音时间：/);
		assert.equal(fallback.nativeCalls(), 0);

		const denied = timedFixture();
		denied.setPermission(async () => { throw new Error("denied"); });
		await assert.rejects(denied.recorder.onStartRecording(), /denied/);
		assert.equal(denied.captures(), 0);
		denied.setPermission(async () => undefined);
		await denied.recorder.onStartRecording();
		denied.recorder.onStopRecording();
		await denied.recorder.saveRecording(data);

		const late = timedFixture();
		let allow!: () => void;
		late.setPermission(() => new Promise<void>((resolve) => { allow = resolve; }));
		const starting = late.recorder.onStartRecording();
		late.adapter.dispose();
		allow();
		await assert.rejects(starting, /启动已取消/);
		assert.equal(late.captures(), 0);
		assert.equal(late.releasedTracks(), 1);
		assert.equal(late.recorder.startRecording, late.originalMethods.startRecording);
		assert.equal(late.recorder.onStartRecording, late.originalMethods.onStartRecording);
		assert.equal(late.recorder.saveRecording, late.native);

		const slow = timedFixture();
		slow.setNote("慢保存.md");
		slow.app.fileManager.generateMarkdownLink = (file) => `[audio](${file.path})`;
		await slow.recorder.onStartRecording();
		slow.recorder.onStopRecording();
		let finishSave!: () => void;
		const createBinary = slow.app.vault.createBinary.bind(slow.app.vault);
		let creations = 0;
		slow.app.vault.createBinary = async (...args) => {
			creations++;
			await new Promise<void>((resolve) => { finishSave = resolve; });
			return createBinary(...args);
		};
		const firstSave = slow.recorder.saveRecording(data);
		const repeatedSave = slow.recorder.saveRecording(data);
		await slow.recorder.onStartRecording();
		assert.equal(slow.permissionRequests(), 1);
		// Let storage's queued directory/path checks reach the actual write.
		while (!finishSave) await Promise.resolve();
		finishSave();
		assert.equal(await firstSave, await repeatedSave);
		assert.equal(creations, 1, "保存中的重复调用应共享同一个录音文件");
		assert.match(slow.contents.get("慢保存.md") ?? "", /!\[audio\]\(/);

		const unloading = timedFixture();
		unloading.setNote("保存中停用.md");
		await unloading.recorder.onStartRecording();
		unloading.recorder.onStopRecording();
		unloading.setAfterCreate(() => unloading.adapter.dispose());
		const preserved = await unloading.recorder.saveRecording(data) as TFile;
		assert.ok(unloading.files.has(preserved.path));
		assert.equal(unloading.contents.get("保存中停用.md"), undefined);

		const noNote = timedFixture();
		await noNote.recorder.onStartRecording();
		noNote.recorder.onStopRecording();
		const opened = await noNote.recorder.saveRecording(data) as TFile;
		assert.equal(noNote.opened.at(-1), opened.path);

		const rebinding = timedFixture();
		const originalStart = rebinding.recorder.onStartRecording;
		const replacement = rebinding.makeRecorder();
		rebinding.setRecorder(replacement);
		rebinding.adapter.refresh();
		assert.notEqual(rebinding.recorder.onStartRecording, originalStart);
		assert.equal(rebinding.recorder.saveRecording, rebinding.native);
		rebinding.adapter.dispose();
		assert.equal(replacement.saveRecording, rebinding.native);

		const readOnly = fixture();
		const incompatible = readOnly.makeRecorder();
		const originalOnStart = incompatible.onStartRecording;
		Object.defineProperty(incompatible, "startRecording", { value: () => undefined, writable: false });
		readOnly.setRecorder(incompatible);
		readOnly.adapter.refresh();
		assert.equal(incompatible.onStartRecording, originalOnStart, "计时绑定失败应还原已经包装的启动方法");
		assert.notEqual(incompatible.saveRecording, readOnly.native, "计时绑定失败仍应保留存储适配");
		assert.match(readOnly.notices.at(-1) ?? "", /无法标注录音时间/);
		readOnly.adapter.dispose();
		assert.equal(incompatible.saveRecording, readOnly.native);

		const changedClock = timedFixture();
		changedClock.setNote("时钟变化.md");
		await changedClock.recorder.onStartRecording();
		wall += 600000;
		changedClock.recorder.onStopRecording();
		await changedClock.recorder.saveRecording(data);
		assert.ok(!changedClock.contents.get("时钟变化.md")?.includes("录音时间："));
		assert.ok(changedClock.notices.some((notice) => notice.includes("计时异常")));
	} finally {
		wallClock.mock.restore();
		elapsedClock.mock.restore();
	}
}

async function runCatalogRecordingFallbackTests(): Promise<void> {
	const data = new Uint8Array([7, 8, 9]).buffer;
	const registered: Array<{ id: string | null; path: string }> = [];
	const interrupted: string[] = [];
	const f = timedFixture({
		onSessionStart: async () => "rec_existing-session",
		onSessionSaved: async (id, file) => { registered.push({ id, path: file.path }); },
		onSessionInterrupted: async (id) => { interrupted.push(id); }
	});
	const note = f.setNote("Native/来源.md");
	f.setSettings({ ...defaults(), strategy: "custom-folder", customFolder: "../invalid" });
	f.app.fileManager.getAvailablePathForAttachment = async () => { throw new Error("attachment lookup failed"); };
	const sourceWaiters = new Map<string, Promise<TFile | null>>();
	const waiterResults: Array<{ path: string; registeredBeforeRelease: boolean }> = [];
	f.app.vault.on("create", (file) => {
		const pending = f.adapter.getPendingSource(file.path);
		assert.ok(pending, "native fallback must provide a readiness promise before the original create callback continues");
		sourceWaiters.set(file.path, pending);
		void pending.then(() => { waiterResults.push({ path: file.path, registeredBeforeRelease: registered.some((entry) => entry.path === file.path) }); });
	});
	await f.recorder.onStartRecording();
	f.recorder.onStopRecording();
	const native = await f.recorder.saveRecording(data) as TFile;
	assert.equal(f.nativeCalls(), 1);
	assert.deepEqual(registered, [{ id: "rec_existing-session", path: native.path }], "native fallback must bind the original recording session identity");
	assert.equal(await sourceWaiters.get(native.path), note);
	assert.equal(waiterResults[0].registeredBeforeRelease, true, "automatic transcription must run after the original recording identity is bound");
	assert.deepEqual(interrupted, [], "a successful native fallback must not become interrupted during clearSession");
	assert.equal(f.adapter.getPendingSource(native.path), undefined);
	f.adapter.dispose();

	let resolveStart!: (id: string) => void;
	const lateSaved: string[] = [];
	const lateInterrupted: string[] = [];
	const late = timedFixture({
		onSessionStart: () => new Promise<string>((resolve) => { resolveStart = resolve; }),
		onSessionSaved: async (_id, file) => { await Promise.resolve(); lateSaved.push(file.path); },
		onSessionInterrupted: async (id) => { lateInterrupted.push(id); }
	});
	late.setNote("保存期间停用.md");
	await late.recorder.onStartRecording();
	late.recorder.onStopRecording();
	const save = late.recorder.saveRecording(data);
	for (let index = 0; index < 20; index++) await Promise.resolve();
	late.adapter.dispose();
	resolveStart("rec_late");
	const preserved = await save as TFile;
	for (let index = 0; index < 5; index++) await Promise.resolve();
	assert.deepEqual(lateSaved, [preserved.path]);
	assert.deepEqual(lateInterrupted, [], "unload during save must wait for the saved callback before deciding interruption");

	const partialSaved: string[] = [];
	const partialInterrupted: string[] = [];
	const partial = timedFixture({
		onSessionStart: async () => "rec_partial_native",
		onSessionSaved: async (id) => { partialSaved.push(id!); },
		onSessionInterrupted: async (id) => { partialInterrupted.push(id); }
	});
	partial.setSettings({ ...defaults(), strategy: "custom-folder", customFolder: "../invalid" });
	partial.app.fileManager.getAvailablePathForAttachment = async () => { throw new Error("lookup"); };
	partial.setAfterCreate(() => { throw new Error("native link insertion failed after file write"); });
	await partial.recorder.onStartRecording();
	partial.recorder.onStopRecording();
	await assert.rejects(partial.recorder.saveRecording(data), /native link insertion failed/);
	for (let index = 0; index < 5; index++) await Promise.resolve();
	assert.deepEqual(partialSaved, ["rec_partial_native"], "a uniquely confirmed audio file must keep the session identity even if native linking throws after creation");
	assert.deepEqual(partialInterrupted, []);
	assert.ok(partial.files.has("Native/fallback-1.webm"));
	partial.adapter.dispose();

	const unmatched: Array<string | null> = [];
	const noTiming = fixture({ onSessionSaved: async (id) => { unmatched.push(id); } });
	noTiming.adapter.refresh();
	await noTiming.getRecorder().saveRecording(data);
	assert.deepEqual(unmatched, [null], "native saving without timing hooks should still register the saved recording");
	noTiming.adapter.dispose();

	const isolated = fixture({ onSessionSaved: async (_id, file) => { assert.equal(file.path, "Native/fallback-1.webm"); } });
	isolated.adapter.refresh();
	const pendingByPath = new Map<string, Promise<TFile | null>>();
	isolated.app.vault.on("create", (file) => {
		const ready = isolated.adapter.getPendingSource(file.path);
		if (ready) pendingByPath.set(file.path, ready);
	});
	let createOther = true;
	isolated.setAfterCreate(() => {
		if (!createOther) return;
		createOther = false;
		void isolated.app.vault.createBinary("Unrelated/other.webm", new Uint8Array([1]).buffer);
	});
	await isolated.getRecorder().saveRecording(data);
	assert.equal(await pendingByPath.get("Unrelated/other.webm"), null, "concurrent unrelated audio must not inherit the recording source");
	isolated.adapter.dispose();
}

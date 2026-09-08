import assert from "node:assert/strict";
import type { App, MarkdownView, TFile } from "obsidian";
import { normalizeRecordingStorageSettings, type RecordingStorageSettings } from "../src/settings/settings";
import { resolveRecordingFolder, validateRecordingStorage } from "../src/audio/recording-storage-path";
import { RecordingStorageService, RecordingMayExistError } from "../src/audio/recording-storage-service";
import { CoreRecordingStorageAdapter } from "../src/audio/core-recording-storage-adapter";

const defaults = (): RecordingStorageSettings => ({ strategy: "obsidian", subfolder: "Recordings", customFolder: "Recordings" });

function fixture() {
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
	const adapter = new CoreRecordingStorageAdapter({ app, storage, getRecorder: () => recorder, getSettings: () => settings, getView: () => view, notify: (message) => notices.push(message) });
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
}

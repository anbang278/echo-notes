import type { App, MarkdownView, TFile } from "obsidian";
import type { RecordingStorageSettings } from "../settings/settings";
import { RecordingMayExistError, RecordingStorageService } from "./recording-storage-service";

interface CoreRecorder {
	saveRecording: (data: ArrayBuffer) => Promise<unknown>;
	onStartRecording: (...args: unknown[]) => unknown;
	onStopRecording: (...args: unknown[]) => unknown;
	extension: string;
}

interface AdapterOptions {
	app: App;
	storage: RecordingStorageService;
	getSettings: () => RecordingStorageSettings;
	getRecorder: () => unknown;
	getView: () => MarkdownView | null;
	notify: (message: string) => void;
}

function isCoreRecorder(value: unknown): value is CoreRecorder {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<CoreRecorder>;
	return typeof candidate.saveRecording === "function"
		&& typeof candidate.onStartRecording === "function"
		&& typeof candidate.onStopRecording === "function"
		&& typeof candidate.extension === "string";
}

export class CoreRecordingStorageAdapter {
	private binding: { recorder: CoreRecorder; original: CoreRecorder["saveRecording"]; wrapped: CoreRecorder["saveRecording"]; owned: boolean } | null = null;
	private disposed = false;
	private warned = false;

	constructor(private options: AdapterOptions) {}

	refresh(): void {
		if (this.disposed) return;
		const recorder = this.options.getRecorder();
		if (this.binding && this.binding.recorder === recorder && this.binding.recorder.saveRecording === this.binding.wrapped) return;
		this.restore();
		if (!isCoreRecorder(recorder)) {
			if (!this.warned && this.options.getSettings().strategy !== "obsidian") {
				this.options.notify("核心录音机保存接口不可用，录音存放配置暂未生效；核心录音仍使用 Obsidian 原生保存。");
				this.warned = true;
			}
			return;
		}
		const original = recorder.saveRecording;
		const owned = Object.hasOwn(recorder, "saveRecording");
		const wrapped = (data: ArrayBuffer) => {
			if (this.disposed || this.options.getSettings().strategy === "obsidian") return original.call(recorder, data) as Promise<unknown>;
			return this.save(recorder, original, data);
		};
		try {
			recorder.saveRecording = wrapped;
			this.binding = { recorder, original, wrapped, owned };
			this.warned = false;
		} catch {
			if (!this.warned && this.options.getSettings().strategy !== "obsidian") {
				this.options.notify("无法接入核心录音机保存接口，录音存放配置暂未生效；将使用 Obsidian 原生保存。");
				this.warned = true;
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		this.restore();
	}

	private restore(): void {
		const binding = this.binding;
		if (binding && binding.recorder.saveRecording === binding.wrapped) {
			if (binding.owned) binding.recorder.saveRecording = binding.original;
			else Reflect.deleteProperty(binding.recorder, "saveRecording");
		}
		this.binding = null;
	}

	private async save(recorder: CoreRecorder, original: CoreRecorder["saveRecording"], data: ArrayBuffer): Promise<unknown> {
		const { app, storage, getSettings, getView, notify } = this.options;
		const activeFile = app.workspace.getActiveFile();
		const source = activeFile?.extension === "md" ? activeFile : null;
		const sourcePath = source?.path ?? "";
		const view = getView();
		const settings = { ...getSettings() };
		const extension = recorder.extension;
		let file: TFile;
		try {
			const date = new Date();
			const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
			file = await storage.createBinary({ settings, sourcePath, name: `Recording ${timestamp}`, extension }, data);
		} catch (error) {
			if (error instanceof RecordingMayExistError) {
				notify(`录音创建时发生错误，${error.path} 可能已保存；为避免重复保存，请先检查该文件是否存在且完整。`);
				return;
			}
			return this.fallback(recorder, original, data);
		}
		try {
			if (source && source.extension === "md") {
				const link = app.fileManager.generateMarkdownLink(file, source.path);
				const embed = link.startsWith("!") ? link : `!${link}`;
				if (view?.file === source && app.workspace.getActiveFile() === source) view.editor.replaceSelection(`${embed}\n`);
				else if (app.vault.getAbstractFileByPath(source.path) === source) await app.vault.process(source, (content) => `${content}\n${embed}\n`);
				else throw new Error("来源笔记已不存在。");
			} else {
				await app.workspace.getLeaf(false).openFile(file);
			}
		} catch {
			notify(`录音已保存至 ${file.path}，但链接插入或打开失败，请从文件列表打开录音。`);
		}
		return file;
	}

	private async fallback(recorder: CoreRecorder, original: CoreRecorder["saveRecording"], data: ArrayBuffer): Promise<unknown> {
		const { app, notify } = this.options;
		// 只观察本次原生调用期间的创建事件；内容核对避免把并发创建误报为本次录音。
		const candidates: TFile[] = [];
		const ref = app.vault.on("create", (file) => {
			const created = app.vault.getFileByPath(file.path);
			if (created?.extension === recorder.extension) candidates.push(created);
		});
		let result: unknown;
		try {
			result = await original.call(recorder, data);
		} catch (error) {
			notify("自定义录音目录保存失败，原生保存也未完成；请检查存储空间和附件目录。已创建的文件不会重复保存。");
			throw error;
		} finally {
			app.vault.offref(ref);
		}
		const matches: string[] = [];
		for (const candidate of candidates) {
			try {
				const bytes = new Uint8Array(await app.vault.readBinary(candidate));
				const expected = new Uint8Array(data);
				if (bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])) matches.push(candidate.path);
			} catch { /* 文件被外部移动时不推断其位置。 */ }
		}
		notify(matches.length === 1
			? `自定义录音目录保存失败，已回退 Obsidian 原生保存：${matches[0]}`
			: "自定义录音目录保存失败，已调用 Obsidian 原生保存；无法唯一确认本次录音位置，请检查原生插入的链接或打开的音频。");
		return result;
	}
}

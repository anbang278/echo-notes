import type { App, MarkdownView, TFile } from "obsidian";
import type { RecordingStorageSettings } from "../settings/settings";
import { formatRecordingSessionTiming, type RecordingSessionTiming } from "./recording-session-timing";
import { RecordingMayExistError, RecordingStorageService } from "./recording-storage-service";

interface CoreRecorder {
	saveRecording: (this: CoreRecorder, data: ArrayBuffer) => Promise<unknown>;
	onStartRecording: (...args: unknown[]) => unknown;
	onStopRecording: (...args: unknown[]) => unknown;
	extension: string;
	startRecording?: (...args: unknown[]) => unknown;
	recorder?: MediaRecorder | null;
}

interface AdapterOptions {
	app: App;
	storage: RecordingStorageService;
	getSettings: () => RecordingStorageSettings;
	getRecorder: () => unknown;
	getView: () => MarkdownView | null;
	notify: (message: string) => void;
	onSessionStart?: (startedAt: number) => Promise<string>;
	onSessionSaved?: (id: string | null, file: TFile, timing: RecordingSessionTiming | null) => Promise<void>;
	onSessionInterrupted?: (id: string) => Promise<void>;
}

function isCoreRecorder(value: unknown): value is CoreRecorder {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<CoreRecorder>;
	return typeof candidate.saveRecording === "function"
		&& typeof candidate.onStartRecording === "function"
		&& typeof candidate.onStopRecording === "function"
		&& typeof candidate.extension === "string";
}

interface SaveContext {
	source: TFile | null;
	settings: RecordingStorageSettings;
}

interface RecordingSession {
	startedAt: number;
	startedMonotonic: number;
	timing: RecordingSessionTiming | null;
	context: SaveContext | null;
	saving?: Promise<unknown>;
	catalogId?: Promise<string | null>;
	catalogSaved?: boolean;
	catalogInterruptionScheduled?: boolean;
	cleanup: () => void;
}

type RecorderMethod = "saveRecording" | "onStartRecording" | "startRecording" | "onStopRecording";

interface RecorderBinding {
	recorder: CoreRecorder;
	methods: Array<{ key: RecorderMethod; original: unknown; wrapped: unknown; owned: boolean }>;
	session: RecordingSession | null;
	starting: boolean;
}

export class CoreRecordingStorageAdapter {
	private binding: RecorderBinding | null = null;
	private disposed = false;
	private warned = false;
	private pendingSources = new Map<string, { promise: Promise<TFile | null>; finish: (source: TFile | null) => void }>();
	private nativeSaveQueue: Promise<unknown> = Promise.resolve();
	private nativeSaveScope: { paths: Set<string>; extension: string } | null = null;

	getPendingSource(audioPath: string): Promise<TFile | null> | undefined {
		const scope = this.nativeSaveScope;
		if (!this.disposed && !this.pendingSources.has(audioPath) && scope && audioPath.endsWith(`.${scope.extension}`)) {
			let finish!: (source: TFile | null) => void;
			const promise = new Promise<TFile | null>((resolve) => { finish = resolve; });
			this.pendingSources.set(audioPath, { promise, finish });
			scope.paths.add(audioPath);
		}
		return this.pendingSources.get(audioPath)?.promise;
	}

	constructor(private options: AdapterOptions) {}

	refresh(): void {
		if (this.disposed) return;
		const recorder = this.options.getRecorder();
		if (this.binding && this.binding.recorder === recorder && this.binding.methods.every((method) => this.binding?.recorder[method.key] === method.wrapped)) return;
		this.restore();
		if (!isCoreRecorder(recorder)) {
			if (recorder && !this.warned) {
				this.options.notify("核心录音机保存接口不可用，录音时间和存放配置暂未生效；核心录音仍使用 Obsidian 原生保存。");
				this.warned = true;
			}
			return;
		}
		const original = recorder.saveRecording;
		const binding: RecorderBinding = { recorder, methods: [], session: null, starting: false };
		this.binding = binding;
		try {
			this.wrap(binding, "saveRecording", async (data: ArrayBuffer): Promise<unknown> => {
				const session = binding.session?.context ? binding.session : null;
				if (this.disposed || this.binding !== binding) {
					const result: unknown = await original.call(recorder, data);
					return result;
				}
				if (session?.saving) return session.saving;
				const operation = !session && this.options.getSettings().strategy === "obsidian"
					? this.fallback(recorder, original, data, null, false)
					: this.save(recorder, original, data, session);
				if (session) session.saving = operation;
				try {
					return await operation;
				} finally {
					if (session) this.clearSession(binding, session);
				}
			});
		} catch {
			this.restore();
			this.warn("无法接入核心录音机保存接口，录音时间和存放配置暂未生效；将使用 Obsidian 原生保存。");
			return;
		}
		if (typeof recorder.startRecording !== "function") {
			this.warn("核心录音机计时接口不可用，无法标注录音时间；录音仍可正常保存。");
			return;
		}
		try {
			this.bindTiming(binding);
			this.warned = false;
		} catch {
			// Keep the working storage wrapper even when the timing hooks are read-only.
			this.restoreMethods(binding, binding.methods.splice(1));
			this.warn("无法接入核心录音机计时接口，无法标注录音时间；录音仍可正常保存。");
		}
	}

	private warn(message: string): void {
		if (!this.warned) this.options.notify(message);
		this.warned = true;
	}

	private wrap(binding: RecorderBinding, key: RecorderMethod, wrapped: unknown): void {
		const recorder = binding.recorder;
		const method = { key, original: recorder[key], wrapped, owned: Object.hasOwn(recorder, key) };
		if (!Reflect.set(recorder, key, wrapped) || recorder[key] !== wrapped) throw new Error("核心录音机接口不可写。");
		binding.methods.push(method);
	}

	private bindTiming(binding: RecorderBinding): void {
		const recorder = binding.recorder;
		const originalStart = recorder.onStartRecording;
		const originalCapture = recorder.startRecording!;
		const originalStop = recorder.onStopRecording;
		this.wrap(binding, "onStartRecording", async (...args: unknown[]) => {
			if (binding.starting || binding.session) {
				this.options.notify("录音正在启动、录制或保存，请完成当前录音后再开始。");
				return;
			}
			binding.starting = true;
			try {
				const result: unknown = await originalStart.apply(recorder, args);
				return result;
			} finally {
				binding.starting = false;
				if (this.binding !== binding) this.restoreMethods(binding, binding.methods);
			}
		});
		this.wrap(binding, "startRecording", (...args: unknown[]) => {
			if (this.disposed || this.binding !== binding) {
				// Permission may resolve after unload. Release this late stream before the core creates a recorder.
				const stream = args[0] as MediaStream | undefined;
				stream?.getTracks?.().forEach((track) => track.stop());
				throw new Error("Echo Notes 已停用，录音启动已取消，请重新开始录音。");
			}
			const result: unknown = originalCapture.apply(recorder, args);
			const media = recorder.recorder;
			if (media?.state !== "recording") {
				this.warn("未能确认录音开始时间，录音保存后将跳过时间标注。");
				return result;
			}
			const session: RecordingSession = {
				startedAt: Date.now(), startedMonotonic: performance.now(), timing: null, context: null,
				cleanup: () => { media.removeEventListener("stop", stopped); media.removeEventListener("error", failed); }
			};
			const stopped = () => this.captureStop(binding, session);
			const failed = () => {
				this.options.notify("核心录音机发生错误，无法确认本段录音时间，请检查已保存的音频。");
				this.clearSession(binding, session);
			};
			media.addEventListener("stop", stopped, { once: true });
			media.addEventListener("error", failed, { once: true });
			binding.session = session;
			if (this.options.onSessionStart) session.catalogId = this.options.onSessionStart(session.startedAt).catch(() => { this.options.notify("录音已经开始，会议身份登记失败，请在保存后检查维护提示。"); return null; });
			return result;
		});
		this.wrap(binding, "onStopRecording", (...args: unknown[]) => {
			const session = binding.session;
			if (session?.context) return;
			const endedAt = Date.now();
			const endedMonotonic = performance.now();
			const result: unknown = originalStop.apply(recorder, args);
			if (session) this.captureStop(binding, session, endedAt, endedMonotonic);
			return result;
		});
	}

	private captureStop(binding: RecorderBinding, session: RecordingSession, endedAt = Date.now(), endedMonotonic = performance.now()): void {
		if (this.disposed || this.binding !== binding || session.context) return;
		session.context = this.captureContext();
		const timing = { startedAt: session.startedAt, endedAt, durationMs: endedMonotonic - session.startedMonotonic };
		if (formatRecordingSessionTiming(timing)) session.timing = timing;
		else this.options.notify("系统时间发生变化或录音计时异常，已跳过时间标注；录音仍会保存。");
	}

	private captureContext(): SaveContext {
		const file = this.options.app.workspace.getActiveFile();
		return {
			source: file?.extension === "md" ? file : null,
			settings: { ...this.options.getSettings() }
		};
	}

	private clearSession(binding: RecorderBinding, session: RecordingSession): void {
		session.cleanup();
		if (!session.catalogInterruptionScheduled && !session.catalogSaved && session.catalogId && this.options.onSessionInterrupted) {
			session.catalogInterruptionScheduled = true;
			void (session.saving ?? Promise.resolve()).catch(() => undefined).then(async () => {
				if (session.catalogSaved) return;
				const id = await session.catalogId;
				if (id && !session.catalogSaved) await this.options.onSessionInterrupted?.(id);
			}).catch(() => { this.options.notify("录音中断状态登记失败，请检查会议维护提示。"); });
		}
		if (binding.session === session) binding.session = null;
	}

	private restoreMethods(binding: RecorderBinding, methods: RecorderBinding["methods"]): void {
		for (const method of [...methods].reverse()) {
			if (binding.recorder[method.key] !== method.wrapped) continue;
			if (method.owned) Reflect.set(binding.recorder, method.key, method.original);
			else Reflect.deleteProperty(binding.recorder, method.key);
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const pending of this.pendingSources.values()) pending.finish(null);
		this.pendingSources.clear();
		this.restore();
	}

	private restore(): void {
		const binding = this.binding;
		if (binding) {
			if (binding.session) this.clearSession(binding, binding.session);
			// The in-flight native onStartRecording calls this.startRecording after permission resolves.
			// Keep that one guard until the pending start settles so a late stream cannot escape unload.
			const methods = binding.starting ? binding.methods.filter((method) => method.key !== "startRecording") : binding.methods;
			this.restoreMethods(binding, methods);
		}
		this.binding = null;
	}

	private async save(recorder: CoreRecorder, original: CoreRecorder["saveRecording"], data: ArrayBuffer, session: RecordingSession | null): Promise<unknown> {
		const { app, storage, notify } = this.options;
		const { source, settings } = session?.context ?? this.captureContext();
		const sourcePath = source?.path ?? "";
		const extension = recorder.extension;
		let pendingPath: string | undefined;
		let finishSource: ((source: TFile | null) => void) | undefined;
		const create = (saveSettings: RecordingStorageSettings, name: string) => storage.create(
			{ settings: saveSettings, sourcePath, name, extension },
			async (path) => {
				// Register before createBinary emits the event, then release after the source block is inserted.
				const promise = new Promise<TFile | null>((resolve) => { finishSource = resolve; });
				pendingPath = path;
				this.pendingSources.set(path, { promise, finish: finishSource! });
				try {
					return await app.vault.createBinary(path, data);
				} catch (error) {
					finishSource?.(null);
					this.pendingSources.delete(path);
					throw error;
				}
			}
		);
		let file: TFile;
		try {
			const date = new Date();
			const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
			const name = `Recording ${settings.strategy === "obsidian" ? timestamp.replace(" ", "") : timestamp}`;
			try {
				file = await create(settings, name);
			} catch (error) {
				if (!session || settings.strategy === "obsidian" || error instanceof RecordingMayExistError) throw error;
				file = await create({ ...settings, strategy: "obsidian" }, name);
				notify(`自定义录音目录保存失败，已回退 Obsidian 附件规则：${file.path}`);
			}
		} catch (error) {
			if (error instanceof RecordingMayExistError) {
				notify(`录音创建时发生错误，${error.path} 可能已保存；为避免重复保存，请先检查该文件是否存在且完整。`);
				return;
			}
			return this.fallback(recorder, original, data, session);
		}
		try {
			if (this.options.onSessionSaved) {
				try { await this.options.onSessionSaved(await session?.catalogId ?? null, file, session?.timing ?? null); if (session) session.catalogSaved = true; }
				catch { notify("录音已保存，会议来源登记失败，请检查维护提示后重试登记。"); }
			}
			if (this.disposed) return file;
			if (source && source.extension === "md") {
				if (app.vault.getAbstractFileByPath(source.path) !== source) throw new Error("来源笔记已不存在。");
				const link = app.fileManager.generateMarkdownLink(file, source.path);
				const embed = link.startsWith("!") ? link : `!${link}`;
				const time = session?.timing ? formatRecordingSessionTiming(session.timing) : null;
				const block = `${time ? `${time}\n` : ""}${embed}\n`;
				const view = this.options.getView();
				if (view?.file === source && app.workspace.getActiveFile() === source) {
					view.editor.replaceRange(`\n${block}`, view.editor.getCursor());
				} else {
					await app.vault.process(source, (content) => `${content}\n${block}`);
					if (session) notify("录音及时间已追加到停止录音时的笔记末尾。");
				}
				finishSource?.(source);
			} else {
				await app.workspace.getLeaf(false).openFile(file);
			}
		} catch {
			notify(`录音已保存至 ${file.path}，但链接插入或打开失败，请从文件列表打开录音。`);
		} finally {
			finishSource?.(null);
			if (pendingPath) this.pendingSources.delete(pendingPath);
		}
		return file;
	}

	private fallback(recorder: CoreRecorder, original: CoreRecorder["saveRecording"], data: ArrayBuffer, session: RecordingSession | null, showFallbackNotice = true): Promise<unknown> {
		const operation = this.nativeSaveQueue.then(() => this.performNativeSave(recorder, original, data, session, showFallbackNotice));
		this.nativeSaveQueue = operation.catch(() => undefined);
		return operation;
	}

	private async performNativeSave(recorder: CoreRecorder, original: CoreRecorder["saveRecording"], data: ArrayBuffer, session: RecordingSession | null, showFallbackNotice: boolean): Promise<unknown> {
		const { app, notify } = this.options;
		const source = session?.context?.source ?? this.captureContext().source;
		const scope = { paths: new Set<string>(), extension: recorder.extension };
		this.nativeSaveScope = scope;
		const candidates: TFile[] = [];
		const ref = app.vault.on("create", (file) => {
			const created = app.vault.getFileByPath(file.path);
			if (created?.extension === recorder.extension) {
				candidates.push(created);
				void this.getPendingSource(created.path);
			}
		});
		let result: unknown;
		let nativeError: unknown;
		try {
			try { result = await original.call(recorder, data); }
			catch (error) {
				nativeError = error;
				notify("原生录音保存流程未完成，请检查已创建的文件和附件链接。文件会保留。");
			} finally { app.vault.offref(ref); }
			const matches: TFile[] = [];
			for (const candidate of candidates) {
				try {
					const bytes = new Uint8Array(await app.vault.readBinary(candidate));
					const expected = new Uint8Array(data);
					if (bytes.length === expected.length && bytes.every((byte, index) => byte === expected[index])) matches.push(candidate);
				} catch { /* A moved/deleted file cannot be safely attributed to this save. */ }
			}
			if (matches.length === 1) {
				const file = matches[0];
				if (this.options.onSessionSaved) {
					try {
						await this.options.onSessionSaved(await session?.catalogId ?? null, file, session?.timing ?? null);
						if (session) session.catalogSaved = true;
					} catch { notify("录音已保存，会议来源登记失败，请检查维护提示后重试登记。"); }
				}
				this.pendingSources.get(file.path)?.finish(source && app.vault.getAbstractFileByPath(source.path) === source ? source : null);
				if (showFallbackNotice) notify(`自定义录音目录保存失败，已回退 Obsidian 原生保存：${file.path}`);
			} else if (showFallbackNotice || this.options.onSessionSaved) {
				notify("已调用 Obsidian 原生保存，无法唯一确认本次录音位置。请检查原生插入的链接或打开的音频，并在会议维护入口登记来源。");
			}
			if (nativeError) throw nativeError instanceof Error ? nativeError : new Error(typeof nativeError === "string" ? nativeError : "原生录音保存失败。");
			return result;
		} finally {
			app.vault.offref(ref);
			if (this.nativeSaveScope === scope) this.nativeSaveScope = null;
			for (const path of scope.paths) {
				this.pendingSources.get(path)?.finish(null);
				this.pendingSources.delete(path);
			}
		}
	}
}

import type { App, TFile } from "obsidian";
import type { RecordingStorageSettings } from "../settings/settings";
import { resolveRecordingFolder, validateRecordingFolder, validateRecordingStorage } from "./recording-storage-path";

export interface RecordingStorageRequest {
	settings: RecordingStorageSettings;
	sourcePath: string;
	name: string;
	extension: string;
}

export class RecordingMayExistError extends Error {
	constructor(readonly path: string, cause: unknown) {
		super(`录音路径已出现文件：${path}`, { cause });
	}
}

export class RecordingStorageService {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private app: App, private ensureFolder: (path: string) => Promise<void>) {}

	validate(settings: RecordingStorageSettings, sourcePath: string): string | null {
		const error = validateRecordingStorage(settings);
		if (error) return error;
		const folder = resolveRecordingFolder(settings, sourcePath);
		if (folder) {
			const pathError = validateRecordingFolder(folder);
			if (pathError) return pathError;
			const configDir = this.app.vault.configDir.toLowerCase();
			if (folder.toLowerCase() === configDir || folder.toLowerCase().startsWith(`${configDir}/`)) return "录音不能保存到 Obsidian 配置目录。";
		}
		return null;
	}

	/** 路径选择和实际创建共用队列，不能向调用者返回未预留的路径。 */
	create<T>(request: RecordingStorageRequest, create: (path: string) => Promise<T>): Promise<T> {
		const frozen = { ...request, settings: { ...request.settings } };
		const operation = this.queue.then(async () => {
			const settingsError = this.validate(frozen.settings, frozen.sourcePath);
			if (settingsError) throw new Error(settingsError);
			const folder = resolveRecordingFolder(frozen.settings, frozen.sourcePath);
			if (!/^[a-z\d]+$/i.test(frozen.extension) || /[/\\]/.test(frozen.name) || !frozen.name) throw new Error("录音文件名或扩展名无效。");
			const filename = `${frozen.name}.${frozen.extension}`;
			const initialPath = folder === null
				? await this.app.fileManager.getAvailablePathForAttachment(filename, frozen.sourcePath || undefined)
				: (folder ? `${folder}/${filename}` : filename);
			const pathError = validateRecordingFolder(initialPath);
			if (pathError) throw new Error(pathError);
			const configDir = this.app.vault.configDir.toLowerCase();
			if (initialPath.toLowerCase() === configDir || initialPath.toLowerCase().startsWith(`${configDir}/`)) throw new Error("录音不能保存到 Obsidian 配置目录。");
			const parent = initialPath.includes("/") ? initialPath.slice(0, initialPath.lastIndexOf("/")) : "";
			await this.ensureFolder(parent);
			const stem = initialPath.slice(0, -(frozen.extension.length + 1));
			let index = 0;
			let path = initialPath;
			while (this.app.vault.getAbstractFileByPath(path) || await this.app.vault.adapter.exists(path)) {
				path = `${stem} ${++index}.${frozen.extension}`;
			}
			// Vault.createBinary 自身拒绝已存在文件，外部创建竞争不会覆盖文件。
			try {
				return await create(path);
			} catch (error) {
				// 创建 API 可能写入后才报告错误；保守保留文件，禁止再次保存同一录音。
				let mayExist = true;
				try {
					mayExist = Boolean(this.app.vault.getAbstractFileByPath(path)) || await this.app.vault.adapter.exists(path);
				} catch { /* 存储状态无法确认时，禁止回退再次创建。 */ }
				if (mayExist) throw new RecordingMayExistError(path, error);
				throw error;
			}
		});
		this.queue = operation.catch(() => undefined);
		return operation;
	}

	createBinary(request: RecordingStorageRequest, data: ArrayBuffer): Promise<TFile> {
		return this.create(request, (path) => this.app.vault.createBinary(path, data));
	}
}

import { App, normalizePath, TFolder } from "obsidian";

export class FileService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async ensureFolder(folderPath: string): Promise<void> {
		const normalized = normalizePath(folderPath);
		if (!normalized || normalized === "/") {
			return;
		}

		const parts = normalized.split("/").filter(Boolean);
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(currentPath);
			if (existing instanceof TFolder) {
				continue;
			}
			if (existing) {
				throw new Error(`无法创建文件夹，路径已被文件占用：${currentPath}`);
			}
			try {
				await this.app.vault.createFolder(currentPath);
			} catch (error) {
				const createdByConcurrentTask = this.app.vault.getAbstractFileByPath(currentPath);
				if (createdByConcurrentTask instanceof TFolder) {
					continue;
				}
				throw error;
			}
		}
	}
}

export function getParentPath(path: string): string {
	const index = path.lastIndexOf("/");
	return index === -1 ? "" : path.slice(0, index);
}

export function getBaseName(path: string): string {
	const name = path.split("/").pop() ?? path;
	const dotIndex = name.lastIndexOf(".");
	return dotIndex === -1 ? name : name.slice(0, dotIndex);
}

export function stripMarkdownExtension(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}

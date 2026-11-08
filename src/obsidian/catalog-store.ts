import { App, TFile, TFolder, parseYaml, stringifyYaml } from "obsidian";
import { CatalogRepository } from "../catalog/catalog-repository";
import { normalizeCatalogPath } from "../catalog/catalog-paths";
import type { CatalogRepositoryOptions, CatalogStorage } from "../catalog/catalog-types";
import { FileService, getParentPath } from "./file-service";

export function createObsidianCatalogStorage(app: App): CatalogStorage {
	const files = new FileService(app);
	const safePath = (path: string): string => {
		const normalized = normalizeCatalogPath(path);
		const config = app.vault.configDir.toLocaleLowerCase();
		if (normalized.toLocaleLowerCase() === config || normalized.toLocaleLowerCase().startsWith(`${config}/`)) throw new Error("资料登记不能访问 Obsidian 配置目录。");
		return normalized;
	};
	const read = async (path: string): Promise<string | null> => {
		const file = app.vault.getAbstractFileByPath(safePath(path));
		if (file === null) return null;
		if (!(file instanceof TFile)) throw new Error("资料路径被文件夹占用。");
		return app.vault.read(file);
	};
	return {
		read,
		async updateProperties(path, changes) {
			const file = app.vault.getAbstractFileByPath(safePath(path));
			if (!(file instanceof TFile)) throw new Error("资料记录缺失，请刷新后重试。");
			await app.fileManager.processFrontMatter(file, (frontmatter) => {
				const properties = frontmatter as Record<string, unknown>;
				for (const [key, value] of Object.entries(changes)) {
					if (value === undefined) delete properties[key];
					else properties[key] = value;
				}
			});
		},
		ensureFolder: (folder) => files.ensureFolder(safePath(folder)),
		async list(folder) {
			const entry = app.vault.getAbstractFileByPath(safePath(folder));
			if (entry === null) return [];
			if (!(entry instanceof TFolder)) throw new Error("资料目录被文件占用。");
			const result: string[] = [];
			const visit = (current: TFolder): void => {
				for (const child of current.children) {
					if (child instanceof TFolder) visit(child);
					else if (child instanceof TFile) result.push(child.path);
				}
			};
			visit(entry);
			return result.sort();
		},
		async create(path, content) {
			const normalized = safePath(path);
			await files.ensureFolder(getParentPath(normalized));
			await app.vault.create(normalized, content);
		},
		async write(path, content) {
			const normalized = safePath(path);
			const existing = app.vault.getAbstractFileByPath(normalized);
			if (existing instanceof TFile) await app.vault.process(existing, () => content);
			else if (existing) throw new Error("资料路径被文件夹占用。");
			else {
				await files.ensureFolder(getParentPath(normalized));
				await app.vault.create(normalized, content);
			}
		},
		async process(path, update) {
			const existing = app.vault.getAbstractFileByPath(safePath(path));
			if (!(existing instanceof TFile)) throw new Error("资料记录缺失，请刷新后重试。");
			return app.vault.process(existing, update);
		},
		async remove(path) {
			const existing = app.vault.getAbstractFileByPath(safePath(path));
			if (existing instanceof TFile) await app.fileManager.trashFile(existing);
			else if (existing) throw new Error("不能删除资料目录。");
		}
	};
}

export function createObsidianCatalogRepository(app: App, options: Omit<CatalogRepositoryOptions, "storage" | "yaml">): CatalogRepository {
	return new CatalogRepository({ ...options, storage: createObsidianCatalogStorage(app), yaml: { parse: (source) => parseYaml(source) as unknown, stringify: stringifyYaml } });
}

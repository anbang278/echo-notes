import { buildMemoryPaths, normalizeMemoryRoot } from "../memory/memory-paths";
import type { CatalogPaths, CatalogRepositoryOptions } from "./catalog-types";

export function normalizeCatalogPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
	if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === ".." || part.includes("\0"))) {
		throw new Error("资料路径必须是 Vault 内的相对路径。");
	}
	return normalized;
}

export function buildCatalogPaths(options: Pick<CatalogRepositoryOptions, "rootFolder" | "language" | "paths">): CatalogPaths {
	const rootFolder = normalizeMemoryRoot(options.rootFolder);
	const memory = options.paths ?? buildMemoryPaths(rootFolder, options.language);
	const paths: CatalogPaths = {
		rootFolder,
		meetingsDir: memory.meetingsDir,
		projectsDir: memory.projectsDir,
		questionsDir: `${rootFolder}/${options.language === "en" ? "08 Questions" : "08 问题"}`,
		evidenceDir: `${memory.contextPackagesDir}/${options.language === "en" ? "Question Evidence" : "问题证据"}`,
		systemDir: memory.systemDir,
		registry: `${memory.systemDir}/catalog-v1/registry.json`,
		migrationDir: `${memory.systemDir}/catalog-v1/migrations`,
		memory
	};
	for (const [key, value] of Object.entries(paths)) if (key !== "memory") normalizeCatalogPath(value as string);
	return paths;
}

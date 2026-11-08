import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { AgentMemoryError, type AgentMemoryStorage } from "../agent-memory-types";
import { normalizeAgentPath } from "../agent-memory-utils";

/** Node-only adapter. Plugin runtime imports the portable publisher instead. */
export class NodeAgentMemoryStorage implements AgentMemoryStorage {
	private constructor(readonly root: string) {}

	static async open(root: string): Promise<NodeAgentMemoryStorage> {
		try {
			const canonical = await realpath(path.resolve(root));
			if (!(await lstat(canonical)).isDirectory()) throw new Error("directory required");
			return new NodeAgentMemoryStorage(canonical);
		} catch {
			throw new AgentMemoryError("VAULT_UNREACHABLE", "The configured Vault directory is unavailable. Reconnect the correct local Vault.");
		}
	}

	async read(relative: string): Promise<string | null> {
		const target = await this.target(relative, false);
		if (target === null) return null;
		try {
			const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await file.stat();
				if (!stat.isFile() || stat.size > 128 * 1024 * 1024) throw new AgentMemoryError("ACCESS_DENIED", "A registered dependency is not a supported ordinary text file.", relative);
				return await file.readFile("utf8");
			} finally {
				await file.close();
			}
		} catch (error) {
			if (hasCode(error, "ENOENT")) return null;
			if (error instanceof AgentMemoryError) throw error;
			throw new AgentMemoryError("VAULT_UNREACHABLE", "A registered file cannot be read. Check its permissions.", relative);
		}
	}

	async write(relative: string, content: string, options?: { exclusive?: boolean }): Promise<void> {
		const normalized = this.allowedRelative(relative);
		await this.assertNoSymlinks(normalized);
		const candidate = path.resolve(this.root, normalized);
		await this.checkParent(path.dirname(candidate));
		await mkdir(path.dirname(candidate), { recursive: true });
		const target = await this.target(normalized, true);
		if (!target) throw new AgentMemoryError("VAULT_UNREACHABLE", "The output path cannot be resolved.", relative);
		if (options?.exclusive) {
			await writeFile(target, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			return;
		}
		const temporary = `${target}.${globalThis.crypto.randomUUID()}.tmp`;
		try {
			await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
			await rename(temporary, target);
		} finally {
			await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
		}
	}

	async list(relative: string): Promise<string[]> {
		const normalized = this.allowedRelative(relative);
		const start = await this.target(normalized, false);
		if (start === null) return [];
		const result: string[] = [];
		const visit = async (directory: string, depth: number): Promise<void> => {
			if (depth > 64 || result.length > 100_000) throw new AgentMemoryError("INDEX_INCOMPLETE", "The registered directory exceeds the bounded reader limit.", relative);
			let entries;
			try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
				if (hasCode(error, "ENOENT")) return;
				throw new AgentMemoryError("VAULT_UNREACHABLE", "A registered directory cannot be enumerated.", relative);
			}
			for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
				const candidate = path.join(directory, entry.name);
				const item = path.relative(this.root, candidate).split(path.sep).join("/");
				if (entry.name === ".obsidian" || entry.name === ".git") continue;
				const safe = await this.target(item, false);
				if (safe === null) continue;
				if (entry.isSymbolicLink()) {
					if ((await lstat(safe)).isDirectory()) throw new AgentMemoryError("ACCESS_DENIED", "Directory symlinks are excluded from registered scope enumeration.", item);
					result.push(item);
				} else if (entry.isDirectory()) {
					await visit(safe, depth + 1);
				} else if (entry.isFile()) {
					result.push(item);
				}
			}
		};
		if (!(await lstat(start)).isDirectory()) return [normalized];
		await visit(start, 0);
		return result.sort();
	}

	private allowedRelative(relative: string): string {
		const normalized = normalizeAgentPath(relative);
		if (normalized.split("/").some((part) => part === ".obsidian" || part === ".git")) throw new AgentMemoryError("ACCESS_DENIED", "Plugin configuration and repository internals are outside the business-data reader scope.");
		return normalized;
	}

	private async target(relative: string, missing: boolean): Promise<string | null> {
		const normalized = this.allowedRelative(relative);
		await this.assertNoSymlinks(normalized);
		const target = path.resolve(this.root, normalized);
		try {
			const resolved = await realpath(target);
			this.assertInside(resolved);
			this.allowedRelative(path.relative(this.root, resolved).split(path.sep).join("/"));
			return resolved;
		} catch (error) {
			if (!hasCode(error, "ENOENT")) throw error;
			await this.checkParent(path.dirname(target));
			return missing ? target : null;
		}
	}

	private async assertNoSymlinks(relative: string): Promise<void> {
		let current = this.root;
		for (const part of relative.split("/")) {
			current = path.join(current, part);
			try {
				if ((await lstat(current)).isSymbolicLink()) throw new AgentMemoryError("ACCESS_DENIED", "Business-data paths containing symlinks are outside the reader scope.", relative);
			} catch (error) {
				if (hasCode(error, "ENOENT")) return;
				throw error;
			}
		}
	}

	private async checkParent(directory: string): Promise<void> {
		let current = directory;
		while (current !== this.root) {
			try {
				this.assertInside(await realpath(current));
				return;
			} catch (error) {
				if (!hasCode(error, "ENOENT")) throw error;
				current = path.dirname(current);
			}
		}
		this.assertInside(current);
	}

	private assertInside(target: string): void {
		const relative = path.relative(this.root, target);
		if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new AgentMemoryError("ACCESS_DENIED", "A registered path resolves outside its canonical Vault root.");
	}
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

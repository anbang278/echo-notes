import { identifyAsrInstallations, type AsrDiscoveryCandidate, type AsrDiscoveryFile } from "./discovery-rules";

export const ASR_SCAN_LIMITS = Object.freeze({ depth: 3, entries: 1000, fileBytes: 256 * 1024, totalBytes: 2 * 1024 * 1024, milliseconds: 5000 });
export interface AsrDiscoveryResult { root: string; candidates: AsrDiscoveryCandidate[]; issues: string[]; entries: number; bytes: number }
export interface AsrDirectoryPage { path: string; parent: string; directories: string[]; nextCursor?: number; limited: boolean }
export interface DesktopAsrDiscovery {
	readonly home: string;
	scan(root: string, baseUrl: string, signal?: AbortSignal): Promise<AsrDiscoveryResult>;
	browse(directory: string, cursor?: number, signal?: AbortSignal): Promise<AsrDirectoryPage>;
}
export interface DiscoveryRuntime { require(name: string): unknown; schedule?(action: () => void, milliseconds: number): () => void }
const SKIP = new Set([".git", ".hg", ".svn", ".venv", "venv", "env", "node_modules", "models", "model", "cache", "caches", ".cache", "logs", "log", "__pycache__", "dist", "backups"]);
const READABLE = /^(?:(?:readme|deployment)(?:\.[\w-]+)*\.(?:md|txt)|(?:bundle-|service-|model-)?manifest\.json|control\.py|service\.py|[\w .-]+\.(?:sh|cmd|bat|ps1))$/i;

/** A separate, read-only desktop boundary. No process, network, Vault or model loading APIs. */
export function createDesktopAsrDiscovery(
	injectedRuntime?: DiscoveryRuntime, limits: typeof ASR_SCAN_LIMITS = ASR_SCAN_LIMITS
): DesktopAsrDiscovery {
	const runtime: Partial<DiscoveryRuntime> | undefined = injectedRuntime ?? (typeof window !== "undefined" ? window : undefined);
	if (typeof runtime?.require !== "function") throw new Error("当前设备不支持本地目录识别。" );
	const fs = runtime.require("fs") as typeof import("fs");
	const paths = runtime.require("path") as typeof import("path");
	const os = runtime.require("os") as typeof import("os");
	const crypto = runtime.require("crypto") as typeof import("crypto");
	const home = os.homedir();
	const normalize = (value: string): string => {
		const text = value.trim();
		if (!text || [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("请填写有效的安装目录绝对路径。" );
		const expanded = text === "~" ? home : text.startsWith(`~${paths.sep}`) ? paths.join(home, text.slice(2)) : text;
		if (!paths.isAbsolute(expanded)) throw new Error("请填写安装目录的绝对路径。" );
		return paths.resolve(expanded);
	};
	const cancelled = (): Error => { const error = new Error("目录识别已取消。" ); error.name = "AbortError"; return error; };
	const contained = (root: string, file: string): boolean => {
		const relative = paths.relative(root, file);
		return !paths.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${paths.sep}`);
	};
	const safeDirectory = async (root: string, directory: string): Promise<void> => {
		if (!contained(root, directory) || await fs.promises.realpath(directory) !== directory || !(await fs.promises.lstat(directory)).isDirectory()) throw new Error("目录位置已变化，请重新选择安装目录。" );
	};
	const isPythonPresent = async (directory: string): Promise<boolean> => {
		try {
			for (const part of [paths.join(directory, ".venv"), paths.join(directory, ".venv", "bin")]) {
				if (!(await fs.promises.lstat(part)).isDirectory()) return false;
			}
			// The sole link-following exception checks interpreter availability, never reads it.
			const python = paths.join(directory, ".venv", "bin", "python");
			const stat = await fs.promises.stat(python);
			return stat.isFile() && Boolean(stat.mode & 0o111);
		} catch { return false; }
	};
	return {
		home,
		async scan(requested, baseUrl, signal) {
			const files: AsrDiscoveryFile[] = [];
			const pythonDirectories: string[] = [];
			const issues = new Set<string>();
			let root = normalize(requested), entries = 0, bytes = 0, expired = false;
			const deadline = Date.now() + limits.milliseconds;
			const guard = (): void => {
				if (signal?.aborted) throw cancelled();
				if (expired || Date.now() >= deadline) { expired = true; throw new Error("deadline"); }
			};
			const read = async (file: string, directory: string, name: string): Promise<void> => {
				guard();
				if (!contained(root, file) || await fs.promises.realpath(file) !== file) return;
				guard();
				const handle = await fs.promises.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
				try {
					guard();
					const initial = await handle.stat();
					const live = await fs.promises.lstat(file);
					if (!initial.isFile() || !live.isFile() || initial.ino !== live.ino || initial.dev !== live.dev || await fs.promises.realpath(file) !== file) return;
					if (initial.size > limits.fileBytes) { issues.add("部分文本文件超过读取上限，已跳过。" ); return; }
					if (bytes + initial.size > limits.totalBytes) { issues.add("已达到累计读取上限，结果可能不完整。" ); return; }
					guard(); bytes += initial.size;
					const buffer = new Uint8Array(initial.size);
					const result = await handle.read(buffer, 0, buffer.length, 0);
					guard();
					const after = await handle.stat();
					if (result.bytesRead !== initial.size || after.size !== initial.size || after.mtimeMs !== initial.mtimeMs || buffer.includes(0)) { issues.add("部分文件在读取时发生变化或不是文本，已跳过。" ); return; }
					guard();
					files.push({ name, directory, relative: paths.relative(root, file), text: new TextDecoder().decode(buffer), sha256: crypto.createHash("sha256").update(buffer).digest("hex") });
				} finally { await handle.close(); }
			};
			const walk = async (directory: string, depth: number): Promise<void> => {
				guard(); await safeDirectory(root, directory); guard();
				const dir = await fs.promises.opendir(directory);
				try {
					guard(); await safeDirectory(root, directory);
					while (entries < limits.entries) {
						guard(); await safeDirectory(root, directory); guard();
						const entry = await dir.read(); guard(); if (!entry) return;
						entries++;
						if (entry.isSymbolicLink()) continue;
						const file = paths.join(directory, entry.name);
						try {
							if (entry.isDirectory() && !entry.name.startsWith(".") && !SKIP.has(entry.name.toLowerCase())) {
								if (depth < limits.depth) await walk(file, depth + 1);
								else issues.add("已达到目录检索深度，结果可能不完整。" );
							} else if (entry.isFile() && READABLE.test(entry.name)) await read(file, directory, entry.name);
						} catch (error) {
							guard();
							if (error instanceof Error && error.name === "AbortError") throw error;
							issues.add("部分文件或子目录无法读取，请检查权限或缩小目录范围。" );
						}
					}
					issues.add("已达到目录项检索上限，结果可能不完整。" );
				} finally { await dir.close(); }
			};
			const run = async (): Promise<void> => {
				guard(); root = await fs.promises.realpath(root); guard();
				await walk(root, 0);
				for (const directory of new Set(files.filter(file => file.name === "control.py").map(file => file.directory))) {
					guard(); await safeDirectory(root, directory);
					if (await isPythonPresent(directory)) { guard(); pythonDirectories.push(directory); }
				}
			};
			let clearDeadline = (): void => {};
			let abort: (() => void) | undefined;
			try {
				await Promise.race([
					run(),
					new Promise<void>((resolve, reject) => {
						const timeout = (): void => { expired = true; issues.add("已达到五秒检索时限，结果可能不完整。" ); resolve(); };
						if (typeof window !== "undefined") { const timer = window.setTimeout(timeout, limits.milliseconds); clearDeadline = () => window.clearTimeout(timer); }
						else if (injectedRuntime?.schedule) clearDeadline = injectedRuntime.schedule(timeout, limits.milliseconds);
						else throw new Error("当前设备不支持目录识别计时器。" );
						abort = () => reject(cancelled()); signal?.addEventListener("abort", abort, { once: true });
					})
				]);
			} catch (error) {
				if (signal?.aborted || error instanceof Error && error.name === "AbortError") throw cancelled();
				if (expired) issues.add("已达到五秒检索时限，结果可能不完整。" );
				else if (!entries) throw new Error("无法读取安装目录，请检查路径与权限。", { cause: error });
				else issues.add("部分目录无法读取，结果可能不完整。" );
			} finally { clearDeadline(); if (abort) signal?.removeEventListener("abort", abort); }
			if (signal?.aborted) throw cancelled();
			return { root, candidates: identifyAsrInstallations({ files: [...files], pythonDirectories: [...pythonDirectories] }, { baseUrl, platform: os.platform(), arch: os.arch() }), issues: [...issues], entries, bytes };
		},
		async browse(requested, cursor = 0, signal) {
			const directory = await fs.promises.realpath(normalize(requested));
			if (signal?.aborted) throw cancelled();
			const dir = await fs.promises.opendir(directory);
			const directories: string[] = [];
			let visited = 0, nextCursor: number | undefined, limited: boolean;
			const deadline = Date.now() + limits.milliseconds;
			try {
				while (visited < limits.entries && Date.now() < deadline) {
					if (signal?.aborted) throw cancelled();
					const item = await dir.read(); if (!item) break;
					visited++;
					if (visited <= cursor) continue;
					if (item.isDirectory() && !item.isSymbolicLink()) directories.push(paths.join(directory, item.name));
					if (directories.length >= 100) { nextCursor = visited; break; }
				}
				limited = visited >= limits.entries || Date.now() >= deadline;
			} finally { await dir.close(); }
			if (signal?.aborted) throw cancelled();
			return { path: directory, parent: paths.dirname(directory), directories: directories.sort(), nextCursor, limited };
		}
	};
}

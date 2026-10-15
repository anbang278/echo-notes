import type { App } from "obsidian";
import { TranscriptionError } from "../providers/transcription-provider";
import { LOCAL_UPLOAD_CHUNK_BYTES } from "./local-http";

export interface LocalDesktopFiles {
	openVaultFile(audioPath: string): Promise<LocalVaultFileHandle>;
	vaultRoot(): string;
}

export interface LocalVaultFileHandle {
	path: string;
	size(): Promise<number>;
	mtimeMs(): Promise<number>;
	/** Identity also detects replacement or same-size rewrites. */
	identity(): Promise<string>;
	readRange(start: number, length: number): Promise<Uint8Array>;
	close(): Promise<void>;
}

export interface LocalSourceIdentity {
	sourceSize: number;
	sourceMtimeMs: number;
	sourceIdentity: string;
}

export async function captureLocalSource(handle: LocalVaultFileHandle): Promise<LocalSourceIdentity> {
	const sourceIdentity = await handle.identity();
	const sourceSize = await handle.size();
	const sourceMtimeMs = await handle.mtimeMs();
	if (!Number.isSafeInteger(sourceSize) || sourceSize <= 0) {
		throw new TranscriptionError("unsupported_audio", "音频文件为空或大小无效。");
	}
	const source = { sourceSize, sourceMtimeMs, sourceIdentity };
	await verifyLocalSource(handle, source);
	return source;
}

export async function verifyLocalSource(handle: LocalVaultFileHandle, source: LocalSourceIdentity): Promise<void> {
	if (await handle.identity() !== source.sourceIdentity || await handle.size() !== source.sourceSize
		|| await handle.mtimeMs() !== source.sourceMtimeMs) {
		throw new TranscriptionError("source_changed", "音频文件已发生变化，请重新发起转写。");
	}
}

/** File reads are bounded and the open descriptor is checked against the live Vault path. */
export async function createDesktopFiles(app: App): Promise<LocalDesktopFiles | null> {
	const runtime = typeof window === "undefined" ? undefined : window as unknown as { require?: (name: string) => unknown };
	if (typeof runtime?.require !== "function") return null;
	const adapter = app.vault.adapter as unknown as { getFullPath?: (path: string) => string; getBasePath?: () => string };
	if (typeof adapter.getFullPath !== "function" || typeof adapter.getBasePath !== "function") return null;
	let fs: typeof import("fs");
	let paths: typeof import("path");
	try {
		fs = runtime.require("fs") as typeof import("fs");
		paths = runtime.require("path") as typeof import("path");
	} catch { return null; }
	if (!fs?.promises?.open) return null;
	const vaultRoot = adapter.getBasePath();
	return {
		vaultRoot: () => vaultRoot,
		async openVaultFile(audioPath) {
			const requestedPath = adapter.getFullPath!(audioPath);
			const root = await fs.promises.realpath(vaultRoot);
			const real = await fs.promises.realpath(requestedPath);
			const relative = paths.relative(root, real);
			if (!relative || relative === ".." || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) {
				throw new TranscriptionError("unsupported_audio", "音频文件不在当前 Vault 内，拒绝读取。");
			}
			const descriptor = await fs.promises.open(real, "r");
			const statIdentity = (stat: import("fs").Stats) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
			try {
				const initial = await descriptor.stat();
				if (!initial.isFile()) throw new TranscriptionError("unsupported_audio", "音频来源必须是普通文件。");
				const identity = async () => {
					const livePath = await fs.promises.realpath(requestedPath);
					const stat = await descriptor.stat();
					const pathStat = await fs.promises.stat(requestedPath);
					if (livePath !== real || statIdentity(stat) !== statIdentity(pathStat)) {
						throw new TranscriptionError("source_changed", "音频来源已被替换，请重新发起转写。");
					}
					return statIdentity(stat);
				};
				const initialIdentity = await identity();
				return {
					path: real,
					async size() { return (await descriptor.stat()).size; },
					async mtimeMs() { return (await descriptor.stat()).mtimeMs; },
					identity,
					async readRange(start, length) {
						if (!Number.isSafeInteger(start) || start < 0 || !Number.isInteger(length) || length <= 0 || length > LOCAL_UPLOAD_CHUNK_BYTES) {
							throw new TranscriptionError("unsupported_audio", "音频读取范围无效。");
						}
						if (await identity() !== initialIdentity) throw new TranscriptionError("source_changed", "音频文件在上传期间被修改。");
						const buffer = new Uint8Array(length);
						const { bytesRead } = await descriptor.read(buffer, 0, length, start);
						if (bytesRead !== length || await identity() !== initialIdentity) {
							throw new TranscriptionError("source_changed", "音频读取不完整或文件已变化。");
						}
						return buffer;
					},
					async close() { await descriptor.close(); }
				};
			} catch (error) { await descriptor.close(); throw error; }
		}
	};
}

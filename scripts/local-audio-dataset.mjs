import { createHash } from "node:crypto";
import { constants, realpathSync } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const LOCAL_AUDIO_DATASET_RELATIVE_PATH = ".local-test-data/audio";
export const LOCAL_AUDIO_DATASET_SCHEMA_VERSION = 1;
export const PROTECTED_VAULT_DIRS_ENV = "ECHO_NOTES_PROTECTED_VAULT_DIRS";

const defaultProtectedVault = path.resolve(os.homedir(), "笔记", "lifeos-obsidian");
const audioMimeTypePattern = /^audio\/[!#$%&'*+\-.^_`|~A-Za-z0-9]+$/;
const manifestMaxBytes = 1024 * 1024;
const noFollowFlag = constants.O_NOFOLLOW ?? 0;

export function resolveLocalAudioDatasetRoot(projectRoot = process.cwd()) {
	const configuredRoot = process.env.ECHO_NOTES_AUDIO_DATASET_DIR?.trim();
	const root = path.resolve(projectRoot, configuredRoot || LOCAL_AUDIO_DATASET_RELATIVE_PATH);
	assertOutsideProductionVault(root);
	return root;
}

export async function loadLocalAudioDataset(options = {}) {
	const projectRoot = path.resolve(options.projectRoot ?? process.cwd());
	const root = path.resolve(options.root ?? resolveLocalAudioDatasetRoot(projectRoot));
	assertOutsideProductionVault(root);

	const rootInfo = await lstat(root).catch(() => null);
	if (!rootInfo?.isDirectory()) {
		throw new Error(`本地音频数据集不存在：${root}`);
	}
	if (rootInfo.isSymbolicLink()) {
		throw new Error(`本地音频数据集目录不能是符号链接：${root}`);
	}

	const resolvedRoot = await realpath(root);
	assertOutsideProductionVault(resolvedRoot);
	const manifestPath = path.join(resolvedRoot, "manifest.json");
	const manifest = await readManifest(resolvedRoot, manifestPath);
	validateManifest(manifest);

	const ids = new Set();
	const cases = [];
	for (const entry of manifest.cases) {
		validateCaseEntry(entry, ids);
		const { absolutePath, verifiedBytes } = await readVerifiedCase(resolvedRoot, entry);
		cases.push({ ...entry, absolutePath, verifiedBytes });
	}

	return {
		root: resolvedRoot,
		manifestPath,
		schemaVersion: manifest.schemaVersion,
		cases
	};
}
export function selectLocalAudioDatasetCases(dataset, selectors = []) {
	const normalizedSelectors = selectors.map((value) => value.trim()).filter(Boolean);
	if (normalizedSelectors.length === 0 || normalizedSelectors.includes("all")) {
		return [...dataset.cases];
	}
	const selected = dataset.cases.filter(
		(entry) =>
			normalizedSelectors.includes(entry.id) ||
			entry.tags.some((tag) => normalizedSelectors.includes(tag))
	);
	if (selected.length === 0) {
		throw new Error(`没有匹配的数据集样本：${normalizedSelectors.join(", ")}`);
	}
	return selected;
}

async function readManifest(root, manifestPath) {
	const opened = await openVerifiedRegularFile(root, manifestPath, "数据集清单");
	try {
		if (opened.info.size > manifestMaxBytes) {
			throw new Error(`本地音频数据集清单超过 ${manifestMaxBytes} 字节：${manifestPath}`);
		}
		const bytes = await opened.handle.readFile();
		const finalInfo = await opened.handle.stat();
		assertFileIdentity(opened.info, finalInfo, "数据集清单");
		if (bytes.byteLength !== finalInfo.size) {
			throw new Error(`数据集清单在读取期间发生变化：${manifestPath}`);
		}
		await verifyOpenedPath(root, manifestPath, "数据集清单", finalInfo);
		try {
			return JSON.parse(bytes.toString("utf8"));
		} catch (error) {
			throw new Error(`本地音频数据集清单不是有效 JSON：${manifestPath}`, { cause: error });
		}
	} finally {
		await opened.handle.close();
	}
}

function validateManifest(manifest) {
	if (!manifest || typeof manifest !== "object") {
		throw new Error("本地音频数据集清单必须是 JSON 对象。");
	}
	if (manifest.schemaVersion !== LOCAL_AUDIO_DATASET_SCHEMA_VERSION) {
		throw new Error(`不支持的数据集清单版本：${String(manifest.schemaVersion)}`);
	}
	if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) {
		throw new Error("本地音频数据集至少需要一个样本。");
	}
}

function validateCaseEntry(entry, ids) {
	if (!entry || typeof entry !== "object") {
		throw new Error("数据集样本必须是 JSON 对象。");
	}
	if (typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) {
		throw new Error(`数据集样本 ID 非法：${String(entry.id)}`);
	}
	if (ids.has(entry.id)) {
		throw new Error(`数据集样本 ID 重复：${entry.id}`);
	}
	ids.add(entry.id);
	if (
		typeof entry.file !== "string" ||
		!entry.file.trim() ||
		path.isAbsolute(entry.file) ||
		[...entry.file].some((character) => {
			const codePoint = character.codePointAt(0);
			return character === '"' || codePoint <= 31 || codePoint === 127;
		})
	) {
		throw new Error(`数据集样本文件名非法：${entry.id}`);
	}
	if (!Number.isInteger(entry.bytes) || entry.bytes <= 0) {
		throw new Error(`数据集样本大小非法：${entry.id}`);
	}
	if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) {
		throw new Error(`数据集样本 SHA-256 非法：${entry.id}`);
	}
	if (
		typeof entry.mimeType !== "string" ||
		/[\r\n]/.test(entry.mimeType) ||
		!audioMimeTypePattern.test(entry.mimeType)
	) {
		throw new Error(`数据集样本 MIME 类型非法：${entry.id}`);
	}
	if (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== "string" || !tag.trim())) {
		throw new Error(`数据集样本标签非法：${entry.id}`);
	}
	if (
		entry.expected !== undefined &&
		(!entry.expected || typeof entry.expected !== "object" || Array.isArray(entry.expected))
	) {
		throw new Error(`数据集样本预期条件非法：${entry.id}`);
	}
	if (
		entry.expected?.durationSeconds !== undefined &&
		(!Number.isFinite(entry.expected.durationSeconds) || entry.expected.durationSeconds <= 0)
	) {
		throw new Error(`数据集样本预期时长非法：${entry.id}`);
	}
	if (
		entry.expected?.durationToleranceSeconds !== undefined &&
		(!Number.isFinite(entry.expected.durationToleranceSeconds) ||
			entry.expected.durationToleranceSeconds < 0)
	) {
		throw new Error(`数据集样本预期时长容差非法：${entry.id}`);
	}
	if (
		entry.expected?.minimumTranscriptCharacters !== undefined &&
		(!Number.isInteger(entry.expected.minimumTranscriptCharacters) ||
			entry.expected.minimumTranscriptCharacters < 0)
	) {
		throw new Error(`数据集样本最小转写字符数非法：${entry.id}`);
	}
}

function resolveCasePath(root, relativePath) {
	const absolutePath = path.resolve(root, relativePath);
	assertPathInside(root, absolutePath, relativePath);
	return absolutePath;
}

function assertPathInside(root, candidate, label) {
	const relativePath = path.relative(root, candidate);
	if (!relativePath || isOutsideRelativePath(relativePath)) {
		throw new Error(`数据集样本路径越界：${label}`);
	}
}

function assertOutsideProductionVault(candidate) {
	const candidatePaths = getLexicalAndRealPaths(candidate);
	for (const protectedVault of getProtectedVaults()) {
		const protectedPaths = getLexicalAndRealPaths(protectedVault);
		for (const candidatePath of candidatePaths) {
			if (protectedPaths.some((protectedPath) => isPathInsideOrEqual(protectedPath, candidatePath))) {
				throw new Error("本地音频数据集不得位于受保护 Vault 中。");
			}
		}
	}
}

function getProtectedVaults() {
	const configuredVaults = process.env[PROTECTED_VAULT_DIRS_ENV]
		?.split(path.delimiter)
		.map((value) => value.trim())
		.filter(Boolean)
		.map((value) => path.resolve(value)) ?? [];
	return [defaultProtectedVault, ...configuredVaults];
}

async function readVerifiedCase(root, entry) {
	const candidatePath = resolveCasePath(root, entry.file);
	const label = `数据集样本：${entry.file}`;
	const opened = await openVerifiedRegularFile(root, candidatePath, label);

	try {
		if (opened.info.size !== entry.bytes) {
			throw new Error(`样本大小不匹配：${entry.id}，清单 ${entry.bytes}，实际 ${opened.info.size}`);
		}
		const verifiedBytes = await opened.handle.readFile();
		const finalInfo = await opened.handle.stat();
		assertFileIdentity(opened.info, finalInfo, label);
		if (finalInfo.size !== entry.bytes || verifiedBytes.byteLength !== entry.bytes) {
			throw new Error(`样本大小不匹配：${entry.id}，清单 ${entry.bytes}，实际 ${verifiedBytes.byteLength}`);
		}
		const sha256 = createHash("sha256").update(verifiedBytes).digest("hex");
		if (sha256 !== entry.sha256.toLowerCase()) {
			throw new Error(`样本 SHA-256 不匹配：${entry.id}`);
		}
		await verifyOpenedPath(root, candidatePath, label, finalInfo);
		return { absolutePath: opened.absolutePath, verifiedBytes };
	} finally {
		await opened.handle.close();
	}
}

async function openVerifiedRegularFile(root, candidatePath, label) {
	const fileInfo = await lstat(candidatePath).catch(() => null);
	if (!fileInfo?.isFile() || fileInfo.isSymbolicLink()) {
		throw new Error(`${label}必须是普通文件且不能是符号链接。`);
	}

	let handle;
	try {
		handle = await open(candidatePath, constants.O_RDONLY | noFollowFlag);
	} catch (error) {
		throw new Error(`无法安全打开${label}。`, { cause: error });
	}

	try {
		const info = await handle.stat();
		if (!info.isFile()) {
			throw new Error(`${label}必须是普通文件。`);
		}
		const absolutePath = await verifyOpenedPath(root, candidatePath, label, info);
		return { handle, info, absolutePath };
	} catch (error) {
		await handle.close();
		throw error;
	}
}

function assertFileIdentity(before, after, label) {
	if (before.dev !== after.dev || before.ino !== after.ino) {
		throw new Error(`${label}在读取期间发生替换。`);
	}
}

async function verifyOpenedPath(root, candidatePath, label, openedInfo) {
	const currentInfo = await lstat(candidatePath).catch(() => null);
	if (!currentInfo?.isFile() || currentInfo.isSymbolicLink()) {
		throw new Error(`${label}必须是普通文件且不能是符号链接。`);
	}
	const resolvedFile = await realpath(candidatePath);
	assertPathInside(root, resolvedFile, label);
	assertOutsideProductionVault(resolvedFile);
	const resolvedInfo = await stat(resolvedFile);
	if (resolvedInfo.dev !== openedInfo.dev || resolvedInfo.ino !== openedInfo.ino) {
		throw new Error(`数据集样本路径在校验期间发生替换：${label}`);
	}
	return resolvedFile;
}

function getLexicalAndRealPaths(candidate) {
	const lexicalPath = path.resolve(candidate);
	const resolvedPath = resolveThroughExistingAncestor(lexicalPath);
	return resolvedPath === lexicalPath ? [lexicalPath] : [lexicalPath, resolvedPath];
}

function resolveThroughExistingAncestor(candidate) {
	let existingPath = candidate;
	const missingSegments = [];
	while (true) {
		try {
			return path.resolve(realpathSync.native(existingPath), ...missingSegments.reverse());
		} catch (error) {
			if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") {
				return candidate;
			}
			const parent = path.dirname(existingPath);
			if (parent === existingPath) {
				return candidate;
			}
			missingSegments.push(path.basename(existingPath));
			existingPath = parent;
		}
	}
}

export function isPathInsideOrEqual(root, candidate) {
	const relativePath = path.relative(path.resolve(root), path.resolve(candidate));
	return !isOutsideRelativePath(relativePath);
}

function isOutsideRelativePath(relativePath) {
	return (
		path.isAbsolute(relativePath) ||
		relativePath === ".." ||
		relativePath.startsWith(`..${path.sep}`)
	);
}

import { mkdir, lstat, readFile, writeFile, copyFile, rename, unlink, readdir, readlink, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { unzipSync } from "fflate";
import { FILES, sha256, json, sourceState, fileHashes, same, writeJson, validateVerification } from "./delivery-evidence.mjs";

const exists = async (file) => { try { return await lstat(file); } catch (e) { if (e.code === "ENOENT") return null; throw e; } };
const isWithin = (root, file) => file === root || file.startsWith(`${root}${path.sep}`);
function forbidProduction(file) {
	if (path.resolve(file).split(path.sep).includes("lifeos-obsidian")) throw new Error("禁止操作生产 Vault");
}
export async function ordinaryPath(file, allowLeafLink = false) {
	forbidProduction(file);
	const absolute = path.resolve(file);
	let cursor = path.parse(absolute).root;
	for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
		cursor = path.join(cursor, part);
		const stat = await exists(cursor);
		if (stat?.isSymbolicLink() && !(allowLeafLink && cursor === absolute)) throw new Error(`拒绝符号链接路径：${cursor}`);
	}
}
function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
export function readPackage(buffer) {
	if (buffer.length > 100 * 1024 * 1024) throw new Error("ZIP 过大");
	let end = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { end = i; break; }
	}
	if (end < 0 || buffer.readUInt16LE(end + 4) || buffer.readUInt16LE(end + 6) || buffer.readUInt16LE(end + 8) !== 3 || buffer.readUInt16LE(end + 10) !== 3) throw new Error("ZIP 必须恰好包含三个插件文件");
	let offset = buffer.readUInt32LE(end + 16);
	if (offset + buffer.readUInt32LE(end + 12) !== end) throw new Error("ZIP 目录损坏");
	const entries = new Map();
	for (let i = 0; i < 3; i++) {
		if (offset + 46 > end || buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error("ZIP 目录损坏");
		const nameLength = buffer.readUInt16LE(offset + 28);
		const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
		const mode = buffer.readUInt32LE(offset + 38) >>> 16;
		const size = buffer.readUInt32LE(offset + 24);
		if (!FILES.includes(name) || entries.has(name) || (mode & 0xf000) === 0xa000 || size > 100 * 1024 * 1024 || (buffer.readUInt16LE(offset + 8) & 1)) throw new Error("ZIP 含重复、越界、链接、加密或非插件文件");
		entries.set(name, { size, crc: buffer.readUInt32LE(offset + 16) });
		offset += 46 + nameLength + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
	}
	if (offset !== end) throw new Error("ZIP 目录长度错误");
	const files = unzipSync(buffer);
	if (Object.keys(files).length !== 3) throw new Error("ZIP 文件清单不一致");
	for (const [name, entry] of entries) {
		if (!files[name] || files[name].length !== entry.size || crc32(files[name]) !== entry.crc) throw new Error("ZIP 文件校验失败");
	}
	return files;
}

export function createInstaller({ root, install, legacySource, fault = async () => {} }) {
	root = path.resolve(root); install = path.resolve(install); legacySource = path.resolve(legacySource);
	const currentPath = path.join(root, "current.json");
	const transactionPath = path.join(root, "transaction.json");
	const lockPath = path.join(root, "install.lock");
	const approved = (record, approval) => Boolean(approval?.deliveryId === record.id && approval.sourceCommit === record.sourceCommit && approval.zipSha256 === record.zipSha256 && FILES.every((f) => approval.fileHashes?.[f] === record.fileHashes[f]) && approval.approvedAt && approval.approvedBy && approval.userQuote?.trim());
	const recordPath = (id) => {
		if (!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error("交付 ID 非法");
		return path.join(root, "deliveries", id);
	};
	async function optionalJson(file) { await ordinaryPath(file); return await exists(file) ? json(file) : null; }
	async function guard() {
		await ordinaryPath(root); await ordinaryPath(path.dirname(install)); await ordinaryPath(legacySource);
		for (const name of ["backups", "deliveries", "current.json", "transaction.json"]) await ordinaryPath(path.join(root, name));
		if (isWithin(install, root) || isWithin(root, install) || install === legacySource) throw new Error("源码、安装和交付目录必须分离");
	}
	async function locked(fn, recovery = false) {
		await guard(); await mkdir(root, { recursive: true, mode: 0o700 });
		await ordinaryPath(lockPath);
		try { await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 }); }
		catch (e) {
			if (e.code !== "EEXIST") throw e;
			const lock = await json(lockPath);
			if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0) throw new Error("部署锁损坏，需人工核查", { cause: e });
			try { process.kill(lock.pid, 0); throw new Error("另一个部署操作正在执行", { cause: e }); }
			catch (check) {
				if (check.code !== "ESRCH") throw check;
				await unlink(lockPath);
				await writeFile(lockPath, JSON.stringify({ pid: process.pid }), { flag: "wx", mode: 0o600 });
			}
		}
		try {
			await ordinaryPath(transactionPath);
			if (await exists(transactionPath) && !recovery) throw new Error("存在未完成部署事务，请先运行 rollback 恢复");
			return await fn();
		} finally { await unlink(lockPath); }
	}
	async function loadCurrent() { return optionalJson(currentPath); }
	async function hashesAt(file) { await ordinaryPath(file); return fileHashes(file); }
	async function baselineBackup(id) {
		const backup = path.join(root, "backups", id);
		await ordinaryPath(backup); await mkdir(backup, { recursive: true, mode: 0o700 });
		for (const file of FILES) { await ordinaryPath(path.join(install, file)); await copyFile(path.join(install, file), path.join(backup, file)); }
		return backup;
	}
	async function assertCurrentMatches(record) {
		if (!record || !same(await hashesAt(install), record.fileHashes)) throw new Error("当前安装产物与交付记录不一致，拒绝覆盖");
	}
	async function restoreTransaction(tx) {
		if (!/^[a-zA-Z0-9-]+$/.test(tx.id)) throw new Error("事务 ID 非法");
		const backup = path.join(root, "backups", tx.id);
		await ordinaryPath(backup);
		if (tx.kind === "migration") {
			if (tx.previousLink !== legacySource) throw new Error("迁移恢复目标不匹配");
			const stat = await exists(install);
			if (stat?.isSymbolicLink()) {
				if (path.resolve(path.dirname(install), await readlink(install)) !== legacySource) throw new Error("安装链接已被外部修改");
			} else {
				if (stat) await rename(install, path.join(backup, `interrupted-install-${randomUUID()}`));
				await symlink(legacySource, install);
			}
		} else {
			await ordinaryPath(install);
			if (!same(await fileHashes(backup), tx.previous.fileHashes)) throw new Error("恢复备份校验失败");
			for (const file of FILES) {
				await ordinaryPath(path.join(install, file));
				const temp = path.join(install, `.${file}-${tx.id}`);
				await ordinaryPath(temp); await copyFile(path.join(backup, file), temp); await rename(temp, path.join(install, file));
			}
		}
		if (tx.previous) await writeJson(currentPath, tx.previous);
		else if (await exists(currentPath)) await unlink(currentPath);
		if (tx.kind !== "migration") {
			for (const file of FILES) {
				const temporary = path.join(install, `.${file}-${tx.id}`);
				await ordinaryPath(temporary);
				if (await exists(temporary)) await unlink(temporary);
			}
		}
		await unlink(transactionPath);
	}
	async function transaction(tx, action) {
		await writeJson(transactionPath, tx);
		try { await action(); await unlink(transactionPath); }
		catch (error) {
			try { await restoreTransaction(tx); }
			catch (restore) { throw new Error(`部署失败且恢复未完成：${error.message}；${restore.message}。请运行 rollback。`, { cause: restore }); }
			throw error;
		}
	}
	async function status() {
		await guard();
		if (await optionalJson(transactionPath)) return { state: "interrupted", ready: false, action: "运行 rollback 恢复未完成事务" };
		if (await optionalJson(lockPath)) return { state: "busy", ready: false };
		const current = await loadCurrent();
		if (!current) return { state: "not-migrated", ready: false, install };
		await assertCurrentMatches(current);
		if (current.kind === "baseline") return { state: "baseline", ready: true, install, current, approvalValid: false };
		const directory = recordPath(current.id);
		const approval = await optionalJson(path.join(directory, "approval.json"));
		let sourceMatches = false;
		if (current.worktree && await exists(current.worktree)) {
			await ordinaryPath(current.worktree);
			const source = await sourceState(current.worktree);
			sourceMatches = source.clean && source.commit === current.sourceCommit && source.fingerprint === current.sourceFingerprint;
		}
		const approvalValid = sourceMatches && approved(current, approval);
		return { state: approvalValid ? "approved" : "awaiting-human", ready: true, install, current, sourceMatches, approvalValid };
	}
	async function migrate() {
		return locked(async () => {
			const old = await loadCurrent();
			if (old) { await assertCurrentMatches(old); return { state: "already-migrated", current: old }; }
			const stat = await exists(install);
			if (!stat?.isSymbolicLink() || path.resolve(path.dirname(install), await readlink(install)) !== legacySource) throw new Error("迁移仅支持已核实的原源码软链接布局");
			const id = randomUUID();
			const backup = path.join(root, "backups", id);
			await ordinaryPath(backup);
			await mkdir(backup, { mode: 0o700, recursive: true });
			const stage = path.join(backup, "staging");
			await ordinaryPath(stage);
			await mkdir(stage, { mode: 0o700 });
			for (const file of [...FILES, "data.json"]) {
				const source = path.join(legacySource, file);
				if (file === "data.json" && !await exists(source)) continue;
				await ordinaryPath(source);
				if (!(await lstat(source)).isFile()) throw new Error(`迁移文件类型错误：${file}`);
				await copyFile(source, path.join(stage, file)); await copyFile(source, path.join(backup, file));
				if (sha256(await readFile(source)) !== sha256(await readFile(path.join(stage, file)))) throw new Error(`迁移校验失败：${file}`);
			}
			const manifest = await json(path.join(stage, "manifest.json"));
			if (manifest.id !== "echo-notes") throw new Error("迁移插件 ID 不匹配");
			const record = { id, kind: "baseline", version: manifest.version, fileHashes: await fileHashes(stage), backupId: id, installedAt: new Date().toISOString() };
			await writeJson(path.join(backup, "migration.json"), { originalLink: legacySource, install, fileHashes: record.fileHashes });
			await transaction({ id, kind: "migration", previous: null, previousLink: legacySource }, async () => {
				await rename(install, path.join(backup, "original-link"));
				await fault("migration-unlinked");
				await rename(stage, install);
				await fault("migration-installed");
				await writeJson(currentPath, record);
			});
			return { state: "migrated", current: record };
		});
	}
	async function snapshotContext(project, task, target) {
		await mkdir(target, { recursive: true, mode: 0o700 });
		async function copyDirectory(source, destination) {
			await ordinaryPath(source);
			await mkdir(destination, { recursive: true, mode: 0o700 });
			for (const entry of await readdir(source, { withFileTypes: true })) {
				if (entry.name === "__pycache__" || entry.name === ".runtime") continue;
				if (entry.isSymbolicLink()) throw new Error("交接上下文禁止包含符号链接");
				if (entry.isDirectory()) await copyDirectory(path.join(source, entry.name), path.join(destination, entry.name));
				else if (entry.isFile()) await copyFile(path.join(source, entry.name), path.join(destination, entry.name));
			}
		}
		await copyDirectory(task, path.join(target, "task"));
		// JSONL 引用与任务命名的原型目录均留存；不能只依赖源码 bundle 保存未跟踪工件。
		for (const list of ["implement.jsonl", "check.jsonl"]) {
			const file = path.join(task, list);
			if (!await exists(file)) continue;
			for (const line of (await readFile(file, "utf8")).split("\n").filter((v) => v.trim())) {
				const ref = JSON.parse(line).file;
				if (typeof ref !== "string" || path.isAbsolute(ref)) throw new Error("JSONL 工件引用必须是工程相对路径");
				const source = path.resolve(project, ref);
				if (!isWithin(project, source) || !/^(?:\.trellis\/(?:spec|tasks)\/|\.agents\/skills\/|design-lab\/|docs\/|src\/|tests\/|scripts\/|AGENTS\.md$)/.test(ref)) throw new Error("JSONL 引用越界或不属于允许的交接工件");
				await ordinaryPath(source);
				const destination = path.join(target, "references", ref);
				if ((await lstat(source)).isDirectory()) await copyDirectory(source, destination);
				else { await mkdir(path.dirname(destination), { recursive: true }); await copyFile(source, destination); }
			}
		}
		const taskInfo = await json(path.join(task, "task.json"));
		const prototype = path.join(project, "design-lab", taskInfo.id);
		if (await exists(prototype)) await copyDirectory(prototype, path.join(target, "design-lab", taskInfo.id));
		for (const name of [".trellis/spec", ".trellis/scripts", ".agents/skills"]) {
			if (await exists(path.join(project, name))) await copyDirectory(path.join(project, name), path.join(target, name));
		}
		for (const name of ["AGENTS.md", ".trellis/workflow.md", ".trellis/config.yaml"]) {
			const source = path.join(project, name);
			if (await exists(source)) { await ordinaryPath(source); await mkdir(path.dirname(path.join(target, name)), { recursive: true }); await copyFile(source, path.join(target, name)); }
		}
	}
	async function installFiles(record, files, previous, kind = "deploy") {
		const id = record.id;
		await baselineBackup(id);
		await transaction({ id, kind, previous }, async () => {
			for (const file of FILES) {
				const staged = path.join(install, `.${file}-${id}`);
				await ordinaryPath(staged); await writeFile(staged, files[file], { flag: "wx" });
			}
			for (const file of FILES) {
				await ordinaryPath(path.join(install, file));
				await rename(path.join(install, `.${file}-${id}`), path.join(install, file));
				await fault(`installed-${file}`);
			}
			if (!same(await fileHashes(install), record.fileHashes)) throw new Error("部署后产物校验失败");
			await writeJson(currentPath, record);
			await fault("current-written");
		});
	}
	async function deploy({ project, task, zip }) {
		project = path.resolve(project); task = path.resolve(task); zip = path.resolve(zip);
		return locked(async () => {
			await ordinaryPath(project); await ordinaryPath(task); await ordinaryPath(zip);
			if (!isWithin(path.join(project, ".trellis/tasks"), task) || task === path.join(project, ".trellis/tasks")) throw new Error("任务路径必须位于当前工程 .trellis/tasks 内");
			const taskInfo = await json(path.join(task, "task.json"));
			if (!/^[a-z0-9-]+$/.test(taskInfo.id)) throw new Error("任务 ID 非法");
			const previous = await loadCurrent();
			await assertCurrentMatches(previous);
			if (previous.taskId && previous.taskId !== taskInfo.id) {
				const release = await optionalJson(path.join(recordPath(previous.id), "release.json"));
				const approval = await optionalJson(path.join(recordPath(previous.id), "approval.json"));
				if (!approved(previous, approval) || release?.deliveryId !== previous.id || release.sourceCommit !== previous.sourceCommit || release.tag !== previous.version || !release.releaseUrl?.startsWith("https://github.com/anbang278/echo-notes/releases/tag/") || !release.completedAt || !release.reviewStatus) throw new Error("其他任务仍占用人工验收目录，不得自动覆盖");
			}
			const verificationFile = path.join(path.dirname(zip), "verification.json");
			const evidenceFile = path.join(path.dirname(zip), "package-evidence.json");
			await ordinaryPath(verificationFile); await ordinaryPath(evidenceFile);
			const verification = await json(verificationFile);
			const source = await validateVerification(project, verification, true);
			const evidence = await json(evidenceFile);
			const bytes = await readFile(zip);
			const zipHash = sha256(bytes);
			if (evidence.zipSha256 !== zipHash || evidence.verificationSha256 !== sha256(await readFile(verificationFile)) || !same(evidence.source, source) || !same(evidence.fileHashes, verification.fileHashes)) throw new Error("打包证据或 ZIP 校验失败");
			const files = readPackage(bytes);
			const manifest = JSON.parse(Buffer.from(files["manifest.json"]).toString("utf8"));
			const hashes = Object.fromEntries(FILES.map((f) => [f, sha256(files[f])]));
			if (manifest.id !== "echo-notes" || manifest.version !== verification.version || !same(hashes, verification.fileHashes)) throw new Error("ZIP 与已验证产物不一致");
			if (previous.zipSha256 === zipHash && previous.sourceCommit === source.commit && previous.taskId === taskInfo.id) return { state: "already-deployed", current: previous };
			const compareVersions = (a, b) => a.split(".").reduce((result, value, i) => result || Math.sign(Number(value) - Number(b.split(".")[i])), 0);
			if (compareVersions(manifest.version, previous.version) <= 0) throw new Error("新测试包版本必须高于当前安装版本");
			const id = `${taskInfo.id}-${randomUUID()}`;
			const directory = recordPath(id);
			await ordinaryPath(directory); await mkdir(directory, { recursive: true, mode: 0o700 });
			await writeFile(path.join(directory, `echo-notes-${manifest.version}.zip`), bytes, { mode: 0o600 });
			await copyFile(verificationFile, path.join(directory, "verification.json"));
			await copyFile(evidenceFile, path.join(directory, "package-evidence.json"));
			await mkdir(path.join(directory, "files"));
			for (const name of FILES) await writeFile(path.join(directory, "files", name), files[name]);
			execFileSync("git", ["bundle", "create", path.join(directory, "source.bundle"), "HEAD"], { cwd: project, stdio: "pipe" });
			await snapshotContext(project, task, path.join(directory, "context"));
			for (const kind of ["settings-ui", "editor-menu"]) {
				const report = path.join(project, "output/playwright", kind, "summary.json");
				if (await exists(report)) {
					await ordinaryPath(report); await mkdir(path.join(directory, "reports"), { recursive: true });
					await copyFile(report, path.join(directory, "reports", `${kind}.json`));
				}
			}
			const record = { id, kind: "delivery", taskId: taskInfo.id, taskPath: task, worktree: project, sourceCommit: source.commit, sourceFingerprint: source.fingerprint, version: manifest.version, zipSha256: zipHash, fileHashes: hashes, installedAt: new Date().toISOString(), previous };
			await writeJson(path.join(directory, "delivery.json"), record);
			// 保存后再次核验来源，防止收集交接工件期间源码被其他进程改动。
			await validateVerification(project, verification, true);
			await installFiles(record, files, previous);
			return { state: "awaiting-human", directory, current: record };
		});
	}
	async function rollback() {
		return locked(async () => {
			const pending = await optionalJson(transactionPath);
			if (pending) { await restoreTransaction(pending); return { state: "recovered" }; }
			const current = await loadCurrent();
			await assertCurrentMatches(current);
			if (!current.previous) throw new Error("没有可回退的部署");
			const previous = current.previous;
			const from = previous.kind === "baseline" ? path.join(root, "backups", previous.backupId) : path.join(recordPath(previous.id), "files");
			if (!same(await hashesAt(from), previous.fileHashes)) throw new Error("回退产物校验失败");
			const files = Object.fromEntries(await Promise.all(FILES.map(async (f) => [f, await readFile(path.join(from, f))])));
			const id = `rollback-${randomUUID()}`;
			const record = { ...previous, id, kind: previous.kind, restoredFrom: previous.id, previous: current, installedAt: new Date().toISOString() };
			const directory = recordPath(id);
			await ordinaryPath(directory);
			await mkdir(path.join(directory, "files"), { recursive: true });
			for (const f of FILES) await writeFile(path.join(directory, "files", f), files[f]);
			if (previous.kind === "delivery") {
				const original = recordPath(previous.id);
				for (const name of ["verification.json", "package-evidence.json", "source.bundle", `echo-notes-${previous.version}.zip`]) {
					await ordinaryPath(path.join(original, name));
					await copyFile(path.join(original, name), path.join(directory, name));
				}
				// 原任务与规范从持久快照复制，不依赖旧 worktree 仍存在。
				async function copySnapshot(source, target) {
					await ordinaryPath(source); await mkdir(target, { recursive: true });
					for (const entry of await readdir(source, { withFileTypes: true })) {
						if (entry.isSymbolicLink()) throw new Error("回退上下文包含异常链接");
						if (entry.isDirectory()) await copySnapshot(path.join(source, entry.name), path.join(target, entry.name));
						else if (entry.isFile()) await copyFile(path.join(source, entry.name), path.join(target, entry.name));
					}
				}
				await copySnapshot(path.join(original, "context"), path.join(directory, "context"));
				if (await exists(path.join(original, "reports"))) await copySnapshot(path.join(original, "reports"), path.join(directory, "reports"));
			}
			await writeJson(path.join(directory, "delivery.json"), record);
			await installFiles(record, files, current, "rollback");
			return { state: record.kind === "baseline" ? "baseline" : "awaiting-human", current: record };
		}, true);
	}
	return { migrate, deploy, status, rollback };
}

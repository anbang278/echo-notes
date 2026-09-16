import { createHash } from "node:crypto";
import { readFile, lstat, mkdir, writeFile, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const REQUIRED_STEP_IDS = ["tests", "lint", "typecheck", "build", "settings-ui", "editor-menu", "diff-worktree", "diff-index", "audit-production"];
export const FILES = ["main.js", "manifest.json", "styles.css"];
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const json = async (file) => JSON.parse(await readFile(file, "utf8"));
export const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }).trim();

export async function writeJson(file, value) {
	await mkdir(path.dirname(file), { recursive: true });
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, file);
}

export async function fileHashes(root) {
	const hashes = {};
	for (const name of FILES) {
		const file = path.join(root, name);
		const stat = await lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`产物必须为普通文件：${name}`);
		hashes[name] = sha256(await readFile(file));
	}
	return hashes;
}

export const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isLocalContext = (name) => /^(?:AGENTS\.md$|design-qa\.md$|design-lab\/|\.agents\/|\.agent\/|\.claude\/|\.codex\/|\.kimi-code\/|\.trellis\/)/.test(name);

export async function sourceState(root) {
	const tracked = git(root, "ls-files", "-z").split("\0").filter(Boolean);
	const extra = git(root, "ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).filter((name) => !isLocalContext(name));
	const names = [...new Set([...tracked, ...extra])].sort();
	const hash = createHash("sha256");
	for (const name of names) {
		const file = path.join(root, name);
		const stat = await lstat(file);
		if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`源码快照不接受符号链接或非普通文件：${name}`);
		hash.update(name).update("\0").update(sha256(await readFile(file))).update("\0");
	}
	return {
		commit: git(root, "rev-parse", "HEAD"),
		branch: git(root, "branch", "--show-current"),
		fingerprint: hash.digest("hex"),
		clean: git(root, "status", "--porcelain", "--untracked-files=no") === "" && extra.length === 0
	};
}

export async function versions(root) {
	const [manifest, pkg, lock, map] = await Promise.all(["manifest.json", "package.json", "package-lock.json", "versions.json"].map((name) => json(path.join(root, name))));
	if (manifest.id !== "echo-notes" || !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
		[pkg.version, lock.version, lock.packages?.[""]?.version].some((v) => v !== manifest.version) || map[manifest.version] !== manifest.minAppVersion) {
		throw new Error("版本文件不一致或插件 ID 非 echo-notes");
	}
	return manifest.version;
}

export async function validateVerification(root, report, requireClean = false) {
	const source = await sourceState(root);
	if (report.schemaVersion !== 1 || report.status !== "PASS" || !report.finishedAt || !Array.isArray(report.steps) || !same(report.steps.map((s) => s.id), REQUIRED_STEP_IDS) || report.steps.some((s) => s.exitCode !== 0)) throw new Error("缺少成功的完整自动验证证据");
	if (!same(source, report.source) || !same(await fileHashes(root), report.fileHashes) || await versions(root) !== report.version) throw new Error("源码、版本或产物已改变，必须重新完整验证");
	if (requireClean && (!source.clean || !source.branch || source.branch === "main" || source.branch === "master")) throw new Error("部署要求所有源码已提交到本地功能分支");
	return source;
}

export function assertFullVerificationMode(env) {
	if (env.ECHO_NOTES_VERIFY_RECORDING_ONLY === "1") throw new Error("完整验证不接受 ECHO_NOTES_VERIFY_RECORDING_ONLY 定向筛选，请取消该变量后重试");
}

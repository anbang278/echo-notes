import { spawn } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { sourceState, fileHashes, writeJson, same, REQUIRED_STEP_IDS, assertFullVerificationMode } from "./lib/delivery-evidence.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const evidencePath = path.join(PROJECT_ROOT, "output/verification/latest.json");
await rm(evidencePath, { force: true });
assertFullVerificationMode(process.env);
const initialSource = await sourceState(PROJECT_ROOT);
const startedAt = new Date().toISOString();

const [packageJson, packageLock, manifest, versions] = await Promise.all([
	readJson("package.json"),
	readJson("package-lock.json"),
	readJson("manifest.json"),
	readJson("versions.json")
]);

const releaseVersion = manifest.version;
const versionValues = {
	"package.json": packageJson.version,
	"package-lock.json": packageLock.version,
	"package-lock.json 根包": packageLock.packages?.[""]?.version,
	"manifest.json": releaseVersion
};
const mismatchedVersions = Object.entries(versionValues)
	.filter(([, version]) => version !== releaseVersion);
if (mismatchedVersions.length > 0) {
	throw new Error(
		`版本不一致：${Object.entries(versionValues).map(([file, version]) => `${file}=${version ?? "缺失"}`).join("，")}`
	);
}
if (versions[releaseVersion] !== manifest.minAppVersion) {
	throw new Error(
		`versions.json 缺少当前版本映射或最低版本不一致：${releaseVersion}=${versions[releaseVersion] ?? "缺失"}，manifest.minAppVersion=${manifest.minAppVersion}`
	);
}

const steps = [
	{
		label: "历史快速回归测试",
		command: npmCommand,
		args: ["test"]
	},
	{
		label: "Lint",
		command: npmCommand,
		args: ["run", "lint"]
	},
	{
		label: "TypeScript 类型检查",
		command: npmCommand,
		args: ["run", "typecheck"]
	},
	{
		label: "生产构建与运行时产物检查",
		command: npmCommand,
		args: ["run", "build"]
	},
	{
		label: "隔离 Obsidian 设置页与新人指引 UI 回归",
		command: process.execPath,
		args: ["scripts/verify-settings-ui.mjs"]
	},
	{
		label: "隔离 Obsidian 编辑器右键菜单回归",
		command: process.execPath,
		args: ["scripts/verify-editor-menu.mjs"]
	},
	{
		label: "未暂存 Git 差异格式检查",
		command: "git",
		args: ["diff", "--check"]
	},
	{
		label: "已暂存 Git 差异格式检查",
		command: "git",
		args: ["diff", "--cached", "--check"]
	},
	{
		label: "生产依赖安全审计",
		command: npmCommand,
		args: ["audit", "--omit=dev"]
	}
];

console.log(`Echo Notes ${releaseVersion} 常规完整验证开始。`);
for (const [index, step] of steps.entries()) {
	console.log(`\n[常规验证 ${index + 1}/${steps.length}] ${step.label}`);
	await run(step.command, step.args);
}
const finalSource = await sourceState(PROJECT_ROOT);
if (!same(initialSource, finalSource)) throw new Error("验证期间源码发生变化，不能生成通过证据");
await writeJson(evidencePath, {
 schemaVersion: 1, status: "PASS", startedAt, finishedAt: new Date().toISOString(),
 version: releaseVersion, source: finalSource, fileHashes: await fileHashes(PROJECT_ROOT),
 steps: steps.map((step, index) => ({ id: REQUIRED_STEP_IDS[index], command: [step.command, ...step.args].join(" "), exitCode: 0 }))
});
console.log(`\nEcho Notes ${releaseVersion} 常规完整验证全部通过。`);

async function readJson(fileName) {
	return JSON.parse(await readFile(path.join(PROJECT_ROOT, fileName), "utf8"));
}

function run(command, args) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: PROJECT_ROOT,
			env: process.env,
			stdio: "inherit"
		});

		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new Error(
				signal
					? `${command} ${args.join(" ")} 被信号 ${signal} 中止`
					: `${command} ${args.join(" ")} 退出码 ${code ?? "未知"}`
			));
		});
	});
}

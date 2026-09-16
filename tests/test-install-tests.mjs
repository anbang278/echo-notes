import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, realpath, readFile, writeFile, symlink, readlink, lstat, rm, copyFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { zipSync } from "fflate";
import { createInstaller, readPackage, ordinaryPath } from "../scripts/lib/test-install.mjs";
import { FILES, REQUIRED_STEP_IDS, fileHashes, sourceState, sha256, writeJson, json, git, validateVerification, versions } from "../scripts/lib/delivery-evidence.mjs";

// 所有配置和源码均为测试合成内容，绝不读取真实 Vault。
async function fixture(t, fault) {
	const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "echo-notes-install-tests-")));
	t.after(() => rm(base, { recursive: true, force: true }));
	const project = path.join(base, "project");
	const root = path.join(base, "persistent");
	const install = path.join(base, "vault/.obsidian/plugins/echo-notes");
	const task = path.join(project, ".trellis/tasks/fixture");
	await mkdir(project);
	await mkdir(path.dirname(install), { recursive: true });
	await mkdir(task, { recursive: true });
	await writeJson(path.join(task, "task.json"), { id: "fixture", status: "in_progress" });
	await writeFile(path.join(project, ".gitignore"), "data.json\ndist/\n.trellis/\n");
	await writeFile(path.join(project, "data.json"), " {\n  \"fixture\": \"配置原始字节\"\n }\n");
	git(project, "init", "--quiet", "--initial-branch=codex/fixture");
	async function commit() {
		git(project, "add", ".");
		git(project, "-c", "user.name=测试", "-c", "user.email=test@example.invalid", "commit", "--quiet", "-m", "测试快照");
	}
	async function update(version, suffix = version) {
		await writeJson(path.join(project, "manifest.json"), { id: "echo-notes", version, minAppVersion: "1.11.4" });
		await writeJson(path.join(project, "package.json"), { name: "echo-notes", version });
		await writeJson(path.join(project, "package-lock.json"), { version, packages: { "": { version } } });
		await writeJson(path.join(project, "versions.json"), { [version]: "1.11.4" });
		await writeFile(path.join(project, "main.js"), `// 合成构建 ${suffix}\n`);
		await writeFile(path.join(project, "styles.css"), `/* 合成样式 ${suffix} */\n`);
		await commit();
	}
	async function packageFixture() {
		const version = await versions(project);
		const dist = path.join(project, "dist");
		await mkdir(dist, { recursive: true });
		const files = Object.fromEntries(await Promise.all(FILES.map(async (name) => [name, await readFile(path.join(project, name))])));
		const zip = path.join(dist, `echo-notes-${version}.zip`);
		const bytes = Buffer.from(zipSync(files));
		await writeFile(zip, bytes);
		const report = {
			schemaVersion: 1, status: "PASS", finishedAt: new Date().toISOString(), version,
			source: await sourceState(project), fileHashes: await fileHashes(project),
			steps: ["npm test", "npm run lint", "npm run typecheck", "npm run build", `${process.execPath} scripts/verify-settings-ui.mjs`, `${process.execPath} scripts/verify-editor-menu.mjs`, "git diff --check", "git diff --cached --check", "npm audit --omit=dev"].map((command, index) => ({ id: REQUIRED_STEP_IDS[index], command, exitCode: 0 }))
		};
		await writeJson(path.join(dist, "verification.json"), report);
		await writeJson(path.join(dist, "package-evidence.json"), {
			source: report.source, fileHashes: report.fileHashes,
			zipSha256: sha256(bytes), verificationSha256: sha256(await readFile(path.join(dist, "verification.json")))
		});
		return { project, task, zip, report };
	}
	await update("0.4.26");
	await symlink(project, install);
	const options = { root, install, legacySource: project, fault };
	const installer = createInstaller(options);
	return { base, project, root, install, task, options, installer, update, commit, packageFixture };
}
async function ready(t, fault) {
	const f = await fixture(t, fault);
	await f.installer.migrate();
	await f.update("0.4.27");
	f.pkg = await f.packageFixture();
	return f;
}
async function approve(f, delivery, overrides = {}) {
	await writeJson(path.join(f.root, "deliveries", delivery.current.id, "approval.json"), {
		deliveryId: delivery.current.id, sourceCommit: delivery.current.sourceCommit,
		zipSha256: delivery.current.zipSha256, fileHashes: delivery.current.fileHashes,
		approvedAt: new Date().toISOString(), approvedBy: "测试用户", userQuote: "该版本验证通过并批准发布", ...overrides
	});
}

test("迁移分离源码、原样保留配置且重复执行幂等", async (t) => {
	const f = await fixture(t);
	const before = await fileHashes(f.project);
	const config = await readFile(path.join(f.project, "data.json"));
	assert.equal((await f.installer.status()).state, "not-migrated");
	assert.equal((await f.installer.migrate()).state, "migrated");
	assert.equal((await lstat(f.install)).isDirectory(), true);
	assert.deepEqual(await fileHashes(f.install), before);
	assert.deepEqual(await readFile(path.join(f.install, "data.json")), config);
	assert.equal((await f.installer.migrate()).state, "already-migrated");
	assert.equal((await f.installer.status()).state, "baseline");
});

test("迁移链接移开后失败会恢复原链接及配置", async (t) => {
	const f = await fixture(t, async (step) => { if (step === "migration-unlinked") throw new Error("注入迁移失败"); });
	const config = await readFile(path.join(f.project, "data.json"));
	await assert.rejects(f.installer.migrate(), /注入迁移失败/);
	assert.equal(await readlink(f.install), f.project);
	assert.deepEqual(await readFile(path.join(f.install, "data.json")), config);
	assert.equal((await f.installer.status()).state, "not-migrated");
});

test("错误旧链接和插件产物软链接均拒绝迁移", async (t) => {
	const f = await fixture(t);
	await rm(f.install);
	await symlink(f.base, f.install);
	await assert.rejects(f.installer.migrate(), /迁移仅支持/);
	await rm(f.install);
	await symlink(f.project, f.install);
	await rm(path.join(f.project, "main.js"));
	await symlink(path.join(f.project, "styles.css"), path.join(f.project, "main.js"));
	await assert.rejects(f.installer.migrate(), /符号链接/);
});

test("正常部署保存源码及证据，批准严格绑定当前交付", async (t) => {
	const f = await ready(t);
	const delivery = await f.installer.deploy(f.pkg);
	assert.equal(delivery.state, "awaiting-human");
	assert.deepEqual(await fileHashes(f.install), f.pkg.report.fileHashes);
	assert.equal((await lstat(path.join(delivery.directory, "source.bundle"))).isFile(), true);
	assert.equal((await lstat(path.join(delivery.directory, "context/task/task.json"))).isFile(), true);
	assert.equal((await f.installer.deploy(f.pkg)).state, "already-deployed");
	await approve(f, delivery, { sourceCommit: "错误提交" });
	assert.equal((await f.installer.status()).approvalValid, false);
	await approve(f, delivery);
	assert.equal((await f.installer.status()).state, "approved");
	await writeFile(path.join(f.install, "main.js"), "外部篡改");
	await assert.rejects(f.installer.status(), /不一致/);
});

test("已批准源码被修改后批准失效", async (t) => {
	const f = await ready(t);
	const delivery = await f.installer.deploy(f.pkg);
	await approve(f, delivery);
	await writeFile(path.join(f.project, "main.js"), "// 修改后的源码\n");
	const state = await f.installer.status();
	assert.equal(state.approvalValid, false);
	assert.notEqual(state.state, "approved");
});

test("未提交源码、陈旧验证证据和主分支均不能部署", async (t) => {
	const f = await ready(t);
	await writeFile(path.join(f.project, "main.js"), "// 未提交变更\n");
	await assert.rejects(f.installer.deploy(f.pkg), /重新完整验证/);
	const dirtyPackage = await f.packageFixture();
	await assert.rejects(f.installer.deploy(dirtyPackage), /本地功能分支/);
	await f.commit();
	git(f.project, "branch", "-m", "main");
	const mainPackage = await f.packageFixture();
	await assert.rejects(f.installer.deploy(mainPackage), /本地功能分支/);
});

test("相同版本的新源码必须升版后才能覆盖", async (t) => {
	const f = await ready(t);
	await f.installer.deploy(f.pkg);
	await f.update("0.4.27", "第二次修改");
	await assert.rejects(f.installer.deploy(await f.packageFixture()), /版本必须高于/);
});

test("新版本部署使先前批准失效且不同任务不能覆盖待验收目录", async (t) => {
	const f = await ready(t);
	const first = await f.installer.deploy(f.pkg);
	await approve(f, first);
	await f.update("0.4.28");
	const current = await f.installer.deploy(await f.packageFixture());
	await approve(f, current);
	assert.equal((await f.installer.status()).approvalValid, true);
	const otherTask = path.join(f.project, ".trellis/tasks/other");
	await writeJson(path.join(otherTask, "task.json"), { id: "other" });
	await assert.rejects(f.installer.deploy({ ...await f.packageFixture(), task: otherTask }), /其他任务仍占用/);
	await f.update("0.4.29");
	const takeover = await f.installer.deploy({ ...await f.packageFixture(), task: otherTask, takeover: true });
	assert.equal(takeover.state, "awaiting-human");
	assert.deepEqual(takeover.current.takeoverPrevious, {
		deliveryId: current.current.id,
		taskId: "fixture",
		authorizedAt: takeover.current.takeoverPrevious.authorizedAt
	});
});

test("替换第一个产物失败后恢复三个旧产物且保留配置", async (t) => {
	const f = await ready(t, async (step) => { if (step === "installed-main.js") throw new Error("注入部署失败"); });
	const before = await fileHashes(f.install);
	const config = await readFile(path.join(f.install, "data.json"));
	await assert.rejects(f.installer.deploy(f.pkg), /注入部署失败/);
	assert.deepEqual(await fileHashes(f.install), before);
	assert.deepEqual(await readFile(path.join(f.install, "data.json")), config);
	assert.equal((await f.installer.status()).state, "baseline");
});

test("回退只恢复三个产物，不回退人工修改的配置", async (t) => {
	const f = await ready(t);
	const before = await fileHashes(f.install);
	await f.installer.deploy(f.pkg);
	const config = Buffer.from("人工验证期间的新配置\n");
	await writeFile(path.join(f.install, "data.json"), config);
	const result = await f.installer.rollback();
	assert.equal(result.state, "baseline");
	assert.equal(result.current.kind, "baseline");
	assert.deepEqual(await fileHashes(f.install), before);
	assert.deepEqual(await readFile(path.join(f.install, "data.json")), config);
	assert.equal((await f.installer.status()).state, "baseline");
});

test("残留部署事务阻止部署，并可从已校验备份恢复", async (t) => {
	const f = await ready(t);
	const previous = (await f.installer.status()).current;
	const id = "interrupted-test";
	const backup = path.join(f.root, "backups", id);
	await mkdir(backup, { recursive: true });
	for (const name of FILES) await copyFile(path.join(f.install, name), path.join(backup, name));
	await writeJson(path.join(f.root, "transaction.json"), { id, kind: "deploy", previous });
	await writeFile(path.join(f.install, "main.js"), "中断后的混合版本");
	assert.equal((await f.installer.status()).ready, false);
	await assert.rejects(f.installer.deploy(f.pkg), /未完成部署事务/);
	assert.equal((await f.installer.rollback()).state, "recovered");
	assert.deepEqual(await fileHashes(f.install), previous.fileHashes);
});

test("存活进程的部署锁阻止并发操作", async (t) => {
	const f = await ready(t);
	await writeJson(path.join(f.root, "install.lock"), { pid: process.pid });
	assert.equal((await f.installer.status()).state, "busy");
	await assert.rejects(f.installer.deploy(f.pkg), /另一个部署操作/);
	assert.equal((await json(path.join(f.root, "install.lock"))).pid, process.pid);
});

test("任务路径越界、安装链接和路径中间软链接均被拒绝", async (t) => {
	const f = await ready(t);
	await assert.rejects(f.installer.deploy({ ...f.pkg, task: f.base }), /任务路径必须/);
	const alias = path.join(f.base, "alias");
	await symlink(f.root, alias);
	await assert.rejects(createInstaller({ ...f.options, root: alias }).status(), /符号链接/);
	await rm(f.install, { recursive: true });
	await symlink(f.project, f.install);
	await assert.rejects(f.installer.deploy(f.pkg), /符号链接/);
});

test("生产路径在任何文件读取或创建前被拒绝", async (t) => {
	const f = await fixture(t);
	const forbidden = path.join(f.base, "lifeos-obsidian");
	await assert.rejects(ordinaryPath(forbidden), /生产 Vault/);
	await assert.rejects(createInstaller({ ...f.options, root: forbidden }).migrate(), /生产 Vault/);
	await assert.rejects(lstat(forbidden), { code: "ENOENT" });
});

test("损坏包、路径越界、额外配置及 ZIP 链接被拒绝", () => {
	const files = { "main.js": Buffer.from("js"), "manifest.json": Buffer.from("{}"), "styles.css": Buffer.from("css") };
	assert.equal(Object.keys(readPackage(Buffer.from(zipSync(files)))).length, 3);
	assert.throws(() => readPackage(Buffer.from("损坏 ZIP")));
	assert.throws(() => readPackage(Buffer.from(zipSync({ "../main.js": files["main.js"], "manifest.json": files["manifest.json"], "styles.css": files["styles.css"] }))), /越界/);
	assert.throws(() => readPackage(Buffer.from(zipSync({ ...files, "data.json": Buffer.from("隐私配置") }))), /三个插件文件/);
	const linked = Buffer.from(zipSync(files));
	const central = linked.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	linked.writeUInt32LE((0xa000 << 16) >>> 0, central + 38);
	assert.throws(() => readPackage(linked), /链接/);
	const corrupted = Buffer.from(zipSync(files, { level: 0 }));
	corrupted[30 + corrupted.readUInt16LE(26)] ^= 1;
	assert.throws(() => readPackage(corrupted), /校验失败/);
});

test("ZIP 或验证文件发生变化时打包证据不能继续使用", async (t) => {
	const f = await ready(t);
	await writeFile(f.pkg.zip, "替换后的 ZIP");
	await assert.rejects(f.installer.deploy(f.pkg), /打包证据或 ZIP/);
	f.pkg = await f.packageFixture();
	await writeJson(path.join(path.dirname(f.pkg.zip), "verification.json"), { ...f.pkg.report, finishedAt: "改动" });
	await assert.rejects(f.installer.deploy(f.pkg), /打包证据或 ZIP/);
});

test("版本文件漂移、失败或缺失门禁都拒绝验证证据", async (t) => {
	const f = await ready(t);
	await assert.rejects(validateVerification(f.project, { ...f.pkg.report, steps: [{ command: "单步冒烟", exitCode: 0 }] }), /完整自动验证/);
	await assert.rejects(validateVerification(f.project, { ...f.pkg.report, steps: [{ command: "失败", exitCode: 1 }] }), /自动验证/);
	await writeJson(path.join(f.project, "package-lock.json"), { version: "0.0.1" });
	await assert.rejects(versions(f.project), /版本文件不一致/);
});

test("工作区丢失时不能继续宣称人工批准有效", async (t) => {
	const f = await ready(t);
	const delivery = await f.installer.deploy(f.pkg);
	await approve(f, delivery);
	await rm(f.project, { recursive: true });
	const state = await f.installer.status();
	assert.equal(state.approvalValid, false);
	assert.notEqual(state.state, "approved");
	assert.equal((await lstat(path.join(delivery.directory, "source.bundle"))).isFile(), true);
});

test("恢复备份被破坏时保留中断状态而不宣称就绪", async (t) => {
	const f = await ready(t);
	const previous = (await f.installer.status()).current;
	const id = "corrupted-backup";
	const backup = path.join(f.root, "backups", id);
	await mkdir(backup, { recursive: true });
	for (const name of FILES) await copyFile(path.join(f.install, name), path.join(backup, name));
	await writeFile(path.join(backup, "styles.css"), "备份损坏");
	await writeJson(path.join(f.root, "transaction.json"), { id, kind: "deploy", previous });
	await assert.rejects(f.installer.rollback(), /恢复备份校验失败/);
	assert.equal((await f.installer.status()).state, "interrupted");
});

test("迁移安装新目录后失败仍恢复原始链接", async (t) => {
	const f = await fixture(t, async (step) => { if (step === "migration-installed") throw new Error("注入完成前失败"); });
	await assert.rejects(f.installer.migrate(), /注入完成前失败/);
	assert.equal(await readlink(f.install), f.project);
	assert.equal((await f.installer.status()).state, "not-migrated");
});

test("无配置文件的旧插件也可以原样迁移", async (t) => {
	const f = await fixture(t);
	await rm(path.join(f.project, "data.json"));
	await f.installer.migrate();
	await assert.rejects(lstat(path.join(f.install, "data.json")), { code: "ENOENT" });
	assert.equal((await f.installer.status()).state, "baseline");
});

test("ZIP 即便更新包哈希也不能与已验证产物不一致", async (t) => {
	const f = await ready(t);
	const bytes = Buffer.from(zipSync({
		"main.js": Buffer.from("未经验证的构建"),
		"manifest.json": await readFile(path.join(f.project, "manifest.json")),
		"styles.css": await readFile(path.join(f.project, "styles.css"))
	}));
	await writeFile(f.pkg.zip, bytes);
	const evidencePath = path.join(path.dirname(f.pkg.zip), "package-evidence.json");
	await writeJson(evidencePath, { ...await json(evidencePath), zipSha256: sha256(bytes) });
	await assert.rejects(f.installer.deploy(f.pkg), /已验证产物不一致/);
});

test("备份根目录为软链接时在复制配置前拒绝迁移", async (t) => {
	const f = await fixture(t);
	const external = path.join(f.base, "outside-backups");
	await mkdir(external);
	await mkdir(f.root);
	await symlink(external, path.join(f.root, "backups"));
	await assert.rejects(f.installer.migrate(), /符号链接/);
	assert.deepEqual(await readdir(external), []);
	assert.equal(await readlink(f.install), f.project);
});

test("交接保存 JSONL 引用的批准原型与任务完整原型目录", async (t) => {
	const f = await ready(t);
	const referenced = path.join(f.project, "design-lab/approved-example/index.html");
	const prototype = path.join(f.project, "design-lab/fixture");
	await mkdir(path.dirname(referenced), { recursive: true });
	await mkdir(path.join(prototype, "assets"), { recursive: true });
	await writeFile(referenced, "<!doctype html><title>已批准交互原型</title>");
	await writeFile(path.join(prototype, "index.html"), "<!doctype html><title>任务原型</title>");
	await writeFile(path.join(prototype, "assets/style.css"), "/* 任务原型依赖 */");
	await writeFile(path.join(f.task, "approval.md"), "人工已批准该合成测试原型。\n");
	await writeFile(path.join(f.task, "implement.jsonl"), `${JSON.stringify({ file: "design-lab/approved-example/index.html", reason: "人工已批准原型" })}\n`);
	const delivery = await f.installer.deploy(f.pkg);
	const context = path.join(delivery.directory, "context");
	assert.deepEqual(await readFile(path.join(context, "references/design-lab/approved-example/index.html")), await readFile(referenced));
	assert.deepEqual(await readFile(path.join(context, "design-lab/fixture/index.html")), await readFile(path.join(prototype, "index.html")));
	assert.deepEqual(await readFile(path.join(context, "design-lab/fixture/assets/style.css")), await readFile(path.join(prototype, "assets/style.css")));
	assert.equal(await readFile(path.join(context, "task/approval.md"), "utf8"), "人工已批准该合成测试原型。\n");
});

test("JSONL 越界引用拒绝部署并保持已有安装不变", async (t) => {
	const f = await ready(t);
	const before = await fileHashes(f.install);
	await writeFile(path.join(f.task, "check.jsonl"), `${JSON.stringify({ file: "design-lab/../../outside-private.txt", reason: "不允许越界" })}\n`);
	await assert.rejects(f.installer.deploy(f.pkg), /JSONL 引用越界/);
	assert.deepEqual(await fileHashes(f.install), before);
	assert.equal((await f.installer.status()).state, "baseline");
});

test("回退旧交付保留完整证据并建立新 ID，不继承旧批准", async (t) => {
	const f = await ready(t);
	const first = await f.installer.deploy(f.pkg);
	await approve(f, first);
	await f.update("0.4.28");
	await f.installer.deploy(await f.packageFixture());
	const result = await f.installer.rollback();
	const restored = path.join(f.root, "deliveries", result.current.id);
	assert.equal(result.state, "awaiting-human");
	assert.equal(result.current.kind, "delivery");
	assert.equal(result.current.version, "0.4.27");
	assert.equal(result.current.restoredFrom, first.current.id);
	assert.notEqual(result.current.id, first.current.id);
	assert.deepEqual(await fileHashes(f.install), first.current.fileHashes);
	for (const name of ["source.bundle", "echo-notes-0.4.27.zip", "verification.json", "package-evidence.json", "context/task/task.json"]) {
		assert.deepEqual(await readFile(path.join(restored, name)), await readFile(path.join(first.directory, name)));
	}
	await assert.rejects(lstat(path.join(restored, "approval.json")), { code: "ENOENT" });
	assert.equal((await f.installer.status()).approvalValid, false);
	assert.equal((await f.installer.status()).state, "awaiting-human");
});

test("完整验证拒绝以录音定向筛选冒充全量回归", async () => {
	const { assertFullVerificationMode } = await import("../scripts/lib/delivery-evidence.mjs");
	assert.throws(() => assertFullVerificationMode({ ECHO_NOTES_VERIFY_RECORDING_ONLY: "1" }), /完整验证/);
	assert.doesNotThrow(() => assertFullVerificationMode({}));
});

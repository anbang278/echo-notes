import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspaceRealtimeStop } from "./verify-workspace-realtime-stop.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VIEW_TYPE = "echo-notes-meeting-workspace";
const FIXTURE_KEY = "__echoWorkspaceAgentValidation";
const TEMP_PREFIX = "echo-workspace-offline-";
const sha256 = (content) => createHash("sha256").update(content).digest("hex");

async function waitUntil(check, message, timeoutMs = 15000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

async function modalStatus(modal) {
	for (const text of await modal.locator("pre").allTextContents()) {
		if (!text.trim().startsWith("{")) continue;
		try {
			const value = JSON.parse(text);
			if (value.protocolVersion === 1 && Array.isArray(value.errors)) return value;
		} catch { /* The UI can still be replacing the prior message. */ }
	}
	return null;
}

/** Uses the real connection UI in the already-running disposable Obsidian host. */
export async function verifyWorkspaceAgentUi(page, { pluginId, validationVault, outputDir }) {
	assert(validationVault && /echo-notes-settings-ui-[^/\\]+[/\\]vault$/.test(validationVault), "Agent UI 验证需要明确的隔离 Vault 路径");
	const isolatedPath = await realpath(validationVault);
	assert.equal(path.dirname(path.dirname(isolatedPath)), await realpath(os.tmpdir()), "Agent UI Vault 必须来自本机临时验收目录");
	await mkdir(outputDir, { recursive: true });
	const originalViewport = page.viewportSize();
	const marker = `ECHO_WORKSPACE_OFFLINE_${randomUUID().replaceAll("-", "")}`;
	const forbiddenAnalysis = `ECHO_FORBIDDEN_ANALYSIS_${randomUUID().replaceAll("-", "")}`;
	let temporaryRoot;
	let returned = false;
	const report = { status: "RUNNING", validationScope: "isolated-obsidian-agent-connection", checks: {} };
	try {
		report.realtimeStop = await verifyWorkspaceRealtimeStop(page, { pluginId, validationVault, outputDir });
		await page.setViewportSize({ width: 1280, height: 900 });
		const prepared = await page.evaluate(async ({ id, expectedVault, fixtureKey, sourceMarker, analysisMarker }) => {
			const app = window.app;
			if (app.vault.adapter.getBasePath() !== expectedVault) throw new Error("Agent UI fixture 目标与隔离 Vault 不一致");
			const plugin = app.plugins.plugins[id];
			if (!plugin?.meetingWorkspace) throw new Error("会议中心服务未加载");
			const root = `Agent连接隔离验收-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
			const priorPolicyPath = `${plugin.meetingWorkspace.catalog.paths.systemDir}/agent-reader/policy.json`;
			const original = {
				settings: plugin.settings,
				activeLeaf: app.workspace.activeLeaf,
				leaves: app.workspace.getLeavesOfType("echo-notes-meeting-workspace"),
				settingsOpen: Boolean(document.querySelector(".modal.mod-settings")),
				leftCollapsed: app.workspace.leftSplit?.collapsed,
				rightCollapsed: app.workspace.rightSplit?.collapsed,
				priorPolicyPath,
				priorPolicyContent: await plugin.meetingWorkspace.catalog.storage.read(priorPolicyPath)
			};
			window[fixtureKey] = { root, original };
			app.setting.close();
			app.workspace.leftSplit?.collapse();
			app.workspace.rightSplit?.collapse();
			plugin.settings = {
				...plugin.settings,
				memoryRootFolder: `${root}/Memory`,
				memoryPathLanguage: "zh",
				meetingDisplayTimezone: "Asia/Taipei",
				meetingWorkspaceMode: "reader",
				autoTranscribeOnAudioCreated: false,
				autoTranscribeOnAudioLink: false
			};
			await plugin.saveSettings();
			if (!app.vault.getAbstractFileByPath(root)) await app.vault.createFolder(root);
			const service = plugin.meetingWorkspace;
			await service.catalog.initialize();
			const project = await service.catalog.registerProject(`${root}/项目背景.md`, "Agent离线验收项目");
			const sourcePath = `${root}/原文 中文.transcript.md`;
			const text = `---\ntype: audio-transcript\nstatus: done\n---\n<!-- echo-notes-transcript:start -->\n# 转写稿 Agent离线验收\n\n产品：${sourceMarker} 保留人工干预入口与上下文。\n\n运营：只在明确范围内读取会议资料。\n<!-- echo-notes-transcript:end -->\n<!-- echo-notes-analysis:start -->\n## AI 分析\n\n${analysisMarker}\n<!-- echo-notes-analysis:end -->\n`;
			await app.vault.create(sourcePath, text);
			const source = await service.catalog.registerTranscript({ transcriptPath: sourcePath, title: "Agent 离线验收会议", time: { precision: "date", date: "2026-11-08", source: "user", confirmed: true } });
			await service.catalog.setMeetingProjects(source.meetingId, [project.id]);
			const sourceContent = await service.catalog.storage.read(sourcePath);
			Object.assign(window[fixtureKey], { sourcePath, sourceId: source.id, meetingId: source.meetingId, projectId: project.id, sourceContent });
			await plugin.activateMeetingWorkspace("reader");
			return { root, sourcePath, sourceId: source.id, meetingId: source.meetingId, projectId: project.id, policyPath: `${service.catalog.paths.systemDir}/agent-reader/policy.json` };
		}, { id: pluginId, expectedVault: validationVault, fixtureKey: FIXTURE_KEY, sourceMarker: marker, analysisMarker: forbiddenAnalysis });
		const workspace = page.locator(".echo-notes-workspace").last();
		await workspace.waitFor({ state: "visible" });
		await workspace.getByRole("button", { name: "Agent 连接", exact: true }).click();
		const modal = page.locator(".modal").filter({ has: page.getByText("连接外部 Agent", { exact: true }) }).last();
		await modal.waitFor({ state: "visible" });
		const setting = (title) => modal.locator(".setting-item").filter({ has: page.getByText(title, { exact: true }) });
		const memoryToggle = setting("已批准记忆").locator(".checkbox-container");
		if (await memoryToggle.evaluate((element) => element.classList.contains("is-enabled"))) await memoryToggle.click();
		const transcriptToggle = setting("原始与修订转写").locator(".checkbox-container");
		if (!await transcriptToggle.evaluate((element) => element.classList.contains("is-enabled"))) await transcriptToggle.click();
		await modal.getByRole("button", { name: "开启只读导出并生成快照", exact: true }).click();
		await waitUntil(async () => (await modal.innerText()).includes("已发布完整快照"), "真实 Agent UI 未发布完整快照");
		await modal.getByRole("button", { name: "健康检查", exact: true }).click();
		await waitUntil(async () => (await modalStatus(modal))?.status === "ok", "真实 Agent UI 健康检查未通过");
		const enabled = await modalStatus(modal);
		assert.deepEqual(enabled.data.sourceKinds, ["transcript"], "Agent UI 未按选定的原文范围生效");
		assert.equal(enabled.data.sources, 1, "构造来源未进入真实发布快照");
		report.checks.realUiScopeAndSnapshot = true;
		report.checks.realUiDoctor = true;
		await modal.screenshot({ path: path.join(outputDir, "workspace-agent-enabled.png") });

		await modal.getByRole("button", { name: "关闭导出", exact: true }).click();
		await waitUntil(async () => (await modal.innerText()).includes("导出已关闭"), "Agent UI 关闭导出未完成");
		await modal.getByRole("button", { name: "健康检查", exact: true }).click();
		await waitUntil(async () => (await modalStatus(modal))?.errors[0]?.code === "EXPORT_DISABLED", "旧快照在 UI 关闭导出后仍可读取");
		report.checks.realUiRevocationRejectsOldGeneration = true;
		await modal.screenshot({ path: path.join(outputDir, "workspace-agent-disabled.png") });
		await modal.getByRole("button", { name: "开启只读导出并生成快照", exact: true }).click();
		await waitUntil(async () => (await modal.innerText()).includes("已发布完整快照"), "Agent UI 重新开启导出未完成");
		await page.waitForFunction((id) => {
			const service = window.app.plugins.plugins[id].meetingWorkspace;
			return service.publishing === null && service.refreshTimer === null;
		}, pluginId);
		const captured = await page.evaluate(async ({ id, fixtureKey, expectedVault }) => {
			if (window.app.vault.adapter.getBasePath() !== expectedVault) throw new Error("Agent fixture 读取目标发生变化");
			const fixture = window[fixtureKey];
			const catalog = window.app.plugins.plugins[id].meetingWorkspace.catalog;
			const names = await catalog.storage.list(fixture.root);
			const files = [];
			for (const name of names) {
				if (!name.startsWith(`${fixture.root}/`) || !/\.(?:md|json)$/.test(name)) throw new Error("Agent fixture 包含范围外或非文本文件");
				const content = await catalog.storage.read(name);
				if (content === null) throw new Error("Agent fixture 在复制期间缺失文件");
				files.push({ path: name, content });
			}
			return { files, sourceUnchanged: (await catalog.storage.read(fixture.sourcePath)) === fixture.sourceContent };
		}, { id: pluginId, fixtureKey: FIXTURE_KEY, expectedVault: validationVault });
		assert(captured.sourceUnchanged, "连接、发布和健康检查修改了转写原文");
		report.checks.sourceUnchanged = true;
		temporaryRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), TEMP_PREFIX)));
		const vaultPath = path.join(temporaryRoot, "Vault 中文");
		await mkdir(vaultPath);
		const fileHashes = {};
		for (const file of captured.files) {
			assert(file.path.startsWith(`${prepared.root}/`) && !file.path.split(/[\\/]/).includes(".."), "复制路径超出构造根");
			const target = path.resolve(vaultPath, file.path);
			assert(target.startsWith(`${vaultPath}${path.sep}`), "复制路径越出离线构造 Vault");
			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, file.content, { flag: "wx" });
			fileHashes[file.path] = sha256(file.content);
		}
		const offlineFixture = { schemaVersion: 1, temporaryRoot, vaultPath, policyPath: prepared.policyPath, sourcePath: prepared.sourcePath, sourceId: prepared.sourceId, meetingId: prepared.meetingId, projectId: prepared.projectId, marker, forbiddenAnalysis, fileHashes };
		report.status = "PASS";
		report.fileCount = captured.files.length;
		report.sourceSha256 = fileHashes[prepared.sourcePath];
		report.checkedAt = new Date().toISOString();
		await writeFile(path.join(outputDir, "workspace-agent-ui.json"), `${JSON.stringify(report, null, 2)}\n`);
		returned = true;
		return { report, offlineFixture };
	} catch (error) {
		report.status = "FAIL";
		report.error = error instanceof Error ? error.message : String(error);
		report.checkedAt = new Date().toISOString();
		await writeFile(path.join(outputDir, "workspace-agent-ui.json"), `${JSON.stringify(report, null, 2)}\n`);
		throw error;
	} finally {
		let cleanupSucceeded = false;
		try {
			const connectionModal = page.locator(".modal").filter({ has: page.getByText("连接外部 Agent", { exact: true }) }).last();
			if (await connectionModal.isVisible()) {
				await page.keyboard.press("Escape");
				await connectionModal.waitFor({ state: "hidden" });
			}
			await page.evaluate(async ({ id, fixtureKey, type }) => {
				const fixture = window[fixtureKey];
				if (!fixture) return;
				const app = window.app;
				for (const container of [...document.querySelectorAll(".modal-container")]) container.querySelector(".modal-close-button")?.click();
				for (const leaf of app.workspace.getLeavesOfType(type)) if (!fixture.original.leaves.includes(leaf)) leaf.detach();
				const plugin = app.plugins.plugins[id];
				plugin.settings = fixture.original.settings;
				await plugin.saveSettings();
				if (fixture.original.priorPolicyContent !== null) await plugin.meetingWorkspace.catalog.storage.write(fixture.original.priorPolicyPath, fixture.original.priorPolicyContent);
				const folder = app.vault.getAbstractFileByPath(fixture.root);
				if (folder) await app.vault.delete(folder, true);
				if (fixture.original.activeLeaf?.parent) app.workspace.setActiveLeaf(fixture.original.activeLeaf, { focus: true });
				if (fixture.original.leftCollapsed === false) app.workspace.leftSplit?.expand();
				if (fixture.original.rightCollapsed === false) app.workspace.rightSplit?.expand();
				if (fixture.original.settingsOpen) { app.setting.open(); await app.setting.openTabById(id); }
				delete window[fixtureKey];
			}, { id: pluginId, fixtureKey: FIXTURE_KEY, type: VIEW_TYPE });
			if (originalViewport) await page.setViewportSize(originalViewport);
			cleanupSucceeded = true;
		} finally {
			if ((!returned || !cleanupSucceeded) && temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
		}
	}
}

/** Invoke only after the disposable Obsidian child has fully exited. */
export async function verifyWorkspaceOfflineReader(fixture, outputDir) {
	assert.equal(fixture?.schemaVersion, 1, "离线验收缺少构造 fixture 身份");
	const temporaryRoot = await realpath(fixture.temporaryRoot);
	assert(path.basename(temporaryRoot).startsWith(TEMP_PREFIX), "拒绝清理非本次离线验收临时目录");
	assert.equal(await realpath(fixture.vaultPath), path.join(temporaryRoot, "Vault 中文"), "离线 Vault 不在本次构造位置");
	const report = { status: "RUNNING", validationScope: "detached-cli-after-isolated-obsidian-exit", checks: {}, commands: [] };
	try {
		await mkdir(outputDir, { recursive: true });
		const detachedSkill = path.join(temporaryRoot, "Detached Skill 中文");
		await cp(path.join(PROJECT_ROOT, "skills/echo-notes-memory"), detachedSkill, { recursive: true });
		const script = path.join(detachedSkill, "scripts/echo-memory.mjs");
		const env = { ...process.env, ECHO_MEMORY_CONFIG: path.join(temporaryRoot, "reader-connections.json") };
		const invoke = (...args) => {
			const startedAt = performance.now();
			const child = spawnSync(process.execPath, [script, ...args], { cwd: temporaryRoot, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
			const elapsedMs = Math.round((performance.now() - startedAt) * 100) / 100;
			if (child.error) throw child.error;
			assert(child.stdout.trim(), `独立 CLI 未返回 JSON ${args[0]}`);
			const response = JSON.parse(child.stdout);
			report.commands.push({ command: args[0], coldProcessElapsedMs: elapsedMs, exitCode: child.status, status: response.status, errorCodes: response.errors?.map((error) => error.code) ?? [] });
			return { exitCode: child.status, response, stdout: child.stdout, stderr: child.stderr };
		};
		const setup = invoke("setup", "--vault", fixture.vaultPath, "--alias", "offline-fixture", "--policy", fixture.policyPath, "--kind", "transcript", "--json");
		assert.equal(setup.exitCode, 0, setup.stdout + setup.stderr);
		assert.equal(setup.response.status, "ok");
		const doctor = invoke("doctor", "--vault", "offline-fixture", "--json");
		assert.equal(doctor.exitCode, 0, doctor.stdout + doctor.stderr);
		assert.equal(doctor.response.data.sources, 1);
		report.checks.detachedSetupAndDoctor = true;
		const projects = invoke("projects", "list", "--vault", "offline-fixture", "--json");
		assert.equal(projects.exitCode, 0, projects.stdout + projects.stderr);
		assert(projects.response.data.items.some((project) => project.id === fixture.projectId));
		const meetings = invoke("meetings", "list", "--vault", "offline-fixture", "--json");
		assert.equal(meetings.exitCode, 0, meetings.stdout + meetings.stderr);
		assert(meetings.response.data.items.some((meeting) => meeting.id === fixture.meetingId));
		report.checks.sameStableProjectAndMeetingIdentities = true;
		const search = invoke("search", "--vault", "offline-fixture", "--query", fixture.marker, "--kind", "evidence", "--json");
		assert.equal(search.exitCode, 0, search.stdout + search.stderr);
		assert(search.response.data.items.length > 0, "宿主退出后独立 CLI 未找回构造原文");
		assert(search.response.data.items.every((item) => item.sourceId === fixture.sourceId && item.quote.includes(fixture.marker)));
		const source = invoke("read", "--vault", "offline-fixture", "--id", fixture.sourceId, "--json");
		assert.equal(source.exitCode, 0, source.stdout + source.stderr);
		assert(source.response.data.content.includes(fixture.marker), "source read 缺少正式原文");
		assert(!source.stdout.includes(fixture.forbiddenAnalysis), "transcript-only 读取泄漏未授权分析区");
		report.checks.offlineEvidenceSearchAndSourceRead = true;
		report.checks.transcriptOnlyScopeExcludesAnalysis = true;
		for (const [relative, hash] of Object.entries(fixture.fileHashes)) assert.equal(sha256(await readFile(path.join(fixture.vaultPath, relative))), hash, `只读 CLI 改写业务文件 ${relative}`);
		report.checks.allCopiedVaultFilesUnchanged = true;
		const policyFile = path.join(fixture.vaultPath, fixture.policyPath);
		const policy = JSON.parse(await readFile(policyFile, "utf8"));
		policy.enabled = false;
		policy.version = `offline-revoked-${randomUUID()}`;
		policy.updatedAt = new Date().toISOString();
		await writeFile(policyFile, `${JSON.stringify(policy, null, 2)}\n`);
		const denied = invoke("doctor", "--vault", "offline-fixture", "--json");
		assert.equal(denied.exitCode, 1);
		assert.equal(denied.response.errors[0].code, "EXPORT_DISABLED");
		const deniedSearch = invoke("search", "--vault", "offline-fixture", "--query", fixture.marker, "--kind", "evidence", "--json");
		assert.equal(deniedSearch.exitCode, 1);
		assert.equal(deniedSearch.response.errors[0].code, "EXPORT_DISABLED");
		report.checks.offlinePolicyRevocationRejectsOldGeneration = true;
		report.status = "PASS";
		report.sourceSha256 = fixture.fileHashes[fixture.sourcePath];
		return report;
	} catch (error) {
		report.status = "FAIL";
		report.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		report.checkedAt = new Date().toISOString();
		await mkdir(outputDir, { recursive: true });
		await writeFile(path.join(outputDir, "workspace-offline-reader.json"), `${JSON.stringify(report, null, 2)}\n`);
		await rm(temporaryRoot, { recursive: true, force: true });
	}
}

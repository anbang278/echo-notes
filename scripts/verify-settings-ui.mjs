import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	realpath,
	rm,
	stat,
	writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

// 该脚本只用于本地验收，通过隔离的 Obsidian renderer 调用内部 API，不进入插件运行时代码。
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_ID = "echo-notes";
const TEST_VAULT = path.resolve(
	process.env.ECHO_NOTES_TEST_VAULT ?? path.resolve(PROJECT_ROOT, "../..")
);
const OBSIDIAN_BINARY = path.resolve(
	process.env.OBSIDIAN_BINARY_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian"
);
const OBSIDIAN_DATA_DIR = path.resolve(
	process.env.OBSIDIAN_DATA_DIR ?? path.join(os.homedir(), "Library/Application Support/obsidian")
);
const OUTPUT_DIR = path.resolve(
	process.env.ECHO_NOTES_UI_OUTPUT_DIR ?? path.join(PROJECT_ROOT, "output/playwright/settings-ui")
);
const README_URL = "https://github.com/anbang278/echo-notes/blob/main/README.zh-CN.md";
const EXPECTED_TITLE = "记录行动，构建面向未来的 AI Memory";
const EXPECTED_INTRO =
	"Echo Notes 以录音为入口，将转写与 AI 分析沉淀为 Vault 中可搜索、可链接、可长期复用的 Markdown 上下文，并为未来的 Personal Agent 构建个人记忆。";
const EXPECTED_README_LINK_TEXT = "查看完整设计理念";
const EXPECTED_GUIDE =
	"操作指引：请按下方工作流选择阶段，再进入对应分类完成必要配置。";
const STARTUP_TIMEOUT_MS = 30_000;
const MOBILE_SHELL_CLASS = "echo-notes-verify-mobile-shell";

const MOBILE_SHELL_CSS = `
body.${MOBILE_SHELL_CLASS} .modal-container.mod-dim {
	align-items: stretch !important;
	justify-content: stretch !important;
}

body.${MOBILE_SHELL_CLASS} .modal.mod-settings {
	inset: 0 !important;
	width: 100vw !important;
	height: 100vh !important;
	max-width: none !important;
	max-height: none !important;
	margin: 0 !important;
	border-radius: 0 !important;
	transform: none !important;
}

body.${MOBILE_SHELL_CLASS} .modal.mod-settings .vertical-tabs-container {
	display: block !important;
}

body.${MOBILE_SHELL_CLASS} .modal.mod-settings .vertical-tab-header {
	display: none !important;
}

body.${MOBILE_SHELL_CLASS} .modal.mod-settings .vertical-tab-content-container,
body.${MOBILE_SHELL_CLASS} .modal.mod-settings .vertical-tab-content {
	width: 100% !important;
	max-width: none !important;
	min-width: 0 !important;
}

body.${MOBILE_SHELL_CLASS} .modal.mod-settings .vertical-tab-content {
	padding: 24px 16px !important;
}

body.${MOBILE_SHELL_CLASS} .workspace-split.mod-right-split:has(.echo-notes-task-center) {
	position: fixed !important;
	inset: 0 !important;
	z-index: var(--layer-popover) !important;
	display: flex !important;
	width: 100vw !important;
	max-width: none !important;
	transform: none !important;
}

body.${MOBILE_SHELL_CLASS} .workspace-split.mod-right-split:has(.echo-notes-task-center) > .workspace-tabs {
	width: 100% !important;
	max-width: none !important;
}

body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal button.echo-notes-memory-center-tab,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal button.echo-notes-memory-quick-link,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal button.echo-notes-memory-tool,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal .echo-notes-memory-inbox-bulk-button,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal .echo-notes-memory-inbox-actions button,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal .echo-notes-memory-inbox-empty button,
body.${MOBILE_SHELL_CLASS} .echo-notes-memory-center-modal .echo-notes-memory-relation-suggestion-actions button {
	min-height: 44px !important;
}
`;

// Obsidian 1.13 hides the real <select> used by DropdownComponent and overlays a custom UI.
// Playwright's selectOption needs the native <select> to be visible, so we force opacity on it
// while leaving the .is-measuring helper select untouched.
const DROPDOWN_VISIBILITY_CSS = `
body .modal.mod-settings select.dropdown:not(.is-measuring) {
	opacity: 1 !important;
}
`;

const VIEWPORTS = [
	{ name: "desktop-1280", width: 1280, height: 900, mobileShell: false, stackedSettings: false },
	{ name: "desktop-768", width: 768, height: 900, mobileShell: false, stackedSettings: true },
	{ name: "mobile-content-375", width: 375, height: 812, mobileShell: true, stackedSettings: true }
];

const THEMES = ["light", "dark"];
const SCREENSHOT_STAGES = [
	{ id: "transcription", section: "转写服务", providerSetting: "服务商" },
	{ id: "analysis", section: "模型配置", providerSetting: "分析服务商" },
	{ id: "memory", section: "模型配置", providerSetting: "记忆服务商" }
];

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function compareVersions(left, right) {
	const leftParts = left.split(".").map(Number);
	const rightParts = right.split(".").map(Number);
	for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
		const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

async function requirePath(targetPath, description) {
	try {
		await stat(targetPath);
	} catch {
		throw new Error(`${description}不存在：${targetPath}`);
	}
}

async function findLatestObsidianAsar() {
	if (process.env.OBSIDIAN_ASAR_PATH) {
		const explicitPath = path.resolve(process.env.OBSIDIAN_ASAR_PATH);
		await requirePath(explicitPath, "OBSIDIAN_ASAR_PATH");
		const match = path.basename(explicitPath).match(/^obsidian-(\d+\.\d+\.\d+)\.asar$/);
		assert(match, "OBSIDIAN_ASAR_PATH 必须指向 obsidian-x.y.z.asar");
		return { path: explicitPath, version: match[1] };
	}

	await requirePath(OBSIDIAN_DATA_DIR, "Obsidian 数据目录");
	const candidates = (await readdir(OBSIDIAN_DATA_DIR))
		.map((fileName) => ({
			fileName,
			match: fileName.match(/^obsidian-(\d+\.\d+\.\d+)\.asar$/)
		}))
		.filter((candidate) => candidate.match)
		.map((candidate) => ({
			path: path.join(OBSIDIAN_DATA_DIR, candidate.fileName),
			version: candidate.match[1]
		}))
		.sort((left, right) => compareVersions(right.version, left.version));

	assert(
		candidates.length > 0,
		`未在 ${OBSIDIAN_DATA_DIR} 找到 obsidian-x.y.z.asar，请先启动并更新 Obsidian`
	);
	return candidates[0];
}

async function validateWorkspace() {
	const manifestPath = path.join(PROJECT_ROOT, "manifest.json");
	const pluginInstallPath = path.join(TEST_VAULT, ".obsidian/plugins", PLUGIN_ID);
	const communityPluginsPath = path.join(TEST_VAULT, ".obsidian/community-plugins.json");

	await Promise.all([
		requirePath(OBSIDIAN_BINARY, "Obsidian 可执行文件"),
		requirePath(manifestPath, "插件 manifest"),
		requirePath(path.join(PROJECT_ROOT, "main.js"), "插件构建产物 main.js"),
		requirePath(path.join(PROJECT_ROOT, "styles.css"), "插件样式 styles.css"),
		requirePath(pluginInstallPath, "测试 Vault 插件目录"),
		requirePath(communityPluginsPath, "测试 Vault 插件启用列表")
	]);

	const [projectRealPath, installRealPath] = await Promise.all([
		realpath(PROJECT_ROOT),
		realpath(pluginInstallPath)
	]);
	assert(
		projectRealPath === installRealPath,
		`测试 Vault 的 ${PLUGIN_ID} 未指向当前工程：${pluginInstallPath}`
	);

	const enabledPlugins = JSON.parse(await readFile(communityPluginsPath, "utf8"));
	assert(Array.isArray(enabledPlugins), `${communityPluginsPath} 必须是 JSON 数组`);
	assert(enabledPlugins.includes(PLUGIN_ID), `测试 Vault 尚未启用 ${PLUGIN_ID}`);

	return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function prepareOutputDirectory() {
	await mkdir(OUTPUT_DIR, { recursive: true });
	const entries = await readdir(OUTPUT_DIR, { withFileTypes: true });
	await Promise.all(
		entries
			.filter(
				(entry) =>
					entry.isFile() &&
					(entry.name === "summary.json" || /^(?:settings|getting-started|task-center|memory-review|memory-relation|memory-context)-[a-z0-9-]+\.png$/.test(entry.name))
			)
			.map((entry) => rm(path.join(OUTPUT_DIR, entry.name), { force: true }))
	);
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "无法分配本地 CDP 端口");
	const { port } = address;
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

async function startMemoryProviderMock() {
	const calls = [];
	let failSecondChunkOnce = true;
	const server = createHttpServer((request, response) => {
		const bodyChunks = [];
		request.on("data", (chunk) => bodyChunks.push(chunk));
		request.on("end", () => {
			try {
				assert(request.method === "POST", "Memory mock 只接受 POST");
				assert(request.url === "/v1/chat/completions", `Memory mock 收到未知路径：${request.url}`);
				const body = JSON.parse(Buffer.concat(bodyChunks).toString("utf8"));
				const systemMessage = body.messages?.find((message) => message.role === "system")?.content ?? "";
				const userMessage = body.messages?.find((message) => message.role === "user")?.content ?? "";
				assert(
					systemMessage.includes("evidenceQuote 只能逐字复制 <echo-memory-source> 标签内部的文本"),
					"Memory 系统提示未限定 evidenceQuote 的证据边界"
				);
				assert(
					userMessage.includes("<echo-memory-metadata>") &&
					userMessage.includes("</echo-memory-metadata>") &&
					userMessage.includes("不得作为 evidenceQuote"),
					"Memory 运行元数据未与证据源隔离"
				);
				const chunkMatch = /分块：(\d+)\/(\d+)/.exec(userMessage);
				const sourceMatch = /<echo-memory-source>\n([\s\S]*?)\n<\/echo-memory-source>/.exec(userMessage);
				assert(chunkMatch && sourceMatch, "Memory mock 请求缺少分块或来源数据");
				const chunkIndex = Number(chunkMatch[1]);
				const totalChunks = Number(chunkMatch[2]);
				calls.push({ chunkIndex, totalChunks });
				if (chunkIndex === 2 && failSecondChunkOnce) {
					failSecondChunkOnce = false;
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: "isolated failure" } }));
					return;
				}
				const sourceText = sourceMatch[1];
				const evidenceQuote = sourceText.slice(0, 48).trim();
				const result = {
					assertions: [
						...(chunkIndex === 1 ? [{
							subjectType: "user",
							subjectName: "测试用户",
							category: "background",
							memoryType: "fact",
							proposedTier: "long_term",
							predicate: "身份为",
							value: "本次会话的初始化用户",
							confidence: 0.9,
							evidenceQuote: "初始化用户：测试用户"
						}] : []),
						{
							subjectType: "user",
							subjectName: "测试用户",
							category: "other",
							memoryType: "experience",
							proposedTier: "working",
							predicate: `隔离分块 ${chunkIndex}`,
							value: `已完成第 ${chunkIndex}/${totalChunks} 块验证`,
							confidence: 0.9,
							evidenceQuote
						}
					]
				};
				response.writeHead(200, {
					"content-type": "application/json",
					"x-request-id": `memory-mock-${chunkIndex}`
				});
				response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) } }] }));
			} catch (error) {
				response.writeHead(500, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
			}
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "无法启动 Memory mock 服务");
	return {
		baseUrl: `http://127.0.0.1:${address.port}/v1`,
		calls,
		close: async () => {
			if (!server.listening) {
				return;
			}
			await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	};
}

async function createIsolatedProfile(obsidianAsar) {
	const profileDir = await mkdtemp(path.join(os.tmpdir(), "echo-notes-settings-ui-"));
	const validationVault = path.join(profileDir, "vault");
	const validationPluginDir = path.join(validationVault, ".obsidian/plugins", PLUGIN_ID);
	await mkdir(validationPluginDir, { recursive: true });
	await Promise.all([
		copyFile(path.join(PROJECT_ROOT, "main.js"), path.join(validationPluginDir, "main.js")),
		copyFile(path.join(PROJECT_ROOT, "styles.css"), path.join(validationPluginDir, "styles.css")),
		copyFile(path.join(PROJECT_ROOT, "manifest.json"), path.join(validationPluginDir, "manifest.json")),
		writeFile(
			path.join(validationVault, ".obsidian/community-plugins.json"),
			`${JSON.stringify([PLUGIN_ID], null, "\t")}\n`,
			"utf8"
		),
		writeFile(
			path.join(validationVault, ".obsidian/app.json"),
			`${JSON.stringify({ promptDelete: false }, null, "\t")}\n`,
			"utf8"
		)
	]);

	const vaultId = createHash("sha256").update(validationVault).digest("hex").slice(0, 16);
	const profileConfig = {
		vaults: {
			[vaultId]: {
				path: validationVault,
				ts: Date.now(),
				open: true
			}
		},
		frame: "custom",
		updateDisabled: true
	};

	await writeFile(
		path.join(profileDir, "obsidian.json"),
		`${JSON.stringify(profileConfig, null, "\t")}\n`,
		"utf8"
	);
	await copyFile(obsidianAsar.path, path.join(profileDir, path.basename(obsidianAsar.path)));
	return { profileDir, validationVault };
}

function launchObsidian(profileDir, port) {
	const child = spawn(
		OBSIDIAN_BINARY,
		[
			`--user-data-dir=${profileDir}`,
			`--remote-debugging-port=${port}`,
			"--window-size=1280,900",
			"--no-first-run"
		],
		{
			cwd: PROJECT_ROOT,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"]
		}
	);
	let output = "";
	const capture = (chunk) => {
		output = `${output}${chunk.toString()}`.slice(-20_000);
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	return { child, getOutput: () => output.trim() };
}

async function waitForObsidianPage(port, child) {
	const endpoint = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + STARTUP_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`隔离 Obsidian 提前退出，退出码 ${child.exitCode}`);
		}
		try {
			const response = await fetch(`${endpoint}/json/list`);
			if (response.ok) {
				const targets = await response.json();
				if (targets.some((target) => target.type === "page" && target.url === "app://obsidian.md/index.html")) {
					return endpoint;
				}
			}
		} catch {
			// Renderer 启动期间端口暂不可用，继续轮询。
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`等待 Obsidian CDP renderer 超时（${STARTUP_TIMEOUT_MS} ms）`);
}

async function reloadPlugin(page) {
	await page.waitForFunction(
		() => Boolean(window.app?.plugins && window.app?.setting),
		undefined,
		{ timeout: STARTUP_TIMEOUT_MS }
	);
	await page.waitForFunction(
		(pluginId) => Boolean(window.app?.workspace?.layoutReady && window.app?.plugins?.manifests?.[pluginId]),
		PLUGIN_ID,
		{ timeout: STARTUP_TIMEOUT_MS }
	);
	const result = await page.evaluate(async (pluginId) => {
		const obsidianApp = window.app;
		if (!obsidianApp.plugins.plugins[pluginId]) {
			await obsidianApp.plugins.setEnable(true);
			await obsidianApp.plugins.enablePluginAndSave(pluginId);
		}
		return {
			manifest: Boolean(obsidianApp.plugins.manifests[pluginId]),
			loaded: Boolean(obsidianApp.plugins.plugins[pluginId]),
			enabled: obsidianApp.plugins.isEnabled(pluginId)
		};
	}, PLUGIN_ID);
	assert(
		result.manifest && result.loaded && result.enabled,
		`Echo Notes 重载后未处于启用状态：${JSON.stringify(result)}`
	);
}

async function openSettings(page) {
	await disableSettingsPopout(page);
	await page.addStyleTag({ content: DROPDOWN_VISIBILITY_CSS });
	await page.evaluate(async (pluginId) => {
		window.app.setting.open();
		await window.app.setting.openTabById(pluginId);
	}, PLUGIN_ID);
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
}

async function disableSettingsPopout(page) {
	await page.evaluate(() => {
		const setting = window.app.setting;
		if (setting && typeof setting.shouldUsePopout === "function") {
			// Obsidian 1.13+ opens Settings in a separate popout window on desktop.
			// For automated UI verification, force it back to the in-window modal so the
			// existing page-based assertions and screenshots work without needing to
			// attach to a second renderer target.
			setting.shouldUsePopout = () => false;
		}
	});
}

async function captureGettingStartedInitialLayouts(page) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const metrics = await page.evaluate(() => {
				const taskCenter = document.querySelector(".echo-notes-task-center");
				const guide = taskCenter?.querySelector(".echo-notes-getting-started-guide");
				const tabs = [...(taskCenter?.querySelectorAll('[role="tab"]') ?? [])];
				const steps = [...(guide?.querySelectorAll(".echo-notes-getting-started-progress-step") ?? [])];
				const guideRect = guide?.getBoundingClientRect();
				return {
					innerWidth: window.innerWidth,
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					taskCenterOverflow: taskCenter
						? taskCenter.scrollWidth - taskCenter.clientWidth
						: Number.POSITIVE_INFINITY,
					guideOverflow: guide ? guide.scrollWidth - guide.clientWidth : Number.POSITIVE_INFINITY,
					guideFits: Boolean(guideRect) && guideRect.left >= -1 && guideRect.right <= window.innerWidth + 1,
					stepCount: steps.length,
					stepsFit: steps.every((step) => step.scrollWidth <= step.clientWidth + 1),
					modalCount: document.querySelectorAll(".echo-notes-getting-started-modal-shell").length,
					tabLabels: tabs.map((tab) => tab.textContent?.trim()),
					selectedTab: tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent?.trim(),
					taskCardCount: taskCenter?.querySelectorAll(".echo-notes-task-card").length ?? 0
				};
			});
			const context = `getting-started/${viewport.name}/${theme}`;
			assert(metrics.innerWidth === viewport.width, `${context} 的 viewport 宽度不匹配`);
			assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
			assert(metrics.taskCenterOverflow <= 1, `${context} 任务中心出现横向溢出`);
			assert(metrics.guideOverflow <= 1 && metrics.guideFits, `${context} 新人边栏超出可视区域`);
			assert(metrics.stepCount === 3 && metrics.stepsFit, `${context} 三阶段边栏布局不完整`);
			assert(metrics.modalCount === 0, `${context} 仍出现新人弹窗`);
			assert(
				JSON.stringify(metrics.tabLabels) === JSON.stringify(["新人指引", "任务列表"]) &&
				metrics.selectedTab === "新人指引" &&
				metrics.taskCardCount === 0,
				`${context} 未只显示新人指引：${JSON.stringify(metrics)}`
			);
			const fileName = `getting-started-initial-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".echo-notes-task-center").screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 5_000, `${fileName} 截图可能为空白`);
			results.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}
	return results;
}

async function captureTaskCenterLayouts(page) {
	await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.__taskCenterUiOriginalTasks = plugin.taskCenter.getTasks();
		const now = Date.now();
		plugin.taskCenter.restoreTasks([
			{
				id: "ui-running-transcription",
				kind: "transcription",
				title: "转写产品评审录音",
				status: "running",
				stage: "正在转写第 2/4 段",
				provider: "siliconflow",
				model: "FunAudioLLM/SenseVoiceSmall",
				targetPath: "Echo Notes/Transcripts/2026-08-10-产品评审会议-长文件名.transcript.md",
				sourcePath: "01 项目/录音/2026-08-10-产品评审会议-长文件名.m4a",
				bytes: 18_874_368,
				currentSegment: 2,
				totalSegments: 4,
				traceId: "trace-ui-running-20260810",
				createdAt: now - 94_000,
				updatedAt: now
			},
			{
				id: "ui-failed-analysis",
				kind: "analysis",
				title: "生成产品评审纪要",
				status: "failed",
				stage: "等待 AI 分析返回",
				provider: "aliyun-bailian",
				model: "deepseek-v4-pro",
				targetPath: "Echo Notes/Transcripts/2026-08-10-产品评审会议-长文件名.transcript.md",
				sourcePath: "Echo Notes/Transcripts/2026-08-10-产品评审会议-长文件名.transcript.md",
				error: "请求超时，请检查网络与服务商配置后重试。",
				traceId: "trace-ui-failed-20260810",
				createdAt: now - 420_000,
				updatedAt: now - 1_000,
				completedAt: now - 1_000
			},
			{
				id: "ui-success-memory",
				kind: "memory",
				title: "提取候选记忆",
				status: "success",
				stage: "3 条候选记忆已写入",
				provider: "aliyun-bailian",
				model: "deepseek-v4-pro",
				targetPath: "Echo Memory/Candidates/2026-08-10-产品评审会议.md",
				outputPath: "Echo Memory/Candidates/2026-08-10-产品评审会议.md",
				createdAt: now - 620_000,
				updatedAt: now - 2_000,
				completedAt: now - 2_000
			}
		]);
	}, PLUGIN_ID);

	const taskCenter = page.locator(".echo-notes-task-center");
	await taskCenter.getByRole("tab", { name: "任务列表", exact: true }).click();
	await taskCenter.locator(".echo-notes-task-card").first().waitFor({ state: "visible" });
	await taskCenter.getByRole("tab", { name: "任务列表", exact: true }).press("ArrowLeft");
	await taskCenter.locator(".echo-notes-getting-started-guide").waitFor({ state: "visible" });
	await page.waitForFunction(() => document.activeElement?.id === "echo-notes-task-center-tab-guide");
	await taskCenter.getByRole("tab", { name: "新人指引", exact: true }).press("ArrowRight");
	await taskCenter.locator(".echo-notes-task-card").first().waitFor({ state: "visible" });
	await page.waitForFunction(() => document.activeElement?.id === "echo-notes-task-center-tab-tasks");
	const results = [];
	for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await taskCenter.locator(".echo-notes-task-details").first().evaluate((details) => {
				details.open = true;
			});
			const metrics = await page.evaluate(() => {
				const center = document.querySelector(".echo-notes-task-center");
				const cards = [...(center?.querySelectorAll(".echo-notes-task-card") ?? [])];
				const cardLayouts = cards.map((card) => {
					const main = card.querySelector(".echo-notes-task-card-main");
					const actions = card.querySelector(".echo-notes-task-card-actions");
					const mainRect = main?.getBoundingClientRect();
					const actionsRect = actions?.getBoundingClientRect();
					return {
						flow: getComputedStyle(card).flexDirection,
						actionsBelowContent: Boolean(mainRect && actionsRect) && actionsRect.top >= mainRect.bottom - 1
					};
				});
				const statuses = [...(center?.querySelectorAll(".echo-notes-task-status.echo-notes-status-indicator") ?? [])];
				const pathValues = [...(center?.querySelectorAll(".echo-notes-task-meta-item.is-path .echo-notes-task-meta-value") ?? [])];
				const tabs = [...(center?.querySelectorAll('[role="tab"]') ?? [])];
				return {
					innerWidth: window.innerWidth,
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					centerOverflow: center ? center.scrollWidth - center.clientWidth : Number.POSITIVE_INFINITY,
					cardCount: cards.length,
					cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
					cardLayouts,
					selectedTab: tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent?.trim(),
					selectedTabControlsPanel: tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.getAttribute("aria-controls"),
					visiblePanelId: center?.querySelector('[role="tabpanel"]:not([hidden])')?.id,
					guideCount: center?.querySelectorAll(".echo-notes-getting-started-guide").length ?? 0,
					statusCount: statuses.length,
					statusTones: statuses.map((status) => status.getAttribute("data-status-tone")),
					statusesComplete: statuses.every((status) =>
						Boolean(status.querySelector(".echo-notes-status-indicator-icon svg")) &&
						Boolean(status.querySelector(".echo-notes-status-indicator-text")?.textContent?.trim())
					),
					detailOpen: Boolean(center?.querySelector(".echo-notes-task-details[open]")),
					pathValues: pathValues.map((value) => value.textContent?.trim()),
					pathTitles: pathValues.map((value) => value.getAttribute("title")),
					diagnosticExportButtonCount: center?.querySelectorAll('[aria-label="导出诊断包"]').length ?? 0
				};
			});
			const context = `task-center/${viewport.name}/${theme}`;
			assert(metrics.innerWidth === viewport.width, `${context} 的 viewport 宽度不匹配`);
			assert(metrics.documentOverflow <= 1 && metrics.centerOverflow <= 1, `${context} 出现横向溢出`);
			assert(metrics.cardCount === 3 && metrics.cardsFit, `${context} 任务卡片尺寸异常`);
			assert(
				metrics.cardLayouts.every((layout) => layout.flow === "column" && layout.actionsBelowContent),
				`${context} 窄任务中心仍将操作按钮挤在正文右侧：${JSON.stringify(metrics.cardLayouts)}`
			);
			assert(
				metrics.selectedTab === "任务列表" &&
				metrics.selectedTabControlsPanel === metrics.visiblePanelId &&
				metrics.guideCount === 0,
				`${context} 页签 ARIA 或分区显隐错误：${JSON.stringify(metrics)}`
			);
			assert(
				metrics.statusCount === 3 &&
				metrics.statusesComplete &&
				JSON.stringify(metrics.statusTones) === JSON.stringify(["running", "failed", "success"]),
				`${context} 状态未同时包含图标和文字：${JSON.stringify(metrics)}`
			);
			assert(metrics.detailOpen, `${context} 任务详情未能展开`);
			assert(metrics.diagnosticExportButtonCount === 3, `${context} 未为每张任务卡提供导出诊断包操作`);
			assert(
				metrics.pathValues.every((value) => value && !value.includes("/")) &&
				metrics.pathTitles.every((value) => value?.includes("/")),
				`${context} 路径摘要或完整路径提示不正确：${JSON.stringify(metrics)}`
			);
			const fileName = `task-center-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await taskCenter.screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 5_000, `${fileName} 截图可能为空白`);
			results.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}

	await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.taskCenter.restoreTasks(plugin.__taskCenterUiOriginalTasks ?? []);
		delete plugin.__taskCenterUiOriginalTasks;
	}, PLUGIN_ID);
	await taskCenter.getByRole("tab", { name: "新人指引", exact: true }).click();
	await taskCenter.locator(".echo-notes-getting-started-guide").waitFor({ state: "visible" });
	return results;
}

async function verifyDiagnosticPackageUi(page) {
	const layouts = [];
	await page.locator('[data-settings-stage="transcription"]').click();
	await getActivePanel(page).getByRole("tab", { name: "自动化与日志", exact: true }).click();
	const setting = await getActiveSetting(page, "保留脱敏诊断记录");
	assert(await setting.isVisible(), "自动化与日志中未显示诊断留存设置");
	assert(await setting.getByRole("button", { name: "导出近期诊断包", exact: true }).isVisible(), "未显示近期诊断包导出按钮");
	assert(await setting.locator('[aria-label="清空已保存的诊断记录"]').isVisible(), "未显示清空诊断记录操作");

	await setting.getByRole("button", { name: "导出近期诊断包", exact: true }).click();
	const modal = page.locator(".modal").filter({ hasText: "导出 Echo Notes 诊断包" });
	await modal.waitFor({ state: "visible" });
	assert(await modal.getByText("不会自动上传", { exact: false }).isVisible(), "导出弹窗缺少本地生成说明");
	assert(await modal.getByText("音频、API Key、鉴权头", { exact: false }).isVisible(), "导出弹窗缺少隐私确认说明");
	const toggles = modal.locator('input[type="checkbox"]');
	assert(await toggles.count() === 3, "导出弹窗必须提供三项独立的可选内容开关");
	for (let index = 0; index < await toggles.count(); index += 1) {
		assert(!(await toggles.nth(index).isChecked()), "诊断包的可选内容必须默认关闭");
	}
	await modal.getByRole("button", { name: "取消", exact: true }).click();
	await modal.waitFor({ state: "hidden" });
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		await plugin.exportDiagnosticPackage({
			includeTranscript: false,
			includeAnalyses: false,
			includeMemoryCandidate: false
		});
	}, PLUGIN_ID);
	const completedModal = page.locator(".modal").filter({ hasText: "诊断包已生成" });
	await completedModal.waitFor({ state: "visible" });
	const expectedRevealLabel = process.platform === "darwin"
		? "在访达中打开"
		: process.platform === "win32"
			? "在文件资源管理器中打开"
			: "在文件管理器中打开";
	assert(
		await completedModal.getByRole("button", { name: expectedRevealLabel, exact: true }).isVisible(),
		`诊断包完成弹窗未显示 ${expectedRevealLabel} 操作`
	);
	assert(
		await completedModal.getByText("会在系统文件管理器中定位并选中此诊断包。", { exact: true }).isVisible(),
		"诊断包完成弹窗未说明定位行为"
	);
	await completedModal.getByRole("button", { name: "关闭", exact: true }).click();
	await completedModal.waitFor({ state: "hidden" });

	for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await page.locator('[data-settings-stage="transcription"]').click();
			await getActivePanel(page).getByRole("tab", { name: "自动化与日志", exact: true }).click();
			const metrics = await setting.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const parent = element.closest(".echo-notes-settings-section-panel");
				return {
					settingWidth: rect.width,
					settingOverflow: element.scrollWidth - element.clientWidth,
					panelOverflow: parent ? parent.scrollWidth - parent.clientWidth : Number.POSITIVE_INFINITY,
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
				};
			});
			const context = `diagnostic-package/${viewport.name}/${theme}`;
			assert(metrics.settingWidth > 0, `${context} 未渲染诊断留存设置`);
			assert(metrics.settingOverflow <= 1 && metrics.panelOverflow <= 1 && metrics.documentOverflow <= 1, `${context} 出现横向溢出`);
			const fileName = `settings-diagnostic-package-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
			layouts.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}
	return layouts;
}

async function verifyRealtimeStatusIndicator(page) {
	const metrics = await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const originalRecording = plugin.activeRealtimeRecording;
		if (originalRecording) {
			throw new Error("实时录音状态 UI fixture 发现已有活动录音");
		}
		plugin.activeRealtimeRecording = {
			startedAt: Date.now() - 7_000,
			streamingState: { connectionStatus: "测试连接" }
		};
		plugin.updateRealtimeUi();
		const statusEl = plugin.realtimeStatusEl;
		const result = {
			visible: Boolean(statusEl) && statusEl.style.display !== "none",
			tone: statusEl?.getAttribute("data-status-tone"),
			hasIcon: Boolean(statusEl?.querySelector(".echo-notes-status-indicator-icon svg")),
			text: statusEl?.querySelector(".echo-notes-status-indicator-text")?.textContent?.trim() ?? ""
		};
		plugin.activeRealtimeRecording = originalRecording;
		plugin.updateRealtimeUi();
		return result;
	}, PLUGIN_ID);
	assert(metrics.visible, "实时录音状态栏 fixture 未显示");
	assert(metrics.tone === "running", `实时录音状态栏未使用进行中状态：${JSON.stringify(metrics)}`);
	assert(metrics.hasIcon && metrics.text, `实时录音状态栏缺少图标或文字：${JSON.stringify(metrics)}`);
	return metrics;
}

async function captureGettingStartedGuideLayouts(page, phase) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const taskCenter = page.locator(".echo-notes-task-center");
			await taskCenter.waitFor({ state: "visible" });
			const metrics = await page.evaluate(() => {
				const content = document.querySelector(".echo-notes-getting-started-guide");
				const steps = [...(content?.querySelectorAll(".echo-notes-getting-started-progress-step") ?? [])];
				const buttons = [...(content?.querySelectorAll("button") ?? [])];
				const contentRect = content?.getBoundingClientRect();
				return {
					innerWidth: window.innerWidth,
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
					contentFits: Boolean(contentRect) && contentRect.left >= -1 && contentRect.right <= window.innerWidth + 1,
					stepCount: steps.length,
					stepsFit: steps.every((step) => step.scrollWidth <= step.clientWidth + 1),
					buttonsFit: buttons.every((button) => {
						const rect = button.getBoundingClientRect();
						return Boolean(contentRect && rect.left >= contentRect.left - 1 && rect.right <= contentRect.right + 1);
					}),
					hotkeyRowsFit: [...(content?.querySelectorAll(".echo-notes-getting-started-hotkey-row") ?? [])]
						.every((row) => row.scrollWidth <= row.clientWidth + 1)
				};
			});
			const context = `getting-started-${phase}/${viewport.name}/${theme}`;
			assert(metrics.innerWidth === viewport.width, `${context} 的 viewport 宽度不匹配`);
			assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
			assert(metrics.contentOverflow <= 1, `${context} 新人边栏内容出现横向溢出`);
			assert(metrics.contentFits, `${context} 新人边栏超出 viewport`);
			assert(metrics.stepCount === 3 && metrics.stepsFit, `${context} 三阶段进度布局不完整`);
			assert(metrics.buttonsFit && metrics.hotkeyRowsFit, `${context} 控件超出新人边栏`);
			const fileName = `getting-started-${phase}-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await taskCenter.screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 5_000, `${fileName} 截图可能为空白`);
			results.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}
	return results;
}

async function inspectSettingsSpotlight(
	page,
	{
		targetName,
		stepLabel,
		actionLabel,
		actionDisabled = false,
		secondaryActionLabel = null,
		expectFocus = true
	}
) {
	const layer = page.locator(".echo-notes-settings-spotlight-layer");
	await layer.waitFor({ state: "visible" });
	if (expectFocus) {
		await page.waitForFunction((expectedTargetName) => {
			const target = document.querySelector(`[data-echo-notes-guide-target="${expectedTargetName}"]`);
			const popover = document.querySelector(".echo-notes-settings-spotlight-popover");
			return Boolean(
				document.activeElement &&
				((target?.contains(document.activeElement) ?? false) || (popover?.contains(document.activeElement) ?? false))
			);
		}, targetName);
	}
	await page.waitForFunction((expectedTargetName) => {
		const target = document.querySelector(`[data-echo-notes-guide-target="${expectedTargetName}"]`);
		const popover = document.querySelector(".echo-notes-settings-spotlight-popover");
		const targetRect = target?.getBoundingClientRect();
		const popoverRect = popover?.getBoundingClientRect();
		if (!target || !targetRect || !popoverRect) {
			return false;
		}
		const targetCenterElement = document.elementFromPoint(
			targetRect.left + targetRect.width / 2,
			targetRect.top + targetRect.height / 2
		);
		return Boolean(
			targetRect.width > 0 &&
			targetRect.height > 0 &&
			targetRect.bottom > 0 &&
			targetRect.top < window.innerHeight &&
			targetCenterElement &&
			(target.contains(targetCenterElement) || targetCenterElement.contains(target)) &&
			popoverRect.left >= -1 &&
			popoverRect.right <= window.innerWidth + 1 &&
			popoverRect.top >= -1 &&
			popoverRect.bottom <= window.innerHeight + 1
		);
	}, targetName);
	const metrics = await page.evaluate(
		({ expectedTargetName, expectedStepLabel }) => {
			const spotlightLayers = [...document.querySelectorAll(".echo-notes-settings-spotlight-layer")];
			const spotlightLayer = spotlightLayers[0];
			const popover = spotlightLayer?.querySelector(".echo-notes-settings-spotlight-popover");
			const target = document.querySelector(`[data-echo-notes-guide-target="${expectedTargetName}"]`);
			const action = popover?.querySelector(".echo-notes-settings-spotlight-action");
			const secondaryAction = popover?.querySelector(".echo-notes-settings-spotlight-secondary-action");
			const close = popover?.querySelector(".echo-notes-settings-spotlight-close");
			const footerButtons = [...(popover?.querySelectorAll(".echo-notes-settings-spotlight-footer button") ?? [])];
			const description = popover?.querySelector(".echo-notes-settings-spotlight-description");
			const describedElement = description?.id
				? document.querySelector(`[aria-describedby~="${description.id}"]`)
				: null;
			const targetRect = target?.getBoundingClientRect();
			const popoverRect = popover?.getBoundingClientRect();
			const targetCenterElement = targetRect
				? document.elementFromPoint(
					targetRect.left + targetRect.width / 2,
					targetRect.top + targetRect.height / 2
				)
				: null;
			const overlapWidth = targetRect && popoverRect
				? Math.max(0, Math.min(targetRect.right, popoverRect.right) - Math.max(targetRect.left, popoverRect.left))
				: Number.POSITIVE_INFINITY;
			const overlapHeight = targetRect && popoverRect
				? Math.max(0, Math.min(targetRect.bottom, popoverRect.bottom) - Math.max(targetRect.top, popoverRect.top))
				: Number.POSITIVE_INFINITY;
			return {
				layerCount: spotlightLayers.length,
				maskCount: spotlightLayer?.querySelectorAll(".echo-notes-settings-spotlight-mask").length ?? 0,
				step: spotlightLayer?.getAttribute("data-spotlight-step"),
				stepLabel: popover?.querySelector(".echo-notes-settings-spotlight-step")?.textContent?.trim(),
				targetFound: Boolean(target),
				targetHighlighted: target?.classList.contains("is-echo-notes-spotlight-target") ?? false,
				targetVisible: Boolean(
					targetRect &&
					targetRect.width > 0 &&
					targetRect.height > 0 &&
					targetRect.bottom > 0 &&
					targetRect.top < window.innerHeight
				),
				targetCenterInteractive: Boolean(
					target && targetCenterElement &&
					(target.contains(targetCenterElement) || targetCenterElement.contains(target))
				),
				popoverVisible: Boolean(
					popoverRect &&
					popoverRect.width > 0 &&
					popoverRect.height > 0 &&
					popoverRect.left >= -1 &&
					popoverRect.right <= window.innerWidth + 1 &&
					popoverRect.top >= -1 &&
					popoverRect.bottom <= window.innerHeight + 1
				),
				popoverOverflow: popover ? popover.scrollWidth - popover.clientWidth : Number.POSITIVE_INFINITY,
				targetPopoverOverlap: overlapWidth * overlapHeight,
				targetRect: targetRect ? {
					left: targetRect.left,
					top: targetRect.top,
					right: targetRect.right,
					bottom: targetRect.bottom,
					width: targetRect.width,
					height: targetRect.height
				} : null,
				popoverRect: popoverRect ? {
					left: popoverRect.left,
					top: popoverRect.top,
					right: popoverRect.right,
					bottom: popoverRect.bottom,
					width: popoverRect.width,
					height: popoverRect.height
				} : null,
				viewport: { width: window.innerWidth, height: window.innerHeight },
				actionLabel: action?.textContent?.trim(),
				actionDisabled: action?.hasAttribute("disabled") ?? false,
				secondaryActionLabel: secondaryAction?.textContent?.trim() ?? null,
				footerButtonCount: footerButtons.length,
				footerButtonsFit: footerButtons.every((button) => (
					button.scrollWidth <= button.clientWidth + 1 &&
					button.getBoundingClientRect().right <= (popoverRect?.right ?? Number.NEGATIVE_INFINITY) + 1
				)),
				closeVisible: Boolean(close && close.getBoundingClientRect().width > 0),
				descriptionLinked: Boolean(describedElement && description && describedElement.getAttribute("aria-describedby")?.split(/\s+/).includes(description.id)),
				focusInside: Boolean(
					document.activeElement &&
					((target?.contains(document.activeElement) ?? false) || (popover?.contains(document.activeElement) ?? false))
				),
				documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				expectedStepLabel
			};
		},
		{ expectedTargetName: targetName, expectedStepLabel: stepLabel }
	);
	const context = `Spotlight/${targetName}/${stepLabel}`;
	assert(metrics.layerCount === 1, `${context} 应只有一个引导层`);
	assert(metrics.maskCount === 4, `${context} 应使用四块遮罩留出可交互目标`);
	assert(metrics.stepLabel === stepLabel, `${context} 步骤标签不正确：${metrics.stepLabel ?? "缺失"}`);
	assert(metrics.targetFound && metrics.targetHighlighted, `${context} 未解析到稳定引导锚点`);
	assert(metrics.targetVisible && metrics.targetCenterInteractive, `${context} 目标未保持可见、可交互`);
	assert(metrics.popoverVisible && metrics.popoverOverflow <= 1, `${context} 提示卡溢出或不可见`);
	assert(
		metrics.targetPopoverOverlap <= 1,
		`${context} 提示卡遮挡目标控件：${JSON.stringify({
			targetRect: metrics.targetRect,
			popoverRect: metrics.popoverRect,
			viewport: metrics.viewport,
			overlap: metrics.targetPopoverOverlap
		})}`
	);
	assert(metrics.actionLabel === actionLabel, `${context} 操作标签不正确`);
	assert(metrics.actionDisabled === actionDisabled, `${context} 操作可用状态不正确`);
	assert(metrics.secondaryActionLabel === secondaryActionLabel, `${context} 次操作标签不正确`);
	assert(
		metrics.footerButtonCount === (secondaryActionLabel ? 2 : 1),
		`${context} 页脚按钮数量不正确`
	);
	assert(metrics.footerButtonsFit, `${context} 页脚按钮文字裁切或溢出`);
	assert(metrics.closeVisible, `${context} 缺少可见关闭按钮`);
	assert(metrics.descriptionLinked, `${context} aria-describedby 关系无效`);
	if (expectFocus) {
		assert(metrics.focusInside, `${context} 初始焦点未落在目标或提示卡中`);
	}
	assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
	return metrics;
}

async function verifySettingsSpotlightFocusOrder(page, targetName) {
	const target = page.locator(`[data-echo-notes-guide-target="${targetName}"] input[type="password"]`);
	await target.focus();
	for (const expectedSelector of [
		".echo-notes-settings-spotlight-secondary-action",
		".echo-notes-settings-spotlight-action",
		".echo-notes-settings-spotlight-close"
	]) {
		await page.keyboard.press("Tab");
		assert(
			await page.locator(expectedSelector).evaluate((element) => element === document.activeElement),
			`Spotlight 焦点未按预期移动到 ${expectedSelector}`
		);
	}
	await page.keyboard.press("Shift+Tab");
	assert(
		await page.locator(".echo-notes-settings-spotlight-action").evaluate(
			(element) => element === document.activeElement
		),
		"Spotlight Shift+Tab 未返回主操作"
	);
}

async function captureSettingsSpotlightLayouts(page, phase, expectation) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await page.locator(`[data-echo-notes-guide-target="${expectation.targetName}"]`).evaluate((target) => {
				target.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
			});
			await page.waitForTimeout(200);
			const metrics = await inspectSettingsSpotlight(page, { ...expectation, expectFocus: false });
			const fileName = `settings-spotlight-${phase}-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 10_000, `${fileName} 截图可能为空白`);
			results.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}
	return results;
}


async function verifyGettingStarted(page) {
	const guide = page.locator(".echo-notes-getting-started-guide");
	await guide.waitFor({ state: "visible" });
	const semantics = await page.evaluate((pluginId) => {
		const section = document.querySelector(".echo-notes-getting-started-guide");
		const title = section?.querySelector(".echo-notes-getting-started-guide-title");
		const toggle = section?.querySelector(".echo-notes-getting-started-guide-toggle");
		const plugin = window.app.plugins.plugins[pluginId];
		return {
			modalCount: document.querySelectorAll(".echo-notes-getting-started-modal-shell").length,
			title: title?.textContent?.trim(),
			labelledBy: section?.getAttribute("aria-labelledby"),
			titleId: title?.id,
			copy: section?.querySelector(".echo-notes-getting-started-guide-copy")?.textContent?.trim(),
			steps: [...(section?.querySelectorAll(".echo-notes-getting-started-progress-step-copy > span:first-child") ?? [])]
				.map((step) => step.textContent?.trim()),
			expanded: toggle?.getAttribute("aria-expanded"),
			inRightSidebar: Boolean(section?.closest(".mod-right-split")),
			mainLeafCount: document.querySelectorAll(".workspace-split.mod-root .workspace-leaf").length,
			status: plugin.settings.gettingStartedState.status,
			schemaVersion: plugin.settings.gettingStartedState.schemaVersion,
			stateJson: JSON.stringify(plugin.settings.gettingStartedState)
		};
	}, PLUGIN_ID);
	assert(semantics.modalCount === 0, "首次启用不应显示新人弹窗");
	assert(semantics.title === "开始使用 Echo Notes", "新人边栏标题不正确");
	assert(semantics.labelledBy === semantics.titleId && Boolean(semantics.titleId), "新人边栏 ARIA 标题关系无效");
	assert(semantics.copy?.includes("Obsidian SecretStorage"), "新人边栏缺少密钥存储说明");
	assert(
		JSON.stringify(semantics.steps) === JSON.stringify(["第一次转写", "快捷转写与分析", "记忆准入"]),
		"新人边栏三阶段标签不正确"
	);
	assert(semantics.expanded === "true", "未完成新人边栏首次打开时应展开");
	assert(semantics.inRightSidebar && semantics.mainLeafCount > 0, "新人指引未在右侧栏打开或主编辑区不可用");
	assert(semantics.status === "in-progress" && semantics.schemaVersion === 3, "新人状态未迁移到 schema v3");
	assert(!/api.?key|secret|sk-/i.test(semantics.stateJson), "新人状态包含密钥或 Secret 字段");

	const trustButton = page.locator(".modal-container.mod-confirmation:visible")
		.getByRole("button", { name: "信任仓库作者并启用插件", exact: true });
	if (await trustButton.count()) {
		await trustButton.click();
		await page.waitForFunction((pluginId) => Boolean(window.app.plugins.plugins[pluginId]), PLUGIN_ID);
		await page.evaluate(() => window.app.setting.close());
		await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
		await guide.waitFor({ state: "visible" });
	}
	const blockingConfirmations = await page.locator(".modal-container.mod-confirmation:visible").allTextContents();
	assert(blockingConfirmations.length === 0, `新人边栏被意外确认框阻塞：${blockingConfirmations.join(" | ")}`);
	const initialLayouts = await captureGettingStartedInitialLayouts(page);
	await setViewportMode(page, VIEWPORTS[0], "light");
	await guide.getByRole("heading", { name: "配置转写服务", exact: true }).waitFor({ state: "visible" });
	assert(await guide.getByText("0/3", { exact: true }).isVisible(), "新人边栏初始章节进度不正确");
	assert((await page.locator(".echo-notes-getting-started-checklist").count()) === 0, "任务中心旧新人清单仍存在");

	await disableSettingsPopout(page);
	await guide.getByRole("button", { name: "去配置", exact: true }).click();
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
	await inspectSettingsSpotlight(page, {
		targetName: "transcription-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	const providerSpotlightLayouts = await captureSettingsSpotlightLayouts(page, "provider-v2", {
		targetName: "transcription-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await setViewportMode(page, VIEWPORTS[0], "light");
	await page.keyboard.press("Escape");
	await page.locator(".echo-notes-settings-spotlight-layer").waitFor({ state: "detached" });
	assert(await page.locator(".modal.mod-settings").isVisible(), "Escape 不应关闭设置窗口");
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "配置转写服务", exact: true }).waitFor({ state: "visible" });

	await guide.getByRole("button", { name: "去配置", exact: true }).click();
	await inspectSettingsSpotlight(page, {
		targetName: "transcription-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.locator(".echo-notes-settings-spotlight-action").click();
	await inspectSettingsSpotlight(page, {
		targetName: "transcription-api-key",
		stepLabel: "2/2",
		actionLabel: "返回新人指引",
		secondaryActionLabel: "留在设置"
	});
	const apiKeySpotlightLayouts = await captureSettingsSpotlightLayouts(page, "api-key-v2", {
		targetName: "transcription-api-key",
		stepLabel: "2/2",
		actionLabel: "返回新人指引",
		secondaryActionLabel: "留在设置"
	});
	await setViewportMode(page, VIEWPORTS[0], "light");
	await verifySettingsSpotlightFocusOrder(page, "transcription-api-key");
	const stayInSettingsBefore = await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const target = document.querySelector('[data-echo-notes-guide-target="transcription-api-key"]');
		const scrollContainer = document.querySelector(".modal.mod-settings .vertical-tab-content-container");
		return {
			activeStage: plugin.settingTab?.activeSettingsStage,
			activeSection: plugin.settingTab?.activeTranscriptionSettingsSection,
			targetTop: target?.getBoundingClientRect().top,
			scrollTop: scrollContainer?.scrollTop
		};
	}, PLUGIN_ID);
	await page.getByRole("button", { name: "留在设置", exact: true }).click();
	await page.locator(".echo-notes-settings-spotlight-layer").waitFor({ state: "detached" });
	assert(await page.locator(".modal.mod-settings").isVisible(), "留在设置后设置窗口被意外关闭");
	const stayInSettingsAfter = await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const target = document.querySelector('[data-echo-notes-guide-target="transcription-api-key"]');
		const scrollContainer = document.querySelector(".modal.mod-settings .vertical-tab-content-container");
		return {
			activeGuide: plugin.settingTab?.activeSettingsGuide ?? null,
			activeStage: plugin.settingTab?.activeSettingsStage,
			activeSection: plugin.settingTab?.activeTranscriptionSettingsSection,
			targetTop: target?.getBoundingClientRect().top,
			scrollTop: scrollContainer?.scrollTop,
			targetHighlighted: target?.classList.contains("is-echo-notes-spotlight-target") ?? false
		};
	}, PLUGIN_ID);
	assert(
		stayInSettingsAfter.activeGuide === null &&
		stayInSettingsAfter.activeStage === stayInSettingsBefore.activeStage &&
		stayInSettingsAfter.activeSection === stayInSettingsBefore.activeSection &&
		Math.abs((stayInSettingsAfter.targetTop ?? 0) - (stayInSettingsBefore.targetTop ?? 0)) <= 1 &&
		Math.abs((stayInSettingsAfter.scrollTop ?? 0) - (stayInSettingsBefore.scrollTop ?? 0)) <= 1 &&
		!stayInSettingsAfter.targetHighlighted,
		`留在设置未保持当前位置或未清理 Spotlight：${JSON.stringify({
			before: stayInSettingsBefore,
			after: stayInSettingsAfter
		})}`
	);
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "配置转写服务", exact: true }).waitFor({ state: "visible" });
	assert((await page.locator(".echo-notes-settings-spotlight-layer").count()) === 0, "退出设置后仍残留 Spotlight");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		await plugin.saveApiKey(plugin.settings.offlineTranscription.provider, "ui-test-transcription-key");
		plugin.__gettingStartedOriginalRecorderCheck = plugin.isOfficialAudioRecorderEnabled;
		plugin.isOfficialAudioRecorderEnabled = () => false;
		plugin.settings.gettingStartedState = {
			schemaVersion: 3,
			status: "in-progress",
			step: "recorder",
			practiceStage: "idle",
			chapters: {
				first: { outcome: "pending" },
				shortcut: { outcome: "pending" },
				memory: { outcome: "pending" }
			},
			firstShownAt: Date.now()
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "启用 Obsidian 核心录音机", exact: true }).waitFor({ state: "visible" });
	assert(await guide.getByRole("button", { name: "立即启用", exact: true }).isVisible(), "核心录音机步骤缺少启用操作");
	await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.isOfficialAudioRecorderEnabled = () => null;
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	assert(await guide.getByRole("button", { name: "打开核心插件设置", exact: true }).isVisible(), "核心录音机内部 API 缺失时未提供设置降级入口");
	assert(await guide.getByRole("button", { name: "我已手动开启", exact: true }).isVisible(), "核心录音机状态不可读时未提供手动确认");
	assert(await guide.getByRole("button", { name: "重新检测", exact: true }).isVisible(), "核心录音机状态不可读时未提供重新检测");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.isOfficialAudioRecorderEnabled = plugin.__gettingStartedOriginalRecorderCheck;
		delete plugin.__gettingStartedOriginalRecorderCheck;
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			step: "first-practice",
			practiceStage: "idle",
			experienceNotePath: undefined,
			recorderManuallyConfirmedAt: Date.now()
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "任务一：完成第一次转写", exact: true }).waitFor({ state: "visible" });
	await guide.getByRole("button", { name: "跳过此阶段", exact: true }).click();
	assert(
		await guide.getByText("跳过后不会生成本阶段的新人产物，但会解锁下一阶段。之后仍可再学一次。", { exact: true }).isVisible(),
		"第一次点击跳过未显示边栏内确认"
	);
	await guide.getByRole("button", { name: "取消", exact: true }).click();
	assert(await guide.getByRole("button", { name: "跳过此阶段", exact: true }).isVisible(), "取消跳过后未恢复阶段操作");
	const firstPracticeLayouts = await captureGettingStartedGuideLayouts(page, "first-practice");
	await setViewportMode(page, VIEWPORTS[0], "light");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			step: "analysis",
			practiceStage: "idle",
			chapters: {
				...plugin.settings.gettingStartedState.chapters,
				first: { outcome: "completed" }
			},
			experienceNotePath: "Echo Notes 首次体验.md",
			firstAudioPath: "Recordings/first.webm",
			firstTranscriptPath: "Recordings/first.transcript.md",
			firstSuccessfulTranscriptionAt: Date.now(),
			firstChapterAcknowledgedAt: Date.now()
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "配置 AI 分析", exact: true }).waitFor({ state: "visible" });
	await guide.getByRole("button", { name: "去配置", exact: true }).click();
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
	await page.waitForTimeout(100);
	const analysisGuideState = await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		return {
			activeGuide: plugin.settingTab?.activeSettingsGuide ?? null,
			activeStage: plugin.settingTab?.activeSettingsStage ?? null,
			analysisEnabled: plugin.settings.analysisEnabled,
			layerCount: document.querySelectorAll(".echo-notes-settings-spotlight-layer").length,
			enableTargetCount: document.querySelectorAll('[data-echo-notes-guide-target="analysis-enabled"]').length
		};
	}, PLUGIN_ID);
	assert(analysisGuideState.layerCount === 1, `AI 分析配置引导未建立：${JSON.stringify(analysisGuideState)}`);
	await inspectSettingsSpotlight(page, {
		targetName: "analysis-enabled",
		stepLabel: "准备步骤",
		actionLabel: "开启后继续",
		actionDisabled: true
	});
	await page.locator('[data-echo-notes-guide-target="analysis-enabled"] .checkbox-container').click();
	await inspectSettingsSpotlight(page, {
		targetName: "analysis-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.locator(".echo-notes-settings-spotlight-mask").evaluateAll((masks) => {
		const visibleMask = masks.find((mask) => {
			const rect = mask.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}) ?? masks[0];
		visibleMask?.click();
	});
	await page.locator(".echo-notes-settings-spotlight-layer").waitFor({ state: "detached" });
	assert(await page.locator(".modal.mod-settings").isVisible(), "点击 Spotlight 遮罩不应关闭设置窗口");
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "配置 AI 分析", exact: true }).waitFor({ state: "visible" });

	await guide.getByRole("button", { name: "去配置", exact: true }).click();
	await inspectSettingsSpotlight(page, {
		targetName: "analysis-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.locator(".echo-notes-settings-spotlight-action").click();
	await inspectSettingsSpotlight(page, {
		targetName: "analysis-api-key",
		stepLabel: "2/2",
		actionLabel: "返回新人指引",
		secondaryActionLabel: "留在设置"
	});
	await page.keyboard.press("Escape");
	await page.locator(".echo-notes-settings-spotlight-layer").waitFor({ state: "detached" });
	assert(await page.locator(".modal.mod-settings").isVisible(), "API Key 步骤按 Escape 不应关闭设置窗口");
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "配置 AI 分析", exact: true }).waitFor({ state: "visible" });

	const conflictCommandInfo = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		await plugin.saveAnalysisApiKey("ui-test-analysis-key");
		plugin.settings.analysisEnabled = true;
		const template = plugin.settings.analysisTemplates.find((candidate) => candidate.enabled) ?? plugin.settings.analysisTemplates[0];
		template.enabled = true;
		const manager = window.app.hotkeyManager;
		for (const commandId of [
			"audio-recorder:start",
			"audio-recorder:stop",
			`${pluginId}:transcribe-all-audio-files-in-current-note`
		]) {
			manager.setHotkeys(commandId, []);
		}
		const conflictCommand = Object.entries(window.app.commands.commands)
			.find(([commandId]) => !commandId.includes("audio-recorder") && !commandId.includes(pluginId));
		if (conflictCommand) {
			manager.setHotkeys(conflictCommand[0], [{ modifiers: ["Ctrl", "Shift"], key: "R" }]);
		}
		await manager.save();
		plugin.settings.officialRecorderStartHotkey = null;
		plugin.settings.officialRecorderStopHotkey = null;
		plugin.settings.transcribeAllAudioHotkey = null;
		delete plugin.settings.gettingStartedState.hotkeysManuallyConfirmedAt;
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
		return conflictCommand
			? {
				id: conflictCommand[0],
				label: conflictCommand[1]?.name ?? conflictCommand[0],
				hotkeys: manager.getHotkeys(conflictCommand[0])
			}
			: null;
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "配置三组快捷键", exact: true }).waitFor({ state: "visible" });
	assert(
		await guide.getByText(
			"Mac 统一推荐：Control+L 开始录音，Control+S 停止录音，Control+Z 转写。",
			{ exact: true }
		).isVisible(),
		"Mac 新人快捷键推荐提示缺失"
	);
	const recommendedHotkeyLabels = await guide
		.locator(".echo-notes-getting-started-hotkey-capture")
		.allTextContents();
	assert(
		JSON.stringify(recommendedHotkeyLabels) === JSON.stringify(["Ctrl+L", "Ctrl+S", "Ctrl+Z"]),
		`Mac 新人快捷键未按统一组合预填：${JSON.stringify(recommendedHotkeyLabels)}`
	);
	const hotkeyLayouts = await captureGettingStartedGuideLayouts(page, "hotkeys");
	await setViewportMode(page, VIEWPORTS[0], "light");
	const captureButtons = guide.locator(".echo-notes-getting-started-hotkey-capture");
	const captureHotkey = async (index, hotkey) => {
		await captureButtons.nth(index).click();
		await page.waitForFunction(() => document.activeElement?.classList.contains("is-recording"));
		await page.keyboard.press(hotkey);
	};
	await captureHotkey(0, "Control+Shift+R");
	if (conflictCommandInfo) {
		const conflictLocator = guide.locator(".echo-notes-getting-started-hotkey-conflict");
		const conflictText = await conflictLocator.count() > 0 ? await conflictLocator.first().textContent() : null;
		const conflictDebug = await page.evaluate(({ pluginId, commandId }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			const taskCenterView = window.app.workspace.getLeavesOfType("echo-notes-task-center")[0]?.view;
			const draft = taskCenterView?.gettingStartedGuide?.hotkeyDraft ?? null;
			return {
				draft,
				conflicts: draft ? plugin.getGettingStartedHotkeyConflicts(draft) : null,
				commandHotkeys: window.app.hotkeyManager.getHotkeys(commandId)
			};
		}, { pluginId: PLUGIN_ID, commandId: conflictCommandInfo.id });
		assert(
			conflictText?.includes(conflictCommandInfo.label),
			`快捷键草稿未实时显示全局冲突：${JSON.stringify({ conflictCommandInfo, conflictText, conflictDebug })}`
		);
		assert(
			await conflictLocator.first().getAttribute("role") === "status" &&
			await conflictLocator.first().getAttribute("aria-live") === "polite" &&
			await conflictLocator.first().getAttribute("data-status-tone") === "warning" &&
			await conflictLocator.first().locator(".echo-notes-status-indicator-icon svg").count() === 1 &&
			Boolean((await conflictLocator.first().locator(".echo-notes-status-indicator-text").textContent())?.trim()),
			"新人快捷键冲突提示缺少可访问状态播报"
		);
		assert(
			await guide.getByRole("button", { name: "保存并继续", exact: true }).isDisabled(),
			"新人快捷键与其他命令冲突时保存按钮仍可用"
		);
		await page.evaluate(async ({ pluginId, commandId }) => {
			window.app.hotkeyManager.setHotkeys(commandId, []);
			await window.app.hotkeyManager.save();
			window.app.plugins.plugins[pluginId].notifyGettingStartedChanged();
		}, { pluginId: PLUGIN_ID, commandId: conflictCommandInfo.id });
		await conflictLocator.waitFor({ state: "detached" });
	}
	await captureHotkey(1, "Control+Shift+R");
	assert(await guide.getByText("三组快捷键不能重复，请重新录入。", { exact: true }).isVisible(), "重复快捷键未被阻止");
	assert(await guide.getByRole("button", { name: "保存并继续", exact: true }).isDisabled(), "重复快捷键时保存按钮仍可用");
	await captureHotkey(1, "Control+Shift+S");
	await captureHotkey(2, "Control+Shift+T");
	assert(
		await guide.getByRole("button", { name: "保存并继续", exact: true }).isEnabled(),
		"合法新人快捷键组合未恢复保存能力"
	);
	await page.evaluate(() => {
		window.app.hotkeyManager.__echoNotesOriginalSave = window.app.hotkeyManager.save;
		window.app.hotkeyManager.save = async () => {
			throw new Error("模拟快捷键批量保存失败");
		};
	});
	await guide.getByRole("button", { name: "保存并继续", exact: true }).click();
	await page.waitForTimeout(100);
	const rollbackState = await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const commandIds = [
			"audio-recorder:start",
			"audio-recorder:stop",
			`${pluginId}:transcribe-all-audio-files-in-current-note`
		];
		return {
			managerHotkeys: commandIds.map((commandId) => window.app.hotkeyManager.getHotkeys(commandId)),
			settingsHotkeys: [
				plugin.settings.officialRecorderStartHotkey,
				plugin.settings.officialRecorderStopHotkey,
				plugin.settings.transcribeAllAudioHotkey
			]
		};
	}, PLUGIN_ID);
	assert(
		rollbackState.managerHotkeys.every((hotkeys) => hotkeys.length === 0) &&
		rollbackState.settingsHotkeys.every((hotkey) => hotkey === null),
		`快捷键批量保存失败后未完整回滚：${JSON.stringify(rollbackState)}`
	);
	await page.evaluate(() => {
		window.app.hotkeyManager.save = window.app.hotkeyManager.__echoNotesOriginalSave;
		delete window.app.hotkeyManager.__echoNotesOriginalSave;
	});
	await guide.getByRole("button", { name: "保存并继续", exact: true }).click();
	await guide.getByRole("heading", { name: "任务二：快捷转写并生成 AI 分析", exact: true }).waitFor({ state: "visible" });

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			step: "shortcut-practice",
			practiceStage: "waiting-for-shortcut-audio",
			shortcutPracticeStartedAt: Date.now()
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	assert(await guide.getByText("等待你用快捷键开始和停止录音", { exact: true }).isVisible(), "快捷键实操等待状态不正确");
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			practiceStage: "waiting-for-shortcut-transcription",
			shortcutAudioPath: "Recordings/shortcut.webm"
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	assert(
		await guide.getByText(
			"录音已保存，请按 Ctrl+Shift+T 转写当前笔记全部音频",
			{ exact: true }
		).isVisible(),
		"录音保存后未显示具体转写快捷键提示"
	);

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.memoryInitialized = true;
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			step: "memory",
			practiceStage: "idle",
			chapters: {
				first: { outcome: "completed" },
				shortcut: { outcome: "completed" },
				memory: { outcome: "pending" }
			},
			shortcutAudioPath: "Recordings/shortcut.webm",
			shortcutTranscriptPath: "getting-started-ui.transcript.md",
			memorySourceTranscriptPath: "getting-started-ui.transcript.md",
			firstSuccessfulAnalysisAt: Date.now(),
			shortcutChapterAcknowledgedAt: Date.now()
		};
		if (!window.app.vault.getAbstractFileByPath("getting-started-ui.transcript.md")) {
			await window.app.vault.create("getting-started-ui.transcript.md", "# UI 验证转写稿\n\n无敏感内容。\n");
		}
		await plugin.saveMemoryApiKey("");
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "任务三：提取并审核第一份记忆", exact: true }).waitFor({ state: "visible" });
	await guide.getByRole("button", { name: "配置模型连接", exact: true }).click();
	await inspectSettingsSpotlight(page, {
		targetName: "memory-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.locator(".echo-notes-settings-spotlight-close").click();
	await page.locator(".echo-notes-settings-spotlight-layer").waitFor({ state: "detached" });
	assert(await page.locator(".modal.mod-settings").isVisible(), "Spotlight 关闭按钮不应关闭设置窗口");
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "任务三：提取并审核第一份记忆", exact: true }).waitFor({ state: "visible" });

	await guide.getByRole("button", { name: "配置模型连接", exact: true }).click();
	await inspectSettingsSpotlight(page, {
		targetName: "memory-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.evaluate(() => window.app.setting.close());
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "任务三：提取并审核第一份记忆", exact: true }).waitFor({ state: "visible" });

	await guide.getByRole("button", { name: "配置模型连接", exact: true }).click();
	await inspectSettingsSpotlight(page, {
		targetName: "memory-provider",
		stepLabel: "1/2",
		actionLabel: "下一步"
	});
	await page.locator(".echo-notes-settings-spotlight-action").click();
	await inspectSettingsSpotlight(page, {
		targetName: "memory-api-key",
		stepLabel: "2/2",
		actionLabel: "返回新人指引",
		secondaryActionLabel: "留在设置"
	});
	await page.getByRole("button", { name: "返回新人指引", exact: true }).click();
	await page.locator(".modal.mod-settings").waitFor({ state: "detached" });
	await guide.getByRole("heading", { name: "任务三：提取并审核第一份记忆", exact: true }).waitFor({ state: "visible" });
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		await plugin.saveMemoryApiKey("ui-test-memory-key");
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("button", { name: "提取候选记忆", exact: true }).waitFor({ state: "visible" });
	await page.waitForFunction(() => document.querySelectorAll(".notice").length === 0, undefined, { timeout: 10_000 });
	const memoryLayouts = await captureGettingStartedGuideLayouts(page, "memory");
	await setViewportMode(page, VIEWPORTS[0], "light");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			status: "completed",
			step: "completed",
			practiceStage: "completed",
			chapters: {
				first: { outcome: "completed" },
				shortcut: { outcome: "completed" },
				memory: { outcome: "completed" }
			},
			firstSuccessfulMemoryAt: Date.now(),
			memoryCandidatePath: "Echo Memory/Candidates/first.md",
			completedAt: Date.now()
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	assert(await guide.getByText("3/3", { exact: true }).isVisible(), "完成摘要章节进度不正确");
	assert(
		(await guide.getByRole("button", { name: "展开新人指引", exact: true }).getAttribute("aria-expanded")) === "false",
		"三阶段完成后新人边栏未默认折叠"
	);
	await page.evaluate(async (pluginId) => {
		await window.app.commands.executeCommandById(`${pluginId}:open-getting-started`);
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "三阶段新人旅程已结束", exact: true }).waitFor({ state: "visible" });
	assert(
		(await guide.getByRole("button", { name: "收起新人指引", exact: true }).getAttribute("aria-expanded")) === "true",
		"新人指引命令未重新展开完成摘要"
	);
	await guide.getByRole("button", { name: /第一次转写/ }).click();
	await guide.getByRole("heading", { name: "第一次转写已完成", exact: true }).waitFor({ state: "visible" });
	assert(await guide.getByRole("button", { name: "再学一次", exact: true }).isVisible(), "已完成阶段缺少再学一次操作");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.gettingStartedState = {
			...plugin.settings.gettingStartedState,
			chapters: {
				...plugin.settings.gettingStartedState.chapters,
				first: { outcome: "skipped", skippedAt: Date.now() }
			}
		};
		await plugin.saveSettings();
		plugin.notifyGettingStartedChanged();
	}, PLUGIN_ID);
	await guide.getByRole("heading", { name: "第一次转写已跳过", exact: true }).waitFor({ state: "visible" });
	await guide.getByRole("button", { name: "再学一次", exact: true }).click();
	await guide.getByText("正在复习：第一次转写", { exact: true }).waitFor({ state: "visible" });
	assert(await guide.getByRole("button", { name: "结束本次复习", exact: true }).isVisible(), "复习状态缺少退出操作");
	await guide.getByRole("button", { name: "结束本次复习", exact: true }).click();
	await guide.getByRole("heading", { name: "第一次转写已跳过", exact: true }).waitFor({ state: "visible" });
	assert((await page.locator(".echo-notes-getting-started-checklist").count()) === 0, "任务中心仍渲染旧新人清单");
	assert((await page.locator(".echo-notes-getting-started-modal-shell").count()) === 0, "完成阶段仍出现新人弹窗");

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.analysisEnabled = false;
		plugin.settings.gettingStartedState = {
			schemaVersion: 3,
			status: "not-started",
			step: "transcription",
			practiceStage: "idle",
			chapters: {
				first: { outcome: "pending" },
				shortcut: { outcome: "pending" },
				memory: { outcome: "pending" }
			}
		};
		await plugin.saveSettings();
		await plugin.maybeOpenGettingStartedGuide();
	}, PLUGIN_ID);
	await guide.getByRole("button", { name: "稍后", exact: true }).click();
	await guide.waitFor({ state: "detached" });
	const dismissedState = await page.evaluate((pluginId) => ({
		...window.app.plugins.plugins[pluginId].settings.gettingStartedState
	}), PLUGIN_ID);
	assert(dismissedState.status === "dismissed", "稍后操作未持久停止自动提醒");
	await page.evaluate(async (pluginId) => {
		await window.app.plugins.plugins[pluginId].maybeOpenGettingStartedGuide();
	}, PLUGIN_ID);
	assert((await page.locator(".echo-notes-getting-started-guide").count()) === 0, "已稍后的新人边栏被自动重新打开");
	await page.evaluate(async (pluginId) => {
		await window.app.commands.executeCommandById(`${pluginId}:open-getting-started`);
	}, PLUGIN_ID);
	await guide.waitFor({ state: "visible" });
	const resumedState = await page.evaluate((pluginId) => ({
		...window.app.plugins.plugins[pluginId].settings.gettingStartedState
	}), PLUGIN_ID);
	assert(resumedState.status === "in-progress", "新人指引命令未恢复已稍后的流程");
	await guide.getByRole("button", { name: "跳过此阶段", exact: true }).click();
	await guide.getByRole("button", { name: "确认跳过", exact: true }).click();
	await guide.getByRole("heading", { name: "配置 AI 分析", exact: true }).waitFor({ state: "visible" });
	const skippedFirstState = await page.evaluate((pluginId) => ({
		...window.app.plugins.plugins[pluginId].settings.gettingStartedState
	}), PLUGIN_ID);
	assert(skippedFirstState.chapters.first.outcome === "skipped", "确认跳过后未持久化第一阶段状态");
	assert(
		await guide.getByText("1/3", { exact: true }).isVisible(),
		"跳过阶段未计入新人旅程进度"
	);
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.analysisEnabled = false;
		plugin.settings.memoryInitialized = false;
		plugin.settings.memoryEnabled = false;
		await plugin.saveSettings();
		plugin.settingTab?.showDestination("transcription-service");
	}, PLUGIN_ID);

	return {
		initialLayouts,
		guideLayouts: [...firstPracticeLayouts, ...hotkeyLayouts, ...memoryLayouts],
		spotlightLayouts: [...providerSpotlightLayouts, ...apiKeySpotlightLayouts]
	};
}

async function verifyDeclarativeSettingsCompatibility(page) {
	const result = await page.evaluate((pluginId) => {
		const settingTab = window.app.setting.pluginTabs.find((tab) => tab.id === pluginId);
		if (!settingTab || typeof settingTab.getSettingDefinitions !== "function") {
			return { error: "未找到 Echo Notes 设置页声明式定义" };
		}

		const definition = settingTab
			.getSettingDefinitions()
			.find((candidate) => typeof candidate.render === "function");
		if (!definition) {
			return { error: "未找到 Echo Notes 自定义 render 定义" };
		}

		const previousStage = settingTab.activeSettingsStage;
		const previousTranscriptionSection = settingTab.activeTranscriptionSettingsSection;
		settingTab.activeSettingsStage = "transcription";
		settingTab.activeTranscriptionSettingsSection = "service";
		const scratchEl = document.body.createDiv({ cls: "echo-notes-declarative-settings-test" });
		scratchEl.style.position = "fixed";
		scratchEl.style.left = "-10000px";
		scratchEl.style.top = "0";
		scratchEl.style.width = "900px";
		const frameworkStyleEl = document.createElement("style");
		frameworkStyleEl.textContent = `
.echo-notes-declarative-settings-test .setting-item {
	display: grid;
	grid-template-columns: repeat(5, minmax(0, 1fr));
	column-gap: 16px;
	align-items: start;
}`;
		frameworkStyleEl.textContent += `
.echo-notes-declarative-settings-test .echo-notes-settings-shell {
	padding: 0;
	border: 0;
}`;
		document.head.append(frameworkStyleEl);
		const groupEl = scratchEl.createDiv({ cls: "setting-group-list" });
		const beforeEl = groupEl.createDiv({ cls: "echo-notes-framework-sentinel-before" });
		const settingEl = groupEl.createDiv({ cls: "setting-item" });
		const afterEl = groupEl.createDiv({ cls: "echo-notes-framework-sentinel-after" });

		const cleanup = definition.render({ settingEl }, { listEl: groupEl });
		const hostEl = settingEl.querySelector(":scope > .echo-notes-settings-definition-host");
		const introEl = hostEl?.querySelector(".echo-notes-settings-intro");
		const guideEl = hostEl?.querySelector(".echo-notes-settings-intro-guide");
		const workflowEl = hostEl?.querySelector(".echo-notes-settings-workflow");
		const initialPanelEl = hostEl?.querySelector(".echo-notes-settings-panel:not([hidden])");
		const hostRect = hostEl?.getBoundingClientRect();
		const introRect = introEl?.getBoundingClientRect();
		const guideRect = guideEl?.getBoundingClientRect();
		const workflowRect = workflowEl?.getBoundingClientRect();
		const initialPanelRect = initialPanelEl?.getBoundingClientRect();
		const rowStyle = getComputedStyle(settingEl);
		const initial = {
			introCount: settingEl.querySelectorAll(".echo-notes-settings-intro").length,
			workflowCount: settingEl.querySelectorAll(".echo-notes-settings-workflow").length,
			panelCount: settingEl.querySelectorAll(".echo-notes-settings-panel").length,
			directChildCount: settingEl.childElementCount,
			parentPreserved:
				groupEl.contains(beforeEl) &&
				groupEl.contains(settingEl) &&
				groupEl.contains(afterEl) &&
				groupEl.children.length === 3,
			orphanHeading: settingEl.textContent?.includes("Echo Notes settings") ?? false,
			rowClass: settingEl.classList.contains("echo-notes-settings-definition-row"),
			hostClass: hostEl?.classList.contains("echo-notes-settings-definition-host") ?? false,
			hostClassNotOnRow: !settingEl.classList.contains("echo-notes-settings-definition-host"),
			rowDisplay: getComputedStyle(settingEl).display,
			rowBackgroundColor: rowStyle.backgroundColor,
			rowBackgroundImage: rowStyle.backgroundImage,
			rowBorderRadius: rowStyle.borderRadius,
			rowBoxShadow: rowStyle.boxShadow,
			verticalFlow: Boolean(
				introRect &&
				guideRect &&
				workflowRect &&
				initialPanelRect &&
				introRect.bottom <= guideRect.top + 1 &&
				guideRect.bottom <= workflowRect.top + 1 &&
				workflowRect.bottom <= initialPanelRect.top + 1
			),
			panelFillsHost: Boolean(
				hostRect && initialPanelRect && Math.abs(hostRect.width - initialPanelRect.width) <= 1
			)
		};

		const outputTabEl = [...settingEl.querySelectorAll("button.echo-notes-settings-section-tab")]
			.find((button) => button.textContent?.trim() === "输出规则");
		outputTabEl?.click();
		const outputSelectedBeforeRefresh = outputTabEl?.getAttribute("aria-selected") === "true";
		settingEl.querySelector('[data-settings-stage="analysis"]')?.click();
		const analysisSelectedBeforeRefresh =
			settingEl.querySelector('[data-settings-stage="analysis"]')?.getAttribute("aria-selected") === "true";
		const analysisPanelEl = settingEl.querySelector(".echo-notes-settings-panel:not([hidden])");
		const analysisToggleEl = analysisPanelEl?.querySelector(".checkbox-container");
		const analysisPanelRect = analysisPanelEl?.getBoundingClientRect();
		const analysisToggleRect = analysisToggleEl?.getBoundingClientRect();
		const controlContained = Boolean(
			analysisPanelEl &&
			analysisToggleEl &&
			analysisPanelRect &&
			analysisToggleRect &&
			analysisPanelEl.contains(analysisToggleEl) &&
			analysisToggleRect.left >= analysisPanelRect.left - 1 &&
			analysisToggleRect.right <= analysisPanelRect.right + 1 &&
			analysisToggleRect.top >= analysisPanelRect.top - 1 &&
			analysisToggleRect.bottom <= analysisPanelRect.bottom + 1
		);
		if (typeof settingTab.refreshSettings === "function") {
			settingTab.refreshSettings();
		}
		const afterRefresh = {
			introCount: settingEl.querySelectorAll(".echo-notes-settings-intro").length,
			directChildCount: settingEl.childElementCount,
			sameHost: settingEl.querySelector(":scope > .echo-notes-settings-definition-host") === hostEl,
			analysisSelected:
				settingEl.querySelector('[data-settings-stage="analysis"]')?.getAttribute("aria-selected") === "true",
			outputSelected: [...settingEl.querySelectorAll("button.echo-notes-settings-section-tab")]
				.some((button) => button.textContent?.trim() === "输出规则" && button.getAttribute("aria-selected") === "true"),
			parentPreserved:
				groupEl.contains(beforeEl) &&
				groupEl.contains(settingEl) &&
				groupEl.contains(afterEl) &&
				groupEl.children.length === 3
		};

		if (typeof cleanup === "function") {
			cleanup();
		}
		const cleanupResult = {
			hostRemoved: !settingEl.contains(hostEl),
			rowEmpty: settingEl.childElementCount === 0,
			rowClassRemoved: !settingEl.classList.contains("echo-notes-settings-definition-row"),
			activeHostReleased: settingTab.settingsContainerEl === null
		};
		settingTab.activeSettingsStage = previousStage;
		settingTab.activeTranscriptionSettingsSection = previousTranscriptionSection;
		frameworkStyleEl.remove();
		scratchEl.remove();

		return {
			initial,
			analysisSelectedBeforeRefresh,
			outputSelectedBeforeRefresh,
			controlContained,
			afterRefresh,
			cleanupResult
		};
	}, PLUGIN_ID);

	assert(!result.error, result.error ?? "声明式设置兼容验证失败");
	assert(result.initial.introCount === 1, "声明式入口应渲染一个引导区");
	assert(result.initial.workflowCount === 1, "声明式入口应渲染一个工作流");
	assert(result.initial.panelCount === 3, "声明式入口应渲染三个已启用阶段面板");
	assert(result.initial.directChildCount === 1, "声明式框架行应只有一个 Echo Notes 内容根节点");
	assert(result.initial.parentPreserved, "声明式入口不得清空 Obsidian 管理的父分组或相邻节点");
	assert(!result.initial.orphanHeading, "声明式入口不得留下孤立的 Echo Notes settings 标题");
	assert(result.initial.rowClass, "声明式入口缺少框架行兼容样式类");
	assert(result.initial.hostClass, "声明式入口缺少独立内容宿主样式类");
	assert(result.initial.hostClassNotOnRow, "声明式内容宿主不得与 Obsidian 框架行共用同一节点");
	assert(result.initial.rowDisplay === "block", `声明式框架行应为块级布局，实际为 ${result.initial.rowDisplay}`);
	assert(
		result.initial.rowBackgroundColor === "rgba(0, 0, 0, 0)" || result.initial.rowBackgroundColor === "transparent",
		`声明式框架行背景应透明，实际为 ${result.initial.rowBackgroundColor}`
	);
	assert(result.initial.rowBackgroundImage === "none", `声明式框架行不应有背景图片，实际为 ${result.initial.rowBackgroundImage}`);
	assert(result.initial.rowBorderRadius === "0px", `声明式框架行不应有圆角，实际为 ${result.initial.rowBorderRadius}`);
	assert(result.initial.rowBoxShadow === "none", `声明式框架行不应有阴影，实际为 ${result.initial.rowBoxShadow}`);
	assert(result.initial.verticalFlow, "声明式入口的引导区、指引、工作流和面板应纵向排列");
	assert(result.initial.panelFillsHost, "声明式入口的活动面板应填满内容宿主宽度");
	assert(result.analysisSelectedBeforeRefresh, "声明式入口应支持阶段切换");
	assert(result.outputSelectedBeforeRefresh, "声明式入口应支持分类切换");
	assert(result.controlContained, "声明式入口的开关控件应保持在活动面板内");
	assert(result.afterRefresh.introCount === 1, "声明式入口重绘后引导区不得重复");
	assert(result.afterRefresh.directChildCount === 1, "声明式入口重绘后不得重复生成内容宿主");
	assert(result.afterRefresh.sameHost, "声明式入口重绘应复用当前自定义内容宿主");
	assert(result.afterRefresh.analysisSelected, "声明式入口重绘后应保持当前阶段");
	assert(result.afterRefresh.outputSelected, "声明式入口重绘后应保持当前分类");
	assert(result.afterRefresh.parentPreserved, "声明式入口重绘后不得破坏父分组");
	assert(
		result.cleanupResult.hostRemoved &&
			result.cleanupResult.rowEmpty &&
			result.cleanupResult.rowClassRemoved &&
			result.cleanupResult.activeHostReleased,
		"声明式入口卸载时应清理宿主并释放活动容器"
	);

	await page.evaluate(async (pluginId) => {
		window.app.setting.close();
		window.app.setting.open();
		await window.app.setting.openTabById(pluginId);
	}, PLUGIN_ID);
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
}

async function verifySettingsSurface(page) {
	const result = await page.evaluate(() => {
		const wrapper = document.querySelector(".echo-notes-settings-root-wrapper");
		const row = document.querySelector(".echo-notes-settings-definition-row");
		const host = document.querySelector(".echo-notes-settings-definition-host");
		const intro = document.querySelector(".echo-notes-settings-intro-copy");
		const workflow = document.querySelector(".echo-notes-settings-workflow");
		const stepStatuses = [...(workflow?.querySelectorAll(".echo-notes-settings-step-status") ?? [])]
			.map((el) => el.textContent?.trim());
		const activeSteps = [...(workflow?.querySelectorAll('.echo-notes-settings-step.is-active') ?? [])].length;
		const agentStep = document.querySelector('[data-settings-stage="agent"]');

		const wrapperStyle = wrapper ? getComputedStyle(wrapper) : null;
		const rowStyle = row ? getComputedStyle(row) : null;
		return {
			wrapperExists: Boolean(wrapper),
			rowExists: Boolean(row),
			hostExists: Boolean(host),
			wrapperBackground: wrapperStyle?.backgroundColor ?? null,
			wrapperBorderRadius: wrapperStyle?.borderRadius ?? null,
			wrapperBoxShadow: wrapperStyle?.boxShadow ?? null,
			rowBackground: rowStyle?.backgroundColor ?? null,
			rowBorderRadius: rowStyle?.borderRadius ?? null,
			rowPadding: rowStyle?.padding ?? null,
			introText: intro?.textContent?.trim() ?? null,
			stepStatuses,
			activeSteps,
			agentDisabled: agentStep?.disabled ?? null,
			documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
		};
	});

	assert(result.wrapperExists, "Echo Notes 设置未标记 echo-notes-settings-root-wrapper");
	assert(result.hostExists, "Echo Notes 设置根 Host 不存在");
	assert(
		result.wrapperBackground === "rgba(0, 0, 0, 0)",
		`外层 Surface 背景应为透明，当前：${result.wrapperBackground}`
	);
	assert(result.wrapperBorderRadius === "0px", `外层 Surface 圆角应为 0，当前：${result.wrapperBorderRadius}`);
	assert(result.wrapperBoxShadow === "none", `外层 Surface 阴影应为 none，当前：${result.wrapperBoxShadow}`);
	assert(result.rowBackground === "rgba(0, 0, 0, 0)", `Definition Row 背景应为透明，当前：${result.rowBackground}`);
	assert(result.rowBorderRadius === "0px", `Definition Row 圆角应为 0，当前：${result.rowBorderRadius}`);
	assert(result.rowPadding === "0px", `Definition Row padding 应为 0，当前：${result.rowPadding}`);
	assert(result.activeSteps === 1, `应只有一个激活的阶段，当前：${result.activeSteps}`);
	assert(result.agentDisabled === true, "外部 Agent 阶段必须 disabled");
	assert(result.documentOverflow <= 1, `桌面 1280 设置页存在横向溢出：${result.documentOverflow}px`);

	const progressMatch = result.introText?.match(/^(\d+)\/3 个阶段已就绪/);
	if (progressMatch) {
		const completed = Number.parseInt(progressMatch[1], 10);
		assert(completed >= 0 && completed <= 3, `新人阶段进度越界：${completed}/3`);
	}
}

async function verifySurfaceAcrossViewports(page) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const metrics = await page.evaluate(() => {
				const host = document.querySelector(".echo-notes-settings-definition-host");
				const wrapper = document.querySelector(".echo-notes-settings-root-wrapper");
				return {
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					hostOverflow: host ? host.scrollWidth - host.clientWidth : Number.POSITIVE_INFINITY,
					wrapperBackground: wrapper ? getComputedStyle(wrapper).backgroundColor : null,
					wrapperBorderRadius: wrapper ? getComputedStyle(wrapper).borderRadius : null
				};
			});
			assert(
				metrics.documentOverflow <= 1 && metrics.hostOverflow <= 1,
				`${viewport.name}/${theme} 设置页出现横向溢出：document=${metrics.documentOverflow}, host=${metrics.hostOverflow}`
			);
			assert(
				metrics.wrapperBackground === "rgba(0, 0, 0, 0)",
				`${viewport.name}/${theme} 外层 Surface 背景非透明：${metrics.wrapperBackground}`
			);
			assert(metrics.wrapperBorderRadius === "0px", `${viewport.name}/${theme} 外层 Surface 圆角非 0：${metrics.wrapperBorderRadius}`);
			results.push({ viewport: viewport.name, theme, ...metrics });
		}
	}
	return results;
}

async function verifyIntroduction(page) {
	const result = await page.evaluate(() => {
		const intro = document.querySelector(".echo-notes-settings-intro");
		const copy = intro?.querySelector(".echo-notes-settings-intro-copy");
		const guide = document.querySelector(".echo-notes-settings-intro-guide");
		const heading = intro?.querySelector(".echo-notes-settings-intro-title");
		const headingSetting = heading?.closest(".setting-item");
		const titleMark = heading?.querySelector(".echo-notes-settings-intro-title-mark");
		const link = intro?.querySelector(".echo-notes-settings-intro-link");
		const icon = link?.querySelector(".echo-notes-settings-intro-link-icon");
		const gettingStartedAction = intro?.querySelector(".echo-notes-settings-intro-guide-link");
		const gettingStartedSeparator = intro?.querySelector(".echo-notes-settings-intro-link-separator");
		const gettingStartedLabel = gettingStartedAction?.querySelector(".echo-notes-settings-intro-guide-link-label");
		const gettingStartedIcon = gettingStartedAction?.querySelector(".echo-notes-settings-intro-guide-link-icon");
		const separatorStyle = gettingStartedSeparator ? getComputedStyle(gettingStartedSeparator) : null;
		const inlineActionStyle = gettingStartedAction ? getComputedStyle(gettingStartedAction) : null;
		const gettingStartedLabelRect = gettingStartedLabel?.getBoundingClientRect();
		const gettingStartedIconRect = gettingStartedIcon?.getBoundingClientRect();
		const workflow = document.querySelector(".echo-notes-settings-workflow");
		return {
			count: document.querySelectorAll(".echo-notes-settings-intro").length,
			guideCount: document.querySelectorAll(".echo-notes-settings-intro-guide").length,
			title: heading?.textContent?.trim(),
			copy: copy?.firstChild?.textContent?.trim(),
			guide: guide?.textContent?.trim(),
			linkText: link?.firstChild?.textContent?.trim(),
			linkInConcept: link?.parentElement === copy,
			href: link?.getAttribute("href"),
			target: link?.getAttribute("target"),
			rel: link?.getAttribute("rel"),
			iconHidden: icon?.getAttribute("aria-hidden"),
			hasSvg: Boolean(icon?.querySelector("svg")),
			titleIconHidden: titleMark?.getAttribute("aria-hidden"),
			titleHasSvg: Boolean(titleMark?.querySelector("svg")),
			standardHeading: Boolean(
				headingSetting?.classList.contains("setting-item-heading") &&
				headingSetting?.classList.contains("echo-notes-settings-intro-heading") &&
				heading?.classList.contains("setting-item-name")
			),
			gettingStartedAction: gettingStartedAction?.textContent?.trim(),
			gettingStartedInConcept: gettingStartedAction?.parentElement === copy,
			gettingStartedLabelFirst:
				gettingStartedLabel === gettingStartedAction?.firstElementChild,
			gettingStartedIconLast:
				gettingStartedIcon === gettingStartedAction?.lastElementChild,
			gettingStartedWhiteSpace: inlineActionStyle?.whiteSpace,
			gettingStartedVerticalAlign: inlineActionStyle?.verticalAlign,
			gettingStartedLabelIconAligned: Boolean(
				gettingStartedLabelRect &&
				gettingStartedIconRect &&
				Math.abs(
					(gettingStartedLabelRect.top + gettingStartedLabelRect.height / 2) -
					(gettingStartedIconRect.top + gettingStartedIconRect.height / 2)
				) <= 2
			),
			gettingStartedAfterReadme:
				gettingStartedSeparator?.previousElementSibling === link &&
				gettingStartedSeparator?.nextElementSibling === gettingStartedAction,
			gettingStartedIconHidden: gettingStartedIcon?.getAttribute("aria-hidden"),
			gettingStartedIconHasSvg: Boolean(gettingStartedIcon?.querySelector("svg")),
			gettingStartedSpacing:
				Number.parseFloat(separatorStyle?.marginInlineStart ?? "0") >= 6 &&
				Number.parseFloat(separatorStyle?.marginInlineEnd ?? "0") >= 4,
			legacyGettingStartedActionCount: document.querySelectorAll(".echo-notes-settings-intro-action").length,
			spotlightLayerCount: document.querySelectorAll(".echo-notes-settings-spotlight-layer").length,
			headingRelation: intro?.getAttribute("aria-labelledby") === heading?.id,
			correctOrder:
				intro?.nextElementSibling === guide && guide?.nextElementSibling === workflow
		};
	});

	assert(result.count === 1, `引导区数量应为 1，实际为 ${result.count}`);
	assert(result.guideCount === 1, `操作指引数量应为 1，实际为 ${result.guideCount}`);
	const compactIntro = result.title === "Echo Notes 设置";
	assert(compactIntro || result.title === EXPECTED_TITLE, "引导区标题不匹配");
	assert(result.copy === EXPECTED_INTRO, "引导区理念文案不匹配");
	assert(
		compactIntro
			? result.guide === "提示：可使用方向键切换配置阶段。"
			: result.guide === EXPECTED_GUIDE,
		"引导区指引文案不匹配"
	);
	assert(result.linkText === EXPECTED_README_LINK_TEXT, "README 链接文案不匹配");
	assert(result.linkInConcept, "README 链接必须位于理念说明末尾");
	assert(result.href === README_URL, "README 链接地址不匹配");
	assert(result.target === "_blank", "README 链接必须在新窗口打开");
	assert(result.rel === "noopener noreferrer", "README 链接缺少安全 rel 属性");
	assert(result.iconHidden === "true" && result.hasSvg, "外链图标或辅助技术属性不完整");
	assert(result.titleIconHidden === "true" && result.titleHasSvg, "标题图标或辅助技术属性不完整");
	assert(result.standardHeading, "引导区标题必须使用 Obsidian Setting heading 结构");
	assert(result.gettingStartedAction === "新人指引", "设置页缺少内联新人指引入口");
	assert(result.gettingStartedInConcept, "新人指引入口必须位于理念说明内");
	assert(result.gettingStartedLabelFirst, "新人指引文字必须位于图标之前");
	assert(result.gettingStartedIconLast, "新人指引图标必须位于文字之后");
	assert(result.gettingStartedWhiteSpace === "nowrap", "新人指引文字与图标不得在控件内部拆行");
	assert(result.gettingStartedVerticalAlign === "middle", "新人指引内联控件必须使用居中对齐");
	assert(result.gettingStartedLabelIconAligned, "新人指引文字与图标未处于同一水平线");
	assert(result.gettingStartedAfterReadme, "新人指引入口必须紧跟完整设计理念链接");
	assert(
		result.gettingStartedIconHidden === "true" && result.gettingStartedIconHasSvg,
		"新人指引入口缺少小图标或辅助技术属性"
	);
	assert(result.gettingStartedSpacing, "新人指引与前方链接的间距不足");
	assert(result.legacyGettingStartedActionCount === 0, "设置页仍存在占空间的旧新人指引卡片");
	assert(result.spotlightLayerCount === 0, "普通打开设置页不应自动启动 Spotlight");
	assert(result.headingRelation, "引导区 aria-labelledby 关系无效");
	assert(result.correctOrder, "操作指引必须位于理念分割线与工作流步骤轴之间");
}

function getActivePanel(page) {
	return page.locator(".echo-notes-settings-panel:not([hidden]):visible");
}

async function getActiveSetting(page, name) {
	const settingItems = getActivePanel(page).locator(".setting-item:not(.setting-item-heading)");
	for (let index = 0; index < (await settingItems.count()); index += 1) {
		const settingItem = settingItems.nth(index);
		const settingName = (await settingItem.locator(".setting-item-name").textContent())?.trim();
		if (settingName === name) {
			return settingItem;
		}
	}
	throw new Error(`当前分类中未找到设置项：${name}`);
}

async function getSettingsRenderId(page) {
	return page.locator(".echo-notes-settings-intro-title").getAttribute("id");
}

async function waitForSettingsRerender(page, previousRenderId) {
	await page.waitForFunction(
		(previousId) => {
			const heading = document.querySelector(".echo-notes-settings-intro-title");
			return Boolean(heading?.id && heading.id !== previousId);
		},
		previousRenderId
	);
}

async function selectSettingOption(page, name, value) {
	const settingItem = await getActiveSetting(page, name);
	const selectEl = settingItem.locator("select:not([aria-hidden=\"true\"])");
	assert((await selectEl.count()) === 1, `${name} 应包含一个下拉选择器`);
	const previousRenderId = await getSettingsRenderId(page);
	await selectEl.evaluate((element, optionValue) => {
		element.value = optionValue;
		element.dispatchEvent(new Event("change", { bubbles: true }));
		if (element.form) {
			element.form.dispatchEvent(new Event("change", { bubbles: true }));
		}
	}, value);
	await waitForSettingsRerender(page, previousRenderId);
}

async function getSettingOptionValues(page, name) {
	const settingItem = await getActiveSetting(page, name);
	const selectEl = settingItem.locator("select:not([aria-hidden=\"true\"])");
	assert((await selectEl.count()) === 1, `${name} 应包含一个下拉选择器`);
	return selectEl.locator("option").evaluateAll((options) => options.map((option) => option.value));
}

async function getSettingTextValue(page, name) {
	const settingItem = await getActiveSetting(page, name);
	const inputEl = settingItem.locator('input[type="text"]');
	assert((await inputEl.count()) === 1, `${name} 应包含一个文本输入框`);
	return inputEl.inputValue();
}

async function setSettingToggle(page, name, enabled) {
	const settingItem = await getActiveSetting(page, name);
	const toggleEl = settingItem.locator(".checkbox-container");
	const checkboxEl = settingItem.locator('input[type="checkbox"]');
	assert((await toggleEl.count()) === 1 && (await checkboxEl.count()) === 1, `${name} 应包含一个开关`);
	if ((await toggleEl.evaluate((element) => element.classList.contains("is-enabled"))) !== enabled) {
		const previousRenderId = await getSettingsRenderId(page);
		await checkboxEl.evaluate((element) => element.click());
		await waitForSettingsRerender(page, previousRenderId);
		const updatedSettingItem = await getActiveSetting(page, name);
		const updatedEnabled = await updatedSettingItem
			.locator(".checkbox-container")
			.evaluate((element) => element.classList.contains("is-enabled"));
		const settingsState = name === "说话人分离"
			? await page.evaluate((pluginId) => ({
				provider: window.app.plugins.plugins[pluginId].settings.offlineTranscription.provider,
				diarizationEnabled: window.app.plugins.plugins[pluginId].settings.offlineTranscription.aliyunFiletrans?.diarizationEnabled
			}), PLUGIN_ID)
			: null;
		assert(
			updatedEnabled === enabled,
			`${name} 重绘后的开关状态不正确：期望 ${enabled}，实际 ${updatedEnabled}，设置 ${JSON.stringify(settingsState)}`
		);
	}
}

async function verifySettingsHotkeyConflicts(page) {
	await reopenSettings(page);
	const setup = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const manager = window.app.hotkeyManager;
		const targetCommandId = "audio-recorder:start";
		const conflictCommand = Object.entries(window.app.commands.commands)
			.find(([commandId]) => commandId !== targetCommandId && !commandId.includes("audio-recorder"));
		if (!conflictCommand) {
			throw new Error("找不到用于设置页快捷键冲突验收的命令");
		}
		const originalTargetHotkeys = manager.getHotkeys(targetCommandId) ?? [];
		const originalConflictHotkeys = manager.getHotkeys(conflictCommand[0]) ?? [];
		const originalSetting = plugin.settings.officialRecorderStartHotkey;
		const originalTranscriptionMode = plugin.settings.transcriptionMode;
		const originalActiveSettingsStage = plugin.settingTab.activeSettingsStage;
		const originalActiveTranscriptionSettingsSection = plugin.settingTab.activeTranscriptionSettingsSection;
		const originalActiveAnalysisSettingsSection = plugin.settingTab.activeAnalysisSettingsSection;
		manager.setHotkeys(targetCommandId, []);
		manager.setHotkeys(conflictCommand[0], [{ modifiers: ["Ctrl", "Shift"], key: "R" }]);
		await manager.save();
		plugin.settings.officialRecorderStartHotkey = null;
		plugin.settings.transcriptionMode = "offline";
		await plugin.saveSettings();
		plugin.settingTab.showDestination("transcription-recording");
		return {
			targetCommandId,
			conflictCommandId: conflictCommand[0],
			conflictLabel: conflictCommand[1]?.name ?? conflictCommand[0],
			originalTargetHotkeys,
			originalConflictHotkeys,
			originalSetting,
			originalTranscriptionMode,
			originalActiveSettingsStage,
			originalActiveTranscriptionSettingsSection,
			originalActiveAnalysisSettingsSection
		};
	}, PLUGIN_ID);
	await page.evaluate((pluginId) => {
		window.app.plugins.plugins[pluginId].settingTab.showDestination("transcription-recording");
	}, PLUGIN_ID);

	const settingItem = await getActiveSetting(page, "开始录音");
	const captureButton = settingItem.locator('.echo-notes-quick-recording-hotkey-capture');
	const status = settingItem.locator('.echo-notes-hotkey-validation[role="status"]');
	await captureButton.click();
	assert((await captureButton.textContent())?.includes("请按组合键"), "快捷键记录状态不明确");
	await page.keyboard.press("Control+Shift+R");
	assert(
		(await status.getAttribute("aria-live")) === "polite" &&
		(await status.getAttribute("data-status-tone")) === "failed" &&
		(await status.textContent())?.includes(setup.conflictLabel) &&
		await status.locator(".echo-notes-status-indicator-icon svg").count() === 1 &&
		Boolean((await status.locator(".echo-notes-status-indicator-text").textContent())?.trim()),
		"设置页快捷键冲突提示不明确或缺少可访问状态播报"
	);
	assert(
		await page.evaluate(
			(pluginId) => window.app.plugins.plugins[pluginId].settings.officialRecorderStartHotkey,
			PLUGIN_ID
		) === null,
		"冲突快捷键不应覆盖原绑定"
	);
	const bypassResult = await page.evaluate(async ({ pluginId, targetCommandId }) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const manager = window.app.hotkeyManager;
		const beforeManager = manager.getHotkeys(targetCommandId) ?? [];
		const beforeSetting = plugin.settings.officialRecorderStartHotkey;
		const saved = await plugin.setOfficialAudioRecorderStartHotkey({ modifiers: ["Ctrl", "Shift"], key: "R" });
		return {
			saved,
			beforeManager,
			afterManager: manager.getHotkeys(targetCommandId) ?? [],
			beforeSetting,
			afterSetting: plugin.settings.officialRecorderStartHotkey
		};
	}, { pluginId: PLUGIN_ID, targetCommandId: setup.targetCommandId });
	assert(
		bypassResult.saved === false &&
		JSON.stringify(bypassResult.beforeManager) === JSON.stringify(bypassResult.afterManager) &&
		JSON.stringify(bypassResult.beforeSetting) === JSON.stringify(bypassResult.afterSetting),
		`设置页单项保存绕过了冲突校验：${JSON.stringify(bypassResult)}`
	);

	await page.evaluate(async (commandId) => {
		window.app.hotkeyManager.setHotkeys(commandId, []);
		await window.app.hotkeyManager.save();
	}, setup.conflictCommandId);
	const refreshedSettingItem = await getActiveSetting(page, "开始录音");
	const refreshedCaptureButton = refreshedSettingItem.locator('.echo-notes-quick-recording-hotkey-capture');
	await refreshedCaptureButton.click();
	await page.keyboard.press("Escape");
	const cancelledCaptureButton = (await getActiveSetting(page, "开始录音")).locator('.echo-notes-quick-recording-hotkey-capture');
	assert((await cancelledCaptureButton.textContent())?.trim() === "记录热键", "Esc 未取消热键记录或修改原绑定");
	await cancelledCaptureButton.click();
	await page.keyboard.press("Control+Shift+Y");
	await page.waitForFunction((pluginId) => (
		window.app.plugins.plugins[pluginId].settings.officialRecorderStartHotkey?.key === "Y"
	), PLUGIN_ID);
	const savedSettingItem = await getActiveSetting(page, "开始录音");
	const savedCaptureButton = savedSettingItem.locator('.echo-notes-quick-recording-hotkey-capture');
	assert((await savedCaptureButton.textContent())?.trim() === "Ctrl+Shift+Y", "合法快捷键未即时显示");
	const clearButton = savedSettingItem.getByRole("button", { name: "清除“开始录音”快捷键", exact: true });
	await clearButton.click();
	await page.waitForFunction((pluginId) => (
		window.app.plugins.plugins[pluginId].settings.officialRecorderStartHotkey === null
	), PLUGIN_ID);
	assert((await (await getActiveSetting(page, "开始录音")).locator('.echo-notes-quick-recording-hotkey-capture').textContent())?.trim() === "记录热键", "清除后未恢复记录热键状态");

	await page.evaluate(async ({ pluginId, setup }) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const manager = window.app.hotkeyManager;
		manager.setHotkeys(setup.targetCommandId, setup.originalTargetHotkeys);
		manager.setHotkeys(setup.conflictCommandId, setup.originalConflictHotkeys);
		await manager.save();
		plugin.settings.officialRecorderStartHotkey = setup.originalSetting;
		plugin.settings.transcriptionMode = setup.originalTranscriptionMode;
		await plugin.saveSettings();
		plugin.settingTab.activeSettingsStage = setup.originalActiveSettingsStage;
		plugin.settingTab.activeTranscriptionSettingsSection = setup.originalActiveTranscriptionSettingsSection;
		plugin.settingTab.activeAnalysisSettingsSection = setup.originalActiveAnalysisSettingsSection;
		plugin.settingTab.display();
	}, { pluginId: PLUGIN_ID, setup });
}

async function getTemplateGroupState(page) {
	return getActivePanel(page).locator(".echo-notes-template-group").evaluateAll((groups) =>
		groups.map((group) => ({
			category: group.getAttribute("data-template-category"),
			label: group.querySelector(".echo-notes-template-group-title")?.textContent?.trim(),
			count: group.querySelector(".echo-notes-template-group-count")?.textContent?.trim(),
			heading: group.querySelector(".echo-notes-template-group-heading")?.classList.contains("setting-item-heading") ?? false,
			templates: [...group.querySelectorAll(".echo-notes-template-card-title")].map((title) => title.textContent?.trim())
		}))
	);
}

async function getTemplateCategoryTabState(page) {
	return getActivePanel(page).locator(".echo-notes-template-category-tab").evaluateAll((tabs) =>
		tabs.map((tab) => ({
			category: tab.getAttribute("data-template-category-tab"),
			label: tab.querySelector(".echo-notes-template-category-tab-label")?.textContent?.trim(),
			count: tab.querySelector(".echo-notes-template-category-tab-count")?.textContent?.trim(),
			selected: tab.getAttribute("aria-selected") === "true"
		}))
	);
}

async function setTemplateCardToggle(page, templateName, enabled) {
	const card = getActivePanel(page).locator(".echo-notes-template-card").filter({ hasText: templateName });
	assert((await card.count()) === 1, `${templateName} 应匹配一个模板卡片`);
	const toggleEl = card.locator(".checkbox-container");
	const checkboxEl = card.locator('input[type="checkbox"]');
	assert((await toggleEl.count()) === 1 && (await checkboxEl.count()) === 1, `${templateName} 应包含一个直接启用开关`);
	if ((await toggleEl.evaluate((element) => element.classList.contains("is-enabled"))) !== enabled) {
		const previousRenderId = await getSettingsRenderId(page);
		await checkboxEl.evaluate((element) => element.click());
		await waitForSettingsRerender(page, previousRenderId);
	}
	const updatedCard = getActivePanel(page).locator(".echo-notes-template-card").filter({ hasText: templateName });
	assert(
		(await updatedCard.locator(".checkbox-container").evaluate((element) => element.classList.contains("is-enabled"))) === enabled,
		`${templateName} 的直接启用状态不正确`
	);
}

async function verifyTabRelationships(page) {
	const result = await page.evaluate(() => {
		const allIds = [...document.querySelectorAll("[id]")].map((element) => element.id);
		const invalidTabs = [];
		for (const tab of document.querySelectorAll('[role="tab"]')) {
			if (tab instanceof HTMLButtonElement && tab.disabled) {
				if (
					tab.tabIndex !== -1 ||
					tab.getAttribute("aria-disabled") !== "true" ||
					tab.getAttribute("aria-selected") !== "false"
				) {
					invalidTabs.push(`${tab.textContent?.trim()}:disabled-state`);
				}
				continue;
			}

			const controls = tab.getAttribute("aria-controls");
			const panel = controls ? document.getElementById(controls) : null;
			const selected = tab.getAttribute("aria-selected") === "true";
			if (
				!tab.id ||
				!panel ||
				panel.getAttribute("role") !== "tabpanel" ||
				panel.getAttribute("aria-labelledby") !== tab.id ||
				tab.tabIndex !== (selected ? 0 : -1)
			) {
				invalidTabs.push(tab.textContent?.trim() || "未命名 Tab");
			}
		}

		const invalidTablists = [...document.querySelectorAll('[role="tablist"]')]
			.filter((tablist) => tablist.querySelectorAll(':scope > [role="tab"][aria-selected="true"]').length !== 1)
			.map((tablist) => tablist.getAttribute("aria-label") || "未命名 Tablist");

		return {
			duplicateIdCount: allIds.length - new Set(allIds).size,
			invalidTabs,
			invalidTablists
		};
	});

	assert(result.duplicateIdCount === 0, `设置页存在 ${result.duplicateIdCount} 个重复 DOM ID`);
	assert(result.invalidTabs.length === 0, `Tab ARIA 关系无效：${result.invalidTabs.join(" | ")}`);
	assert(result.invalidTablists.length === 0, `Tablist 选中状态无效：${result.invalidTablists.join(" | ")}`);
}

async function verifyTabs(page) {
	const transcriptionTab = page.locator('[data-settings-stage="transcription"]');
	const analysisTab = page.locator('[data-settings-stage="analysis"]');
	const memoryTab = page.locator('[data-settings-stage="memory"]');
	const agentTab = page.locator('[data-settings-stage="agent"]');

	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "首次打开应选中录音转写");
	assert(await agentTab.isDisabled(), "外部 Agent 步骤必须保持禁用");
	assert((await agentTab.getAttribute("tabindex")) === "-1", "外部 Agent 步骤必须移出键盘顺序");
	await verifyTabRelationships(page);

	await analysisTab.click();
	assert(await analysisTab.getAttribute("aria-selected") === "true", "点击后应选中 AI 分析");
	assert(
		(await getActivePanel(page).locator(".echo-notes-settings-section-tabs").count()) === 0,
		"AI 分析关闭时不应显示二级分类"
	);
	await analysisTab.press("Home");
	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "顶层 Home 应切到录音转写");
	await transcriptionTab.press("End");
	assert(await memoryTab.getAttribute("aria-selected") === "true", "顶层 End 应切到记忆提取");
	await memoryTab.press("ArrowLeft");
	assert(await analysisTab.getAttribute("aria-selected") === "true", "记忆提取左方向键应切到 AI 分析");
	await analysisTab.press("ArrowLeft");
	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "顶层左方向键应切换阶段");
	await transcriptionTab.press("ArrowRight");
	assert(await analysisTab.getAttribute("aria-selected") === "true", "顶层右方向键应切换阶段");

	await transcriptionTab.click();
	const activePanel = getActivePanel(page);
	const sectionTabs = activePanel.locator(".echo-notes-settings-section-tab");
	assert((await sectionTabs.allTextContents()).join("|") === "转写服务|能力增强|输出规则|自动化与日志", "转写二级分类不完整");
	const serviceTab = sectionTabs.filter({ hasText: "转写服务" });
	const advancedTab = sectionTabs.filter({ hasText: "能力增强" });
	const outputTab = sectionTabs.filter({ hasText: "输出规则" });
	const automationTab = sectionTabs.filter({ hasText: "自动化与日志" });
	await outputTab.click();
	const outputSelected = await outputTab.getAttribute("aria-selected");
	assert(
		outputSelected === "true",
		`点击后应选中输出规则：${JSON.stringify(await sectionTabs.evaluateAll((tabs) => tabs.map((tab) => ({ text: tab.textContent, selected: tab.getAttribute("aria-selected"), connected: tab.isConnected }))))}`
	);
	await outputTab.press("End");
	assert(await automationTab.getAttribute("aria-selected") === "true", "二级 End 应切到末项");
	await automationTab.press("Home");
	assert(await serviceTab.getAttribute("aria-selected") === "true", "二级 Home 应切回首项");
	await serviceTab.press("ArrowLeft");
	assert(await automationTab.getAttribute("aria-selected") === "true", "二级左方向键应循环切换");
	await automationTab.press("ArrowRight");
	assert(await serviceTab.getAttribute("aria-selected") === "true", "二级右方向键应循环切换");
	assert(
		await activePanel.locator(".echo-notes-settings-section-tabs").evaluate((element) => getComputedStyle(element).position) !== "sticky",
		"转写二级分类不应在滚动时遮挡内容"
	);
	assert(
		JSON.stringify(await getSettingOptionValues(page, "服务商")) ===
			JSON.stringify(["aliyun-bailian", "siliconflow", "mosi", "ollama", "lm-studio"]),
		"离线转写服务商的成员或顺序不正确"
	);
	assert(
		JSON.stringify(await getSettingOptionValues(page, "转写模型")) ===
			JSON.stringify(["qwen-audio-3.0-asr-flash-filetrans", "qwen3-asr-flash"]),
		"阿里百炼转写模型选项不完整"
	);
	await advancedTab.click();
	const serviceContext = activePanel.locator('.echo-notes-transcription-context');
	assert(await serviceContext.locator('.echo-notes-transcription-context-provider').count() === 1, "当前服务卡缺少服务商主信息");
	assert(await serviceContext.locator('.echo-notes-transcription-context-model').count() === 1, "当前服务卡缺少模型主信息");
	assert(await serviceContext.locator('.echo-notes-transcription-context-mode').count() === 1, "当前服务卡缺少转写模式标签");
	const capabilityTags = serviceContext.locator('.echo-notes-transcription-context-chip');
	assert(
		JSON.stringify(await capabilityTags.allTextContents()) === JSON.stringify([
			"说话人分离",
			"时间戳",
			"热词增强",
			"上下文增强"
		]),
		"阿里 filetrans 的模型支持 Tag 不正确"
	);
	assert(
		await capabilityTags.evaluateAll((tags) => tags.every((tag) => (
			![...tag.classList].some((className) => className.startsWith("is-")) &&
			tag.getAttribute("role") !== "button" &&
			Boolean(tag.getAttribute("aria-label")?.includes("当前模型支持"))
		))),
		"模型支持 Tag 混入开关状态或缺少可访问名称"
	);
	assert(await serviceContext.locator('.echo-notes-transcription-context-details').count() === 1, "当前服务卡缺少技术详情折叠区");
	const capabilityCards = activePanel.locator('.echo-notes-transcription-capability-card');
	assert(
		JSON.stringify(await capabilityCards.locator('.echo-notes-transcription-capability-card-title').allTextContents()) ===
			JSON.stringify(["说话人分离", "术语增强", "上下文增强", "快捷录音"]),
		"能力增强未按四张能力卡片组织"
	);
	assert(
		await activePanel.locator('.echo-notes-transcription-capability-fact').count() === 0,
		"时间戳不应在能力 Tag 之外重复渲染"
	);
	assert(
		await (await getActiveSetting(page, "说话人分离"))
			.locator(".checkbox-container")
			.evaluate((element) => element.classList.contains("is-enabled")),
		"阿里 filetrans 说话人分离应默认开启"
	);
	assert(
		(await getSettingTextValue(page, "说话人数")) === "",
		"阿里 filetrans 说话人数应默认自动判断"
	);
	const hotwordEnhancementSetting = await getActiveSetting(page, "术语增强");
	const contextEnhancementSetting = await getActiveSetting(page, "上下文增强");
	const memoryInitialized = await page.evaluate(
		(pluginId) => window.app.plugins.plugins[pluginId].settings.memoryInitialized,
		PLUGIN_ID
	);
	assert(
		await hotwordEnhancementSetting
			.locator(".checkbox-container")
			.evaluate((element) => element.classList.contains("is-disabled")) === !memoryInitialized,
		"热词增强开关的 Memory 初始化限制不正确"
	);
	assert(
		!await hotwordEnhancementSetting
			.locator(".checkbox-container")
			.evaluate((element) => element.classList.contains("is-enabled")),
		"阿里 filetrans 的热词增强应默认关闭"
	);
	assert(
		!await contextEnhancementSetting.locator(".checkbox-container")
			.evaluate((element) => element.classList.contains("is-enabled")),
		"阿里 filetrans 的上下文增强应默认关闭"
	);
	assert(
		(await activePanel.getByRole("button", { name: "打开记忆中心", exact: true }).count()) === 2,
		"Memory 未初始化时应分别提供术语和上下文恢复入口"
	);
	assert(
		(await activePanel.getByText("已开启", { exact: true }).count()) === 0,
		"普通开关状态不应重复显示“已开启”标签"
	);
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.memoryInitialized = true;
		plugin.settings.offlineTranscription.aliyunFiletrans.hotwordEnhancementEnabled = false;
		plugin.settings.offlineTranscription.aliyunFiletrans.contextEnhancementEnabled = false;
		await plugin.saveSettings();
		plugin.settingTab.showDestination("transcription-recording");
	}, PLUGIN_ID);
	await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
	assert(
		(await activePanel.getByText("人工术语", { exact: true }).count()) === 0 &&
		(await activePanel.getByText("预览实际内容", { exact: true }).count()) === 0,
		"父能力关闭时仍显示后续配置"
	);
	const speakerCountSetting = await getActiveSetting(page, "说话人数");
	const speakerCountInput = speakerCountSetting.locator('input[type="text"]');
	await speakerCountInput.fill("3");
	await speakerCountInput.blur();
	await speakerCountSetting.getByText("已保存", { exact: true }).waitFor({ state: "visible" });
	await setSettingToggle(page, "说话人分离", false);
	assert(
		(await activePanel.getByText("说话人数", { exact: true }).count()) === 0 &&
		(await activePanel.getByText("说话人标签样式", { exact: true }).count()) === 0,
		"关闭说话人分离后仍显示从属配置"
	);
	assert(
		await page.evaluate(
			(pluginId) => window.app.plugins.plugins[pluginId].settings.offlineTranscription.aliyunFiletrans.speakerCount,
			PLUGIN_ID
		) === 3,
		"关闭说话人分离时不应清除已保存的说话人数"
	);
	await setSettingToggle(page, "说话人分离", true);
	assert((await getSettingTextValue(page, "说话人数")) === "3", "重新开启后未恢复说话人数");
	await setSettingToggle(page, "术语增强", true);
	assert(await (await getActiveSetting(page, "人工术语")).isVisible(), "开启术语增强后未显示人工配置入口");
	assert(await (await getActiveSetting(page, "AI 术语候选")).isVisible(), "开启术语增强后未显示候选审核入口");
	await setSettingToggle(page, "术语增强", false);
	assert((await activePanel.getByText("人工术语", { exact: true }).count()) === 0, "关闭术语增强后未隐藏人工配置入口");
	await setSettingToggle(page, "上下文增强", true);
	assert(await (await getActiveSetting(page, "预览实际内容")).isVisible(), "开启上下文增强后未显示预览入口");
	await setSettingToggle(page, "上下文增强", false);
	assert((await activePanel.getByText("预览实际内容", { exact: true }).count()) === 0, "关闭上下文增强后未隐藏预览入口");
	for (const [capabilityName, expanded] of [["说话人分离", true], ["术语增强", false], ["上下文增强", false]]) {
		const toggle = (await getActiveSetting(page, capabilityName)).locator(".checkbox-container");
		assert(Boolean(await toggle.getAttribute("aria-controls")), `${capabilityName} 开关缺少 aria-controls`);
		assert((await toggle.getAttribute("aria-expanded")) === String(expanded), `${capabilityName} 的 aria-expanded 不正确`);
	}
	await page.evaluate(async ({ pluginId, memoryInitialized }) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.memoryInitialized = memoryInitialized;
		plugin.settings.offlineTranscription.aliyunFiletrans.hotwordEnhancementEnabled = false;
		plugin.settings.offlineTranscription.aliyunFiletrans.contextEnhancementEnabled = false;
		delete plugin.settings.offlineTranscription.aliyunFiletrans.speakerCount;
		await plugin.saveSettings();
		plugin.settingTab.showDestination("transcription-recording");
	}, { pluginId: PLUGIN_ID, memoryInitialized });
	await transcriptionTab.click();
	await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
	await serviceTab.click();
	await selectSettingOption(page, "服务商", "siliconflow");
	await advancedTab.click();
	assert(
		JSON.stringify(await serviceContext.locator('.echo-notes-transcription-context-chip').allTextContents()) === JSON.stringify(["长音频分段"]),
		"SiliconFlow 只应展示长音频分段能力 Tag"
	);
	assert(
		await activePanel.locator('.echo-notes-transcription-capability-empty').count() === 3,
		"SiliconFlow 不支持的能力组应显示三个紧凑空状态"
	);
	assert(
		await activePanel.locator('.echo-notes-transcription-capability-card .checkbox-container').count() === 0 &&
		await activePanel.locator('.echo-notes-transcription-capability-status.is-unsupported').count() === 3,
		"不支持的能力仍被渲染成可操作开关或缺少状态说明"
	);
	await activePanel.getByRole("button", { name: "前往转写服务", exact: true }).first().click();
	await page.waitForFunction(() => (
		document.activeElement?.closest('[data-echo-notes-guide-target="transcription-provider"]') !== null
	));
	assert(await serviceTab.getAttribute("aria-selected") === "true", "空状态操作未返回转写服务");
	const transcriptionAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).first();
	assert(await transcriptionAdvanced.getAttribute("open") === null, "转写高级配置应默认折叠");
	assert(await (await getActiveSetting(page, "转写模型")).isVisible(), "转写模型应在基础配置中可见");
	assert(await (await getActiveSetting(page, "转写配置自检")).isVisible(), "转写配置自检应在基础配置中可见");
	const serviceOrder = await activePanel.locator('.echo-notes-settings-section-panel:not([hidden])').evaluate((panel) => (
		[...panel.children]
			.map((element) => {
				if (element.matches(".setting-item")) {
					return element.querySelector(".setting-item-name")?.textContent?.trim() ?? "";
				}
				if (element.matches(".echo-notes-provider-capability")) {
					return "当前服务商能力";
				}
				if (element.matches(".echo-notes-settings-advanced")) {
					return "高级配置";
				}
				return "";
			})
			.filter(Boolean)
	));
	const orderIndex = (label) => serviceOrder.findIndex((item) => item.includes(label));
	assert(
		orderIndex("服务商") < orderIndex("API Key") &&
		orderIndex("API Key") < orderIndex("转写模型") &&
		orderIndex("转写模型") < orderIndex("转写配置自检") &&
		orderIndex("转写配置自检") < orderIndex("高级配置"),
		`转写服务设置顺序不符合信息架构：${JSON.stringify(serviceOrder)}`
	);
	assert(
		JSON.stringify(await getSettingOptionValues(page, "转写模型")) ===
			JSON.stringify(["FunAudioLLM/SenseVoiceSmall", "TeleAI/TeleSpeechASR", "__custom__"]),
		"SiliconFlow 转写模型选项不完整"
	);
	for (const advancedSettingName of ["Base URL", "默认转写语言", "自定义语言代码"]) {
		const advancedSetting = await getActiveSetting(page, advancedSettingName);
		assert(!(await advancedSetting.isVisible()), `${advancedSettingName} 应在高级配置折叠时隐藏`);
	}
	assert((await activePanel.getByText("硅基流动注册链接", { exact: true }).count()) === 0, "服务商注册入口不应再单独占用设置行");
	assert(
		(await activePanel.getByText("自定义转写模型", { exact: true }).count()) === 0,
		"使用官方模型时不应显示自定义模型输入框"
	);
	const officialTranscriptionModel = await page.evaluate(
		(pluginId) => window.app.plugins.plugins[pluginId].settings.offlineTranscription.model,
		PLUGIN_ID
	);
	await selectSettingOption(page, "转写模型", "__custom__");
	const customModelSetting = await getActiveSetting(page, "自定义转写模型");
	assert(await customModelSetting.isVisible(), "选择自定义模型后应在基础配置中就地显示模型 ID 输入框");
	assert(
		(await page.evaluate(
			(pluginId) => window.app.plugins.plugins[pluginId].settings.offlineTranscription.model,
			PLUGIN_ID
		)) === officialTranscriptionModel,
		"选择自定义模型时不应覆盖当前有效模型"
	);
	const customModelInput = customModelSetting.locator('input[type="text"]');
	await customModelInput.fill(" ");
	await customModelInput.blur();
	await customModelSetting.getByText("模型 ID 不能为空。", { exact: true }).waitFor({ state: "visible" });
	assert(
		(await page.evaluate(
			(pluginId) => window.app.plugins.plugins[pluginId].settings.offlineTranscription.model,
			PLUGIN_ID
		)) === officialTranscriptionModel,
		"无效自定义模型不应写入设置"
	);
	await customModelInput.fill("custom/test-asr");
	await customModelInput.blur();
	await customModelSetting.getByText("已保存", { exact: true }).waitFor({ state: "visible" });
	assert(
		(await page.evaluate(
			(pluginId) => window.app.plugins.plugins[pluginId].settings.offlineTranscription.model,
			PLUGIN_ID
		)) === "custom/test-asr",
		"合法自定义模型未保存"
	);
	await selectSettingOption(page, "转写模型", "FunAudioLLM/SenseVoiceSmall");
	assert(
		(await activePanel.getByText("自定义转写模型", { exact: true }).count()) === 0,
		"切回官方模型后应隐藏自定义模型输入框"
	);

	await selectSettingOption(page, "服务商", "mosi");
	const fixedTranscriptionModel = (await getActiveSetting(page, "转写模型")).locator('input[type="text"]');
	assert(await fixedTranscriptionModel.isDisabled(), "MOSI 固定模型应不可编辑");
	await advancedTab.click();
	await setSettingToggle(page, "说话人分离", false);
	assert(
		(await serviceContext.locator('.echo-notes-transcription-context-model').textContent()) === "moss-transcribe",
		"关闭 MOSI 说话人分离后固定模型不正确"
	);
	await setSettingToggle(page, "说话人分离", true);
	assert(
		(await serviceContext.locator('.echo-notes-transcription-context-model').textContent()) === "moss-transcribe-diarize",
		"开启 MOSI 说话人分离后固定模型不正确"
	);

	await selectSettingOption(page, "转写模式", "realtime");
	assert(
		(await serviceContext.locator('.echo-notes-transcription-context-model').textContent()) === "doubao-seed-asr-2.0",
		"AgentPlan 实时转写固定模型未在摘要中展示"
	);
	assert(
		await (await getActiveSetting(page, "说话人分离"))
			.locator('.echo-notes-transcription-capability-status.is-fixed')
			.getByText("始终开启", { exact: true })
			.count() === 1,
		"AgentPlan 说话人分离缺少“始终开启”特殊状态"
	);
	await selectSettingOption(page, "转写模式", "offline");
	await serviceTab.click();
	await selectSettingOption(page, "服务商", "siliconflow");
	await transcriptionAdvanced.locator("summary").click();
	for (const advancedSettingName of ["Base URL", "默认转写语言", "自定义语言代码"]) {
		assert(await (await getActiveSetting(page, advancedSettingName)).isVisible(), `${advancedSettingName} 应在展开高级配置后显示`);
	}

	await outputTab.click();
	await selectSettingOption(page, "输出目录策略", "custom-folder");
	await activePanel.getByText("自定义输出目录", { exact: true }).waitFor({ state: "visible" });
	assert(await outputTab.getAttribute("aria-selected") === "true", "输出策略重绘后应保留输出规则分类");

	await serviceTab.click();
	await selectSettingOption(page, "转写模式", "realtime");
	await activePanel.getByText("麦克风", { exact: true }).waitFor({ state: "visible" });
	assert(await serviceTab.getAttribute("aria-selected") === "true", "实时模式重绘后应保留转写服务分类");
	await selectSettingOption(page, "转写模式", "offline");
	const activeServiceSection = activePanel.locator('.echo-notes-settings-section-panel:not([hidden])');
	assert((await activeServiceSection.getByText("快捷录音", { exact: true }).count()) === 0, "快捷录音不应显示在转写服务");
	assert(await serviceTab.getAttribute("aria-selected") === "true", "离线模式重绘后应保留转写服务分类");
	await advancedTab.click();
	const activeAdvancedSection = activePanel.locator('.echo-notes-settings-section-panel:not([hidden])');
	const recordingSection = activeAdvancedSection.locator('[data-capability-card="quick-recording"]');
	await recordingSection.getByText("快捷录音", { exact: true }).waitFor({ state: "visible" });
	assert(
		await recordingSection.getAttribute("aria-label") === "快捷录音" &&
		(await recordingSection.getByText("与服务商和模型能力无关", { exact: false }).count()) === 1,
		"高级功能末尾的快捷录音卡缺少标准结构或非模型能力说明"
	);
	assert(
		await recordingSection.locator('.checkbox-container, input[type="text"]').count() === 0 &&
		await recordingSection.getByRole("button", { name: "保存", exact: true }).count() === 0 &&
		await recordingSection.locator('.echo-notes-quick-recording-hotkey-capture').count() === 3,
		"快捷录音仍包含开关、文本框、保存按钮，或缺少三项热键记录控件"
	);
	assert(
		await recordingSection.evaluate((section, cardsSelector) => {
			const cards = [...document.querySelectorAll(cardsSelector)];
			return cards.at(-1) === section;
		}, '.echo-notes-settings-section-panel:not([hidden]) .echo-notes-transcription-capability-card'),
		"快捷录音未作为最后一张高级能力卡片"
	);
	const recorderAutoEnable = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const manager = window.app.internalPlugins;
		if (typeof manager?.setEnable !== "function") {
			return { supported: false };
		}
		await manager.setEnable("audio-recorder", false);
		const before = plugin.isOfficialAudioRecorderEnabled();
		const result = await plugin.ensureOfficialAudioRecorderEnabled();
		return { supported: true, before, result, after: plugin.isOfficialAudioRecorderEnabled() };
	}, PLUGIN_ID);
	assert(
		!recorderAutoEnable.supported || (
			recorderAutoEnable.before === false &&
			recorderAutoEnable.result === "enabled" &&
			recorderAutoEnable.after === true
		),
		`核心录音机未按约定自动开启：${JSON.stringify(recorderAutoEnable)}`
	);
	await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		window.__echoNotesQuickRecordingMocks = {
			isEnabled: plugin.isOfficialAudioRecorderEnabled,
			ensureEnabled: plugin.ensureOfficialAudioRecorderEnabled,
			canWriteShortcuts: plugin.canWriteObsidianShortcutBindings
		};
		plugin.isOfficialAudioRecorderEnabled = () => false;
		plugin.ensureOfficialAudioRecorderEnabled = async () => "failed";
		plugin.canWriteObsidianShortcutBindings = () => false;
		plugin.settingTab.showDestination("transcription-recording");
	}, PLUGIN_ID);
	const failedRecordingCard = getActivePanel(page).locator('[data-capability-card="quick-recording"]');
	await failedRecordingCard.getByText("自动开启失败", { exact: true }).waitFor({ state: "visible" });
	assert(
		await failedRecordingCard.locator('.echo-notes-quick-recording-hotkey-capture:disabled').count() === 3 &&
		await failedRecordingCard.getByRole("button", { name: "打开快捷键设置", exact: true }).count() === 1 &&
		await failedRecordingCard.getByRole("button", { name: "打开核心插件设置", exact: true }).count() === 1,
		"自动开启失败或快捷键管理器不可写时缺少正确降级入口"
	);
	await page.evaluate((pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const mocks = window.__echoNotesQuickRecordingMocks;
		plugin.isOfficialAudioRecorderEnabled = mocks.isEnabled;
		plugin.ensureOfficialAudioRecorderEnabled = mocks.ensureEnabled;
		plugin.canWriteObsidianShortcutBindings = mocks.canWriteShortcuts;
		delete window.__echoNotesQuickRecordingMocks;
		plugin.settingTab.showDestination("transcription-recording");
	}, PLUGIN_ID);

	await memoryTab.click();
	const memorySectionTabs = activePanel.locator(".echo-notes-settings-section-tab");
	assert(
		(await memorySectionTabs.allTextContents()).join("|") === "模型配置|配置与规则|维护",
		"记忆阶段应按模型配置、配置与规则、维护的顺序展示"
	);
	const agentStage = page.locator('[data-settings-stage="agent"]');
	assert(await agentStage.getAttribute("aria-disabled") === "true", "外部 Agent 阶段应保持不可操作");
	assert((await agentStage.locator(".echo-notes-settings-step-status").textContent())?.trim() === "规划中", "外部 Agent 阶段应显示规划中而不是研发中");
	const memoryModelTab = memorySectionTabs.filter({ hasText: "模型配置" });
	await memoryModelTab.click();
	assert(
		JSON.stringify(await getSettingOptionValues(page, "记忆服务商")) ===
			JSON.stringify([
				"siliconflow",
				"aliyun-bailian",
				"deepseek",
				"volcengine-agentplan",
				"ollama",
				"lm-studio",
				"custom-openai-compatible"
			]),
		"记忆服务商的成员或顺序不正确"
	);
	await selectSettingOption(page, "记忆服务商", "siliconflow");
	assert((await getSettingTextValue(page, "记忆模型")) === "Qwen/Qwen3.5-4B", "硅基流动默认记忆模型不正确");
	await memorySectionTabs.filter({ hasText: "配置与规则" }).click();
	assert(await activePanel.getByText("确认 3 件事，就可以开始", { exact: true }).count() === 1, "提取设置缺少准备度分组");
	assert(await activePanel.getByText("隐私与费用", { exact: true }).count() === 1, "提取设置缺少隐私与费用说明");
	await setSettingToggle(page, "长文本分块提取", false);
	assert((await activePanel.getByText("记忆分块字符数", { exact: true }).count()) === 0, "关闭记忆分块后不应显示分块字符数");
	await setSettingToggle(page, "长文本分块提取", true);
	const memoryAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).filter({ hasText: "高级：分块参数" });
	assert(await memoryAdvanced.getAttribute("open") === null, "记忆分块高级配置应默认折叠");
	await memoryAdvanced.locator("summary").click();
	await activePanel.getByText("记忆分块字符数", { exact: true }).waitFor({ state: "visible" });
	await memorySectionTabs.filter({ hasText: "维护" }).click();


	// 记忆中心已改为独立 Modal，不再内嵌在设置 Tab 中

	await analysisTab.click();
	await setSettingToggle(page, "启用 AI 纪要分析", true);
	const analysisSectionTabs = activePanel.locator(".echo-notes-settings-section-tab");
	await analysisSectionTabs.first().waitFor({ state: "visible" });
	assert(
		(await analysisSectionTabs.allTextContents()).join("|") === "模型配置|处理策略|模板管理",
		"AI 分析二级分类不完整"
	);
	const modelTab = analysisSectionTabs.filter({ hasText: "模型配置" });
	const processingTab = analysisSectionTabs.filter({ hasText: "处理策略" });
	const templatesTab = analysisSectionTabs.filter({ hasText: "模板管理" });
	assert(
		JSON.stringify(await getSettingOptionValues(page, "分析服务商")) ===
			JSON.stringify([
				"siliconflow",
				"opencode-go",
				"aliyun-bailian",
				"deepseek",
				"volcengine-agentplan",
				"ollama",
				"lm-studio",
				"custom-openai-compatible"
			]),
		"AI 分析服务商的成员或顺序不正确"
	);
	const analysisProviderOptions = await (await getActiveSetting(page, "分析服务商")).locator('select:not([aria-hidden="true"]) option').allTextContents();
	assert(
		JSON.stringify(analysisProviderOptions) ===
			JSON.stringify([
				"【免费】硅基流动（SiliconFlow）",
				"【推荐】OpenCode Go",
				"阿里百炼（Alibaba Bailian）",
				"DeepSeek",
				"火山引擎 AgentPlan",
				"Ollama",
				"LM Studio",
				"自定义兼容接口（Custom OpenAI-compatible）"
			]),
		"AI 分析服务商展示名称或顺序不正确"
	);

	await selectSettingOption(page, "分析服务商", "siliconflow");
	assert(
		(await getSettingTextValue(page, "分析模型")) === "Qwen/Qwen3.5-4B",
		"硅基流动默认分析模型不正确"
	);
	assert(await (await getActiveSetting(page, "分析模型")).isVisible(), "分析模型应在基础配置中可见");
	let analysisAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).first();
	assert(await analysisAdvanced.getAttribute("open") === null, "分析高级配置应默认折叠");
	assert(!(await (await getActiveSetting(page, "分析 Base URL")).isVisible()), "分析 Base URL 应在高级配置折叠时隐藏");
	assert(!(await (await getActiveSetting(page, "分析配置自检")).isVisible()), "分析配置自检应在高级配置折叠时隐藏");

	await selectSettingOption(page, "分析服务商", "opencode-go");
	const openCodeGoAnalysisModel = await getActiveSetting(page, "分析模型");
	assert(
		await openCodeGoAnalysisModel.isVisible() && (await openCodeGoAnalysisModel.locator("select:not([aria-hidden=\"true\"])").count()) === 1,
		"OpenCode Go 分析模型应在基础配置中使用下拉框展示"
	);
	assert(
		await openCodeGoAnalysisModel.locator("select:not([aria-hidden=\"true\"])").inputValue() === "deepseek-v4-flash",
		"OpenCode Go 默认分析模型不正确"
	);
	assert(
		JSON.stringify(await getSettingOptionValues(page, "分析模型")) ===
			JSON.stringify([
				"grok-4.5",
				"glm-5.2",
				"glm-5.1",
				"gpt-5.6-luna",
				"kimi-k3",
				"kimi-k2.7-code",
				"kimi-k2.6",
				"mimo-v2.5",
				"mimo-v2.5-pro",
				"minimax-m3",
				"minimax-m2.7",
				"qwen3.8-max",
				"qwen3.7-max",
				"qwen3.7-plus",
				"qwen3.6-plus",
				"deepseek-v4-pro",
				"deepseek-v4-flash",
				"hy3"
			]),
		"OpenCode Go 模型清单不符合官方文档快照"
	);
	analysisAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).first();
	await verifyApiKeyLink(page, "OpenCode Go 分析 API Key", "OpenCode Go 分析", {
		label: "获取 OpenCode Go API Key",
		href: "https://opencode.ai/go?ref=YD4XM7Z5CY"
	});
	await analysisAdvanced.locator("summary").click();
	const openCodeGoBaseUrl = (await getActiveSetting(page, "分析 Base URL")).locator("input");
	assert(
		await openCodeGoBaseUrl.isDisabled() &&
		await openCodeGoBaseUrl.inputValue() === "https://opencode.ai/zen/go/v1",
		"OpenCode Go Base URL 应为只读官方地址"
	);

	await selectSettingOption(page, "分析服务商", "volcengine-agentplan");
	const agentPlanAnalysisModel = await getActiveSetting(page, "分析模型");
	assert(
		await agentPlanAnalysisModel.isVisible() && (await agentPlanAnalysisModel.locator("select:not([aria-hidden=\"true\"])").count()) === 1,
		"AgentPlan 分析模型应在基础配置中使用下拉框展示"
	);

	await selectSettingOption(page, "分析服务商", "ollama");
	analysisAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).first();
	assert(await analysisAdvanced.getAttribute("open") === null, "分析高级配置应在服务商重绘后保持默认折叠");
	assert(await (await getActiveSetting(page, "分析模型")).isVisible(), "Ollama 分析模型应在基础配置中可见");
	await analysisAdvanced.locator("summary").click();
	await activePanel.getByText("分析 Base URL", { exact: true }).waitFor({ state: "visible" });
	assert(await (await getActiveSetting(page, "分析配置自检")).isVisible(), "展开高级配置后应显示分析配置自检");
	assert(await modelTab.getAttribute("aria-selected") === "true", "分析服务商重绘后应保留模型配置分类");

	await processingTab.click();
	const processingOrder = await activePanel.locator('.echo-notes-settings-section-panel:not([hidden])').evaluate((panel) => (
		[...panel.querySelectorAll(":scope > .setting-item .setting-item-name")].map((element) => element.textContent?.trim() ?? "")
	));
	assert(
		processingOrder.findIndex((item) => item.includes("AI 分析前脱敏")) <
		processingOrder.findIndex((item) => item.includes("长文本分块分析")),
		`AI 分析处理策略顺序不符合隐私优先：${JSON.stringify(processingOrder)}`
	);
	await setSettingToggle(page, "长文本分块分析", false);
	await activePanel.getByText("AI 分析前脱敏 transcript", { exact: true }).waitFor({ state: "visible" });
	assert(await processingTab.getAttribute("aria-selected") === "true", "长文本开关重绘后应保留处理策略分类");
	assert(
		(await activePanel.getByText("分析分块字符数", { exact: true }).count()) === 0,
		"关闭长文本分块后不应显示分块字符数"
	);
	await setSettingToggle(page, "长文本分块分析", true);
	const analysisProcessingAdvanced = activePanel.locator(
		'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
	).first();
	assert(await analysisProcessingAdvanced.getAttribute("open") === null, "分析分块高级配置应默认折叠");
	await analysisProcessingAdvanced.locator("summary").click();
	await activePanel.getByText("分析分块字符数", { exact: true }).waitFor({ state: "visible" });

	await modelTab.click();
	await selectSettingOption(page, "分析服务商", "aliyun-bailian");
	assert(await modelTab.getAttribute("aria-selected") === "true", "恢复分析服务商后应保留模型配置分类");
	await templatesTab.click();
	await activePanel.getByText("默认分析模板", { exact: true }).waitFor({ state: "visible" });
	assert(await templatesTab.getAttribute("aria-selected") === "true", "模板管理分类应可访问");
	assert(
		JSON.stringify(await getTemplateCategoryTabState(page)) ===
			JSON.stringify([
				{ category: "general", label: "通用场景", count: "2/2", selected: true },
				{ category: "management-people", label: "管理与组织", count: "0/2", selected: false },
				{ category: "product-delivery", label: "产品与交付", count: "1/3", selected: false },
				{ category: "engineering", label: "技术研发", count: "0/1", selected: false },
				{ category: "customer-growth", label: "客户与增长", count: "0/3", selected: false },
				{ category: "custom", label: "自定义", count: "0/0", selected: false }
			]),
		"模板分类切换器的顺序、计数或默认选中状态不正确"
	);
	assert(
		(await getActivePanel(page).locator(".echo-notes-template-group:not([hidden])").getAttribute("data-template-category")) === "general",
		"首次进入模板管理应只显示通用场景"
	);
	const generalCategoryTab = getActivePanel(page).locator('[data-template-category-tab="general"]');
	await generalCategoryTab.focus();
	await generalCategoryTab.press("End");
	assert(
		(await getActivePanel(page).locator(".echo-notes-template-group:not([hidden])").getAttribute("data-template-category")) === "custom",
		"End 键应切换到最后一个模板分类"
	);
	await getActivePanel(page).locator('[data-template-category-tab="custom"]').press("Home");
	assert(
		(await getActivePanel(page).locator(".echo-notes-template-group:not([hidden])").getAttribute("data-template-category")) === "general",
		"Home 键应切换到第一个模板分类"
	);
	assert(
		JSON.stringify(await getTemplateGroupState(page)) ===
			JSON.stringify([
				{ category: "general", label: "通用场景", count: "2/2 已启用", heading: true, templates: ["工作纪要", "学习纪要"] },
				{ category: "management-people", label: "管理与组织", count: "0/2 已启用", heading: true, templates: ["管理者纪要", "HR/人力纪要"] },
				{ category: "product-delivery", label: "产品与交付", count: "1/3 已启用", heading: true, templates: ["产品需求挖掘纪要", "产品经理纪要", "项目经理纪要"] },
				{ category: "engineering", label: "技术研发", count: "0/1 已启用", heading: true, templates: ["研发/技术纪要"] },
				{ category: "customer-growth", label: "客户与增长", count: "0/3 已启用", heading: true, templates: ["销售纪要", "客户成功纪要", "运营纪要"] },
				{ category: "custom", label: "自定义", count: "0/0 已启用", heading: true, templates: [] }
			]),
		"模板管理的角色分类、计数或模板顺序不正确"
	);
	const defaultTemplateSetting = await getActiveSetting(page, "默认分析模板");
	assert(
		JSON.stringify(await defaultTemplateSetting.locator("optgroup").evaluateAll((groups) => groups.map((group) => group.label))) ===
			JSON.stringify(["通用场景", "管理与组织", "产品与交付", "技术研发", "客户与增长"]),
		"默认分析模板下拉的 optgroup 不完整"
	);

	await getActivePanel(page).locator('[data-template-category-tab="management-people"]').click();
	await setTemplateCardToggle(page, "管理者纪要", true);
	assert(
		(await getTemplateGroupState(page)).find((group) => group.category === "management-people")?.count === "1/2 已启用",
		"直接启用模板后分组计数未更新"
	);
	assert(
		(await getTemplateCategoryTabState(page)).find((tab) => tab.category === "management-people")?.selected === true,
		"模板启用触发设置页重绘后应保留当前分类"
	);

	const beforeCreateRenderId = await getSettingsRenderId(page);
	await getActivePanel(page).getByRole("button", { name: "新增模板", exact: true }).click();
	await waitForSettingsRerender(page, beforeCreateRenderId);
	const templateModal = page.locator(".echo-notes-template-modal");
	await templateModal.waitFor({ state: "visible" });
	const categorySetting = templateModal.locator(".setting-item").filter({ hasText: "角色分类" });
	assert((await categorySetting.count()) === 1, "自定义模板编辑器应包含角色分类");
	const categoryOptions = await categorySetting.locator('select:not([aria-hidden="true"]) option').allTextContents();
	assert(
		JSON.stringify(categoryOptions) ===
			JSON.stringify(["通用场景", "管理与组织", "产品与交付", "技术研发", "客户与增长", "自定义"]),
		"自定义模板角色分类选项不完整"
	);
	await categorySetting.locator("select:not([aria-hidden=\"true\"])").selectOption("engineering");
	const beforeSaveRenderId = await getSettingsRenderId(page);
	await templateModal.getByRole("button", { name: "保存", exact: true }).click();
	await templateModal.waitFor({ state: "detached" });
	await waitForSettingsRerender(page, beforeSaveRenderId);
	const engineeringGroup = (await getTemplateGroupState(page)).find((group) => group.category === "engineering");
	assert(
		JSON.stringify(engineeringGroup) ===
			JSON.stringify({ category: "engineering", label: "技术研发", count: "1/2 已启用", heading: true, templates: ["研发/技术纪要", "自定义模板"] }),
		"自定义模板保存后未进入技术研发分类"
	);
	assert(
		(await getActivePanel(page).locator(".echo-notes-template-group:not([hidden])").getAttribute("data-template-category")) === "engineering",
		"自定义模板改分类并保存后应自动显示目标分类"
	);
	await verifyTabRelationships(page);
	assert((await page.locator(".echo-notes-settings-intro").count()) === 1, "Tab 切换后引导区不应重复");

	await page.evaluate(async (commandId) => {
		const filePath = "Echo Notes UI Picker.transcript.md";
		const existing = window.app.vault.getAbstractFileByPath(filePath);
		const file = existing ?? await window.app.vault.create(filePath, "# 转写稿\n\n用于隔离 UI 验证。\n");
		await window.app.workspace.getLeaf(false).openFile(file);
		await window.app.commands.executeCommandById(commandId);
	}, `${PLUGIN_ID}:analyze-current-transcript-with-template`);
	const pickerModal = page.locator(".echo-notes-analysis-template-picker-modal");
	await pickerModal.waitFor({ state: "visible" });
	assert(
		JSON.stringify(await pickerModal.locator(".echo-notes-analysis-template-picker-group").evaluateAll((groups) =>
			groups.map((group) => group.getAttribute("data-template-category"))
		)) === JSON.stringify(["general", "management-people", "product-delivery", "engineering"]),
		"手动模板选择弹窗未按已启用角色分类分组"
	);
	assert(
		JSON.stringify(await pickerModal.locator(".echo-notes-analysis-template-picker-title").allTextContents()) ===
			JSON.stringify(["工作纪要", "学习纪要", "管理者纪要", "产品需求挖掘纪要", "自定义模板"]),
		"手动模板选择弹窗的模板顺序不正确"
	);
	if (await page.locator(".modal-close-button").count() === 0) {
		await page.keyboard.press("Escape");
	} else {
		if (await page.locator(".modal-close-button").count() === 0) {
		await page.keyboard.press("Escape");
	} else {
		await page.locator(".modal-close-button").last().click();
	}
	}
	await pickerModal.waitFor({ state: "detached" });
}

async function reopenSettings(page) {
	await page.evaluate(async (pluginId) => {
		window.app.setting.close();
		window.app.setting.open();
		await window.app.setting.openTabById(pluginId);
	}, PLUGIN_ID);
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
	assert((await page.locator(".echo-notes-settings-intro").count()) === 1, "重新打开设置后引导区不应重复");
	assert(
		(await page.locator('[data-settings-stage="analysis"]').getAttribute("aria-selected")) === "true",
		"同一设置页实例重新打开后应保留当前阶段"
	);
	assert(
		(await getActivePanel(page).getByRole("tab", { name: "模板管理", exact: true }).getAttribute("aria-selected")) === "true",
		"同一设置页实例重新打开后应保留当前 AI 分类"
	);
}

async function verifyMemoryInitialization(page) {
	await page.evaluate(async (commandId) => {
		await window.app.commands.executeCommandById(commandId);
	}, `${PLUGIN_ID}:initialize-echo-memory`);
	const modal = page.locator(".echo-notes-memory-initialization-modal");
	await modal.waitFor({ state: "visible" });
	await modal.locator(".setting-item").filter({ hasText: "称呼" }).locator("input").fill("测试用户");
	await modal.locator(".setting-item").filter({ hasText: "当前角色" }).locator("input").fill("产品经理");
	await modal.locator(".setting-item").filter({ hasText: "近期目标" }).locator("textarea").fill("验证 Echo Memory MVP");
	await modal.getByRole("button", { name: "初始化", exact: true }).click();
	await modal.waitFor({ state: "detached" });

	const result = await page.evaluate(async () => {
		const expectedPaths = [
			"Echo Memory/00 首页.md",
			"Echo Memory/04 User/SOUL.md",
			"Echo Memory/04 User/01 使命与目标.md",
			"Echo Memory/04 User/08 隐私与授权边界.md",
			"Echo Memory/07 转写增强/术语与上下文.md",
			"Echo Memory/07 转写增强/术语候选.md",
			"Echo Memory/99 系统/echo-memory.json"
		];
		const missingPaths = expectedPaths.filter((path) => !window.app.vault.getAbstractFileByPath(path));
		const manifestFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory.json");
		const manifest = manifestFile ? JSON.parse(await window.app.vault.read(manifestFile)) : null;
		return {
			missingPaths,
			manifest,
			peopleFolderExists: Boolean(window.app.vault.getAbstractFileByPath("Echo Memory/03 实体/人物")),
			organizationFolderExists: Boolean(window.app.vault.getAbstractFileByPath("Echo Memory/03 实体/组织")),
			projectFolderExists: Boolean(window.app.vault.getAbstractFileByPath("Echo Memory/03 实体/项目"))
		};
	});
	assert(result.missingPaths.length === 0, `Echo Memory 初始化缺少路径：${result.missingPaths.join(" | ")}`);
	assert(result.peopleFolderExists && result.organizationFolderExists && result.projectFolderExists, "实体目录初始化不完整");
	assert(result.manifest?.schemaVersion === 1, "Echo Memory 清单 Schema 版本不正确");
	assert(result.manifest?.user?.displayName === "测试用户", "Echo Memory 初始化用户未写入清单");
	assert(result.manifest?.paths?.candidatesDir === "Echo Memory/02 记忆候选", "Echo Memory 清单路径映射不正确");
}

async function verifyMemoryCheckpointResume(page, mock) {
	const result = await page.evaluate(async ({ pluginId, baseUrl }) => {
		window.app.setting.close();
		const plugin = window.app.plugins.plugins[pluginId];
		if (!plugin?.memoryService) {
			throw new Error("Echo Notes MemoryService 未初始化");
		}
		plugin.settings.memoryMode = "candidates-only";
		plugin.settings.memoryProvider = "ollama";
		plugin.settings.memoryBaseUrl = baseUrl;
		plugin.settings.memoryModel = "mock-memory";
		plugin.settings.memoryLongTextEnabled = true;
		plugin.settings.memoryChunkCharacters = 4_000;
		await plugin.saveSettings();

		const transcriptPath = "Echo Notes UI Memory Resume.transcript.md";
		const transcriptBody = Array.from(
			{ length: 120 },
			(_, index) =>
				`验证记录 ${String(index + 1).padStart(3, "0")}：Echo Notes 检查点必须保留已验证证据并从失败分块续跑。`
		).join("\n");
		const transcriptContent = `# 转写稿\n\n${transcriptBody}\n`;
		const existingTranscript = window.app.vault.getAbstractFileByPath(transcriptPath);
		const transcriptFile = existingTranscript ?? await window.app.vault.create(transcriptPath, transcriptContent);
		if (existingTranscript) {
			await window.app.vault.modify(existingTranscript, transcriptContent);
		}

		let firstError = "";
		try {
			await plugin.memoryService.extractFromTranscript(plugin.settings, transcriptFile, {
				apiKey: "",
				analysisTemplateIds: []
			});
		} catch (error) {
			firstError = error instanceof Error ? error.message : String(error);
		}
		if (!firstError) {
			throw new Error("Memory mock 首轮提取未按预期失败");
		}

		const checkpointPath = "Echo Memory/99 系统/echo-memory-checkpoints.json";
		const checkpointFile = window.app.vault.getAbstractFileByPath(checkpointPath);
		if (!checkpointFile) {
			throw new Error("首轮失败后未写入 Memory 检查点文件");
		}
		const checkpointContent = await window.app.vault.read(checkpointFile);
		const checkpointStore = JSON.parse(checkpointContent);
		const checkpoint = checkpointStore.checkpoints?.[transcriptPath];
		const candidatesAfterFailure = window.app.vault.getMarkdownFiles()
			.filter((file) =>
				file.path.startsWith("Echo Memory/02 记忆候选/") &&
				!file.path.toLocaleLowerCase().endsWith(".review.md")
			)
			.map((file) => file.path);

		const extraction = await plugin.memoryService.extractFromTranscript(plugin.settings, transcriptFile, {
			apiKey: "",
			analysisTemplateIds: []
		});
		const candidateFile = window.app.vault.getAbstractFileByPath(extraction.candidateFilePath);
		const reviewPath = extraction.candidateFilePath.replace(/\.md$/i, ".review.md");
		const reviewFile = window.app.vault.getAbstractFileByPath(reviewPath);
		const meetingFile = window.app.vault.getAbstractFileByPath(extraction.meetingFilePath);
		if (!candidateFile || !reviewFile || !meetingFile) {
			throw new Error("Memory 续跑成功后缺少候选包、审核文件或会议页");
		}
		const candidateContent = await window.app.vault.read(candidateFile);
		const candidateMatch = /<!-- echo-memory-data:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- echo-memory-data:end -->/.exec(candidateContent);
		if (!candidateMatch) {
			throw new Error("Memory 候选包缺少结构化数据区块");
		}
		const candidate = JSON.parse(candidateMatch[1]);
		const manifestFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory.json");
		const manifest = JSON.parse(await window.app.vault.read(manifestFile));
		const completedCheckpointContent = await window.app.vault.read(checkpointFile);
		const completedCheckpointStore = JSON.parse(completedCheckpointContent);

		return {
			transcriptPath,
			firstError,
			checkpointPath,
			checkpointContent,
			checkpointCreatedAt: checkpoint?.createdAt ?? null,
			completedChunks: checkpoint?.completedChunks?.length ?? 0,
			checkpointChunkTotal: checkpoint?.completedChunks?.[0]?.total ?? null,
			candidatesAfterFailure,
			extraction,
			reviewPath,
			candidateCreatedAt: candidate.createdAt,
			candidateAssertionCount: candidate.assertions?.length ?? 0,
			candidateRejectedAssertionCount: candidate.rejectedAssertionCount ?? 0,
			manifestRun: manifest.runs?.[candidate.fingerprint] ?? null,
			checkpointFileStillExists: Boolean(window.app.vault.getAbstractFileByPath(checkpointPath)),
			checkpointRemoved: !completedCheckpointStore.checkpoints?.[transcriptPath]
		};
	}, { pluginId: PLUGIN_ID, baseUrl: mock.baseUrl });

	assert(result.firstError.includes("HTTP 500"), `Memory 首轮失败原因不正确：${result.firstError}`);
	assert(result.completedChunks === 1, `首轮失败后应保留 1 个分块，实际为 ${result.completedChunks}`);
	assert(result.checkpointChunkTotal === 2, `Memory 集成输入应拆为 2 块，实际为 ${result.checkpointChunkTotal ?? "未知"}`);
	assert(result.checkpointCreatedAt, "Memory 检查点缺少初次 createdAt");
	assert(result.candidatesAfterFailure.length === 0, "首轮失败时不应提前生成候选包");
	assert(
		!["apiKey", "Authorization", "rawResponse", "choices"].some((term) => result.checkpointContent.includes(term)),
		"Memory 检查点不应保存 API Key、认证头或 Provider 原始响应"
	);
	assert(
		JSON.stringify(mock.calls.map((call) => call.chunkIndex)) === JSON.stringify([1, 2, 2]),
		`Memory 续跑调用序列应为 1,2,2，实际为 ${mock.calls.map((call) => call.chunkIndex).join(",")}`
	);
	assert(mock.calls.every((call) => call.totalChunks === 2), "Memory mock 收到的总分块数不一致");
	assert(result.candidateCreatedAt === result.checkpointCreatedAt, "Memory 续跑后的候选 createdAt 未保持首次运行时间");
	assert(result.candidateAssertionCount === 2, `Memory 续跑候选应包含 2 条断言，实际为 ${result.candidateAssertionCount}`);
	assert(result.candidateRejectedAssertionCount === 1, "Memory 候选未记录被证据校验拒绝的断言数量");
	assert(result.extraction.rejectedAssertionCount === 1, "Memory 提取结果未返回证据校验拒绝数量");
	assert(result.manifestRun?.candidatePath === result.extraction.candidateFilePath, "Memory 清单未记录续跑生成的候选包");
	assert(result.manifestRun?.meetingPath === result.extraction.meetingFilePath, "Memory 清单未记录续跑生成的会议页");
	assert(result.reviewPath.endsWith(".review.md"), "Memory 续跑未生成审核 sidecar 路径");
	assert(result.checkpointFileStillExists, "Memory 成功清理不应删除共享检查点存储文件");
	assert(result.checkpointRemoved, "Memory 续跑成功后未清理当前转写稿检查点");
}

async function verifyTranscriptionEnhancementMarkdown(page) {
	const migration = await page.evaluate(async (pluginId) => {
		window.app.setting.close();
		const plugin = window.app.plugins.plugins[pluginId];
		const manualPath = "Echo Memory/07 转写增强/术语与上下文.md";
		const candidatePath = "Echo Memory/07 转写增强/术语候选.md";
		const backupPath = "Echo Memory/99 系统/transcription-enhancement-v1-backup.json";
		const at = "2026-08-13T08:00:00.000Z";
		const store = {
			schemaVersion: 1,
			updatedAt: at,
			terms: {
				manualApproved: { id: "manualApproved", text: "Echo Notes", weight: 3, scope: { type: "global" }, source: "manual", status: "approved", approvedAt: at, updatedAt: at, history: [] },
				projectManual: { id: "projectManual", text: "项目专词", weight: 5, scope: { type: "project", value: "Echo Notes" }, source: "manual", status: "approved", approvedAt: at, updatedAt: at, history: [] },
				manualDisabled: { id: "manualDisabled", text: "不应生效", weight: 50, scope: { type: "global" }, source: "manual", status: "disabled", updatedAt: at, history: [{ at, status: "disabled", note: "保留备份" }] },
				candidateA: { id: "candidateA", text: "EchoNote", weight: 3, scope: { type: "global" }, source: "memory", status: "pending", evidence: "依据 A", backlink: "Echo Memory/02 记忆候选/source-a.review.md", updatedAt: at, history: [{ at, status: "pending", note: "AI 生成" }] },
				candidateB: { id: "candidateB", text: "Dash Scope", weight: 4, scope: { type: "project", value: "Echo Notes" }, source: "memory", status: "pending", evidence: "依据 B", backlink: "Echo Memory/02 记忆候选/source-b.review.md", updatedAt: at, history: [{ at, status: "pending", note: "AI 生成" }] },
				candidateApproved: { id: "candidateApproved", text: "OpenAI", effectiveText: "OpenAI", weight: 3, scope: { type: "global" }, source: "memory", status: "approved", evidence: "依据 C", backlink: "Echo Memory/02 记忆候选/source-c.review.md", approvedAt: at, updatedAt: at, history: [{ at, status: "approved", note: "旧审核" }] }
			},
			prompts: {
				globalPrompt: { id: "globalPrompt", text: "保留产品名称。", scope: { type: "global" }, status: "approved", updatedAt: at, history: [] },
				projectPrompt: { id: "projectPrompt", text: "当前是 Echo Notes 项目。", scope: { type: "project", value: "Echo Notes" }, status: "approved", updatedAt: at, history: [] }
			}
		};
		const legacy = [
			"---", "echo_memory_type: transcription-enhancement", "---", "", "# 术语与上下文", "",
			"## 人工补充", "", "这段人工说明必须保留。", "",
			"<!-- echo-memory-transcription-enhancement:managed:start -->", "## 术语", "",
			"<!-- echo-memory-transcription-enhancement-data:start -->", "```json", JSON.stringify(store, null, 2), "```",
			"<!-- echo-memory-transcription-enhancement-data:end -->", "<!-- echo-memory-transcription-enhancement:managed:end -->", ""
		].join("\n");
		const manualFile = window.app.vault.getAbstractFileByPath(manualPath);
		await window.app.vault.modify(manualFile, legacy);
		const first = await plugin.memoryService.getTranscriptionEnhancementDocuments(plugin.settings);
		const firstManual = await window.app.vault.read(first.manualFile);
		const firstCandidates = await window.app.vault.read(first.candidateFile);
		const backupFile = window.app.vault.getAbstractFileByPath(backupPath);
		const backup = backupFile ? await window.app.vault.read(backupFile) : "";
		const second = await plugin.memoryService.getTranscriptionEnhancementDocuments(plugin.settings);
		return {
			manualPath,
			candidatePath,
			backupPath,
			firstManual,
			firstCandidates,
			backup,
			secondManual: await window.app.vault.read(second.manualFile),
			secondCandidates: await window.app.vault.read(second.candidateFile),
			stats: first.stats
		};
	}, PLUGIN_ID);

	assert(migration.firstManual.includes("## 全局") && migration.firstManual.includes("## 项目：Echo Notes"), "旧人工术语未迁移为作用域 Markdown");
	assert(migration.firstManual.includes("这段人工说明必须保留"), "迁移未保留人工正文");
	assert(!migration.firstManual.includes("不应生效"), "未启用的旧人工术语不应迁移为生效配置");
	assert(migration.firstCandidates.includes("candidateA") && migration.firstCandidates.includes("依据 A"), "AI 候选状态与依据未迁移");
	assert(migration.backup.includes("不应生效") && migration.backup.includes("manualDisabled"), "系统迁移备份未保留未启用记录");
	assert(migration.firstManual === migration.secondManual && migration.firstCandidates === migration.secondCandidates, "重复迁移不是零变化");
	assert(migration.stats.manualTermCount === 2 && migration.stats.manualPromptCount === 2 && migration.stats.pendingCandidateCount === 2, "迁移后统计不正确");

	const openedPaths = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		await plugin.openTranscriptionEnhancementManualFile();
		const manual = window.app.workspace.getActiveFile()?.path;
		await plugin.openTranscriptionEnhancementCandidateFile();
		return { manual, candidate: window.app.workspace.getActiveFile()?.path };
	}, PLUGIN_ID);
	assert(openedPaths.manual === migration.manualPath && openedPaths.candidate === migration.candidatePath, "双文件入口未打开约定路径");

	await page.evaluate((pluginId) => {
		document.querySelectorAll(".notice").forEach((notice) => notice.remove());
		window.app.plugins.plugins[pluginId].openTranscriptionEnhancementManager();
	}, PLUGIN_ID);
	const modal = page.locator(".echo-notes-transcription-candidate-review-modal");
	await modal.waitFor({ state: "visible" });
	assert((await modal.locator('.echo-notes-candidate-review-card').count()) === 2, "候选审核应默认只显示待审核项");
	assert((await modal.locator('[role="tablist"]').count()) === 1, "候选审核缺少可访问状态分类");

	const layouts = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const metrics = await modal.evaluate((element, requireTouchTargets) => {
				const cards = [...element.querySelectorAll('.echo-notes-candidate-review-card')];
				const buttons = [...element.querySelectorAll('button')];
				return {
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					contentOverflow: element.scrollWidth - element.clientWidth,
					modalFits: element.getBoundingClientRect().width <= window.innerWidth + 1,
					cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
					touchTargetsMeetMinimum: !requireTouchTargets || buttons.every((button) => button.getBoundingClientRect().height >= 44)
				};
			}, viewport.mobileShell);
			const context = `transcription-candidates/${viewport.name}/${theme}`;
			assert(metrics.documentOverflow <= 1 && metrics.contentOverflow <= 1, `${context} 出现水平溢出`);
			assert(metrics.modalFits && metrics.cardsFit, `${context} 候选弹窗或卡片超出 viewport`);
			assert(metrics.touchTargetsMeetMinimum, `${context} 移动操作区小于 44px`);
			const fileName = `transcription-candidates-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await modal.screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
			layouts.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}

	await setViewportMode(page, VIEWPORTS[0], "light");
	let card = modal.locator('.echo-notes-candidate-review-card').filter({ hasText: "EchoNote" });
	await card.locator('input[type="text"]').first().fill("Echo Notes AI");
	await card.getByRole("button", { name: "批准候选 EchoNote", exact: true }).click();
	card = modal.locator('.echo-notes-candidate-review-card').filter({ hasText: "Dash Scope" });
	await card.getByRole("button", { name: "拒绝候选 Dash Scope", exact: true }).click();
	assert((await modal.locator('.echo-notes-candidate-review-card').count()) === 0, "候选批准与拒绝后未移出待审核列表");
	await modal.getByRole("button", { name: "保存审核", exact: true }).click();
	await modal.waitFor({ state: "detached" });
	await page.evaluate((pluginId) => window.app.plugins.plugins[pluginId].openTranscriptionEnhancementManager(), PLUGIN_ID);
	const reopened = page.locator(".echo-notes-transcription-candidate-review-modal");
	await reopened.waitFor({ state: "visible" });
	await reopened.getByRole("tab", { name: /已批准/ }).click();
	const corrected = reopened.locator('.echo-notes-candidate-review-card').filter({ hasText: "EchoNote" });
	assert(await corrected.locator('input[type="text"]').first().inputValue() === "Echo Notes AI", "审核修正后的生效词未保存");
	await reopened.getByRole("tab", { name: /已拒绝/ }).click();
	assert((await reopened.getByText("Dash Scope", { exact: true }).count()) >= 1, "拒绝状态未持久化");
	if (await reopened.locator(".modal-close-button").count() === 0) {
		await page.keyboard.press("Escape");
	} else {
		await reopened.locator(".modal-close-button").click();
	}
	await reopened.waitFor({ state: "detached" });

	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.offlineTranscription.provider = "aliyun-bailian";
		plugin.settings.offlineTranscription.model = "qwen-audio-3.0-asr-flash-filetrans";
		plugin.settings.offlineTranscription.aliyunFiletrans = {
			...(plugin.settings.offlineTranscription.aliyunFiletrans ?? {}),
			diarizationEnabled: true,
			hotwordEnhancementEnabled: true,
			contextEnhancementEnabled: true,
			memoryEnhancementEnabled: true
		};
		await plugin.saveSettings();
		const path = "Echo Notes 术语作用域预览.md";
		const content = "---\necho_notes_memory_projects:\n  - Echo Notes\n---\n\n# 作用域预览\n";
		const existing = window.app.vault.getAbstractFileByPath(path);
		const file = existing ?? await window.app.vault.create(path, content);
		if (existing) await window.app.vault.modify(existing, content);
		await window.app.workspace.getLeaf(false).openFile(file);
		await new Promise((resolve) => window.setTimeout(resolve, 100));
		await plugin.openTranscriptionEnhancementPreview();
	}, PLUGIN_ID);
	const preview = page.locator(".echo-notes-transcription-enhancement-preview-modal");
	await preview.waitFor({ state: "visible" });
	assert((await preview.getByText("项目：Echo Notes", { exact: true }).count()) === 1, "预览未使用当前笔记的项目作用域");
	assert((await preview.getByText(/项目专词/).count()) >= 1, "预览未展示作用域匹配热词");
	assert((await preview.getByText(/当前是 Echo Notes 项目/).count()) >= 1, "预览未展示作用域匹配 Prompt");
	await preview.getByRole("button", { name: "关闭", exact: true }).click();

	await page.evaluate(async (pluginId) => {
		window.app.setting.open();
		await window.app.setting.openTabById(pluginId);
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settingTab.showDestination("memory-model");
	}, PLUGIN_ID);
	await getActivePanel(page).getByRole("tab", { name: "维护", exact: true }).click();
	const resetSettingItems = getActivePanel(page).locator(".setting-item").filter({ hasText: "教学示例" });
	const hasResetExample = await resetSettingItems.count() > 0;
	if (hasResetExample) {
		await resetSettingItems.first().getByRole("button", { name: "重置并生成示例", exact: true }).click();
	}
	if (!hasResetExample) {
		return [];
	}
	const confirmModal = page.locator(".modal").filter({ hasText: "重置转写增强示例" });
	await confirmModal.waitFor({ state: "visible" });
	assert(
		(await confirmModal.textContent())?.includes("将清空当前人工术语") &&
		(await confirmModal.textContent())?.includes("99 系统"),
		"重置确认未明确告知清空范围与备份位置"
	);
	const destructiveConfirm = confirmModal.getByRole("button", { name: "确认重置", exact: true });
	assert(await destructiveConfirm.evaluate((button) => button.classList.contains("mod-warning")), "重置确认按钮缺少危险操作语义");
	await destructiveConfirm.click();
	await confirmModal.waitFor({ state: "detached" });
	await page.waitForFunction(() => window.app.workspace.getActiveFile()?.path === "Echo Memory/07 转写增强/术语与上下文.md");
	const resetResult = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const documents = await plugin.memoryService.getTranscriptionEnhancementDocuments(plugin.settings);
		const manualContent = await window.app.vault.read(documents.manualFile);
		const candidateContent = await window.app.vault.read(documents.candidateFile);
		const backups = window.app.vault.getFiles()
			.filter((file) => file.path.startsWith("Echo Memory/99 系统/transcription-enhancement-reset-") && file.extension === "json")
			.sort((left, right) => right.stat.mtime - left.stat.mtime);
		const backupContent = backups[0] ? await window.app.vault.read(backups[0]) : "";
		const snapshot = await plugin.memoryService.buildTranscriptionEnhancement(plugin.settings, undefined, {
			enableHotwords: true,
			enableContext: true
		});
		return {
			stats: documents.stats,
			manualContent,
			candidateContent,
			backupPath: backups[0]?.path ?? "",
			backupContent,
			hotwordCount: snapshot.hotwords.length,
			contextText: snapshot.contextText ?? ""
		};
	}, PLUGIN_ID);
	assert(resetResult.stats.manualTermCount === 0 && resetResult.stats.manualPromptCount === 0 && resetResult.stats.pendingCandidateCount === 0, "重置后仍存在生效配置或待审核候选");
	assert(resetResult.hotwordCount === 0 && resetResult.contextText === "", "教学示例被错误纳入实际转写增强");
	assert(resetResult.manualContent.includes("配置示例（不会被读取）") && resetResult.manualContent.includes("> ## 项目：Echo Notes"), "重置未生成人工配置教学示例");
	assert(resetResult.candidateContent.includes("候选示例（不会被读取）"), "重置未生成候选审核教学示例");
	assert(resetResult.backupPath.endsWith(".json") && resetResult.backupContent.includes("Echo Notes AI") && resetResult.backupContent.includes("项目专词"), "重置备份未保留两份原始内容");
	return layouts;
}

async function verifyMemoryReview(page) {
	const candidatePath = "Echo Memory/02 记忆候选/2026-07-31 隔离审核 abc123.md";
	const reviewPath = "Echo Memory/02 记忆候选/2026-07-31 隔离审核 abc123.review.md";
	await page.evaluate(async ({ pluginId, candidatePath: nextCandidatePath }) => {
		window.app.setting.close();
		document.querySelectorAll(".notice").forEach((notice) => notice.remove());
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.memoryMode = "compile-profiles";
		await plugin.saveSettings();
		const manifestFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory.json");
		const legacyManifest = JSON.parse(await window.app.vault.read(manifestFile));
		delete legacyManifest.paths.aggregationsDir;
		delete legacyManifest.paths.projectAggregation;
		delete legacyManifest.paths.peopleAggregation;
		delete legacyManifest.paths.timelineAggregation;
		await window.app.vault.modify(manifestFile, `${JSON.stringify(legacyManifest, null, 2)}\n`);
		const candidate = {
			schemaVersion: 1,
			id: "memory-ui-review",
			fingerprint: "ui-review-fingerprint",
			createdAt: "2026-07-31T00:00:00.000Z",
			provider: "siliconflow",
			model: "Qwen/Qwen3.5-4B",
			traceIds: [],
			source: {
				transcriptPath: "Echo Notes UI Review.transcript.md",
				transcriptTitle: "隔离审核",
				analysisTemplateIds: ["work-minutes"]
			},
			assertions: [
				{
					id: "assertion-ui-user",
					subjectType: "user",
					subjectName: "测试用户",
					category: "mission-goal",
					predicate: "近期目标",
					value: "完成初版",
					confidence: 0.91,
					evidenceQuote: "近期目标是完成初版",
					observedAt: "2026-07-31T00:00:00.000Z",
					sourcePath: "Echo Notes UI Review.transcript.md",
					chunkIndex: 1
				},
				{
					id: "assertion-ui-project",
					subjectType: "project",
					subjectName: "Echo Notes",
					category: "status",
					predicate: "状态",
					value: "等待核验",
					confidence: 0.82,
					evidenceQuote: "Echo Notes 仍在等待核验",
					observedAt: "2026-07-31T00:00:00.000Z",
					sourcePath: "Echo Notes UI Review.transcript.md",
					chunkIndex: 1
				}
			]
		};
		const content = [
			"---",
			"echo_memory_type: candidate",
			"---",
			"",
			"# 记忆候选 · 隔离审核",
			"",
			"<!-- echo-memory-data:start -->",
			"```json",
			JSON.stringify(candidate, null, 2),
			"```",
			"<!-- echo-memory-data:end -->",
			""
		].join("\n");
		const existing = window.app.vault.getAbstractFileByPath(nextCandidatePath);
		const file = existing ?? await window.app.vault.create(nextCandidatePath, content);
		if (existing) {
			await window.app.vault.modify(existing, content);
		}
		await window.app.workspace.getLeaf(false).openFile(file);
		await window.app.commands.executeCommandById(`${pluginId}:review-current-memory-candidate`);
	}, { pluginId: PLUGIN_ID, candidatePath });

	const modal = page.locator(".echo-notes-memory-review-modal");
	await modal.waitFor({ state: "visible" });
	assert((await modal.locator(".echo-notes-memory-review-item").count()) === 2, "候选审核弹窗断言数量不正确");
	assert((await modal.locator(".echo-notes-memory-review-summary").textContent())?.includes("待审核 2"), "旧候选未迁移为待审核");

	const layouts = [];
	for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await modal.evaluate((element) => {
				element.scrollTop = 0;
			});
			const metrics = await page.evaluate((requireTouchTargets) => {
				const content = document.querySelector(".echo-notes-memory-review-modal");
				const shell = content?.closest(".modal");
				const items = [...(content?.querySelectorAll(".echo-notes-memory-review-item") ?? [])];
				const textareas = [...(content?.querySelectorAll("textarea") ?? [])];
				const buttons = [...(content?.querySelectorAll(".echo-notes-memory-review-bulk-actions button, .echo-notes-memory-review-actions button") ?? [])];
				const firstSetting = content?.querySelector(".echo-notes-memory-review-item .setting-item");
				const info = firstSetting?.querySelector(".setting-item-info");
				const control = firstSetting?.querySelector(".setting-item-control");
				return {
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
					shellFits: Boolean(shell) && shell.getBoundingClientRect().width <= window.innerWidth + 1,
					itemsFit: items.every((item) => item.scrollWidth <= item.clientWidth + 1),
					textareasFit: textareas.every((textarea) => textarea.getBoundingClientRect().right <= textarea.closest(".echo-notes-memory-review-item").getBoundingClientRect().right + 1),
					controlsStacked: Boolean(info && control && control.getBoundingClientRect().top >= info.getBoundingClientRect().bottom),
					touchTargetsMeetMinimum: !requireTouchTargets || buttons.every((button) => button.getBoundingClientRect().height >= 44)
				};
			}, viewport.mobileShell);
			const context = `memory-review/${viewport.name}/${theme}`;
			assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
			assert(metrics.contentOverflow <= 1, `${context} 审核内容出现横向溢出`);
			assert(metrics.shellFits, `${context} 审核弹窗超出 viewport`);
			assert(metrics.itemsFit && metrics.textareasFit, `${context} 审核卡片内容溢出`);
			assert(metrics.controlsStacked === viewport.mobileShell, `${context} 审核控件响应式布局不正确`);
			assert(metrics.touchTargetsMeetMinimum, `${context} 移动端审核按钮小于 44px`);
			const fileName = `memory-review-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".modal").filter({ has: modal }).screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
			layouts.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}

	await setViewportMode(page, VIEWPORTS[0], "light");
	await modal.locator("button").filter({ hasText: "全部批准" }).click();
	const userItem = modal.locator(".echo-notes-memory-review-item").filter({ hasText: "测试用户 · 近期目标" });
	const projectItem = modal.locator(".echo-notes-memory-review-item").filter({ hasText: "Echo Notes · 状态" });
	await userItem.locator(".echo-notes-memory-review-edit summary").click();
	await projectItem.locator(".echo-notes-memory-review-edit summary").click();
	await userItem.locator("textarea").nth(0).fill("完成可信审核闭环");
	await userItem.locator("textarea").nth(1).fill("隔离 UI 已核验");
	await projectItem.locator("select:not([aria-hidden=\"true\"])").first().selectOption("rejected");
	await projectItem.locator("textarea").nth(1).fill("状态仍需外部证据");
	await modal.locator("button").filter({ hasText: "保存审核" }).click();
	await modal.waitFor({ state: "detached" });

	const approvedState = await page.evaluate(async ({ reviewPath: nextReviewPath }) => {
		const reviewFile = window.app.vault.getAbstractFileByPath(nextReviewPath);
		const soulFile = window.app.vault.getAbstractFileByPath("Echo Memory/04 User/SOUL.md");
		const reviewContent = reviewFile ? await window.app.vault.read(reviewFile) : "";
		const soulContent = soulFile ? await window.app.vault.read(soulFile) : "";
		return { reviewContent, soulContent };
	}, { reviewPath });
	assert(approvedState.reviewContent.includes('"status": "approved"'), "批准状态未写入审核 sidecar");
	assert(approvedState.reviewContent.includes('"status": "rejected"'), "拒绝状态未写入审核 sidecar");
	assert(approvedState.soulContent.includes("完成可信审核闭环"), "批准后的修正值未进入 User 画像");
	assert(!approvedState.soulContent.includes("等待核验"), "拒绝断言不应进入画像");

	await page.evaluate(async ({ pluginId, reviewPath: nextReviewPath }) => {
		const reviewFile = window.app.vault.getAbstractFileByPath(nextReviewPath);
		const content = await window.app.vault.read(reviewFile);
		await window.app.vault.modify(
			reviewFile,
			content.replace("## 人工补充\n\n", "## 人工补充\n\n这段人工审核说明必须保留。\n\n")
		);
		await window.app.workspace.getLeaf(false).openFile(reviewFile);
		await window.app.commands.executeCommandById(`${pluginId}:review-current-memory-candidate`);
	}, { pluginId: PLUGIN_ID, reviewPath });
	await modal.waitFor({ state: "visible" });
	const reopenedUserItem = modal.locator(".echo-notes-memory-review-item").filter({ hasText: "测试用户 · 近期目标" });
	await reopenedUserItem.locator(".echo-notes-memory-review-edit summary").click();
	await reopenedUserItem.locator("select:not([aria-hidden=\"true\"])").first().selectOption("pending");
	await reopenedUserItem.locator("textarea").nth(1).fill("等待再次确认");
	await modal.locator("button").filter({ hasText: "保存审核" }).click();
	await modal.waitFor({ state: "detached" });

	const revertedState = await page.evaluate(async ({ reviewPath: nextReviewPath }) => {
		const reviewFile = window.app.vault.getAbstractFileByPath(nextReviewPath);
		const soulFile = window.app.vault.getAbstractFileByPath("Echo Memory/04 User/SOUL.md");
		return {
			reviewContent: await window.app.vault.read(reviewFile),
			soulContent: await window.app.vault.read(soulFile)
		};
	}, { reviewPath });
	assert(revertedState.reviewContent.includes("这段人工审核说明必须保留。"), "保存审核覆盖了人工正文");
	assert(revertedState.reviewContent.includes('"status": "pending"'), "重置待审核状态未写入 sidecar");
	assert(!revertedState.soulContent.includes("完成可信审核闭环"), "重置待审核后未从画像撤销派生内容");
	assert(revertedState.soulContent.includes("暂无已批准的候选记忆"), "撤销后画像空状态不正确");

	await page.evaluate((pluginId) => window.app.plugins.plugins[pluginId].openMemoryInbox(), PLUGIN_ID);
	const inboxCenter = page.locator(".echo-notes-memory-center-modal");
	await inboxCenter.waitFor({ state: "visible" });
	const inbox = inboxCenter.locator(".echo-notes-memory-inbox");
	await inbox.waitFor({ state: "visible" });
	assert(await inbox.locator(".echo-notes-memory-inbox-hero").count() === 1, "审核中心缺少待审核英雄条");
	assert(await inbox.locator(".echo-notes-memory-inbox-tier").count() >= 1, "审核中心缺少优先级徽标");
	assert(await inbox.locator(".echo-notes-memory-inbox-filter").count() === 4, "审核中心缺少优先级、类型、来源和排序筛选");
	const inboxCardCount = await inbox.locator(".echo-notes-memory-inbox-card").count();
	const inboxSelectCount = await inbox.locator(".echo-notes-memory-inbox-card-select").count();
	assert(await inbox.locator(".echo-notes-memory-inbox-card-select input").count() >= 1, `审核中心候选缺少选择控件：卡片 ${inboxCardCount}，选择容器 ${inboxSelectCount}`);
	assert(await inbox.locator(".echo-notes-memory-inbox-evidence-rail").count() === inboxCardCount, "审核中心候选缺少证据轨结构");
	assert(await inbox.locator(".echo-notes-memory-inbox-insight-details").count() === inboxCardCount, "审核中心次要判断依据未渐进披露");
	assert(await inbox.getByText("更多审核动作", { exact: true }).count() === inboxCardCount, "审核中心高级动作未收纳");
	assert(await inbox.getByText("批准已选", { exact: false }).count() === 1, "审核中心缺少选中批量批准入口");
	assert(await inbox.getByText("拒绝已选", { exact: false }).count() === 1, "审核中心缺少选中批量拒绝入口");
	await inbox.locator(".echo-notes-memory-inbox-card-select input").first().check();
	await inbox.getByRole("button", { name: /批准已选/ }).click();
	const inboxConfirm = page.locator(".echo-notes-memory-inbox-confirm-modal");
	await inboxConfirm.waitFor({ state: "visible" });
	assert(await inboxConfirm.getByText(/确认批准已选/).count() === 1, "批量批准缺少二次确认");
	await inboxConfirm.getByRole("button", { name: "取消", exact: true }).click();
	const inboxCardCountBeforeSort = await inbox.locator(".echo-notes-memory-inbox-card").count();
	await inbox.locator(".echo-notes-memory-inbox-filters > summary").click();
	await inbox.locator('select[aria-label="排序"]').selectOption("confidence");
	assert(await inbox.locator('.echo-notes-memory-inbox-card').count() === inboxCardCountBeforeSort, "审核中心排序后候选列表不正确");
	await page.evaluate(() => document.querySelectorAll(".notice").forEach((notice) => notice.remove()));
	for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const inboxMetrics = await inbox.evaluate((element) => ({
				documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				contentOverflow: element.scrollWidth - element.clientWidth,
				shellFits: element.closest(".modal")?.getBoundingClientRect().width <= window.innerWidth + 1,
				touchTargetsMeetMinimum: [...element.querySelectorAll(".echo-notes-memory-inbox-actions button, .echo-notes-memory-inbox-bulk-button")].every((button) => button.getBoundingClientRect().height >= 44)
			}));
			assert(inboxMetrics.documentOverflow <= 1 && inboxMetrics.contentOverflow <= 1 && inboxMetrics.shellFits, `memory-inbox/${viewport.name}/${theme} 布局出现溢出`);
			if (viewport.mobileShell) assert(inboxMetrics.touchTargetsMeetMinimum, `memory-inbox/${viewport.name}/${theme} 操作目标不足 44px`);
			const fileName = `memory-inbox-current-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await inboxCenter.screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
		}
	}
	await setViewportMode(page, VIEWPORTS[0], "light");
	return layouts;
}

	async function verifyMemoryRelations(page) {
	const setup = await page.evaluate(async (pluginId) => {
		document.querySelectorAll(".notice").forEach((notice) => notice.remove());
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.memoryMode = "compile-profiles";
		await plugin.saveSettings();
		const definitions = [
			{
				candidatePath: "Echo Memory/02 记忆候选/2026-07-30 关系旧候选 old001.md",
				id: "memory-ui-relation-old",
				fingerprint: "ui-relation-old-fingerprint",
				createdAt: "2026-07-30T08:00:00.000Z",
				assertionId: "assertion-ui-relation-old",
				value: "完成候选审核",
				evidenceQuote: "近期目标是完成候选审核",
				transcriptPath: "Echo Notes UI Relation Old.transcript.md"
			},
			{
				candidatePath: "Echo Memory/02 记忆候选/2026-07-31 关系新候选 new001.md",
				id: "memory-ui-relation-new",
				fingerprint: "ui-relation-new-fingerprint",
				createdAt: "2026-07-31T08:00:00.000Z",
				assertionId: "assertion-ui-relation-new",
				value: "完成关系模型",
				evidenceQuote: "近期目标是完成关系模型",
				transcriptPath: "Echo Notes UI Relation New.transcript.md"
			}
		];
		const candidates = [];
		for (const definition of definitions) {
			const transcript = window.app.vault.getAbstractFileByPath(definition.transcriptPath) ??
				await window.app.vault.create(
					definition.transcriptPath,
					`# 转写稿\n\n${definition.evidenceQuote}。\n`
				);
			const candidate = {
				schemaVersion: 1,
				id: definition.id,
				fingerprint: definition.fingerprint,
				createdAt: definition.createdAt,
				provider: "ollama",
				model: "isolated-relation-model",
				traceIds: [],
				source: {
					transcriptPath: transcript.path,
					transcriptTitle: transcript.basename,
					analysisTemplateIds: []
				},
				assertions: [
					{
						id: definition.assertionId,
						subjectType: "user",
						subjectName: "测试用户",
						category: "mission-goal",
						predicate: "近期目标",
						value: definition.value,
						confidence: 0.95,
						evidenceQuote: definition.evidenceQuote,
						observedAt: definition.createdAt,
						sourcePath: transcript.path,
						chunkIndex: 1
					},
					{
						id: `${definition.assertionId}-project`,
						subjectType: "project",
						subjectName: "Echo Notes",
						category: "status",
						predicate: "阶段",
						value: definition.value,
						confidence: 0.93,
						evidenceQuote: definition.evidenceQuote,
						observedAt: definition.createdAt,
						sourcePath: transcript.path,
						chunkIndex: 1
					},
					{
						id: `${definition.assertionId}-person`,
						subjectType: "person",
						subjectName: "测试负责人",
						category: "responsibility",
						predicate: "负责事项",
						value: definition.value,
						confidence: 0.91,
						evidenceQuote: definition.evidenceQuote,
						observedAt: definition.createdAt,
						sourcePath: transcript.path,
						chunkIndex: 1
					}
				]
			};
			const content = [
				"---",
				"echo_memory_type: candidate",
				"---",
				"",
				`# 记忆候选 · ${transcript.basename}`,
				"",
				"<!-- echo-memory-data:start -->",
				"```json",
				JSON.stringify(candidate, null, 2),
				"```",
				"<!-- echo-memory-data:end -->",
				""
			].join("\n");
			const existing = window.app.vault.getAbstractFileByPath(definition.candidatePath);
			const candidateFile = existing ?? await window.app.vault.create(definition.candidatePath, content);
			if (existing) {
				await window.app.vault.modify(existing, content);
			}
			const context = await plugin.memoryService.getReviewContext(plugin.settings, candidateFile);
			await plugin.memoryService.saveMemoryReview(
				plugin.settings,
				definition.candidatePath,
				candidate.assertions.map((assertion) => ({
					assertionId: assertion.id,
					status: "approved",
					effectiveValue: assertion.value,
					note: "隔离关系与聚合验证"
				}))
			);
			candidates.push({
				path: definition.candidatePath,
				content: await window.app.vault.read(candidateFile),
				reviewPath: context.reviewPath,
				reviewContent: await window.app.vault.read(window.app.vault.getAbstractFileByPath(context.reviewPath))
			});
		}
		const aggregationPaths = {
			projects: "Echo Memory/05 聚合/项目.md",
			people: "Echo Memory/05 聚合/人物.md",
			timeline: "Echo Memory/05 聚合/时间线.md"
		};
		const projectAggregationFile = window.app.vault.getAbstractFileByPath(aggregationPaths.projects);
		const projectAggregationContent = await window.app.vault.read(projectAggregationFile);
		await window.app.vault.modify(
			projectAggregationFile,
			projectAggregationContent.replace("## 人工内容\n\n", "## 人工内容\n\n这段跨记录项目判断必须保留。\n\n")
		);
		await window.app.vault.create(
			"Vault 外部聚合噪声.md",
			"# 不应进入 Echo Memory\n\n外部噪声断言：不得扫描。\n"
		);
		const unreviewed = {
			...definitions[0],
			candidatePath: "Echo Memory/02 记忆候选/2026-07-29 关系未审核候选 pending001.md",
			id: "memory-ui-relation-pending",
			fingerprint: "ui-relation-pending-fingerprint",
			assertionId: "assertion-ui-relation-pending",
			value: "尚未审核的旧目标",
			createdAt: "2026-07-29T08:00:00.000Z"
		};
		const unreviewedCandidate = {
			schemaVersion: 1,
			id: unreviewed.id,
			fingerprint: unreviewed.fingerprint,
			createdAt: unreviewed.createdAt,
			provider: "ollama",
			model: "isolated-relation-model",
			traceIds: [],
			source: {
				transcriptPath: definitions[0].transcriptPath,
				transcriptTitle: "Relation pending",
				analysisTemplateIds: []
			},
			assertions: [{
				id: unreviewed.assertionId,
				subjectType: "user",
				subjectName: "测试用户",
				category: "mission-goal",
				predicate: "近期目标",
				value: unreviewed.value,
				confidence: 0.95,
				evidenceQuote: definitions[0].evidenceQuote,
				observedAt: unreviewed.createdAt,
				sourcePath: definitions[0].transcriptPath,
				chunkIndex: 1
			}]
		};
		await window.app.vault.create(unreviewed.candidatePath, [
			"---",
			"echo_memory_type: candidate",
			"---",
			"",
			"<!-- echo-memory-data:start -->",
			"```json",
			JSON.stringify(unreviewedCandidate, null, 2),
			"```",
			"<!-- echo-memory-data:end -->",
			""
		].join("\n"));
		const current = window.app.vault.getAbstractFileByPath(definitions[1].candidatePath);
		await window.app.workspace.getLeaf(false).openFile(current);
		await window.app.commands.executeCommandById(`${pluginId}:manage-current-memory-relations`);
		return {
			candidates,
			unreviewedReviewPath: unreviewed.candidatePath.replace(/\.md$/i, ".review.md"),
			aggregationPaths
		};
	}, PLUGIN_ID);

	const modal = page.locator(".echo-notes-memory-relation-modal");
	await modal.waitFor({ state: "visible" });
	assert((await modal.locator(".echo-notes-memory-relation-editor select:not(.is-measuring)").count()) === 3, "记忆关系编辑器控件不完整");
	assert((await modal.locator(".echo-notes-memory-relation-list .echo-notes-memory-relation-item").count()) === 0, "新候选不应已有关系");
	assert(await page.evaluate((reviewPath) => !window.app.vault.getAbstractFileByPath(reviewPath), setup.unreviewedReviewPath), "打开关系管理意外补建了未审核 sidecar");

	const layouts = [];
	for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await modal.evaluate((element) => {
				element.scrollTop = 0;
			});
			const metrics = await page.evaluate((requireTouchTargets) => {
				const content = document.querySelector(".echo-notes-memory-relation-modal");
				const shell = content?.closest(".modal");
				const controls = [...(content?.querySelectorAll("select, textarea, input") ?? [])];
				const buttons = [...(content?.querySelectorAll(".echo-notes-memory-relation-actions button, .echo-notes-memory-relation-item button") ?? [])];
				const firstSetting = content?.querySelector(".echo-notes-memory-relation-editor .setting-item");
				const info = firstSetting?.querySelector(".setting-item-info");
				const control = firstSetting?.querySelector(".setting-item-control");
				return {
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
					shellFits: Boolean(shell) && shell.getBoundingClientRect().width <= window.innerWidth + 1,
					controlsFit: controls.every((element) => element.getBoundingClientRect().right <= content.getBoundingClientRect().right + 1),
					controlsStacked: Boolean(info && control && control.getBoundingClientRect().top >= info.getBoundingClientRect().bottom),
					touchTargetsMeetMinimum: !requireTouchTargets || buttons.every((button) => button.getBoundingClientRect().height >= 44)
				};
			}, viewport.mobileShell);
			const context = `memory-relation/${viewport.name}/${theme}`;
			assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
			assert(metrics.contentOverflow <= 1, `${context} 关系内容出现横向溢出`);
			assert(metrics.shellFits && metrics.controlsFit, `${context} 关系弹窗或控件超出 viewport`);
			assert(metrics.controlsStacked === viewport.mobileShell, `${context} 关系控件响应式布局不正确`);
			assert(metrics.touchTargetsMeetMinimum, `${context} 移动端关系按钮小于 44px`);
			const fileName = `memory-relation-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".modal").filter({ has: modal }).screenshot({ path: screenshotPath });
			assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
			layouts.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}

	await setViewportMode(page, VIEWPORTS[0], "light");
	const relationTypeSetting = modal.locator(".setting-item").filter({ hasText: "它们是什么关系" });
	await relationTypeSetting.locator("select:not([aria-hidden=\"true\"])").selectOption("supersedes");
	await modal.locator(".setting-item").filter({ hasText: "关系备注" }).locator("textarea").fill("新目标替代旧目标");
	await modal.locator("button").filter({ hasText: "确认关系" }).click();
	await modal.locator(".echo-notes-memory-relation-item").filter({ hasText: "替代旧记忆 · 生效" }).waitFor({ state: "visible" });

	const activeState = await page.evaluate(async ({ candidates, aggregationPaths }) => {
		const relationFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory-relations.json");
		const soulFile = window.app.vault.getAbstractFileByPath("Echo Memory/04 User/SOUL.md");
		const manifestFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory.json");
		const homeFile = window.app.vault.getAbstractFileByPath("Echo Memory/00 首页.md");
		return {
			relationContent: await window.app.vault.read(relationFile),
			soulContent: await window.app.vault.read(soulFile),
			manifest: JSON.parse(await window.app.vault.read(manifestFile)),
			homeContent: await window.app.vault.read(homeFile),
			projectAggregation: await window.app.vault.read(window.app.vault.getAbstractFileByPath(aggregationPaths.projects)),
			peopleAggregation: await window.app.vault.read(window.app.vault.getAbstractFileByPath(aggregationPaths.people)),
			timelineAggregation: await window.app.vault.read(window.app.vault.getAbstractFileByPath(aggregationPaths.timeline)),
			candidateContents: await Promise.all(candidates.map(async (candidate) =>
				window.app.vault.read(window.app.vault.getAbstractFileByPath(candidate.path)))),
			reviewContents: await Promise.all(candidates.map(async (candidate) =>
				window.app.vault.read(window.app.vault.getAbstractFileByPath(candidate.reviewPath))))
		};
	}, setup);
	const activeStore = JSON.parse(activeState.relationContent);
	const activeRelation = Object.values(activeStore.relations)[0];
	assert(activeRelation.status === "active", "确认后的记忆关系未处于生效状态");
	assert(activeRelation.history.length === 1, "确认关系未写入首个历史事件");
	assert(!activeState.relationContent.includes("evidenceQuote"), "新关系 JSON 仍持久化了原文证据");
	assert(activeState.soulContent.includes("- **近期目标**：完成关系模型"), "替代关系的来源断言未进入画像");
	assert(!activeState.soulContent.includes("- **近期目标**：完成候选审核"), "替代关系的目标断言仍作为事实留在画像");
	assert(activeState.soulContent.includes(activeRelation.id), "画像未记录关系 ID");
	assert(activeState.soulContent.includes("关联：近期目标：完成候选审核"), "画像未保留被替代记忆的审计回链");
	assert(activeState.manifest.paths.aggregationsDir === "Echo Memory/05 聚合", "旧 Manifest 未补齐聚合目录路径");
	assert(activeState.manifest.paths.timelineAggregation === setup.aggregationPaths.timeline, "旧 Manifest 未补齐时间线路径");
	assert(activeState.homeContent.includes(`[[${setup.aggregationPaths.projects}|项目]]`), "Echo Memory 首页缺少项目聚合入口");
	assert(activeState.homeContent.includes(`[[${setup.aggregationPaths.people}|人物]]`), "Echo Memory 首页缺少人物聚合入口");
	assert(activeState.homeContent.includes(`[[${setup.aggregationPaths.timeline}|时间线]]`), "Echo Memory 首页缺少时间线入口");
	assert(activeState.projectAggregation.includes("这段跨记录项目判断必须保留。"), "聚合重建覆盖了项目页人工内容");
	assert(activeState.projectAggregation.includes("- 2026-07-30T08:00:00.000Z · **阶段**：完成候选审核"), "项目聚合缺少旧记录");
	assert(activeState.projectAggregation.includes("- 2026-07-31T08:00:00.000Z · **阶段**：完成关系模型"), "项目聚合缺少新记录");
	assert(activeState.projectAggregation.indexOf("完成候选审核") < activeState.projectAggregation.indexOf("完成关系模型"), "项目聚合时间排序不稳定");
	assert(activeState.projectAggregation.includes("Echo Notes UI Relation Old.transcript.md|transcript"), "项目聚合缺少 transcript 回链");
	assert(activeState.projectAggregation.includes(setup.candidates[0].reviewPath), "项目聚合缺少审核回链");
	assert(activeState.peopleAggregation.includes("**负责事项**：完成候选审核"), "人物聚合缺少旧记录");
	assert(activeState.peopleAggregation.includes("**负责事项**：完成关系模型"), "人物聚合缺少新记录");
	assert(activeState.timelineAggregation.includes("**测试用户 · 近期目标**：完成关系模型"), "时间线缺少当前用户目标");
	assert(!activeState.timelineAggregation.includes("**测试用户 · 近期目标**：完成候选审核"), "时间线未应用替代关系");
	assert(activeState.timelineAggregation.includes(activeRelation.id), "时间线缺少关系 ID");
	assert(!activeState.timelineAggregation.includes("尚未审核的旧目标"), "时间线纳入了未审核候选");
	assert(!activeState.timelineAggregation.includes("外部噪声断言"), "聚合扫描了 Echo Memory 候选目录之外的笔记");
	assert(JSON.stringify(activeState.candidateContents) === JSON.stringify(setup.candidates.map((candidate) => candidate.content)), "确认关系改写了原始候选包");
	assert(JSON.stringify(activeState.reviewContents) === JSON.stringify(setup.candidates.map((candidate) => candidate.reviewContent)), "确认关系改写了审核 sidecar");
	assert(await page.evaluate((reviewPath) => !window.app.vault.getAbstractFileByPath(reviewPath), setup.unreviewedReviewPath), "确认关系意外补建了未审核 sidecar");

	const legacyCleanupState = await page.evaluate(async ({ pluginId, candidatePath }) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const relationFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory-relations.json");
		const legacyStore = JSON.parse(await window.app.vault.read(relationFile));
		const relation = Object.values(legacyStore.relations)[0];
		relation.source.evidenceQuote = "旧关系来源原文证据";
		relation.target.evidenceQuote = "旧关系目标原文证据";
		for (const event of relation.history) {
			event.source.evidenceQuote = "旧历史来源原文证据";
			event.target.evidenceQuote = "旧历史目标原文证据";
		}
		await window.app.vault.modify(relationFile, `${JSON.stringify(legacyStore, null, 2)}\n`);
		const candidateFile = window.app.vault.getAbstractFileByPath(candidatePath);
		const context = await plugin.memoryService.getMemoryRelationContext(plugin.settings, candidateFile);
		const sanitizedContent = await window.app.vault.read(relationFile);
		return {
			sanitizedContent,
			schemaVersion: JSON.parse(sanitizedContent).schemaVersion,
			approvedEvidenceCount: context.approvedEndpoints.filter((endpoint) => endpoint.evidenceQuote).length
		};
	}, { pluginId: PLUGIN_ID, candidatePath: setup.candidates[1].path });
	assert(!legacyCleanupState.sanitizedContent.includes("evidenceQuote"), "读取旧关系文件后未惰性清理原文证据");
	assert(legacyCleanupState.schemaVersion === 1, "旧关系惰性清理意外升级了 schema version");
	assert(legacyCleanupState.approvedEvidenceCount > 0, "关系编辑上下文未继续从当前批准候选包读取原文证据");

	const relationItem = modal.locator(".echo-notes-memory-relation-item").filter({ hasText: activeRelation.id });
	await relationItem.locator('input[type="text"]').fill("旧目标重新生效");
	await relationItem.locator("button").filter({ hasText: "撤销关系" }).click();
	await modal.locator(".echo-notes-memory-relation-item").filter({ hasText: "替代旧记忆 · 已撤销" }).waitFor({ state: "visible" });

	const revokedState = await page.evaluate(async ({ candidates, aggregationPaths }) => {
		const relationFile = window.app.vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory-relations.json");
		const soulFile = window.app.vault.getAbstractFileByPath("Echo Memory/04 User/SOUL.md");
		return {
			relationContent: await window.app.vault.read(relationFile),
			soulContent: await window.app.vault.read(soulFile),
			projectAggregation: await window.app.vault.read(window.app.vault.getAbstractFileByPath(aggregationPaths.projects)),
			timelineAggregation: await window.app.vault.read(window.app.vault.getAbstractFileByPath(aggregationPaths.timeline)),
			candidateContents: await Promise.all(candidates.map(async (candidate) =>
				window.app.vault.read(window.app.vault.getAbstractFileByPath(candidate.path)))),
			reviewContents: await Promise.all(candidates.map(async (candidate) =>
				window.app.vault.read(window.app.vault.getAbstractFileByPath(candidate.reviewPath))))
		};
	}, setup);
	const revokedRelation = Object.values(JSON.parse(revokedState.relationContent).relations)[0];
	assert(revokedRelation.status === "revoked", "撤销后的记忆关系状态不正确");
	assert(revokedRelation.history.length === 2, "撤销关系未追加历史事件");
	assert(revokedRelation.history[1].note === "旧目标重新生效", "撤销关系备注未写入历史");
	assert(revokedState.soulContent.includes("- **近期目标**：完成关系模型"), "撤销关系后新目标意外消失");
	assert(revokedState.soulContent.includes("- **近期目标**：完成候选审核"), "撤销关系后旧目标未恢复到画像");
	assert(revokedState.timelineAggregation.includes("**测试用户 · 近期目标**：完成候选审核"), "撤销关系后旧目标未恢复到时间线");
	assert(revokedState.projectAggregation.includes("这段跨记录项目判断必须保留。"), "撤销关系时覆盖了聚合人工内容");
	assert(JSON.stringify(revokedState.candidateContents) === JSON.stringify(setup.candidates.map((candidate) => candidate.content)), "撤销关系改写了原始候选包");
	assert(JSON.stringify(revokedState.reviewContents) === JSON.stringify(setup.candidates.map((candidate) => candidate.reviewContent)), "撤销关系改写了审核 sidecar");
	assert(await page.evaluate((reviewPath) => !window.app.vault.getAbstractFileByPath(reviewPath), setup.unreviewedReviewPath), "撤销关系意外补建了未审核 sidecar");
	if (await page.locator(".modal-close-button").count() === 0) {
		await page.keyboard.press("Escape");
	} else {
		await page.locator(".modal-close-button").last().click();
	}
	await modal.waitFor({ state: "detached" });
	await page.evaluate(async (pluginId) => {
		await window.app.commands.executeCommandById(`${pluginId}:open-echo-memory-timeline`);
	}, PLUGIN_ID);
	await page.waitForFunction(
		(expectedPath) => window.app.workspace.getActiveFile()?.path === expectedPath,
		setup.aggregationPaths.timeline
	);
		return layouts;
	}

	async function verifyMemoryContextPackage(page, providerMock) {
		await page.evaluate(async (pluginId) => {
			await window.app.commands.executeCommandById(`${pluginId}:create-personal-agent-context-package`);
		}, PLUGIN_ID);
	const modal = page.locator(".echo-notes-memory-context-modal");
	await modal.waitFor({ state: "visible" });
	await page.evaluate(() => document.querySelectorAll(".notice").forEach((notice) => notice.remove()));
	assert((await modal.locator(".echo-notes-memory-context-editor select:not(.is-measuring)").count()) === 3, "上下文包项目、人物与用途筛选控件不完整");
		assert(
			(await modal.locator(".echo-notes-memory-context-editor input[type='date'], .echo-notes-memory-context-editor input[type='number']").count()) === 3,
			"上下文包日期和预算控件不完整"
		);
		assert(
			(await modal.locator(".echo-notes-memory-context-editor input[type='checkbox']").count()) === 11,
			"上下文包记忆类型、时效与“全部”筛选控件不完整"
		);
		const initialSummary = await modal.locator(".echo-notes-memory-context-summary").textContent();
		assert(initialSummary?.includes("匹配"), "上下文包缺少生成前预览摘要");

		const layouts = [];
		for (const viewport of [VIEWPORTS[0], VIEWPORTS[2]]) {
			for (const theme of THEMES) {
				await setViewportMode(page, viewport, theme);
				await modal.evaluate((element) => {
					element.scrollTop = 0;
				});
				const metrics = await page.evaluate((requireTouchTargets) => {
					const content = document.querySelector(".echo-notes-memory-context-modal");
					const shell = content?.closest(".modal");
					const controls = [...(content?.querySelectorAll("select, input") ?? [])];
					const buttons = [...(content?.querySelectorAll(".echo-notes-memory-context-actions button") ?? [])];
					return {
						documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
						contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
						shellFits: Boolean(shell) && shell.getBoundingClientRect().width <= window.innerWidth + 1,
						controlsFit: controls.every((element) => element.getBoundingClientRect().right <= content.getBoundingClientRect().right + 1),
						touchTargetsMeetMinimum: !requireTouchTargets || buttons.every((button) => button.getBoundingClientRect().height >= 44)
					};
				}, viewport.mobileShell);
				const context = `memory-context/${viewport.name}/${theme}`;
				assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
				assert(metrics.contentOverflow <= 1, `${context} 上下文内容出现横向溢出`);
				assert(metrics.shellFits && metrics.controlsFit, `${context} 上下文弹窗或控件超出 viewport`);
				assert(metrics.touchTargetsMeetMinimum, `${context} 移动端上下文按钮小于 44px`);
				const fileName = `memory-context-${viewport.name}-${theme}.png`;
				const screenshotPath = path.join(OUTPUT_DIR, fileName);
				await page.locator(".modal").filter({ has: modal }).screenshot({ path: screenshotPath });
				assert((await stat(screenshotPath)).size > 8_000, `${fileName} 截图可能为空白`);
				layouts.push({ viewport: viewport.name, theme, fileName, metrics });
			}
		}

		await setViewportMode(page, VIEWPORTS[0], "light");
		await modal.locator(".setting-item").filter({ hasText: "项目" }).locator("select:not([aria-hidden=\"true\"])").selectOption({ label: "Echo Notes" });
		await modal.locator(".setting-item").filter({ hasText: "开始日期" }).locator("input").fill("2026-07-30");
		await modal.locator(".setting-item").filter({ hasText: "结束日期" }).locator("input").fill("2026-07-31");
		await modal.locator(".setting-item").filter({ hasText: "字符预算" }).locator("input").fill("4000");
		const filteredSummary = await modal.locator(".echo-notes-memory-context-summary").textContent();
		assert(filteredSummary?.includes("匹配 2"), `项目与日期筛选结果不正确：${filteredSummary}`);
		assert(filteredSummary?.includes("/4000 字符"), `字符预算未应用：${filteredSummary}`);
		const callsBeforeGeneration = providerMock.calls.length;
		await modal.locator("button").filter({ hasText: "生成上下文包" }).click();
		await modal.waitFor({ state: "detached" });
		const generatedPath = await page.evaluate(() => window.app.workspace.getActiveFile()?.path ?? "");
		assert(/^Echo Memory\/06 上下文包\/上下文 \d{4}-\d{2}-\d{2} [a-f0-9]+\.md$/.test(generatedPath), `上下文包路径不正确：${generatedPath}`);
		const firstContent = await page.evaluate(async (targetPath) => {
			const file = window.app.vault.getAbstractFileByPath(targetPath);
			return file ? window.app.vault.read(file) : "";
		}, generatedPath);
		assert(firstContent.length <= 4_000, "上下文包超过字符预算");
		assert(firstContent.includes("Echo Notes UI Relation Old.transcript.md|transcript"), "上下文包缺少 transcript 回链");
		assert(firstContent.includes("候选审核"), "上下文包缺少已批准旧记录");
		assert(firstContent.includes("关系模型"), "上下文包缺少已批准新记录");
		assert(!firstContent.includes("尚未审核的旧目标"), "上下文包纳入了未审核候选");
		assert(!firstContent.includes("外部噪声断言"), "上下文包扫描了候选目录之外的笔记");
		assert(providerMock.calls.length === callsBeforeGeneration, "生成上下文包新增了外部 HTTP 请求");

		await page.evaluate(async (targetPath) => {
			const file = window.app.vault.getAbstractFileByPath(targetPath);
			const content = await window.app.vault.read(file);
			await window.app.vault.modify(file, content.replace("## 人工内容\n\n", "## 人工内容\n\n这段上下文使用说明必须保留。\n\n"));
		}, generatedPath);
		await page.evaluate(async (pluginId) => {
			await window.app.commands.executeCommandById(`${pluginId}:create-personal-agent-context-package`);
		}, PLUGIN_ID);
		await modal.waitFor({ state: "visible" });
		await modal.locator(".setting-item").filter({ hasText: "项目" }).locator("select:not([aria-hidden=\"true\"])").selectOption({ label: "Echo Notes" });
		await modal.locator(".setting-item").filter({ hasText: "开始日期" }).locator("input").fill("2026-07-30");
		await modal.locator(".setting-item").filter({ hasText: "结束日期" }).locator("input").fill("2026-07-31");
		await modal.locator(".setting-item").filter({ hasText: "字符预算" }).locator("input").fill("4000");
		await modal.locator("button").filter({ hasText: "生成上下文包" }).click();
		await modal.waitFor({ state: "detached" });
		const regeneratedContent = await page.evaluate(async (targetPath) => {
			const file = window.app.vault.getAbstractFileByPath(targetPath);
			return file ? window.app.vault.read(file) : "";
		}, generatedPath);
		assert(regeneratedContent.includes("这段上下文使用说明必须保留。"), "重新生成上下文包覆盖了人工正文");
		assert(providerMock.calls.length === callsBeforeGeneration, "重复生成上下文包新增了外部 HTTP 请求");
		return layouts;
	}

async function setViewportMode(page, viewport, theme) {
	await page.setViewportSize({ width: viewport.width, height: viewport.height });
	await page.evaluate(
		({ mobileShellClass, mobileShell, nextTheme }) => {
			document.body.classList.remove("theme-light", "theme-dark", "is-mobile", mobileShellClass);
			document.body.classList.add(`theme-${nextTheme}`);
			if (mobileShell) {
				document.body.classList.add(mobileShellClass);
			}
			const content = document.querySelector(".vertical-tab-content");
			if (content) {
				content.scrollTop = 0;
			}
		},
		{ mobileShellClass: MOBILE_SHELL_CLASS, mobileShell: viewport.mobileShell, nextTheme: theme }
	);
}

async function inspectNamedSettingControls(page, settingNames) {
	return getActivePanel(page).evaluate((panel, expectedNames) => {
		const activeSection = panel.querySelector(".echo-notes-settings-section-panel:not([hidden])");
		const expectedFieldHeight = Number.parseFloat(
			getComputedStyle(activeSection ?? panel).getPropertyValue("--input-height")
		) || 30;
		return expectedNames.map((name) => {
			const settingItem = [...(activeSection?.querySelectorAll(".setting-item") ?? [])].find(
				(item) => item.querySelector(".setting-item-name")?.textContent?.trim() === name
			);
			const control = settingItem?.querySelector(":scope > .setting-item-control");
			const interactive = control?.querySelector(":scope > input, :scope > select, :scope > button, :scope > .checkbox-container");
			const field = control?.querySelector(
				':scope > input[type="text"], :scope > input[type="password"], ' +
				':scope > input[type="number"], :scope > input[type="url"], ' +
				':scope > input[type="search"], :scope > select'
			);
			const feedback = control?.querySelector(":scope > .echo-notes-inline-validation");
			const controlRect = control?.getBoundingClientRect();
			const interactiveRect = interactive?.getBoundingClientRect();
			const fieldRect = field?.getBoundingClientRect();
			const feedbackRect = feedback?.getBoundingClientRect();
			return {
				name,
				found: Boolean(settingItem && control && interactive),
				controlRight: controlRect?.right ?? 0,
				controlWidth: controlRect?.width ?? 0,
				interactiveRight: interactiveRect?.right ?? 0,
				interactiveWidth: interactiveRect?.width ?? 0,
				interactiveHeight: interactiveRect?.height ?? 0,
				interactiveTag: interactive?.tagName ?? "",
				isUniformField: Boolean(field),
				hasUniformFieldClass: field?.classList.contains("echo-notes-settings-field") ?? false,
				fieldWidth: fieldRect?.width ?? 0,
				fieldHeight: fieldRect?.height ?? 0,
				expectedFieldHeight,
				feedbackCount: control?.querySelectorAll(":scope > .echo-notes-inline-validation").length ?? 0,
				feedbackBelowControl: Boolean(
					interactiveRect && feedbackRect && feedbackRect.top >= interactiveRect.bottom - 1
				),
				feedbackTextAlign: feedback ? getComputedStyle(feedback).textAlign : null
			};
		});
	}, settingNames);
}

function assertAlignedControlGroup(metrics, context) {
	assert(metrics.every((metric) => metric.found), `${context} 缺少控件：${JSON.stringify(metrics)}`);
	const rightEdges = metrics.map((metric) => metric.controlRight);
	assert(
		Math.max(...rightEdges) - Math.min(...rightEdges) <= 1.5,
		`${context} 控制列右边界未对齐：${JSON.stringify(metrics)}`
	);
	for (const metric of metrics) {
		assert(
			Math.abs(metric.controlWidth - 320) <= 1.5,
			`${context}/${metric.name} 桌面控制列宽度不是 320px：${metric.controlWidth}`
		);
		assert(
			Math.abs(metric.interactiveRight - metric.controlRight) <= 1.5,
			`${context}/${metric.name} 控件未贴齐控制列右边界`
		);
		if (metric.isUniformField) {
			assert(metric.hasUniformFieldClass, `${context}/${metric.name} 缺少统一字段 class`);
			assert(
				Math.abs(metric.fieldWidth - metric.controlWidth) <= 1.5,
				`${context}/${metric.name} 单字段未占满控制列`
			);
			assert(
				Math.abs(metric.fieldHeight - metric.expectedFieldHeight) <= 1,
				`${context}/${metric.name} 字段高度不是 ${metric.expectedFieldHeight}px：${metric.fieldHeight}`
			);
		}
	}
}

async function verifyApiKeyFeedback(page, settingName, context) {
	const settingItem = await getActiveSetting(page, settingName);
	const inspect = () => settingItem.evaluate((item) => {
		const control = item.querySelector(":scope > .setting-item-control");
		const input = control?.querySelector(':scope > input[type="password"]');
		const feedback = control?.querySelector(":scope > .echo-notes-secret-save-status");
		const inputRect = input?.getBoundingClientRect();
		const feedbackRect = feedback?.getBoundingClientRect();
		return {
			statusCount: item.querySelectorAll(".echo-notes-secret-save-status").length,
			inlineFeedbackCount: item.querySelectorAll(".echo-notes-inline-validation").length,
			statusInDescription: Boolean(item.querySelector(".setting-item-description .echo-notes-secret-save-status")),
			statusInControl: Boolean(feedback && feedback.parentElement === control),
			statusAfterInput: Boolean(input && feedback && input.nextElementSibling === feedback),
			statusBelowInput: Boolean(inputRect && feedbackRect && feedbackRect.top >= inputRect.bottom - 1),
			role: feedback?.getAttribute("role") ?? null,
			ariaLive: feedback?.getAttribute("aria-live") ?? null,
			textAlign: feedback ? getComputedStyle(feedback).textAlign : null,
			inputWidth: inputRect?.width ?? 0,
			inputHeight: inputRect?.height ?? 0,
			controlWidth: control?.getBoundingClientRect().width ?? 0,
			hasUniformFieldClass: input?.classList.contains("echo-notes-settings-field") ?? false,
			statusText: feedback?.textContent?.trim() ?? ""
		};
	});
	const metrics = await inspect();
	assert(
		metrics.statusCount === 1 && metrics.inlineFeedbackCount === 1,
		`${context} API key 应只有一个反馈节点：${JSON.stringify(metrics)}`
	);
	assert(!metrics.statusInDescription && metrics.statusInControl, `${context} API key 反馈必须位于控制列`);
	assert(metrics.statusAfterInput && metrics.statusBelowInput, `${context} API key 反馈必须位于输入框下方`);
	assert(metrics.role === "status" && metrics.ariaLive === "polite", `${context} API key 反馈 ARIA 不完整`);
	assert(metrics.textAlign === "right", `${context} API key 桌面反馈应右对齐`);
	assert(metrics.hasUniformFieldClass, `${context} API key 输入框缺少统一字段 class`);

	const input = settingItem.locator('.setting-item-control > input[type="password"]');
	const feedback = settingItem.locator(".echo-notes-secret-save-status");
	await input.fill(`sk-echo-notes-ui-${context}`);
	await input.blur();
	await feedback.filter({ hasText: "已安全保存" }).waitFor({ state: "visible" });
	const savedMetrics = await inspect();
	assert(savedMetrics.statusText === "已安全保存", `${context} API key 未显示安全保存状态`);
	assert(
		Math.abs(savedMetrics.inputWidth - metrics.inputWidth) <= 1 &&
		Math.abs(savedMetrics.inputHeight - metrics.inputHeight) <= 1 &&
		Math.abs(savedMetrics.controlWidth - metrics.controlWidth) <= 1,
		`${context} API key 保存状态改变了字段尺寸：${JSON.stringify({ metrics, savedMetrics })}`
	);

	await input.fill("");
	await input.blur();
	await feedback.filter({ hasText: "已清除" }).waitFor({ state: "visible" });
	const clearedMetrics = await inspect();
	assert(clearedMetrics.statusText === "已清除", `${context} API key 测试值未清除`);
	assert(
		Math.abs(clearedMetrics.inputWidth - metrics.inputWidth) <= 1 &&
		Math.abs(clearedMetrics.inputHeight - metrics.inputHeight) <= 1,
		`${context} API key 清除状态改变了字段尺寸`
	);
	return { initial: metrics, saved: savedMetrics, cleared: clearedMetrics };
}

async function verifyApiKeyLink(page, settingName, context, expected = {
	label: "获取硅基流动 API Key",
	href: "https://cloud.siliconflow.cn/i/uTf2euFF"
}) {
	const settingItem = await getActiveSetting(page, settingName);
	const link = settingItem.locator(".echo-notes-settings-api-key-link");
	assert((await link.count()) === 1, `${context} 应显示一个 API key 获取入口`);
	// 先建立键盘导航上下文，再聚焦链接；仅 programmatic focus 不一定触发 :focus-visible。
	await page.keyboard.press("Tab");
	await link.focus();
	const metrics = await settingItem.evaluate((item) => {
		const description = item.querySelector(".setting-item-description");
		const row = description?.querySelector(":scope > .echo-notes-settings-api-key-link-row");
		const linkEl = row?.querySelector(":scope > .echo-notes-settings-api-key-link");
		const icon = linkEl?.querySelector(".echo-notes-settings-api-key-link-icon");
		const rowRect = row?.getBoundingClientRect();
		const linkRect = linkEl?.getBoundingClientRect();
		const linkStyle = linkEl ? getComputedStyle(linkEl) : null;
		return {
			label: linkEl?.textContent?.trim() ?? "",
			href: linkEl?.getAttribute("href") ?? "",
			target: linkEl?.getAttribute("target") ?? null,
			rel: linkEl?.getAttribute("rel") ?? "",
			rowDisplay: row ? getComputedStyle(row).display : null,
			linkDisplay: linkStyle?.display ?? null,
			whiteSpace: linkStyle?.whiteSpace ?? null,
			borderWidth: Number.parseFloat(linkStyle?.borderTopWidth ?? "0"),
			focusOutlineWidth: Number.parseFloat(linkStyle?.outlineWidth ?? "0"),
			focusOutlineStyle: linkStyle?.outlineStyle ?? null,
			focused: document.activeElement === linkEl,
			rowOnlyContainsLink: row?.children.length === 1 && row.firstElementChild === linkEl,
			rowContainsLink: Boolean(rowRect && linkRect && linkRect.left >= rowRect.left - 1 && linkRect.right <= rowRect.right + 1),
			linkOverflow: linkEl ? linkEl.scrollWidth - linkEl.clientWidth : Number.POSITIVE_INFINITY,
			iconAriaHidden: icon?.getAttribute("aria-hidden") ?? null,
			hasExternalLinkIcon: Boolean(icon?.querySelector("svg"))
		};
	});
	assert(metrics.label === expected.label, `${context} API Key 入口文案不正确`);
	assert(metrics.href === expected.href, `${context} API key 入口 URL 不正确`);
	assert(metrics.target === "_blank" && metrics.rel.split(/\s+/).includes("noopener") && metrics.rel.split(/\s+/).includes("noreferrer"), `${context} API key 外链安全属性不完整`);
	assert(metrics.rowDisplay === "block" && metrics.rowOnlyContainsLink, `${context} API key 入口未使用独立操作行`);
	assert(metrics.linkDisplay === "inline-flex" && metrics.whiteSpace === "nowrap", `${context} API key 入口样式不完整`);
	assert(metrics.borderWidth >= 1 && metrics.rowContainsLink && metrics.linkOverflow <= 1, `${context} API key 入口边框或尺寸异常`);
	assert(metrics.iconAriaHidden === "true" && metrics.hasExternalLinkIcon, `${context} API key 入口缺少可访问的外链图标`);
	assert(metrics.focused && metrics.focusOutlineStyle !== "none" && metrics.focusOutlineWidth >= 1, `${context} API key 入口焦点样式不可见`);
	return metrics;
}

async function verifySettingsControlAlignment(page) {
	await setViewportMode(page, VIEWPORTS[0], "light");
	const groupResults = [];
	const stageSpecs = [
		{
			stage: "transcription",
			section: "转写服务",
			providerName: "服务商",
			providerValue: "siliconflow",
			apiKeyName: "API Key",
			basicNames: ["服务商", "API Key", "转写模型", "转写配置自检"],
			advancedNames: ["Base URL", "默认转写语言", "自定义语言代码"]
		},
		{
			stage: "analysis",
			section: "模型配置",
			providerName: "分析服务商",
			providerValue: "siliconflow",
			apiKeyName: "分析 API Key",
			basicNames: ["分析服务商", "分析 API Key", "分析模型"],
			advancedNames: ["分析 Base URL", "分析配置自检"]
		},
		{
			stage: "memory",
			section: "模型配置",
			providerName: "记忆服务商",
			providerValue: "siliconflow",
			apiKeyName: "记忆 API Key",
			basicNames: ["记忆服务商", "记忆 API Key", "记忆模型"],
			advancedNames: ["记忆 Base URL", "记忆配置自检"]
		}
	];

	for (const spec of stageSpecs) {
		await page.locator(`[data-settings-stage="${spec.stage}"]`).click();
		if (spec.stage === "analysis") {
			await setSettingToggle(page, "启用 AI 纪要分析", true);
		}
		await getActivePanel(page).getByRole("tab", { name: spec.section, exact: true }).click();
		if (spec.stage === "memory") {
			await getActivePanel(page)
				.locator("details.echo-notes-settings-advanced")
				.filter({ hasText: "高级配置（Base URL 与自检）" })
				.first()
				.locator("summary")
				.evaluate((element) => element.click());
		}
		await selectSettingOption(page, spec.providerName, spec.providerValue);
		const basicMetrics = await inspectNamedSettingControls(page, spec.basicNames);
		assertAlignedControlGroup(basicMetrics, `${spec.stage}/基础配置`);
		const feedbackMetrics = await verifyApiKeyFeedback(page, spec.apiKeyName, spec.stage);
		const apiKeyLinkMetrics = await verifyApiKeyLink(page, spec.apiKeyName, spec.stage);

		const advanced = getActivePanel(page).locator(
			'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
		).first();
		if ((await advanced.getAttribute("open")) === null) {
			await advanced.locator("summary").click();
		}
		const advancedMetrics = await inspectNamedSettingControls(page, spec.advancedNames);
		assertAlignedControlGroup(advancedMetrics, `${spec.stage}/高级配置`);
		const allFieldMetrics = [...basicMetrics, ...advancedMetrics].filter((metric) => metric.isUniformField);
		assert(
			Math.max(...allFieldMetrics.map((metric) => metric.fieldWidth)) -
			Math.min(...allFieldMetrics.map((metric) => metric.fieldWidth)) <= 1,
			`${spec.stage} 基础配置与高级配置字段宽度不一致`
		);
		assert(
			Math.max(...allFieldMetrics.map((metric) => metric.fieldHeight)) -
			Math.min(...allFieldMetrics.map((metric) => metric.fieldHeight)) <= 1,
			`${spec.stage} 基础配置与高级配置字段高度不一致`
		);
		groupResults.push({
			stage: spec.stage,
			basicMetrics,
			advancedMetrics,
			feedbackMetrics,
			apiKeyLinkMetrics
		});
	}

	return groupResults;
}

async function inspectActiveSectionFields(page) {
	return getActivePanel(page).evaluate((panel) => {
		const activeSection = panel.querySelector(".echo-notes-settings-section-panel:not([hidden])");
		const eligibleFields = [...(activeSection?.querySelectorAll(
			'.setting-item-control > input[type="text"], ' +
			'.setting-item-control > input[type="password"], ' +
			'.setting-item-control > input[type="number"], ' +
			'.setting-item-control > input[type="url"], ' +
			'.setting-item-control > input[type="search"], ' +
			'.setting-item-control > select'
		) ?? [])].filter((field) => field.getBoundingClientRect().width > 0);
		const expectedFieldHeight = Number.parseFloat(
			getComputedStyle(activeSection ?? panel).getPropertyValue("--input-height")
		) || 30;
		return {
			panelWidth: panel.getBoundingClientRect().width,
			sectionOverflow: activeSection
				? activeSection.scrollWidth - activeSection.clientWidth
				: Number.POSITIVE_INFINITY,
			expectedFieldHeight,
			fields: eligibleFields.map((field) => {
				const control = field.parentElement;
				const fieldRect = field.getBoundingClientRect();
				const controlRect = control?.getBoundingClientRect();
				const settingItem = field.closest(".setting-item");
				return {
					name: settingItem?.querySelector(".setting-item-name")?.textContent?.trim() ?? "未命名字段",
					tag: field.tagName,
					type: field instanceof HTMLInputElement ? field.type : null,
					hasUniformFieldClass: field.classList.contains("echo-notes-settings-field"),
					fieldWidth: fieldRect.width,
					fieldHeight: fieldRect.height,
					controlWidth: controlRect?.width ?? 0,
					leftDelta: controlRect ? fieldRect.left - controlRect.left : Number.POSITIVE_INFINITY,
					rightDelta: controlRect ? controlRect.right - fieldRect.right : Number.POSITIVE_INFINITY
				};
			})
		};
	});
}

async function verifyAllCategorizedFields(page) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		await setViewportMode(page, viewport, "light");
		const viewportHeights = [];
		for (const stage of SCREENSHOT_STAGES) {
			await page.locator(`[data-settings-stage="${stage.id}"]`).click();
			const tabs = getActivePanel(page).locator('.echo-notes-settings-section-tabs [role="tab"]');
			const sectionNames = (await tabs.allTextContents()).map((name) => name.trim());
			for (const sectionName of sectionNames) {
				await getActivePanel(page).getByRole("tab", { name: sectionName, exact: true }).click();
				await getActivePanel(page).locator(
					'.echo-notes-settings-section-panel:not([hidden]) .echo-notes-settings-advanced'
				).evaluateAll((detailsElements) => {
					for (const details of detailsElements) {
						details.open = true;
					}
				});
				const metrics = await inspectActiveSectionFields(page);
				const context = `${stage.id}/${sectionName}/${viewport.name}`;
				assert(metrics.sectionOverflow <= 1, `${context} 分类面板出现横向溢出`);
				for (const field of metrics.fields) {
					assert(field.hasUniformFieldClass, `${context}/${field.name} 缺少统一字段 class`);
					assert(
						Math.abs(field.fieldHeight - metrics.expectedFieldHeight) <= 1,
						`${context}/${field.name} 字段高度异常：${field.fieldHeight}`
					);
					assert(
						Math.abs(field.fieldWidth - field.controlWidth) <= 1.5 &&
						Math.abs(field.leftDelta) <= 1.5 && Math.abs(field.rightDelta) <= 1.5,
						`${context}/${field.name} 未占满控制区：${JSON.stringify(field)}`
					);
					if (metrics.panelWidth > 561) {
						assert(
							Math.abs(field.fieldWidth - 320) <= 1.5,
							`${context}/${field.name} 宽屏字段不是 320px：${field.fieldWidth}`
						);
					}
					viewportHeights.push(field.fieldHeight);
				}
				results.push({ viewport: viewport.name, stage: stage.id, section: sectionName, ...metrics });
			}
		}
		assert(viewportHeights.length > 0, `${viewport.name} 未测量到任何配置字段`);
		assert(
			Math.max(...viewportHeights) - Math.min(...viewportHeights) <= 1,
			`${viewport.name} 分类面板字段高度不一致：${JSON.stringify(viewportHeights)}`
		);
	}
	return results;
}

async function inspectCompositeControl(page, settingName) {
	const settingItem = await getActiveSetting(page, settingName);
	return settingItem.evaluate((item) => {
		const control = item.querySelector(":scope > .setting-item-control");
		const panel = item.closest(".echo-notes-settings-panel");
		const controlRect = control?.getBoundingClientRect();
		const children = [...(control?.querySelectorAll(":scope > input, :scope > select:not(.is-measuring), :scope > button") ?? [])];
		const childRects = children.map((child) => child.getBoundingClientRect());
		const field = children.find((child) => child.matches("input, select"));
		const button = children.find((child) => child.matches("button"));
		const fieldRect = field?.getBoundingClientRect();
		const buttonRect = button?.getBoundingClientRect();
		const expectedFieldHeight = Number.parseFloat(
			getComputedStyle(item).getPropertyValue("--input-height")
		) || 30;
		return {
			markedComposite: control?.classList.contains("echo-notes-settings-control-composite") ?? false,
			childCount: children.length,
			compactLayout: (panel?.getBoundingClientRect().width ?? Number.POSITIVE_INFINITY) <= 560,
			fieldMarkedUniform: field?.classList.contains("echo-notes-settings-field") ?? false,
			fieldWidth: fieldRect?.width ?? 0,
			fieldHeight: fieldRect?.height ?? 0,
			expectedFieldHeight,
			controlWidth: controlRect?.width ?? 0,
			fieldFillsControl: Boolean(
				fieldRect && controlRect &&
				Math.abs(fieldRect.left - controlRect.left) <= 1 &&
				Math.abs(fieldRect.right - controlRect.right) <= 1
			),
			buttonBelowField: Boolean(fieldRect && buttonRect && buttonRect.top >= fieldRect.bottom - 1),
			buttonLeftDelta: buttonRect && controlRect ? buttonRect.left - controlRect.left : Number.POSITIVE_INFINITY,
			buttonRightDelta: buttonRect && controlRect ? controlRect.right - buttonRect.right : Number.POSITIVE_INFINITY,
			controlOverflow: control ? control.scrollWidth - control.clientWidth : Number.POSITIVE_INFINITY,
			childrenFit: childRects.every((rect) => Boolean(
				controlRect &&
				rect.left >= controlRect.left - 1 &&
				rect.right <= controlRect.right + 1 &&
				rect.top >= controlRect.top - 1 &&
				rect.bottom <= controlRect.bottom + 1
			)),
			childrenOverlap: childRects.some((rect, index) => childRects.slice(index + 1).some((candidate) => !(
				rect.right <= candidate.left + 1 ||
				candidate.right <= rect.left + 1 ||
				rect.bottom <= candidate.top + 1 ||
				candidate.bottom <= rect.top + 1
			)))
		};
	});
}

async function verifyCompositeControlLayouts(page) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		await setViewportMode(page, viewport, "light");
		await page.locator('[data-settings-stage="transcription"]').click();
		await selectSettingOption(page, "转写模式", "realtime");
		await getActivePanel(page).getByRole("tab", { name: "转写服务", exact: true }).click();
		const microphone = await inspectCompositeControl(page, "麦克风");
		assert(
			microphone.markedComposite && microphone.childCount === 2,
			`${viewport.name} 麦克风控件未使用复合控制列`
		);
		assert(
			microphone.controlOverflow <= 1 && microphone.childrenFit && !microphone.childrenOverlap,
			`${viewport.name} 麦克风控件溢出或重叠：${JSON.stringify(microphone)}`
		);
		assert(
			microphone.fieldMarkedUniform && microphone.fieldFillsControl && microphone.buttonBelowField &&
			Math.abs(microphone.fieldHeight - microphone.expectedFieldHeight) <= 1,
			`${viewport.name} 麦克风字段尺寸或按钮位置不正确：${JSON.stringify(microphone)}`
		);
		assert(
			microphone.compactLayout
				? Math.abs(microphone.buttonLeftDelta) <= 1.5
				: Math.abs(microphone.buttonRightDelta) <= 1.5,
			`${viewport.name} 麦克风辅助按钮对齐不正确：${JSON.stringify(microphone)}`
		);

		await selectSettingOption(page, "转写模式", "offline");
		await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
		const hotkey = await (await getActiveSetting(page, "开始录音")).evaluate((item) => {
			const control = item.querySelector(":scope > .setting-item-control");
			const capture = control?.querySelector(".echo-notes-quick-recording-hotkey-capture");
			const clear = control?.querySelector(".echo-notes-quick-recording-hotkey-clear");
			const controlRect = control?.getBoundingClientRect();
			const captureRect = capture?.getBoundingClientRect();
			const clearRect = clear?.getBoundingClientRect();
			return {
				controlOverflow: control ? control.scrollWidth - control.clientWidth : Number.POSITIVE_INFINITY,
				captureHeight: captureRect?.height ?? 0,
				clearHeight: clearRect?.height ?? 0,
				childrenFit: Boolean(controlRect && captureRect && clearRect &&
					captureRect.left >= controlRect.left - 1 && clearRect.right <= controlRect.right + 1),
				childrenOverlap: Boolean(captureRect && clearRect && captureRect.right > clearRect.left + 1)
			};
		});
		assert(
			hotkey.controlOverflow <= 1 && hotkey.childrenFit && !hotkey.childrenOverlap,
			`${viewport.name} 快捷键控件溢出或重叠：${JSON.stringify(hotkey)}`
		);
		assert(
			viewport.width > 375 || (hotkey.captureHeight >= 44 && hotkey.clearHeight >= 44),
			`${viewport.name} 快捷键移动操作区不足 44px：${JSON.stringify(hotkey)}`
		);
		results.push({ viewport: viewport.name, microphone, hotkey });
	}
	return results;
}

async function inspectLayout(page, providerSettingName) {
	return page.evaluate((expectedProviderSettingName) => {
		const content = document.querySelector(".vertical-tab-content");
		const panel = document.querySelector(".echo-notes-settings-panel:not([hidden])");
		const intro = document.querySelector(".echo-notes-settings-intro");
		const guide = document.querySelector(".echo-notes-settings-intro-guide");
		const workflow = document.querySelector(".echo-notes-settings-workflow");
		const providerItem = [...(panel?.querySelectorAll(".setting-item") ?? [])].find(
			(item) => item.querySelector(".setting-item-name")?.textContent === expectedProviderSettingName
		);
		const providerInfo = providerItem?.querySelector(".setting-item-info");
		const providerControl = providerItem?.querySelector(".setting-item-control");
		const stepFits = [...document.querySelectorAll(".echo-notes-settings-step")].every(
			(step) => step.scrollWidth <= step.clientWidth + 1
		);

		return {
			innerWidth: window.innerWidth,
			contentWidth: content?.getBoundingClientRect().width ?? 0,
			panelWidth: panel?.getBoundingClientRect().width ?? 0,
			contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
			panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : Number.POSITIVE_INFINITY,
			documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			introBeforeWorkflow: Boolean(
				intro &&
				guide &&
				workflow &&
				intro.getBoundingClientRect().bottom <= guide.getBoundingClientRect().top &&
				guide.getBoundingClientRect().bottom <= workflow.getBoundingClientRect().top
			),
			stepFits,
			providerFound: Boolean(providerItem),
			providerStacked: Boolean(
				providerInfo &&
				providerControl &&
				providerControl.getBoundingClientRect().top >= providerInfo.getBoundingClientRect().bottom
			)
		};
	}, providerSettingName);
}

async function captureViewports(page) {
	const results = [];
	// 回归场景固定到拥有最长服务商和模型标签的阿里百炼，确保度量的是
	// 实际渲染选项而不是仅存在于其他服务商配置中的字符串。
	await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		plugin.settings.transcriptionMode = "offline";
		plugin.settings.offlineTranscription.provider = "aliyun-bailian";
		plugin.settings.offlineTranscription.model = "qwen-audio-3.0-asr-flash-filetrans";
		await plugin.saveSettings();
		plugin.settingTab.display();
	}, PLUGIN_ID);

	async function inspectTranscriptionDropdownTextVisibility(viewport) {
		const metrics = await page.evaluate(() => {
			const canvas = document.createElement('canvas');
			const context = canvas.getContext('2d');
			const allSettings = [...document.querySelectorAll('.echo-notes-settings-panel:not([hidden]) .setting-item')];
			const findSetting = (name) => allSettings.find((s) => s.querySelector('.setting-item-name')?.textContent?.trim().includes(name));
			const targets = [
				{ key: "mode", name: "转写模式", longestOptionText: "实时转写" },
				{ key: "provider", name: "服务商", longestOptionText: "【推荐】阿里百炼（Alibaba Bailian）" },
				{ key: "model", name: "转写模型", longestOptionText: "qwen-audio-3.0-asr-flash-filetrans（推荐）" }
			];
			const result = {};
			for (const target of targets) {
				const settingEl = findSetting(target.name);
				const selectEl = settingEl?.querySelector('select.dropdown:not(.is-measuring)');
				if (!selectEl) {
					result[target.key] = { found: false };
					continue;
				}
				const controlEl = selectEl.parentElement;
				const style = getComputedStyle(selectEl);
				const rect = selectEl.getBoundingClientRect();
				context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
				const selectedText = selectEl.options[selectEl.selectedIndex]?.text ?? "";
				const textWidth = context.measureText(selectedText).width;
				const longestOptionText = target.longestOptionText;
				const longestOptionExists = [...selectEl.options].some((option) => option.text === longestOptionText);
				const longestOptionTextWidth = context.measureText(longestOptionText).width;
				const paddingStart = parseFloat(style.paddingInlineStart);
				const paddingEnd = parseFloat(style.paddingInlineEnd);
				const availableWidth = rect.width - paddingStart - paddingEnd;
				result[target.key] = {
					found: true,
					controlWidth: controlEl.getBoundingClientRect().width,
					nativeSelectWidth: rect.width,
					nativeSelectClientWidth: selectEl.clientWidth,
					nativeSelectScrollWidth: selectEl.scrollWidth,
					visibleDropdownWidth: rect.width,
					visibleDropdownScrollWidth: selectEl.scrollWidth,
					selectedText,
					textWidth,
					availableWidth,
					selectedTextFullyVisible: textWidth <= availableWidth + 1,
					longestOptionText,
					longestOptionExists,
					longestOptionTextWidth,
					longestOptionTextFullyVisible: longestOptionTextWidth <= availableWidth + 1,
					computedStyle: {
						width: style.width,
						maxWidth: style.maxWidth,
						paddingInlineStart: style.paddingInlineStart,
						paddingInlineEnd: style.paddingInlineEnd,
						overflow: style.overflow,
						textOverflow: style.textOverflow,
						whiteSpace: style.whiteSpace
					}
				};
			}
			return result;
		});
		for (const [key, metric] of Object.entries(metrics)) {
			const context = `dropdown-visibility/transcription/${viewport.name}/${key}`;
			assert(metric.found, `${context} 未找到下拉控件`);
			if (key === "mode" && !viewport.stackedSettings && !viewport.mobileShell) {
				assert(metric.visibleDropdownWidth >= 100 && metric.visibleDropdownWidth <= 130, `${context} 模式下拉框未收窄到短文案所需宽度（${metric.visibleDropdownWidth}）`);
			} else {
				assert(Math.abs(metric.visibleDropdownWidth - metric.controlWidth) <= 1, `${context} 可见下拉框宽度（${metric.visibleDropdownWidth}）未填满控制区（${metric.controlWidth}）`);
			}
			if (!viewport.stackedSettings && !viewport.mobileShell) {
				assert(
					metric.selectedTextFullyVisible,
					`${context} 选中文本（"${metric.selectedText}"，宽度 ${metric.textWidth.toFixed(1)}px）超出可用区域（${metric.availableWidth.toFixed(1)}px）`
				);
				assert(metric.longestOptionExists, `${context} 未找到最长回归选项：${metric.longestOptionText}`);
				assert(
					metric.longestOptionTextFullyVisible,
					`${context} 最长选项（"${metric.longestOptionText}"，宽度 ${metric.longestOptionTextWidth.toFixed(1)}px）超出可用区域（${metric.availableWidth.toFixed(1)}px）`
				);
			}
		}
		return metrics;
	}

	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			for (const stage of SCREENSHOT_STAGES) {
				await setViewportMode(page, viewport, theme);
				await page.locator(`[data-settings-stage="${stage.id}"]`).click();
				await getActivePanel(page).getByRole("tab", { name: stage.section, exact: true }).click();
				await page.evaluate(() => {
					const content = document.querySelector(".vertical-tab-content");
					if (content) {
						content.scrollTop = 0;
					}
				});
				await page.mouse.move(1, 1);

				const metrics = await inspectLayout(page, stage.providerSetting);
				const context = `${stage.id}/${viewport.name}/${theme}`;
				assert(metrics.innerWidth === viewport.width, `${context} 的 viewport 宽度不匹配`);
				assert(metrics.contentOverflow <= 1, `${context} 设置内容出现横向溢出`);
				assert(metrics.panelOverflow <= 1, `${context} 插件面板出现横向溢出`);
				assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
				assert(metrics.introBeforeWorkflow, `${context} 引导区与步骤轴发生重叠`);
				assert(metrics.stepFits, `${context} 步骤标签发生裁切`);
				assert(metrics.providerFound, `${context} 未找到 ${stage.providerSetting} 设置项`);
				assert(
					metrics.providerStacked === viewport.stackedSettings,
					`${context} 的服务商设置行响应式布局不符合预期`
				);

				const dropdownMetrics = stage.id === "transcription"
					? await inspectTranscriptionDropdownTextVisibility(viewport)
					: undefined;

				const fileName = `settings-${stage.id}-${viewport.name}-${theme}.png`;
				const screenshotPath = path.join(OUTPUT_DIR, fileName);
				await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
				const screenshotStat = await stat(screenshotPath);
				assert(screenshotStat.size > 10_000, `${fileName} 截图可能为空白`);
				results.push({ stage: stage.id, viewport: viewport.name, theme, fileName, metrics, dropdownMetrics });
			}
		}
	}
	return results;
}

async function captureAdvancedCapabilityViewports(page) {
	const original = await page.evaluate(async (pluginId) => {
		const plugin = window.app.plugins.plugins[pluginId];
		const snapshot = {
			transcriptionMode: plugin.settings.transcriptionMode,
			memoryInitialized: plugin.settings.memoryInitialized,
			offlineTranscription: JSON.parse(JSON.stringify(plugin.settings.offlineTranscription))
		};
		plugin.settings.transcriptionMode = "offline";
		plugin.settings.memoryInitialized = false;
		plugin.settings.offlineTranscription.provider = "aliyun-bailian";
		plugin.settings.offlineTranscription.model = "qwen-audio-3.0-asr-flash-filetrans";
		plugin.settings.offlineTranscription.aliyunFiletrans = {
			...(plugin.settings.offlineTranscription.aliyunFiletrans ?? {}),
			diarizationEnabled: true,
			hotwordEnhancementEnabled: false,
			contextEnhancementEnabled: false,
			memoryEnhancementEnabled: false
		};
		delete plugin.settings.offlineTranscription.aliyunFiletrans.speakerCount;
		await plugin.saveSettings();
		plugin.settingTab.showDestination("transcription-recording");
		return snapshot;
	}, PLUGIN_ID);

	const results = [];
	try {
		for (const viewport of VIEWPORTS) {
			for (const theme of THEMES) {
				await setViewportMode(page, viewport, theme);
				await page.locator('[data-settings-stage="transcription"]').click();
				await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
				await page.evaluate(() => {
					const content = document.querySelector(".vertical-tab-content");
					if (content) content.scrollTop = 0;
				});
				await page.mouse.move(1, 1);

				const metrics = await page.evaluate(() => {
					const content = document.querySelector(".vertical-tab-content");
					const panel = document.querySelector(".echo-notes-settings-panel:not([hidden])");
					const section = panel?.querySelector(".echo-notes-settings-section-panel:not([hidden])");
					const summary = section?.querySelector(".echo-notes-transcription-context");
					const model = summary?.querySelector(".echo-notes-transcription-context-model");
					const tags = [...(summary?.querySelectorAll(".echo-notes-transcription-context-chip") ?? [])];
					const actions = [...(section?.querySelectorAll(".echo-notes-transcription-capability-action") ?? [])];
					const hotkeyControls = [...(section?.querySelectorAll(".echo-notes-quick-recording-hotkey-capture, .echo-notes-quick-recording-hotkey-clear") ?? [])];
					const sectionRect = section?.getBoundingClientRect();
					return {
						innerWidth: window.innerWidth,
						contentOverflow: content ? content.scrollWidth - content.clientWidth : Number.POSITIVE_INFINITY,
						panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : Number.POSITIVE_INFINITY,
						documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
						summaryFits: Boolean(summary && summary.scrollWidth <= summary.clientWidth + 1),
						modelFits: Boolean(model && model.scrollWidth <= model.clientWidth + 1),
						tagsFit: tags.every((tag) => {
							const rect = tag.getBoundingClientRect();
							return !sectionRect || (rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1);
						}),
						tagLabels: tags.map((tag) => tag.textContent?.trim()),
						cardLabels: [...(section?.querySelectorAll(".echo-notes-transcription-capability-card-title") ?? [])]
							.map((label) => label.textContent?.trim()),
						actionCount: actions.length,
						minimumActionHeight: actions.length > 0
							? Math.min(...actions.map((action) => action.getBoundingClientRect().height))
							: 0,
						actionsFit: actions.every((action) => {
							const rect = action.getBoundingClientRect();
							return !sectionRect || (rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1);
						}),
						hotkeyControlsFit: hotkeyControls.every((control) => {
							const rect = control.getBoundingClientRect();
							return !sectionRect || (rect.left >= sectionRect.left - 1 && rect.right <= sectionRect.right + 1);
						}),
						minimumHotkeyControlHeight: hotkeyControls.length > 0
							? Math.min(...hotkeyControls.map((control) => control.getBoundingClientRect().height))
							: 0
					};
				});
				const context = `advanced-capabilities/${viewport.name}/${theme}`;
				assert(metrics.innerWidth === viewport.width, `${context} 的 viewport 宽度不匹配`);
				assert(metrics.contentOverflow <= 1, `${context} 设置内容出现横向溢出`);
				assert(metrics.panelOverflow <= 1, `${context} 插件面板出现横向溢出`);
				assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
				assert(metrics.summaryFits && metrics.modelFits && metrics.tagsFit, `${context} 服务摘要或能力 Tag 溢出`);
				assert(
					JSON.stringify(metrics.tagLabels) === JSON.stringify([
						"说话人分离",
						"时间戳",
						"热词增强",
						"上下文增强"
					]),
					`${context} 模型支持 Tag 不正确`
				);
				assert(
					JSON.stringify(metrics.cardLabels) === JSON.stringify(["说话人分离", "术语增强", "上下文增强", "快捷录音"]),
					`${context} 能力卡片结构不正确`
				);
				assert(metrics.actionCount >= 2 && metrics.actionsFit, `${context} 恢复操作缺失或溢出`);
				assert(metrics.hotkeyControlsFit, `${context} 快捷录音控件溢出`);
				if (viewport.mobileShell) {
					assert(metrics.minimumActionHeight >= 44, `${context} 恢复操作小于 44px`);
					assert(metrics.minimumHotkeyControlHeight >= 44, `${context} 快捷录音控件小于 44px`);
				}

				const fileName = `settings-advanced-capabilities-${viewport.name}-${theme}.png`;
				const screenshotPath = path.join(OUTPUT_DIR, fileName);
				await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
				const screenshotStat = await stat(screenshotPath);
				assert(screenshotStat.size > 10_000, `${fileName} 截图可能为空白`);
				results.push({ viewport: viewport.name, theme, fileName, metrics });
				const quickRecordingFileName = `settings-quick-recording-${viewport.name}-${theme}.png`;
				const quickRecordingPath = path.join(OUTPUT_DIR, quickRecordingFileName);
				await getActivePanel(page).locator('[data-capability-card="quick-recording"]').screenshot({ path: quickRecordingPath });
				assert((await stat(quickRecordingPath)).size > 4_000, `${quickRecordingFileName} 截图可能为空白`);
			}
		}
	} finally {
		await page.evaluate(async ({ pluginId, snapshot }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			plugin.settings.transcriptionMode = snapshot.transcriptionMode;
			plugin.settings.memoryInitialized = snapshot.memoryInitialized;
			plugin.settings.offlineTranscription = snapshot.offlineTranscription;
			await plugin.saveSettings();
			plugin.settingTab.showDestination("transcription-service");
		}, { pluginId: PLUGIN_ID, snapshot: original });
	}
	return results;
}

async function verifyTemplateResponsiveLayouts(page) {
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			await page.locator('[data-settings-stage="analysis"]').click();
			await getActivePanel(page).getByRole("tab", { name: "模板管理", exact: true }).click();
			await getActivePanel(page).locator('[data-template-category-tab="product-delivery"]').click();
			await page.evaluate(() => {
				const modalContent = document.querySelector(".modal-content");
				const verticalTabContent = document.querySelector(".vertical-tab-content");
				if (modalContent) {
					modalContent.scrollTop = 0;
				}
				if (verticalTabContent) {
					verticalTabContent.scrollTop = 0;
				}
			});
			await getActivePanel(page).locator(".echo-notes-template-category-tabs").evaluate((element) => {
				element.scrollIntoView({ block: "start" });
			});
			await page.evaluate(() => {
				const categoryTabs = document.querySelector(".echo-notes-template-category-tabs");
				const groupHeader = document.querySelector(".echo-notes-template-group:not([hidden]) .echo-notes-template-group-header");
				const categoryTabsRect = categoryTabs?.getBoundingClientRect();
				const groupHeaderRect = groupHeader?.getBoundingClientRect();
				const overlap = categoryTabsRect && groupHeaderRect
					? categoryTabsRect.bottom - groupHeaderRect.top + 1
					: 0;
				if (overlap <= 0) {
					return;
				}
				let scrollContainer = categoryTabs?.parentElement ?? null;
				while (scrollContainer && scrollContainer.scrollTop <= 0) {
					scrollContainer = scrollContainer.parentElement;
				}
				if (scrollContainer) {
					scrollContainer.scrollTop = Math.max(0, scrollContainer.scrollTop - overlap);
				}
			});
			const metrics = await page.evaluate((requireTouchTargets) => {
				const panel = document.querySelector(".echo-notes-settings-panel:not([hidden])");
				const categoryTabs = panel?.querySelector(".echo-notes-template-category-tabs");
				const categoryTabButtons = [...(categoryTabs?.querySelectorAll(".echo-notes-template-category-tab") ?? [])];
				const groups = [...(panel?.querySelectorAll(".echo-notes-template-group") ?? [])];
				const visibleGroups = groups.filter((group) => !group.hasAttribute("hidden"));
				const cards = [...(visibleGroups[0]?.querySelectorAll(".echo-notes-template-card") ?? [])];
				const targets = [...(visibleGroups[0]?.querySelectorAll(".echo-notes-template-card-actions button, .echo-notes-template-enable") ?? [])];
				const categoryTabsRect = categoryTabs?.getBoundingClientRect();
				const groupHeaderRect = visibleGroups[0]?.querySelector(".echo-notes-template-group-header")?.getBoundingClientRect();
				const groupHeadingRect = visibleGroups[0]?.querySelector(".echo-notes-template-group-heading")?.getBoundingClientRect();
				const groupCountRect = visibleGroups[0]?.querySelector(".echo-notes-template-group-count")?.getBoundingClientRect();
				return {
					panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : Number.POSITIVE_INFINITY,
					documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
					categoryTabCount: categoryTabButtons.length,
					categoryTabsFit: Boolean(categoryTabsRect) && categoryTabButtons.every((tab) => {
						const rect = tab.getBoundingClientRect();
						return rect.left >= categoryTabsRect.left - 1 && rect.right <= categoryTabsRect.right + 1;
					}),
					groupCount: groups.length,
					visibleGroupCount: visibleGroups.length,
					categoryTabsBottom: categoryTabsRect?.bottom ?? null,
					groupHeaderTop: groupHeaderRect?.top ?? null,
					groupHeadingVisible: Boolean(groupHeadingRect?.width && groupHeadingRect.height),
					groupCountVisible: Boolean(groupCountRect?.width && groupCountRect.height),
					cardCount: cards.length,
					cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1),
					targetsFit: targets.every((target) => {
						const targetRect = target.getBoundingClientRect();
						const cardRect = target.closest(".echo-notes-template-card")?.getBoundingClientRect();
						return Boolean(cardRect && targetRect.left >= cardRect.left - 1 && targetRect.right <= cardRect.right + 1);
					}),
					touchTargetsMeetMinimum: !requireTouchTargets || targets.every((target) => target.getBoundingClientRect().height >= 44)
				};
			}, viewport.mobileShell);
			const context = `templates/${viewport.name}/${theme}`;
			assert(metrics.panelOverflow <= 1, `${context} 模板面板出现横向溢出`);
			assert(metrics.documentOverflow <= 1, `${context} 文档出现横向溢出`);
			assert(metrics.categoryTabCount === 6, `${context} 模板分类切换入口数量不正确`);
			assert(metrics.categoryTabsFit, `${context} 模板分类切换入口超出容器`);
			assert(metrics.groupCount === 6, `${context} 模板分类数量不正确`);
			assert(metrics.visibleGroupCount === 1, `${context} 应只显示当前模板分类`);
			assert(
				metrics.categoryTabsBottom !== null && metrics.groupHeaderTop !== null && metrics.groupHeaderTop >= metrics.categoryTabsBottom - 1,
				`${context} 模板标题被分类切换器遮挡：${JSON.stringify({ categoryTabsBottom: metrics.categoryTabsBottom, groupHeaderTop: metrics.groupHeaderTop })}`
			);
			assert(metrics.groupHeadingVisible, `${context} 模板标题不可见`);
			assert(metrics.groupCountVisible, `${context} 模板启用数量不可见`);
			assert(metrics.cardCount === 3, `${context} 产品与交付模板卡片数量不正确`);
			assert(metrics.cardsFit, `${context} 模板卡片内容溢出`);
			assert(metrics.targetsFit, `${context} 模板操作控件超出卡片边界`);
			assert(metrics.touchTargetsMeetMinimum, `${context} 移动端操作控件小于 44px`);
			await page.mouse.move(1, 1);
			const fileName = `settings-templates-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
			const screenshotStat = await stat(screenshotPath);
			assert(screenshotStat.size > 10_000, `${fileName} 截图可能为空白`);
			await getActivePanel(page).locator(".echo-notes-template-group:not([hidden]) .echo-notes-template-card").last().scrollIntoViewIfNeeded();
			const stickyMetrics = await page.evaluate(() => {
				const categoryTabs = document.querySelector(".echo-notes-template-category-tabs");
				const activeGroup = document.querySelector(".echo-notes-template-group:not([hidden])");
				const tabsRect = categoryTabs?.getBoundingClientRect();
				const groupRect = activeGroup?.getBoundingClientRect();
				return {
					tabsVisible: Boolean(tabsRect && tabsRect.bottom > 0 && tabsRect.top < window.innerHeight),
					groupVisible: Boolean(groupRect && groupRect.bottom > 0 && groupRect.top < window.innerHeight),
					tabsRect: tabsRect ? { top: tabsRect.top, bottom: tabsRect.bottom } : null,
					groupRect: groupRect ? { top: groupRect.top, bottom: groupRect.bottom } : null
				};
			});
			assert(stickyMetrics.tabsVisible, `${context} 滚动模板卡片后分类切换器不可见：${JSON.stringify(stickyMetrics)}`);
			assert(stickyMetrics.groupVisible, `${context} 当前模板分类未滚入可视区域`);
			results.push({ viewport: viewport.name, theme, fileName, metrics });
		}
	}
	return results;
}

async function stopChild(child) {
	if (!child || child.exitCode !== null) {
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([
		once(child, "exit"),
		new Promise((resolve) => setTimeout(resolve, 3_000))
	]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
}

async function removeIsolatedProfile(profileDir) {
	if (!profileDir) {
		return;
	}
	const expectedPrefix = path.resolve(os.tmpdir(), "echo-notes-settings-ui-");
	const resolvedProfile = path.resolve(profileDir);
	assert(resolvedProfile.startsWith(expectedPrefix), `拒绝清理非预期目录：${resolvedProfile}`);
	await rm(resolvedProfile, { force: true, recursive: true });
}

let isolatedProfile;
let obsidianProcess;
let getObsidianOutput = () => "";
let browser;
let memoryProviderMock;
const verificationStartedAt = Date.now();

try {
	const manifest = await validateWorkspace();
	const obsidianAsar = await findLatestObsidianAsar();
	assert(
		compareVersions(obsidianAsar.version, manifest.minAppVersion) >= 0,
		`Obsidian ${obsidianAsar.version} 低于插件最低要求 ${manifest.minAppVersion}`
	);

	await prepareOutputDirectory();
	memoryProviderMock = await startMemoryProviderMock();
	const isolated = await createIsolatedProfile(obsidianAsar);
	isolatedProfile = isolated.profileDir;
	const port = await reservePort();
	const launched = launchObsidian(isolatedProfile, port);
	obsidianProcess = launched.child;
	getObsidianOutput = launched.getOutput;
	const endpoint = await waitForObsidianPage(port, obsidianProcess);

	browser = await chromium.connectOverCDP(endpoint);
	const pages = browser.contexts().flatMap((context) => context.pages());
	const page = pages.find((candidate) => candidate.url() === "app://obsidian.md/index.html");
	assert(page, "CDP 中未找到 Obsidian renderer 页面");
	page.setDefaultTimeout(10_000);
	await page.addStyleTag({ content: MOBILE_SHELL_CSS });
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await reloadPlugin(page);
	const runtimeState = await page.evaluate(async (pluginId) => {
		const AudioContextConstructor = window.AudioContext;
		const audioWorkletNodeAvailable = typeof window.AudioWorkletNode !== "undefined";
		let audioWorkletAvailable = false;
		if (AudioContextConstructor) {
			const audioContext = new AudioContextConstructor();
			try {
				audioWorkletAvailable = Boolean(audioContext.audioWorklet);
			} finally {
				await audioContext.close();
			}
		}
		return {
			pluginVersion: window.app.plugins.manifests[pluginId]?.version ?? null,
			pluginEnabled: window.app.plugins.enabledPlugins.has(pluginId),
			audioWorkletAvailable,
			audioWorkletNodeAvailable
		};
	}, PLUGIN_ID);
	assert(runtimeState.pluginEnabled, `测试 vault 中 ${PLUGIN_ID} 未加载`);
	assert(runtimeState.pluginVersion === manifest.version, `宿主插件版本不匹配：${runtimeState.pluginVersion ?? "未找到"}`);
	assert(runtimeState.audioWorkletAvailable, "Obsidian 宿主的 AudioContext.audioWorklet 不可用");
	assert(runtimeState.audioWorkletNodeAvailable, "Obsidian 宿主的 AudioWorkletNode 不可用");
	const realtimeStatusLayout = await verifyRealtimeStatusIndicator(page);
	const gettingStartedLayouts = await verifyGettingStarted(page);
	const taskCenterLayouts = await captureTaskCenterLayouts(page);
	await setViewportMode(page, VIEWPORTS[0], "light");
	await openSettings(page);
	await verifyDeclarativeSettingsCompatibility(page);
	await verifySettingsSurface(page);
	await verifyIntroduction(page);
	await verifyTabs(page);
	await verifySettingsHotkeyConflicts(page);
	await reopenSettings(page);
	await page.locator('[data-settings-stage="transcription"]').click();
	const controlAlignmentLayouts = await verifySettingsControlAlignment(page);

	await verifySurfaceAcrossViewports(page);
	const categorizedFieldLayouts = await verifyAllCategorizedFields(page);
	const compositeControlLayouts = await verifyCompositeControlLayouts(page);
	const diagnosticPackageLayouts = await verifyDiagnosticPackageUi(page);
	const screenshots = await captureViewports(page);
	const advancedCapabilityLayouts = await captureAdvancedCapabilityViewports(page);
	const templateLayouts = await verifyTemplateResponsiveLayouts(page);
	await verifyMemoryInitialization(page);
	const transcriptionEnhancementLayouts = await verifyTranscriptionEnhancementMarkdown(page);
	await verifyMemoryCheckpointResume(page, memoryProviderMock);
	const memoryReviewLayouts = await verifyMemoryReview(page);
	const memoryRelationLayouts = await verifyMemoryRelations(page);
	const memoryContextLayouts = await verifyMemoryContextPackage(page, memoryProviderMock);
	assert(pageErrors.length === 0, `设置页出现运行时错误：${pageErrors.join(" | ")}`);

	const summary = {
		pluginVersion: manifest.version,
		runtimePluginVersion: runtimeState.pluginVersion,
		obsidianVersion: obsidianAsar.version,
		sourceTestVault: TEST_VAULT,
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - verificationStartedAt,
		semanticChecks: {
			audioWorkletSupport: true,
			declarativeSettingsCompatibility: true,
			introduction: true,
			keyboardNavigation: true,
			ariaRelationships: true,
			renderStatePersistence: true,
			settingsControlAlignment: true,
			settingsCategorizedFieldSizing: true,
			settingsFeedbackSemantics: true,
			settingsApiKeyLinks: true,
			settingsCompositeControls: true,
			advancedCapabilities: true,
			diagnosticPackageUi: true,
			templateGrouping: true,
			memoryInitialization: true,
			transcriptionEnhancementMarkdown: true,
			transcriptionEnhancementMigration: true,
			transcriptionCandidateReview: true,
			memoryCheckpointResume: true,
			memoryReview: true,
			memoryRelations: true,
			memoryAggregations: true,
			memoryContextPackages: true,
			gettingStartedSidebar: true,
			gettingStartedNoModal: true,
			gettingStartedSettingsSpotlight: true,
			gettingStartedDismissal: true,
			realtimeStatusIndicator: true,
			taskCenterSections: true,
			taskCenterStatusIndicators: true,
			taskCenterResponsiveLayout: true,
			runtimeErrors: pageErrors.length
		},
		gettingStartedInitialLayouts: gettingStartedLayouts.initialLayouts,
		gettingStartedGuideLayouts: gettingStartedLayouts.guideLayouts,
		gettingStartedSpotlightLayouts: gettingStartedLayouts.spotlightLayouts,
		realtimeStatusLayout,
		taskCenterLayouts,
		controlAlignmentLayouts,
		categorizedFieldLayouts,
		compositeControlLayouts,
		diagnosticPackageLayouts,
		screenshots,
		advancedCapabilityLayouts,
		templateLayouts,
		transcriptionEnhancementLayouts,
		memoryReviewLayouts,
		memoryRelationLayouts,
		memoryContextLayouts
	};
	await writeFile(
		path.join(OUTPUT_DIR, "summary.json"),
		`${JSON.stringify(summary, null, "\t")}\n`,
		"utf8"
	);

	console.log(`Echo Notes 设置页验证通过：Obsidian ${obsidianAsar.version}`);
	console.log(`耗时：${summary.durationMs} ms；新人边栏初始截图：${gettingStartedLayouts.initialLayouts.length} 张；新人阶段截图：${gettingStartedLayouts.guideLayouts.length} 张；配置 Spotlight 截图：${gettingStartedLayouts.spotlightLayouts.length} 张；任务中心截图：${taskCenterLayouts.length} 张；标准截图：${screenshots.length} 张；高级能力截图：${advancedCapabilityLayouts.length} 张；模板管理截图：${templateLayouts.length} 张；术语候选截图：${transcriptionEnhancementLayouts.length} 张；记忆候选审核截图：${memoryReviewLayouts.length} 张；记忆关系截图：${memoryRelationLayouts.length} 张；上下文包截图：${memoryContextLayouts.length} 张`);
	console.log(`截图与指标：${OUTPUT_DIR}`);
} catch (error) {
	console.error(error instanceof Error ? error.stack : error);
	const obsidianOutput = getObsidianOutput();
	if (obsidianOutput) {
		console.error(`隔离 Obsidian 输出：\n${obsidianOutput}`);
	}
	process.exitCode = 1;
} finally {
	if (browser) {
		await browser.close().catch(() => undefined);
	}
	await stopChild(obsidianProcess);
	await memoryProviderMock?.close().catch(() => undefined);
	await removeIsolatedProfile(isolatedProfile);
}

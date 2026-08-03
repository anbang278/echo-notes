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
	"Echo Notes 以录音为入口，将转写与 AI 分析沉淀为 vault 中可搜索、可链接、可长期复用的 Markdown 上下文，并为未来的 Personal Agent 构建个人记忆。";
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
`;

const VIEWPORTS = [
	{ name: "desktop-1280", width: 1280, height: 900, mobileShell: false, stackedSettings: false },
	{ name: "desktop-768", width: 768, height: 900, mobileShell: false, stackedSettings: true },
	{ name: "mobile-content-375", width: 375, height: 812, mobileShell: true, stackedSettings: true }
];

const THEMES = ["light", "dark"];
const SCREENSHOT_STAGES = [
	{ id: "transcription", section: "转写服务", providerSetting: "Provider" },
	{ id: "analysis", section: "模型配置", providerSetting: "分析 provider" },
	{ id: "memory", section: "模型配置", providerSetting: "记忆 provider" }
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
					(entry.name === "summary.json" || /^(?:settings|memory-review|memory-relation|memory-context)-[a-z0-9-]+\.png$/.test(entry.name))
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
							predicate: "身份为",
							value: "本次会话的初始化用户",
							confidence: 0.9,
							evidenceQuote: "初始化用户：测试用户"
						}] : []),
						{
							subjectType: "user",
							subjectName: "测试用户",
							category: "other",
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

async function reloadPluginAndOpenSettings(page) {
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
		await obsidianApp.plugins.setEnable(true);
		if (obsidianApp.plugins.plugins[pluginId]) {
			await obsidianApp.plugins.disablePlugin(pluginId);
		}
		await obsidianApp.plugins.enablePluginAndSave(pluginId);
		obsidianApp.setting.open();
		await obsidianApp.setting.openTabById(pluginId);
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
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
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
			headingRelation: intro?.getAttribute("aria-labelledby") === heading?.id,
			correctOrder:
				intro?.nextElementSibling === guide && guide?.nextElementSibling === workflow
		};
	});

	assert(result.count === 1, `引导区数量应为 1，实际为 ${result.count}`);
	assert(result.guideCount === 1, `操作指引数量应为 1，实际为 ${result.guideCount}`);
	assert(result.title === EXPECTED_TITLE, "引导区标题不匹配");
	assert(result.copy === EXPECTED_INTRO, "引导区理念文案不匹配");
	assert(result.guide === EXPECTED_GUIDE, "引导区指引文案不匹配");
	assert(result.linkText === EXPECTED_README_LINK_TEXT, "README 链接文案不匹配");
	assert(result.linkInConcept, "README 链接必须位于理念说明末尾");
	assert(result.href === README_URL, "README 链接地址不匹配");
	assert(result.target === "_blank", "README 链接必须在新窗口打开");
	assert(result.rel === "noopener noreferrer", "README 链接缺少安全 rel 属性");
	assert(result.iconHidden === "true" && result.hasSvg, "外链图标或辅助技术属性不完整");
	assert(result.titleIconHidden === "true" && result.titleHasSvg, "标题图标或辅助技术属性不完整");
	assert(result.standardHeading, "引导区标题必须使用 Obsidian Setting heading 结构");
	assert(result.headingRelation, "引导区 aria-labelledby 关系无效");
	assert(result.correctOrder, "操作指引必须位于理念分割线与工作流步骤轴之间");
}

function getActivePanel(page) {
	return page.locator(".echo-notes-settings-panel:not([hidden])");
}

async function getActiveSetting(page, name) {
	const settingItems = getActivePanel(page).locator(".setting-item");
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
	const selectEl = settingItem.locator("select");
	assert((await selectEl.count()) === 1, `${name} 应包含一个下拉选择器`);
	const previousRenderId = await getSettingsRenderId(page);
	await selectEl.selectOption(value);
	await waitForSettingsRerender(page, previousRenderId);
}

async function getSettingOptionValues(page, name) {
	const settingItem = await getActiveSetting(page, name);
	const selectEl = settingItem.locator("select");
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
		assert(
			(await updatedSettingItem
				.locator(".checkbox-container")
				.evaluate((element) => element.classList.contains("is-enabled"))) === enabled,
			`${name} 重绘后的开关状态不正确`
		);
	}
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
	assert((await sectionTabs.allTextContents()).join("|") === "转写服务|录音控制|输出规则|自动化与日志", "转写二级分类不完整");
	const serviceTab = sectionTabs.filter({ hasText: "转写服务" });
	const recordingTab = sectionTabs.filter({ hasText: "录音控制" });
	const outputTab = sectionTabs.filter({ hasText: "输出规则" });
	const automationTab = sectionTabs.filter({ hasText: "自动化与日志" });
	await outputTab.click();
	assert(await outputTab.getAttribute("aria-selected") === "true", "点击后应选中输出规则");
	await outputTab.press("End");
	assert(await automationTab.getAttribute("aria-selected") === "true", "二级 End 应切到末项");
	await automationTab.press("Home");
	assert(await serviceTab.getAttribute("aria-selected") === "true", "二级 Home 应切回首项");
	await serviceTab.press("ArrowLeft");
	assert(await automationTab.getAttribute("aria-selected") === "true", "二级左方向键应循环切换");
	await automationTab.press("ArrowRight");
	assert(await serviceTab.getAttribute("aria-selected") === "true", "二级右方向键应循环切换");
	assert(
		JSON.stringify(await getSettingOptionValues(page, "Provider")) ===
			JSON.stringify(["aliyun-bailian", "siliconflow", "mosi", "ollama", "lm-studio"]),
		"离线转写 Provider 的成员或顺序不正确"
	);

	await outputTab.click();
	await selectSettingOption(page, "输出目录策略", "custom-folder");
	await activePanel.getByText("自定义输出目录", { exact: true }).waitFor({ state: "visible" });
	assert(await outputTab.getAttribute("aria-selected") === "true", "输出策略重绘后应保留输出规则分类");

	await recordingTab.click();
	await selectSettingOption(page, "转写模式", "realtime");
	await activePanel.getByText("麦克风", { exact: true }).waitFor({ state: "visible" });
	assert(await recordingTab.getAttribute("aria-selected") === "true", "实时模式重绘后应保留录音控制分类");
	await selectSettingOption(page, "转写模式", "offline");
	await activePanel.getByText("Obsidian 核心插件录音机", { exact: true }).waitFor({ state: "visible" });
	assert(await recordingTab.getAttribute("aria-selected") === "true", "离线模式重绘后应保留录音控制分类");

	await memoryTab.click();
	const memorySectionTabs = activePanel.locator(".echo-notes-settings-section-tab");
	assert(
		(await memorySectionTabs.allTextContents()).join("|") === "记忆工作区|模型配置|编译策略",
		"记忆提取二级分类不完整"
	);
	const memoryModelTab = memorySectionTabs.filter({ hasText: "模型配置" });
	const memoryProcessingTab = memorySectionTabs.filter({ hasText: "编译策略" });
	await memoryModelTab.click();
	assert(
		JSON.stringify(await getSettingOptionValues(page, "记忆 provider")) ===
			JSON.stringify([
				"siliconflow",
				"aliyun-bailian",
				"deepseek",
				"volcengine-agentplan",
				"ollama",
				"lm-studio",
				"custom-openai-compatible"
			]),
		"记忆 Provider 的成员或顺序不正确"
	);
	await selectSettingOption(page, "记忆 provider", "siliconflow");
	assert((await getSettingTextValue(page, "记忆模型")) === "Qwen/Qwen3.5-4B", "硅基流动默认记忆模型不正确");
	await memoryProcessingTab.click();
	await setSettingToggle(page, "长文本分块提取", false);
	assert((await activePanel.getByText("记忆分块字符数", { exact: true }).count()) === 0, "关闭记忆分块后不应显示分块字符数");
	await setSettingToggle(page, "长文本分块提取", true);
	await activePanel.getByText("记忆分块字符数", { exact: true }).waitFor({ state: "visible" });

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
		JSON.stringify(await getSettingOptionValues(page, "分析 provider")) ===
			JSON.stringify([
				"siliconflow",
				"aliyun-bailian",
				"deepseek",
				"volcengine-agentplan",
				"ollama",
				"lm-studio",
				"custom-openai-compatible"
			]),
		"AI 分析 Provider 的成员或顺序不正确"
	);

	await selectSettingOption(page, "分析 provider", "siliconflow");
	assert(
		(await getSettingTextValue(page, "分析模型")) === "Qwen/Qwen3.5-4B",
		"硅基流动默认分析模型不正确"
	);

	await selectSettingOption(page, "分析 provider", "ollama");
	await activePanel.getByText("分析 base URL", { exact: true }).waitFor({ state: "visible" });
	assert(await modelTab.getAttribute("aria-selected") === "true", "分析 Provider 重绘后应保留模型配置分类");

	await processingTab.click();
	await setSettingToggle(page, "长文本分块分析", false);
	await activePanel.getByText("AI 分析前脱敏 transcript", { exact: true }).waitFor({ state: "visible" });
	assert(await processingTab.getAttribute("aria-selected") === "true", "长文本开关重绘后应保留处理策略分类");
	assert(
		(await activePanel.getByText("分析分块字符数", { exact: true }).count()) === 0,
		"关闭长文本分块后不应显示分块字符数"
	);
	await setSettingToggle(page, "长文本分块分析", true);
	await activePanel.getByText("分析分块字符数", { exact: true }).waitFor({ state: "visible" });

	await modelTab.click();
	await selectSettingOption(page, "分析 provider", "aliyun-bailian");
	assert(await modelTab.getAttribute("aria-selected") === "true", "恢复分析 Provider 后应保留模型配置分类");
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
	assert(
		JSON.stringify(await categorySetting.locator("option").allTextContents()) ===
			JSON.stringify(["通用场景", "管理与组织", "产品与交付", "技术研发", "客户与增长", "自定义"]),
		"自定义模板角色分类选项不完整"
	);
	await categorySetting.locator("select").selectOption("engineering");
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
	await page.locator(".modal-close-button").last().click();
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
	await userItem.locator("textarea").nth(0).fill("完成可信审核闭环");
	await userItem.locator("textarea").nth(1).fill("隔离 UI 已核验");
	await projectItem.locator("select").selectOption("rejected");
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
	await reopenedUserItem.locator("select").selectOption("pending");
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
	assert((await modal.locator(".echo-notes-memory-relation-editor select").count()) === 3, "记忆关系编辑器控件不完整");
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
	const relationTypeSetting = modal.locator(".setting-item").filter({ hasText: "关系类型" });
	await relationTypeSetting.locator("select").selectOption("supersedes");
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
	await page.locator(".modal-close-button").last().click();
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
		assert((await modal.locator(".echo-notes-memory-context-editor select").count()) === 2, "上下文包项目和人物筛选控件不完整");
		assert((await modal.locator(".echo-notes-memory-context-editor input").count()) === 3, "上下文包日期和预算控件不完整");
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
		await modal.locator(".setting-item").filter({ hasText: "项目" }).locator("select").selectOption({ label: "Echo Notes" });
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
		await modal.locator(".setting-item").filter({ hasText: "项目" }).locator("select").selectOption({ label: "Echo Notes" });
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
	await page.addStyleTag({ content: MOBILE_SHELL_CSS });
	const results = [];
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
					`${context} 的 Provider 设置行响应式布局不符合预期`
				);

				const fileName = `settings-${stage.id}-${viewport.name}-${theme}.png`;
				const screenshotPath = path.join(OUTPUT_DIR, fileName);
				await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
				const screenshotStat = await stat(screenshotPath);
				assert(screenshotStat.size > 10_000, `${fileName} 截图可能为空白`);
				results.push({ stage: stage.id, viewport: viewport.name, theme, fileName, metrics });
			}
		}
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
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await reloadPluginAndOpenSettings(page);
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
	await verifyIntroduction(page);
	await verifyTabs(page);
	await reopenSettings(page);
	await page.locator('[data-settings-stage="transcription"]').click();
	const screenshots = await captureViewports(page);
	const templateLayouts = await verifyTemplateResponsiveLayouts(page);
	await verifyMemoryInitialization(page);
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
			introduction: true,
			keyboardNavigation: true,
			ariaRelationships: true,
			renderStatePersistence: true,
			templateGrouping: true,
			memoryInitialization: true,
			memoryCheckpointResume: true,
			memoryReview: true,
			memoryRelations: true,
			memoryAggregations: true,
			memoryContextPackages: true,
			runtimeErrors: pageErrors.length
		},
		screenshots,
		templateLayouts,
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
	console.log(`耗时：${summary.durationMs} ms；标准截图：${screenshots.length} 张；模板管理截图：${templateLayouts.length} 张；候选审核截图：${memoryReviewLayouts.length} 张；记忆关系截图：${memoryRelationLayouts.length} 张；上下文包截图：${memoryContextLayouts.length} 张`);
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

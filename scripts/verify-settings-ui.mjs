import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
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
`;

const VIEWPORTS = [
	{ name: "desktop-1280", width: 1280, height: 900, mobileShell: false, stackedSettings: false },
	{ name: "desktop-768", width: 768, height: 900, mobileShell: false, stackedSettings: true },
	{ name: "mobile-content-375", width: 375, height: 812, mobileShell: true, stackedSettings: true }
];

const THEMES = ["light", "dark"];

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
	assert(result.headingRelation, "引导区 aria-labelledby 关系无效");
	assert(result.correctOrder, "操作指引必须位于理念分割线与工作流步骤轴之间");
}

async function verifyTabs(page) {
	const transcriptionTab = page.locator('[data-settings-stage="transcription"]');
	const analysisTab = page.locator('[data-settings-stage="analysis"]');
	const agentTab = page.locator('[data-settings-stage="agent"]');

	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "首次打开应选中录音转写");
	assert(await agentTab.isDisabled(), "外部 Agent 步骤必须保持禁用");

	await analysisTab.click();
	assert(await analysisTab.getAttribute("aria-selected") === "true", "点击后应选中 AI 分析");
	await analysisTab.press("Home");
	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "顶层 Home 应切到录音转写");
	await transcriptionTab.press("End");
	assert(await analysisTab.getAttribute("aria-selected") === "true", "顶层 End 应切到 AI 分析");
	await analysisTab.press("ArrowLeft");
	assert(await transcriptionTab.getAttribute("aria-selected") === "true", "顶层左方向键应切换阶段");
	await transcriptionTab.press("ArrowRight");
	assert(await analysisTab.getAttribute("aria-selected") === "true", "顶层右方向键应切换阶段");

	await transcriptionTab.click();
	const activePanel = page.locator(".echo-notes-settings-panel:not([hidden])");
	const sectionTabs = activePanel.locator(".echo-notes-settings-section-tab");
	assert((await sectionTabs.allTextContents()).join("|") === "转写服务|录音控制|输出规则|自动化与日志", "转写二级分类不完整");
	const serviceTab = sectionTabs.filter({ hasText: "转写服务" });
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
	assert((await page.locator(".echo-notes-settings-intro").count()) === 1, "Tab 切换后引导区不应重复");
}

async function reopenSettings(page) {
	await page.evaluate(async (pluginId) => {
		window.app.setting.close();
		window.app.setting.open();
		await window.app.setting.openTabById(pluginId);
	}, PLUGIN_ID);
	await page.locator(".echo-notes-settings-intro").waitFor({ state: "visible" });
	assert((await page.locator(".echo-notes-settings-intro").count()) === 1, "重新打开设置后引导区不应重复");
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

async function inspectLayout(page) {
	return page.evaluate(() => {
		const content = document.querySelector(".vertical-tab-content");
		const panel = document.querySelector(".echo-notes-settings-panel:not([hidden])");
		const intro = document.querySelector(".echo-notes-settings-intro");
		const guide = document.querySelector(".echo-notes-settings-intro-guide");
		const workflow = document.querySelector(".echo-notes-settings-workflow");
		const providerItem = [...document.querySelectorAll(".echo-notes-settings-panel .setting-item")].find(
			(item) => item.querySelector(".setting-item-name")?.textContent === "Provider"
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
			providerStacked: Boolean(
				providerInfo &&
				providerControl &&
				providerControl.getBoundingClientRect().top >= providerInfo.getBoundingClientRect().bottom
			)
		};
	});
}

async function captureViewports(page) {
	await page.addStyleTag({ content: MOBILE_SHELL_CSS });
	const results = [];
	for (const viewport of VIEWPORTS) {
		for (const theme of THEMES) {
			await setViewportMode(page, viewport, theme);
			const metrics = await inspectLayout(page);
			assert(metrics.innerWidth === viewport.width, `${viewport.name} 的 viewport 宽度不匹配`);
			assert(metrics.contentOverflow <= 1, `${viewport.name}/${theme} 设置内容出现横向溢出`);
			assert(metrics.panelOverflow <= 1, `${viewport.name}/${theme} 插件面板出现横向溢出`);
			assert(metrics.documentOverflow <= 1, `${viewport.name}/${theme} 文档出现横向溢出`);
			assert(metrics.introBeforeWorkflow, `${viewport.name}/${theme} 引导区与步骤轴发生重叠`);
			assert(metrics.stepFits, `${viewport.name}/${theme} 步骤标签发生裁切`);
			assert(
				metrics.providerStacked === viewport.stackedSettings,
				`${viewport.name}/${theme} 的 Provider 设置行响应式布局不符合预期`
			);

			const fileName = `settings-${viewport.name}-${theme}.png`;
			const screenshotPath = path.join(OUTPUT_DIR, fileName);
			await page.locator(".modal.mod-settings").screenshot({ path: screenshotPath });
			const screenshotStat = await stat(screenshotPath);
			assert(screenshotStat.size > 10_000, `${fileName} 截图可能为空白`);
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

try {
	const manifest = await validateWorkspace();
	const obsidianAsar = await findLatestObsidianAsar();
	assert(
		compareVersions(obsidianAsar.version, manifest.minAppVersion) >= 0,
		`Obsidian ${obsidianAsar.version} 低于插件最低要求 ${manifest.minAppVersion}`
	);

	await mkdir(OUTPUT_DIR, { recursive: true });
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
	await verifyIntroduction(page);
	await verifyTabs(page);
	await reopenSettings(page);
	await page.locator('[data-settings-stage="transcription"]').click();
	const screenshots = await captureViewports(page);
	assert(pageErrors.length === 0, `设置页出现运行时错误：${pageErrors.join(" | ")}`);

	const summary = {
		pluginVersion: manifest.version,
		obsidianVersion: obsidianAsar.version,
		sourceTestVault: TEST_VAULT,
		generatedAt: new Date().toISOString(),
		screenshots
	};
	await writeFile(
		path.join(OUTPUT_DIR, "summary.json"),
		`${JSON.stringify(summary, null, "\t")}\n`,
		"utf8"
	);

	console.log(`Echo Notes 设置页验证通过：Obsidian ${obsidianAsar.version}`);
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
	await removeIsolatedProfile(isolatedProfile);
}

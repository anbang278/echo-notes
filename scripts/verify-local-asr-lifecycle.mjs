import assert from "node:assert/strict";
import path from "node:path";
import { verifyAsrDiscovery } from "./verify-asr-discovery.mjs";

const STORAGE_KEY = "echo-notes:local-asr-lifecycle:v1";
const A = "http://127.0.0.1:29181/v1";
const B = "http://127.0.0.1:29182/v1";

/** Real Obsidian form checks; all profiles and commands are synthetic. */
export async function verifyLocalAsrLifecycle(page, helpers) {
	const { pluginId, getActiveSetting, getActivePanel, setViewportMode, viewports, themes, outputDir } = helpers;
	const block = () => getActivePanel(page).locator(".echo-notes-local-asr-service-block");
	const field = (key) => block().locator(`#echo-notes-local-asr-${key}`);
	const error = () => block().locator('[role="alert"]');
	const toggle = () => block().locator(".checkbox-container");
	const open = async () => {
		if (!await block().isVisible()) {
			const advanced = getActivePanel(page).locator("details.echo-notes-settings-advanced");
			if (await advanced.count()) await advanced.evaluate(el => { el.open = true; });
			await page.locator(".echo-notes-local-asr-jump button").click();
		}
		const button = block().locator(".echo-notes-local-asr-config-toggle");
		if (await button.getAttribute("aria-expanded") !== "true") await button.click();
	};
	const setEnabled = async (enabled) => {
		if ((await toggle().getAttribute("aria-checked")) !== String(enabled)) {
			await toggle().locator('input[type="checkbox"]').evaluate((el) => el.click());
		}
		await page.waitForFunction((enabled) => {
			const el = document.querySelector(".echo-notes-local-asr-service-block .checkbox-container");
			return el?.classList.contains("is-enabled") === enabled && el?.getAttribute("aria-checked") === String(enabled) && el?.querySelector("input")?.checked === enabled;
		}, enabled);
	};
	const setValue = async (key, value) => { await field(key).fill(value); await field(key).blur(); };
	const readProfiles = () => page.evaluate((key) => JSON.parse(window.app.loadLocalStorage(key) || "{}"), STORAGE_KEY);
	const saved = async (url = A) => (await readProfiles())[`local-openai-compatible|${url}`];
	const configure = async () => {
		await setValue("startCommand", "/opt/isolated-asr/start.sh");
		await setValue("stopCommand", "/opt/isolated-asr/stop.sh");
	};
	const changeUrl = async (url) => {
		await page.getByRole("tab", { name: "转写服务", exact: true }).click();
		await getActivePanel(page).locator("details.echo-notes-settings-advanced").evaluate(el => { el.open = true; });
		const input = (await getActiveSetting(page, "Base URL")).locator('input[type="text"]');
		await input.fill(url); await input.blur();
		await page.waitForFunction(({ id, url }) => window.app.plugins.plugins[id].settings.offlineTranscription.baseUrl === url, { id: pluginId, url });
		await open();
	};
	const snapshot = await page.evaluate(async ({ id, key, baseUrl }) => {
		const plugin = window.app.plugins.plugins[id];
		const previous = {
			offline: plugin.settings.offlineTranscription, profiles: plugin.settings.offlineTranscriptionByProvider,
			mode: plugin.settings.transcriptionMode, storage: window.app.loadLocalStorage(key),
			stage: plugin.settingTab.activeSettingsStage, analysisSection: plugin.settingTab.activeAnalysisSettingsSection, transcriptionSection: plugin.settingTab.activeTranscriptionSettingsSection
		};
		plugin.settings.transcriptionMode = "offline";
		plugin.settings.offlineTranscription = { provider: "local-openai-compatible", baseUrl, model: "isolated-model", language: "auto" };
		plugin.settings.offlineTranscriptionByProvider = {};
		plugin.settingTab.localAsrDrafts?.clear();
		plugin.settingTab.localAsrConfigOpen = false;
		window.app.saveLocalStorage(key, "{}");
		await plugin.saveSettings();
		plugin.settingTab.showDestination("transcription-service");
		return previous;
	}, { id: pluginId, key: STORAGE_KEY, baseUrl: A });
	let spyInstalled = false;
	try {
		await open();
		// Regression: changing the address in this page must not copy the previous command.
		// This assertion also runs against the old compiled 0.4.41 bundle for RED evidence.
		const commands = () => block().locator(".echo-notes-local-asr-command-input");
		await commands().nth(0).fill("/opt/isolated-asr/start.sh");
		await commands().nth(0).blur();
		await changeUrl(B);
		assert.equal(await commands().nth(0).inputValue(), "", "切换Base URL后仍显示上一个服务的启动命令");
		await changeUrl(A);
		await open();
		assert.equal(await commands().nth(0).inputValue(), "/opt/isolated-asr/start.sh");
		// Instrument actual manager dependencies, and prove each observer can see a call.
		await page.evaluate(async (id) => {
			const manager = window.app.plugins.plugins[id].localAsrLifecycle;
			const original = { acquire: manager.acquire, probe: manager.deps.probe, runCommand: manager.deps.runCommand };
			const counts = { acquire: 0, probe: 0, command: 0 };
			manager.acquire = function (...args) { counts.acquire++; return original.acquire.apply(this, args); };
			manager.deps.probe = async () => { counts.probe++; return { kind: "ready" }; };
			manager.deps.runCommand = async () => { counts.command++; return { cancel() {}, exited: Promise.resolve({ code: 0, signal: null }) }; };
			const lease = await manager.acquire({
				provider: "local-openai-compatible", baseUrl: "http://127.0.0.1:29189/v1", readinessUrl: "http://127.0.0.1:29189/health",
				startCommand: "synthetic", stopCommand: "synthetic", workingDirectory: "", startupTimeoutSeconds: 1, idleTimeoutSeconds: 0, shutdownTimeoutSeconds: 1
			});
			await lease.release("safe-terminal");
			await manager.deps.runCommand({ command: "synthetic", workingDirectory: "", timeoutMs: 1 });
			if (!counts.acquire || !counts.probe || !counts.command) throw new Error("执行入口观测器自检失败");
			counts.acquire = counts.probe = counts.command = 0;
			window.__echoAsrVerification = { manager, original, counts };
		}, pluginId);
		spyInstalled = true;

		// FT01: required commands, native click ordering, error visibility and focus.
		await setValue("startCommand", "");
		await setValue("stopCommand", "");
		await toggle().locator("input").evaluate((el) => el.click());
		await error().waitFor({ state: "visible" });
		assert.equal(await toggle().getAttribute("aria-checked"), "false");
		assert.equal(await toggle().evaluate((el) => el.classList.contains("is-enabled")), false);
		await field("startCommand").evaluate((el) => { if (document.activeElement !== el) throw new Error("首个无效字段未获得焦点"); });
		await configure();
		await setEnabled(true);
		assert.equal((await saved()).enabled, true);
		await toggle().press("Space");
		await page.waitForFunction(() => document.querySelector(".echo-notes-local-asr-service-block .checkbox-container")?.getAttribute("aria-checked") === "false");
		await block().locator(".echo-notes-local-asr-setting-name").click();
		await page.waitForFunction(() => document.querySelector(".echo-notes-local-asr-service-block .checkbox-container")?.getAttribute("aria-checked") === "true");

		// FT02/03: invalid raw values never overwrite the active profile.
		for (const key of ["startupTimeoutSeconds", "idleTimeoutSeconds", "shutdownTimeoutSeconds"]) {
			const original = await field(key).inputValue();
			for (const invalid of ["", "-1", "1.5", "86401"]) {
				const before = JSON.stringify(await saved());
				await setValue(key, invalid);
				await error().waitFor({ state: "visible" });
				assert.equal(JSON.stringify(await saved()), before, `${key}非法输入覆盖有效配置`);
				await setValue(key, original);
			}
			await setValue(key, "86400");
			assert.equal((await saved())[key], 86400);
			await setValue(key, original);
		}
		await setValue("idleTimeoutSeconds", "0");
		assert.equal((await saved()).idleTimeoutSeconds, 0);
		await setValue("idleTimeoutSeconds", "30");
		await setValue("stopCommand", "");
		assert.equal((await saved()).stopCommand, "/opt/isolated-asr/stop.sh");
		await setEnabled(false); // Disabling must not depend on draft validity.
		assert.equal((await saved()).enabled, false);
		await configure();
		await setEnabled(true);
		await setValue("readinessUrl", "http://127.0.0.1:29182/health");
		await error().waitFor({ state: "visible" });
		assert.equal((await saved()).readinessUrl, "http://127.0.0.1:29181/health");
		await setValue("readinessUrl", "http://127.0.0.1:29181/health");

		// FT04: old config object, repeated saves, profile aliases, unsaved address.
		await page.getByRole("tab", { name: "转写服务", exact: true }).click();
		await getActivePanel(page).locator("details.echo-notes-settings-advanced").evaluate(el => { el.open = true; });
		await (await getActiveSetting(page, "默认转写语言")).locator('select:not([aria-hidden="true"])').selectOption("en");
		await changeUrl(B);
		assert.equal(await field("startCommand").inputValue(), "");
		assert.equal(await field("readinessUrl").inputValue(), "http://127.0.0.1:29182/health");
		await setValue("startCommand", "/opt/isolated-b/start.sh");
		await setValue("stopCommand", "/opt/isolated-b/stop.sh");
		await setEnabled(true);
		await changeUrl(A);
		assert.equal(await field("startCommand").inputValue(), "/opt/isolated-asr/start.sh");
		await setValue("startupTimeoutSeconds", "-1");
		await changeUrl(B);
		await changeUrl(A);
		assert.equal(await field("startupTimeoutSeconds").inputValue(), "-1", "切回服务后编辑草稿丢失");
		await setValue("startupTimeoutSeconds", "180");
		await changeUrl("http://localhost:29181/v1/");
		assert.equal(await field("startCommand").inputValue(), "/opt/isolated-asr/start.sh");
		await changeUrl(A);
		await page.getByRole("tab", { name: "转写服务", exact: true }).click();
		await getActivePanel(page).locator("details.echo-notes-settings-advanced").evaluate(el => { el.open = true; });
		const pendingAddress = (await getActiveSetting(page, "Base URL")).locator('input[type="text"]');
		await pendingAddress.fill(B);
		await open();
		await page.waitForFunction((id) => window.app.plugins.plugins[id].settings.offlineTranscription.baseUrl.endsWith("29182/v1"), pluginId);
		assert.equal((await saved(A)).startCommand, "/opt/isolated-asr/start.sh");
		await changeUrl(A);

		// FT05: failure injection into actual device storage APIs, restored in finally.
		await page.evaluate(() => {
			window.__echoAsrSave = window.app.saveLocalStorage;
			window.app.saveLocalStorage = () => { throw new Error("synthetic private write error"); };
		});
		try {
			await setValue("startCommand", "/opt/changed/start.sh");
			await error().waitFor({ state: "visible" });
			assert((await error().textContent()).includes("无法保存本机配置"));
			assert.equal((await saved()).startCommand, "/opt/isolated-asr/start.sh");
		} finally {
			await page.evaluate(() => { window.app.saveLocalStorage = window.__echoAsrSave; delete window.__echoAsrSave; });
		}
		await setValue("startCommand", "/opt/isolated-asr/start.sh");
		const beforeReadFailure = JSON.stringify(await readProfiles());
		await page.evaluate((id) => {
			window.__echoAsrLoad = window.app.loadLocalStorage;
			window.app.loadLocalStorage = () => { throw new Error("synthetic private read error"); };
			window.app.plugins.plugins[id].settingTab.refreshSettings();
		}, pluginId);
		try {
			await open();
			await error().waitFor({ state: "visible" });
			assert((await error().textContent()).includes("无法读取本机配置"));
		} finally {
			await page.evaluate(() => { window.app.loadLocalStorage = window.__echoAsrLoad; delete window.__echoAsrLoad; });
		}
		assert.equal(JSON.stringify(await readProfiles()), beforeReadFailure);
		await field("startCommand").focus();
		await field("startCommand").blur(); // retry read, without writing defaults
		await open();
		assert.equal(await field("startCommand").inputValue(), "/opt/isolated-asr/start.sh");
		await page.evaluate((id) => window.app.plugins.plugins[id].settingTab.refreshSettings(), pluginId);
		await open();
		assert.equal(await toggle().getAttribute("aria-checked"), "true", "重新打开设置后启用状态丢失");

		const discovery = await verifyAsrDiscovery(page, { block, setValue, open, setEnabled, saved, readProfiles, pluginId, outputDir });

		// FT07/08: measure the actual expanded conditional group in every container.
		const layouts = [];
		const matrix = [...viewports, { name: "wide-window-narrow-panel", width: 1280, height: 900, mobileShell: false, narrowPanel: true }];
		for (const viewport of matrix) {
			for (const theme of themes) {
				await setViewportMode(page, viewport, theme);
				if (viewport.narrowPanel) {
					const style = await page.addStyleTag({ content: ".echo-notes-settings-panel { width:600px !important; max-width:600px !important; }" });
					await style.evaluate((el) => { el.id = "echo-asr-narrow-test"; });
				}
				try {
					await open();
					await block().locator(".echo-notes-local-asr-config-toggle").focus();
					await page.keyboard.press("Enter");
					assert.equal(await block().locator(".echo-notes-local-asr-fields").isVisible(), false);
					await page.keyboard.press("Space");
					assert.equal(await block().locator(".echo-notes-local-asr-fields").isVisible(), true);
					await setEnabled(false);
					await setValue("startCommand", "");
					await toggle().locator("input").evaluate((el) => el.click());
					await error().waitFor({ state: "visible" });
					assert.equal(await toggle().getAttribute("aria-checked"), "false");
					await configure();
					await setEnabled(true);
					await setValue("workingDirectory", "/tmp/" + "long synthetic path ".repeat(15));
					const metrics = await block().evaluate((el) => {
						const bounds = el.getBoundingClientRect();
						const panel = el.closest(".echo-notes-settings-panel").getBoundingClientRect();
						const cells = [...el.querySelectorAll(".echo-notes-local-asr-field")];
						const inputs = [...el.querySelectorAll(".echo-notes-local-asr-field input")];
						const fit = (node, parent) => {
							const r = node.getBoundingClientRect(), p = parent.getBoundingClientRect();
							return r.width > 0 && r.left >= p.left - 1 && r.right <= p.right + 1;
						};
						return {
							panelWidth: panel.width, blockWidth: bounds.width, fieldCount: inputs.length,
							textCount: inputs.filter((n) => n.type === "text").length, numberCount: inputs.filter((n) => n.type === "number").length,
							overflow: el.scrollWidth - el.clientWidth,
							toggleFits: fit(el.querySelector(".checkbox-container"), el),
							discoveryFits: fit(el.querySelector("#echo-notes-asr-directory"), el),
							toggleBounds: { left: el.querySelector(".checkbox-container").getBoundingClientRect().left - bounds.left, right: el.querySelector(".checkbox-container").getBoundingClientRect().right - bounds.left },
							cellsFit: cells.every((n) => fit(n, el)),
							inputsFit: inputs.every((n) => fit(n, n.closest(".setting-item"))),
							labelsAbove: cells.every((n) => n.querySelector(".setting-item-name").getBoundingClientRect().bottom <= n.querySelector("input").getBoundingClientRect().top + 1),
							inputHeight: Math.min(...inputs.map((n) => n.getBoundingClientRect().height)),
							buttonHeight: el.querySelector(".echo-notes-local-asr-config-toggle").getBoundingClientRect().height,
							columns: getComputedStyle(el.querySelector(".echo-notes-local-asr-parameter-grid")).gridTemplateColumns.split(" ").length,
							labelsNamed: inputs.every((n) => document.getElementById(n.getAttribute("aria-labelledby"))?.textContent.trim())
						};
					});
					assert.equal(metrics.fieldCount, 7);
					assert.equal(metrics.textCount, 4);
					assert.equal(metrics.numberCount, 3);
					assert(metrics.overflow <= 1 && metrics.cellsFit && metrics.inputsFit && metrics.labelsAbove && metrics.toggleFits && metrics.discoveryFits, JSON.stringify(metrics));
					assert(metrics.inputHeight >= 44 && metrics.buttonHeight >= 44 && metrics.labelsNamed);
					assert.equal(metrics.columns, metrics.panelWidth <= 620 ? 1 : 2);
					const fileName = `settings-local-asr-${viewport.name}-${theme}.png`;
					await block().locator(".echo-notes-local-asr-toggle-row").scrollIntoViewIfNeeded();
					await page.locator(".modal.mod-settings").screenshot({ path: path.join(outputDir, fileName) });
					const parameterFileName = fileName.replace(".png", "-parameters.png");
					await field("shutdownTimeoutSeconds").scrollIntoViewIfNeeded();
					await page.locator(".modal.mod-settings").screenshot({ path: path.join(outputDir, parameterFileName) });
					layouts.push({ viewport: viewport.name, theme, fileName, parameterFileName, ...metrics });
				} finally {
					if (viewport.narrowPanel) await page.locator("#echo-asr-narrow-test").evaluateAll((els) => els.forEach((el) => el.remove()));
				}
			}
		}
		assert.equal(await page.locator("#echo-asr-narrow-test").count(), 0, "窄面板测试样式未清理");
		const counts = await page.evaluate(() => ({ ...window.__echoAsrVerification.counts }));
		assert.deepEqual(counts, { acquire: 0, probe: 0, command: 0 }, "编辑/保存/启用触发了服务执行");
		// Persistence across an actual plugin unload/load, using only the isolated Vault.
		await page.evaluate(async (id) => {
			const { manager, original } = window.__echoAsrVerification;
			manager.acquire = original.acquire;
			manager.deps.probe = original.probe;
			manager.deps.runCommand = original.runCommand;
			delete window.__echoAsrVerification;
			window.app.setting.close();
			await window.app.plugins.disablePlugin(id);
			await window.app.plugins.enablePluginAndSave(id);
			window.app.setting.open();
			await window.app.setting.openTabById(id);
			window.app.plugins.plugins[id].settingTab.showDestination("transcription-service");
		}, pluginId);
		spyInstalled = false;
		await setViewportMode(page, viewports[0], "light");
		await open();
		assert.equal(await toggle().getAttribute("aria-checked"), "true");
		assert.equal((await saved()).enabled, true);
		assert.equal(await field("startCommand").inputValue(), "/opt/isolated-asr/start.sh");
		return { scenarios: ["FT01", "FT02", "FT03", "FT04", "FT05", "FT06", "FT07", "FT08"], layouts, discovery, noExecution: counts };
	} finally {
		await page.evaluate(async ({ id, key, previous, spyInstalled }) => {
			if (spyInstalled && window.__echoAsrVerification) {
				const { manager, original } = window.__echoAsrVerification;
				manager.acquire = original.acquire;
				manager.deps.probe = original.probe;
				manager.deps.runCommand = original.runCommand;
				delete window.__echoAsrVerification;
			}
			const plugin = window.app.plugins.plugins[id];
			plugin.settings.offlineTranscription = previous.offline;
			plugin.settings.offlineTranscriptionByProvider = previous.profiles;
			plugin.settings.transcriptionMode = previous.mode;
			window.app.saveLocalStorage(key, previous.storage ?? "{}");
			plugin.settingTab.localAsrDrafts?.clear();
			plugin.settingTab.localAsrConfigOpen = false;
			plugin.settingTab.activeSettingsStage = previous.stage;
			plugin.settingTab.activeAnalysisSettingsSection = previous.analysisSection;
			plugin.settingTab.activeTranscriptionSettingsSection = previous.transcriptionSection;
			await plugin.saveSettings();
			plugin.settingTab.refreshSettings();
		}, { id: pluginId, key: STORAGE_KEY, previous: snapshot, spyInstalled });
		await setViewportMode(page, viewports[0], "light");
	}
}

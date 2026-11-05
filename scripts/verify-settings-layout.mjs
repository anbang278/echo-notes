import assert from "node:assert/strict";
import path from "node:path";

// Exercise real settings DOM in the isolated Obsidian host, including a narrow
// settings pane inside a wide desktop window (not a mobile viewport).
export async function verifySettingsLayout(page, { pluginId, outputDir, getActivePanel, setViewportMode, viewports }) {
	const snapshot = await page.evaluate((id) => {
		const plugin = window.app.plugins.plugins[id];
		return {
			settings: JSON.stringify(plugin.settings),
			navigation: Object.fromEntries([
				"activeSettingsStage", "activeTranscriptionSettingsSection", "activeTranscriptionCapability",
				"activeAnalysisSettingsSection", "activeMemorySettingsSection"
			].map((key) => [key, plugin.settingTab[key]]))
		};
	}, pluginId);
	const fixture = await page.addStyleTag({ content: `
		.modal.mod-settings { width: 900px !important; height: 700px !important; max-height: 700px !important; }
		.echo-notes-settings-shell { width: calc(var(--echo-layout-test-width) + 42px) !important; max-width: none !important; }
	` });
	const results = [];
	try {
		for (const provider of ["siliconflow", "local-openai-compatible"]) {
			await page.evaluate(({ id, provider }) => {
				const plugin = window.app.plugins.plugins[id];
				plugin.settings.transcriptionMode = "offline";
				plugin.settings.offlineTranscription.provider = provider;
				plugin.settings.offlineTranscription.model = "Qwen/Qwen3-ASR-1.7B";
				plugin.settingTab.showDestination("transcription-recording");
			}, { id: pluginId, provider });
			await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
			for (const theme of ["light", "dark"]) {
				await setViewportMode(page, viewports[0], theme);
				for (const scale of [1, 1.25]) {
					for (const width of [554, 560, 620, 480, 479, 360, 359]) {
						await page.evaluate(({ width, scale }) => {
							document.body.style.setProperty("--echo-layout-test-width", `${width}px`);
							document.body.style.setProperty("--font-ui-small", `${14 * scale}px`);
							document.body.style.setProperty("--font-ui-smaller", `${12 * scale}px`);
							document.body.style.setProperty("--font-ui-medium", `${16 * scale}px`);
						}, { width, scale });
						const metrics = await getActivePanel(page).evaluate((panel) => {
							const rect = (selector) => panel.querySelector(selector).getBoundingClientRect();
							const providerEl = panel.querySelector(".echo-notes-transcription-context-provider");
							const range = document.createRange();
							range.selectNodeContents(providerEl);
							const lineTops = [...range.getClientRects()].map((r) => Math.round(r.top));
							const cards = [...panel.querySelectorAll(".echo-notes-settings-capability-tab")];
							const labels = [...panel.querySelectorAll(".echo-notes-settings-capability-tab-title > span")];
							const rows = (elements) => new Set(elements.map((el) => Math.round(el.getBoundingClientRect().top))).size;
							const sectionTabs = [...panel.querySelectorAll(".echo-notes-settings-section-tab")];
							const service = rect(".echo-notes-transcription-context-service");
							const identity = rect(".echo-notes-transcription-context-identity");
							const button = rect(".echo-notes-transcription-context-switch");
							const grid = rect(".echo-notes-settings-capability-tabs");
							return {
								panelWidth: panel.getBoundingClientRect().width,
								panelOverflow: panel.scrollWidth - panel.clientWidth,
								serviceWidthRatio: service.width / identity.width,
								providerLines: new Set(lineTops).size,
								serviceHeight: rect(".echo-notes-transcription-context").height,
								serviceOverlapsButton: service.right > button.left + 1 && service.bottom > button.top + 1 && button.bottom > service.top + 1,
								sectionRows: rows(sectionTabs), cardRows: rows(cards), cardCount: cards.length, gridHeight: grid.height,
								cardsFit: cards.every((card) => card.scrollWidth <= card.clientWidth + 1 && card.scrollHeight <= card.clientHeight + 1),
								labelsFit: labels.every((label) => {
									const r = label.getBoundingClientRect(); const c = label.closest("button").getBoundingClientRect();
									return r.left >= c.left && r.right <= c.right && r.bottom <= c.bottom;
								}),
								minimumCardHeight: Math.min(...cards.map((c) => c.getBoundingClientRect().height))
							};
						});
						const context = `${provider}/${theme}/${scale}/${width}: ${JSON.stringify(metrics)}`;
						if (width === 554 && scale === 1) {
							await page.locator(".vertical-tab-content").evaluate((el) => {
								const workflow = el.querySelector(".echo-notes-settings-workflow");
								el.scrollTop += workflow.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
							});
							await page.locator(".modal.mod-settings").screenshot({ path: path.join(outputDir, `settings-default-${provider}-${theme}.png`) });
						}
						assert(Math.abs(metrics.panelWidth - width) <= 1, `尺寸夹具错误 ${context}`);
						assert(metrics.serviceWidthRatio >= 0.6 && metrics.providerLines <= 2, `服务名称被挤压 ${context}`);
						assert(!metrics.serviceOverlapsButton && metrics.panelOverflow <= 1, `服务栏重叠或溢出 ${context}`);
						assert.equal(metrics.sectionRows, width >= 480 ? 1 : 2, `分类行数错误 ${context}`);
						const columns = width >= 480 ? 3 : width >= 360 ? 2 : 1;
						assert.equal(metrics.cardCount, provider === "siliconflow" ? 5 : 6, `能力数错误 ${context}`);
						assert.equal(metrics.cardRows, Math.ceil(metrics.cardCount / columns), `能力布局不紧凑 ${context}`);
						assert(metrics.cardsFit && metrics.labelsFit && metrics.minimumCardHeight >= 44, `能力文本裁切或点击目标不足 ${context}`);
						if (width === 554 && scale === 1 && provider === "siliconflow") {
							assert(metrics.serviceHeight <= 140 && metrics.gridHeight <= 128, `默认窗口占高过大 ${context}`);
						}
						results.push({ provider, theme, scale, width, ...metrics });
					}
				}
			}
		}
		// A long, unbroken model ID may wrap, but must remain fully accessible.
		await page.evaluate((id) => {
			const plugin = window.app.plugins.plugins[id];
			plugin.settings.offlineTranscription.model = "organization/long-model-identifier-".repeat(5);
			plugin.settingTab.showDestination("transcription-recording");
		}, pluginId);
		await getActivePanel(page).getByRole("tab", { name: "能力增强", exact: true }).click();
		assert(await getActivePanel(page).locator(".echo-notes-transcription-context-model").evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "长模型名溢出");
	} finally {
		await fixture.evaluate((el) => el.remove());
		await page.evaluate(async ({ id, snapshot }) => {
			for (const property of ["--echo-layout-test-width", "--font-ui-small", "--font-ui-smaller", "--font-ui-medium"]) document.body.style.removeProperty(property);
			const plugin = window.app.plugins.plugins[id];
			plugin.settings = JSON.parse(snapshot.settings);
			await plugin.saveSettings();
			Object.assign(plugin.settingTab, snapshot.navigation);
			plugin.settingTab.display();
		}, { id: pluginId, snapshot });
		await setViewportMode(page, viewports[0], "light");
	}
	return results;
}

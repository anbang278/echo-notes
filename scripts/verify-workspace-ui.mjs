import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";

async function waitUntil(check, message, timeout = 10000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(message);
}

const VIEW_TYPE = "echo-notes-meeting-workspace";
const FIXTURE_KEY = "__echoMeetingWorkspaceValidation";

/** Runs inside the existing isolated Obsidian host and restores all fixture state. */
export async function verifyMeetingWorkspace(page, helpers) {
	const { pluginId, outputDir, validationVault, setViewportMode } = helpers;
	assert(validationVault && /echo-notes-settings-ui-[^/\\]+[/\\]vault$/.test(validationVault), "会议中心验证需要明确的隔离 Vault 路径");
	const originalViewport = page.viewportSize();
	const report = { functional: {}, layouts: [], fixtureMeetings: 3, validationScope: "isolated-obsidian-workspace" };
	const viewports = [
		{ name: "desktop-1280", width: 1280, height: 900, mobileShell: false },
		{ name: "desktop-768", width: 768, height: 900, mobileShell: false },
		{ name: "mobile-375", width: 375, height: 812, mobileShell: true }
	];
	const workspace = () => page.locator(".echo-notes-workspace").last();
	const dialog = (title) => page.locator(".modal").filter({ has: page.getByText(title, { exact: true }) }).last();
	const setting = (container, title) => container.locator(".setting-item").filter({ has: page.getByText(title, { exact: true }) });
	const waitWorkspace = async () => {
		await workspace().waitFor({ state: "visible" });
		await page.waitForFunction((type) => {
			const view = window.app.workspace.getLeavesOfType(type)[0]?.view;
			return Boolean(view?.snapshot && !view.loading && !view.error);
		}, VIEW_TYPE);
	};
	const closeDialog = async (title) => {
		const modal = dialog(title);
		if (await modal.isVisible()) {
			await page.keyboard.press("Escape");
			await modal.waitFor({ state: "hidden" });
		}
	};
	await mkdir(outputDir, { recursive: true });
	try {
		const prepared = await page.evaluate(async ({ id, expectedVault, fixtureKey }) => {
			const app = window.app;
			if (app.vault.adapter.getBasePath() !== expectedVault) throw new Error("会议中心 fixture 目标与隔离 Vault 不一致");
			const plugin = app.plugins.plugins[id];
			if (!plugin?.meetingWorkspace || typeof plugin.activateMeetingWorkspace !== "function") throw new Error("会议中心入口未注册");
			const root = `会议中心隔离验收-${Date.now()}`;
			const original = {
				settings: plugin.settings, activeLeaf: app.workspace.activeLeaf,
				settingsOpen: Boolean(document.querySelector(".modal.mod-settings")),
				leftCollapsed: app.workspace.leftSplit?.collapsed, rightCollapsed: app.workspace.rightSplit?.collapsed,
				bodyClasses: ["theme-light", "theme-dark", "echo-notes-verify-mobile-shell"].filter((name) => document.body.classList.contains(name))
			};
			window[fixtureKey] = { root, original };
			app.setting.close();
			app.workspace.leftSplit?.collapse();
			app.workspace.rightSplit?.collapse();
			await app.vault.createFolder(root);
			plugin.settings = { ...plugin.settings, memoryRootFolder: `${root}/Memory`, memoryPathLanguage: "zh", meetingDisplayTimezone: "Asia/Taipei", meetingWorkspaceMode: "reader", autoTranscribeOnAudioLink: false, autoTranscribeNewAudio: false };
			await plugin.saveSettings();
			const service = plugin.meetingWorkspace;
			await service.catalog.initialize();
			const project = await service.catalog.registerProject(`${root}/Project.md`, "工作台验收项目");
			const other = await service.catalog.registerProject(`${root}/OtherProject.md`, "另一个验收项目");
			const todayParts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
			const part = (type) => todayParts.find((item) => item.type === type)?.value ?? "";
			const date = `${part("year")}-${part("month")}-${part("day")}`;
			const inputs = [
				{ title: "B/C 模式验收 · 分级处理方案与长标题的阅读布局", body: "产品：为什么调整统一提醒？\n\n运营：统一提醒数量过多，保留人工干预入口后改为分级处理。\n\n产品：如果承诺时间存在风险，仍需人工确认。", project: project.id, time: { precision: "date", date, source: "user", confirmed: true }, tags: ["产品评审"] },
				{ title: "B/C 日期未知会议", body: "发言人：这段录音未记录发生日期，等待人工补全。", time: { precision: "unknown", reason: "隔离构造录音缺少发生日期" }, tags: ["导入录音"] },
				{ title: "B/C 另一个项目例会", body: "项目经理：本周按既定节点推进，暂时没有额外风险。", project: other.id, time: { precision: "date", date, source: "user", confirmed: true }, tags: ["项目例会"] }
			];
			const sources = [];
			for (const [index, input] of inputs.entries()) {
				const file = await app.vault.create(`${root}/source-${index}.transcript.md`, `---\ntype: audio-transcript\nstatus: done\n---\n<!-- echo-notes-transcript:start -->\n# 转写稿 ${input.title}\n\n${input.body}\n<!-- echo-notes-transcript:end -->\n`);
				const source = await service.catalog.registerTranscript({ transcriptPath: file.path, title: input.title, time: input.time });
				await service.catalog.updateMeetingMetadata(source.meetingId, { time: input.time, tags: input.tags });
				if (input.project) await service.catalog.setMeetingProjects(source.meetingId, [input.project]);
				sources.push({ path: file.path, meetingId: source.meetingId, content: await app.vault.read(file) });
			}
			window[fixtureKey].sources = sources;
			window[fixtureKey].projectId = project.id;
			window[fixtureKey].date = date;
			await plugin.activateMeetingWorkspace("reader");
			return { projectId: project.id, date, root, primaryMeetingId: sources[0].meetingId };
		}, { id: pluginId, expectedVault: validationVault, fixtureKey: FIXTURE_KEY });
		for (let attempt = 0; attempt < 8 && await page.locator(".modal-container").count(); attempt++) {
			const close = page.locator(".modal-container").last().locator(".modal-close-button");
			if (await close.count() && await close.isVisible()) await close.click();
			else await page.keyboard.press("Escape");
			await page.waitForTimeout(50);
		}
		assert.equal(await page.locator(".modal-container").count(), 0, "前序验收弹窗未关闭，会议中心不可交互");
		await setViewportMode(page, viewports[0], "light");
		await waitWorkspace();
		await workspace().getByLabel("会议日期范围", { exact: true }).selectOption("all");
		await page.waitForFunction(() => document.querySelectorAll(".echo-notes-workspace-meeting-card").length === 3);
		assert.equal(await workspace().locator(".echo-notes-workspace-meeting-card").count(), 3, "日期未知会议在全部日期范围中丢失");
		await workspace().getByLabel("会议日期范围", { exact: true }).selectOption("undated");
		assert.equal(await workspace().locator(".echo-notes-workspace-meeting-card").count(), 1, "日期待补全筛选错误");
		assert((await workspace().locator(".echo-notes-workspace-meetings").innerText()).includes("日期未知会议"));
		await workspace().getByLabel("会议日期范围", { exact: true }).selectOption("all");
		await workspace().locator(".echo-notes-workspace-project-filters").getByRole("button", { name: "工作台验收项目", exact: true }).click();
		assert.equal(await workspace().locator(".echo-notes-workspace-meeting-card").count(), 1, "项目范围未按稳定关系筛选");
		await workspace().getByLabel("查找会议与摘要", { exact: true }).fill("分级处理");
		await workspace().locator(".echo-notes-workspace-tag-filters > summary").click();
		await setting(workspace().locator(".echo-notes-workspace-tag-filters"), "产品评审").locator(".checkbox-container").click();
		assert.equal(await workspace().locator(".echo-notes-workspace-meeting-card").count(), 1, "项目/标签/关键词组合筛选错误");
		report.functional.dateProjectTagFiltering = true;

		await workspace().locator(".echo-notes-workspace-detail-tabs").getByRole("tab", { name: "摘要", exact: true }).focus();
		await page.keyboard.press("ArrowRight");
		assert.equal(await workspace().locator(".echo-notes-workspace-detail-tabs").getByRole("tab", { name: "原文", exact: true }).getAttribute("aria-selected"), "true", "会议内容 Tab 方向键失效");
		assert((await workspace().locator(".echo-notes-workspace-detail-content").innerText()).includes("统一提醒数量过多"), "正式原文未在详情显示");
		report.functional.formalTranscriptAndKeyboardTabs = true;

		await workspace().locator(".echo-notes-workspace-material-bar").getByRole("button", { name: "整理问题材料", exact: true }).click();
		const materials = dialog("整理问题材料");
		await materials.waitFor({ state: "visible" });
		await setting(materials, "你想厘清的问题").locator("textarea").fill("为什么从统一提醒调整为分级处理？");
		await setting(materials, "关键词与同义词").locator("input").fill("统一提醒");
		await materials.getByRole("button", { name: "查找材料", exact: true }).click();
		await materials.locator(".echo-notes-evidence-item").first().waitFor({ state: "visible" });
		await materials.locator(".echo-notes-evidence-item details > summary").first().click();
		await materials.getByRole("button", { name: "固定纳入", exact: true }).first().click();
		await page.waitForFunction((type) => {
			const materials = window.app.workspace.getLeavesOfType(type)[0]?.view.materials;
			return materials?.query.pinnedEvidenceIds.length > 0 && materials.previewQuery === JSON.stringify(materials.query);
		}, VIEW_TYPE);
		const selected = await page.evaluate((type) => {
			const view = window.app.workspace.getLeavesOfType(type)[0].view;
			return { projectIds: view.state.projectIds, tags: view.state.tags, search: view.state.search, question: view.materials.query.question, pins: view.materials.query.pinnedEvidenceIds, count: view.materials.result?.selectedItems.length };
		}, VIEW_TYPE);
		await closeDialog("整理问题材料");
		await workspace().getByRole("tab", { name: "C 项目工作台", exact: true }).click();
		const switched = await page.evaluate((type) => {
			const view = window.app.workspace.getLeavesOfType(type)[0].view;
			return { projectIds: view.state.projectIds, tags: view.state.tags, search: view.state.search, question: view.materials.query.question, pins: view.materials.query.pinnedEvidenceIds, count: view.materials.result?.selectedItems.length };
		}, VIEW_TYPE);
		assert.deepEqual(switched, selected, "B/C 模式切换丢失筛选或问题选材");
		assert((await workspace().locator(".echo-notes-workspace-material-bar").innerText()).includes(`${selected.count} 段已选原文`));
		report.functional.modeSwitchPreservesFiltersAndMaterials = true;

		await workspace().getByRole("tab", { name: "C 项目工作台", exact: true }).focus();
		await page.keyboard.press("Home");
		assert.equal(await workspace().getByRole("tab", { name: "B 日期阅读器", exact: true }).getAttribute("aria-selected"), "true", "模式 Tab Home 失效");
		await page.keyboard.press("End");
		assert.equal(await workspace().getByRole("tab", { name: "C 项目工作台", exact: true }).getAttribute("aria-selected"), "true", "模式 Tab End 失效");
		report.functional.modeKeyboardNavigation = true;

		for (const mode of ["reader", "projects"]) {
			await workspace().getByRole("tab", { name: mode === "reader" ? "B 日期阅读器" : "C 项目工作台", exact: true }).click();
			for (const viewport of viewports) {
				for (const theme of ["light", "dark"]) {
					await setViewportMode(page, viewport, theme);
					// Re-establish list visibility after a previously selected narrow-screen detail.
					await page.evaluate((type) => { const view = window.app.workspace.getLeavesOfType(type)[0].view; view.state.mobileDetail = false; view.render(); }, VIEW_TYPE);
					const metrics = await workspace().evaluate((element) => {
						const visible = (target) => { const r = target.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(target).visibility !== "hidden"; };
						const targets = [...element.querySelectorAll("button,input,select,summary")].filter(visible);
						const rect = element.getBoundingClientRect();
						return { width: rect.width, left: rect.left, right: rect.right, viewport: innerWidth, overflow: element.scrollWidth - element.clientWidth,
							unnamedButtons: [...element.querySelectorAll("button")].filter((button) => visible(button) && !(button.textContent?.trim() || button.getAttribute("aria-label"))).length,
							minimumTargetHeight: Math.min(...targets.map((target) => target.getBoundingClientRect().height)),
							mode: element.classList.contains("is-projects-mode") ? "projects" : "reader" };
					});
					const context = `workspace/${mode}/${viewport.name}/${theme}`;
					assert(metrics.width > 0 && metrics.overflow <= 1, `${context} 内容横向溢出 ${JSON.stringify(metrics)}`);
					assert(metrics.left >= -1 && metrics.right <= metrics.viewport + 1, `${context} 工作区越出窗口 ${JSON.stringify(metrics)}`);
					assert.equal(metrics.unnamedButtons, 0, `${context} 存在未命名按钮`);
					if (viewport.width === 375) assert(metrics.minimumTargetHeight >= 44, `${context} 触控目标不足44px ${JSON.stringify(metrics)}`);
					const fileName = `workspace-${mode}-${viewport.name}-${theme}.png`;
					await workspace().screenshot({ path: path.join(outputDir, fileName) });
					report.layouts.push({ mode, viewport: viewport.name, theme, fileName, metrics });
				}
			}
		}
		await setViewportMode(page, viewports[0], "light");
		await workspace().locator(".echo-notes-workspace-material-bar").getByRole("button", { name: "整理问题材料", exact: true }).click();
		await materials.getByRole("button", { name: "保存问题", exact: true }).click();
		await waitUntil(() => page.evaluate(async (id) => (await window.app.plugins.plugins[id].meetingWorkspace.questions()).length === 1, pluginId), "问题未保存");
		await materials.getByRole("button", { name: "核验并导出 Markdown", exact: true }).click();
		await waitUntil(async () => page.evaluate(async (id) => {
			const catalog = window.app.plugins.plugins[id].meetingWorkspace.catalog;
			return (await catalog.storage.list(catalog.paths.evidenceDir)).some((name) => name.endsWith(".md"));
		}, pluginId), "证据包未生成，请检查材料核验错误");
		const exported = await page.evaluate(async ({ id, fixtureKey }) => {
			const catalog = window.app.plugins.plugins[id].meetingWorkspace.catalog;
			const names = (await catalog.storage.list(catalog.paths.evidenceDir)).filter((name) => name.endsWith(".md"));
			const content = await catalog.storage.read(names[0]);
			const questions = await window.app.plugins.plugins[id].meetingWorkspace.questions();
			const fixture = window[fixtureKey];
			const sourcesUnchanged = (await Promise.all(fixture.sources.map(async (source) => (await catalog.storage.read(source.path)) === source.content))).every(Boolean);
			return { content, question: questions[0]?.query.question, sourcesUnchanged, retainedWorkspaceLeaf: window.app.workspace.getLeavesOfType("echo-notes-meeting-workspace").length > 0 };
		}, { id: pluginId, fixtureKey: FIXTURE_KEY });
		assert(exported.content.includes("统一提醒数量过多") && exported.content.includes("UTF-16") && exported.content.includes("sha256"), "导出未包含真实原文、范围和来源版本");
		assert.equal(exported.question, "为什么从统一提醒调整为分级处理？");
		assert(exported.sourcesUnchanged, "浏览、选材或导出修改了转写来源");
		assert(exported.retainedWorkspaceLeaf, "打开导出结果替换了会议工作区并丢失返回入口");
		report.functional.questionAndStandaloneMarkdown = true;
		await closeDialog("整理问题材料");

		await page.evaluate(async (id) => {
			const app = window.app;
			const plugin = app.plugins.plugins[id];
			plugin.settings.meetingWorkspaceMode = "projects";
			await plugin.saveSettings();
			app.workspace.detachLeavesOfType("echo-notes-meeting-workspace");
			await app.plugins.disablePlugin(id);
			await app.plugins.enablePluginAndSave(id);
			await app.plugins.plugins[id].activateMeetingWorkspace();
		}, pluginId);
		await waitWorkspace();
		assert.equal(await workspace().getByRole("tab", { name: "C 项目工作台", exact: true }).getAttribute("aria-selected"), "true", "插件真实启停后未恢复模式偏好");
		report.functional.persistedModeAfterRealPluginReload = true;
		report.functional.onlyConstructedFixtureVault = prepared.root;
		return report;
	} finally {
		await page.evaluate(async ({ id, fixtureKey }) => {
			const fixture = window[fixtureKey];
			if (!fixture) return;
			const app = window.app;
			for (const modal of [...document.querySelectorAll(".modal-container")]) {
				const close = modal.querySelector(".modal-close-button");
				if (close) close.click();
			}
			app.workspace.detachLeavesOfType("echo-notes-meeting-workspace");
			if (!app.plugins.plugins[id]) await app.plugins.enablePluginAndSave(id);
			const plugin = app.plugins.plugins[id];
			plugin.settings = fixture.original.settings;
			await plugin.saveSettings();
			const folder = app.vault.getAbstractFileByPath(fixture.root);
			if (folder) await app.vault.delete(folder, true);
			if (fixture.original.activeLeaf?.parent) app.workspace.setActiveLeaf(fixture.original.activeLeaf, { focus: true });
			if (fixture.original.leftCollapsed === false) app.workspace.leftSplit?.expand();
			if (fixture.original.rightCollapsed === false) app.workspace.rightSplit?.expand();
			for (const name of ["theme-light", "theme-dark", "echo-notes-verify-mobile-shell"]) document.body.classList.toggle(name, fixture.original.bodyClasses.includes(name));
			if (fixture.original.settingsOpen) { app.setting.open(); await app.setting.openTabById(id); }
			delete window[fixtureKey];
		}, { id: pluginId, fixtureKey: FIXTURE_KEY });
		if (originalViewport) await page.setViewportSize(originalViewport);
	}
}

import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, chmod, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Real renderer and filesystem fixtures; no fixture script is ever executed. */
export async function verifyAsrDiscovery(page, helpers) {
	const { block, setValue, open, setEnabled, readProfiles, saved, pluginId, outputDir } = helpers;
	const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), "echo-asr-discovery-ui-")));
	const install = path.join(fixture, "中文 ' 安装 A");
	const second = path.join(fixture, "install-b");
	const unknown = path.join(fixture, "unknown");
	for (const dir of [install, second]) {
		await mkdir(path.join(dir, ".venv/bin"), { recursive: true });
		for (const name of ["start.sh", "stop.sh", "control.py"]) await copyFile(path.join(import.meta.dirname, "../integrations/local-mlx-asr", name), path.join(dir, name));
		await writeFile(path.join(dir, "service.py"), "# Isolated fixture, never executed\n");
		await writeFile(path.join(dir, ".venv/bin/python"), "fixture interpreter, never executed"); await chmod(path.join(dir, ".venv/bin/python"), 0o755);
	}
	await mkdir(unknown); await writeFile(path.join(unknown, "start.sh"), "echo never-execute > marker\n");
	await writeFile(path.join(unknown, "README.md"), "# 启动\n```sh\npython -m example_asr.server\n```\n");
	const directory = () => block().locator("#echo-notes-asr-directory");
	const message = () => block().locator(".echo-notes-asr-results > [role=status]");
	const scan = async dir => {
		await directory().fill(dir); await block().getByRole("button", { name: "识别此目录", exact: true }).click();
		await block().getByRole("button", { name: "取消识别", exact: true }).waitFor({ state: "hidden" });
	};
	const confirm = () => page.locator(".echo-notes-asr-confirm-modal");
	const preview = () => block().locator(".echo-notes-asr-preview-apply");
	const confirmChecks = async () => { for (const input of await confirm().locator('input[type="checkbox"]').all()) await input.check(); };
	try {
		await open();
		const profilesBeforeBrowse = JSON.stringify(await readProfiles());
		await directory().fill(install);
		await block().getByRole("button", { name: "选择目录…", exact: true }).click();
		const browser = page.locator(".echo-notes-asr-directory-modal");
		await browser.getByText("可继续打开子目录，或选择当前位置。", { exact: true }).waitFor();
		await browser.getByRole("button", { name: "上一级", exact: true }).press("Enter");
		await page.waitForFunction(dir => document.querySelector('.echo-notes-asr-directory-modal input')?.value === dir, fixture);
		await browser.getByRole("button", { name: `▸ ${path.basename(install)}`, exact: true }).press("Enter");
		await page.waitForFunction(dir => document.querySelector('.echo-notes-asr-directory-modal input')?.value === dir, install);
		await browser.getByRole("button", { name: "选择此目录", exact: true }).press("Enter");
		await browser.waitFor({ state: "hidden" });
		assert.equal(await directory().inputValue(), install);
		assert.match(await message().textContent(), /指定目录/);
		assert.equal(JSON.stringify(await readProfiles()), profilesBeforeBrowse, "浏览目录不应写入配置");
		await scan(install);
		assert.match(await block().locator(".echo-notes-asr-candidate-preview").textContent(), /--port 29181/);
		const beforePreview = JSON.stringify(await readProfiles());
		await preview().click(); await confirm().waitFor();
		assert.equal(JSON.stringify(await readProfiles()), beforePreview, "候选预览不应写入配置");
		assert.equal(await confirm().getByRole("button", { name: "确认填入", exact: true }).isEnabled(), false);
		await confirmChecks(); await confirm().getByRole("button", { name: "确认填入", exact: true }).click();
		await confirm().waitFor({ state: "hidden" });
		assert.equal((await saved()).enabled, false);
		assert.equal((await saved()).workingDirectory, install);
		assert.match((await saved()).startCommand, /'\\''/);
		await setEnabled(true);
		await page.locator(".modal.mod-settings").screenshot({ path: path.join(outputDir, "settings-local-asr-discovery-applied.png") });

		// A real storage write error must preserve both the profile map and rendered values.
		await preview().click(); await confirmChecks(); const beforeFailure = JSON.stringify(await readProfiles());
		await page.evaluate(() => { window.__echoDiscoverySave = window.app.saveLocalStorage; window.app.saveLocalStorage = () => { throw new Error("synthetic private write failure"); }; });
		try {
			await confirm().getByRole("button", { name: "确认填入", exact: true }).click();
			assert.match(await confirm().locator('[role="alert"]').textContent(), /已保留/);
			assert.equal(JSON.stringify(await readProfiles()), beforeFailure);
		} finally { await page.evaluate(() => { window.app.saveLocalStorage = window.__echoDiscoverySave; delete window.__echoDiscoverySave; }); }
		await confirm().getByRole("button", { name: "取消", exact: true }).click();

		// Multiple installations require a deliberate candidate selection.
		await scan(fixture); assert.equal(await block().locator('.echo-notes-asr-candidate input:checked').count(), 0);
		assert.equal(await preview().count(), 0);
		await block().locator(".echo-notes-asr-candidate").filter({ hasText: second }).locator("input").check();
		assert.match(await block().locator(".echo-notes-asr-candidate-preview").textContent(), /install-b/);

		// Explicit synchronous cancel proves a late filesystem completion cannot replace the result.
		await directory().fill(install);
		await block().evaluate(el => {
			[...el.querySelectorAll('button')].find(button => button.textContent === "识别此目录").click();
			[...el.querySelectorAll('button')].find(button => button.textContent === "取消识别").click();
		});
		await page.waitForTimeout(100); assert.match(await message().textContent(), /已取消/);
		await scan(path.join(fixture, "does-not-exist")); assert.match(await message().textContent(), /路径与权限/);

		await setEnabled(false); // Retain the old stop command to prove an incomplete candidate clears it.
		assert.ok((await saved()).stopCommand);
		await scan(unknown); assert.match(await block().locator(".echo-notes-asr-candidate-preview").textContent(), /需要补充/);
		await preview().click(); await confirmChecks(); await confirm().getByRole("button", { name: "确认填入", exact: true }).click();
		await confirm().waitFor({ state: "hidden" });
		assert.equal((await saved()).stopCommand, "");
		await block().locator('.checkbox-container input').evaluate(el => el.click());
		assert.equal(await block().locator('.checkbox-container').getAttribute('aria-checked'), "false");
		assert.equal((await saved()).enabled, false);

		// Navigation cancels the actual mounted scanner; applying a stale candidate is impossible.
		await directory().fill(install);
		await page.evaluate(id => {
			const el = document.querySelector('.echo-notes-asr-discovery');
			[...el.querySelectorAll('button')].find(button => button.textContent === "识别此目录").click();
			window.app.plugins.plugins[id].settingTab.showDestination("transcription-service");
		}, pluginId);
		assert.equal(await page.locator('.echo-notes-local-asr-jump').count(), 1);
		assert.equal(await page.locator('.echo-notes-settings-section-panel[id$="-transcription-service"] .echo-notes-local-asr-service-block').count(), 0);
		await open();
		assert.equal(await directory().inputValue(), install);
		// Changing provider removes both the service-page entry and the sixth capability.
		const profilesBeforeProvider = JSON.stringify(await readProfiles());
		await page.evaluate(id => {
			const plugin = window.app.plugins.plugins[id];
			plugin.settings.offlineTranscription.provider = "ollama";
			plugin.settingTab.refreshSettings();
		}, pluginId);
		assert.equal(await page.locator('.echo-notes-local-asr-jump').count(), 0);
		assert.equal(await page.locator('[data-capability-tab="local-asr"]').count(), 0);
		assert.equal(await page.locator('[data-capability-tab]').count(), 5);
		await page.evaluate(id => {
			const plugin = window.app.plugins.plugins[id];
			plugin.settings.offlineTranscription.provider = "local-openai-compatible";
			plugin.settingTab.showDestination("transcription-local-asr");
		}, pluginId);
		await open();
		assert.equal(await page.locator('[data-capability-tab]').count(), 6);
		assert.equal(JSON.stringify(await readProfiles()), profilesBeforeProvider);
		await setValue("startCommand", "/opt/isolated-asr/start.sh"); await setValue("stopCommand", "/opt/isolated-asr/stop.sh");
		await setValue("workingDirectory", ""); await setEnabled(true);
		return { staticFixture: true, realRenderer: true, scenarios: ["directory-no-scan", "directory-keyboard-parent-child", "candidate-preview-no-write", "replace-confirmation", "special-path", "apply-disables-management", "storage-failure", "multiple-candidates", "cancel", "bad-path", "partial-config", "navigation", "provider-conditional-entry"] };
	} finally { await rm(fixture, { recursive: true, force: true }); }
}

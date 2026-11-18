import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import path from "node:path";

const v31 = "qwen-audio-3.1-asr-flash-filetrans";
const v30 = "qwen-audio-3.0-asr-flash-filetrans";
const qwen3 = "qwen3-asr-flash";
const longText = "这是隔离测试转写的完整句子。".repeat(110) + "百炼长文本结束标记";
const oldTaskId = "filetrans-original-task";

export async function verifyAliyunUpgrade(page, { pluginId, setViewportMode, viewports, themes, outputDir }) {
	const calls = [];
	let nextTask = 0;
	let origin;
	const server = createServer(async (request, response) => {
		const url = new URL(request.url, origin);
		let body = "";
		for await (const chunk of request) body += chunk.toString();
		const model = url.searchParams.get("model") ?? (request.headers["content-type"]?.startsWith("application/json") && body ? JSON.parse(body).model : undefined);
		calls.push({ path: url.pathname, model, key: request.headers.authorization });
		response.setHeader("Content-Type", "application/json");
		if (url.pathname === "/api/v1/uploads") {
			response.end(JSON.stringify({ data: {
				oss_access_key_id: "fixture", signature: "fixture", policy: "fixture", x_oss_object_acl: "private",
				x_oss_forbid_overwrite: "true", upload_dir: "fixture", upload_host: origin + "/upload"
			} }));
		} else if (url.pathname === "/upload") {
			response.end("{}");
		} else if (url.pathname === "/api/v1/services/audio/asr/transcription") {
			response.end(JSON.stringify({ output: { task_id: "filetrans-new-" + ++nextTask, task_status: "PENDING" } }));
		} else if (url.pathname.startsWith("/api/v1/tasks/")) {
			response.end(JSON.stringify({ output: {
				task_id: path.posix.basename(url.pathname), task_status: "SUCCEEDED",
				results: [{ subtask_status: "SUCCEEDED", transcription_url: origin + "/result" }]
			} }));
		} else if (url.pathname === "/result") {
			response.end(JSON.stringify({ transcripts: [{ text: longText }] }));
		} else if (url.pathname === "/compatible-mode/v1/chat/completions") {
			response.end(JSON.stringify({ choices: [{ message: { content: "旧版兼容转写" } }] }));
		} else {
			response.writeHead(404).end("{}");
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	origin = "http://127.0.0.1:" + server.address().port;
	try {
		await page.evaluate(async ({ pluginId, origin, v30 }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			const fixture = {
				settings: JSON.parse(JSON.stringify(plugin.settings)), tasks: plugin.taskCenter.getTasks(),
				key: plugin.getApiKey, confirm: plugin.confirmTranscriptionUpload, save: plugin.saveSettings,
				files: [], confirmations: []
			};
			window.__echoNotesAliyun = fixture;
			Object.assign(plugin.settings, {
				autoTranscribeOnAudioCreated: false, autoTranscribeOnAudioLink: false, analysisEnabled: false,
				skipExistingTranscript: true, confirmBeforeTranscription: true, aliyunFiletrans31UpgradeNoticeDismissed: false
			});
			Object.assign(plugin.settings.offlineTranscription, {
				provider: "aliyun-bailian", model: v30, baseUrl: origin, language: "zh",
				aliyunFiletrans: { diarizationEnabled: false, hotwordEnhancementEnabled: false, contextEnhancementEnabled: false }
			});
			plugin.getApiKey = () => "isolated-aliyun-key";
			plugin.confirmTranscriptionUpload = async (_file, settings) => {
				fixture.confirmations.push(settings.offlineTranscription.model);
				return true;
			};
			const bytes = new Uint8Array(44);
			bytes.set([82, 73, 70, 70], 0);
			bytes.set([87, 65, 86, 69], 8);
			for (let index = 0; index < 5; index++) {
				fixture.files.push(await window.app.vault.createBinary("aliyun-fixture-" + index + ".wav", bytes.buffer));
			}
			fixture.launch = (indices, options) => {
				fixture.pending = Promise.all(indices.map(index => plugin.processAudioToTranscript(fixture.files[index], undefined, options)));
			};
		}, { pluginId, origin, v30 });
		async function launch(indices, options) {
			await page.evaluate(({ indices, options }) => window.__echoNotesAliyun.launch(indices, options), { indices, options });
		}
		const result = () => page.evaluate(async () => Promise.all((await window.__echoNotesAliyun.pending).map(async item =>
			item ? { path: item.transcriptFile.path, text: await window.app.vault.read(item.transcriptFile) } : null
		)));
		const dialog = page.locator(".echo-notes-aliyun-upgrade-dialog");
		const keep = dialog.getByRole("button", { name: "继续使用旧版", exact: true });
		const change = dialog.getByRole("button", { name: "切换到 3.1 并转写", exact: true });
		const layouts = [];
		await launch([0]);
		await dialog.waitFor();
		assert.match(await dialog.innerText(), /约 0\.79 元\s*\/ 计费小时/);
		assert.match(await dialog.innerText(), /0\.8 元\s*\/ 百万 Token/);
		const info = dialog.getByRole("button", { name: "查看 3.1 模型说明" });
		await info.hover();
		await dialog.getByRole("tooltip").waitFor();
		await page.keyboard.press("Escape");
		await dialog.getByRole("tooltip").waitFor({ state: "hidden" });
		assert.ok(await dialog.isVisible(), "Esc 应优先关闭模型说明");
		for (const theme of themes) {
			for (const viewport of viewports) {
				await setViewportMode(page, viewport, theme);
				const placement = await dialog.locator(".echo-notes-aliyun-model-comparison").evaluate(node => {
					const cards = [...node.children].map(card => card.getBoundingClientRect());
					return { sideBySide: Math.abs(cards[0].top - cards[1].top) < 1, overflow: node.scrollWidth - node.clientWidth };
				});
				assert.equal(placement.sideBySide, viewport.width > 580, viewport.name + " 的模型卡片排列与原型不同");
				assert.ok(placement.overflow <= 1, "模型卡片横向溢出");
				const screenshot = `aliyun-upgrade-${viewport.name}-${theme}.png`;
				await dialog.screenshot({ path: path.join(outputDir, screenshot) });
				layouts.push({ viewport: viewport.name, theme, screenshot });
			}
		}
		await setViewportMode(page, viewports[0], "light");
		await page.keyboard.press("Escape");
		assert.deepEqual(await result(), [null]);
		assert.equal(calls.length, 0, "关闭弹窗不能上传");
		await launch([0], { allowUploadConfirmation: false });
		assert.deepEqual(await result(), [null]);
		assert.equal(await dialog.count(), 0, "后台转写不触发升级弹窗");

		await launch([0, 0]);
		await dialog.waitFor();
		assert.equal(await dialog.count(), 1);
		await page.evaluate(({ pluginId, v31 }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			const save = plugin.saveSettings;
			plugin.saveSettings = async () => {
				if (plugin.settings.offlineTranscription.model === v31) {
					plugin.saveSettings = save;
					throw new Error("isolated test save failure");
				}
				await save.call(plugin);
			};
		}, { pluginId, v31 });
		await change.click();
		await dialog.getByText("设置尚未保存，请重试或继续使用旧版。").waitFor();
		assert.equal(await page.evaluate(pluginId => window.app.plugins.plugins[pluginId].settings.offlineTranscription.model, pluginId), v30);
		assert.equal(calls.length, 0, "保存失败不能发起请求");
		await change.click();
		const upgraded = await result();
		assert.ok(upgraded[0]?.text.includes(longText) && upgraded[0].path === upgraded[1]?.path);
		assert.deepEqual(calls.filter(item => item.model).map(item => item.model), [v31, v31]);
		assert.ok(calls.filter(item => item.path === "/upload" || item.path === "/result").every(item => !item.key));
		assert.deepEqual(await page.evaluate(() => window.__echoNotesAliyun.confirmations), [v31]);

		await page.evaluate(({ pluginId, v30 }) => {
			window.app.plugins.plugins[pluginId].settings.offlineTranscription.model = v30;
		}, { pluginId, v30 });
		await launch([1]);
		await keep.click();
		assert.ok((await result())[0]?.text.includes(longText));
		assert.deepEqual(calls.filter(item => item.model).map(item => item.model), [v31, v31, v30, v30]);
		const prior = calls.length;
		await launch([1]);
		assert.ok((await result())[0]);
		assert.equal(await dialog.count(), 0, "已有可复用稿件时不能弹窗");
		assert.equal(calls.length, prior);

		await page.evaluate(async ({ pluginId, v30, v31, origin, oldTaskId }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			const fixture = window.__echoNotesAliyun;
			const audioPath = fixture.files[2].path;
			const recovery = { kind: "transcription", audioPath };
			const remoteTask = { taskId: oldTaskId, origin, status: "RUNNING", submittedAt: Date.now(), configurationFingerprint: "recorded-original" };
			fixture.oldTask = { recovery, remoteTask };
			plugin.taskCenter.upsertTask({ id: "transcription:" + audioPath + ":", kind: "transcription", status: "paused",
				model: v30, title: audioPath, targetPath: audioPath, stage: "待继续", provider: "aliyun-bailian", recovery, remoteTask });
			plugin.settings.offlineTranscription.model = v31;
			await plugin.resumeRemoteTranscriptionTask(recovery, remoteTask);
		}, { pluginId, v30, v31, origin, oldTaskId });
		assert.equal(calls.length, prior, "原模型不匹配时不能轮询");
		await launch([2]);
		assert.deepEqual(await result(), [null], "同音频的未结束任务不能重新提交");
		await page.evaluate(async ({ pluginId, v30 }) => {
			const plugin = window.app.plugins.plugins[pluginId];
			plugin.settings.offlineTranscription.model = v30;
			const { recovery, remoteTask } = window.__echoNotesAliyun.oldTask;
			await plugin.resumeRemoteTranscriptionTask(recovery, remoteTask);
		}, { pluginId, v30 });
		assert.deepEqual(calls.slice(prior).map(item => item.path), ["/api/v1/tasks/" + oldTaskId, "/result"]);

		await page.evaluate(({ pluginId, qwen3 }) => {
			window.app.plugins.plugins[pluginId].settings.offlineTranscription.model = qwen3;
		}, { pluginId, qwen3 });
		await launch([3]);
		await dialog.getByRole("button", { name: "不再提醒，继续使用旧版" }).click();
		assert.ok((await result())[0]?.text.includes("旧版兼容转写"));
		await launch([4]);
		assert.ok((await result())[0]);
		assert.equal(await dialog.count(), 0);
		assert.deepEqual(calls.slice(-2).map(item => [item.path, item.model]), [
			["/compatible-mode/v1/chat/completions", qwen3], ["/compatible-mode/v1/chat/completions", qwen3]
		]);
		return { layouts, routes: [v30, v31, qwen3], preservedOriginalTaskId: true, completeTranscript: true };
	} finally {
		try {
			await page.evaluate(async pluginId => {
				const plugin = window.app.plugins.plugins[pluginId];
				const fixture = window.__echoNotesAliyun;
				if (!fixture) return;
				plugin.aliyunUpgradeModal?.abort();
				plugin.getApiKey = fixture.key;
				plugin.confirmTranscriptionUpload = fixture.confirm;
				plugin.saveSettings = fixture.save;
				plugin.settings = fixture.settings;
				plugin.taskCenter.restoreTasks(fixture.tasks);
				await plugin.saveSettings();
				for (const file of fixture.files) {
					const transcript = plugin.transcriptService.getTranscriptFile(file);
					if (transcript) await window.app.vault.delete(transcript);
					await window.app.vault.delete(file);
				}
				delete window.__echoNotesAliyun;
			}, pluginId);
		} finally {
			await new Promise(resolve => server.close(resolve));
		}
	}
}

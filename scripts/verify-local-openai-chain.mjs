import assert from "node:assert/strict";
import { createServer } from "node:http";

/** Synthetic audio + local standard server, exercised through the actual isolated Obsidian plugin. */
export async function verifyLocalOpenAIChain(page) {
	const calls = [];
	const pending = [];
	const server = createServer((request, response) => {
		let bytes = 0;
		let prefix = Buffer.alloc(0);
		request.on("data", chunk => {
			bytes += chunk.length;
			if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
		});
		request.on("end", () => {
			calls.push({ bytes, declared: Number(request.headers["content-length"]), url: request.url,
				authorization: Boolean(request.headers.authorization), prefix: prefix.toString("utf8") });
			pending.push(() => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ text: "本地长音频完整转写：首、中、尾。" })); });
		});
	});
	await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
	const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
	try {
		await page.evaluate(async baseUrl => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			globalThis.__localOriginalConfig = structuredClone(plugin.settings.offlineTranscription);
			plugin.settings.offlineTranscription = { provider: "local-openai-compatible", baseUrl, model: "fixture-local", language: "auto" };
			plugin.settings.confirmBeforeTranscription = false;
			plugin.settings.analysisEnabled = false;
			await plugin.saveSettings();
			plugin.settings.apiKey = "synthetic-other-provider-secret";
			const bytes = new ArrayBuffer(27 * 1024 * 1024 + 44);
			const view = new DataView(bytes);
			for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]]) for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
			view.setUint32(4, bytes.byteLength - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); view.setUint32(40, bytes.byteLength - 44, true);
			await window.app.vault.createBinary("local-large.wav", bytes);
			await window.app.vault.createBinary("local-cancel.wav", bytes.slice(0, 2048));
			globalThis.__localReadBinary = window.app.vault.readBinary;
			window.app.vault.readBinary = function(file) {
				if (file.path.startsWith("local-")) throw new Error("禁止整文件 readBinary");
				return globalThis.__localReadBinary.call(this, file);
			};
			globalThis.__localRun = plugin.processAudioToTranscript(window.app.vault.getAbstractFileByPath("local-large.wav"), undefined, { forceTranscription: true });
		}, baseUrl);
		await page.waitForFunction(() => window.app.plugins.plugins["echo-notes"].taskCenter.getTasks().some(t => t.targetPath === "local-large.wav" && t.stage === "等待服务返回"), undefined, { timeout: 45000 });
		assert.equal(calls.length, 1);
		assert(calls[0].bytes > 25 * 1024 * 1024);
		assert.equal(calls[0].bytes, calls[0].declared);
		assert.equal(calls[0].url, "/v1/audio/transcriptions");
		assert.equal(calls[0].authorization, false);
		assert.match(calls[0].prefix, /name="model"/);
		pending.shift()();
		const success = await page.evaluate(async () => {
			const result = await globalThis.__localRun;
			const task = window.app.plugins.plugins["echo-notes"].taskCenter.getTasks().find(t => t.targetPath === "local-large.wav");
			return { status: task.status, text: result ? await window.app.vault.read(result.transcriptFile) : "", analysisEligible: result?.analysisEligible };
		});
		assert.equal(success.status, "success");
		assert.equal(success.analysisEligible, true);
		assert.match(success.text, /本地长音频完整转写：首、中、尾/);
		await page.evaluate(() => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			globalThis.__localRun = plugin.processAudioToTranscript(window.app.vault.getAbstractFileByPath("local-cancel.wav"), undefined, { forceTranscription: true });
		});
		await page.waitForFunction(() => window.app.plugins.plugins["echo-notes"].taskCenter.getTasks().some(t => t.targetPath === "local-cancel.wav" && t.stage === "等待服务返回"), undefined, { timeout: 45000 });
		const interrupted = await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			const task = plugin.taskCenter.getTasks().find(t => t.targetPath === "local-cancel.wav");
			await plugin.cancelTaskCenterLocalTask(task.id);
			const result = await globalThis.__localRun;
			return { result, task: plugin.taskCenter.getTask(task.id) };
		});
		pending.shift()();
		assert.equal(interrupted.result, null);
		assert.equal(interrupted.task.status, "failed");
		assert.match(interrupted.task.error, /结果未知/);
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			delete plugin.settings.apiKey;
			window.app.vault.readBinary = globalThis.__localReadBinary;
			await plugin.persistPersistentState();
			await window.app.plugins.disablePlugin("echo-notes");
			await window.app.plugins.enablePluginAndSave("echo-notes");
		});
		await page.waitForTimeout(500);
		assert.equal(calls.length, 2, "标准接口重载不得自动重复提交");
		await page.evaluate(async () => {
			const plugin = window.app.plugins.plugins["echo-notes"];
			plugin.settings.offlineTranscription = globalThis.__localOriginalConfig;
			await plugin.saveSettings();
		});
		return { largeFileBytes: 27 * 1024 * 1024 + 44, requests: calls.length, exactContentLength: true, noWholeFileRead: true, optionalIsolatedKey: true, waitingStage: true, interruptUnknown: true, reloadNoResubmit: true };
	} catch (error) {
		console.error("本地链路任务快照", await page.evaluate(() => window.app.plugins.plugins["echo-notes"]?.taskCenter.getTasks().filter(t => t.targetPath.startsWith("local-"))));
		console.error("本地链路请求数", calls.length);
		throw error;
	} finally {
		server.closeAllConnections();
		await new Promise(resolve => server.close(resolve));
	}
}

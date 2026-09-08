import assert from "node:assert/strict";
import path from "node:path";

export async function verifyRecordingStorageSettings(page, helpers) {
	const { pluginId, getActiveSetting, selectSettingOption, getActivePanel,
		setViewportMode, viewports, themes, outputDir } = helpers;
	await page.evaluate(async (id) => {
		window.app.setting.open();
		await window.app.setting.openTabById(id);
	}, pluginId);
	const original = await page.evaluate((id) => {
		const plugin = window.app.plugins.plugins[id];
		return {
			storage: { ...plugin.settings.recordingStorage }, mode: plugin.settings.transcriptionMode,
			stage: plugin.settingTab.activeSettingsStage, section: plugin.settingTab.activeTranscriptionSettingsSection
		};
	}, pluginId);
	const showOutput = async () => {
		await page.locator('[data-settings-stage="transcription"]').click();
		await getActivePanel(page).getByRole("tab", { name: "输出规则", exact: true }).click();
	};
	const layouts = [];
	try {
		await showOutput();
		await selectSettingOption(page, "录音存放位置", "obsidian");
		assert.equal(await getActivePanel(page).getByRole("textbox", { name: "录音固定目录", exact: true }).count(), 0);
		await selectSettingOption(page, "录音存放位置", "same-folder");
		assert.equal(await getActivePanel(page).getByRole("textbox", { name: "录音子目录", exact: true }).count(), 0);
		await selectSettingOption(page, "录音存放位置", "note-subfolder");
		const subfolder = getActivePanel(page).getByRole("textbox", { name: "录音子目录", exact: true });
		await subfolder.fill("会议资料/原始录音");
		await subfolder.press("Enter");
		await page.waitForFunction(async (id) => (await window.app.plugins.plugins[id].loadData()).recordingStorage.subfolder === "会议资料/原始录音", pluginId);
		await selectSettingOption(page, "录音存放位置", "custom-folder");
		const fixed = getActivePanel(page).getByRole("textbox", { name: "录音固定目录", exact: true });
		for (const invalid of ["", "../库外", "/tmp/录音", "https://example.com/audio", "附件/../录音", "附件/非法:目录"]) {
			await fixed.fill(invalid);
			await fixed.press("Enter");
			assert.equal(await fixed.getAttribute("aria-invalid"), "true", `未拒绝非法录音目录：${invalid}`);
			assert.equal(await page.evaluate((id) => window.app.plugins.plugins[id].settings.recordingStorage.customFolder, pluginId), "Recordings");
			assert(await getActivePanel(page).locator(".echo-notes-recording-storage-error").isVisible());
		}
		await fixed.fill("资料附件/会议录音与讨论记录");
		await fixed.press("Tab");
		await page.waitForFunction(async (id) => (await window.app.plugins.plugins[id].loadData()).recordingStorage.customFolder === "资料附件/会议录音与讨论记录", pluginId);
		await page.evaluate(async (id) => {
			window.app.setting.close();
			window.app.setting.open();
			await window.app.setting.openTabById(id);
		}, pluginId);
		await showOutput();
		assert.equal(await (await getActiveSetting(page, "录音存放位置")).locator("select:not(.is-measuring)").inputValue(), "custom-folder");
		assert.equal(await getActivePanel(page).getByRole("textbox", { name: "录音固定目录", exact: true }).inputValue(), "资料附件/会议录音与讨论记录");
		for (const mode of ["realtime", "offline"]) {
			await selectSettingOption(page, "转写模式", mode);
			assert(await (await getActiveSetting(page, "录音存放位置")).isVisible(), `${mode} 模式缺少录音配置`);
		}
		for (const viewport of viewports) {
			for (const theme of themes) {
				await setViewportMode(page, viewport, theme);
				await (await getActiveSetting(page, "录音存放位置")).scrollIntoViewIfNeeded();
				const metrics = await page.evaluate(() => {
					const panel = document.querySelector('.echo-notes-settings-section-panel:not([hidden])');
					const input = document.querySelector('input[aria-label="录音固定目录"]');
					return {
						documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
						panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : Infinity,
						inputHeight: input?.getBoundingClientRect().height ?? 0
					};
				});
				assert(metrics.documentOverflow <= 1 && metrics.panelOverflow <= 1, `录音输出设置溢出：${JSON.stringify(metrics)}`);
				if (viewport.mobileShell) assert(metrics.inputHeight >= 44, "录音目录输入框移动触控高度不足");
				const screenshot = `settings-recording-storage-${viewport.name}-${theme}.png`;
				await page.screenshot({ path: path.join(outputDir, screenshot) });
				layouts.push({ viewport: viewport.name, theme, screenshot, ...metrics });
			}
		}
	} finally {
		await page.evaluate(async ({ id, original }) => {
			const plugin = window.app.plugins.plugins[id];
			plugin.settings.recordingStorage = original.storage;
			plugin.settings.transcriptionMode = original.mode;
			plugin.settingTab.activeSettingsStage = original.stage;
			plugin.settingTab.activeTranscriptionSettingsSection = original.section;
			await plugin.saveSettings();
			plugin.settingTab.display();
		}, { id: pluginId, original });
		await setViewportMode(page, viewports[0], "light");
	}
	return layouts;
}

export async function verifyCoreRecordingStorage(page, pluginId) {
	const integration = await page.evaluate(async (id) => {
		const app = window.app;
		const plugin = app.plugins.plugins[id];
		app.setting.close();
		const root = "录音存储隔离验收";
		const ensureFolder = async (folder) => {
			let current = "";
			for (const segment of folder.split("/")) {
				current = current ? `${current}/${segment}` : segment;
				if (!app.vault.getAbstractFileByPath(current)) await app.vault.createFolder(current);
			}
		};
		const check = (condition, message) => { if (!condition) throw new Error(message); };
		const linksTo = (note, audio) => {
			const cache = app.metadataCache.getFileCache(note);
			return [...(cache?.embeds ?? []), ...(cache?.links ?? [])].some((link) =>
				app.metadataCache.getFirstLinkpathDest(link.link, note.path)?.path === audio.path
			);
		};
		const waitFor = async (predicate, message) => {
			const deadline = Date.now() + 8000;
			while (Date.now() < deadline) {
				if (await predicate()) return;
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			throw new Error(message);
		};
		const nativeSettings = {
			attachmentFolderPath: app.vault.getConfig("attachmentFolderPath")
		};
		const settings = {
			recordingStorage: { ...plugin.settings.recordingStorage },
			realtimeTranscription: { ...plugin.settings.realtimeTranscription },
			transcriptionMode: plugin.settings.transcriptionMode,
			analysisEnabled: plugin.settings.analysisEnabled,
			autoTranscribeOnAudioCreated: plugin.settings.autoTranscribeOnAudioCreated,
			autoTranscribeOnAudioLink: plugin.settings.autoTranscribeOnAudioLink
		};
		const originalProcess = plugin.processAudioToTranscript;
		const originalGetApiKey = plugin.getApiKey;
		const https = window.require("node:https");
		const originalHttpsRequest = https.request;
		let redirectedRealtimeRequests = 0;
		const getUserMedia = navigator.mediaDevices.getUserMedia;
		const captured = [];
		const automaticPaths = [];
		const contexts = [];
		let microphoneRequests = 0;
		const permissionMethods = [];
		const createRef = app.vault.on("create", (file) => {
			if (["webm", "m4a", "wav"].includes(file.extension)) captured.push(file);
		});
		const results = [];
		let activeRecorder;
		const getRecorder = () => app.internalPlugins.getEnabledPluginById("audio-recorder");
		const waitForAdapter = async () => {
			await waitFor(() => {
				const recorder = getRecorder();
				return recorder && recorder.saveRecording !== Object.getPrototypeOf(recorder).saveRecording;
			}, "核心录音存储适配器未绑定");
			activeRecorder = getRecorder();
		};
		const createSilentWav = () => {
			const data = new ArrayBuffer(44 + 6400);
			const view = new DataView(data);
			const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
			text(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt ");
			view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
			view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true);
			view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 6400, true);
			return data;
		};
		try {
			await ensureFolder(`${root}/笔记甲`);
			await ensureFolder(`${root}/笔记乙`);
			await ensureFolder(`${root}/原生附件`);
			const noteA = await app.vault.create(`${root}/笔记甲/会议.md`, "# 合成录音验收甲\n");
			const noteB = await app.vault.create(`${root}/笔记乙/会议.md`, "# 合成录音验收乙\n");
			app.vault.setConfig("attachmentFolderPath", `${root}/原生附件`);
			plugin.settings.autoTranscribeOnAudioCreated = true;
			plugin.settings.autoTranscribeOnAudioLink = false;
			plugin.processAudioToTranscript = async (file) => {
				automaticPaths.push(file.path);
				return null;
			};
			await plugin.ensureOfficialAudioRecorderEnabled();
			await waitForAdapter();
			const saveDirect = async (storage, note, expectedFolder) => {
				plugin.settings.recordingStorage = { subfolder: "录音/原声", customFolder: `${root}/固定录音`, ...storage };
				if (note) await app.workspace.getLeaf(false).openFile(note);
				else {
					await app.workspace.getLeaf(false).setViewState({ type: "empty" });
					check(!app.workspace.getActiveFile(), "无笔记测试仍存在活动文件");
				}
				const before = captured.length;
				activeRecorder.extension = "wav";
				await activeRecorder.saveRecording(createSilentWav());
				await waitFor(() => captured.length > before, "核心录音未创建文件");
				check(captured.length === before + 1, "单次录音创建了多个文件");
				const audio = captured.at(-1);
				check(audio.parent.path === expectedFolder, `录音位置不符：${audio.path}，期望 ${expectedFolder}`);
				check((await app.vault.readBinary(audio)).byteLength === 6444, "保存后的合成 WAV 字节不完整");
				if (note) {
					await waitFor(() => linksTo(note, audio), `来源笔记缺少可解析录音链接：${audio.path}`);
				} else check(app.workspace.getActiveFile()?.path === audio.path, "无来源笔记时未打开录音");
				await waitFor(() => automaticPaths.includes(audio.path), "自动转写未使用最终录音路径");
				results.push({ scenario: storage.strategy, path: audio.path, linked: Boolean(note), bytes: 6444 });
				return audio;
			};
			await saveDirect({ strategy: "obsidian" }, noteA, `${root}/原生附件`);
			await saveDirect({ strategy: "same-folder" }, noteB, `${root}/笔记乙`);
			await saveDirect({ strategy: "note-subfolder" }, noteA, `${root}/笔记甲/录音/原声`);
			await saveDirect({ strategy: "custom-folder" }, noteA, `${root}/固定录音`);
			await saveDirect({ strategy: "custom-folder", customFolder: "." }, noteA, "/");
			await saveDirect({ strategy: "same-folder" }, null, "/");
			await saveDirect({ strategy: "note-subfolder", subfolder: `${root}/无笔记录音` }, null, `${root}/无笔记录音`);
			await app.vault.create(`${root}/被文件占用`, "目录冲突测试");
			await saveDirect({ strategy: "custom-folder", customFolder: `${root}/被文件占用/录音` }, noteA, `${root}/原生附件`);
			check(app.vault.getConfig("attachmentFolderPath") === `${root}/原生附件`, "录音配置意外修改了全局附件目录");

			// 替换音频来源为本机合成流，保留宿主 MediaRecorder 与核心开始/停止保存链。
			navigator.mediaDevices.getUserMedia = async () => {
				microphoneRequests += 1;
				const context = new AudioContext();
				const oscillator = context.createOscillator();
				const destination = context.createMediaStreamDestination();
				oscillator.connect(destination);
				oscillator.start();
				await context.resume();
				contexts.push({ context, oscillator });
				return destination.stream;
			};
			for (const route of ["命令", "快捷键", "麦克风按钮"]) {
				plugin.settings.recordingStorage = { strategy: "note-subfolder", subfolder: `入口验收/${route}`, customFolder: "Recordings" };
				await app.workspace.getLeaf(false).openFile(noteA);
				const before = captured.length;
				if (route === "麦克风按钮") {
					permissionMethods.push([activeRecorder, activeRecorder.checkPermission]);
					activeRecorder.checkPermission = async () => true;
					activeRecorder.plugin.addedButtonEls[0].click();
				} else if (route === "快捷键") {
					// 快捷键分发最终调用同一个已注册 checkCallback，不更改用户热键配置。
					check(app.commands.commands["audio-recorder:start"].checkCallback(false), "快捷键开始命令不可用");
				} else check(app.commands.executeCommandById("audio-recorder:start"), "开始命令不可用");
				await waitFor(() => activeRecorder.recording, `${route} 未开始录音`);
				await new Promise((resolve) => setTimeout(resolve, 180));
				await app.workspace.getLeaf(false).openFile(noteB);
				if (route === "麦克风按钮") activeRecorder.plugin.addedButtonEls[0].click();
				else if (route === "快捷键") check(app.commands.commands["audio-recorder:stop"].checkCallback(false), "快捷键停止命令不可用");
				else check(app.commands.executeCommandById("audio-recorder:stop"), "停止命令不可用");
				await waitFor(() => captured.length > before, `${route} 未保存录音`);
				const audio = captured.at(-1);
				await waitFor(() => linksTo(noteB, audio), "保存时笔记未收到可解析音频链接");
				check(audio.parent.path === `${root}/笔记乙/入口验收/${route}`, "切换笔记后核心录音未按保存时笔记归档");
				check((await app.vault.readBinary(audio)).byteLength > 0, "核心录音保存了空文件");
				check(!linksTo(noteA, audio), "核心录音误回链开始时笔记");
				results.push({ scenario: `核心${route}合成音频`, path: audio.path });
			}

			plugin.settings.transcriptionMode = "realtime";
			plugin.settings.autoTranscribeOnAudioLink = true;
			plugin.settings.analysisEnabled = false;
			plugin.settings.realtimeTranscription = {
				...plugin.settings.realtimeTranscription,
				provider: "volcengine-agentplan", model: "doubao-seed-asr-2.0", language: "zh", inputDeviceId: "",
				baseUrl: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async"
			};
			// 只在隔离进程替换传输层，保留真实配置预检；请求全部重定向到本机关闭端口。
			https.request = function (options, ...rest) {
				check(options.host === "openspeech.bytedance.com" || options.hostname === "openspeech.bytedance.com", "实时测试出现非预期请求");
				redirectedRealtimeRequests += 1;
				return originalHttpsRequest.call(this, { ...options, host: "127.0.0.1", hostname: "127.0.0.1", port: 1 }, ...rest);
			};
			plugin.getApiKey = () => "isolated-recording-storage-test";
			await app.workspace.getLeaf(false).openFile(noteA);
			plugin.settings.recordingStorage = { strategy: "custom-folder", customFolder: "../禁止目录", subfolder: "Recordings" };
			const beforeInvalid = microphoneRequests;
			await plugin.startRealtimeTranscription();
			check(microphoneRequests === beforeInvalid, "非法目录仍申请了麦克风");
			check(!plugin.activeRealtimeRecording, "非法目录仍启动了实时录音");
			plugin.settings.recordingStorage = { strategy: "note-subfolder", subfolder: "实时录音", customFolder: "Recordings" };
			await plugin.startRealtimeTranscription();
			const realtime = plugin.activeRealtimeRecording;
			check(realtime, "实时合成录音未启动");
			const realtimePath = realtime.audioFile.path;
			const transcriptPath = realtime.transcriptFile.path;
			check(realtime.audioFile.parent.path === `${root}/笔记甲/实时录音`, "实时录音未使用开始时笔记目录");
			check(!automaticPaths.includes(realtimePath), "实时录音创建事件误触发离线自动转写");
			await app.workspace.getLeaf(false).openFile(noteB);
			plugin.settings.recordingStorage = { strategy: "custom-folder", subfolder: "Recordings", customFolder: `${root}/改动后的设置` };
			await plugin.saveSettings();
			await waitFor(() => Boolean(realtime.asrError), "本地 ASR 连接未按预期失败");
			check(redirectedRealtimeRequests === 1, "实时请求未经过本地替身");
			await new Promise((resolve) => setTimeout(resolve, 1300));
			await plugin.handleAutoMarkdownFile(noteA);
			check(!automaticPaths.includes(realtimePath), "实时录音链接修改事件误触发离线转写");
			await plugin.stopRealtimeTranscription();
			check(realtime.audioFile.path === realtimePath && realtime.transcriptFile.path === transcriptPath, "录音中修改配置改变了当前文件路径");
			check((await app.vault.readBinary(realtime.audioFile)).byteLength > 0, "实时录音未保留音频");
			await waitFor(() => linksTo(noteA, realtime.audioFile), "实时录音来源链接不正确");
			check(!linksTo(noteB, realtime.audioFile), "实时录音误写入停止时笔记");
			const task = plugin.taskCenter.getTask(realtime.taskId);
			check(task?.targetPath === realtimePath && task?.outputPath === transcriptPath, "实时任务路径未与文件一致");
			results.push({ scenario: "实时录音目录冻结与 ASR 失败保留", path: realtimePath, transcriptPath });

			const corePlugin = app.internalPlugins.getPluginById("audio-recorder");
			corePlugin.disable(false);
			await waitFor(() => activeRecorder.saveRecording === Object.getPrototypeOf(activeRecorder).saveRecording, "核心停用后适配器未释放");
			await corePlugin.enable(false);
			await waitForAdapter();
			await saveDirect({ strategy: "custom-folder", customFolder: `${root}/重启后录音` }, noteA, `${root}/重启后录音`);
			return { cases: results, automaticPaths, transcriptionStub: true, microphone: "合成流，未使用真实麦克风" };
		} finally {
			if (plugin.activeRealtimeRecording) await plugin.stopRealtimeTranscription();
			if (activeRecorder?.recording) activeRecorder.onStopRecording();
			for (const [recorder, method] of permissionMethods) recorder.checkPermission = method;
			navigator.mediaDevices.getUserMedia = getUserMedia;
			for (const { context, oscillator } of contexts) {
				oscillator.stop();
				await context.close();
			}
			app.vault.offref(createRef);
			for (const [filePath, timer] of plugin.markdownDebounceTimers) {
				if (filePath.startsWith(`${root}/`)) {
					clearTimeout(timer);
					plugin.markdownDebounceTimers.delete(filePath);
				}
			}
			plugin.processAudioToTranscript = originalProcess;
			plugin.getApiKey = originalGetApiKey;
			https.request = originalHttpsRequest;
			Object.assign(plugin.settings, settings);
			app.vault.setConfig("attachmentFolderPath", nativeSettings.attachmentFolderPath);
			await plugin.saveSettings();
		}
	}, pluginId);
	const restored = await page.evaluate(async (id) => {
		const app = window.app;
		const recorder = app.internalPlugins.getEnabledPluginById("audio-recorder");
		const native = Object.getPrototypeOf(recorder).saveRecording;
		await app.plugins.disablePlugin(id);
		const result = recorder.saveRecording === native;
		await app.plugins.enablePlugin(id);
		return result;
	}, pluginId);
	assert(restored, "停用 Echo Notes 后核心录音保存方法未恢复");
	const startupUnload = await page.evaluate(async (id) => {
		const app = window.app;
		const plugin = app.plugins.plugins[id];
		const saved = await plugin.loadData();
		const previousGetUserMedia = navigator.mediaDevices.getUserMedia;
		const context = new AudioContext();
		const stream = context.createMediaStreamDestination().stream;
		let releaseMicrophone;
		let requested = false;
		const pending = new Promise((resolve) => { releaseMicrophone = () => resolve(stream); });
		const created = [];
		const event = app.vault.on("create", (file) => { if (file.extension === "webm") created.push(file.path); });
		let startup;
		try {
			const note = await app.vault.create("录音存储隔离验收/启动时停用.md", "# 启动时停用\n");
			await app.workspace.getLeaf(false).openFile(note);
			plugin.settings.recordingStorage = { strategy: "custom-folder", subfolder: "Recordings", customFolder: "录音存储隔离验收/不应创建" };
			plugin.settings.realtimeTranscription = {
				provider: "volcengine-agentplan", model: "doubao-seed-asr-2.0", language: "zh", inputDeviceId: "",
				baseUrl: "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_async"
			};
			plugin.getApiKey = () => "isolated-delayed-microphone-test";
			navigator.mediaDevices.getUserMedia = () => { requested = true; return pending; };
			startup = plugin.startRealtimeTranscription();
			if (!requested) throw new Error("延迟麦克风场景未进入录音准备阶段");
			await app.plugins.disablePlugin(id);
			releaseMicrophone();
			await startup;
			if (created.length || plugin.activeRealtimeRecording || stream.getTracks().some((track) => track.readyState !== "ended")) {
				throw new Error(`插件停用后继续启动录音：${JSON.stringify({ created, active: Boolean(plugin.activeRealtimeRecording) })}`);
			}
			return { delayedMicrophoneStopped: true, createdFiles: created.length };
		} finally {
			releaseMicrophone();
			await startup;
			navigator.mediaDevices.getUserMedia = previousGetUserMedia;
			stream.getTracks().forEach((track) => track.stop());
			await context.close();
			app.vault.offref(event);
			await plugin.persistenceQueue;
			await plugin.saveData(saved);
			await app.plugins.enablePlugin(id);
		}
	}, pluginId);
	return { ...integration, unloadRestoresNative: restored, startupUnload };
}

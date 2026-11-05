import assert from "node:assert/strict";
import { createServer } from "node:http";

const START = "<!-- echo-notes-recording-summary:start -->";
const END = "<!-- echo-notes-recording-summary:end -->";

export async function verifyRecordingSummary(page, pluginId) {
	const summaries = {
		basic: "新员工销售话术培训与客户沟通模拟对练",
		repeated: "新员工客户需求确认与问题回应话术对练",
		second: "订单交付各环节职责与异常跟进流程核对",
		first: "客户任务流程需求与异常处理方案评审",
		later: "客户任务表单字段与操作状态提示讨论",
		old: "历史订单报表统计口径与数据来源核对",
		newer: "订单缺货取消与补发异常处理职责核对",
		retry: "新员工销售问答与话术衔接表达语气复盘",
		"capture-old": "历史订单报表字段含义与计算方式核对",
		"capture-new": "订单异常处理操作与岗位跟进范围讨论",
		shared: "客户服务需求登记分派与异常跟进流程讨论",
		migration: "新员工销售话术训练与客户沟通流程复盘"
	};
	for (const [key, summary] of Object.entries(summaries)) {
		const characters = Array.from(summary).length;
		assert(characters >= 15 && characters <= 30, `摘要场景 ${key} 长度不在15–30字范围内`);
	}
	const calls = [];
	const completions = [];
	const server = createServer(async (request, response) => {
		try {
			assert.equal(request.method, "POST");
			assert.equal(request.url, "/v1/chat/completions");
			assert.equal(request.headers.authorization, "Bearer isolated-recording-summary-key");
			const chunks = [];
			for await (const chunk of request) chunks.push(chunk);
			const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const system = body.messages?.find((message) => message.role === "system")?.content ?? "";
			const user = body.messages?.find((message) => message.role === "user")?.content ?? "";
			const key = /\[summary-host-case:([a-z-]+)\]/.exec(user)?.[1];
			assert(key, "录音摘要 Mock 请求缺少场景标识");
			assert(system.includes(START) && system.includes(END), "最终分析请求缺少摘要输出契约");
			assert(/15[–-]30/.test(system) && (system.includes("主题") || system.includes("用途")), "摘要提示缺少主题用途或15–30字要求");
			calls.push(key);
			const finish = () => {
				completions.push(key);
				if (key === "failure") {
					response.writeHead(500, { "content-type": "application/json" });
					response.end(JSON.stringify({ error: { message: "isolated summary host failure" } }));
					return;
				}
				const summary = key === "missing" ? "" : `\n\n${START}${summaries[key]}${END}`;
				response.writeHead(200, { "content-type": "application/json", "x-request-id": `summary-host-${calls.length}` });
				response.end(JSON.stringify({ choices: [{ message: { content: `## 合成分析\n\n正文-${key}。${summary}` } }] }));
			};
			if (key === "first" || key === "old" || key === "shared") setTimeout(finish, key === "first" ? 150 : 450);
			else finish();
		} catch (error) {
			response.writeHead(500, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
		}
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object");
	try {
		const integration = await page.evaluate(async ({ id, baseUrl, summaries, start, end }) => {
			const app = window.app;
			const plugin = app.plugins.plugins[id];
			const root = `录音摘要隔离验收-${Date.now()}`;
			const original = {
				settings: plugin.settings,
				getAnalysisApiKey: plugin.getAnalysisApiKey,
				tasks: plugin.taskCenter.getTasks(),
				activeFile: app.workspace.getActiveFile()
			};
			const check = (condition, message) => { if (!condition) throw new Error(message); };
			const waitFor = async (predicate, message) => {
				const deadline = Date.now() + 8000;
				while (Date.now() < deadline) {
					if (await predicate()) return;
					await new Promise((resolve) => setTimeout(resolve, 25));
				}
				throw new Error(message);
			};
			const readNote = async (note) => {
				const editor = app.workspace.getLeavesOfType("markdown")
					.map((leaf) => leaf.view).find((view) => view.file === note)?.editor;
				return editor ? editor.getValue() : app.vault.read(note);
			};
			const template = (key, templateId = key) => ({
				id: `summary-host-${templateId}`, name: `合成摘要-${key}`, version: "1",
				category: "custom", description: "隔离验收", enabled: true, builtin: false,
				systemPrompt: "根据转写生成有依据的简体中文分析。",
				customPrompt: `概括录音内容。[summary-host-case:${key}]`, recognitionKeywords: []
			});
			const tasksFor = (transcript) => plugin.taskCenter.getTasks().filter((task) =>
				task.kind === "analysis" && task.targetPath === transcript.path);
			const checkPlainSummaries = (content, count) => {
				check(!content.includes(start) && !content.includes(end), "来源笔记仍包含摘要HTML标记");
				check(content.split("｜AI 总结：").length - 1 === count, "来源笔记摘要数量异常");
			};
			try {
				plugin.settings = {
					...JSON.parse(JSON.stringify(original.settings)),
					analysisEnabled: true, analysisProvider: "custom-openai-compatible",
					analysisBaseUrl: baseUrl, analysisModel: "isolated-summary-model",
					analysisLongTextEnabled: false, analysisChunkCharacters: 20000,
					redactTranscriptBeforeAnalysis: false, copyLanguage: "zh-CN",
					memoryEnabled: false, memoryInitialized: false,
					autoTranscribeOnAudioCreated: false, autoTranscribeOnAudioLink: false,
					outputStrategy: "same-folder"
				};
				plugin.getAnalysisApiKey = () => "isolated-recording-summary-key";
				plugin.refreshServices();
				app.setting.close();
				await app.vault.createFolder(root);
				const audioA = await app.vault.createBinary(`${root}/培训.wav`, new ArrayBuffer(44));
				const audioB = await app.vault.createBinary(`${root}/项目.wav`, new ArrayBuffer(44));
				const audioC = await app.vault.createBinary(`${root}/无时间.wav`, new ArrayBuffer(44));
				const audioLink = (audio, sourcePath) => `!${app.fileManager.generateMarkdownLink(audio, sourcePath)}`;
				const notePath = `${root}/会议记录.md`;
				const manual = "手写说明原样保留。";
				const note = await app.vault.create(notePath, [
					"# 合成会议记录", `录音时间：08:54–09:16（22分钟）：${manual}`,
					audioLink(audioA, notePath), "", "录音时间：10:00–10:30（30分钟）",
					audioLink(audioB, notePath), "", "其他手写正文。", ""
				].join("\n"));
				const noTimePath = `${root}/无时间记录.md`;
				const noTimeText = `# 没有录音时间\n${audioLink(audioC, noTimePath)}\n手写内容。\n`;
				const noTime = await app.vault.create(noTimePath, noTimeText);
				const source = "本次是新员工销售话术培训。通过模拟客户沟通练习提问顺序、需求确认、话术衔接和表达语气，帮助新人理解实际销售沟通流程。";
				const transcribe = (audio, sourceNote) => plugin.transcriptService.writeSuccessTranscript(audio, sourceNote, {
					text: source, provider: "isolated-host", model: "synthetic-transcript"
				});
				const transcriptA = await transcribe(audioA, note);
				const transcriptB = await transcribe(audioB, note);
				const transcriptC = await transcribe(audioC, noTime);
				await waitFor(async () => (await plugin.transcriptLinkService.captureTranscriptSourceAnchor(transcriptA))?.initialReferenceCount === 1,
					"合成转写来源未被宿主解析");
				await app.workspace.getLeaf(false).openFile(transcriptA);
				await plugin.runAnalysisBatch(transcriptA, [template("basic")]);
				let content = await readNote(note);
				check(content.includes(`${manual}｜AI 总结：${summaries.basic}`), "首轮摘要没有保留手写说明并写入时间行");
				checkPlainSummaries(content, 1);
				check((await app.vault.read(transcriptA)).includes("echo_notes_recording_summary"), "摘要未持久化到转写技术信息");
				check(tasksFor(transcriptA).every((task) => task.status === "success"), "首轮分析未记录为成功");
				const untouchedSecond = content.split("\n").find((line) => line.startsWith("录音时间：10:00"));
				check(untouchedSecond === "录音时间：10:00–10:30（30分钟）", "首轮摘要写入了其他录音");

				await app.workspace.getLeaf(false).openFile(note);
				const noteEditor = app.workspace.getLeavesOfType("markdown").find((leaf) => leaf.view.file === note).view.editor;
				const handwrittenSuffix = "；手写补充保留。";
				const firstTimeLine = noteEditor.getValue().split("\n").findIndex((line) => line.startsWith("录音时间：08:54"));
				noteEditor.replaceRange(handwrittenSuffix, { line: firstTimeLine, ch: noteEditor.getLine(firstTimeLine).length });
				await plugin.runAnalysisBatch(transcriptA, [template("repeated", "basic")]);
				content = await readNote(note);
				check(content.includes(summaries.repeated) && !content.includes(summaries.basic), "重新分析未更新原摘要");
				checkPlainSummaries(content, 1);
				check(content.includes(`${manual}｜AI 总结：${summaries.repeated}${handwrittenSuffix}`), "重新分析改写了摘要前后手写说明");
				await plugin.runAnalysisBatch(transcriptB, [template("second")]);
				content = await readNote(note);
				checkPlainSummaries(content, 2);
				check(content.includes(summaries.repeated) && content.includes(summaries.second), "多录音摘要位置不独立");

				await plugin.runAnalysisBatch(transcriptC, [template("basic", "no-time")]);
				check(await readNote(noTime) === noTimeText, "无录音时间时改写了笔记");
				check(tasksFor(transcriptC).every((task) => task.status === "success"), "无时间行使已保存分析变为失败");
				await plugin.runAnalysisBatch(transcriptA, [template("first"), template("later")]);
				content = await readNote(note);
				check(content.includes(summaries.first) && !content.includes(summaries.later), "多模板按完成顺序而非输入顺序选择摘要");
				const beforeMissing = content;
				await plugin.runAnalysisBatch(transcriptA, [template("missing")]);
				check(await readNote(note) === beforeMissing, "无有效摘要时改变了已有笔记");
				check(tasksFor(transcriptA).find((task) => task.recovery?.templateId === "summary-host-missing")?.status === "success", "无摘要使主分析失败");
				await plugin.runAnalysisBatch(transcriptA, [template("failure"), template("later", "fallback")]);
				check((await readNote(note)).includes(summaries.later), "首模板失败时未采用后续成功摘要");

				const oldBatch = plugin.runAnalysisBatch(transcriptA, [template("old")]);
				await waitFor(() => plugin.taskCenter.getTasks().some((task) =>
					task.recovery?.templateId === "summary-host-old" && task.status === "running"), "旧批次未进入运行态");
				await plugin.runAnalysisBatch(transcriptA, [template("newer")]);
				await oldBatch;
				content = await readNote(note);
				check(content.includes(summaries.newer) && !content.includes(summaries.old), "迟到的旧批次覆盖了新摘要");
				const retryTemplate = template("retry", "basic");
				plugin.settings.analysisTemplates = [retryTemplate];
				await plugin.retryAnalysisTask(transcriptA.path, retryTemplate.id);
				content = await readNote(note);
				check(content.includes(summaries.retry) && !content.includes(summaries.newer), "重试入口没有更新摘要");
				checkPlainSummaries(content, 2);
				check(content.includes("其他手写正文。") && content.includes(handwrittenSuffix), "最终笔记手写正文丢失");

				const sourceLinks = plugin.transcriptLinkService;
				const originalCapture = sourceLinks.captureTranscriptSourceAnchor;
				let releaseCapture;
				let markCaptureStarted;
				const captureGate = new Promise((resolve) => { releaseCapture = resolve; });
				const captureStarted = new Promise((resolve) => { markCaptureStarted = resolve; });
				let captureCalls = 0;
				let delayedCaptureBatch;
				try {
					sourceLinks.captureTranscriptSourceAnchor = async function (file) {
						if (captureCalls++ === 0) {
							markCaptureStarted();
							await captureGate;
						}
						return originalCapture.call(this, file);
					};
					delayedCaptureBatch = plugin.runAnalysisBatch(transcriptA, [template("capture-old")]);
					await captureStarted;
					await plugin.runAnalysisBatch(transcriptA, [template("capture-new")]);
					releaseCapture();
					await delayedCaptureBatch;
					content = await readNote(note);
					check(content.includes(summaries["capture-new"]) && !content.includes(summaries["capture-old"]),
						"来源读取较慢的旧批次覆盖了新摘要");
					for (const key of ["capture-old", "capture-new"]) {
						check(tasksFor(transcriptA).find((task) => task.recovery?.templateId === `summary-host-${key}`)?.status === "success",
							`来源等待期间的 ${key} 主分析未完成`);
					}
				} finally {
					releaseCapture();
					sourceLinks.captureTranscriptSourceAnchor = originalCapture;
					await delayedCaptureBatch;
				}

				const sharedTemplate = template("shared");
				const firstSharedBatch = plugin.runAnalysisBatch(transcriptA, [sharedTemplate]);
				await waitFor(() => plugin.processingAnalyses.has(`${transcriptA.path}:${sharedTemplate.id}`),
					"首个共享分析未登记在途 Promise");
				await Promise.all([firstSharedBatch, plugin.runAnalysisBatch(transcriptA, [sharedTemplate])]);
				check((await readNote(note)).includes(summaries.shared), "共享在途分析没有回写有效摘要");

				const adapter = plugin.coreRecordingStorageAdapter;
				const originalPendingSource = adapter.getPendingSource;
				const originalProcess = plugin.processAudioToTranscript;
				const automaticPath = `${root}/自动来源就绪.wav`;
				const automaticCalls = [];
				let releaseSource;
				let pendingObserved = false;
				const pendingSource = new Promise((resolve) => { releaseSource = resolve; });
				try {
					adapter.getPendingSource = function (audioPath) {
						if (audioPath === automaticPath) {
							pendingObserved = true;
							return pendingSource;
						}
						return originalPendingSource.call(this, audioPath);
					};
					plugin.processAudioToTranscript = async function (audioFile, sourceNote, options) {
						if (audioFile.path === automaticPath) {
							automaticCalls.push(sourceNote);
							return null;
						}
						return originalProcess.call(this, audioFile, sourceNote, options);
					};
					plugin.settings.autoTranscribeOnAudioCreated = true;
					await app.vault.createBinary(automaticPath, new ArrayBuffer(44));
					await waitFor(() => pendingObserved, "自动创建入口未查询来源就绪 Promise");
					check(automaticCalls.length === 0, "自动转写在来源就绪之前启动");
					releaseSource(note);
					await waitFor(() => automaticCalls.length === 1, "来源就绪后自动转写未启动");
					check(automaticCalls[0] === note, "自动转写没有收到来源笔记身份");
				} finally {
					releaseSource(null);
					plugin.settings.autoTranscribeOnAudioCreated = false;
					adapter.getPendingSource = originalPendingSource;
					plugin.processAudioToTranscript = originalProcess;
				}
				const oldLongSummary = "旧版合成摘要记录新员工参加销售话术培训，通过模拟客户沟通核对提问顺序、需求确认、话术衔接和表达语气，帮助新人理解实际销售沟通流程。";
				check(Array.from(oldLongSummary).length > 30, "旧版迁移样例应超过30字");
				const legacyPrefix = "录音时间：10:00–10:30（30分钟）：迁移前手写。";
				const legacySuffix = "迁移后手写。";
				const secondTimeLine = noteEditor.getValue().split("\n").findIndex((line) => line.startsWith("录音时间：10:00"));
				noteEditor.replaceRange(`${legacyPrefix}${start}｜AI 总结：${oldLongSummary}${end}${legacySuffix}`,
					{ line: secondTimeLine, ch: 0 }, { line: secondTimeLine, ch: noteEditor.getLine(secondTimeLine).length });
				await plugin.runAnalysisBatch(transcriptB, [template("migration")]);
				content = await readNote(note);
				checkPlainSummaries(content, 2);
				check(content.includes(`${legacyPrefix}｜AI 总结：${summaries.migration}${legacySuffix}`),
					"旧版标记迁移未保留前后手写文字并替换为短摘要");
				check(!content.includes(oldLongSummary), "旧版长摘要迁移后仍存在");
				return {
					requestToSourceWriteback: true, manualTextPreserved: true, idempotentEditorUpdate: true,
					multipleRecordings: true, missingTimeKeepsAnalysisSuccess: true,
					multiTemplateInputOrder: true, missingSummaryKeepsAnalysisSuccess: true,
					failedTemplateFallback: true, staleBatchCannotOverwrite: true, retryUpdatesSummary: true,
					delayedSourceKeepsBothAnalyses: true, duplicateAnalysisSharesPromise: true,
					automaticCreateWaitsForSource: true, sourceNoteHasNoHtmlMarkers: true,
					shortSummary15To30Characters: true, legacyMarkersMigratedWithManualText: true,
					manualPrefixAndSuffixPreserved: true
				};
			} finally {
				await Promise.allSettled([...plugin.processingAnalyses.values()]);
				for (const leaf of app.workspace.getLeavesOfType("markdown")) {
					if (leaf.view.file?.path.startsWith(`${root}/`)) {
						await leaf.view.save();
						await leaf.setViewState({ type: "empty" });
					}
				}
				const folder = app.vault.getAbstractFileByPath(root);
				if (folder) await app.vault.delete(folder, true);
				plugin.getAnalysisApiKey = original.getAnalysisApiKey;
				plugin.settings = original.settings;
				plugin.taskCenter.restoreTasks(original.tasks);
				plugin.refreshServices();
				await plugin.saveSettings();
				if (original.activeFile && app.vault.getAbstractFileByPath(original.activeFile.path) === original.activeFile) {
					await app.workspace.getLeaf(false).openFile(original.activeFile);
				}
			}
		}, { id: pluginId, baseUrl: `http://127.0.0.1:${address.port}/v1`, summaries, start: START, end: END });
		assert.equal(calls.length, 16, `摘要宿主验收请求次数异常，实际为 ${calls.length}`);
		assert.equal(calls.filter((key) => key === "shared").length, 1, "同模板并发批次发起了重复 HTTP 请求");
		assert(completions.indexOf("later") < completions.indexOf("first"), "多模板 Mock 未产生乱序返回");
		assert(completions.indexOf("newer") < completions.indexOf("old"), "新旧批次 Mock 未产生迟到旧结果");
		return { ...integration, localMockRequests: calls.length, externalRequests: 0 };
	} finally {
		await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	}
}

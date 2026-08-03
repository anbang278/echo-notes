import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { chromium } from "playwright-core";

const projectRoot = process.cwd();
const pluginId = "echo-notes";
const releaseVersion = "0.4.2";
const fixtureFolder = `Echo Notes 验证/${releaseVersion}-真实链路-20260731`;
const sourceRoot = `/Users/anbang/笔记/Develop-obsidian/${fixtureFolder}`;
const obsidianBinary = "/Applications/Obsidian.app/Contents/MacOS/Obsidian";
const obsidianDataDir = path.join(os.homedir(), "Library/Application Support/obsidian");
const siliconFlowProvider = "siliconflow";
const siliconFlowBaseUrl = "https://api.siliconflow.cn";
const siliconFlowModel = "FunAudioLLM/SenseVoiceSmall";
const agentPlanProvider = "volcengine-agentplan";
const agentPlanBaseUrl = "https://ark.cn-beijing.volces.com/api/plan/v3";
const agentPlanModel = "doubao-seed-2.0-lite";
const sourceFiles = [
	"EchoRelease-0815.md",
	"EchoRelease-上线日期-0815.transcript.md",
	"EchoRelease-0822.md",
	"EchoRelease-上线日期-0822.wav"
];

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function findObsidianAsar() {
	const names = await (await import("node:fs/promises")).readdir(obsidianDataDir);
	const candidates = names
			.map((name) => ({ name, match: name.match(/^obsidian-(\d+\.\d+\.\d+)\.asar$/) }))
			.filter((item) => item.match)
			.sort((left, right) => right.match[1].localeCompare(left.match[1], undefined, { numeric: true }));
	assert(candidates.length > 0, "未找到 Obsidian 版本化 ASAR。");
	return { path: path.join(obsidianDataDir, candidates[0].name), version: candidates[0].match[1] };
}

async function reservePort() {
	const server = createServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "无法分配 CDP 端口。");
	const port = address.port;
	await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

async function createProfile(obsidianAsar) {
	const profileDir = await mkdtemp(path.join(os.tmpdir(), "echo-notes-real-chain-"));
	const vault = path.join(profileDir, "vault");
	const pluginDir = path.join(vault, ".obsidian/plugins", pluginId);
	const testDir = path.join(vault, fixtureFolder);
	await mkdir(pluginDir, { recursive: true });
	await mkdir(testDir, { recursive: true });
	await Promise.all([
		copyFile(path.join(projectRoot, "main.js"), path.join(pluginDir, "main.js")),
		copyFile(path.join(projectRoot, "styles.css"), path.join(pluginDir, "styles.css")),
		copyFile(path.join(projectRoot, "manifest.json"), path.join(pluginDir, "manifest.json")),
		...sourceFiles.map((file) => copyFile(path.join(sourceRoot, file), path.join(testDir, file))),
		writeFile(path.join(vault, ".obsidian/community-plugins.json"), `${JSON.stringify([pluginId])}\n`),
		writeFile(path.join(vault, ".obsidian/app.json"), `${JSON.stringify({ promptDelete: false })}\n`)
	]);
	const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
	await writeFile(
		path.join(profileDir, "obsidian.json"),
		`${JSON.stringify({ vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } }, frame: "custom", updateDisabled: true }, null, "\t")}\n`
	);
	await copyFile(obsidianAsar.path, path.join(profileDir, path.basename(obsidianAsar.path)));
	return { profileDir, vault };
}

function launch(profileDir, port) {
	const child = spawn(obsidianBinary, [
		`--user-data-dir=${profileDir}`,
		`--remote-debugging-port=${port}`,
		"--window-size=1280,900",
		"--no-first-run"
	], { cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
	let output = "";
	const capture = (chunk) => { output = `${output}${chunk.toString()}`.slice(-20_000); };
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	return { child, getOutput: () => output };
}

async function waitForPage(port, child) {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`隔离 Obsidian 提前退出：${child.exitCode}`);
		}
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			if (response.ok) {
				const targets = await response.json();
				if (targets.some((target) => target.type === "page" && target.url === "app://obsidian.md/index.html")) {
					return `http://127.0.0.1:${port}`;
				}
			}
		} catch {
			// 启动期间继续轮询。
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error("等待隔离 Obsidian renderer 超时。");
}

async function stopChild(child) {
	if (!child || child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
	if (child.exitCode === null) {
		child.kill("SIGKILL");
		await once(child, "exit");
	}
}

async function main() {
	assert(process.env.SILICONFLOW_API_KEY?.trim(), "请先以无回显方式设置 SILICONFLOW_API_KEY。");
	assert(process.env.AGENTPLAN_API_KEY?.trim(), "请先以无回显方式设置 AGENTPLAN_API_KEY。");
	const asar = await findObsidianAsar();
	const isolated = await createProfile(asar);
	let child;
	let browser;
	try {
		const port = await reservePort();
		const launched = launch(isolated.profileDir, port);
		child = launched.child;
		const endpoint = await waitForPage(port, child);
		browser = await chromium.connectOverCDP(endpoint);
		const page = browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() === "app://obsidian.md/index.html");
		assert(page, "CDP 未找到 Obsidian 页面。");
		page.setDefaultTimeout(20_000);
		await page.waitForFunction(() => Boolean(window.app?.plugins?.plugins));
		await page.evaluate(async (id) => {
			await window.app.plugins.setEnable(true);
			if (window.app.plugins.plugins[id]) await window.app.plugins.disablePlugin(id);
			await window.app.plugins.enablePluginAndSave(id);
		}, pluginId);
		await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]?.settings), pluginId);

		const setup = await page.evaluate(async ({
			id,
			releaseVersion,
			siliconFlowProvider,
			siliconFlowBaseUrl,
			siliconFlowModel,
			agentPlanProvider,
			agentPlanBaseUrl,
			agentPlanModel
		}) => {
			const plugin = window.app.plugins.plugins[id];
			const siliconFlowKey = globalThis.process?.env?.SILICONFLOW_API_KEY?.trim();
			const agentPlanKey = globalThis.process?.env?.AGENTPLAN_API_KEY?.trim();
			if (!siliconFlowKey) throw new Error("隔离 Obsidian 未继承 SILICONFLOW_API_KEY。");
			if (!agentPlanKey) throw new Error("隔离 Obsidian 未继承 AGENTPLAN_API_KEY。");
			window.app.secretStorage.setSecret(
				"echo-notes-transcription-api-key-siliconflow",
				siliconFlowKey
			);
			window.app.secretStorage.setSecret(
				"echo-notes-analysis-api-key-volcengine-agentplan",
				agentPlanKey
			);
			window.app.secretStorage.setSecret(
				"echo-notes-memory-api-key-volcengine-agentplan",
				agentPlanKey
			);
			Object.assign(plugin.settings, {
				transcriptionMode: "offline",
				offlineTranscription: {
					...plugin.settings.offlineTranscription,
					provider: siliconFlowProvider,
					baseUrl: siliconFlowBaseUrl,
					model: siliconFlowModel,
					language: "auto"
				},
				analysisProvider: agentPlanProvider,
				analysisBaseUrl: agentPlanBaseUrl,
				analysisModel: agentPlanModel,
				analysisEnabled: true,
				memoryEnabled: true,
				memoryInitialized: false,
				memoryRootFolder: "Echo Memory",
				memoryPathLanguage: "zh",
				memoryMode: "compile-profiles",
				memoryProvider: agentPlanProvider,
				memoryBaseUrl: agentPlanBaseUrl,
				memoryModel: agentPlanModel,
				copyLanguage: "zh",
				skipExistingTranscript: false,
				confirmBeforeTranscription: false,
				verboseLog: false
			});
			plugin.refreshServices();
			await plugin.memoryService.initialize(plugin.settings, {
				displayName: "Echo Test User",
				role: "产品经理",
				recentGoal: `验证 Echo Notes ${releaseVersion} 真实链路`
			});
			plugin.settings.memoryInitialized = true;
			await plugin.saveSettings();
			plugin.refreshServices();
			return {
				transcriptionMode: plugin.settings.transcriptionMode,
				offlineProvider: plugin.settings.offlineTranscription.provider,
				offlineBaseUrl: plugin.settings.offlineTranscription.baseUrl,
				offlineModel: plugin.settings.offlineTranscription.model,
				analysisProvider: plugin.settings.analysisProvider,
				analysisBaseUrl: plugin.settings.analysisBaseUrl,
				analysisModel: plugin.settings.analysisModel,
				memoryProvider: plugin.settings.memoryProvider,
				memoryBaseUrl: plugin.settings.memoryBaseUrl,
				memoryModel: plugin.settings.memoryModel,
				memoryInitialized: plugin.settings.memoryInitialized,
				secretsPresent: [
					"echo-notes-transcription-api-key-siliconflow",
					"echo-notes-analysis-api-key-volcengine-agentplan",
					"echo-notes-memory-api-key-volcengine-agentplan"
				].every((secretId) => Boolean(window.app.secretStorage.getSecret(secretId)))
			};
		}, {
			id: pluginId,
			releaseVersion,
			siliconFlowProvider,
			siliconFlowBaseUrl,
			siliconFlowModel,
			agentPlanProvider,
			agentPlanBaseUrl,
			agentPlanModel
		});
		assert(setup.secretsPresent, "SiliconFlow/AgentPlan SecretStorage 注入失败。");
		assert(setup.offlineProvider === siliconFlowProvider, "真实验收转写 Provider 配置不正确。");
		assert(setup.offlineBaseUrl === siliconFlowBaseUrl, "真实验收转写 Base URL 配置不正确。");
		assert(setup.offlineModel === siliconFlowModel, "真实验收转写模型配置不正确。");
		assert(setup.analysisProvider === agentPlanProvider, "真实验收分析 Provider 配置不正确。");
		assert(setup.analysisBaseUrl === agentPlanBaseUrl, "真实验收分析 Base URL 配置不正确。");
		assert(setup.analysisModel === agentPlanModel, "真实验收分析模型配置不正确。");
		assert(setup.memoryProvider === agentPlanProvider, "真实验收记忆 Provider 配置不正确。");
		assert(setup.memoryBaseUrl === agentPlanBaseUrl, "真实验收记忆 Base URL 配置不正确。");
		assert(setup.memoryModel === agentPlanModel, "真实验收记忆模型配置不正确。");

		const result = await page.evaluate(async ({ id, fixtureFolder }) => {
			const plugin = window.app.plugins.plugins[id];
			const vault = window.app.vault;
			const sourcePath = `${fixtureFolder}/EchoRelease-0822.md`;
			const audioPath = `${fixtureFolder}/EchoRelease-上线日期-0822.wav`;
			const sourceNote = window.app.vault.getAbstractFileByPath(sourcePath);
			const audioFile = window.app.vault.getAbstractFileByPath(audioPath);
			if (!sourceNote?.path?.endsWith(".md") || !audioFile?.path?.endsWith(".wav")) {
				throw new Error("真实链路测试素材未加载。");
			}
			const audioLinkPath = "EchoRelease-上线日期-0822.wav";
			const transcription = await plugin.processAudioToTranscript(audioFile, sourceNote, {
				allowUploadConfirmation: false,
				audioLinkPath,
				onTranscriptFileReady: (transcriptFile) => plugin.insertTranscriptLinkIntoFile(sourceNote, audioLinkPath, transcriptFile)
			});
			if (!transcription?.transcriptFile) throw new Error("真实转写未生成 transcript。");
			const template = plugin.settings.analysisTemplates.find((item) => item.id === "work-minutes");
			if (!template) throw new Error("工作纪要模板不存在。");
			const analysisSuccess = await plugin.startAnalysisTask(transcription.transcriptFile, template);
			if (!analysisSuccess) throw new Error("真实 AI 分析未成功。");
			const existingTranscript = vault.getAbstractFileByPath(`${fixtureFolder}/EchoRelease-上线日期-0815.transcript.md`);
			if (!existingTranscript?.path?.endsWith(".md")) throw new Error("第二份验收 transcript 不存在。");
			const transcriptContentForRelation = await vault.cachedRead(transcription.transcriptFile);
			await vault.modify(existingTranscript, transcriptContentForRelation);
			await plugin.startMemoryTask(transcription.transcriptFile, [template.id], true);
			while (plugin.activeMemoryTasks.size > 0) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			await plugin.startMemoryTask(existingTranscript, [template.id], true);
			while (plugin.activeMemoryTasks.size > 0) {
				await new Promise((resolve) => setTimeout(resolve, 250));
			}
			return { transcriptPath: transcription.transcriptFile.path, sourcePath, audioPath };
		}, { id: pluginId, fixtureFolder });

		await page.waitForFunction((id) => {
			const plugin = window.app.plugins.plugins[id];
			return plugin.taskCenter.getTasks().every((task) => task.status !== "running");
		}, pluginId, { timeout: 900_000 });

		const verification = await page.evaluate(async ({
			id,
			transcriptPath,
			releaseVersion,
			siliconFlowProvider,
			siliconFlowModel,
			agentPlanProvider,
			agentPlanModel
		}) => {
			const plugin = window.app.plugins.plugins[id];
			const vault = window.app.vault;
			const transcriptFile = vault.getAbstractFileByPath(transcriptPath);
			if (!transcriptFile?.path?.endsWith(".md")) throw new Error("真实 transcript 文件不存在。");
			const transcriptContent = await vault.cachedRead(transcriptFile);
			const tasks = plugin.taskCenter.getTasks().map((task) => ({ id: task.id, kind: task.kind, status: task.status, provider: task.provider, model: task.model, outputPath: task.outputPath, error: task.error, traceId: task.traceId }));
			if (!/^status: done/m.test(transcriptContent)) throw new Error("真实 transcript 未完成。");
			if (!new RegExp(`provider: "${siliconFlowProvider}"`, "m").test(transcriptContent)) throw new Error("真实 transcript Provider 不正确。");
			if (!new RegExp(`model: "${siliconFlowModel.replaceAll("/", "\\/")}"`, "m").test(transcriptContent)) throw new Error("真实 transcript 模型不正确。");
			if (!/analysis_status: "analysis_done"/m.test(transcriptContent)) throw new Error("真实 AI 分析未写入完成状态。");
			if (!new RegExp(`analysis_provider: "${agentPlanProvider}"`, "m").test(transcriptContent)) throw new Error("真实 AI 分析 Provider 不正确。");
			if (!new RegExp(`analysis_model: "${agentPlanModel}"`, "m").test(transcriptContent)) throw new Error("真实 AI 分析模型不正确。");
			if (!transcriptContent.includes("echo-notes-analysis:start")) throw new Error("真实 AI 分析托管区块不存在。");
			if (transcriptContent.includes("echo-notes-analysis-checkpoint:start")) throw new Error("成功分析后仍保留分析检查点。");
			if (/SILICONFLOW_API_KEY|AGENTPLAN_API_KEY|Bearer\s|api[_-]?key/i.test(transcriptContent)) throw new Error("真实 transcript 含敏感凭据痕迹。");
			const transcriptionTask = tasks.find((task) => task.kind === "transcription" && task.provider === siliconFlowProvider && task.model === siliconFlowModel);
			const analysisTask = tasks.find((task) => task.kind === "analysis" && task.provider === agentPlanProvider && task.model === agentPlanModel);
			const memoryTasks = tasks.filter((task) => task.kind === "memory" && task.provider === agentPlanProvider && task.model === agentPlanModel);
			if (transcriptionTask?.status !== "success" || !transcriptionTask.traceId) throw new Error("转写任务或 Trace ID 验收失败。");
			if (analysisTask?.status !== "success" || !analysisTask.traceId) throw new Error("分析任务或 Trace ID 验收失败。");
			if (memoryTasks.length < 2 || memoryTasks.some((task) => task.status !== "success" || !task.traceId)) throw new Error("记忆任务或 Trace ID 验收失败。");
			const candidateFiles = vault.getMarkdownFiles().filter((file) => file.path.startsWith("Echo Memory/02 记忆候选/") && !file.path.endsWith(".review.md"));
			if (candidateFiles.length < 2) throw new Error(`真实 Memory 候选不足：${candidateFiles.length}`);
			const candidateData = [];
			for (const file of candidateFiles) {
				const context = await plugin.memoryService.getReviewContext(plugin.settings, file);
				if (context.candidate.assertions.length === 0) throw new Error(`候选没有有效断言：${file.path}`);
				if (context.candidate.provider !== agentPlanProvider || context.candidate.model !== agentPlanModel) throw new Error(`候选 Provider 或模型不正确：${file.path}`);
				if (context.candidate.traceIds.length === 0) throw new Error(`候选缺少 Trace ID：${file.path}`);
				const updates = context.candidate.assertions.map((assertion) => ({ assertionId: assertion.id, status: "approved", effectiveValue: assertion.value, note: `${releaseVersion} 真实链路验收批准` }));
				const saved = await plugin.memoryService.saveMemoryReview(plugin.settings, context.candidatePath, updates);
				candidateData.push({ path: context.candidatePath, context, saved });
			}
			await plugin.memoryService.compileProfiles(plugin.settings);
			const endpoints = [];
			for (const item of candidateData) {
				const file = vault.getAbstractFileByPath(item.path);
				const relationContext = await plugin.memoryService.getMemoryRelationContext(plugin.settings, file);
				endpoints.push(...relationContext.currentApprovedEndpoints);
			}
			let relation = null;
			for (const left of endpoints) {
				const right = endpoints.find((candidate) => candidate.candidatePath !== left.candidatePath && candidate.subjectType === left.subjectType && candidate.subjectName === left.subjectName);
				if (right) {
					const type = left.predicate === right.predicate && left.effectiveValue !== right.effectiveValue ? "conflicts" : "supplements";
					relation = await plugin.memoryService.confirmMemoryRelation(plugin.settings, left.candidatePath, type, left, right, `${releaseVersion} 真实链路关系验收`);
					break;
				}
			}
			if (!relation) throw new Error("两份真实候选没有找到可建立关系的共同主体。");
			await plugin.memoryService.compileProfiles(plugin.settings);
			const choices = await plugin.memoryService.getMemoryContextPackageContext(plugin.settings);
			const project = choices.choices.projects[0] ?? "";
			const contextPackage = await plugin.memoryService.createMemoryContextPackage(plugin.settings, { project, person: "", startDate: "", endDate: "", maxCharacters: 12_000 });
			const contextFile = vault.getAbstractFileByPath(contextPackage.path);
			if (!contextFile?.path?.endsWith(".md")) throw new Error("上下文包文件不存在。");
			const contextContent = await vault.cachedRead(contextFile);
			if (!contextContent.includes("echo-memory-context:managed:start")) throw new Error("上下文包托管区块不存在。");
			const checkpointFile = vault.getAbstractFileByPath("Echo Memory/99 系统/echo-memory-checkpoints.json");
			if (checkpointFile?.path?.endsWith(".json")) {
				const checkpointStore = JSON.parse(await vault.cachedRead(checkpointFile));
				if (Object.keys(checkpointStore.checkpoints ?? {}).length !== 0) throw new Error("成功记忆提取后仍保留未完成检查点。");
			}
			const candidatePaths = candidateData.map((item) => item.path);
			const reviewPaths = candidateData.map((item) => item.context.reviewPath);
			const files = vault.getMarkdownFiles().map((file) => file.path);
			return {
				transcriptPath,
				transcriptBytes: transcriptContent.length,
				tasks,
				candidatePaths,
				reviewPaths,
				relationId: relation.relation?.id ?? null,
				contextPath: contextPackage.path,
				contextProject: project,
				checkpointFiles: files.filter((file) => file.includes("checkpoint")),
				managedAnalysis: transcriptContent.includes("echo-notes-analysis:start"),
				secretFree: !/SILICONFLOW_API_KEY|AGENTPLAN_API_KEY|Bearer\s|api[_-]?key/i.test(transcriptContent + contextContent)
			};
		}, {
			id: pluginId,
			transcriptPath: result.transcriptPath,
			releaseVersion,
			siliconFlowProvider,
			siliconFlowModel,
			agentPlanProvider,
			agentPlanModel
		});

		console.log(JSON.stringify({ obsidianVersion: asar.version, setup, result, verification }));
	} finally {
		if (browser) await browser.close().catch(() => {});
		await stopChild(child);
		await rm(isolated.profileDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.stack : String(error));
	process.exitCode = 1;
});

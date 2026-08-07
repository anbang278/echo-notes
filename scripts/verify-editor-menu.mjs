import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
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
import { createServer as createNetServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const pluginId = "echo-notes";
const menuTitle = "转写当前笔记音频";
const testVault = path.resolve(process.env.ECHO_NOTES_TEST_VAULT ?? path.resolve(projectRoot, "../.."));
const obsidianBinary = path.resolve(
	process.env.OBSIDIAN_BINARY_PATH ?? "/Applications/Obsidian.app/Contents/MacOS/Obsidian"
);
const obsidianDataDir = path.resolve(
	process.env.OBSIDIAN_DATA_DIR ?? path.join(os.homedir(), "Library/Application Support/obsidian")
);
const outputDir = path.resolve(
	process.env.ECHO_NOTES_EDITOR_MENU_OUTPUT_DIR ?? path.join(projectRoot, "output/playwright/editor-menu")
);
const startupTimeoutMs = 30_000;
const workflowTimeoutMs = 45_000;

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

async function validateWorkspace() {
	const manifestPath = path.join(projectRoot, "manifest.json");
	const pluginInstallPath = path.join(testVault, ".obsidian/plugins", pluginId);
	const communityPluginsPath = path.join(testVault, ".obsidian/community-plugins.json");
	await Promise.all([
		requirePath(obsidianBinary, "Obsidian 可执行文件"),
		requirePath(path.join(projectRoot, "main.js"), "插件构建产物 main.js"),
		requirePath(path.join(projectRoot, "styles.css"), "插件样式 styles.css"),
		requirePath(manifestPath, "插件 manifest"),
		requirePath(pluginInstallPath, "测试 Vault 插件目录"),
		requirePath(communityPluginsPath, "测试 Vault 插件启用列表")
	]);
	const [projectRealPath, installRealPath] = await Promise.all([
		realpath(projectRoot),
		realpath(pluginInstallPath)
	]);
	assert(projectRealPath === installRealPath, `测试 Vault 的 ${pluginId} 未指向当前工程`);
	const enabledPlugins = JSON.parse(await readFile(communityPluginsPath, "utf8"));
	assert(Array.isArray(enabledPlugins) && enabledPlugins.includes(pluginId), `测试 Vault 尚未启用 ${pluginId}`);
	return JSON.parse(await readFile(manifestPath, "utf8"));
}

async function findLatestObsidianAsar() {
	const candidates = (await readdir(obsidianDataDir))
		.map((fileName) => ({
			fileName,
			match: fileName.match(/^obsidian-(\d+\.\d+\.\d+)\.asar$/)
		}))
		.filter((candidate) => candidate.match)
		.map((candidate) => ({
			path: path.join(obsidianDataDir, candidate.fileName),
			version: candidate.match[1]
		}))
		.sort((left, right) => compareVersions(right.version, left.version));
	assert(candidates.length > 0, `未在 ${obsidianDataDir} 找到 Obsidian 版本化 ASAR`);
	return candidates[0];
}

async function reservePort() {
	const server = createNetServer();
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "无法分配本地端口");
	await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
	return address.port;
}

async function startTranscriptionMock() {
	const calls = [];
	let nextFailureStatus = null;
	const server = createHttpServer((request, response) => {
		const bodyChunks = [];
		let bodyBytes = 0;
		request.on("data", (chunk) => {
			bodyBytes += chunk.byteLength;
			if (bodyBytes > 2 * 1024 * 1024) {
				request.destroy(new Error("本地转写 mock 请求超过 2 MB"));
				return;
			}
			bodyChunks.push(chunk);
		});
		request.on("end", () => {
			const callIndex = calls.length + 1;
			const contentType = request.headers["content-type"] ?? "";
			const body = Buffer.concat(bodyChunks);
			calls.push({
				method: request.method,
				url: request.url,
				bodyBytes: body.byteLength,
				multipart: contentType.startsWith("multipart/form-data; boundary="),
				local: request.socket.remoteAddress === "127.0.0.1" || request.socket.remoteAddress === "::1"
			});
			if (request.method !== "POST" || request.url !== "/v1/audio/transcriptions") {
				response.writeHead(404, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "unknown local mock route" } }));
				return;
			}
			if (!contentType.startsWith("multipart/form-data; boundary=") || body.byteLength === 0) {
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "invalid local multipart request" } }));
				return;
			}
			if (nextFailureStatus !== null) {
				const status = nextFailureStatus;
				nextFailureStatus = null;
				response.writeHead(status, {
					"content-type": "application/json",
					"x-siliconcloud-trace-id": `local-failure-${callIndex}`
				});
				response.end(JSON.stringify({ error: { message: "local mock rejected request" } }));
				return;
			}
			response.writeHead(200, {
				"content-type": "application/json",
				"x-siliconcloud-trace-id": `local-success-${callIndex}`
			});
			response.end(JSON.stringify({ text: `本地模拟转写 ${callIndex}` }));
		});
	});
	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	assert(address && typeof address === "object", "无法启动本地转写 mock");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		calls,
		failNext(status = 400) {
			nextFailureStatus = status;
		},
		async close() {
			if (!server.listening) {
				return;
			}
			await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	};
}

function createSyntheticWav(frequency) {
	const sampleRate = 16_000;
	const sampleCount = Math.round(sampleRate * 0.5);
	const dataBytes = sampleCount * 2;
	const buffer = Buffer.alloc(44 + dataBytes);
	buffer.write("RIFF", 0, "ascii");
	buffer.writeUInt32LE(36 + dataBytes, 4);
	buffer.write("WAVE", 8, "ascii");
	buffer.write("fmt ", 12, "ascii");
	buffer.writeUInt32LE(16, 16);
	buffer.writeUInt16LE(1, 20);
	buffer.writeUInt16LE(1, 22);
	buffer.writeUInt32LE(sampleRate, 24);
	buffer.writeUInt32LE(sampleRate * 2, 28);
	buffer.writeUInt16LE(2, 32);
	buffer.writeUInt16LE(16, 34);
	buffer.write("data", 36, "ascii");
	buffer.writeUInt32LE(dataBytes, 40);
	for (let index = 0; index < sampleCount; index += 1) {
		const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 5000);
		buffer.writeInt16LE(value, 44 + index * 2);
	}
	return buffer;
}

async function createIsolatedProfile(obsidianAsar) {
	const profileDir = await mkdtemp(path.join(os.tmpdir(), "echo-notes-editor-menu-"));
	const vault = path.join(profileDir, "vault");
	const pluginDir = path.join(vault, ".obsidian/plugins", pluginId);
	await mkdir(pluginDir, { recursive: true });
	const wavFiles = ["confirm.wav", "single.wav", "one.wav", "two.wav", "failure.wav"];
	await Promise.all([
		copyFile(path.join(projectRoot, "main.js"), path.join(pluginDir, "main.js")),
		copyFile(path.join(projectRoot, "styles.css"), path.join(pluginDir, "styles.css")),
		copyFile(path.join(projectRoot, "manifest.json"), path.join(pluginDir, "manifest.json")),
		writeFile(path.join(vault, ".obsidian/community-plugins.json"), `${JSON.stringify([pluginId])}\n`),
		writeFile(path.join(vault, ".obsidian/app.json"), `${JSON.stringify({ promptDelete: false })}\n`),
		writeFile(path.join(vault, "empty.md"), "# 无音频\n\n用于验证空分支。\n"),
		writeFile(path.join(vault, "confirm.md"), "# 上传确认\n\n![[confirm.wav]]\n"),
		writeFile(path.join(vault, "single.md"), "# 单音频\n\n![[single.wav]]\n"),
		writeFile(path.join(vault, "multiple.md"), "# 多音频\n\n![[one.wav]]\n\n![[two.wav]]\n"),
		writeFile(path.join(vault, "failure.md"), "# 失败分支\n\n![[failure.wav]]\n"),
		...wavFiles.map((fileName, index) =>
			writeFile(path.join(vault, fileName), createSyntheticWav(320 + index * 40))
		)
	]);
	const vaultId = createHash("sha256").update(vault).digest("hex").slice(0, 16);
	await writeFile(
		path.join(profileDir, "obsidian.json"),
		`${JSON.stringify({
			vaults: { [vaultId]: { path: vault, ts: Date.now(), open: true } },
			frame: "custom",
			updateDisabled: true
		}, null, "\t")}\n`
	);
	await copyFile(obsidianAsar.path, path.join(profileDir, path.basename(obsidianAsar.path)));
	return { profileDir, vault };
}

function launchObsidian(profileDir, port) {
	const child = spawn(
		obsidianBinary,
		[
			`--user-data-dir=${profileDir}`,
			`--remote-debugging-port=${port}`,
			"--window-size=1280,900",
			"--no-first-run"
		],
		{ cwd: projectRoot, env: process.env, stdio: ["ignore", "pipe", "pipe"] }
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
	const deadline = Date.now() + startupTimeoutMs;
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
			// Renderer 启动期间继续轮询。
		}
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`等待隔离 Obsidian renderer 超时（${startupTimeoutMs} ms）`);
}

async function ensurePluginLoaded(page) {
	await page.waitForFunction(
		(id) => Boolean(window.app?.workspace?.layoutReady && window.app?.plugins?.manifests?.[id]),
		pluginId,
		{ timeout: startupTimeoutMs }
	);
	await page.evaluate(async (id) => {
		await window.app.plugins.setEnable(true);
		if (!window.app.plugins.plugins[id]) {
			await window.app.plugins.enablePluginAndSave(id);
		}
	}, pluginId);
	await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), pluginId);
}

async function closeStartupModals(page) {
	const welcomeClose = page.locator(
		".echo-notes-getting-started-modal-shell:visible .modal-close-button"
	);
	if (await welcomeClose.count()) {
		await welcomeClose.click();
		await page.locator(".echo-notes-getting-started-modal-shell").waitFor({ state: "detached" });
	}
	const trustButton = page.locator(".modal-container:visible")
		.getByRole("button", { name: "信任仓库作者并启用插件", exact: true });
	if (await trustButton.count()) {
		await trustButton.click();
		await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), pluginId);
	}
}

async function configurePlugin(page, baseUrl) {
	const localSecret = `local-mock-${randomUUID()}`;
	await page.evaluate(async ({ id, localBaseUrl, secret }) => {
		const plugin = window.app.plugins.plugins[id];
		Object.assign(plugin.settings, {
			transcriptionMode: "offline",
			offlineTranscription: {
				...plugin.settings.offlineTranscription,
				provider: "siliconflow",
				baseUrl: localBaseUrl,
				model: "local-editor-menu-mock",
				language: "auto"
			},
			analysisEnabled: false,
			confirmBeforeTranscription: false,
			skipExistingTranscript: false,
			verboseLog: false,
			gettingStartedState: {
				...plugin.settings.gettingStartedState,
				status: "dismissed",
				dismissedAt: Date.now()
			}
		});
		await plugin.saveApiKey("siliconflow", secret);
		await plugin.saveSettings();
		plugin.refreshServices();
	}, { id: pluginId, localBaseUrl: baseUrl, secret: localSecret });
}

async function openNote(page, notePath) {
	await page.evaluate(async (targetPath) => {
		const file = window.app.vault.getAbstractFileByPath(targetPath);
		if (!file?.path?.endsWith(".md")) {
			throw new Error(`隔离验收笔记不存在：${targetPath}`);
		}
		const leaf = window.app.workspace.getLeaf(false);
		window.app.workspace.setActiveLeaf(leaf, { focus: true });
		await leaf.openFile(file);
	}, notePath);
	await page.waitForFunction(
		(targetPath) => window.app.workspace.getActiveFile()?.path === targetPath,
		notePath
	);
	await page.locator(".workspace-leaf.mod-active .cm-editor .cm-content").waitFor({ state: "visible" });
}

async function openEditorMenu(page) {
	return page.evaluate((expectedTitle) => {
		const view = window.app.workspace.activeLeaf?.view;
		if (!view?.editor) {
			throw new Error("当前活动视图不是 Markdown 编辑器");
		}
		const items = [];
		const menuTarget = {
			addItem(callback) {
				const state = { title: "", icon: "", onClick: null };
				let item;
				item = new Proxy({
					setTitle(value) {
						state.title = String(value);
						return item;
					},
					setIcon(value) {
						state.icon = String(value);
						return item;
					},
					onClick(handler) {
						state.onClick = handler;
						return item;
					}
				}, {
					get(target, property) {
						if (property in target) {
							return target[property];
						}
						return () => item;
					}
				});
				callback(item);
				items.push(state);
				return menu;
			},
			addSeparator() {
				return menu;
			}
		};
		let menu;
		menu = new Proxy(menuTarget, {
			get(target, property) {
				if (property in target) {
					return target[property];
				}
				return () => menu;
			}
		});
		window.app.workspace.trigger("editor-menu", menu, view.editor, view);
		globalThis.__echoNotesEditorMenuItems = items;
		const matches = items.filter((item) => item.title === expectedTitle);
		if (matches.some((item) => item.icon !== "audio-lines" || typeof item.onClick !== "function")) {
			throw new Error("右键菜单项的图标或点击回调不正确");
		}
		return matches.length;
	}, menuTitle);
}

async function clickTranscriptionMenuItem(page) {
	await page.evaluate((expectedTitle) => {
		const matches = (globalThis.__echoNotesEditorMenuItems ?? [])
			.filter((item) => item.title === expectedTitle);
		if (matches.length !== 1 || typeof matches[0].onClick !== "function") {
			throw new Error(`右键菜单项数量不正确：${matches.length}`);
		}
		matches[0].onClick();
	}, menuTitle);
}

async function waitForNotice(page, text) {
	await page.locator(".notice").filter({ hasText: text }).last().waitFor({
		state: "visible",
		timeout: workflowTimeoutMs
	});
}

async function waitForTask(page, targetPath, status) {
	await page.waitForFunction(
		({ id, audioPath, expectedStatus }) => {
			const plugin = window.app.plugins.plugins[id];
			return plugin?.taskCenter.getTasks().some(
				(task) => task.kind === "transcription" && task.targetPath === audioPath && task.status === expectedStatus
			);
		},
		{ id: pluginId, audioPath: targetPath, expectedStatus: status },
		{ timeout: workflowTimeoutMs }
	);
}

async function inspectSuccessfulTranscription(page, audioPath, minimumLinks) {
	return page.evaluate(async ({ id, targetPath, expectedLinks }) => {
		const plugin = window.app.plugins.plugins[id];
		const task = plugin.taskCenter.getTasks().find(
			(candidate) => candidate.kind === "transcription" && candidate.targetPath === targetPath
		);
		const transcriptFile = task?.outputPath
			? window.app.vault.getAbstractFileByPath(task.outputPath)
			: null;
		const transcriptContent = transcriptFile ? await window.app.vault.read(transcriptFile) : "";
		const editorValue = window.app.workspace.activeLeaf?.view?.editor?.getValue?.() ?? "";
		return {
			task,
			transcriptPath: transcriptFile?.path ?? null,
			transcriptContent,
			linkCount: (editorValue.match(/\.transcript(?:\.md)?(?:\||\]\])/g) ?? []).length,
			expectedLinks
		};
	}, { id: pluginId, targetPath: audioPath, expectedLinks: minimumLinks });
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
	const expectedPrefix = path.resolve(os.tmpdir(), "echo-notes-editor-menu-");
	const resolvedProfile = path.resolve(profileDir);
	assert(resolvedProfile.startsWith(expectedPrefix), `拒绝清理非预期目录：${resolvedProfile}`);
	await rm(resolvedProfile, { force: true, recursive: true });
}

let isolatedProfile;
let obsidianProcess;
let getObsidianOutput = () => "";
let browser;
let transcriptionMock;
const startedAt = Date.now();

try {
	const manifest = await validateWorkspace();
	const obsidianAsar = await findLatestObsidianAsar();
	assert(
		compareVersions(obsidianAsar.version, manifest.minAppVersion) >= 0,
		`Obsidian ${obsidianAsar.version} 低于插件最低要求 ${manifest.minAppVersion}`
	);
	await mkdir(outputDir, { recursive: true });
	await rm(path.join(outputDir, "summary.json"), { force: true });
	transcriptionMock = await startTranscriptionMock();
	const isolated = await createIsolatedProfile(obsidianAsar);
	isolatedProfile = isolated.profileDir;
	const cdpPort = await reservePort();
	const launched = await launchObsidian(isolatedProfile, cdpPort);
	obsidianProcess = launched.child;
	getObsidianOutput = launched.getOutput;
	const endpoint = await waitForObsidianPage(cdpPort, obsidianProcess);
	browser = await chromium.connectOverCDP(endpoint);
	const page = browser.contexts().flatMap((context) => context.pages())
		.find((candidate) => candidate.url() === "app://obsidian.md/index.html");
	assert(page, "CDP 中未找到 Obsidian renderer 页面");
	page.setDefaultTimeout(10_000);
	const pageErrors = [];
	page.on("pageerror", (error) => pageErrors.push(error.message));

	await ensurePluginLoaded(page);
	await closeStartupModals(page);
	await configurePlugin(page, transcriptionMock.baseUrl);
	const runtimeVersion = await page.evaluate((id) => window.app.plugins.manifests[id]?.version ?? null, pluginId);
	assert(runtimeVersion === manifest.version, `宿主插件版本不匹配：${runtimeVersion ?? "未找到"}`);

	await openNote(page, "empty.md");
	assert(await openEditorMenu(page) === 1, "无音频笔记右键菜单项不是唯一实例");
	const emptyBefore = await page.evaluate((id) => ({
		tasks: window.app.plugins.plugins[id].taskCenter.getTasks().length,
		files: window.app.vault.getMarkdownFiles().length
	}), pluginId);
	await clickTranscriptionMenuItem(page);
	await waitForNotice(page, "没有在当前笔记中找到音频文件");
	const emptyAfter = await page.evaluate((id) => ({
		tasks: window.app.plugins.plugins[id].taskCenter.getTasks().length,
		files: window.app.vault.getMarkdownFiles().length
	}), pluginId);
	assert(JSON.stringify(emptyAfter) === JSON.stringify(emptyBefore), "无音频分支创建了任务或文件");
	assert(transcriptionMock.calls.length === 0, "无音频分支调用了本地转写 mock");

	await openNote(page, "confirm.md");
	await page.evaluate(async (id) => {
		const plugin = window.app.plugins.plugins[id];
		plugin.settings.confirmBeforeTranscription = true;
		await plugin.saveSettings();
	}, pluginId);
	const confirmTaskCount = await page.evaluate(
		(id) => window.app.plugins.plugins[id].taskCenter.getTasks().length,
		pluginId
	);
	assert(await openEditorMenu(page) === 1, "上传确认笔记右键菜单项不是唯一实例");
	await clickTranscriptionMenuItem(page);
	await page.locator(".modal-title").filter({ hasText: "确认上传音频" }).waitFor({ state: "visible" });
	assert(transcriptionMock.calls.length === 0, "确认前已发送音频请求");
	await page.getByRole("button", { name: "取消", exact: true }).click();
	await waitForNotice(page, "已取消转写：confirm.wav");
	const confirmTaskCountAfter = await page.evaluate(
		(id) => window.app.plugins.plugins[id].taskCenter.getTasks().length,
		pluginId
	);
	assert(confirmTaskCountAfter === confirmTaskCount, "取消上传后仍创建了转写任务");
	await page.evaluate(async (id) => {
		const plugin = window.app.plugins.plugins[id];
		plugin.settings.confirmBeforeTranscription = false;
		await plugin.saveSettings();
	}, pluginId);

	await openNote(page, "single.md");
	assert(await openEditorMenu(page) === 1, "单音频笔记右键菜单项不是唯一实例");
	await clickTranscriptionMenuItem(page);
	await waitForTask(page, "single.wav", "success");
	const singleResult = await inspectSuccessfulTranscription(page, "single.wav", 1);
	assert(singleResult.task?.traceId?.startsWith("local-success-"), "单音频任务缺少本地 mock Trace ID");
	assert(singleResult.transcriptPath?.endsWith("single.transcript.md"), "单音频未生成 transcript");
	assert(/^status: done/m.test(singleResult.transcriptContent), "单音频 transcript 状态不是 done");
	assert(/source_audio:/m.test(singleResult.transcriptContent), "单音频 transcript 缺少音频来源");
	assert(/source_note:/m.test(singleResult.transcriptContent), "单音频 transcript 缺少笔记来源");
	assert(singleResult.linkCount >= singleResult.expectedLinks, "单音频笔记未回写 transcript 链接");

	await openNote(page, "multiple.md");
	assert(await openEditorMenu(page) === 1, "多音频笔记右键菜单项不是唯一实例");
	await clickTranscriptionMenuItem(page);
	await Promise.all([
		waitForTask(page, "one.wav", "success"),
		waitForTask(page, "two.wav", "success")
	]);
	const multipleResult = await inspectSuccessfulTranscription(page, "one.wav", 2);
	assert(multipleResult.linkCount >= multipleResult.expectedLinks, "多音频笔记未回写全部 transcript 链接");
	const multipleTasks = await page.evaluate((id) => window.app.plugins.plugins[id].taskCenter.getTasks()
		.filter((task) => ["one.wav", "two.wav"].includes(task.targetPath))
		.map((task) => ({ status: task.status, outputPath: task.outputPath, traceId: task.traceId })), pluginId);
	assert(multipleTasks.length === 2 && multipleTasks.every(
		(task) => task.status === "success" && task.outputPath && task.traceId?.startsWith("local-success-")
	), "多音频任务状态不完整");

	await openNote(page, "failure.md");
	transcriptionMock.failNext(400);
	assert(await openEditorMenu(page) === 1, "失败分支右键菜单项不是唯一实例");
	await clickTranscriptionMenuItem(page);
	await waitForTask(page, "failure.wav", "failed");
	await waitForNotice(page, "转写失败");
	const failureTask = await page.evaluate((id) => window.app.plugins.plugins[id].taskCenter.getTasks()
		.find((task) => task.targetPath === "failure.wav"), pluginId);
	assert(failureTask?.status === "failed" && failureTask.error, "本地 mock 失败未记录到任务中心");

	await page.evaluate(async (id) => {
		await window.app.plugins.disablePlugin(id);
	}, pluginId);
	assert(await openEditorMenu(page) === 0, "禁用插件后右键菜单监听器未清理");
	await page.evaluate(async (id) => {
		await window.app.plugins.enablePluginAndSave(id);
	}, pluginId);
	await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), pluginId);
	assert(await openEditorMenu(page) === 1, "重新启用插件后右键菜单数量不正确");
	await page.evaluate(async (id) => {
		await window.app.plugins.disablePlugin(id);
		await window.app.plugins.enablePluginAndSave(id);
	}, pluginId);
	await page.waitForFunction((id) => Boolean(window.app.plugins.plugins[id]), pluginId);
	assert(await openEditorMenu(page) === 1, "重载插件后出现重复右键菜单项");

	assert(transcriptionMock.calls.length === 4, `本地转写 mock 请求数量不正确：${transcriptionMock.calls.length}`);
	assert(transcriptionMock.calls.every((call) => call.local && call.multipart), "转写验收出现非本机或非 multipart 请求");
	assert(pageErrors.length === 0, `右键菜单验收出现运行时错误：${pageErrors.join(" | ")}`);
	const summary = {
		pluginVersion: manifest.version,
		runtimePluginVersion: runtimeVersion,
		obsidianVersion: obsidianAsar.version,
		sourceTestVault: testVault,
		externalAudioUploads: 0,
		localMockRequests: transcriptionMock.calls.length,
		checks: {
			uniqueMenuItem: true,
			emptyNote: true,
			uploadConfirmationCancel: true,
			singleAudio: true,
			multipleAudio: true,
			failureTask: true,
			listenerCleanup: true,
			runtimeErrors: pageErrors.length
		},
		durationMs: Date.now() - startedAt,
		generatedAt: new Date().toISOString()
	};
	await writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, "\t")}\n`);
	console.log(`Echo Notes 编辑器右键菜单隔离验收通过：Obsidian ${obsidianAsar.version}`);
	console.log(`本地 mock 请求 ${summary.localMockRequests} 次；外部音频上传 ${summary.externalAudioUploads} 次。`);
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
	await transcriptionMock?.close().catch(() => undefined);
	await removeIsolatedProfile(isolatedProfile);
}

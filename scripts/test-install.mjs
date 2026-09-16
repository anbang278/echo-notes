import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { createInstaller } from "./lib/test-install.mjs";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vault = "/Users/anbang/笔记/Develop-obsidian";
const installer = createInstaller({
	root: "/Users/anbang/.local/share/echo-notes",
	install: path.join(vault, ".obsidian/plugins/echo-notes"),
	legacySource: path.join(vault, "插件开发/Echo Notes")
});
function cli(...args) {
	return execFileSync("obsidian", ["vault=Develop-obsidian", ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
}
function pluginState() {
	const response = cli("eval", 'code=JSON.stringify({path:app.vault.adapter.getBasePath(),enabled:app.plugins.enabledPlugins.has("echo-notes"),loaded:!!app.plugins.plugins["echo-notes"]})');
	const line = response.split("\n").find((v) => v.trim().startsWith("=> {"));
	if (!line) throw new Error("无法确认测试 Vault 与插件状态；请关闭 Develop-obsidian 测试库并联系执行 agent 核查，禁止默认操作其他 Vault");
	const state = JSON.parse(line.slice(line.indexOf("{")).trim());
	if (state.path !== vault || typeof state.enabled !== "boolean" || typeof state.loaded !== "boolean") throw new Error("测试 Vault 身份不匹配");
	return state;
}
async function withPausedPlugin(action) {
	const initial = pluginState();
	let result;
	let failure;
	try {
		if (initial.loaded || initial.enabled) cli("plugin:disable", "id=echo-notes", "filter=community");
		const paused = pluginState();
		if (paused.loaded || paused.enabled) throw new Error("Echo Notes 未成功暂停，不能迁移或回退");
		result = await action();
	} catch (error) { failure = error; }
	try {
		// 只恢复本次目标插件的原启用状态，不读取配置内容或重启整个应用。
		pluginState();
		const health = await installer.status();
		if (health.state === "interrupted" || health.state === "busy") throw new Error("安装事务尚未恢复，保持插件暂停，请先运行 rollback");
		if (initial.enabled) {
			cli("plugin:enable", "id=echo-notes", "filter=community");
			if (!pluginState().loaded) throw new Error("目录操作后插件未成功恢复，请在 Develop-obsidian 中手动启用 Echo Notes");
		}
	} catch (restore) {
		throw new Error(`${failure ? `目录操作失败：${failure.message}；` : ""}恢复插件启用状态失败：${restore.message}`, { cause: restore });
	}
	if (failure) throw failure;
	return result;
}
function options(args) {
	const values = {};
	for (let index = 0; index < args.length; index += 2) {
		const key = args[index];
		if (!["--task", "--zip"].includes(key) || !args[index + 1] || values[key]) throw new Error("参数格式：deploy --task <任务目录> --zip <ZIP>");
		values[key] = args[index + 1];
	}
	return values;
}
try {
	const [command, ...args] = process.argv.slice(2);
	let result;
	if (command === "deploy") {
		const values = options(args);
		if (!values["--task"] || !values["--zip"]) throw new Error("deploy 需要 --task 和 --zip");
		result = await installer.deploy({ project, task: path.resolve(values["--task"]), zip: path.resolve(values["--zip"]) });
	} else if (["migrate", "status", "rollback"].includes(command) && args.length === 0) {
		result = command === "status" ? await installer.status() : await withPausedPlugin(() => installer[command]());
	} else throw new Error("用法：npm run test-install -- migrate | deploy --task <目录> --zip <ZIP> | status | rollback");
	console.log(JSON.stringify(result, null, 2));
} catch (error) {
	console.error(`测试插件操作失败：${error.message}`);
	process.exitCode = 1;
}

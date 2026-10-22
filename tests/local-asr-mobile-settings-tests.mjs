import assert from "node:assert/strict";
import vm from "node:vm";
import esbuild from "esbuild";

class Element {
	constructor(tag = "div", options = {}) {
		this.tag = tag;
		this.cls = options.cls ?? "";
		this.text = options.text ?? "";
		this.children = [];
	}
	createDiv(options) { return this.createEl("div", options); }
	createEl(tag, options) {
		const child = new Element(tag, options);
		this.children.push(child);
		return child;
	}
}
class MobileSetting {
	constructor(parent) { this.element = parent.createEl("div"); }
	setName(text) { this.element.text = text; return this; }
	setHeading() { return this; }
}
const obsidian = new Proxy({ Platform: { isMobile: true }, Setting: MobileSetting }, {
	get: (target, key) => key in target ? target[key] : class {}
});
const result = await esbuild.build({
	entryPoints: ["src/settings/settings-tab.ts"], bundle: true, write: false,
	platform: "node", format: "cjs", external: ["obsidian"], logLevel: "silent"
});
const module = { exports: {} };
const context = vm.createContext({
	module, exports: module.exports,
	require: (name) => {
		assert.equal(name, "obsidian", "移动设置模块不应加载Node执行模块");
		return obsidian;
	},
	URL, TextEncoder, TextDecoder, console
});
vm.runInContext(result.outputFiles[0].text, context);
const tab = Object.create(module.exports.EchoNotesSettingTab.prototype);
let storageCalls = 0;
tab.plugin = { app: {
	loadLocalStorage() { storageCalls++; throw new Error("移动端不应访问启停配置"); },
	saveLocalStorage() { storageCalls++; throw new Error("移动端不应保存启停配置"); }
} };
const root = new Element();
tab.renderLocalAsrLifecycleSection(root, { provider: "local-openai-compatible", baseUrl: "http://127.0.0.1:9000/v1" });
const flatten = (node) => [node, ...node.children.flatMap(flatten)];
const nodes = flatten(root);
assert(nodes.some((node) => node.text === "仅桌面端支持目录识别与自动启停"));
assert(nodes.some((node) => node.text.includes("当前设备不会读取目录或执行命令")));
assert(!nodes.some((node) => ["input", "button"].includes(node.tag)));
assert(!nodes.some((node) => node.cls.includes("echo-notes-local-asr-fields")));
assert.equal(storageCalls, 0);
console.log("Mobile ASR settings runtime mock passed.");

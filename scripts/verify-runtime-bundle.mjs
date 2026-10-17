import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import ts from "typescript";

const bundlePath = process.argv[2] ?? "main.js";
const source = await readFile(bundlePath, "utf8");
const nodeDynamicImports = Array.from(
	source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
	(match) => match[2]
).filter((specifier) => isBuiltin(specifier));
if (nodeDynamicImports.length > 0) throw new Error(`运行时产物仍包含 Node 内置模块动态导入：${[...new Set(nodeDynamicImports)].join(", ")}`);

// The local streaming provider explicitly needs one lazy desktop fs adapter.
// Preserve the mobile/module-load boundary: no top-level fs import or other fs access path.
const fsPattern = /\b(?:require|import)\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g;
const filesystemLoads = Array.from(source.matchAll(fsPattern));
if (filesystemLoads.length !== 1) throw new Error(`运行时应只有一个桌面本地流式读盘入口，实际 ${filesystemLoads.length}`);

// The local ASR lifecycle adapter is the single allowed lazy child_process/os entry.
// Everything else must stay off Node process-spawning paths in the shipped bundle.
const childProcessPattern = /\brequire\(\s*["']child_process["']\s*\)/g;
const childProcessLoads = Array.from(source.matchAll(childProcessPattern));
if (childProcessLoads.length !== 1) throw new Error(`运行时应只有一个本地 ASR 惰性 child_process 入口，实际 ${childProcessLoads.length}`);
const config = ts.readConfigFile("tsconfig.json", ts.sys.readFile).config;
const files = ts.parseJsonConfigFileContent(config, ts.sys, process.cwd()).fileNames.filter(file => file.endsWith(".ts"));
let approvedLoads = 0;
let approvedCommandLoads = 0;
for (const file of files) {
	const text = await readFile(file, "utf8");
	const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
	function visit(node) {
		const specifier = ts.isImportDeclaration(node) ? node.moduleSpecifier
			: ts.isCallExpression(node) ? node.arguments[0] : undefined;
		if (specifier && ts.isStringLiteral(specifier) && /^(?:node:)?fs(?:\/promises)?$/.test(specifier.text)) {
			let scope = node.parent;
			while (scope && !ts.isFunctionDeclaration(scope)) scope = scope.parent;
			if (!file.endsWith("/src/network/local-desktop-files.ts") || !ts.isCallExpression(node) || scope?.name?.text !== "createDesktopFiles") {
				throw new Error(`文件系统能力越过桌面流式适配器边界：${file}`);
			}
			approvedLoads++;
		}
		if (specifier && ts.isStringLiteral(specifier) && (specifier.text === "child_process" || specifier.text === "os")) {
			if (!file.endsWith("/src/local-asr/desktop-command-adapter.ts") || !ts.isCallExpression(node)) {
				throw new Error(`进程能力越过本地 ASR 命令适配器边界：${file}`);
			}
			approvedCommandLoads++;
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
}
if (approvedLoads !== 1) throw new Error("缺少唯一明确的桌面文件系统入口");
if (approvedCommandLoads < 2) throw new Error("缺少本地 ASR 命令适配器的 child_process/os 惰性入口");
console.log(`运行时模块检查通过：一个惰性桌面流式读盘入口与本地 ASR 命令适配器，无 Node 动态 import：${bundlePath}`);

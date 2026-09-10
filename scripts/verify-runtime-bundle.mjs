import { readFile } from "node:fs/promises";
import { isBuiltin } from "node:module";

const bundlePath = process.argv[2] ?? "main.js";
const source = await readFile(bundlePath, "utf8");
const nodeDynamicImports = Array.from(
	source.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g),
	(match) => match[2]
).filter((specifier) => isBuiltin(specifier));

if (nodeDynamicImports.length > 0) {
	throw new Error(
		`运行时产物仍包含 Node 内置模块动态导入：${Array.from(new Set(nodeDynamicImports)).join(", ")}`
	);
}

const filesystemLoads = Array.from(
	source.matchAll(/\b(?:require|import)\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/g),
	(match) => match[0]
);

if (filesystemLoads.length > 0) {
	throw new Error(`运行时产物不应加载 Node 文件系统模块：${Array.from(new Set(filesystemLoads)).join(", ")}`);
}

console.log(`运行时产物模块加载检查通过，未发现 Node 文件系统模块：${bundlePath}`);

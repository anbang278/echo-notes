import esbuild from "esbuild";
import { builtinModules } from "node:module";
import process from "node:process";

const production = process.argv[2] === "production";
const builtins = [...builtinModules, ...builtinModules.map((moduleName) => `node:${moduleName}`)];

const banner =
`/*
此文件由 esbuild 生成，请修改 src/ 下的源文件。
*/`;

const context = await esbuild.context({
	banner: {
		js: banner
	},
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		...builtins
	],
	format: "cjs",
	// Obsidian 桌面端使用 CommonJS 插件宿主。桌面专用依赖 ws 需选择 Node 入口，
	// AgentPlan Provider 会在移动端守卫通过后再延迟加载该依赖。
	platform: "node",
	mainFields: ["main", "module"],
	target: "es2018",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: production
});

if (production) {
	await context.rebuild();
	await context.dispose();
} else {
	await context.watch();
}

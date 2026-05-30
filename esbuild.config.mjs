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

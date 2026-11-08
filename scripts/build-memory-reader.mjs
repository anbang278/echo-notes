import esbuild from "esbuild";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "skills/echo-notes-memory/scripts/echo-memory.mjs");
await mkdir(path.dirname(target), { recursive: true });
await esbuild.build({
	entryPoints: [path.join(root, "src/agent-memory/node/cli.ts")],
	outfile: target,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	minify: false,
	legalComments: "eof",
	banner: { js: "#!/usr/bin/env node\n// Generated from the shared Echo Notes reader. Node.js 22 or newer." }
});
console.log("Built the self-contained Echo Notes memory reader.");

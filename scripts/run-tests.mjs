import esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";

await rm(".tmp", { force: true, recursive: true });
await mkdir(".tmp", { recursive: true });

await esbuild.build({
	entryPoints: ["tests/smoke-tests.ts"],
	bundle: true,
	format: "esm",
	platform: "node",
	outfile: ".tmp/smoke-tests.mjs",
	logLevel: "silent"
});

await import(pathToFileURL(`${process.cwd()}/.tmp/smoke-tests.mjs`).href);
await import(pathToFileURL(`${process.cwd()}/tests/local-audio-dataset-tests.mjs`).href);

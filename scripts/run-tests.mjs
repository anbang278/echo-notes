import { execFileSync } from "node:child_process";
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

for (const name of ["local-mlx-jobs-tests", "local-streaming-tests", "local-task-lifecycle-tests", "local-asr-lifecycle-tests"]) {
	await esbuild.build({ entryPoints: [`tests/${name}.ts`], bundle: true, format: "esm", platform: "node", outfile: `.tmp/${name}.mjs`, logLevel: "silent" });
	if (name === "local-task-lifecycle-tests") {
		execFileSync(process.execPath, ["--input-type=module", "-e", "const tests = await import(process.argv[1]); await tests.runLocalTaskLifecycleTests();", pathToFileURL(`${process.cwd()}/.tmp/${name}.mjs`).href], { stdio: "inherit" });
	} else if (name === "local-asr-lifecycle-tests") {
		execFileSync(process.execPath, ["--input-type=module", "-e", "const tests = await import(process.argv[1]); tests.runLocalAsrSettingsTests(); await tests.runLocalAsrManagerTests(); console.log('Local ASR lifecycle tests passed.');", pathToFileURL(`${process.cwd()}/.tmp/${name}.mjs`).href], { stdio: "inherit" });
	} else {
		execFileSync(process.execPath, ["--test", `.tmp/${name}.mjs`], { stdio: "inherit" });
	}
}

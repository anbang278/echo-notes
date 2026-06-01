import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));

if (packageJson.version !== manifest.version) {
	throw new Error(`版本不一致：package.json=${packageJson.version}, manifest.json=${manifest.version}`);
}

const version = packageJson.version;
const distDir = "dist";
const stagingDir = join(distDir, "echo-notes");
const zipPath = join(distDir, `echo-notes-${version}.zip`);
const releaseFiles = ["main.js", "manifest.json", "styles.css"];

await rm(distDir, { recursive: true, force: true });
await mkdir(stagingDir, { recursive: true });

for (const file of releaseFiles) {
	await copyFile(file, join(stagingDir, file));
}

await run("zip", ["-r", `../echo-notes-${version}.zip`, ...releaseFiles], stagingDir);

console.log(`Release package created: ${zipPath}`);

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd,
			stdio: "inherit"
		});

		child.on("error", reject);
		child.on("exit", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} exited with code ${code}`));
			}
		});
	});
}

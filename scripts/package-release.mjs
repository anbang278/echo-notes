import { copyFile, mkdir, readFile, rm, lstat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";

import { json, validateVerification, sha256, writeJson } from "./lib/delivery-evidence.mjs";

const verification = await json("output/verification/latest.json");
await validateVerification(process.cwd(), verification);

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

const skillFiles = ["SKILL.md", "scripts/echo-memory.mjs", "references/setup.md", "references/query-contract.md", "references/provenance.md"];
const skillDirectory = join(distDir, "echo-notes-memory");
const skillZipPath = join(distDir, `echo-notes-memory-${version}.zip`);
const skillHashes = {};
for (const file of skillFiles) {
	const source = join("skills/echo-notes-memory", file);
	const info = await lstat(source);
	if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Skill 包只接受普通文件：${file}`);
	const destination = join(skillDirectory, file);
	await mkdir(dirname(destination), { recursive: true });
	await copyFile(source, destination);
	skillHashes[file] = sha256(await readFile(destination));
}
await run("zip", ["-r", `echo-notes-memory-${version}.zip`, "echo-notes-memory"], distDir);
await writeJson(join(distDir, "skill-evidence.json"), { schemaVersion: 1, version, source: verification.source, fileHashes: skillHashes, zipSha256: sha256(await readFile(skillZipPath)) });
console.log(`独立 Skill 包已生成：${skillZipPath}`);

await writeJson(join(distDir, "verification.json"), verification);
await writeJson(join(distDir, "package-evidence.json"), {
 schemaVersion: 1, version, source: verification.source,
 fileHashes: verification.fileHashes, zipSha256: sha256(await readFile(zipPath)),
 verificationSha256: sha256(await readFile(join(distDir, "verification.json")))
});
console.log(`测试包已生成：${zipPath}`);

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

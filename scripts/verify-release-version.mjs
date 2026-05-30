import { readFile } from "node:fs/promises";

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
	throw new Error("GITHUB_REF_NAME is required.");
}

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
const packageJson = JSON.parse(await readFile("package.json", "utf8"));

if (manifest.version !== packageJson.version) {
	throw new Error(`Version mismatch: manifest ${manifest.version}, package ${packageJson.version}.`);
}

if (manifest.version !== tag) {
	throw new Error(`Tag ${tag} does not match manifest version ${manifest.version}.`);
}

console.log(`Release version verified: ${tag}`);

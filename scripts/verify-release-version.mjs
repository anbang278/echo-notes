import { readFile } from "node:fs/promises";

const tag = process.env.GITHUB_REF_NAME;
if (!tag) {
	throw new Error("GITHUB_REF_NAME is required.");
}

const [manifest, packageJson, packageLock, versions] = await Promise.all([
	readJson("manifest.json"),
	readJson("package.json"),
	readJson("package-lock.json"),
	readJson("versions.json")
]);

const releaseVersion = manifest.version;
const versionValues = {
	"package.json": packageJson.version,
	"package-lock.json": packageLock.version,
	"package-lock.json root package": packageLock.packages?.[""]?.version,
	"manifest.json": releaseVersion
};
const mismatchedVersions = Object.entries(versionValues)
	.filter(([, version]) => version !== releaseVersion);
if (mismatchedVersions.length > 0) {
	throw new Error(
		`Version mismatch: ${Object.entries(versionValues).map(([file, version]) => `${file}=${version ?? "missing"}`).join(", ")}.`
	);
}
if (versions[releaseVersion] !== manifest.minAppVersion) {
	throw new Error(
		`versions.json mismatch: ${releaseVersion}=${versions[releaseVersion] ?? "missing"}, manifest.minAppVersion=${manifest.minAppVersion}.`
	);
}

if (releaseVersion !== tag) {
	throw new Error(`Tag ${tag} does not match manifest version ${releaseVersion}.`);
}

console.log(`Release version verified: ${tag}`);

async function readJson(fileName) {
	return JSON.parse(await readFile(fileName, "utf8"));
}

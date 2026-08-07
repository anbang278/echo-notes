import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	isPathInsideOrEqual,
	loadLocalAudioDataset,
	PROTECTED_VAULT_DIRS_ENV,
	resolveLocalAudioDatasetRoot,
	selectLocalAudioDatasetCases
} from "../scripts/local-audio-dataset.mjs";
import {
	probeAudioBytes,
	shouldCheckGitIgnore
} from "../scripts/verify-local-audio-dataset.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "echo-notes-audio-dataset-test-"));

try {
	const audioBytes = Uint8Array.from([0, 1, 2, 3, 4]);
	const sha256 = createHash("sha256").update(audioBytes).digest("hex");
	const validRoot = path.join(temporaryRoot, "valid");
	await mkdir(validRoot, { recursive: true });
	await writeFile(path.join(validRoot, "样本(1).m4a"), audioBytes);
	await writeManifest(validRoot, {
		schemaVersion: 1,
		cases: [
			{
				id: "unicode-name",
				file: "样本(1).m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: ["smoke", "unicode"]
			}
		]
	});
	const dataset = await loadLocalAudioDataset({ root: validRoot, projectRoot: temporaryRoot });
	assert.equal(dataset.cases.length, 1);
	assert.equal(selectLocalAudioDatasetCases(dataset, ["smoke"])[0].id, "unicode-name");
	assert.equal(selectLocalAudioDatasetCases(dataset, ["unicode-name"])[0].file, "样本(1).m4a");
	assert.equal(selectLocalAudioDatasetCases(dataset, ["all"]).length, 1);
	assert.throws(() => selectLocalAudioDatasetCases(dataset, ["missing"]), /没有匹配/);
	assert.deepEqual(dataset.cases[0].verifiedBytes, Buffer.from(audioBytes));

	await writeFile(path.join(validRoot, "样本(1).m4a"), Uint8Array.from([4, 3, 2, 1, 0]));
	assert.deepEqual(dataset.cases[0].verifiedBytes, Buffer.from(audioBytes));
	await writeFile(path.join(validRoot, "样本(1).m4a"), audioBytes);
	assert.equal(isPathInsideOrEqual(temporaryRoot, path.join(temporaryRoot, "..audio")), true);
	assert.equal(isPathInsideOrEqual(temporaryRoot, path.dirname(temporaryRoot)), false);
	assert.equal(shouldCheckGitIgnore(temporaryRoot, path.join(temporaryRoot, "..data", "sample.m4a")), true);
	assert.equal(shouldCheckGitIgnore(temporaryRoot, path.dirname(temporaryRoot)), false);

	const traversalRoot = path.join(temporaryRoot, "traversal");
	await mkdir(traversalRoot, { recursive: true });
	await writeManifest(traversalRoot, {
		schemaVersion: 1,
		cases: [
			{
				id: "traversal",
				file: "../outside.m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: []
			}
		]
	});
	await assert.rejects(
		loadLocalAudioDataset({ root: traversalRoot, projectRoot: temporaryRoot }),
		/路径越界/
	);

	const symlinkRoot = path.join(temporaryRoot, "symlink");
	await mkdir(symlinkRoot, { recursive: true });
	await symlink(path.join(validRoot, "样本(1).m4a"), path.join(symlinkRoot, "linked.m4a"));
	await writeManifest(symlinkRoot, {
		schemaVersion: 1,
		cases: [
			{
				id: "linked",
				file: "linked.m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: []
			}
		]
	});
	await assert.rejects(
		loadLocalAudioDataset({ root: symlinkRoot, projectRoot: temporaryRoot }),
		/不能是符号链接/
	);

	const manifestSymlinkRoot = path.join(temporaryRoot, "manifest-symlink");
	await mkdir(manifestSymlinkRoot, { recursive: true });
	await writeFile(path.join(manifestSymlinkRoot, "sample.m4a"), audioBytes);
	await writeManifest(manifestSymlinkRoot, {
		schemaVersion: 1,
		cases: [
			{
				id: "manifest-linked",
				file: "sample.m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: []
			}
		]
	}, "manifest-target.json");
	await symlink("manifest-target.json", path.join(manifestSymlinkRoot, "manifest.json"));
	await assert.rejects(
		loadLocalAudioDataset({ root: manifestSymlinkRoot, projectRoot: temporaryRoot }),
		/数据集清单.*符号链接/
	);

	for (const [name, mimeType, expected, errorPattern] of [
		["mime-crlf", "audio/mp4\r\nContent-Type: multipart/form-data", undefined, /MIME 类型非法/],
		["mime-parameter", "audio/mp4; boundary=unsafe", undefined, /MIME 类型非法/],
		["expected-string", "audio/mp4", "invalid", /预期条件非法/],
		["duration-string", "audio/mp4", { durationSeconds: "1" }, /预期时长非法/],
		["duration-null", "audio/mp4", { durationSeconds: null }, /预期时长非法/],
		["tolerance-string", "audio/mp4", { durationSeconds: 1, durationToleranceSeconds: "0.2" }, /时长容差非法/],
		["tolerance-negative", "audio/mp4", { durationSeconds: 1, durationToleranceSeconds: -0.1 }, /时长容差非法/]
	]) {
		const invalidRoot = path.join(temporaryRoot, name);
		await mkdir(invalidRoot, { recursive: true });
		await writeFile(path.join(invalidRoot, "sample.m4a"), audioBytes);
		await writeManifest(invalidRoot, {
			schemaVersion: 1,
			cases: [
				{
					id: name,
					file: "sample.m4a",
					bytes: audioBytes.byteLength,
					sha256,
					mimeType,
					tags: [],
					...(expected === undefined ? {} : { expected })
				}
			]
		});
		await assert.rejects(
			loadLocalAudioDataset({ root: invalidRoot, projectRoot: temporaryRoot }),
			errorPattern
		);
	}

	for (const [name, fileName] of [
		["filename-crlf", "sample.m4a\r\nX-Injected: true"],
		["filename-quote", 'sample".m4a'],
		["filename-control", "sample\u0001.m4a"]
	]) {
		const invalidRoot = path.join(temporaryRoot, name);
		await mkdir(invalidRoot, { recursive: true });
		await writeManifest(invalidRoot, {
			schemaVersion: 1,
			cases: [
				{
					id: name,
					file: fileName,
					bytes: audioBytes.byteLength,
					sha256,
					mimeType: "audio/mp4",
					tags: []
				}
			]
		});
		await assert.rejects(
			loadLocalAudioDataset({ root: invalidRoot, projectRoot: temporaryRoot }),
			/文件名非法/
		);
	}

	const projectRoot = path.join(temporaryRoot, "project");
	const externalRoot = path.join(temporaryRoot, "external-audio");
	await mkdir(projectRoot, { recursive: true });
	await mkdir(externalRoot, { recursive: true });
	await writeFile(path.join(externalRoot, "sample.m4a"), audioBytes);
	await writeManifest(externalRoot, {
		schemaVersion: 1,
		cases: [
			{
				id: "external",
				file: "sample.m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: []
			}
		]
	});
	const fakeBin = path.join(temporaryRoot, "bin");
	const fakeFfprobe = path.join(fakeBin, "ffprobe");
	await mkdir(fakeBin, { recursive: true });
	await writeFile(
		fakeFfprobe,
		"#!/bin/sh\ncase \" $* \" in *\" format=duration:stream=codec_type,codec_name,channels \"*\" -i pipe:0 \"*) ;; *) exit 64 ;; esac\nreceived=\"$(wc -c | tr -d ' ')\"\n[ \"$received\" = \"$ECHO_TEST_EXPECTED_BYTES\" ] || exit 65\nprintf '%s\\n' \"$ECHO_TEST_FFPROBE_OUTPUT\"\n"
	);
	await chmod(fakeFfprobe, 0o755);
	const ffprobeEnvironment = {
		...process.env,
		ECHO_NOTES_AUDIO_DATASET_DIR: externalRoot,
		[PROTECTED_VAULT_DIRS_ENV]: "",
		ECHO_TEST_EXPECTED_BYTES: String(audioBytes.byteLength),
		PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
	};
	const { stdout: externalVerificationOutput } = await execFileAsync(
		process.execPath,
		["scripts/verify-local-audio-dataset.mjs"],
		{
			cwd: repositoryRoot,
			env: {
				...ffprobeEnvironment,
				ECHO_TEST_FFPROBE_OUTPUT: JSON.stringify({
					streams: [
						{ codec_type: "video", codec_name: "h264" },
						{ codec_type: "audio", codec_name: "aac", channels: 2 }
					],
					format: { duration: "1.0" }
				})
			}
		}
	);
	assert.match(externalVerificationOutput, /本地音频数据集离线校验通过/);
	assert.match(externalVerificationOutput, /aac/);
	await withEnvironment(
		{
			ECHO_TEST_EXPECTED_BYTES: String(audioBytes.byteLength),
			ECHO_TEST_FFPROBE_OUTPUT: JSON.stringify({
				streams: [{ codec_type: "audio", codec_name: "aac", channels: 1 }],
				format: { duration: "1.0" }
			}),
			PATH: ffprobeEnvironment.PATH
		},
		async () => {
			const verifiedProbe = await probeAudioBytes(dataset.cases[0].verifiedBytes, "verified-buffer");
			assert.equal(verifiedProbe.codec, "aac");
		}
	);
	await assert.rejects(
		execFileAsync(process.execPath, ["scripts/verify-local-audio-dataset.mjs"], {
			cwd: repositoryRoot,
			env: {
				...ffprobeEnvironment,
				ECHO_TEST_FFPROBE_OUTPUT: JSON.stringify({
					streams: [{ codec_type: "video", codec_name: "h264" }],
					format: { duration: "1.0" }
				})
			}
		}),
		/音频元数据不完整/
	);
	await assert.rejects(
		execFileAsync(process.execPath, ["scripts/verify-local-audio-dataset.mjs"], {
			cwd: repositoryRoot,
			env: {
				...ffprobeEnvironment,
				ECHO_TEST_FFPROBE_OUTPUT: "not-json"
			}
		}),
		/JSON 无效/
	);

	await withEnvironment(
		{
			ECHO_NOTES_AUDIO_DATASET_DIR: path.join(os.homedir(), "笔记", "lifeos-obsidian", "audio"),
			[PROTECTED_VAULT_DIRS_ENV]: undefined
		},
		async () => {
			assert.throws(() => resolveLocalAudioDatasetRoot(projectRoot), /受保护 Vault/);
		}
	);

	const additionalProtectedVault = path.join(temporaryRoot, "protected-vault");
	const protectedVaultAlias = path.join(temporaryRoot, "protected-vault-alias");
	await mkdir(path.join(additionalProtectedVault, "audio"), { recursive: true });
	const protectedSample = path.join(additionalProtectedVault, "audio", "protected.m4a");
	await writeFile(protectedSample, audioBytes);
	await symlink(additionalProtectedVault, protectedVaultAlias);
	await withEnvironment(
		{
			ECHO_NOTES_AUDIO_DATASET_DIR: path.join(additionalProtectedVault, "audio"),
			[PROTECTED_VAULT_DIRS_ENV]: additionalProtectedVault
		},
		async () => {
			assert.throws(() => resolveLocalAudioDatasetRoot(projectRoot), /受保护 Vault/);
			await assert.rejects(
				loadLocalAudioDataset({ root: path.join(additionalProtectedVault, "audio"), projectRoot }),
				/受保护 Vault/
			);
		}
	);

	const protectedDotDotAudio = path.join(additionalProtectedVault, "..audio");
	await mkdir(protectedDotDotAudio, { recursive: true });
	await writeFile(path.join(protectedDotDotAudio, "sample.m4a"), audioBytes);
	await writeManifest(protectedDotDotAudio, {
		schemaVersion: 1,
		cases: [
			{
				id: "protected-dot-dot-prefix",
				file: "sample.m4a",
				bytes: audioBytes.byteLength,
				sha256,
				mimeType: "audio/mp4",
				tags: []
			}
		]
	});
	await withEnvironment(
		{
			ECHO_NOTES_AUDIO_DATASET_DIR: protectedDotDotAudio,
			[PROTECTED_VAULT_DIRS_ENV]: additionalProtectedVault
		},
		async () => {
			assert.throws(
				() => resolveLocalAudioDatasetRoot(projectRoot),
				/受保护 Vault/
			);
			await assert.rejects(
				loadLocalAudioDataset({ root: protectedDotDotAudio, projectRoot }),
				/受保护 Vault/
			);
		}
	);
	await withEnvironment(
		{
			ECHO_NOTES_AUDIO_DATASET_DIR: path.join(protectedVaultAlias, "audio"),
			[PROTECTED_VAULT_DIRS_ENV]: additionalProtectedVault
		},
		async () => {
			assert.throws(() => resolveLocalAudioDatasetRoot(projectRoot), /受保护 Vault/);
			await assert.rejects(
				loadLocalAudioDataset({ root: path.join(protectedVaultAlias, "audio"), projectRoot }),
				/受保护 Vault/
			);
		}
	);

	const protectedParent = path.join(temporaryRoot, "protected-parent");
	const protectedParentAlias = path.join(temporaryRoot, "protected-parent-alias");
	await mkdir(path.join(protectedParent, "vault", "audio"), { recursive: true });
	await symlink(protectedParent, protectedParentAlias);
	await withEnvironment(
		{
			ECHO_NOTES_AUDIO_DATASET_DIR: path.join(protectedParent, "vault", "audio"),
			[PROTECTED_VAULT_DIRS_ENV]: path.join(protectedParentAlias, "vault")
		},
		async () => {
			assert.throws(() => resolveLocalAudioDatasetRoot(projectRoot), /受保护 Vault/);
		}
	);

	console.log("本地音频数据集加载器测试通过。");
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

async function writeManifest(root, manifest, fileName = "manifest.json") {
	await writeFile(path.join(root, fileName), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function withEnvironment(values, callback) {
	const originalValues = new Map(Object.keys(values).map((name) => [name, process.env[name]]));
	try {
		for (const [name, value] of Object.entries(values)) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		await callback();
	} finally {
		for (const [name, value] of originalValues) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
	}
}

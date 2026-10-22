import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as paths from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { createDesktopAsrDiscovery, ASR_SCAN_LIMITS, type DiscoveryRuntime } from "../src/local-asr/desktop-discovery-adapter";
import { MLX_LIFECYCLE_SIGNATURES, quotePosixArgument } from "../src/local-asr/discovery-rules";

const baseUrl = "http://127.0.0.1:29181/v1";
function runtime(overrides: Partial<typeof fs.promises> = {}, platform = "darwin", arch = "arm64"): DiscoveryRuntime {
	return { schedule(action, milliseconds) { const timer = setTimeout(action, milliseconds); return () => clearTimeout(timer); }, require(name) {
		switch (name) {
			case "fs": return { ...fs, promises: { ...fs.promises, ...overrides } };
			case "path": return paths;
			case "os": return { ...os, platform: () => platform, arch: () => arch };
			case "crypto": return crypto;
			default: throw new Error(`Unexpected runtime capability: ${name}`);
		}
	} };
}
async function fixture(run: (root: string) => Promise<void>): Promise<void> {
	const root = await fs.promises.realpath(await fs.promises.mkdtemp(paths.join(os.tmpdir(), "echo-discovery-test-")));
	try { await run(root); } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
}
async function paired(root: string): Promise<void> {
	await fs.promises.mkdir(paths.join(root, ".venv/bin"), { recursive: true });
	for (const [name, hash] of Object.entries(MLX_LIFECYCLE_SIGNATURES)) {
		const source = await fs.promises.readFile(paths.join(process.cwd(), "integrations/local-mlx-asr", name));
		assert.equal(crypto.createHash("sha256").update(source).digest("hex"), hash, "pinned recipe must match reviewed source");
		await fs.promises.writeFile(paths.join(root, name), source);
	}
	await fs.promises.writeFile(paths.join(root, "service.py"), "# Synthetic service: never executed\n");
	await fs.promises.writeFile(paths.join(root, ".venv/bin/python"), "synthetic interpreter");
	await fs.promises.chmod(paths.join(root, ".venv/bin/python"), 0o755);
	await fs.promises.writeFile(paths.join(root, "bundle-manifest.json"), JSON.stringify({ service_version: "2.0.0", files: MLX_LIFECYCLE_SIGNATURES }));
}

test("paired install is recognized at an arbitrary path with safe quoting and current port", async () => {
	await fixture(async root => {
		const dir = paths.join(root, "中文 ' $模型 `literal`"); await paired(dir);
		const result = await createDesktopAsrDiscovery(runtime()).scan(dir, baseUrl);
		assert.equal(result.candidates.length, 1);
		const candidate = result.candidates[0]; assert.equal(candidate.complete, true);
		assert.equal(candidate.fields.workingDirectory.value, dir);
		assert.equal(candidate.fields.readinessUrl.value, "http://127.0.0.1:29181/health");
		assert.equal(candidate.fields.stopCommand.value, `/bin/sh ${quotePosixArgument(`${dir}/stop.sh`)} --root ${quotePosixArgument(dir)} --port 29181`);
		assert.equal(quotePosixArgument("a'b $`"), "'a'\\''b $`'");
		assert.ok(result.bytes <= ASR_SCAN_LIMITS.totalBytes);
	});
});

test("multiple installations, missing interpreter, changed scripts and unsupported platforms remain distinct", async () => {
	await fixture(async root => {
		await paired(paths.join(root, "a")); await paired(paths.join(root, "b"));
		const service = createDesktopAsrDiscovery(runtime());
		assert.equal((await service.scan(root, baseUrl)).candidates.filter(c => c.complete).length, 2);
		await fs.promises.rm(paths.join(root, "a/.venv/bin/python"));
		let result = await service.scan(root, baseUrl); assert.equal(result.candidates.filter(c => c.complete).length, 1);
		assert.match(result.candidates.find(c => c.directory.endsWith("/a"))!.issues.join(" "), /python/);
		result = await createDesktopAsrDiscovery(runtime({}, "win32", "x64")).scan(root, baseUrl);
		assert.ok(result.candidates.every(c => !c.complete && !c.fields.stopCommand.value));
		await fs.promises.appendFile(paths.join(root, "b/start.sh"), "\n# modified\n");
		assert.ok((await service.scan(root, baseUrl)).candidates.every(c => !c.complete));
	});
});

test("untrusted manifests and generic script names never prove a safe stop command", async () => {
	await fixture(async root => {
		await paired(root);
		await fs.promises.writeFile(paths.join(root, "bundle-manifest.json"), JSON.stringify({ files: {} }));
		assert.equal((await createDesktopAsrDiscovery(runtime()).scan(root, baseUrl)).candidates[0].complete, false);
		await fs.promises.writeFile(paths.join(root, "start.sh"), "echo should-not-run > marker\n");
		await fs.promises.writeFile(paths.join(root, "stop.sh"), "pkill -f python\n");
		await fs.promises.writeFile(paths.join(root, "README.md"), "# 启动\n```sh\npython -m example_asr.server\n```\n# 停止\n```sh\npkill python\n```\n");
		const candidate = (await createDesktopAsrDiscovery(runtime()).scan(root, baseUrl)).candidates[0];
		assert.equal(candidate.fields.startCommand.status, "candidate");
		assert.equal(candidate.fields.startCommand.value, "python -m example_asr.server");
		assert.equal(candidate.fields.stopCommand.value, ""); assert.equal(candidate.fields.readinessUrl.value, "");
		assert.equal(fs.existsSync(paths.join(root, "marker")), false);
	});
});

test("excluded directories and internal symlinks are never read; interpreter link is stat-only", async () => {
	await fixture(async root => {
		const dir = paths.join(root, "install"); await paired(dir);
		const secret = paths.join(root, "outside.txt"); await fs.promises.writeFile(secret, "unrelated private bytes");
		await fs.promises.symlink(secret, paths.join(dir, "launch.sh"));
		await fs.promises.symlink(root, paths.join(dir, "outside-dir"));
		await fs.promises.mkdir(paths.join(dir, "models")); await fs.promises.writeFile(paths.join(dir, "models/start.sh"), "ignored");
		await fs.promises.writeFile(paths.join(dir, ".env"), "ignored-secret");
		const opened: string[] = [];
		const io = runtime({ open: async (...args: Parameters<typeof fs.promises.open>) => { opened.push(String(args[0])); return fs.promises.open(...args); } });
		let result = await createDesktopAsrDiscovery(io).scan(dir, baseUrl); assert.equal(result.candidates[0].complete, true);
		assert.ok(opened.every(path => path.startsWith(dir) && !path.includes("/models/") && !path.includes(".venv") && !path.endsWith("launch.sh") && !path.endsWith(".env")));
		await fs.promises.rm(paths.join(dir, ".venv/bin/python"));
		await fs.promises.chmod(secret, 0o755); await fs.promises.symlink(secret, paths.join(dir, ".venv/bin/python"));
		result = await createDesktopAsrDiscovery(io).scan(dir, baseUrl); assert.equal(result.candidates[0].complete, true);
		assert.ok(!opened.includes(secret));
		const selectedLink = paths.join(root, "selected-link"); await fs.promises.symlink(dir, selectedLink);
		result = await createDesktopAsrDiscovery(io).scan(selectedLink, baseUrl);
		assert.equal(result.root, dir); assert.equal(result.candidates[0].complete, true);
	});
});

test("depth, entry, file size and total bytes limits are enforced", async () => {
	await fixture(async root => {
		await paired(paths.join(root, "a/b/c/d"));
		let result = await createDesktopAsrDiscovery(runtime()).scan(root, baseUrl);
		assert.equal(result.candidates.length, 0); assert.match(result.issues.join(" "), /深度/);
		await paired(root);
		result = await createDesktopAsrDiscovery(runtime(), { ...ASR_SCAN_LIMITS, entries: 2 }).scan(root, baseUrl);
		assert.equal(result.entries, 2); assert.match(result.issues.join(" "), /上限/);
		result = await createDesktopAsrDiscovery(runtime(), { ...ASR_SCAN_LIMITS, fileBytes: 10, totalBytes: 15 }).scan(root, baseUrl);
		assert.ok(result.bytes <= 15); assert.match(result.issues.join(" "), /上限/);
		const budget = paths.join(root, "budget"); await fs.promises.mkdir(budget);
		await fs.promises.writeFile(paths.join(budget, "start.sh"), "123456789012");
		await fs.promises.writeFile(paths.join(budget, "README.md"), "123456789012");
		result = await createDesktopAsrDiscovery(runtime(), { ...ASR_SCAN_LIMITS, totalBytes: 15 }).scan(budget, baseUrl);
		assert.equal(result.bytes, 12); assert.match(result.issues.join(" "), /累计读取上限/);
		await assert.rejects(createDesktopAsrDiscovery(runtime()).scan("relative/path", baseUrl), /绝对路径/);
	});
});

test("deadline and abort stop progress, including after delayed IO resolves", async () => {
	await fixture(async root => {
		let opens = 0;
		const delayed = runtime({ realpath: async (...args: Parameters<typeof fs.promises.realpath>) => {
			await new Promise(resolve => setTimeout(resolve, 30)); return fs.promises.realpath(...args);
		}, open: async (...args: Parameters<typeof fs.promises.open>) => { opens++; return fs.promises.open(...args); } });
		const result = await createDesktopAsrDiscovery(delayed, { ...ASR_SCAN_LIMITS, milliseconds: 2 }).scan(root, baseUrl);
		assert.match(result.issues.join(" "), /时限/);
		await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(opens, 0);
		const controller = new AbortController();
		const pending = createDesktopAsrDiscovery(delayed).scan(root, baseUrl, controller.signal); controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(opens, 0);
	});
});

test("permission errors are actionable and descriptor replacement is rejected before read", async () => {
	await fixture(async root => {
		await paired(root);
		await assert.rejects(createDesktopAsrDiscovery(runtime({ opendir: async () => { throw new Error("sensitive-system-error"); } })).scan(root, baseUrl), error => error instanceof Error && /权限/.test(error.message) && !error.message.includes("sensitive"));
		const other = paths.join(root, "other.txt"); await fs.promises.writeFile(other, "outside replacement");
		const result = await createDesktopAsrDiscovery(runtime({ open: async (file, ...args) => fs.promises.open(String(file).endsWith("start.sh") ? other : file, ...args) })).scan(root, baseUrl);
		assert.ok(result.candidates.every(c => !c.complete));
	});
});

test("directory browsing is separate from discovery and supports pagination and cancellation", async () => {
	await fixture(async root => {
		for (let i = 0; i < 110; i++) await fs.promises.mkdir(paths.join(root, `dir-${i}`));
		let opened = 0; const adapter = createDesktopAsrDiscovery(runtime({ open: async (...args: Parameters<typeof fs.promises.open>) => { opened++; return fs.promises.open(...args); } }));
		const first = await adapter.browse(root); assert.equal(first.directories.length, 100); assert.ok(first.nextCursor);
		const second = await adapter.browse(root, first.nextCursor); assert.equal(second.directories.length, 10); assert.equal(opened, 0);
		const controller = new AbortController(); controller.abort(); await assert.rejects(adapter.browse(root, 0, controller.signal), { name: "AbortError" });
	});
});

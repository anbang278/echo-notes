import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, cp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import esbuild from "esbuild";

const root = process.cwd();
const temporary = await mkdtemp(path.join(os.tmpdir(), "echo-reader-tests-"));
let serial = 0;
const apiFile = path.join(temporary, "api.mjs");
await esbuild.build({ entryPoints: [path.join(root, "src/agent-memory/index.ts")], outfile: apiFile, bundle: true, platform: "node", format: "esm" });
const { AgentExportPublisher } = await import(pathToFileURL(apiFile).href);
execFileSync(process.execPath, [path.join(root, "scripts/build-memory-reader.mjs")], { cwd: root, stdio: "pipe" });
const detachedSkill = path.join(temporary, "detached skill 中文");
await cp(path.join(root, "skills/echo-notes-memory"), detachedSkill, { recursive: true });
const script = path.join(detachedSkill, "scripts/echo-memory.mjs");
const at = "2026-11-08T03:00:00Z";

async function fixture() {
	const directory = path.join(temporary, `Vault 中文 ${++serial}`);
	await mkdir(directory, { recursive: true });
	const source = "转写/会议 1.transcript.md";
	const content = "---\ntype: audio-transcript\necho_source_id: source-1\n---\n<!-- echo-notes-transcript:start -->\n# 会议转写\n\n采用人工干预入口。\n\n保留条件和上下文。\n<!-- echo-notes-transcript:end -->\n";
	const paths = [];
	const storage = {
		async read(relative) { try { return await readFile(path.join(directory, relative), "utf8"); } catch (error) { if (error.code === "ENOENT") return null; throw error; } },
		async write(relative, text, options) { const target = path.join(directory, relative); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, text, { flag: options?.exclusive ? "wx" : "w" }); if (!paths.includes(relative)) paths.push(relative); },
		async list(folder) { return paths.filter((name) => name.startsWith(`${folder}/`)).sort(); }
	};
	await storage.write(source, content);
	const meetingContent = "---\necho_meeting_id: meeting-1\n---\n# 构造会议\n";
	const projectContent = "---\necho_project_id: project-1\n---\n# 构造项目\n";
	await storage.write("记忆/会议.md", meetingContent);
	await storage.write("记忆/项目.md", projectContent);
	const publisher = new AgentExportPublisher(storage, { systemDir: "记忆/系统", vaultId: `vault-${serial}`, now: () => at, id: () => `id-${++serial}` });
	await publisher.setPolicy({ enabled: true, sourceKinds: ["approved_memory", "transcript"], allowedRoots: ["记忆", "转写"] });
	await publisher.publish({ documents: [{ sourceId: "source-1", meetingId: "meeting-1", sourcePath: source, content, title: "构造会议", meetingDate: "2026-11-07", projectIds: ["project-1"] }], meetings: [{ id: "meeting-1", path: "记忆/会议.md", title: "构造会议", date: "2026-11-07", projectIds: ["project-1"], sourceRevision: createHash("sha256").update(meetingContent).digest("hex") }], projects: [{ id: "project-1", path: "记忆/项目.md", name: "构造项目", aliases: [], status: "active", sourceRevision: createHash("sha256").update(projectContent).digest("hex") }], authorityRoots: [] });
	const config = path.join(temporary, `registry-${serial}.json`);
	const env = { ...process.env, ECHO_MEMORY_CONFIG: config };
	const run = (...args) => spawnSync(process.execPath, [script, ...args], { cwd: temporary, env, encoding: "utf8" });
	const setup = run("setup", "--vault", directory, "--alias", "fixture", "--policy", publisher.policyPath, "--kind", "approved_memory", "--kind", "transcript", "--json");
	assert.equal(setup.status, 0, setup.stdout + setup.stderr);
	return { directory, source, publisher, storage, run, config };
}

test.after(async () => { await rm(temporary, { recursive: true, force: true }); });

test("complete detached Skill has all referenced files and runs without repository cwd", async () => {
	for (const name of ["SKILL.md", "scripts/echo-memory.mjs", "references/setup.md", "references/query-contract.md", "references/provenance.md"]) assert.ok((await readFile(path.join(detachedSkill, name))).length);
	const help = spawnSync(process.execPath, [script, "help"], { cwd: temporary, env: { ...process.env, ECHO_MEMORY_CONFIG: path.join(temporary, "no-config.json") }, encoding: "utf8" });
	assert.equal(help.status, 0);
	assert.match(help.stdout, /Echo Notes memory reader/);
	assert.equal(help.stderr, "");
});

test("explicit local setup, doctor, evidence search and source read work with Unicode and spaces", async () => {
	const { run, directory, source } = await fixture();
	const before = createHash("sha256").update(await readFile(path.join(directory, source))).digest("hex");
	const doctor = run("doctor", "--vault", "fixture", "--json");
	assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
	assert.equal(JSON.parse(doctor.stdout).status, "ok");
	const search = run("search", "--vault", "fixture", "--query", "人工干预", "--kind", "evidence", "--json");
	assert.equal(search.status, 0, search.stdout + search.stderr);
	assert.equal(JSON.parse(search.stdout).data.items.length, 1);
	const read = run("read", "--vault", "fixture", "--id", "source-1", "--json");
	assert.equal(read.status, 0);
	assert.match(JSON.parse(read.stdout).data.content, /人工干预/);
	const after = createHash("sha256").update(await readFile(path.join(directory, source))).digest("hex");
	assert.equal(before, after);
});

test("policy revocation rejects an old healthy generation", async () => {
	const { run, publisher } = await fixture();
	await publisher.setPolicy({ enabled: false, sourceKinds: ["transcript"], allowedRoots: ["转写"] });
	const result = run("doctor", "--vault", "fixture", "--json");
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).errors[0].code, "EXPORT_DISABLED");
});

test("source paths resolving outside Vault or into plugin configuration are denied", async () => {
	const { run, directory, source } = await fixture();
	const outside = path.join(temporary, "outside-private.md");
	await writeFile(outside, "not-readable-through-source");
	await rm(path.join(directory, source));
	await symlink(outside, path.join(directory, source));
	assert.equal(JSON.parse(run("read", "--vault", "fixture", "--id", "source-1", "--json").stdout).errors[0].code, "ACCESS_DENIED");
	await rm(path.join(directory, source));
	await mkdir(path.join(directory, ".obsidian"), { recursive: true });
	const secret = path.join(directory, ".obsidian/config.md");
	await writeFile(secret, "private-config");
	await symlink(secret, path.join(directory, source));
	assert.equal(JSON.parse(run("read", "--vault", "fixture", "--id", "source-1", "--json").stdout).errors[0].code, "ACCESS_DENIED");
});

test("explicit Markdown export contains actual material and refuses existing destination", async () => {
	const { run } = await fixture();
	const result = run("export", "--vault", "fixture", "--query", "人工干预", "--kind", "evidence", "--format", "markdown");
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /采用人工干预入口/);
	assert.match(result.stdout, /source-1/);
	const target = path.join(temporary, "材料包.md");
	const saved = run("export", "--vault", "fixture", "--query", "人工干预", "--kind", "evidence", "--format", "markdown", "--out", target);
	assert.equal(saved.status, 0, saved.stdout + saved.stderr);
	const bytes = await readFile(target);
	const repeated = run("export", "--vault", "fixture", "--query", "人工干预", "--kind", "evidence", "--format", "markdown", "--out", target);
	assert.equal(repeated.status, 1);
	assert.deepEqual(await readFile(target), bytes);
});

test("multiple Vaults require explicit selection and invalid CLI options are machine errors", async () => {
	const { run, config } = await fixture();
	const connections = JSON.parse(await readFile(config, "utf8"));
	connections.vaults.push({ ...connections.vaults[0], alias: "second" });
	await writeFile(config, JSON.stringify(connections));
	const missing = run("doctor", "--json");
	assert.equal(JSON.parse(missing.stdout).errors[0].code, "VAULT_NOT_CONFIGURED");
	assert.equal(run("doctor", "--vault", "fixture", "--unsupported", "x").status, 1);
});

test("a Vault-internal symlink cannot escape policy roots or setup roots", async () => {
	const { run, directory, source } = await fixture();
	const privatePath = path.join(directory, "Private/private.transcript.md");
	await mkdir(path.dirname(privatePath), { recursive: true });
	await writeFile(privatePath, "<!-- echo-notes-transcript:start -->\n# Private meeting\n\nPRIVATE_POLICY_SCOPE_MARKER\n<!-- echo-notes-transcript:end -->\n");
	await rm(path.join(directory, source));
	await symlink(privatePath, path.join(directory, source));
	const result = run("read", "--vault", "fixture", "--id", "source-1", "--json");
	assert.equal(result.status, 1);
	assert.equal(JSON.parse(result.stdout).errors[0].code, "ACCESS_DENIED");
	assert.doesNotMatch(result.stdout, /PRIVATE_POLICY_SCOPE_MARKER/);
});

test("detached reader rejects a replaced source until its catalog snapshot is republished", async () => {
	const { run, directory, source } = await fixture();
	const file = path.join(directory, source);
	const content = (await readFile(file, "utf8")).replace("source-1", "source-2").replace("采用人工干预入口。", "DIFFERENT_IDENTITY_PRIVATE_BODY");
	await writeFile(file, content);
	for (const args of [["read", "--id", "source-1"], ["search", "--kind", "evidence", "--query", "DIFFERENT_IDENTITY_PRIVATE_BODY"], ["context", "--kind", "evidence"], ["export", "--kind", "evidence"]]) {
		const result = run(...args, "--vault", "fixture", "--json");
		assert.equal(result.status, 1);
		assert.equal(JSON.parse(result.stdout).errors[0].code, "SOURCE_CHANGED");
		assert.doesNotMatch(result.stdout, /DIFFERENT_IDENTITY_PRIVATE_BODY/);
	}
});

test("detached doctor and filters reject changed saved metadata while Obsidian is absent", async () => {
	const { run, directory } = await fixture();
	await writeFile(path.join(directory, "记忆/会议.md"), "---\necho_meeting_id: meeting-1\necho_project_ids: []\n---\n# Changed meeting date and title\n");
	for (const args of [["doctor"], ["meetings", "list", "--from", "2026-11-07"], ["projects", "list"]]) {
		const result = run(...args, "--vault", "fixture", "--json");
		assert.equal(result.status, 1);
		const response = JSON.parse(result.stdout);
		assert.equal(response.errors[0].code, "SOURCE_CHANGED");
		assert.match(response.errors[0].message, /refresh.*publish/);
		assert.equal(response.data, null);
	}
});

import { mkdir, readFile, realpath, writeFile, open, rename, unlink } from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createEvidenceQuery } from "../../evidence";
import type { EvidenceKind, EvidenceQueryV1 } from "../../evidence/evidence-types";
import { MemoryReader, type AgentReadRequest } from "../memory-reader";
import { parseAgentPolicy } from "../agent-export";
import { AgentMemoryError, type AgentResponse } from "../agent-memory-types";
import { agentJson, normalizeAgentPath } from "../agent-memory-utils";
import { NodeAgentMemoryStorage } from "./node-storage";

interface VaultConnection {
	alias: string;
	vaultId: string;
	root: string;
	policyPath: string;
	sourceKinds: EvidenceKind[];
	allowedRoots: string[];
	setupAt: string;
}

interface LocalConnections {
	schemaVersion: 1;
	vaults: VaultConnection[];
}

interface Arguments {
	positionals: string[];
	flags: Map<string, string[]>;
}

const configPath = process.env.ECHO_MEMORY_CONFIG ?? path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "echo-notes-memory", "vaults.json");

async function main(): Promise<void> {
	const args = parseArguments(process.argv.slice(2));
	const command = args.positionals[0] ?? "help";
	if (command === "help" || args.flags.has("help")) {
		process.stdout.write("Echo Notes memory reader\n\nCommands\n  vault list --json\n  setup --vault <absolute-path> --alias <name> --policy <Vault-relative-policy.json>\n  doctor --vault <alias> --json\n  projects list | meetings list --vault <alias> --json\n  search --vault <alias> --query <text> --kind memory|evidence --json\n  read --vault <alias> --id <stable-id> --json\n  context | export --vault <alias> --query-file <file> --json\n\nRead scope defaults to approved_memory. Add --kind transcript or --kind analysis during setup only after explicit approval.\n");
		return;
	}
	if (command === "setup") {
		await setup(args);
		return;
	}
	const config = await readConnections();
	if (command === "vault" && args.positionals[1] === "list") {
		process.stdout.write(agentJson({ protocolVersion: 1, command: "vault list", status: "ok", data: { items: config.vaults.map((vault) => ({ alias: vault.alias, vaultId: vault.vaultId, sourceKinds: vault.sourceKinds, setupAt: vault.setupAt })) }, warnings: [], errors: [] }));
		return;
	}
	const alias = flag(args, "vault");
	const connection = alias ? config.vaults.find((vault) => vault.alias === alias) : config.vaults.length === 1 ? config.vaults[0] : undefined;
	if (!connection) throw new AgentMemoryError("VAULT_NOT_CONFIGURED", "Select a registered alias with --vault. Copy the setup command from Echo Notes Agent connection settings.");
	const storage = await NodeAgentMemoryStorage.open(connection.root);
	const reader = new MemoryReader(storage, { policyPath: connection.policyPath, sourceKinds: connection.sourceKinds, allowedRoots: connection.allowedRoots });
	const request = await readRequest(args);
	const response = await reader.execute(request);
	if (response.vaultId && response.vaultId !== connection.vaultId) throw new AgentMemoryError("IDENTITY_CONFLICT", "The connected Vault identity changed. Review and run setup again.");
	const markdown = command === "export" && flag(args, "format") === "markdown" && response.status !== "error"
		? (response.data as { markdown: string }).markdown
		: null;
	const output = flag(args, "out");
	if (output) {
		if (command !== "export") throw new AgentMemoryError("INVALID_QUERY", "--out is supported only for an explicit export.");
		if (response.status === "error") {
			process.stdout.write(agentJson(response));
			process.exitCode = 1;
			return;
		}
		await writeFile(path.resolve(output), markdown ?? agentJson(response), { encoding: "utf8", flag: "wx", mode: 0o600 });
		process.stdout.write(agentJson({ ...response, data: { saved: true, format: markdown ? "markdown" : "json" } }));
	} else {
		process.stdout.write(markdown ?? agentJson(response));
	}
	if (response.status === "error") process.exitCode = 1;
}

async function setup(args: Arguments): Promise<void> {
	const location = flag(args, "vault");
	const alias = flag(args, "alias");
	const policyPath = flag(args, "policy");
	if (!location || !alias || !policyPath || !/^[\p{L}\p{N}_-]{1,64}$/u.test(alias)) throw new AgentMemoryError("VAULT_NOT_CONFIGURED", "setup requires --vault <path>, --alias <name>, and the exact --policy path copied from Echo Notes.");
	const storage = await NodeAgentMemoryStorage.open(location);
	const policyText = await storage.read(normalizeAgentPath(policyPath));
	if (policyText === null) throw new AgentMemoryError("EXPORT_DISABLED", "The selected current export policy is missing. Enable export and copy its path from Echo Notes.");
	const policy = parseAgentPolicy(policyText);
	if (!policy.enabled) throw new AgentMemoryError("EXPORT_DISABLED", "The current plugin export policy is disabled.");
	const kinds = (args.flags.get("kind")?.flatMap((value) => value.split(",")) ?? ["approved_memory"]) as EvidenceKind[];
	if (!kinds.every((kind) => ["approved_memory", "transcript", "analysis"].includes(kind) && policy.sourceKinds.includes(kind))) throw new AgentMemoryError("ACCESS_DENIED", "The requested setup scope exceeds the current plugin policy.");
	const roots = args.flags.get("allow-root") ?? policy.allowedRoots;
	const connection: VaultConnection = { alias, vaultId: policy.vaultId, root: await realpath(storage.root), policyPath: normalizeAgentPath(policyPath), sourceKinds: [...new Set(kinds)], allowedRoots: roots.map(normalizeAgentPath), setupAt: new Date().toISOString() };
	const check = await new MemoryReader(storage, { policyPath: connection.policyPath, sourceKinds: connection.sourceKinds, allowedRoots: connection.allowedRoots }).execute({ command: "doctor" });
	if (check.status === "error") {
		process.stdout.write(agentJson(check));
		process.exitCode = 1;
		return;
	}
	await saveConnection(connection);
	process.stdout.write(agentJson({ ...check, command: "setup", data: { alias, vaultId: connection.vaultId, sourceKinds: connection.sourceKinds, allowedRoots: connection.allowedRoots, setupAt: connection.setupAt } }));
}

async function saveConnection(connection: VaultConnection): Promise<void> {
	await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
	let lock;
	try { lock = await open(`${configPath}.lock`, "wx", 0o600); } catch (error) {
		if (hasCode(error, "EEXIST")) throw new AgentMemoryError("DATA_UPDATING", "Another setup operation owns the connection registry. Retry after it completes.");
		throw error;
	}
	const temporary = `${configPath}.${globalThis.crypto.randomUUID()}.tmp`;
	try {
		const config = await readConnections();
		const existing = config.vaults.find((vault) => vault.alias === connection.alias);
		if (existing && (existing.vaultId !== connection.vaultId || existing.root !== connection.root)) throw new AgentMemoryError("IDENTITY_CONFLICT", "This alias already connects another Vault. Choose a new alias.");
		config.vaults = [...config.vaults.filter((vault) => vault.alias !== connection.alias), connection].sort((left, right) => left.alias.localeCompare(right.alias));
		await writeFile(temporary, agentJson(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, configPath);
	} finally {
		await lock.close();
		await unlink(`${configPath}.lock`);
		await unlink(temporary).catch((error: unknown) => { if (!hasCode(error, "ENOENT")) throw error; });
	}
}

async function readRequest(args: Arguments): Promise<AgentReadRequest> {
	const command = args.positionals[0];
	if (!["doctor", "projects", "meetings", "search", "read", "context", "export"].includes(command)) throw new AgentMemoryError("INVALID_QUERY", "Unknown reader command. Run help.");
	if ((command === "projects" || command === "meetings") && args.positionals[1] !== "list") throw new AgentMemoryError("INVALID_QUERY", "Use projects list or meetings list.");
	let query: EvidenceQueryV1;
	const queryFile = flag(args, "query-file");
	if (queryFile) {
		let parsed;
		try { parsed = JSON.parse(await readFile(path.resolve(queryFile), "utf8")) as EvidenceQueryV1; } catch { throw new AgentMemoryError("INVALID_QUERY", "The query file is not readable JSON."); }
		query = parsed;
	} else {
		const text = flag(args, "query") ?? "";
		const kind = flag(args, "kind") ?? "memory";
		query = createEvidenceQuery(text, { keywords: args.flags.get("keyword") ?? (text.trim() ? [text.trim()] : []), includeHistoricalMemory: args.flags.has("include-history"), filters: { projectIds: args.flags.get("project") ?? [], meetingIds: args.flags.get("meeting") ?? [], fromDate: flag(args, "from"), toDateInclusive: flag(args, "to"), timezone: flag(args, "timezone") ?? "UTC", sourceKinds: kind === "memory" ? ["approved_memory"] : ["transcript", ...(args.flags.has("include-history") ? ["approved_memory" as const] : [])] }, maxCharacters: Number(flag(args, "max-characters") ?? "12000") });
	}
	return { command: command as AgentReadRequest["command"], query, kind: flag(args, "kind") === "evidence" ? "evidence" : "memory", id: flag(args, "id"), includeHistory: args.flags.has("include-history"), includeAnalysis: args.flags.has("include-analysis"), projectIds: args.flags.get("project"), fromDate: flag(args, "from"), toDate: flag(args, "to"), limit: Number(flag(args, "limit") ?? "20"), cursor: flag(args, "cursor") };
}

async function readConnections(): Promise<LocalConnections> {
	try {
		const config = JSON.parse(await readFile(configPath, "utf8")) as LocalConnections;
		if (config.schemaVersion !== 1 || !Array.isArray(config.vaults) || !config.vaults.every((vault) => typeof vault.alias === "string" && typeof vault.root === "string" && typeof vault.policyPath === "string" && Array.isArray(vault.sourceKinds) && Array.isArray(vault.allowedRoots))) throw new Error("schema");
		return config;
	} catch (error) {
		if (hasCode(error, "ENOENT")) return { schemaVersion: 1, vaults: [] };
		throw new AgentMemoryError("VAULT_NOT_CONFIGURED", "The local connection registry is invalid or unreadable. Restore it or choose another ECHO_MEMORY_CONFIG path.");
	}
}

function parseArguments(values: string[]): Arguments {
	const args: Arguments = { positionals: [], flags: new Map() };
	const booleanFlags = new Set(["json", "include-history", "include-analysis", "help"]);
	const allowedFlags = new Set(["vault", "alias", "policy", "kind", "allow-root", "query", "query-file", "keyword", "project", "meeting", "from", "to", "timezone", "max-characters", "id", "limit", "cursor", "format", "out", ...booleanFlags]);
	for (let index = 0; index < values.length; index++) {
		const value = values[index];
		if (!value.startsWith("--")) { args.positionals.push(value); continue; }
		const name = value.slice(2);
		if (!allowedFlags.has(name)) throw new AgentMemoryError("INVALID_QUERY", `Unknown option --${name}.`);
		const next = booleanFlags.has(name) ? "true" : values[++index];
		if (!next || next.startsWith("--")) throw new AgentMemoryError("INVALID_QUERY", `Option --${name} requires a value.`);
		args.flags.set(name, [...(args.flags.get(name) ?? []), next]);
	}
	return args;
}

function flag(args: Arguments, name: string): string | undefined {
	return args.flags.get(name)?.at(-1);
}

function hasCode(error: unknown, code: string): boolean {
	return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

await main().catch((error: unknown) => {
	const failure = error instanceof AgentMemoryError ? error : new AgentMemoryError("VAULT_UNREACHABLE", hasCode(error, "EEXIST") ? "The output file already exists. Choose a new path." : "The reader could not complete the requested local operation.");
	const response: AgentResponse = { protocolVersion: 1, command: process.argv[2] ?? "help", vaultId: "", generationId: "", status: "error", checkedAt: new Date().toISOString(), freshness: { index: "as_of_snapshot", returnedItems: "unverified", scopeCompleteness: "as_of_snapshot" }, data: null, warnings: [], errors: [{ code: failure.code, message: failure.message }] };
	process.stdout.write(agentJson(response));
	process.stderr.write(`${failure.code}: ${failure.message}\n`);
	process.exitCode = 1;
});

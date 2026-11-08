import { AgentMemoryError } from "./agent-memory-types";

export function normalizeAgentPath(path: string): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!normalized || normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new AgentMemoryError("ACCESS_DENIED", "A registered Vault-relative path is required.");
	}
	return normalized;
}

export function isWithinAgentRoots(path: string, roots: readonly string[]): boolean {
	const normalized = normalizeAgentPath(path);
	return roots.some((root) => {
		const allowed = normalizeAgentPath(root);
		return normalized === allowed || normalized.startsWith(`${allowed}/`);
	});
}

export async function agentSha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function normalizedSource(value: string): string {
	return value.replace(/\r\n/g, "\n");
}

export function agentJson(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

export function parseAgentJson<T>(value: string | null, path: string): T {
	if (value === null) throw new AgentMemoryError("INDEX_INCOMPLETE", "The published snapshot is missing. Open Echo Notes and publish a new snapshot.", path);
	try {
		return JSON.parse(value) as T;
	} catch {
		throw new AgentMemoryError("INDEX_INCOMPLETE", "The published snapshot is invalid. Publish a new snapshot.", path);
	}
}

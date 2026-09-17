import type { App } from "obsidian";
import type { DualModelProofreadingSession } from "./proofreading";

const STORE_VERSION = 1;

interface ProofreadingSessionIndex {
	schemaVersion: number;
	byTranscriptPath: Record<string, string>;
}

interface StoredProofreadingSession {
	schemaVersion: number;
	transcriptPath: string;
	session: DualModelProofreadingSession;
}

/**
 * 校对恢复数据属于本机插件状态，不进入用户的 Markdown 或 data.json。
 * 部署仅替换三项插件资产，存储目录会被保留；清除插件数据或卸载插件会移除该恢复能力。
 */
export class ProofreadingSessionStore {
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(private readonly app: App, pluginId: string) {
		this.directory = `${app.vault.configDir}/plugins/${pluginId}/proofreading-sessions`;
	}

	private readonly directory: string;

	async load(transcriptPath: string): Promise<DualModelProofreadingSession | null> {
		const index = await this.readIndex();
		const sessionId = index.byTranscriptPath[transcriptPath];
		if (!sessionId) return null;
		const stored = await this.readStoredSession(this.getSessionPath(sessionId));
		if (!stored || stored.transcriptPath !== transcriptPath || !isValidSession(stored.session)) return null;
		return stored.session;
	}

	async save(transcriptPath: string, session: DualModelProofreadingSession): Promise<void> {
		if (!isValidSession(session)) throw new Error("校对恢复数据不完整，已停止保存。");
		return this.enqueue(async () => {
			await this.ensureDirectory();
			const index = await this.readIndex();
			await this.app.vault.adapter.write(this.getSessionPath(session.sessionId), JSON.stringify({
				schemaVersion: STORE_VERSION,
				transcriptPath,
				session
			} satisfies StoredProofreadingSession));
			index.byTranscriptPath[transcriptPath] = session.sessionId;
			await this.app.vault.adapter.write(this.indexPath, JSON.stringify(index));
		});
	}

	private get indexPath(): string {
		return `${this.directory}/index.json`;
	}

	private getSessionPath(sessionId: string): string {
		return `${this.directory}/session-${encodeURIComponent(sessionId)}.json`;
	}

	private async readIndex(): Promise<ProofreadingSessionIndex> {
		if (!(await this.app.vault.adapter.exists(this.indexPath))) {
			return { schemaVersion: STORE_VERSION, byTranscriptPath: {} };
		}
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(this.indexPath)) as ProofreadingSessionIndex;
			return parsed.schemaVersion === STORE_VERSION && parsed.byTranscriptPath && typeof parsed.byTranscriptPath === "object"
				? parsed
				: { schemaVersion: STORE_VERSION, byTranscriptPath: {} };
		} catch {
			return { schemaVersion: STORE_VERSION, byTranscriptPath: {} };
		}
	}

	private async readStoredSession(path: string): Promise<StoredProofreadingSession | null> {
		if (!(await this.app.vault.adapter.exists(path))) return null;
		try {
			const parsed = JSON.parse(await this.app.vault.adapter.read(path)) as StoredProofreadingSession;
			return parsed.schemaVersion === STORE_VERSION && typeof parsed.transcriptPath === "string" ? parsed : null;
		} catch {
			return null;
		}
	}

	private async ensureDirectory(): Promise<void> {
		let current = "";
		for (const segment of this.directory.split("/")) {
			current = current ? `${current}/${segment}` : segment;
			if (await this.app.vault.adapter.exists(current)) continue;
			try {
				await this.app.vault.adapter.mkdir(current);
			} catch (error) {
				if (!(await this.app.vault.adapter.exists(current))) throw error;
			}
		}
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.writeQueue.then(operation, operation);
		this.writeQueue = result.then(() => undefined, () => undefined);
		return result;
	}
}

function isValidSession(session: DualModelProofreadingSession): boolean {
	return session.schemaVersion === 2 && Boolean(session.sessionId) && Boolean(session.primary?.text) && Array.isArray(session.issues);
}

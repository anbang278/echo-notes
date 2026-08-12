import { getSanitizedErrorMessage, sanitizeSensitiveText } from "../security/redaction";
import type {
	DiagnosticEvent,
	DiagnosticEventCategory,
	DiagnosticSession,
	DiagnosticSessionInput,
	DiagnosticSessionStatus,
	DiagnosticSink,
	DiagnosticState,
	DiagnosticValue
} from "./diagnostic-types";

export const DIAGNOSTIC_RETENTION_DAYS = 7;
export const MAX_DIAGNOSTIC_SESSIONS = 20;
export const MAX_DIAGNOSTIC_EVENTS_PER_SESSION = 200;
export const MAX_DIAGNOSTIC_SESSION_BYTES = 64 * 1024;
export const MAX_DIAGNOSTIC_STATE_BYTES = 1024 * 1024;

export const EMPTY_DIAGNOSTIC_STATE: DiagnosticState = {
	schemaVersion: 1,
	enabled: true,
	sessions: []
};

type DiagnosticListener = () => void;

export class DiagnosticStore {
	state: DiagnosticState = cloneState(EMPTY_DIAGNOSTIC_STATE);
	private listeners = new Set<DiagnosticListener>();

	restore(value: unknown): void {
		this.state = normalizeDiagnosticState(value);
		this.notify();
	}

	getState(): DiagnosticState {
		return cloneState(this.state);
	}

	isEnabled(): boolean {
		return this.state.enabled;
	}

	setEnabled(enabled: boolean): void {
		if (this.state.enabled === enabled) {
			return;
		}
		this.state.enabled = enabled;
		this.prune();
		this.notify();
	}

	createChainId(): string {
		return createDiagnosticId("chain");
	}

	startSession(input: DiagnosticSessionInput): DiagnosticSession {
		const now = Date.now();
		const session: DiagnosticSession = {
			id: createDiagnosticId("session"),
			chainId: input.chainId?.trim() || this.createChainId(),
			retryOfSessionId: input.retryOfSessionId?.trim() || undefined,
			kind: input.kind,
			status: "running",
			startedAt: now,
			updatedAt: now,
			events: []
		};
		if (!this.state.enabled) {
			return session;
		}
		this.state.sessions.unshift(session);
		this.prune();
		this.notify();
		return cloneSession(session);
	}

	getSink(sessionId: string): DiagnosticSink {
		return {
			event: (category, name, data) => this.record(sessionId, category, name, data)
		};
	}

	record(
		sessionId: string,
		category: DiagnosticEventCategory,
		name: string,
		data?: Record<string, unknown>
	): void {
		if (!this.state.enabled) {
			return;
		}
		const session = this.findSession(sessionId);
		if (!session) {
			return;
		}
		const safeData = sanitizeDiagnosticData(data);
		const now = Date.now();
		const previous = session.events.at(-1);
		if (previous && previous.category === category && previous.name === name && isSameData(previous.data, safeData)) {
			previous.timestamp = now;
			previous.count = (previous.count ?? 1) + 1;
		} else if (session.events.length < MAX_DIAGNOSTIC_EVENTS_PER_SESSION) {
			session.events.push({
				id: createDiagnosticId("event"),
				timestamp: now,
				category,
				name: sanitizeDiagnosticText(name, 120),
				...(safeData ? { data: safeData } : {})
			});
		} else if (!session.events.some((event) => event.name === "event-limit-reached")) {
			session.events[session.events.length - 1] = {
				id: createDiagnosticId("event"),
				timestamp: now,
				category: "result",
				name: "event-limit-reached",
				data: { limit: MAX_DIAGNOSTIC_EVENTS_PER_SESSION }
			};
		}
		session.updatedAt = now;
		this.enforceSessionBudget(session);
		this.prune();
		this.notify();
	}

	complete(sessionId: string, status: Exclude<DiagnosticSessionStatus, "running">, data?: Record<string, unknown>): void {
		const session = this.findSession(sessionId);
		if (!session || !this.state.enabled || session.status !== "running") {
			return;
		}
		this.record(sessionId, "result", "session-completed", { status, ...data });
		session.status = status;
		session.completedAt = Date.now();
		session.updatedAt = session.completedAt;
		this.prune();
		this.notify();
	}

	markInterruptedSessions(): void {
		for (const session of this.state.sessions.filter((item) => item.status === "running")) {
			this.complete(session.id, "failed", { error: "插件重启或停用导致任务中断", errorCategory: "interrupted" });
		}
	}

	clear(): void {
		if (this.state.sessions.length === 0) {
			return;
		}
		this.state.sessions = [];
		this.notify();
	}

	subscribe(listener: DiagnosticListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private findSession(id: string): DiagnosticSession | undefined {
		return this.state.sessions.find((session) => session.id === id);
	}

	private enforceSessionBudget(session: DiagnosticSession): void {
		while (getByteLength(session) > MAX_DIAGNOSTIC_SESSION_BYTES && session.events.length > 1) {
			session.events.splice(1, 1);
		}
		if (getByteLength(session) > MAX_DIAGNOSTIC_SESSION_BYTES) {
			session.events = [{
				id: createDiagnosticId("event"),
				timestamp: Date.now(),
				category: "result",
				name: "session-size-limit-reached",
				data: { limit: MAX_DIAGNOSTIC_SESSION_BYTES }
			}];
		}
	}

	prune(): void {
		const cutoff = Date.now() - DIAGNOSTIC_RETENTION_DAYS * 24 * 60 * 60 * 1000;
		this.state.sessions = this.state.sessions
			.filter((session) => session.status === "running" || session.updatedAt >= cutoff)
			.sort((left, right) => right.updatedAt - left.updatedAt);

		const running = this.state.sessions.filter((session) => session.status === "running");
		const completed = this.state.sessions
			.filter((session) => session.status !== "running")
			.slice(0, Math.max(0, MAX_DIAGNOSTIC_SESSIONS - running.length));
		this.state.sessions = [...running, ...completed].sort((left, right) => right.updatedAt - left.updatedAt);

		while (getByteLength(this.state) > MAX_DIAGNOSTIC_STATE_BYTES) {
			const oldestFinished = [...this.state.sessions]
				.reverse()
				.find((session) => session.status !== "running");
			if (oldestFinished) {
				this.state.sessions = this.state.sessions.filter((session) => session !== oldestFinished);
				continue;
			}
			const runningWithEvents = [...this.state.sessions]
				.reverse()
				.find((session) => session.events.length > 1);
			if (!runningWithEvents) {
				break;
			}
			runningWithEvents.events.splice(1, 1);
		}
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

export function normalizeDiagnosticState(value: unknown): DiagnosticState {
	if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.sessions)) {
		return cloneState(EMPTY_DIAGNOSTIC_STATE);
	}
	const store = new DiagnosticStore();
	store.state = {
		schemaVersion: 1,
		enabled: typeof value.enabled === "boolean" ? value.enabled : true,
		sessions: value.sessions.map(parseSession).filter((session): session is DiagnosticSession => Boolean(session))
	};
	store.prune();
	return store.getState();
}

export function sanitizeDiagnosticUrl(value: string): string {
	const normalized = value.trim();
	const alreadyRedacted = normalized.match(/^([a-z][a-z\d+.-]*:\/\/\[lan\])(?::(\d+))?(\/[^?#]*)?(?:[?#].*)?$/i);
	if (alreadyRedacted) {
		return `${alreadyRedacted[1]}${alreadyRedacted[2] ? `:${alreadyRedacted[2]}` : ""}${alreadyRedacted[3]?.replace(/\/$/, "") || "/"}`;
	}
	try {
		const url = new URL(normalized);
		const host = isPrivateHost(url.hostname) ? "[lan]" : url.hostname;
		const port = url.port ? `:${url.port}` : "";
		const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "");
		return `${url.protocol}//${host}${port}${path || "/"}`;
	} catch {
		return "[INVALID_URL]";
	}
}

export function sanitizeDiagnosticText(value: unknown, maxLength = 800): string {
	const text = value instanceof Error ? getSanitizedErrorMessage(value, maxLength) : sanitizeSensitiveText(String(value), maxLength);
	return text
		.replace(/(?:\/Users\/|\/home\/|[A-Za-z]:\\)[^\s"'`]+/g, "[PATH]")
		.replace(/\b[^\s/\\]+\.(?:mp3|m4a|wav|webm|ogg|flac|aac|transcript\.md)\b/gi, "[FILE]")
		.replace(/\b(?:echo-notes-(?:transcription|analysis|memory)-api-key-[\w-]+)\b/gi, "[SECRET_ID]");
}

export function sanitizeDiagnosticData(value: Record<string, unknown> | undefined): Record<string, DiagnosticValue> | undefined {
	if (!value) {
		return undefined;
	}
	const sanitized = sanitizeValue(value, "");
	return isRecord(sanitized) ? sanitized : undefined;
}

function sanitizeValue(value: unknown, key: string): DiagnosticValue | undefined {
	if (/authorization|api.?key|token|secret|password|credential|base64|audio.?data|prompt|content|body|path|file.?name|vault/i.test(key)) {
		return undefined;
	}
	if (typeof value === "string") {
		return /(?:url|endpoint)/i.test(key) ? sanitizeDiagnosticUrl(value) : sanitizeDiagnosticText(value, 1200);
	}
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : undefined;
	}
	if (typeof value === "boolean" || value === null) {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.slice(0, 30)
			.map((item) => sanitizeValue(item, key))
			.filter((item): item is DiagnosticValue => item !== undefined);
	}
	if (isRecord(value)) {
		const result: Record<string, DiagnosticValue> = {};
		for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
			const safeValue = sanitizeValue(childValue, childKey);
			if (safeValue !== undefined) {
				result[childKey] = safeValue;
			}
		}
		return result;
	}
	return sanitizeDiagnosticText(value, 400);
}

function parseSession(value: unknown): DiagnosticSession | null {
	if (!isRecord(value) || !isDiagnosticKind(value.kind) || !isDiagnosticStatus(value.status)) {
		return null;
	}
	const id = readId(value.id);
	const chainId = readId(value.chainId);
	const startedAt = readTimestamp(value.startedAt);
	const updatedAt = readTimestamp(value.updatedAt);
	if (!id || !chainId || startedAt === null || updatedAt === null || !Array.isArray(value.events)) {
		return null;
	}
	const completedAt = readTimestamp(value.completedAt);
	return {
		id,
		chainId,
		...(typeof value.retryOfSessionId === "string" && readId(value.retryOfSessionId) ? { retryOfSessionId: value.retryOfSessionId } : {}),
		kind: value.kind,
		status: value.status,
		startedAt,
		updatedAt,
		...(completedAt === null ? {} : { completedAt }),
		events: value.events.map(parseEvent).filter((event): event is DiagnosticEvent => Boolean(event)).slice(-MAX_DIAGNOSTIC_EVENTS_PER_SESSION)
	};
}

function parseEvent(value: unknown): DiagnosticEvent | null {
	if (!isRecord(value) || typeof value.category !== "string" || !isDiagnosticCategory(value.category)) {
		return null;
	}
	const id = readId(value.id);
	const timestamp = readTimestamp(value.timestamp);
	if (!id || timestamp === null || typeof value.name !== "string") {
		return null;
	}
	return {
		id,
		timestamp,
		category: value.category,
		name: sanitizeDiagnosticText(value.name, 120),
		...(isRecord(value.data) && sanitizeDiagnosticData(value.data) ? { data: sanitizeDiagnosticData(value.data) } : {}),
		...(typeof value.count === "number" && Number.isFinite(value.count) && value.count > 1 ? { count: Math.floor(value.count) } : {})
	};
}

function isDiagnosticKind(value: unknown): value is DiagnosticSession["kind"] {
	return value === "transcription" || value === "analysis" || value === "memory";
}

function isDiagnosticStatus(value: unknown): value is DiagnosticSessionStatus {
	return value === "running" || value === "success" || value === "failed" || value === "skipped";
}

function isDiagnosticCategory(value: string): value is DiagnosticEventCategory {
	return ["environment", "configuration", "lifecycle", "request", "progress", "result"].includes(value);
}

function cloneState(state: DiagnosticState): DiagnosticState {
	return JSON.parse(JSON.stringify(state)) as DiagnosticState;
}

function cloneSession(session: DiagnosticSession): DiagnosticSession {
	return JSON.parse(JSON.stringify(session)) as DiagnosticSession;
}

function createDiagnosticId(prefix: string): string {
	const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
		? crypto.randomUUID().replace(/-/g, "").slice(0, 12)
		: Math.random().toString(36).slice(2, 14);
	return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function isPrivateHost(host: string): boolean {
	return host === "localhost" ||
		host === "::1" ||
		/^127\./.test(host) ||
		/^10\./.test(host) ||
		/^192\.168\./.test(host) ||
		/^169\.254\./.test(host) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
		/^(?:fc|fd)/i.test(host);
}

function getByteLength(value: unknown): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function isSameData(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readId(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

function readTimestamp(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

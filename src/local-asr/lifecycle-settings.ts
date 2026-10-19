import type { OfflineTranscriptionProviderId } from "../settings/settings";
import { parseLoopbackUrl } from "../network/local-http";

/** Device-scoped lifecycle settings: never serialized into data.json. */
export interface LocalAsrLifecycleSettings {
	enabled: boolean;
	startCommand: string;
	stopCommand: string;
	workingDirectory: string;
	readinessUrl: string;
	startupTimeoutSeconds: number;
	idleTimeoutSeconds: number;
	shutdownTimeoutSeconds: number;
}

export const LOCAL_ASR_LIFECYCLE_STORAGE_KEY = "echo-notes:local-asr-lifecycle:v1";

export const LOCAL_ASR_LIFECYCLE_DEFAULTS: Readonly<LocalAsrLifecycleSettings> = Object.freeze({
	enabled: false,
	startCommand: "",
	stopCommand: "",
	workingDirectory: "",
	readinessUrl: "",
	startupTimeoutSeconds: 180,
	idleTimeoutSeconds: 30,
	shutdownTimeoutSeconds: 30
});

const POSITIVE_SECONDS_FIELDS = ["startupTimeoutSeconds", "shutdownTimeoutSeconds"] as const;
const NON_NEGATIVE_SECONDS_FIELDS = ["idleTimeoutSeconds"] as const;

/** Loopback origin with localhost normalized to 127.0.0.1; path preserved, trailing slashes trimmed. */
export function normalizeLocalAsrServiceKey(provider: OfflineTranscriptionProviderId, baseUrl: string): string {
	const parsed = parseLoopbackUrl(baseUrl.trim());
	if (parsed.hostname === "localhost") parsed.hostname = "127.0.0.1";
	const pathname = parsed.pathname.replace(/\/+$/, "");
	return `${provider}|${parsed.origin}${pathname}`;
}

/** Readiness URL must live on the same normalized loopback origin as the service Base URL. */
export function validateLocalAsrReadinessUrl(value: string, baseUrl: string): string | undefined {
	const address = value.trim();
	if (!address) return "请填写就绪检查地址。";
	if (address.includes("\\") || [...address].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
		return "请填写有效的就绪检查地址。";
	}
	let parsed: URL;
	let base: URL;
	try {
		// parseLoopbackUrl 已拒绝凭据、查询参数与片段。
		parsed = parseLoopbackUrl(address);
		base = parseLoopbackUrl(baseUrl.trim());
	} catch {
		return "请填写有效的就绪检查地址。";
	}
	const normalize = (url: URL): string => (url.hostname === "localhost" ? `http://127.0.0.1:${url.port}` : url.origin);
	if (normalize(parsed) !== normalize(base)) {
		return "就绪检查地址必须使用当前服务的同源地址。";
	}
	return undefined;
}

/** Default readiness endpoint derived from the Base URL origin. */
export function defaultLocalAsrReadinessUrl(baseUrl: string): string {
	const base = parseLoopbackUrl(baseUrl.trim());
	const hostname = base.hostname === "localhost" ? "127.0.0.1" : base.hostname;
	return `${base.protocol}//${hostname}${base.port ? `:${base.port}` : ""}/health`;
}

/** Missing/invalid fields fall back to defaults; no command execution side effects. */
export function normalizeLocalAsrLifecycleSettings(raw: unknown): LocalAsrLifecycleSettings {
	const source = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
	const text = (field: keyof LocalAsrLifecycleSettings): string => {
		const value = source[field];
		return typeof value === "string" ? value.trim() : "";
	};
	const numeric = (field: keyof LocalAsrLifecycleSettings): number | undefined => {
		const value = source[field];
		if (typeof value === "number" && Number.isSafeInteger(value)) return value;
		if (typeof value === "string" && value.trim() && Number.isSafeInteger(Number(value.trim()))) return Number(value.trim());
		return undefined;
	};
	const normalized: LocalAsrLifecycleSettings = {
		enabled: source.enabled === true,
		startCommand: text("startCommand"),
		stopCommand: text("stopCommand"),
		workingDirectory: text("workingDirectory"),
		readinessUrl: text("readinessUrl"),
		startupTimeoutSeconds: numeric("startupTimeoutSeconds") ?? LOCAL_ASR_LIFECYCLE_DEFAULTS.startupTimeoutSeconds,
		idleTimeoutSeconds: numeric("idleTimeoutSeconds") ?? LOCAL_ASR_LIFECYCLE_DEFAULTS.idleTimeoutSeconds,
		shutdownTimeoutSeconds: numeric("shutdownTimeoutSeconds") ?? LOCAL_ASR_LIFECYCLE_DEFAULTS.shutdownTimeoutSeconds
	};
	for (const field of POSITIVE_SECONDS_FIELDS) {
		if (normalized[field] < 1) normalized[field] = LOCAL_ASR_LIFECYCLE_DEFAULTS[field];
	}
	for (const field of NON_NEGATIVE_SECONDS_FIELDS) {
		if (normalized[field] < 0) normalized[field] = LOCAL_ASR_LIFECYCLE_DEFAULTS[field];
	}
	if (normalized.startupTimeoutSeconds > 24 * 3600) normalized.startupTimeoutSeconds = 24 * 3600;
	if (normalized.shutdownTimeoutSeconds > 24 * 3600) normalized.shutdownTimeoutSeconds = 24 * 3600;
	if (normalized.idleTimeoutSeconds > 24 * 3600) normalized.idleTimeoutSeconds = 24 * 3600;
	return normalized;
}

/** Validation used by the settings UI before enabling; mirrors the approved prototype errors. */
export function validateLocalAsrLifecycleForEnable(settings: LocalAsrLifecycleSettings, baseUrl: string): string | undefined {
	if (!settings.startCommand.trim() || !settings.stopCommand.trim()) return "请先填写启动命令和关闭命令。";
	for (const field of POSITIVE_SECONDS_FIELDS) {
		if (!Number.isSafeInteger(settings[field]) || settings[field] < 1 || settings[field] > 86400) return "请填写有效的等待时间和空闲时间。";
	}
	for (const field of NON_NEGATIVE_SECONDS_FIELDS) {
		if (!Number.isSafeInteger(settings[field]) || settings[field] < 0 || settings[field] > 86400) return "请填写有效的等待时间和空闲时间。";
	}
	return validateLocalAsrReadinessUrl(settings.readinessUrl, baseUrl);
}

export type LocalAsrLifecycleDraft = {
	[Key in Exclude<keyof LocalAsrLifecycleSettings, "enabled">]: string;
};

export function validateLocalAsrLifecycleDraft(
	draft: LocalAsrLifecycleDraft, baseUrl: string, enabled: boolean
): { field: keyof LocalAsrLifecycleDraft; message: string } | undefined {
	if (enabled && !draft.startCommand.trim()) return { field: "startCommand", message: "请先填写启动命令和关闭命令。" };
	if (enabled && !draft.stopCommand.trim()) return { field: "stopCommand", message: "请先填写启动命令和关闭命令。" };
	for (const field of [...POSITIVE_SECONDS_FIELDS, ...NON_NEGATIVE_SECONDS_FIELDS]) {
		const value = Number(draft[field]);
		const minimum = field === "idleTimeoutSeconds" ? 0 : 1;
		if (!draft[field].trim() || !Number.isSafeInteger(value) || value < minimum || value > 86400) {
			return { field, message: minimum === 0 ? "空闲关闭时间请输入0～86400的整数。" : "等待时间请输入1～86400的整数。" };
		}
	}
	const error = validateLocalAsrReadinessUrl(draft.readinessUrl, baseUrl);
	return error ? { field: "readinessUrl", message: error } : undefined;
}

export interface LocalAsrProfileMap {
	[key: string]: LocalAsrLifecycleSettings;
}

/** Storage surface injected for determinism; real adapter uses app.load/saveLocalStorage. */
export interface LocalAsrSettingsStore {
	load(key: string): string | null;
	save(key: string, value: string): void;
}

export function readLocalAsrProfiles(store: LocalAsrSettingsStore): LocalAsrProfileMap {
	const raw = store.load(LOCAL_ASR_LIFECYCLE_STORAGE_KEY);
	if (!raw) return {};
	let parsed: unknown;
	try { parsed = JSON.parse(raw); } catch { return {}; }
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
	const profiles: LocalAsrProfileMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (!key) continue;
		profiles[key] = normalizeLocalAsrLifecycleSettings(value);
	}
	return profiles;
}

export function writeLocalAsrProfiles(store: LocalAsrSettingsStore, profiles: LocalAsrProfileMap): void {
	store.save(LOCAL_ASR_LIFECYCLE_STORAGE_KEY, JSON.stringify(profiles));
}

/** Does not persist runtime state beyond per-profile configuration. */
export function saveLocalAsrProfile(
	store: LocalAsrSettingsStore,
	provider: OfflineTranscriptionProviderId,
	baseUrl: string,
	settings: LocalAsrLifecycleSettings
): void {
	const profiles = readLocalAsrProfiles(store);
	profiles[normalizeLocalAsrServiceKey(provider, baseUrl)] = normalizeLocalAsrLifecycleSettings(settings);
	writeLocalAsrProfiles(store, profiles);
}

export function readLocalAsrProfile(
	store: LocalAsrSettingsStore,
	provider: OfflineTranscriptionProviderId,
	baseUrl: string
): LocalAsrLifecycleSettings {
	return readLocalAsrProfiles(store)[normalizeLocalAsrServiceKey(provider, baseUrl)]
		?? normalizeLocalAsrLifecycleSettings(undefined);
}

/** App-local storage adapter: failures remain observable without exposing commands. */
export function createAppLocalStorageStore(app: { loadLocalStorage(key: string): string | null; saveLocalStorage(key: string, value: string): void }): LocalAsrSettingsStore {
	return {
		load: (key) => {
			try { return app.loadLocalStorage(key); } catch { throw new Error("无法读取本机配置，请重开设置后重试。"); }
		},
		save: (key, value) => {
			try { app.saveLocalStorage(key, value); } catch { throw new Error("无法保存本机配置，请重试。当前修改未生效。"); }
		}
	};
}

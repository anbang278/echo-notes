import { strToU8, zipSync } from "fflate";
import type { DiagnosticSession } from "./diagnostic-types";
import { sanitizeDiagnosticData, sanitizeDiagnosticText } from "./diagnostic-store";

export interface DiagnosticExportTask {
	id: string;
	kind: string;
	status: string;
	provider?: string;
	model?: string;
	traceId?: string;
	diagnosticSessionId?: string;
	diagnosticChainId?: string;
	error?: string;
}

export interface DiagnosticExportContent {
	transcript?: string;
	analyses?: string;
	memoryCandidate?: string;
}

export interface DiagnosticExportInput {
	pluginVersion: string;
	obsidianVersion?: string;
	platform: "desktop" | "mobile";
	applicationLanguage: string;
	sessions: readonly DiagnosticSession[];
	tasks: readonly DiagnosticExportTask[];
	content?: DiagnosticExportContent;
}

export interface DiagnosticArchive {
	fileName: string;
	bytes: Uint8Array;
}

export function createDiagnosticArchive(input: DiagnosticExportInput): DiagnosticArchive {
	const sessions = input.sessions.map((session) => sanitizeSession(session));
	const events = sessions
		.flatMap((session) => session.events.map((event) => ({
			sessionId: session.id,
			chainId: session.chainId,
			kind: session.kind,
			...event
		})))
		.sort((left, right) => left.timestamp - right.timestamp)
		.map((event) => JSON.stringify(event))
		.join("\n");
	const manifest = {
		schemaVersion: 1,
		generatedAt: new Date().toISOString(),
		plugin: { id: "echo-notes", version: input.pluginVersion },
		host: {
			obsidianVersion: input.obsidianVersion ?? "unknown",
			platform: input.platform,
			applicationLanguage: sanitizeDiagnosticText(input.applicationLanguage, 40)
		},
		privacy: {
			audioIncluded: false,
			defaultContentExcluded: !input.content?.transcript && !input.content?.analyses && !input.content?.memoryCandidate,
			apiKeys: "not-collected",
			pathsAndFileNames: "not-collected"
		},
		sessions: sessions.map(({ events: _events, ...session }) => session),
		tasks: input.tasks.map(sanitizeTask),
		legacyTaskNotice: input.tasks.length > 0 && sessions.length === 0
			? "这些任务没有结构化会话。请升级后重现一次，才能获得请求级诊断日志。"
			: undefined,
		diagnosticHints: buildHints(sessions, input.applicationLanguage)
	};
	const files: Record<string, Uint8Array> = {
		"README.md": strToU8(renderReadme(Boolean(input.content?.transcript || input.content?.analyses || input.content?.memoryCandidate))),
		"manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
		"events.jsonl": strToU8(events ? `${events}\n` : "")
	};
	if (input.content?.transcript) {
		files["optional/transcript.md"] = strToU8(input.content.transcript);
	}
	if (input.content?.analyses) {
		files["optional/analysis.md"] = strToU8(input.content.analyses);
	}
	if (input.content?.memoryCandidate) {
		files["optional/memory-candidate.json"] = strToU8(input.content.memoryCandidate);
	}
	return {
		fileName: `echo-notes-diagnostics-${formatTimestamp(new Date())}-${randomSuffix()}.zip`,
		bytes: zipSync(files, { level: 6 })
	};
}

function sanitizeSession(session: DiagnosticSession): DiagnosticSession {
	return {
		...session,
		events: session.events.map((event) => ({
			...event,
			name: sanitizeDiagnosticText(event.name, 120),
			...(event.data ? { data: sanitizeDiagnosticData(event.data) } : {})
		}))
	};
}

function sanitizeTask(task: DiagnosticExportTask): Record<string, string | undefined> {
	return {
		id: sanitizeDiagnosticText(task.id, 120),
		kind: sanitizeDiagnosticText(task.kind, 40),
		status: sanitizeDiagnosticText(task.status, 40),
		provider: task.provider ? sanitizeDiagnosticText(task.provider, 120) : undefined,
		model: task.model ? sanitizeDiagnosticText(task.model, 160) : undefined,
		traceId: task.traceId ? sanitizeDiagnosticText(task.traceId, 500) : undefined,
		diagnosticSessionId: task.diagnosticSessionId,
		diagnosticChainId: task.diagnosticChainId,
		error: task.error ? sanitizeDiagnosticText(task.error, 800) : undefined
	};
}

function buildHints(sessions: readonly DiagnosticSession[], applicationLanguage: string): string[] {
	const hints: string[] = [];
	const appLanguage = applicationLanguage.toLocaleLowerCase();
	for (const session of sessions) {
		if (session.kind !== "transcription") {
			continue;
		}
		const config = session.events.find((event) => event.name === "transcription-configuration")?.data;
		const language = typeof config?.language === "string" ? config.language.toLocaleLowerCase() : "";
		const provider = config?.provider;
		if (provider === "aliyun-bailian" && language && language !== "auto" && !appLanguage.startsWith(language.split("-")[0])) {
			hints.push("阿里百炼请求使用显式转写语言，与应用语言环境不一致；请确认该语言参数是否符合录音语言。此项仅供排查，不代表已确认根因。");
		}
	}
	return Array.from(new Set(hints));
}

function renderReadme(includesOptionalContent: boolean): string {
	return [
		"# Echo Notes 诊断日志包",
		"",
		"请将整个 ZIP 文件发送给 Echo Notes 支持人员。此包仅在本地生成，插件不会自动上传。",
		"",
		"## 固定内容",
		"",
		"- `manifest.json`：版本、脱敏配置快照、任务索引和诊断提示。",
		"- `events.jsonl`：按时间排序的脱敏请求生命周期事件。",
		"",
		"## 隐私边界",
		"",
		"- 音频、API Key、鉴权头、SecretStorage 标识、Vault 名称、文件名和本地路径不会包含在包内。",
		"- 原始服务端响应、提示词和默认正文不会自动保存。",
		includesOptionalContent
			? "- 本次导出包含用户明确勾选的可选内容；发送前请再次确认内容可对外提供。"
			: "- 本次未包含转写正文、AI 分析结果或 Memory 候选内容。",
		"",
		"诊断记录默认只保留在插件设置中，最近 20 次且最长 7 天。清空诊断记录不会删除已生成的 ZIP。"
	].join("\n");
}

function formatTimestamp(date: Date): string {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function randomSuffix(): string {
	return Math.random().toString(36).slice(2, 8);
}

import { insertOrReplaceManagedBlock } from "../memory/memory-output";
import type { CatalogYamlCodec, MeetingTime } from "./catalog-types";
import { validateMeetingTime } from "./catalog-time";

export interface CatalogDocument {
	properties: Record<string, unknown>;
	body: string;
	lineEnding: string;
}

export function parseCatalogDocument(content: string, yaml: CatalogYamlCodec): CatalogDocument {
	const lineEnding = content.includes("\r\n") ? "\r\n" : "\n";
	if (!content.startsWith("---")) return { properties: {}, body: content, lineEnding };
	const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
	if (!match) throw new Error("Frontmatter 标记不完整，请修复后重试。");
	const parsed = yaml.parse(match[1]);
	if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) throw new Error("Frontmatter 必须是属性对象。");
	const properties = parsed as Record<string, unknown> ?? {};
	if (properties.echo_schema !== undefined && properties.echo_schema !== 1 && (properties.echo_kind !== undefined || properties.echo_source_id !== undefined || properties.echo_meeting_id !== undefined || properties.echo_project_id !== undefined)) throw new Error("资料版本不受支持，请升级插件后重试。");
	return { properties, body: content.slice(match[0].length), lineEnding };
}

export function updateCatalogDocument(content: string, changes: Record<string, unknown>, yaml: CatalogYamlCodec): string {
	const parsed = parseCatalogDocument(content, yaml);
	const properties = { ...parsed.properties };
	for (const [key, value] of Object.entries(changes)) {
		if (value === undefined) delete properties[key];
		else properties[key] = value;
	}
	const serialized = yaml.stringify(properties).trimEnd().replace(/\r?\n/g, parsed.lineEnding);
	return `---${parsed.lineEnding}${serialized}${parsed.lineEnding}---${parsed.lineEnding}${parsed.body}`;
}

export function stringProperty(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
	return undefined;
}

export function stringListProperty(value: unknown): string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") return [value];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error("列表属性必须只包含字符串。");
	return [...new Set(value as string[])];
}

export function catalogDocumentTitle(content: string, path: string): string {
	const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
	return /^#\s+(.+?)\s*#*\s*$/m.exec(body)?.[1]?.trim() || path.split("/").pop()?.replace(/\.md$/i, "") || path;
}

export function readMeetingTime(properties: Record<string, unknown>): MeetingTime {
	const precision = properties.echo_time_precision;
	if (precision === undefined || precision === "unknown") {
		if (precision === "unknown" && [properties.echo_started_at, properties.echo_ended_at, properties.echo_meeting_date].some((value) => value !== undefined)) throw new Error("未知日期精度与已有时间字段冲突。");
		return { precision: "unknown", reason: stringProperty(properties.echo_time_reason) };
	}
	if (precision === "date") {
		if (properties.echo_started_at !== undefined || properties.echo_ended_at !== undefined) throw new Error("日期精度与起止时刻字段冲突。");
		const time: MeetingTime = { precision: "date", date: stringProperty(properties.echo_meeting_date) ?? "", source: properties.echo_time_source === "user" ? "user" : "legacy", confirmed: properties.echo_time_confirmed === true };
		validateMeetingTime(time);
		return time;
	}
	if (precision !== "instant") throw new Error("会议时间精度无法识别。");
	if (properties.echo_meeting_date !== undefined) throw new Error("精确时间与日期字段冲突。");
	const time: MeetingTime = {
		precision: "instant", startedAt: stringProperty(properties.echo_started_at) ?? "",
		endedAt: stringProperty(properties.echo_ended_at), timezone: stringProperty(properties.echo_timezone),
		source: properties.echo_time_source === "user" ? "user" : "recording", confirmed: properties.echo_time_confirmed === true
	};
	validateMeetingTime(time);
	return time;
}

export function meetingTimeProperties(time: MeetingTime): Record<string, unknown> {
	validateMeetingTime(time);
	const properties: Record<string, unknown> = {
		echo_time_precision: time.precision, echo_started_at: undefined, echo_ended_at: undefined,
		echo_timezone: undefined, echo_meeting_date: undefined, echo_time_source: undefined,
		echo_time_confirmed: undefined, echo_time_reason: undefined
	};
	if (time.precision === "unknown") properties.echo_time_reason = time.reason;
	else {
		properties.echo_time_source = time.source;
		properties.echo_time_confirmed = time.confirmed;
		if (time.precision === "date") properties.echo_meeting_date = time.date;
		else {
			properties.echo_started_at = time.startedAt;
			properties.echo_ended_at = time.endedAt;
			properties.echo_timezone = time.timezone;
		}
	}
	return properties;
}

export async function catalogSha256(content: string): Promise<string> {
	const buffer = new TextEncoder().encode(content);
	const hash = await crypto.subtle.digest("SHA-256", buffer);
	return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function createCatalogId(kind: string): string {
	return `${kind}_${crypto.randomUUID()}`;
}

export function replaceCatalogManagedBlock(content: string, start: string, end: string, block: string): string {
	const starts = content.split(start).length - 1;
	const ends = content.split(end).length - 1;
	if (starts !== ends || starts > 1 || (starts === 1 && content.indexOf(end) < content.indexOf(start))) throw new Error("托管区块标记不完整或重复，请先修复。");
	if (starts === 1) return insertOrReplaceManagedBlock(content, start, end, block);
	return `${content}${content.endsWith("\n") ? "\n" : "\n\n"}${block}\n`;
}

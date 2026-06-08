export type TranscriptAnalysisStatus =
	| "analysis_pending"
	| "analysis_done"
	| "analysis_failed"
	| "analysis_partial_failed";

export interface TranscriptAnalysisMetadataInput {
	templateId: string;
	provider: string;
	model: string;
	timestamp: string;
	error?: string;
}

type AnalysisMetadataEvent = "pending" | "done" | "failed";

const ANALYSIS_METADATA_KEYS = [
	"analysis_status",
	"analysis_template_ids",
	"analysis_pending_template_ids",
	"analysis_done_template_ids",
	"analysis_failed_template_ids",
	"analysis_provider",
	"analysis_model",
	"analysis_started_at",
	"analysis_updated_at",
	"analysis_completed_at",
	"analysis_error"
];

export function markTranscriptAnalysisPending(content: string, input: TranscriptAnalysisMetadataInput): string {
	return updateTranscriptAnalysisMetadata(content, input, "pending");
}

export function markTranscriptAnalysisDone(content: string, input: TranscriptAnalysisMetadataInput): string {
	return updateTranscriptAnalysisMetadata(content, input, "done");
}

export function markTranscriptAnalysisFailed(content: string, input: TranscriptAnalysisMetadataInput): string {
	return updateTranscriptAnalysisMetadata(content, input, "failed");
}

function updateTranscriptAnalysisMetadata(
	content: string,
	input: TranscriptAnalysisMetadataInput,
	event: AnalysisMetadataEvent
): string {
	const frontmatter = splitFrontmatter(content);
	const frontmatterLines = frontmatter ? frontmatter.content.split(/\r?\n/) : [];
	const allTemplateIds = readYamlArrayField(frontmatterLines, "analysis_template_ids");
	const pendingTemplateIds = readYamlArrayField(frontmatterLines, "analysis_pending_template_ids");
	const doneTemplateIds = readYamlArrayField(frontmatterLines, "analysis_done_template_ids");
	const failedTemplateIds = readYamlArrayField(frontmatterLines, "analysis_failed_template_ids");
	const existingError = readYamlScalarField(frontmatterLines, "analysis_error");

	const templateId = input.templateId.trim();
	if (!templateId) {
		return content;
	}

	const nextAllTemplateIds = addUnique(allTemplateIds, templateId);
	let nextPendingTemplateIds = removeValue(pendingTemplateIds, templateId);
	let nextDoneTemplateIds = removeValue(doneTemplateIds, templateId);
	let nextFailedTemplateIds = removeValue(failedTemplateIds, templateId);

	if (event === "pending") {
		nextPendingTemplateIds = addUnique(nextPendingTemplateIds, templateId);
	}
	if (event === "done") {
		nextDoneTemplateIds = addUnique(nextDoneTemplateIds, templateId);
	}
	if (event === "failed") {
		nextFailedTemplateIds = addUnique(nextFailedTemplateIds, templateId);
	}

	const status = resolveAnalysisStatus(nextPendingTemplateIds, nextDoneTemplateIds, nextFailedTemplateIds);
	const fields = new Map<string, string | string[]>();
	fields.set("analysis_status", status);
	fields.set("analysis_template_ids", nextAllTemplateIds);
	setArrayField(fields, "analysis_pending_template_ids", nextPendingTemplateIds);
	setArrayField(fields, "analysis_done_template_ids", nextDoneTemplateIds);
	setArrayField(fields, "analysis_failed_template_ids", nextFailedTemplateIds);
	fields.set("analysis_provider", input.provider);
	fields.set("analysis_model", input.model);
	if (event === "pending") {
		fields.set("analysis_started_at", input.timestamp);
	} else {
		const existingStartedAt = readYamlScalarField(frontmatterLines, "analysis_started_at");
		if (existingStartedAt) {
			fields.set("analysis_started_at", existingStartedAt);
		}
	}
	fields.set("analysis_updated_at", input.timestamp);
	if (nextPendingTemplateIds.length === 0 && (nextDoneTemplateIds.length > 0 || nextFailedTemplateIds.length > 0)) {
		fields.set("analysis_completed_at", input.timestamp);
	}
	if (event === "failed" && input.error?.trim()) {
		fields.set("analysis_error", input.error.trim());
	} else if (nextFailedTemplateIds.length > 0 && existingError) {
		fields.set("analysis_error", existingError);
	}

	const preservedFrontmatterLines = removeManagedFields(frontmatterLines);
	const nextFrontmatter = [...preservedFrontmatterLines, ...renderAnalysisFields(fields)].filter((line, index, lines) => {
		return line.trim() || index < lines.length - 1;
	});

	if (!frontmatter) {
		return [`---`, ...nextFrontmatter, `---`, "", content.trimStart()].join("\n");
	}

	return `${frontmatter.prefix}${nextFrontmatter.join("\n")}${frontmatter.suffix}`;
}

function splitFrontmatter(content: string): { prefix: string; content: string; suffix: string } | null {
	if (!content.startsWith("---\n")) {
		return null;
	}

	const endIndex = content.indexOf("\n---", 4);
	if (endIndex === -1) {
		return null;
	}

	return {
		prefix: "---\n",
		content: content.slice(4, endIndex),
		suffix: content.slice(endIndex)
	};
}

function readYamlScalarField(lines: string[], key: string): string {
	const line = lines.find((candidate) => getTopLevelKey(candidate) === key);
	if (!line) {
		return "";
	}

	const separatorIndex = line.indexOf(":");
	return unquoteYamlScalar(line.slice(separatorIndex + 1).trim());
}

function readYamlArrayField(lines: string[], key: string): string[] {
	const lineIndex = lines.findIndex((candidate) => getTopLevelKey(candidate) === key);
	if (lineIndex === -1) {
		return [];
	}

	const line = lines[lineIndex];
	const separatorIndex = line.indexOf(":");
	const inlineValue = line.slice(separatorIndex + 1).trim();
	if (inlineValue) {
		return parseYamlArrayValue(inlineValue);
	}

	const values: string[] = [];
	for (let index = lineIndex + 1; index < lines.length; index += 1) {
		const match = lines[index].match(/^\s*-\s+(.+)$/);
		if (!match) {
			break;
		}
		values.push(...parseYamlArrayValue(match[1].trim()));
	}

	return unique(values);
}

function parseYamlArrayValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return unique(
			trimmed
				.slice(1, -1)
				.split(",")
				.map((item) => unquoteYamlScalar(item.trim()))
				.filter(Boolean)
		);
	}

	return [unquoteYamlScalar(trimmed)].filter(Boolean);
}

function removeManagedFields(lines: string[]): string[] {
	const managedKeys = new Set(ANALYSIS_METADATA_KEYS);
	const result: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const key = getTopLevelKey(lines[index]);
		if (!key || !managedKeys.has(key)) {
			result.push(lines[index]);
			continue;
		}

		while (index + 1 < lines.length && /^\s*-\s+/.test(lines[index + 1])) {
			index += 1;
		}
	}

	return result;
}

function renderAnalysisFields(fields: Map<string, string | string[]>): string[] {
	const lines: string[] = [];

	for (const key of ANALYSIS_METADATA_KEYS) {
		const value = fields.get(key);
		if (Array.isArray(value)) {
			if (value.length > 0) {
				lines.push(`${key}: [${value.map(escapeYamlArrayValue).join(", ")}]`);
			}
			continue;
		}
		if (typeof value === "string" && value.trim()) {
			lines.push(`${key}: ${escapeYamlScalar(value.trim())}`);
		}
	}

	return lines;
}

function getTopLevelKey(line: string): string {
	const match = /^([A-Za-z0-9_-]+):/.exec(line);
	return match?.[1] ?? "";
}

function resolveAnalysisStatus(
	pendingTemplateIds: string[],
	doneTemplateIds: string[],
	failedTemplateIds: string[]
): TranscriptAnalysisStatus {
	if (pendingTemplateIds.length > 0) {
		return "analysis_pending";
	}
	if (failedTemplateIds.length > 0 && doneTemplateIds.length > 0) {
		return "analysis_partial_failed";
	}
	if (failedTemplateIds.length > 0) {
		return "analysis_failed";
	}
	return "analysis_done";
}

function setArrayField(fields: Map<string, string | string[]>, key: string, value: string[]): void {
	if (value.length > 0) {
		fields.set(key, value);
	}
}

function addUnique(values: string[], value: string): string[] {
	return unique([...values, value]);
}

function removeValue(values: string[], value: string): string[] {
	const normalizedValue = value.trim().toLowerCase();
	return values.filter((candidate) => candidate.trim().toLowerCase() !== normalizedValue);
}

function unique(values: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const trimmed = value.trim();
		const normalized = trimmed.toLowerCase();
		if (!trimmed || seen.has(normalized)) {
			continue;
		}
		seen.add(normalized);
		result.push(trimmed);
	}

	return result;
}

function escapeYamlArrayValue(value: string): string {
	return /^[A-Za-z0-9_./-]+$/.test(value) ? value : escapeYamlScalar(value);
}

function escapeYamlScalar(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function unquoteYamlScalar(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}

	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}

	return value;
}

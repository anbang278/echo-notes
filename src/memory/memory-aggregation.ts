import { insertOrReplaceManagedBlock, normalizeEntityName } from "./memory-output";
import {
	MEMORY_RELATION_TYPE_LABELS,
	type MemoryRelationAnnotation
} from "./memory-relation";
import {
	formatProposedTier,
	formatMemoryType,
	type MemoryAssertion,
	type MemoryPaths
} from "./memory-types";

export const MEMORY_AGGREGATION_MANAGED_START = "<!-- echo-memory-aggregation:managed:start -->";
export const MEMORY_AGGREGATION_MANAGED_END = "<!-- echo-memory-aggregation:managed:end -->";
export const MEMORY_HOME_AGGREGATION_START = "<!-- echo-memory-home-aggregation:start -->";
export const MEMORY_HOME_AGGREGATION_END = "<!-- echo-memory-home-aggregation:end -->";

export type MemoryAggregationKind = "projects" | "people" | "timeline";

export interface MemoryAggregationEntry {
	assertion: MemoryAssertion;
	candidateId: string;
	candidatePath: string;
	reviewPath: string;
	relationAnnotations: MemoryRelationAnnotation[];
}

export interface MemoryAggregationCompilation {
	kind: MemoryAggregationKind;
	path: string;
	title: string;
	entryCount: number;
	managedBlock: string;
}

export function createMemoryAggregationCompilations(
	entries: readonly MemoryAggregationEntry[],
	paths: MemoryPaths,
	entityIndex: Readonly<Record<string, string>>,
	language: "zh" | "en"
): MemoryAggregationCompilation[] {
	const definitions: Array<{ kind: MemoryAggregationKind; path: string; title: string }> = language === "en"
		? [
			{ kind: "projects", path: paths.projectAggregation, title: "Project Memory" },
			{ kind: "people", path: paths.peopleAggregation, title: "People Memory" },
			{ kind: "timeline", path: paths.timelineAggregation, title: "Memory Timeline" }
		]
		: [
			{ kind: "projects", path: paths.projectAggregation, title: "项目记忆" },
			{ kind: "people", path: paths.peopleAggregation, title: "人物记忆" },
			{ kind: "timeline", path: paths.timelineAggregation, title: "记忆时间线" }
		];

	return definitions.map((definition) => {
		const selected = definition.kind === "projects"
			? entries.filter((entry) => entry.assertion.subjectType === "project")
			: definition.kind === "people"
				? entries.filter((entry) => entry.assertion.subjectType === "person")
				: [...entries];
		return {
			...definition,
			entryCount: selected.length,
			managedBlock: renderMemoryAggregationManagedBlock(
				definition.kind,
				selected,
				entityIndex,
				language
			)
		};
	});
}

export function renderInitialMemoryAggregation(
	compilation: MemoryAggregationCompilation,
	language: "zh" | "en"
): string {
	return [
		"---",
		"echo_memory_type: aggregation",
		`echo_memory_aggregation: ${compilation.kind}`,
		"---",
		"",
		`# ${compilation.title}`,
		"",
		language === "en" ? "## Manual Notes" : "## 人工内容",
		"",
		compilation.managedBlock,
		""
	].join("\n");
}

export function updateMemoryAggregationDocument(
	content: string,
	managedBlock: string
): string {
	return insertOrReplaceManagedBlock(
		content,
		MEMORY_AGGREGATION_MANAGED_START,
		MEMORY_AGGREGATION_MANAGED_END,
		managedBlock
	);
}

export function renderMemoryAggregationHomeBlock(paths: MemoryPaths, language: "zh" | "en"): string {
	return [
		MEMORY_HOME_AGGREGATION_START,
		language === "en" ? "## Cross-record views" : "## 跨记录视图",
		"",
		`- [[${paths.projectAggregation}|${language === "en" ? "Projects" : "项目"}]]`,
		`- [[${paths.peopleAggregation}|${language === "en" ? "People" : "人物"}]]`,
		`- [[${paths.timelineAggregation}|${language === "en" ? "Timeline" : "时间线"}]]`,
		`- [[${paths.contextPackagesDir}|${language === "en" ? "Context Packages" : "上下文包"}]]`,
		MEMORY_HOME_AGGREGATION_END
	].join("\n");
}

export function updateMemoryAggregationHome(
	content: string,
	paths: MemoryPaths,
	language: "zh" | "en"
): string {
	return insertOrReplaceManagedBlock(
		content,
		MEMORY_HOME_AGGREGATION_START,
		MEMORY_HOME_AGGREGATION_END,
		renderMemoryAggregationHomeBlock(paths, language)
	);
}

function renderMemoryAggregationManagedBlock(
	kind: MemoryAggregationKind,
	entries: readonly MemoryAggregationEntry[],
	entityIndex: Readonly<Record<string, string>>,
	language: "zh" | "en"
): string {
	const body = kind === "timeline"
		? renderTimeline(entries, language)
		: renderEntityGroups(entries, entityIndex, language);
	const heading = language === "en" ? "## Echo Memory aggregation" : "## Echo Memory 聚合";
	return [
		MEMORY_AGGREGATION_MANAGED_START,
		heading,
		"",
		...(body.length > 0
			? body
			: [language === "en" ? "_No current approved memory._" : "_暂无当前已批准记忆。_"]),
		MEMORY_AGGREGATION_MANAGED_END
	].join("\n");
}

function renderEntityGroups(
	entries: readonly MemoryAggregationEntry[],
	entityIndex: Readonly<Record<string, string>>,
	language: "zh" | "en"
): string[] {
	const groups = new Map<string, MemoryAggregationEntry[]>();
	for (const entry of entries) {
		const normalizedName = normalizeEntityName(entry.assertion.subjectName);
		groups.set(normalizedName, [...(groups.get(normalizedName) ?? []), entry]);
	}
	return [...groups.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.flatMap(([, groupEntries]) => {
			const sortedEntries = sortEntries(groupEntries);
			const first = sortedEntries[0];
			const displayName = normalizeDisplayName(first.assertion.subjectName);
			const key = `${first.assertion.subjectType}:${normalizeEntityName(displayName)}`;
			const profilePath = entityIndex[key];
			const title = profilePath
				? `### [[${profilePath}|${escapeMarkdownInline(displayName)}]]`
				: `### ${escapeMarkdownInline(displayName)}`;
			return [
				title,
				"",
				...sortedEntries.flatMap((entry) => renderEntry(entry, false, language)),
				""
			];
		});
}

function renderTimeline(entries: readonly MemoryAggregationEntry[], language: "zh" | "en"): string[] {
	const groups = new Map<string, MemoryAggregationEntry[]>();
	for (const entry of sortEntries(entries)) {
		const date = getObservedDate(entry.assertion.observedAt, language);
		groups.set(date, [...(groups.get(date) ?? []), entry]);
	}
	return [...groups.entries()].flatMap(([date, group]) => [
		`### ${date}`,
		"",
		...group.flatMap((entry) => renderEntry(entry, true, language)),
		""
	]);
}

function renderEntry(
	entry: MemoryAggregationEntry,
	includeSubject: boolean,
	language: "zh" | "en"
): string[] {
	const { assertion } = entry;
	const subject = includeSubject ? `${escapeMarkdownInline(assertion.subjectName)} · ` : "";
	const observed = escapeMarkdownInline(assertion.observedAt);
	const evidenceLabel = language === "en" ? "Evidence" : "证据";
	const sourceLabel = language === "en" ? "Sources" : "来源";
	const typeLabel = language === "en" ? "Type" : "类型";
	const horizonLabel = language === "en" ? "Horizon" : "时效";
	const admissionLabel = language === "en" ? "Why remember" : "准入理由";
	const temporalLabel = language === "en" ? "Valid" : "时间范围";
	const lines = [
		`- ${observed} · **${subject}${escapeMarkdownInline(assertion.predicate)}**：${escapeMarkdownInline(assertion.value)}`,
		`  - ${typeLabel}：${formatMemoryType(assertion.memoryType, language)} · ${horizonLabel}：${formatProposedTier(assertion.proposedTier, language)}`,
		`  - ${evidenceLabel}：“${escapeMarkdownInline(assertion.evidenceQuote)}”`,
	];
	if (assertion.whyRemember) {
		lines.push(`  - ${admissionLabel}：${escapeMarkdownInline(assertion.whyRemember)}`);
	}
	const temporalText = formatTemporalText(assertion.temporal, language);
	if (temporalText) {
		lines.push(`  - ${temporalLabel}：${temporalText}`);
	}
	lines.push(`  - ${sourceLabel}：[[${assertion.sourcePath}|transcript]] · [[${entry.candidatePath}|${entry.candidateId}]] · [[${entry.reviewPath}|review]]`);
	lines.push(...entry.relationAnnotations.map((annotation) => renderRelationAnnotation(annotation, language)));
	return lines;
}

function renderRelationAnnotation(annotation: MemoryRelationAnnotation, language: "zh" | "en"): string {
	const counterpart = annotation.counterpart;
	const label = language === "en"
		? annotation.type
		: MEMORY_RELATION_TYPE_LABELS[annotation.type];
	return [
		`  - ${language === "en" ? "Relation" : "关系"}：${label}（${annotation.relationId}）`,
		`    - ${language === "en" ? "Linked memory" : "关联记忆"}：${escapeMarkdownInline(counterpart.predicate)}：${escapeMarkdownInline(counterpart.effectiveValue)} · [[${counterpart.transcriptPath}|transcript]] · [[${counterpart.candidatePath}|candidate]] · [[${counterpart.reviewPath}|review]]`
	].join("\n");
}

function sortEntries(entries: readonly MemoryAggregationEntry[]): MemoryAggregationEntry[] {
	return [...entries].sort((left, right) =>
		compareObservedAt(left.assertion.observedAt, right.assertion.observedAt) ||
		normalizeEntityName(left.assertion.subjectName).localeCompare(normalizeEntityName(right.assertion.subjectName)) ||
		left.assertion.predicate.localeCompare(right.assertion.predicate) ||
		left.candidateId.localeCompare(right.candidateId) ||
		left.assertion.id.localeCompare(right.assertion.id)
	);
}

function compareObservedAt(left: string, right: string): number {
	const leftTime = Date.parse(left);
	const rightTime = Date.parse(right);
	if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
		return leftTime - rightTime;
	}
	if (Number.isFinite(leftTime)) {
		return -1;
	}
	if (Number.isFinite(rightTime)) {
		return 1;
	}
	return left.localeCompare(right);
}

function getObservedDate(value: string, language: "zh" | "en"): string {
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
	return match?.[1] ?? (language === "en" ? "Date to confirm" : "时间待确认");
}

function escapeMarkdownInline(value: string): string {
	return value.replace(/\r?\n/g, " ").replace(/([\\`*_[\]<>])/g, "\\$1").trim();
}

function formatTemporalText(temporal: MemoryAssertion["temporal"], language: "zh" | "en"): string {
	if (!temporal) {
		return "";
	}
	const parts: string[] = [];
	if (temporal.validFrom) {
		parts.push(`${language === "en" ? "from" : "从"} ${temporal.validFrom}`);
	}
	if (temporal.validUntil) {
		parts.push(`${language === "en" ? "to" : "至"} ${temporal.validUntil}`);
	}
	return parts.join(" ");
}

function normalizeDisplayName(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ");
}

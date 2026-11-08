import { meetingDates, validateDisplayTimezone } from "../catalog/catalog-time";
import type { MeetingTime } from "../catalog/catalog-types";
import { createEvidenceId, evidenceSha256 } from "./evidence-hash";
import { parseAnalysisSections, parseFormalTranscript } from "./formal-transcript";
import type {
	EvidenceDocument, EvidenceItem, EvidenceIssue, EvidenceMatch, EvidenceMemory,
	EvidenceQueryV1, EvidenceSearchResult, EvidenceValidationResult, FormalParagraph, FormalTranscript
} from "./evidence-types";

export type EvidenceQueryOverrides = Omit<Partial<EvidenceQueryV1>, "filters"> & { filters?: Partial<EvidenceQueryV1["filters"]> };

export function createEvidenceQuery(question = "", overrides: EvidenceQueryOverrides = {}): EvidenceQueryV1 {
	return normalizeEvidenceQuery({
		protocolVersion: 1, question, keywords: suggestTerms(question), exactPhrases: [],
		includeHistoricalMemory: true, retrievalMode: "lexical", maxCharacters: 20_000,
		contextBefore: 1, contextAfter: 1, pinnedEvidenceIds: [], excludedEvidenceIds: [],
		...overrides,
		filters: { projectIds: [], meetingIds: [], timezone: "UTC", sourceKinds: ["transcript", "approved_memory"], ...overrides.filters }
	});
}

export function normalizeEvidenceQuery(query: EvidenceQueryV1): EvidenceQueryV1 {
	if (query.protocolVersion !== 1 || query.retrievalMode !== "lexical") throw new Error("证据查询协议或检索模式不受支持。");
	if (typeof query.question !== "string") throw new Error("问题必须是文本。");
	const filters = query.filters;
	if (!filters || !["string"].includes(typeof filters.timezone)) throw new Error("缺少明确的查询时区。");
	try { validateDisplayTimezone(filters.timezone); } catch { throw new Error("查询时区无效。"); }
	for (const value of [filters.fromDate, filters.toDateInclusive]) {
		if (value !== undefined && !validDate(value)) throw new Error("日期范围必须使用有效的 YYYY-MM-DD。");
	}
	if (filters.fromDate && filters.toDateInclusive && filters.fromDate > filters.toDateInclusive) throw new Error("起始日期不能晚于结束日期。");
	if (!Number.isFinite(query.maxCharacters) || query.maxCharacters < 1 || query.maxCharacters > 1_000_000) throw new Error("材料字符预算必须在 1 至 1000000 之间。");
	for (const count of [query.contextBefore, query.contextAfter]) {
		if (!Number.isInteger(count) || count < 0 || count > 20) throw new Error("前后文范围必须是 0 至 20 个完整段落。");
	}
	const kinds = [...new Set(filters.sourceKinds)];
	if (!kinds.every((kind) => ["transcript", "approved_memory", "analysis"].includes(kind))) throw new Error("资料类型不受支持。");
	const pinned = strings(query.pinnedEvidenceIds);
	const excluded = strings(query.excludedEvidenceIds);
	if (pinned.some((id) => excluded.includes(id))) throw new Error("同一材料不能同时固定与排除。");
	return {
		...query, keywords: strings(query.keywords), exactPhrases: strings(query.exactPhrases),
		maxCharacters: Math.floor(query.maxCharacters), includeHistoricalMemory: Boolean(query.includeHistoricalMemory),
		pinnedEvidenceIds: pinned, excludedEvidenceIds: excluded,
		filters: { ...filters, projectIds: strings(filters.projectIds), meetingIds: strings(filters.meetingIds), sourceKinds: kinds }
	};
}

export async function searchEvidence(
	documents: readonly EvidenceDocument[], input: EvidenceQueryV1, memoryInputs: readonly EvidenceMemory[] = []
): Promise<EvidenceSearchResult> {
	const query = normalizeEvidenceQuery(input);
	const issues: EvidenceIssue[] = [];
	const scoped = documents.filter((doc) => matchesFilters(doc, query));
	const duplicates = duplicateSourceIds(documents);
	const items: EvidenceItem[] = [];
	for (const document of scoped) {
		if (!document.sourceId || duplicates.has(document.sourceId)) {
			issues.push({ sourceId: document.sourceId, sourcePath: document.sourcePath, code: "IDENTITY_CONFLICT", message: "来源身份缺失或重复，需先解决登记冲突。" });
			continue;
		}
		if (document.missing) {
			issues.push({ sourceId: document.sourceId, sourcePath: document.sourcePath, code: "SOURCE_MISSING", message: "登记来源已删除或无法读取，请恢复或解除来源关联。" });
			continue;
		}
		const revision = await evidenceSha256(document.content.replace(/\r\n/g, "\n"));
		if (query.filters.sourceKinds.includes("transcript")) {
			const parsed = parseFormalTranscript(document.content);
			if (parsed.status !== "ok") issues.push({ sourceId: document.sourceId, sourcePath: document.sourcePath, code: "SOURCE_UNSUPPORTED", message: parsed.errors.join(" ") });
			else items.push(...await documentItems(document, parsed, revision, query, parsed.kind));
		}
		if (query.filters.sourceKinds.includes("analysis") && document.content.includes("<!-- echo-notes-analysis:")) {
			const parsed = parseAnalysisSections(document.content);
			if (parsed.status !== "ok") issues.push({ sourceId: document.sourceId, sourcePath: document.sourcePath, code: "SOURCE_UNSUPPORTED", message: parsed.errors.join(" ") });
			else items.push(...await documentItems(document, parsed, revision, query, "analysis"));
		}
	}
	items.sort((a, b) => b.score - a.score || chronological(a, b));
	const byId = new Map(items.map((item) => [item.evidenceId, item]));
	const pinned: EvidenceItem[] = [];
	for (const id of query.pinnedEvidenceIds) {
		const item = byId.get(id);
		if (item) pinned.push(item);
		else issues.push({ code: "PINNED_EVIDENCE_MISSING", message: `固定材料 ${id} 已更新、缺失或超出当前范围，请重新确认。` });
	}
	const excluded = new Set(query.excludedEvidenceIds);
	const pinnedIds = new Set(query.pinnedEvidenceIds);
	const selected = [...pinned];
	let characters = materialCharacters(pinned);
	if (characters > query.maxCharacters) issues.push({ code: "PINNED_OVER_BUDGET", message: "固定材料已超过预算，请调整固定项或明确扩大字符预算。" });
	const automatic = fairOrder(items.filter((item) => !pinnedIds.has(item.evidenceId) && !excluded.has(item.evidenceId)));
	let omittedByBudget = 0;
	for (const item of automatic) {
		const cost = itemCharacters(item);
		if (characters + cost > query.maxCharacters) { omittedByBudget++; continue; }
		selected.push(item);
		characters += cost;
	}
	const memories: EvidenceMemory[] = [];
	let omittedMemories = 0;
	const matchedMemories = query.filters.sourceKinds.includes("approved_memory") ? matchMemoryEvidence(memoryInputs, query) : [];
	for (const memory of [...matchedMemories].sort((a, b) => (a.meetingDate ?? "").localeCompare(b.meetingDate ?? "") || a.id.localeCompare(b.id))) {
		const cost = Array.from(memory.text).length;
		if (characters + cost > query.maxCharacters) { omittedMemories++; continue; }
		memories.push({ ...memory });
		characters += cost;
	}
	return {
		protocolVersion: 1, retrievalVersion: 1, query, items, selectedItems: selected, memories, issues,
		coverage: {
			scannedMeetings: new Set(scoped.map((doc) => doc.meetingId)).size,
			matchedMeetings: new Set(items.map((item) => item.meetingId)).size,
			includedMeetings: new Set(selected.map((item) => item.meetingId)).size,
			matchedItems: items.length, includedItems: selected.length, omittedByBudget,
			excludedByUser: items.filter((item) => excluded.has(item.evidenceId)).length,
			abnormalSources: new Set(issues.filter((issue) => issue.sourceId).map((issue) => issue.sourceId)).size,
			characters, budgetUnit: "unicode_code_point", matchedMemories: matchedMemories.length,
			includedMemories: memories.length, omittedMemories
		},
		canFreeze: !issues.some((issue) => issue.code === "PINNED_EVIDENCE_MISSING" || issue.code === "PINNED_OVER_BUDGET")
	};
}

export async function validateEvidence(selection: readonly EvidenceItem[], documents: readonly EvidenceDocument[]): Promise<EvidenceValidationResult> {
	const duplicates = duplicateSourceIds(documents);
	const byId = new Map(documents.map((doc) => [doc.sourceId, doc]));
	const items: EvidenceValidationResult["items"] = [];
	const issues: EvidenceIssue[] = [];
	for (const item of selection) {
		const doc = byId.get(item.sourceId);
		let sourceCheck: EvidenceItem["sourceCheck"] = "verified";
		let code: EvidenceIssue["code"] | undefined;
		if (duplicates.has(item.sourceId)) { sourceCheck = "ambiguous"; code = "IDENTITY_CONFLICT"; }
		else if (!doc || doc.missing) { sourceCheck = "missing"; code = "SOURCE_MISSING"; }
		else {
			const parsed = item.kind === "analysis" ? parseAnalysisSections(doc.content) : parseFormalTranscript(doc.content);
			const revision = await evidenceSha256(parsed.normalizedDocument);
			if (parsed.status !== "ok") { sourceCheck = "unsupported"; code = "SOURCE_UNSUPPORTED"; }
			else if (revision !== item.sourceRevision || !validItemRanges(item, parsed)) { sourceCheck = "changed"; code = "SOURCE_CHANGED"; }
			else if (await createEvidenceId(item.sourceId, item.sourceRevision, item.sourceRange.start, item.sourceRange.end) !== item.evidenceId) { sourceCheck = "changed"; code = "SOURCE_CHANGED"; }
		}
		items.push({ evidenceId: item.evidenceId, sourceCheck });
		if (code) issues.push({ sourceId: item.sourceId, sourcePath: doc?.sourcePath ?? item.sourcePath, code, message: `材料 ${item.evidenceId} 的来源${sourceCheck === "missing" ? "已缺失" : sourceCheck === "ambiguous" ? "身份冲突" : "已更新或无法核验"}，请刷新并重新确认。` });
	}
	return { valid: issues.length === 0, items, issues };
}

export async function expandEvidence(item: EvidenceItem, documents: readonly EvidenceDocument[], before: number, after: number): Promise<EvidenceItem> {
	if (![before, after].every((count) => Number.isInteger(count) && count >= 0 && count <= 20)) throw new Error("上下文范围无效。");
	const validation = await validateEvidence([item], documents);
	if (!validation.valid) throw new Error(validation.issues[0].message);
	const doc = documents.find((source) => source.sourceId === item.sourceId)!;
	const parsed = item.kind === "analysis" ? parseAnalysisSections(doc.content) : parseFormalTranscript(doc.content);
	const first = parsed.paragraphs.findIndex((paragraph) => paragraph.start === item.sourceRange.start);
	const last = parsed.paragraphs.findIndex((paragraph) => paragraph.end === item.sourceRange.end);
	if (first < 0 || last < first) throw new Error("原文片段边界无法定位，请重新检索。");
	const context = contextBounds(parsed.paragraphs, first, last, before, after);
	return { ...item, sourcePath: doc.sourcePath, contextRange: context, contextBefore: parsed.normalizedDocument.slice(context.start, item.sourceRange.start), contextAfter: parsed.normalizedDocument.slice(item.sourceRange.end, context.end) };
}

function validItemRanges(item: EvidenceItem, parsed: FormalTranscript): boolean {
	const source = item.sourceRange;
	const context = item.contextRange;
	if (![source.start, source.end, context.start, context.end].every(Number.isInteger)) return false;
	if (context.start > source.start || source.end > context.end || source.start >= source.end) return false;
	if (!parsed.ranges.some((range) => context.start >= range.start && context.end <= range.end)) return false;
	if ([source.start, source.end, context.start, context.end].some((offset) => splitsSurrogate(parsed.normalizedDocument, offset))) return false;
	return parsed.normalizedDocument.slice(source.start, source.end) === item.quote && parsed.normalizedDocument.slice(context.start, source.start) === item.contextBefore && parsed.normalizedDocument.slice(source.end, context.end) === item.contextAfter;
}

async function documentItems(document: EvidenceDocument, parsed: FormalTranscript, revision: string, query: EvidenceQueryV1, kind: EvidenceItem["kind"]): Promise<EvidenceItem[]> {
	const hits = parsed.paragraphs.flatMap((paragraph, index) => {
		const matches = matchText(paragraph.text, query);
		return matches.length ? [{ index, matches, context: contextBounds(parsed.paragraphs, index, index, query.contextBefore, query.contextAfter) }] : [];
	});
	const windows: Array<{ first: number; last: number; matches: EvidenceMatch[]; start: number; end: number }> = [];
	for (const hit of hits) {
		const previous = windows[windows.length - 1];
		if (previous && parsed.paragraphs[previous.last].sectionIndex === parsed.paragraphs[hit.index].sectionIndex && hit.context.start <= previous.end && Math.max(previous.end, hit.context.end) - previous.start <= query.maxCharacters) {
			previous.last = hit.index;
			previous.end = Math.max(previous.end, hit.context.end);
			previous.matches.push(...hit.matches);
		} else windows.push({ first: hit.index, last: hit.index, matches: [...hit.matches], start: hit.context.start, end: hit.context.end });
	}
	const result: EvidenceItem[] = [];
	for (const window of windows) {
		const a = parsed.paragraphs[window.first], b = parsed.paragraphs[window.last];
		const matches = [...new Map(window.matches.map((match) => [`${match.kind}\n${match.term}`, match])).values()];
		result.push({
			evidenceId: await createEvidenceId(document.sourceId, revision, a.start, b.end), sourceId: document.sourceId,
			sourceRevision: revision, sourcePath: document.sourcePath, sourceRange: { start: a.start, end: b.end },
			meetingId: document.meetingId, meetingTitle: document.title, meetingDate: document.meetingTime ? meetingDates(document.meetingTime, query.filters.timezone)[0] : document.meetingDate ?? document.meetingDates?.[0],
			projectIds: [...document.projectIds], kind, quote: parsed.normalizedDocument.slice(a.start, b.end),
			contextBefore: parsed.normalizedDocument.slice(window.start, a.start), contextAfter: parsed.normalizedDocument.slice(b.end, window.end),
			contextRange: { start: window.start, end: window.end }, ...(a.speaker ? { speaker: a.speaker } : {}),
			matches, score: matches.reduce((score, match) => score + (match.kind === "phrase" ? 8 : match.kind === "keyword" ? 4 : 1), 0), sourceCheck: "verified"
		});
	}
	return result;
}

function contextBounds(paragraphs: FormalParagraph[], first: number, last: number, before: number, after: number): { start: number; end: number } {
	const section = paragraphs[first].sectionIndex;
	let a = first, b = last;
	while (a > 0 && first - a < before && paragraphs[a - 1].sectionIndex === section) a--;
	while (b + 1 < paragraphs.length && b - last < after && paragraphs[b + 1].sectionIndex === section) b++;
	return { start: paragraphs[a].start, end: paragraphs[b].end };
}

/** Shared lexical/meeting-scope matching before budget selection or reader pagination. */
export function matchMemoryEvidence(memories: readonly EvidenceMemory[], query: EvidenceQueryV1): EvidenceMemory[] {
	return memories.filter((memory) => memory.approval === "approved" &&
		(query.includeHistoricalMemory || memory.resolvedValidity === "active") &&
		matchesFilters({ meetingId: memory.meetingId ?? "", meetingDate: memory.meetingDate, meetingDates: memory.meetingDates, meetingTime: memory.meetingTime, projectIds: memory.projectIds ?? [] }, query) &&
		matchText(memory.text, query).length > 0);
}

function matchText(text: string, query: EvidenceQueryV1): EvidenceMatch[] {
	if (!query.keywords.length && !query.exactPhrases.length) return [{ term: "按范围整理", kind: "scope" }];
	const haystack = text.toLocaleLowerCase("en");
	const matches: EvidenceMatch[] = [];
	for (const term of query.exactPhrases) if (haystack.includes(term.toLocaleLowerCase("en"))) matches.push({ term, kind: "phrase" });
	for (const term of query.keywords) {
		if (haystack.includes(term.toLocaleLowerCase("en"))) { matches.push({ term, kind: "keyword" }); continue; }
		const chars = Array.from(term);
		if (chars.length < 3 || !/\p{Script=Han}/u.test(term)) continue;
		const grams = [...new Set(chars.slice(0, -1).map((char, index) => char + chars[index + 1]).filter((gram) => /\p{Script=Han}/u.test(gram)))];
		const found = grams.filter((gram) => haystack.includes(gram));
		if (grams.length && found.length / grams.length >= 0.5) matches.push(...found.map((gram) => ({ term: gram, kind: "bigram" as const })));
	}
	return matches;
}

function matchesFilters(document: { meetingId: string; projectIds: string[]; meetingDate?: string; meetingDates?: string[]; meetingTime?: MeetingTime }, query: EvidenceQueryV1): boolean {
	const filters = query.filters;
	if (filters.projectIds.length && !filters.projectIds.some((id) => document.projectIds.includes(id))) return false;
	if (filters.meetingIds.length && !filters.meetingIds.includes(document.meetingId)) return false;
	if (!filters.fromDate && !filters.toDateInclusive) return true;
	const dates = document.meetingTime ? meetingDates(document.meetingTime, filters.timezone) : document.meetingDates ?? (document.meetingDate ? [document.meetingDate] : []);
	return dates.some((date) => (!filters.fromDate || date >= filters.fromDate) && (!filters.toDateInclusive || date <= filters.toDateInclusive));
}

function duplicateSourceIds(documents: readonly EvidenceDocument[]): Set<string> {
	const seen = new Set<string>(), duplicates = new Set<string>();
	for (const doc of documents) { if (seen.has(doc.sourceId)) duplicates.add(doc.sourceId); seen.add(doc.sourceId); }
	return duplicates;
}

function fairOrder(items: EvidenceItem[]): EvidenceItem[] {
	const groups = new Map<string, EvidenceItem[]>();
	for (const item of items) { const group = groups.get(item.meetingId) ?? []; group.push(item); groups.set(item.meetingId, group); }
	const result: EvidenceItem[] = [];
	// Smaller first windows maximize distinct-meeting coverage before later rounds.
	const ordered = [...groups.values()].sort((a, b) => itemCharacters(a[0]) - itemCharacters(b[0]) || b[0].score - a[0].score || chronological(a[0], b[0]));
	const rounds = Math.max(0, ...ordered.map((group) => group.length));
	for (let index = 0; index < rounds; index++) for (const group of ordered) if (group[index]) result.push(group[index]);
	return result;
}

function chronological(a: EvidenceItem, b: EvidenceItem): number {
	return (a.meetingDate ?? "9999").localeCompare(b.meetingDate ?? "9999") || a.meetingId.localeCompare(b.meetingId) || a.sourcePath.localeCompare(b.sourcePath) || a.sourceRange.start - b.sourceRange.start;
}

function itemCharacters(item: EvidenceItem): number {
	return Array.from(item.contextBefore + item.quote + item.contextAfter).length;
}

function materialCharacters(items: readonly EvidenceItem[]): number { return items.reduce((sum, item) => sum + itemCharacters(item), 0); }
function strings(values: readonly string[]): string[] {
	if (!Array.isArray(values) || !values.every((value) => typeof value === "string")) throw new Error("查询列表必须是文本数组。");
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
function validDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function splitsSurrogate(value: string, offset: number): boolean {
	const here = value.charCodeAt(offset), previous = value.charCodeAt(offset - 1);
	return here >= 0xdc00 && here <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
}
function suggestTerms(question: string): string[] {
	return [...new Set(question.replace(/为什么|为何|如何|怎样|哪些|什么|是否/g, " ").split(/[\s，。？！、,?!；;]+/u).map((value) => value.trim()).filter((value) => Array.from(value).length >= 2))];
}

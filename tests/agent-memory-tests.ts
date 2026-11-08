import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { AgentExportPublisher, MemoryReader, readMemoryProjection, type AgentMemoryStorage } from "../src/agent-memory";
import { createEvidenceQuery } from "../src/evidence";
import type { EvidenceDocument } from "../src/evidence/evidence-types";
import { renderMemoryCandidate } from "../src/memory/memory-output";
import { applyMemoryReviewUpdates, createMemoryReview, renderMemoryReview } from "../src/memory/memory-review";
import { confirmMemoryRelation, createMemoryRelationEndpoint, createMemoryRelationStore, renderMemoryRelationStore } from "../src/memory/memory-relation";
import { currentProjectedMemories, projectMemories } from "../src/memory/memory-projection";
import type { MemoryCandidatePackage, MemoryReviewPackage } from "../src/memory/memory-types";

const at = "2026-11-08T03:00:00Z";
const candidatePath = "Memory/Candidates/decision.md";
const reviewPath = "Memory/Candidates/decision.review.md";
const relationPath = "Memory/System/echo-memory-relations.json";
const sourcePath = "Transcripts/meeting.transcript.md";
const meetingPath = "Memory/Meetings/meeting.md";
const projectPath = "Memory/Projects/project.md";

function revision(content: string): string {
	return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

class Storage implements AgentMemoryStorage {
	files = new Map<string, string>();
	writes = 0;
	onRead?: (path: string, value: string | null) => void;
	async read(path: string): Promise<string | null> {
		const value = this.files.get(path) ?? null;
		this.onRead?.(path, value);
		return value;
	}
	async write(path: string, content: string, options?: { exclusive?: boolean }): Promise<void> {
		if (options?.exclusive && this.files.has(path)) throw new Error("exists");
		this.files.set(path, content);
		this.writes++;
	}
	async list(root: string): Promise<string[]> {
		return [...this.files.keys()].filter((path) => path.startsWith(`${root}/`)).sort();
	}
}

function candidate(id = "candidate-1", value = "采用人工干预入口。", assertionId = "assertion-1"): MemoryCandidatePackage {
	return {
		schemaVersion: 2, id, fingerprint: `fingerprint-${id}`, createdAt: at, provider: "fixture", model: "fixture", traceIds: [],
		source: { transcriptPath: sourcePath, transcriptTitle: "会议", analysisTemplateIds: [] },
		assertions: [{ id: assertionId, subjectType: "project", subjectName: "订单履约", category: "other", predicate: "策略", value, confidence: 0.9, evidenceQuote: value, memoryType: "decision", proposedTier: "long_term", whyRemember: "追溯决策", temporal: { scope: "ongoing" }, observedAt: at, sourcePath, chunkIndex: 0 }]
	};
}

function approved(item: MemoryCandidatePackage, path = candidatePath): MemoryReviewPackage {
	return applyMemoryReviewUpdates(createMemoryReview(item, path, at), item, item.assertions.map((assertion) => ({ assertionId: assertion.id, status: "approved", effectiveValue: assertion.value, note: "", authority: "user_confirmed", validity: "active" })), at);
}

function document(): EvidenceDocument {
	return { sourceId: "source-1", meetingId: "meeting-1", sourcePath, title: "订单履约评审", meetingDate: "2026-11-07", projectIds: ["project-1"], content: "---\ntype: audio-transcript\necho_source_id: source-1\n---\n<!-- echo-notes-transcript:start -->\n# 会议转写\n\n采用人工干预入口。\n\n先观察异常情况。\n<!-- echo-notes-transcript:end -->\n" };
}

async function fixture(withReview = true): Promise<{ storage: Storage; publisher: AgentExportPublisher; reader: MemoryReader; item: MemoryCandidatePackage; review: MemoryReviewPackage; doc: EvidenceDocument }> {
	const storage = new Storage();
	const item = candidate();
	const review = approved(item);
	const doc = document();
	storage.files.set(sourcePath, doc.content);
	storage.files.set(candidatePath, renderMemoryCandidate(item));
	if (withReview) storage.files.set(reviewPath, renderMemoryReview(review, item));
	const meetingContent = "---\necho_meeting_id: meeting-1\necho_project_ids: [project-1]\n---\n# 订单履约评审\n";
	const projectContent = "---\necho_project_id: project-1\n---\n# 订单履约\n";
	storage.files.set(meetingPath, meetingContent);
	storage.files.set(projectPath, projectContent);
	let serial = 0;
	const publisher = new AgentExportPublisher(storage, { systemDir: "Memory/System", vaultId: "vault-1", now: () => at, id: () => String(++serial) });
	await publisher.setPolicy({ enabled: true, sourceKinds: ["approved_memory", "transcript"], allowedRoots: ["Memory", "Transcripts"] });
	await publisher.publish({ documents: [doc], meetings: [{ id: "meeting-1", path: meetingPath, title: doc.title, date: doc.meetingDate, projectIds: ["project-1"], sourceRevision: revision(meetingContent) }], projects: [{ id: "project-1", path: projectPath, name: "订单履约", aliases: [], status: "active", sourceRevision: revision(projectContent) }], authorityRoots: ["Memory/Candidates"], relationPath });
	const reader = new MemoryReader(storage, { policyPath: publisher.policyPath, now: () => at });
	return { storage, publisher, reader, item, review, doc };
}

function resultItems(response: Awaited<ReturnType<MemoryReader["execute"]>>): Array<Record<string, unknown>> {
	return (response.data as { items: Array<Record<string, unknown>> }).items;
}

test("reader uses complete saved generation and leaves all business data unchanged", async () => {
	const { storage, reader } = await fixture();
	const before = [...storage.files.entries()];
	const writes = storage.writes;
	const response = await reader.execute({ command: "search", kind: "memory", query: createEvidenceQuery("人工干预") });
	assert.equal(response.status, "ok");
	assert.equal(resultItems(response).length, 1);
	assert.equal(resultItems(response)[0].approval, "approved");
	assert.equal(resultItems(response)[0].resolvedValidity, "active");
	assert.equal(resultItems(response)[0].authority, "user_confirmed");
	assert.equal("assertion" in resultItems(response)[0], false, "raw candidate evidence is not included in memory-only responses");
	assert.deepEqual([...storage.files.entries()], before);
	assert.equal(storage.writes, writes);
});

test("missing Review is unverified and never causes query-time sidecar creation", async () => {
	const { storage, reader } = await fixture(false);
	const response = await reader.execute({ command: "search", kind: "memory" });
	assert.equal(resultItems(response).length, 0);
	assert.equal(storage.files.has(reviewPath), false);
});

test("new Review file after a snapshot changes current authority immediately", async () => {
	const { storage, reader, item, review } = await fixture(false);
	storage.files.set(reviewPath, renderMemoryReview(review, item));
	const response = await reader.execute({ command: "search", kind: "memory" });
	assert.equal(response.status, "partial");
	assert.equal(resultItems(response).length, 1);
	assert.ok(response.warnings.some((warning) => warning.code === "AUTHORITY_UNVERIFIED"));
});

test("revoked or deleted Review cannot retain snapshot approval", async () => {
	const { storage, reader, item, review } = await fixture();
	const rejected = applyMemoryReviewUpdates(review, item, [{ assertionId: "assertion-1", status: "rejected", effectiveValue: item.assertions[0].value, note: "撤销" }], at);
	storage.files.set(reviewPath, renderMemoryReview(rejected, item));
	assert.equal(resultItems(await reader.execute({ command: "search", kind: "memory" })).length, 0);
	storage.files.delete(reviewPath);
	assert.equal(resultItems(await reader.execute({ command: "search", kind: "memory" })).length, 0);
});

test("time validity and historical state are jointly evaluated without changing stored validity", async () => {
	const item = candidate();
	const review = approved(item);
	review.reviews["assertion-1"].validUntil = "2026-11-01T00:00:00Z";
	const projection = projectMemories([{ candidatePath, reviewPath, candidate: item, review }], createMemoryRelationStore(at), at);
	assert.equal(projection.items[0].storedValidity, "active");
	assert.equal(projection.items[0].resolvedValidity, "expired");
	assert.equal(currentProjectedMemories(projection.items).length, 0);
	review.reviews["assertion-1"].validUntil = undefined;
	review.reviews["assertion-1"].validFrom = "2026-12-01T00:00:00Z";
	assert.equal(projectMemories([{ candidatePath, reviewPath, candidate: item, review }], createMemoryRelationStore(at), at).items[0].resolvedValidity, "not_yet_valid");
});

test("active supersedes and invalidates relations change resolved validity with history preserved", async () => {
	const old = candidate("old", "采用统一提醒。", "old-assertion");
	const recent = candidate("recent", "采用分级提醒。", "recent-assertion");
	const oldPath = "Memory/Candidates/old.md";
	const recentPath = "Memory/Candidates/recent.md";
	const source = createMemoryRelationEndpoint({ candidate: recent, candidatePath: recentPath, reviewPath: recentPath.replace(".md", ".review.md"), assertion: recent.assertions[0] });
	const target = createMemoryRelationEndpoint({ candidate: old, candidatePath: oldPath, reviewPath: oldPath.replace(".md", ".review.md"), assertion: old.assertions[0] });
	const relations = confirmMemoryRelation(createMemoryRelationStore(at), "supersedes", source, target, "更新", at);
	const packages = [old, recent].map((item, index) => ({ candidate: item, candidatePath: index ? recentPath : oldPath, reviewPath: (index ? recentPath : oldPath).replace(".md", ".review.md"), review: approved(item, index ? recentPath : oldPath) }));
	const result = projectMemories(packages, relations, at);
	assert.equal(result.items[0].resolvedValidity, "superseded");
	assert.equal(result.items[0].approval, "approved");
	assert.equal(currentProjectedMemories(result.items).length, 1);
	packages[1].review.reviews["recent-assertion"].validUntil = "2026-11-01T00:00:00Z";
	const expiredSuccessor = projectMemories(packages, relations, at);
	assert.equal(expiredSuccessor.items[0].resolvedValidity, "superseded", "successor expiry does not revoke an explicitly confirmed supersession");
	const invalidates = confirmMemoryRelation(createMemoryRelationStore(at), "invalidates", source, target, "作废", at);
	assert.equal(projectMemories(packages, invalidates, at).items[0].resolvedValidity, "invalidated");
});

test("new relationship record and corrupt current authority fail closed", async () => {
	const { storage, reader } = await fixture();
	storage.files.set("Memory/System/new-relations.json", "{}");
	const unknown = await reader.execute({ command: "search", kind: "memory" });
	assert.equal(unknown.status, "error");
	assert.equal(unknown.errors[0].code, "AUTHORITY_UNVERIFIED");
	storage.files.delete("Memory/System/new-relations.json");
	storage.files.set(relationPath, "broken-json");
	assert.equal((await reader.execute({ command: "search", kind: "memory" })).errors[0].code, "AUTHORITY_UNVERIFIED");
});

test("Review changes during a read retry against one consistent current version", async () => {
	const { storage, reader, item, review } = await fixture();
	const rejected = renderMemoryReview(applyMemoryReviewUpdates(review, item, [{ assertionId: "assertion-1", status: "rejected", effectiveValue: item.assertions[0].value, note: "" }], at), item);
	let changed = false;
	storage.onRead = (path) => {
		if (path === reviewPath && !changed) { changed = true; storage.files.set(reviewPath, rejected); }
	};
	const response = await reader.execute({ command: "search", kind: "memory" });
	assert.notEqual(response.status, "error");
	assert.equal(resultItems(response).length, 0);
});

test("a continuously changing policy returns DATA_UPDATING after limited retries", async () => {
	const { storage, reader, publisher } = await fixture();
	let reads = 0;
	storage.onRead = (path, text) => {
		if (path === publisher.policyPath && text) { const policy = JSON.parse(text); policy.version = String(++reads); storage.files.set(path, JSON.stringify(policy)); }
	};
	const response = await reader.execute({ command: "doctor" });
	assert.equal(response.status, "error");
	assert.equal(response.errors[0].code, "DATA_UPDATING");
	assert.ok(reads <= 6);
});

test("current policy disablement and local kind restrictions supersede existing snapshots", async () => {
	const { storage, publisher, reader } = await fixture();
	const narrow = new MemoryReader(storage, { policyPath: publisher.policyPath, sourceKinds: ["approved_memory"], now: () => at });
	assert.equal((await narrow.execute({ command: "search", kind: "evidence", query: createEvidenceQuery("人工干预", { filters: { sourceKinds: ["transcript"] } }) })).errors[0].code, "ACCESS_DENIED");
	await publisher.setPolicy({ enabled: false, sourceKinds: ["approved_memory"], allowedRoots: ["Memory"] });
	assert.equal((await reader.execute({ command: "doctor" })).errors[0].code, "EXPORT_DISABLED");
});

test("source edits require a refreshed publication and deleted cached text is not reused", async () => {
	const { storage, reader, doc } = await fixture();
	storage.files.set(sourcePath, doc.content.replace("采用人工干预入口。", "改成异常提醒。"));
	const query = createEvidenceQuery("异常提醒", { filters: { sourceKinds: ["transcript"] } });
	const response = await reader.execute({ command: "search", kind: "evidence", query });
	assert.equal(response.status, "error");
	assert.equal(response.errors[0].code, "SOURCE_CHANGED");
	assert.equal(response.data, null);
	storage.files.delete(sourcePath);
	const missing = await reader.execute({ command: "search", kind: "evidence", query });
	assert.equal(resultItems(missing).length, 0);
	assert.ok((missing.data as { issues: Array<{ code: string }> }).issues.some((issue) => issue.code === "SOURCE_MISSING"));
});

test("corrupt snapshot completion and duplicate catalog identity are rejected", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	const pointer = JSON.parse(storage.files.get(publisher.currentPath)!);
	storage.files.set(pointer.completePath, "{}");
	assert.equal((await reader.execute({ command: "doctor" })).errors[0].code, "INDEX_INCOMPLETE");
	await assert.rejects(() => publisher.publish({ documents: [doc, doc], meetings: [], projects: [], authorityRoots: [] }), /identity/);
});

test("local UI projection returns empty without Memory initialization and never writes", async () => {
	const storage = new Storage();
	const empty = await readMemoryProjection(storage, { authorityRoots: ["Memory/Candidates"], relationPath, documents: [], checkedAt: at });
	assert.equal(empty.items.length, 0);
	assert.equal(storage.writes, 0);
});

test("relationship files use original authoritative parser and derived context respects Review metadata", async () => {
	const { storage, reader } = await fixture();
	storage.files.set(relationPath, renderMemoryRelationStore(createMemoryRelationStore(at)));
	assert.notEqual((await reader.execute({ command: "search", kind: "memory" })).status, "error");
});

test("Candidate source identity/version round-trip preserves legacy compatibility and validates new fields", async () => {
	const { parseMemoryCandidate } = await import("../src/memory/memory-output");
	const legacy = candidate();
	assert.equal(parseMemoryCandidate(renderMemoryCandidate(legacy)).source.sourceRevision, undefined);
	const item = candidate();
	item.source.sourceId = "source-1";
	item.source.sourceRevision = "a".repeat(64);
	const parsed = parseMemoryCandidate(renderMemoryCandidate(item));
	assert.equal(parsed.source.sourceId, "source-1");
	assert.equal(parsed.source.sourceRevision, "a".repeat(64));
	item.source.sourceRevision = "old-fingerprint";
	assert.throws(() => parseMemoryCandidate(renderMemoryCandidate(item)), /元数据无效/);
});

test("new Candidate provenance follows stable source identity across rename while old approval remains unversioned", async () => {
	const item = candidate();
	const review = approved(item);
	const legacy = projectMemories([{ candidatePath, reviewPath, candidate: item, review }], createMemoryRelationStore(at), at, [{ path: sourcePath, sourceId: "source-1", sourceRevision: "a".repeat(64), sourceCheck: "verified" }]);
	assert.equal(legacy.items[0].sourceCheck, "unsupported");
	item.source.sourceId = "source-1";
	item.source.sourceRevision = "a".repeat(64);
	const renamed = projectMemories([{ candidatePath, reviewPath, candidate: item, review }], createMemoryRelationStore(at), at, [{ path: "Transcripts/renamed.md", sourceId: "source-1", sourceRevision: "a".repeat(64), sourceCheck: "verified" }]);
	assert.equal(renamed.items[0].sourcePath, "Transcripts/renamed.md");
	assert.equal(renamed.items[0].sourceCheck, "verified");
});

test("deleting a previously published relationship store does not silently reactivate old decisions", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	storage.files.set(relationPath, renderMemoryRelationStore(createMemoryRelationStore(at)));
	await publisher.publish({ documents: [doc], meetings: [], projects: [], authorityRoots: ["Memory/Candidates"], relationPath });
	storage.files.delete(relationPath);
	assert.equal((await reader.execute({ command: "search", kind: "memory" })).errors[0].code, "AUTHORITY_UNVERIFIED");
});

test("legacy context filtering, ranking and output use effective Review fields", async () => {
	const { buildMemoryContextPackagePreview, createDefaultMemoryContextFilterOptions } = await import("../src/memory/memory-context");
	const base = candidate();
	const review = approved(base).reviews["assertion-1"];
	const entries = [{ assertion: base.assertions[0], candidateId: base.id, candidatePath, reviewPath, relationAnnotations: [], review: { ...review, effectiveType: "goal" as const, effectiveTier: "core" as const, authority: "core_declared" as const, validity: "historical" as const } }];
	const preview = buildMemoryContextPackagePreview(entries, { ...createDefaultMemoryContextFilterOptions(), memoryTypes: ["goal"] }, "en", at);
	assert.equal(preview.matchingCount, 1);
	assert.match(preview.managedBlock, /Goal/);
	assert.match(preview.managedBlock, /Core/);
	assert.match(preview.managedBlock, /Historical/);
	const changed = buildMemoryContextPackagePreview([{ ...entries[0], review: { ...entries[0].review, validity: "active" as const } }], createDefaultMemoryContextFilterOptions(), "en", at);
	assert.notEqual(preview.id, changed.id);
});

test("transcript-only source reads never return analysis, technical blocks or raw frontmatter", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	const content = doc.content.replace("<!-- echo-notes-transcript:end -->", "<!-- echo-notes-transcript:end -->\n<!-- echo-notes-transcript-technical:start -->\nTECHNICAL_PRIVATE_MARKER\n<!-- echo-notes-transcript-technical:end -->\n<!-- echo-notes-analysis:start -->\n<!-- echo-notes-analysis-item:start work-minutes -->\nANALYSIS_PRIVATE_MARKER\n<!-- echo-notes-analysis-item:end work-minutes -->\n<!-- echo-notes-analysis:end -->");
	storage.files.set(sourcePath, content);
	await publisher.setPolicy({ enabled: true, sourceKinds: ["transcript"], allowedRoots: ["Memory", "Transcripts"] });
	await publisher.publish({ documents: [{ ...doc, content }], meetings: [], projects: [], authorityRoots: [] });
	const result = await reader.execute({ command: "read", id: "source-1" });
	assert.notEqual(result.status, "error");
	const rendered = JSON.stringify(result.data);
	assert.match(rendered, /采用人工干预入口/);
	assert.doesNotMatch(rendered, /TECHNICAL_PRIVATE_MARKER|ANALYSIS_PRIVATE_MARKER|type: audio-transcript/);
	assert.ok((result.data as { sections: unknown[] }).sections.length > 0);
	const attempted = await reader.execute({ command: "read", id: "source-1", includeAnalysis: true });
	assert.doesNotMatch(JSON.stringify(attempted.data), /ANALYSIS_PRIVATE_MARKER/);
});

test("source read with incomplete revised-reading markers fails closed", async () => {
	const { storage, reader, doc } = await fixture();
	storage.files.set(sourcePath, doc.content + "\n<!-- echo-notes-proofreading-reading:start -->\nINCOMPLETE_READING_PRIVATE");
	const result = await reader.execute({ command: "read", id: "source-1" });
	assert.equal(result.status, "error");
	assert.equal(result.errors[0].code, "SOURCE_CHANGED");
	assert.equal(result.data, null);
});

test("analysis source read is separately returned only after explicit opt-in", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	const content = doc.content + "\n<!-- echo-notes-analysis:start -->\n<!-- echo-notes-analysis-item:start work-minutes -->\nANALYSIS_EXPLICIT_ONLY\n<!-- echo-notes-analysis-item:end work-minutes -->\n<!-- echo-notes-analysis:end -->\n";
	storage.files.set(sourcePath, content);
	await publisher.setPolicy({ enabled: true, sourceKinds: ["transcript", "analysis"], allowedRoots: ["Memory", "Transcripts"] });
	await publisher.publish({ documents: [{ ...doc, content }], meetings: [], projects: [], authorityRoots: [] });
	assert.doesNotMatch(JSON.stringify((await reader.execute({ command: "read", id: "source-1" })).data), /ANALYSIS_EXPLICIT_ONLY/);
	const explicit = await reader.execute({ command: "read", id: "source-1", includeAnalysis: true });
	assert.notEqual(explicit.status, "error");
	assert.match(JSON.stringify((explicit.data as { analysis: unknown }).analysis), /ANALYSIS_EXPLICIT_ONLY/);
	assert.doesNotMatch((explicit.data as { content: string }).content, /ANALYSIS_EXPLICIT_ONLY/);
});

test("meeting and approved-memory date filters include the second day and honor query timezone", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	const time = { precision: "instant" as const, startedAt: "2026-11-07T23:30:00+08:00", endedAt: "2026-11-08T00:30:00+08:00", timezone: "Asia/Taipei", source: "user" as const, confirmed: true };
	await publisher.publish({ documents: [{ ...doc, meetingTime: time, meetingDate: "2026-11-07" }], meetings: [{ id: "meeting-1", path: meetingPath, title: doc.title, projectIds: ["project-1"], date: "2026-11-07", time, sourceRevision: revision(storage.files.get(meetingPath)!) }], projects: [], authorityRoots: ["Memory/Candidates"], relationPath });
	const taipei = createEvidenceQuery("", { filters: { sourceKinds: ["approved_memory"], timezone: "Asia/Taipei", fromDate: "2026-11-08", toDateInclusive: "2026-11-08" } });
	const meetings = await reader.execute({ command: "meetings", fromDate: "2026-11-08", toDate: "2026-11-08", query: taipei });
	assert.equal(resultItems(meetings).length, 1);
	assert.equal(resultItems(await reader.execute({ command: "search", kind: "memory", query: taipei })).length, 1);
	const newYork = createEvidenceQuery("", { filters: { sourceKinds: ["approved_memory"], timezone: "America/New_York", fromDate: "2026-11-08", toDateInclusive: "2026-11-08" } });
	assert.equal(resultItems(await reader.execute({ command: "meetings", fromDate: "2026-11-08", toDate: "2026-11-08", query: newYork })).length, 0);
	assert.equal(resultItems(await reader.execute({ command: "search", kind: "memory", query: newYork })).length, 0);
});

test("shared context/export memory selection uses cross-midnight time and Chinese lexical matching", async () => {
	const { matchMemoryEvidence } = await import("../src/evidence/evidence-query");
	const time = { precision: "instant" as const, startedAt: "2026-11-07T23:30:00+08:00", endedAt: "2026-11-08T00:30:00+08:00", source: "user" as const, confirmed: true };
	const memory = { id: "memory-time", text: "采用人工干预入口。", approval: "approved" as const, resolvedValidity: "active", meetingDate: "2026-11-07", meetingTime: time };
	const query = createEvidenceQuery("人工干预", { filters: { sourceKinds: ["approved_memory"], timezone: "Asia/Taipei", fromDate: "2026-11-08", toDateInclusive: "2026-11-08" } });
	assert.equal(matchMemoryEvidence([memory], query).length, 1);
	assert.equal(matchMemoryEvidence([memory], createEvidenceQuery("人工干预", { filters: { ...query.filters, timezone: "America/New_York" } })).length, 0);
});

test("a refreshed generation preserves deleted-source descriptors and reports omissions", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	storage.files.delete(sourcePath);
	await publisher.publish({ documents: [{ ...doc, content: "", missing: true }], meetings: [], projects: [], authorityRoots: [] });
	const response = await reader.execute({ command: "search", kind: "evidence", query: createEvidenceQuery("人工干预", { filters: { sourceKinds: ["transcript"] } }) });
	assert.equal(response.status, "partial");
	assert.equal(resultItems(response).length, 0);
	assert.ok(response.warnings.some((warning) => warning.code === "SOURCE_MISSING"));
	assert.ok((response.data as { issues: Array<{ code: string }> }).issues.some((issue) => issue.code === "SOURCE_MISSING"));
	storage.files.set(sourcePath, doc.content);
	await assert.rejects(() => publisher.publish({ documents: [{ ...doc, content: "", missing: true }], meetings: [], projects: [], authorityRoots: [] }), /exists again/);
});

test("memory-only context and export expose only public EvidenceMemory fields", async () => {
	const { storage, reader, item } = await fixture();
	item.assertions[0].evidenceQuote = "INTERNAL_EVIDENCE_QUOTE_ONLY";
	const review = applyMemoryReviewUpdates(approved(item), item, [{ assertionId: "assertion-1", status: "approved", effectiveValue: item.assertions[0].value, note: "INTERNAL_REVIEW_NOTE_ONLY" }], at);
	storage.files.set(candidatePath, renderMemoryCandidate(item));
	storage.files.set(reviewPath, renderMemoryReview(review, item));
	const query = createEvidenceQuery("人工干预", { filters: { sourceKinds: ["approved_memory"] } });
	const allowed = new Set(["id", "text", "approval", "resolvedValidity", "sourceId", "sourcePath", "meetingId", "meetingDate", "meetingDates", "meetingTime", "projectIds", "sourceCheck", "authority", "validFrom", "validUntil"]);
	for (const command of ["context", "export"] as const) {
		const response = await reader.execute({ command, query });
		assert.notEqual(response.status, "error", JSON.stringify(response.errors));
		const data = response.data as { memories?: Array<Record<string, unknown>>; snapshot?: { memories: Array<Record<string, unknown>> } };
		const memories = command === "export" ? data.snapshot!.memories : data.memories!;
		assert.equal(memories.length, 1);
		assert.ok(Object.keys(memories[0]).every((key) => allowed.has(key)));
		assert.doesNotMatch(JSON.stringify(response), /INTERNAL_EVIDENCE_QUOTE_ONLY|INTERNAL_REVIEW_NOTE_ONLY|"assertion":|"review":|"candidatePath":|"reviewPath":/);
	}
});

test("replacing a source at the same path never binds new text to its old identity", async () => {
	const { storage, publisher, reader, doc } = await fixture();
	const replacement = doc.content.replace("source-1", "source-2").replace("采用人工干预入口。", "OTHER_SOURCE_PRIVATE_BODY");
	storage.files.set(sourcePath, replacement);
	const query = createEvidenceQuery("OTHER_SOURCE_PRIVATE_BODY", { filters: { sourceKinds: ["transcript"] } });
	for (const request of [{ command: "read" as const, id: "source-1" }, { command: "search" as const, kind: "evidence" as const, query }, { command: "context" as const, query }, { command: "export" as const, query }]) {
		const response = await reader.execute(request);
		assert.equal(response.status, "error");
		assert.equal(response.errors[0].code, "SOURCE_CHANGED");
		assert.match(response.errors[0].message, /refresh.*publish/);
		assert.doesNotMatch(JSON.stringify(response), /OTHER_SOURCE_PRIVATE_BODY/);
	}
	await publisher.publish({ documents: [{ ...doc, sourceId: "source-2", content: replacement }], meetings: [], projects: [], authorityRoots: [] });
	assert.equal((await reader.execute({ command: "read", id: "source-1" })).errors[0].code, "ITEM_NOT_FOUND");
	const refreshed = await reader.execute({ command: "read", id: "source-2" });
	assert.equal(refreshed.status, "ok");
	assert.equal((refreshed.data as { sourceId: string }).sourceId, "source-2");
});

test("changed or missing meeting and project metadata stop stale filters and verified claims", async () => {
	for (const path of [meetingPath, projectPath]) {
		const { storage, reader } = await fixture();
		storage.files.set(path, storage.files.get(path)! + "\n# Changed title, date or project metadata\n");
		for (const command of ["doctor", "projects", "meetings", "search", "context", "export"] as const) {
			const response = await reader.execute({ command });
			assert.equal(response.status, "error");
			assert.equal(response.errors[0].code, "SOURCE_CHANGED");
			assert.equal(response.data, null);
			assert.match(response.errors[0].message, /refresh.*publish/);
		}
		storage.files.delete(path);
		assert.equal((await reader.execute({ command: "doctor" })).errors[0].code, "SOURCE_CHANGED");
	}
});

test("metadata outside the intersected allowed roots cannot block an allowed source read", async () => {
	const { storage, publisher } = await fixture();
	storage.files.delete(meetingPath);
	storage.files.delete(projectPath);
	const reader = new MemoryReader(storage, { policyPath: publisher.policyPath, sourceKinds: ["transcript"], allowedRoots: ["Transcripts"], now: () => at });
	assert.equal((await reader.execute({ command: "read", id: "source-1" })).status, "ok");
});

test("publication verifies metadata provenance before writing and detects concurrent metadata edits", async () => {
	const { storage, publisher, doc } = await fixture();
	const current = storage.files.get(publisher.currentPath);
	const meeting = { id: "meeting-1", path: meetingPath, title: doc.title, projectIds: [], sourceRevision: revision(storage.files.get(meetingPath)!) };
	const input = { documents: [doc], meetings: [meeting], projects: [], authorityRoots: [] };
	await assert.rejects(() => publisher.publish({ ...input, meetings: [{ ...meeting, sourceRevision: undefined }] }), /no verified source revision/);
	let changed = false;
	storage.onRead = (path, text) => {
		if (path === meetingPath && !changed) { changed = true; storage.files.set(path, text + "\nChanged during publication\n"); }
	};
	await assert.rejects(() => publisher.publish(input), /metadata changed before generation completion/);
	assert.equal(storage.files.get(publisher.currentPath), current);
});

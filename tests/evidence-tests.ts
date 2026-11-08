import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
	createEvidenceQuery, searchEvidence, parseFormalTranscript, validateEvidence,
	freezeEvidencePackage, renderEvidenceMarkdown, expandEvidence,
	renderQuestionDocument, parseQuestionDocument, countEvidenceCharacters
} from "../src/evidence";
import type { EvidenceDocument, EvidenceMemory, QuestionRecord } from "../src/evidence";

function document(body: string, suffix = "1", extra: Partial<EvidenceDocument> = {}): EvidenceDocument {
	return {
		sourceId: `source-${suffix}`, meetingId: `meeting-${suffix}`, sourcePath: `转写/会议 ${suffix}.transcript.md`,
		content: `---\ntype: audio-transcript\n---\n<!-- echo-notes-transcript:start -->\n# 转写稿 会议 ${suffix}\n\n${body}\n<!-- echo-notes-transcript:end -->\n`,
		title: `会议 ${suffix}`, meetingDate: "2026-11-07", projectIds: ["project-1"], ...extra
	};
}

const freezeOptions = { packageId: "package-1", frozenAt: "2026-11-08T03:00:00Z", generationId: "generation-1" };

test("formal parser preserves full normalized offsets and repeated emoji quotations", async () => {
	const raw = "---\r\ntype: audio-transcript\r\necho_source_id: src_00000000-0000-4000-8000-000000000001\r\n---\r\n<!-- echo-notes-transcript:start -->\r\n# 触达策略转写\r\n\r\n## 转写正文\r\n\r\n说话人甲：先保留人工干预入口🙂。\r\n\r\n说话人乙：如果存在承诺时间风险，先保留人工干预入口🙂。\r\n<!-- echo-notes-transcript:end -->\r\n<!-- echo-notes-transcript-technical:start -->\r\n调试词：强制触达，不属于会议正文。\r\n<!-- echo-notes-transcript-technical:end -->\r\n";
	const expected = {
	  "sourceRevision": "7dfff4333f77371ebb2327e28fb1e107602cc898aed588d1be567bf062c218c8",
	  "matches": [
	    {
	      "start": 149,
	      "end": 161,
	      "quote": "先保留人工干预入口🙂。"
	    },
	    {
	      "start": 179,
	      "end": 191,
	      "quote": "先保留人工干预入口🙂。"
	    }
	  ]
	};
	const doc = document("", "fixture", { content: raw });
	const result = await searchEvidence([doc], createEvidenceQuery("", { keywords: ["人工干预入口"], contextBefore: 0, contextAfter: 0 }));
	assert.equal(result.items.length, 2);
	assert.notEqual(result.items[0].evidenceId, result.items[1].evidenceId);
	const normalized = raw.replace(/\r\n/g, "\n");
	assert.equal(createHash("sha256").update(normalized).digest("hex"), expected.sourceRevision);
	for (const item of result.items) {
		assert.equal(item.sourceRevision, expected.sourceRevision);
		assert.equal(normalized.slice(item.sourceRange.start, item.sourceRange.end), item.quote);
		assert.ok(expected.matches.some((range) => range.start >= item.sourceRange.start && range.end <= item.sourceRange.end));
	}
	assert.equal((await validateEvidence(result.items, [doc])).valid, true);
});

test("corrected reading wins over original model and analysis and broken markers fail closed", async () => {
	const content = document("原稿提到强制触达。\n\n<!-- echo-notes-proofreading-reading:start -->\n当前修订采用分级处理。\n<!-- echo-notes-proofreading-reading:end -->\n\n主模型原稿强制触达。", "corrected").content;
	const parsed = parseFormalTranscript(content);
	assert.equal(parsed.kind, "revised_transcript");
	assert.equal(parsed.paragraphs[0].text, "当前修订采用分级处理。");
	assert.equal((await searchEvidence([document("", "1", { content })], createEvidenceQuery("强制触达"))).items.length, 0);
	assert.equal(parseFormalTranscript(content.replace("<!-- echo-notes-proofreading-reading:end -->", "")).status, "unsupported");
	assert.equal(parseFormalTranscript(content + "<!-- echo-notes-proofreading-reading:start -->").status, "unsupported");
});

test("analysis and technical terms never match default formal transcript retrieval", async () => {
	const doc = document("只讨论分级处理。\n\n<!-- echo-notes-transcript-technical:start -->\n强制触达技术日志。\n<!-- echo-notes-transcript-technical:end -->");
	doc.content += "<!-- echo-notes-analysis:start -->\n## 分析\n\n强制触达是一个分析解释。\n<!-- echo-notes-analysis:end -->\n";
	assert.equal((await searchEvidence([doc], createEvidenceQuery("强制触达"))).items.length, 0);
	const analysis = await searchEvidence([doc], createEvidenceQuery("强制触达", { filters: { sourceKinds: ["analysis"] } }));
	assert.equal(analysis.items.length, 1);
	assert.equal(analysis.items[0].kind, "analysis");
	assert.equal((await validateEvidence(analysis.items, [doc])).valid, true);
});

test("legacy parser requires a recognizable transcript heading and stops at manual notes", () => {
	assert.equal(parseFormalTranscript("# 普通笔记\n\n不能当转写正文。").status, "unsupported");
	const parsed = parseFormalTranscript("# 转写稿 历史会议\n\n保留旧转写正文。\n\n## 人工补充\n\n不属于原文。");
	assert.equal(parsed.status, "ok");
	assert.equal(parsed.paragraphs[0].text, "保留旧转写正文。");
});

test("filters apply cross-dimension AND and same-dimension OR including cross-midnight dates", async () => {
	const docs = [document("人工干预。", "1"), document("人工干预。", "2", { projectIds: ["project-2"], meetingDate: "2026-11-08", meetingDates: ["2026-11-07", "2026-11-08"] }), document("人工干预。", "3", { meetingDate: undefined, projectIds: ["project-2"] })];
	const query = createEvidenceQuery("人工干预", { filters: { projectIds: ["project-1", "project-2"], meetingIds: ["meeting-2", "meeting-3"], fromDate: "2026-11-07", toDateInclusive: "2026-11-07", timezone: "Asia/Taipei" } });
	const result = await searchEvidence(docs, query);
	assert.deepEqual(result.items.map((item) => item.meetingId), ["meeting-2"]);
});

test("Chinese bigram suggestions and explicit phrases expose lexical match reasons", async () => {
	const doc = document("我们讨论订单履约策略的调整，保留人工干预。\n\n先确认承诺时间风险。");
	const query = createEvidenceQuery("为什么调整订单履约策略？", { contextBefore: 0, contextAfter: 0 });
	assert.ok(query.keywords.length > 0);
	const result = await searchEvidence([doc], query);
	assert.ok(result.items.length > 0);
	assert.ok(result.items[0].matches.some((match) => match.kind === "bigram"));
	const exact = await searchEvidence([doc], createEvidenceQuery("", { keywords: [], exactPhrases: ["承诺时间风险"], contextBefore: 0, contextAfter: 0 }));
	assert.equal(exact.items.length, 1);
	assert.deepEqual(exact.items[0].matches, [{ term: "承诺时间风险", kind: "phrase" }]);
});

test("scope-only retrieval is declared and does not invent semantic understanding", async () => {
	const result = await searchEvidence([document("完整范围资料。")], createEvidenceQuery("", { keywords: [] }));
	assert.deepEqual(result.items[0].matches, [{ term: "按范围整理", kind: "scope" }]);
});

test("overlapping windows merge only inside the same formal source section", async () => {
	const doc = document("背景段。\n\n需要人工干预。\n\n承诺时间风险需要人工干预。\n\n后续条件。\n\n<!-- trace_id: hidden -->\n\n另一段人工干预。");
	const result = await searchEvidence([doc], createEvidenceQuery("人工干预"));
	assert.equal(result.items.length, 2);
	assert.ok(result.items[0].quote.includes("承诺时间风险"));
	assert.ok(result.items.every((item) => !item.quote.includes("trace_id")));
});

test("coverage selection includes different meetings before taking extra windows", async () => {
	const docs = [document("需要人工干预。\n\n中间段。\n\n需要人工干预。", "1"), document("需要人工干预。", "2")];
	const result = await searchEvidence(docs, createEvidenceQuery("人工干预", { maxCharacters: 18, contextBefore: 0, contextAfter: 0 }));
	assert.equal(result.coverage.includedMeetings, 2);
	assert.equal(result.coverage.omittedByBudget, 1);
});

test("pinned evidence over budget remains selected and prevents freeze", async () => {
	const doc = document("如果承诺时间存在风险，就保留人工干预入口，不应删掉这个条件。");
	const all = await searchEvidence([doc], createEvidenceQuery("人工干预"));
	const query = createEvidenceQuery("人工干预", { maxCharacters: 4, pinnedEvidenceIds: [all.items[0].evidenceId] });
	const result = await searchEvidence([doc], query);
	assert.equal(result.selectedItems.length, 1);
	assert.equal(result.canFreeze, false);
	assert.ok(result.issues.some((issue) => issue.code === "PINNED_OVER_BUDGET"));
	await assert.rejects(freezeEvidencePackage([doc], query, freezeOptions), /固定材料/);
});

test("excluded materials and missing pins have distinct counts and blocking state", async () => {
	const doc = document("人工干预需要条件。\n\n人工干预需要负责人。");
	const query = createEvidenceQuery("人工干预", { contextBefore: 0, contextAfter: 0 });
	const all = await searchEvidence([doc], query);
	const result = await searchEvidence([doc], { ...query, excludedEvidenceIds: [all.items[0].evidenceId], pinnedEvidenceIds: ["missing-reference"] });
	assert.equal(result.coverage.excludedByUser, 1);
	assert.equal(result.selectedItems.length, 1);
	assert.equal(result.canFreeze, false);
});

test("preview validation detects title metadata edits, missing source and duplicate identity", async () => {
	const doc = document("人工干预需要条件。");
	const items = (await searchEvidence([doc], createEvidenceQuery("人工干预"))).items;
	assert.equal((await validateEvidence(items, [{ ...doc, sourcePath: "移动/新路径.md" }])).valid, true);
	assert.equal((await validateEvidence(items, [{ ...doc, content: doc.content.replace("type: audio-transcript", "type: audio-transcript\nchanged: true") }])).items[0].sourceCheck, "changed");
	assert.equal((await validateEvidence(items, [])).items[0].sourceCheck, "missing");
	assert.equal((await validateEvidence(items, [doc, { ...doc, sourcePath: "副本.md" }])).items[0].sourceCheck, "ambiguous");
});

test("registered missing sources make scope partial and never look like zero memory", async () => {
	const result = await searchEvidence([document("", "1", { missing: true })], createEvidenceQuery("人工干预"));
	assert.equal(result.coverage.scannedMeetings, 1);
	assert.equal(result.coverage.abnormalSources, 1);
	assert.equal(result.issues[0].code, "SOURCE_MISSING");
});

test("tampered quote/context/range cannot pass exact source verification", async () => {
	const doc = document("背景🙂。\n\n需要人工干预。\n\n后续条件。");
	const item = (await searchEvidence([doc], createEvidenceQuery("人工干预"))).items[0];
	assert.equal((await validateEvidence([{ ...item, quote: item.quote + "伪造" }], [doc])).valid, false);
	assert.equal((await validateEvidence([{ ...item, contextBefore: "伪造上下文" }], [doc])).valid, false);
	assert.equal((await validateEvidence([{ ...item, sourceRange: { start: -1, end: item.sourceRange.end } }], [doc])).valid, false);
});

test("expanded context is version checked and preserves complete paragraphs", async () => {
	const doc = document("前文🙂。\n\n需要人工干预。\n\n后文条件。");
	const item = (await searchEvidence([doc], createEvidenceQuery("人工干预", { contextBefore: 0, contextAfter: 0 }))).items[0];
	const expanded = await expandEvidence(item, [doc], 1, 1);
	assert.ok(expanded.contextBefore.includes("前文🙂。"));
	assert.ok(expanded.contextAfter.includes("后文条件。"));
	assert.equal((await validateEvidence([expanded], [doc])).valid, true);
	await assert.rejects(expandEvidence(item, [{ ...doc, content: doc.content + "\n修改" }], 1, 1), /来源已更新/);
});

test("memory appendix excludes pending/rejected and distinguishes historical validity", async () => {
	const memories: EvidenceMemory[] = [
		{ id: "1", text: "人工干预旧决定", approval: "approved", resolvedValidity: "superseded", sourcePath: "历史.md" },
		{ id: "2", text: "人工干预当前决定", approval: "approved", resolvedValidity: "active", sourcePath: "当前.md" },
		{ id: "3", text: "人工干预候选", approval: "pending", resolvedValidity: "active" },
		{ id: "4", text: "人工干预已拒绝", approval: "rejected", resolvedValidity: "active" }
	];
	const all = await searchEvidence([], createEvidenceQuery("人工干预"), memories);
	assert.deepEqual(all.memories.map((item) => item.id), ["1", "2"]);
	const current = await searchEvidence([], createEvidenceQuery("人工干预", { includeHistoricalMemory: false }), memories);
	assert.deepEqual(current.memories.map((item) => item.id), ["2"]);
});

test("memory appendix consumes code-point budget and reports omissions", async () => {
	const memories: EvidenceMemory[] = [{ id: "1", text: "🙂🙂🙂", approval: "approved", resolvedValidity: "active" }];
	const result = await searchEvidence([], createEvidenceQuery("", { maxCharacters: 2 }), memories);
	assert.equal(result.memories.length, 0);
	assert.equal(result.coverage.omittedMemories, 1);
});

test("freeze rechecks original preview and updates safe moved source paths", async () => {
	const doc = document("人工干预需要条件。");
	const query = createEvidenceQuery("人工干预");
	const selected = (await searchEvidence([doc], query)).selectedItems;
	await assert.rejects(freezeEvidencePackage([{ ...doc, content: doc.content + "修改" }], query, { ...freezeOptions, selection: selected }), /来源已更新/);
	const snapshot = await freezeEvidencePackage([{ ...doc, sourcePath: "Moved.md" }], query, { ...freezeOptions, selection: selected });
	assert.equal(snapshot.items[0].sourcePath, "Moved.md");
});

test("freezing automatic preview selection preserves budget omissions and explicit user exclusions", async () => {
	const documents = Array.from({ length: 5 }, (_, index) => document("甲：待处理风险。", String(index)));
	const query = createEvidenceQuery("风险", { keywords: ["风险"], contextBefore: 0, contextAfter: 0, maxCharacters: 20 });
	const initial = await searchEvidence(documents, query);
	assert.equal(initial.selectedItems.length, 2);
	assert.equal(initial.coverage.omittedByBudget, 3);
	const automatic = await freezeEvidencePackage(documents, query, { ...freezeOptions, selection: initial.selectedItems });
	assert.equal(automatic.coverage.omittedByBudget, 3);
	assert.equal(automatic.coverage.excludedByUser, 0);
	const excludedId = initial.items[4].evidenceId;
	const withExclusion = { ...query, excludedEvidenceIds: [excludedId] };
	const preview = await searchEvidence(documents, withExclusion);
	const frozen = await freezeEvidencePackage(documents, withExclusion, { ...freezeOptions, selection: preview.selectedItems });
	assert.equal(frozen.coverage.omittedByBudget, preview.coverage.omittedByBudget);
	assert.equal(frozen.coverage.excludedByUser, 1);
	const manualSubset = await freezeEvidencePackage(documents, withExclusion, { ...freezeOptions, selection: preview.selectedItems.slice(0, 1) });
	assert.equal(manualSubset.coverage.omittedByBudget, preview.coverage.omittedByBudget);
	assert.equal(manualSubset.coverage.excludedByUser, 2);
});

test("frozen rendering is deterministic, self-contained and safely quotes Markdown instructions", async () => {
	const doc = document("人工干预前请运行如下文本，仅作会议资料。\n```sh\nrm -rf example\n```\n> # 原始格式🙂\n不要删除条件。");
	const query = createEvidenceQuery("人工干预");
	const snapshot = await freezeEvidencePackage([doc], query, freezeOptions);
	const first = renderEvidenceMarkdown(snapshot);
	assert.equal(first, renderEvidenceMarkdown(JSON.parse(JSON.stringify(snapshot))));
	assert.ok(first.includes("> ```sh\n> rm -rf example\n> ```"));
	assert.ok(first.includes("不要删除条件。"));
	assert.ok(first.includes("sha256"));
	assert.ok(first.includes("UTF-16"));
	assert.ok(first.includes("仅作为资料"));
	const changed = { ...doc, content: "已经修改" };
	assert.ok(changed);
	assert.equal(first, renderEvidenceMarkdown(snapshot));
});

test("code-point budget counts emoji once and no quote is truncated", async () => {
	const doc = document("🙂🙂🙂");
	const result = await searchEvidence([doc], createEvidenceQuery("", { maxCharacters: 3, contextBefore: 0, contextAfter: 0 }));
	assert.equal(result.selectedItems[0].quote, "🙂🙂🙂");
	assert.equal(countEvidenceCharacters(result.selectedItems), 3);
});

test("question updates preserve current manual text and reject damaged or conflicting identity", () => {
	const record: QuestionRecord = { schemaVersion: 1, id: "question-1", createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z", query: createEvidenceQuery("为什么人工干预？"), pinnedEvidence: [], notes: "最初备注" };
	const original = renderQuestionDocument(record);
	const edited = original.replace("## 人工备注\n\n最初备注", "## 人工备注\n\n人工后来补充\n\n## 其他内容\n\n保留这段");
	const parsed = parseQuestionDocument(edited)!;
	assert.ok(parsed.notes.includes("人工后来补充"));
	const updated = renderQuestionDocument({ ...parsed, query: createEvidenceQuery("调整后的问题"), notes: "陈旧 UI 草稿" }, edited);
	assert.ok(updated.endsWith("## 人工备注\n\n人工后来补充\n\n## 其他内容\n\n保留这段\n"));
	assert.ok(!updated.includes("陈旧 UI 草稿"));
	assert.equal(parseQuestionDocument(updated)!.query.question, "调整后的问题");
	assert.equal(parseQuestionDocument(updated.replace("<!-- echo-notes-question:end -->", "")), null);
	assert.throws(() => renderQuestionDocument({ ...record, id: "another" }, original), /身份/);
});

test("invalid dates, protocols and contradictory selections fail explicitly", async () => {
	assert.throws(() => createEvidenceQuery("", { protocolVersion: 2 as 1 }), /协议/);
	assert.throws(() => createEvidenceQuery("", { filters: { fromDate: "2026-02-30" } }), /日期/);
	assert.throws(() => createEvidenceQuery("", { pinnedEvidenceIds: ["x"], excludedEvidenceIds: ["x"] }), /同时/);
	assert.throws(() => createEvidenceQuery("", { filters: { timezone: "Unspecified/Fake" } }), /时区/);
	await assert.rejects(freezeEvidencePackage([], createEvidenceQuery(""), { packageId: "p", frozenAt: "2026-11-08 12:00" }), /带时区/);
});

test("long scope-only sources retain selectable coherent windows within the material budget", async () => {
	const doc = document(Array.from({ length: 100 }, (_, index) => `第${index}段讨论人工干预条件。`).join("\n\n"));
	const result = await searchEvidence([doc], createEvidenceQuery("", { maxCharacters: 100, contextBefore: 0, contextAfter: 0 }));
	assert.ok(result.items.length > 1);
	assert.ok(result.selectedItems.length >= 1);
	assert.ok(result.coverage.characters <= 100);
});

test("question text containing owned-looking markers is safely encoded inside query data", () => {
	const record: QuestionRecord = { schemaVersion: 1, id: "q-markers", createdAt: "2026-11-07T00:00:00Z", updatedAt: "2026-11-07T00:00:00Z", query: createEvidenceQuery("如何解释 <!-- echo-notes-question:end --> 这段原话？"), pinnedEvidence: [], notes: "" };
	const rendered = renderQuestionDocument(record);
	assert.equal(parseQuestionDocument(rendered)?.query.question, record.query.question);
});

test("query timezone reprojects raw instant instead of reusing snapshot display dates", async () => {
	const doc = document("人工干预。", "timezone", { meetingDate: "2026-11-08", meetingDates: ["2026-11-08"], meetingTime: { precision: "instant", startedAt: "2026-11-08T00:30:00+08:00", endedAt: "2026-11-08T01:00:00+08:00", timezone: "Asia/Taipei", source: "user", confirmed: true } });
	const result = await searchEvidence([doc], createEvidenceQuery("人工干预", { filters: { fromDate: "2026-11-07", toDateInclusive: "2026-11-07", timezone: "America/New_York" } }));
	assert.equal(result.items.length, 1);
	assert.equal(result.items[0].meetingDate, "2026-11-07");
});

test("fixed UTC offset query works without inventing an IANA timezone", async () => {
	const doc = document("人工干预。", "offset", { meetingTime: { precision: "instant", startedAt: "2026-11-07T22:00:00Z", source: "user", confirmed: true } });
	const result = await searchEvidence([doc], createEvidenceQuery("人工干预", { filters: { timezone: "+05:30", fromDate: "2026-11-08", toDateInclusive: "2026-11-08" } }));
	assert.equal(result.items[0].meetingDate, "2026-11-08");
});

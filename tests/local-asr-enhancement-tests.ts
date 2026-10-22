import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeLocalEnhancement, parseLocalEnhancementCapability, requireLocalEnhancementCapability } from "../src/providers/local-asr-enhancement";
import { buildTranscriptionEnhancementSnapshot, createTranscriptionEnhancementStore } from "../src/memory/memory-transcription-enhancement";
import { getOfflineTranscriptionProviderDefaults, normalizeEchoNotesSettings, switchOfflineTranscriptionProvider } from "../src/settings/settings";
import { createTranscriptionConfigurationFingerprint } from "../src/transcript/transcript-checkpoint";

const wire = { version: 1, transports: ["jobs"], hotwords: true, context: true,
	limits: { max_hotwords: 100, max_hotword_characters: 1000, max_context_characters: 400 } };

test("local prompts normalize exactly and reject invalid Unicode, versions and budgets", () => {
	assert.deepEqual(normalizeLocalEnhancement({ version: 1, hotwords: [" 星河 ", "星河", "AI", "ai", ""], context_text: " 背景 " }),
		{ version: 1, hotwords: ["星河", "AI", "ai"], context_text: "背景" });
	for (const invalid of [{ version: true }, { version: 2 }, { version: 1, extra: "private" }, { version: 1, hotwords: null }, { version: 1, context_text: null },
		{ version: 1, hotwords: ["\ud800"] }, { version: 1, hotwords: Array.from({ length: 101 }, (_, i) => String(i)) },
		{ version: 1, hotwords: ["字".repeat(1001)] }, { version: 1, context_text: "😀".repeat(401) }]) {
		assert.throws(() => normalizeLocalEnhancement(invalid));
	}
	assert.equal(Array.from(normalizeLocalEnhancement({ version: 1, context_text: "😀".repeat(400) }).context_text).length, 400);
});

test("local capability is model scoped and explicitly required even for empty enabled hints", () => {
	assert.equal(parseLocalEnhancementCapability(undefined), undefined);
	assert.equal(parseLocalEnhancementCapability({ ...wire, transports: ["multipart"] }), undefined);
	const cap = parseLocalEnhancementCapability(wire);
	assert.ok(cap);
	const empty = normalizeLocalEnhancement({ version: 1 });
	assert.throws(() => requireLocalEnhancementCapability(undefined, empty), /增强/);
	assert.doesNotThrow(() => requireLocalEnhancementCapability(cap, empty));
	assert.throws(() => requireLocalEnhancementCapability({ ...cap, hotwords: false }, { ...empty, hotwords: ["词"] }), /热词/);
});

test("local snapshot uses manual scoped content with separate Unicode budgets and no memory", () => {
	const store = createTranscriptionEnhancementStore();
	const term = { weight: 50 as const, status: "approved" as const, source: "manual" as const, scope: { type: "global" as const }, updatedAt: "2026-10-22" };
	for (let i = 0; i < 105; i++) store.terms[String(i)] = { ...term, id: String(i), text: `${i}词` };
	store.terms.memory = { ...term, id: "memory", text: "自动候选", source: "memory" };
	store.terms.other = { ...term, id: "other", text: "无关", scope: { type: "project", value: "other" } };
	store.prompts.a = { id: "a", text: "😀".repeat(399), scope: { type: "global" }, status: "approved", updatedAt: "2026-10-22" };
	const input = { store, scopes: { projects: [], people: [], organizations: [] }, localOnly: true,
		memoryAssertions: [{ id: "private", text: "自动记忆", observedAt: "2026-10-22", subjectType: "user" as const, subjectName: "me" }] };
	const snapshot = buildTranscriptionEnhancementSnapshot(input);
	assert.equal(snapshot.hotwords.length, 100);
	assert.equal(snapshot.omittedHotwordCount, 5);
	assert.equal(snapshot.contextText, "😀".repeat(399));
	assert.deepEqual(snapshot.memoryAssertionIds, []);
	assert.ok(snapshot.hotwords.every((item) => item.text !== "自动候选" && item.text !== "无关"));
	store.terms["0"].text = "字".repeat(1001);
	const next = buildTranscriptionEnhancementSnapshot(input);
	assert.ok(next.hotwords.every((item) => Array.from(item.text).length <= 1000));
	assert.notEqual(next.fingerprint, snapshot.fingerprint);
});

test("local switches persist independently; disabled fingerprints preserve old tasks", () => {
	const defaults = getOfflineTranscriptionProviderDefaults("local-openai-compatible");
	assert.deepEqual(defaults.localEnhancement, { hotwordEnhancementEnabled: false, contextEnhancementEnabled: false });
	const config = { provider: "local-openai-compatible" as const, ...defaults };
	assert.equal(createTranscriptionConfigurationFingerprint(config), createTranscriptionConfigurationFingerprint({ ...config, localEnhancement: undefined }));
	const settings = normalizeEchoNotesSettings({ offlineTranscription: { ...config, language: "auto", localEnhancement: { hotwordEnhancementEnabled: true, contextEnhancementEnabled: false } } });
	const before = createTranscriptionConfigurationFingerprint(settings.offlineTranscription, "one");
	assert.notEqual(before, createTranscriptionConfigurationFingerprint(settings.offlineTranscription, "two"));
	switchOfflineTranscriptionProvider(settings, "lm-studio");
	switchOfflineTranscriptionProvider(settings, "local-openai-compatible");
	assert.equal(settings.offlineTranscription.language, "auto");
	assert.equal(settings.offlineTranscription.localEnhancement?.hotwordEnhancementEnabled, true);
	assert.notEqual(settings.offlineTranscription.localEnhancement, settings.offlineTranscriptionByProvider["local-openai-compatible"]?.localEnhancement);
});

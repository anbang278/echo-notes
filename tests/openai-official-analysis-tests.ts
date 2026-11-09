import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import type { RequestUrlResponse } from "obsidian";
import {
	ANALYSIS_PROVIDER_LABELS,
	DEFAULT_ANALYSIS_TEMPLATES,
	DEFAULT_SETTINGS,
	MEMORY_PROVIDER_LABELS,
	REMOVED_ANALYSIS_PROVIDER_IDS,
	isAnalysisProviderId,
	isMemoryProviderId,
	normalizeEchoNotesSettings
} from "../src/settings/settings";
import {
	OPENAI_OFFICIAL_BASE_URL,
	OPENAI_OFFICIAL_DEFAULT_MODEL,
	OPENAI_OFFICIAL_MODELS,
	OPENAI_OFFICIAL_PRICE_CHECKED_AT,
	OPENAI_OFFICIAL_PRICING_URL,
	formatOpenAIOfficialModelLabel,
	getOpenAIOfficialModelOption,
	isOpenAIOfficialBaseUrl
} from "../src/analysis/openai-model-catalog";
import { AnalysisError, type AnalysisInput, type ChunkedAnalysisProvider } from "../src/analysis/analysis-provider";
import { createAnalysisProvider } from "../src/analysis/analysis-provider-registry";
import { OpenAIOfficialAnalysisProvider } from "../src/analysis/openai-official-analysis-provider";
import { parseOpenAIOfficialAnalysisResponse } from "../src/analysis/openai-official-protocol";
import { diagnoseAnalysisProviderSettings } from "../src/analysis/analysis-diagnostics";
import { ANALYSIS_TASK_TIMEOUT_MS } from "../src/analysis/analysis-timeout";
import { RECORDING_SUMMARY_END, RECORDING_SUMMARY_START } from "../src/analysis/recording-summary";
import { insertOrReplaceTranscriptAnalysis, renderTranscriptAnalysisWithTechnicalInfo } from "../src/analysis/analysis-output";
import { readTranscriptRecordingSummary } from "../src/analysis/analysis-technical";
import { createAnalysisCheckpointIdentity } from "../src/analysis/analysis-checkpoint";
import {
	getAnalysisApiKeySecretId,
	getMemoryApiKeySecretId,
	getRemovedAnalysisApiKeySecretId,
	getTranscriptionApiKeySecretId,
	migrateSecretIfTargetEmpty
} from "../src/security/provider-secrets";
import { queueResponse, requests, resetRequests } from "./fixtures/openai-official-obsidian";

const apiKey = "synthetic-openai-analysis-key";
const privateText = "合成敏感正文仅供本地测试";
const input: AnalysisInput = {
	template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"],
	transcriptTitle: "Synthetic meeting.transcript",
	transcriptText: privateText,
	copyLanguage: "zh",
	includeRecordingSummary: true
};

const settings = () => ({ ...DEFAULT_SETTINGS, analysisProvider: "openai-official" as const, analysisBaseUrl: OPENAI_OFFICIAL_BASE_URL, analysisModel: OPENAI_OFFICIAL_DEFAULT_MODEL });
const completed = (text = "## 会议纪要\n\n整理合成会议讨论内容。") => ({
	status: "completed",
	error: null,
	output: [
		{ type: "reasoning", summary: [{ type: "summary_text", text: "不应进入正文的推理摘要" }] },
		{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text }] }
	]
});
const response = (json: unknown, status = 200, traceId = "req-synthetic"): RequestUrlResponse => ({
	status,
	headers: { "X-Request-Id": traceId },
	json,
	text: JSON.stringify(json),
	arrayBuffer: new ArrayBuffer(0)
});

beforeEach(() => {
	resetRequests();
	Object.defineProperty(globalThis, "window", { configurable: true, value: { setTimeout, clearTimeout } });
});

afterEach(() => {
	mock.restoreAll();
	resetRequests();
	Reflect.deleteProperty(globalThis, "window");
});

test("OpenAI catalog records four Standard prices and dated official source", () => {
	assert.deepEqual(OPENAI_OFFICIAL_MODELS.map(({ id, inputPrice, outputPrice }) => [id, inputPrice, outputPrice]), [
		["gpt-6.1-sol", 2, 10], ["gpt-6.1-terra", 1, 5], ["gpt-6-luna", 0.1, 0.5], ["gpt-6-astra", 10, 50]
	]);
	assert.equal(new Set(OPENAI_OFFICIAL_MODELS.map((model) => model.id)).size, 4);
	assert.equal(OPENAI_OFFICIAL_PRICE_CHECKED_AT, "2026-11-09");
	assert.equal(OPENAI_OFFICIAL_PRICING_URL, "https://developers.openai.com/api/docs/pricing");
	assert.equal(formatOpenAIOfficialModelLabel(OPENAI_OFFICIAL_MODELS[0]), "gpt-6.1-sol · 输入 $2 / 输出 $10");
	assert.equal(formatOpenAIOfficialModelLabel(OPENAI_OFFICIAL_MODELS[2]), "gpt-6-luna · 输入 $0.10 / 输出 $0.50");
	assert.equal(getOpenAIOfficialModelOption(" gpt-6.1-terra ")?.id, "gpt-6.1-terra");
	assert.equal(getOpenAIOfficialModelOption("unknown"), undefined);
});

test("OpenAI configuration normalization preserves selected model and legacy gateway migration", () => {
	assert.equal(ANALYSIS_PROVIDER_LABELS["openai-official"], "OpenAI 官方");
	assert.equal(isAnalysisProviderId("openai-official"), true);
	assert.equal(isMemoryProviderId("openai-official"), false);
	assert.equal(Object.hasOwn(MEMORY_PROVIDER_LABELS, "openai-official"), false);
	assert.equal(REMOVED_ANALYSIS_PROVIDER_IDS.includes("openai"), true);
	assert.equal(isAnalysisProviderId("openai"), false);
	for (const option of OPENAI_OFFICIAL_MODELS) {
		const saved = normalizeEchoNotesSettings({ ...settings(), analysisBaseUrl: "https://gateway.invalid/v1", analysisModel: option.id });
		assert.equal(saved.analysisProvider, "openai-official");
		assert.equal(saved.analysisBaseUrl, OPENAI_OFFICIAL_BASE_URL);
		assert.equal(saved.analysisModel, option.id);
		assert.equal(normalizeEchoNotesSettings(JSON.parse(JSON.stringify(saved))).analysisModel, option.id);
	}
	for (const model of [undefined, "", "unsupported-model"]) {
		assert.equal(normalizeEchoNotesSettings({ analysisProvider: "openai-official", analysisModel: model }).analysisModel, OPENAI_OFFICIAL_DEFAULT_MODEL);
	}
	const legacy = normalizeEchoNotesSettings({ analysisProvider: "openai", analysisBaseUrl: "https://gateway.invalid/v1", analysisModel: "custom-model" });
	assert.equal(legacy.analysisProvider, "custom-openai-compatible");
	assert.equal(legacy.analysisBaseUrl, "https://gateway.invalid/v1");
	assert.equal(legacy.analysisModel, "custom-model");
	assert.equal(normalizeEchoNotesSettings({}).analysisProvider, DEFAULT_SETTINGS.analysisProvider);
	assert.equal(normalizeEchoNotesSettings({ memoryProvider: "openai-official" }).memoryProvider, DEFAULT_SETTINGS.memoryProvider);
});

test("OpenAI analysis credentials use their own slot and legacy migration targets only custom", () => {
	const officialId = getAnalysisApiKeySecretId("openai-official");
	const legacyId = getRemovedAnalysisApiKeySecretId("openai");
	const customId = getAnalysisApiKeySecretId("custom-openai-compatible");
	assert.equal(officialId, "echo-notes-analysis-api-key-openai-official");
	assert.equal(new Set([officialId, legacyId, customId, getMemoryApiKeySecretId("custom-openai-compatible"), getTranscriptionApiKeySecretId("siliconflow")]).size, 5);
	const secrets = new Map([[legacyId, "synthetic-legacy-key"], [officialId, apiKey]]);
	const storage = { getSecret: (id: string) => secrets.get(id) ?? null, setSecret: (id: string, value: string) => { secrets.set(id, value); } };
	assert.equal(migrateSecretIfTargetEmpty(storage, legacyId, customId), true);
	assert.equal(storage.getSecret(customId), "synthetic-legacy-key");
	assert.equal(storage.getSecret(officialId), apiKey);
	assert.equal(storage.getSecret(legacyId), "");
	assert.equal(JSON.stringify(normalizeEchoNotesSettings(settings())).includes(apiKey), false);
});

test("factory routes all four official models through the official Responses request", async () => {
	for (const option of OPENAI_OFFICIAL_MODELS) {
		queueResponse(response(completed()));
		const provider = createAnalysisProvider({ ...settings(), analysisModel: option.id }, ` ${apiKey} `);
		assert.ok(provider instanceof OpenAIOfficialAnalysisProvider);
		const result = await provider.analyze(input);
		const request = requests.at(-1)!;
		assert.equal(request.url, `${OPENAI_OFFICIAL_BASE_URL}/responses`);
		assert.equal(request.method, "POST");
		assert.equal(request.throw, false);
		assert.equal(request.headers?.Authorization, `Bearer ${apiKey}`);
		const body = JSON.parse(String(request.body));
		assert.deepEqual(Object.keys(body).sort(), ["input", "instructions", "model", "reasoning", "service_tier", "store", "stream"]);
		assert.equal(body.model, option.id);
		assert.equal(body.input.includes(privateText), true);
		assert.equal(body.instructions.includes(RECORDING_SUMMARY_START), true);
		assert.equal(body.store, false);
		assert.equal(body.stream, false);
		assert.equal(body.service_tier, "default");
		assert.deepEqual(body.reasoning, { effort: "medium" });
		assert.equal(result.provider, "openai-official");
		assert.equal(result.model, option.id);
		assert.equal(result.traceId, "req-synthetic");
		assert.equal(result.text.includes("推理摘要"), false);
		assert.equal(result.raw, undefined);
	}
	assert.equal(requests.length, 4);
});

test("official URL and model preflight blocks requests before uploading input", async () => {
	const invalidUrls = ["http://api.openai.com/v1", "https://api.openai.com.evil.invalid/v1", "https://api.openai.com/v1/responses", "https://api.openai.com/v1?token=secret", "https://api.openai.com/v1#fragment", "https://user:password@api.openai.com/v1", "https://api.openai.com:443/v1", "https://gateway.invalid/v1", ""];
	assert.equal(isOpenAIOfficialBaseUrl(` ${OPENAI_OFFICIAL_BASE_URL}/// `), true);
	for (const baseUrl of invalidUrls) {
		const config = { ...settings(), analysisBaseUrl: baseUrl };
		assert.equal(isOpenAIOfficialBaseUrl(baseUrl), false);
		assert.equal(diagnoseAnalysisProviderSettings(config, apiKey).canAttemptAnalysis, false);
		await assert.rejects(createAnalysisProvider(config, apiKey).analyze(input), { code: "api_error" });
	}
	assert.equal(diagnoseAnalysisProviderSettings(settings(), "").canAttemptAnalysis, false);
	await assert.rejects(createAnalysisProvider(settings(), " ").analyze(input), { code: "missing_api_key" });
	const unknown = { ...settings(), analysisModel: "unknown" };
	assert.equal(diagnoseAnalysisProviderSettings(unknown, apiKey).canAttemptAnalysis, false);
	await assert.rejects(createAnalysisProvider(unknown, apiKey).analyze(input), { code: "api_error" });
	for (const option of OPENAI_OFFICIAL_MODELS) {
		assert.equal(diagnoseAnalysisProviderSettings({ ...settings(), analysisModel: option.id }, apiKey).canAttemptAnalysis, true);
	}
	assert.equal(requests.length, 0);
});

test("raw Responses messages combine text in order and preserve recording summary for managed writeback", async () => {
	const summary = "新悦新员工销售话术与表达语气对练";
	const json = completed();
	json.output[1].content!.push({ type: "output_text", text: `${RECORDING_SUMMARY_START}\n${summary}\n${RECORDING_SUMMARY_END}` });
	queueResponse(response(json));
	const result = await createAnalysisProvider(settings(), apiKey).analyze(input);
	assert.equal(result.recordingSummary, summary);
	assert.equal(result.text, "## 会议纪要\n\n整理合成会议讨论内容。");
	const rendered = renderTranscriptAnalysisWithTechnicalInfo({ templateId: "work-minutes", templateName: "会议纪要", result, copyLanguage: "zh" });
	const written = insertOrReplaceTranscriptAnalysis("人工说明必须保留\n\n原转写正文。\n", rendered.analysisBlock, "work-minutes", "AI 分析", undefined, rendered.technicalBlock, "zh");
	assert.equal(written.includes("人工说明必须保留"), true);
	assert.equal(written.includes("整理合成会议讨论内容。"), true);
	assert.equal(readTranscriptRecordingSummary(written, "work-minutes"), summary);
	assert.equal(written.includes(RECORDING_SUMMARY_START), false);
	const multiple = completed("第一段");
	multiple.output.push({ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "第二段" }] });
	assert.equal(parseOpenAIOfficialAnalysisResponse(multiple), "第一段\n第二段");
});

test("partial, refused, malformed and empty output fail even with an apparent helper text", async () => {
	const failures: unknown[] = [
		null, "invalid", {}, { output_text: "SDK helper alone" },
		... ["failed", "incomplete", "cancelled", "queued", "in_progress"].map((status) => ({ ...completed("部分正文不能被写入"), status })),
		{ ...completed(), error: { message: privateText } },
		{ ...completed(), output: [] },
		{ ...completed(), output: [{ type: "reasoning", content: [{ type: "output_text", text: "只含推理" }] }] },
		completed(" "),
		completed(`${RECORDING_SUMMARY_START}\n新悦新员工销售话术与表达语气对练\n${RECORDING_SUMMARY_END}`),
		{ ...completed(), output: [{ type: "message", role: "assistant", status: "incomplete", content: [{ type: "output_text", text: "部分正文" }] }] },
		{ ...completed(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: privateText }] }] },
		{ ...completed(), output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "正文" }, { type: "refusal", refusal: privateText }] }] }
	];
	for (const json of failures) {
		queueResponse(response(json));
		await assert.rejects(createAnalysisProvider(settings(), apiKey).analyze(input), (error: AnalysisError) => {
			assert.equal(error.code, "invalid_response");
			assert.equal(error.traceId, "req-synthetic");
			assert.equal(error.message.includes(privateText), false);
			return true;
		});
	}
	assert.equal(requests.length, failures.length);
});

test("HTTP, JSON and network failures keep useful categories without remote text or credentials", async () => {
	const remoteMessage = `${privateText} ${apiKey} sk-synthetic-sensitive-key`;
	for (const [status, code, pattern] of [[400, "invalid_model", /模型/], [401, "invalid_api_key", /API Key/], [403, "forbidden", /权限/], [404, "model_not_found", /模型/], [429, "insufficient_quota", /余额.*配额/], [429, "rate_limit_exceeded", /限流/], [503, "server_error", /稍后重试/]] as const) {
		queueResponse(response({ error: { code, message: remoteMessage } }, status));
		await assert.rejects(createAnalysisProvider(settings(), apiKey).analyze(input), (error: AnalysisError) => {
			assert.equal(error.code, "api_error");
			assert.equal(error.traceId, "req-synthetic");
			assert.match(error.message, pattern);
			assert.equal(error.message.includes(remoteMessage), false);
			assert.equal(error.message.includes(apiKey), false);
			return true;
		});
	}
	for (const status of [200, 502]) {
		const malformed = response(undefined, status);
		Object.defineProperty(malformed, "json", { get: () => { throw new Error(remoteMessage); } });
		queueResponse(malformed);
		await assert.rejects(createAnalysisProvider(settings(), apiKey).analyze(input), { code: status === 200 ? "invalid_response" : "api_error", traceId: "req-synthetic" });
	}
	const events: unknown[] = [];
	queueResponse(new Error(remoteMessage));
	await assert.rejects(createAnalysisProvider(settings(), apiKey).analyze({ ...input, diagnostics: { event: (...event: unknown[]) => { events.push(event); } } }), (error: AnalysisError) => {
		assert.equal(error.code, "network_error");
		assert.equal(error.message.includes(privateText), false);
		assert.equal(error.message.includes(apiKey), false);
		return true;
	});
	assert.equal(JSON.stringify(events).includes(privateText), false);
	assert.equal(JSON.stringify(events).includes(apiKey), false);
	assert.equal(requests.length, 10);
});

test("chunk extraction and synthesis keep provider snapshot, trace IDs and final summary", async () => {
	const config = settings();
	const provider = createAnalysisProvider(config, apiKey) as ChunkedAnalysisProvider;
	queueResponse(response(completed("第一块提取内容"), 200, "req-chunk-1"));
	queueResponse(response(completed("第二块提取内容"), 200, "req-chunk-2"));
	const summary = "新悦新员工销售话术与表达语气对练";
	queueResponse(response(completed(`汇总分析正文\n${RECORDING_SUMMARY_START}\n${summary}\n${RECORDING_SUMMARY_END}`), 200, "req-synthesis"));
	const first = await provider.analyzeChunk(input, 1, 2);
	config.analysisModel = "gpt-6-astra";
	config.analysisBaseUrl = "https://gateway.invalid/v1";
	const second = await provider.analyzeChunk(input, 2, 2);
	const final = await provider.synthesizeChunks(input, [first, second]);
	assert.equal(first.recordingSummary, undefined);
	assert.equal(second.recordingSummary, undefined);
	assert.equal(final.text, "汇总分析正文");
	assert.equal(final.recordingSummary, summary);
	assert.equal(final.traceId, "req-chunk-1, req-chunk-2, req-synthesis");
	for (const request of requests) {
		assert.equal(request.url, `${OPENAI_OFFICIAL_BASE_URL}/responses`);
		assert.equal(JSON.parse(String(request.body)).model, OPENAI_OFFICIAL_DEFAULT_MODEL);
	}
	assert.equal(JSON.parse(String(requests[0].body)).instructions.includes(RECORDING_SUMMARY_START), false);
	assert.equal(JSON.parse(String(requests[2].body)).instructions.includes(RECORDING_SUMMARY_START), true);
	assert.equal(JSON.parse(String(requests[2].body)).input.includes("第一块提取内容"), true);
});

test("checkpoint identities distinguish official Provider and selected models", () => {
	const config = settings();
	const makeIdentity = (providerSettings: typeof config) => createAnalysisCheckpointIdentity({
		transcriptPath: "synthetic.transcript.md",
		analysisText: input.transcriptText,
		template: input.template,
		settings: providerSettings,
		overlapCharacters: 100
	});
	const sol = makeIdentity(config);
	const terra = makeIdentity({ ...config, analysisModel: "gpt-6.1-terra" });
	assert.equal(sol.provider, "openai-official");
	assert.equal(sol.model, "gpt-6.1-sol");
	assert.notEqual(sol.configurationFingerprint, terra.configurationFingerprint);
	const gateway = createAnalysisCheckpointIdentity({ transcriptPath: "synthetic.transcript.md", analysisText: input.transcriptText, template: input.template, settings: { ...config, analysisProvider: "custom-openai-compatible" }, overlapCharacters: 100 });
	assert.notEqual(sol.configurationFingerprint, gateway.configurationFingerprint);
});

test("same Provider uses a shared task deadline and ignores a late response", async () => {
	const startedAt = 1000;
	let now = startedAt;
	mock.method(Date, "now", () => now);
	const provider = createAnalysisProvider(settings(), apiKey) as ChunkedAnalysisProvider;
	queueResponse(response(completed()));
	await provider.analyzeChunk(input, 1, 2);
	now = startedAt + ANALYSIS_TASK_TIMEOUT_MS;
	await assert.rejects(provider.synthesizeChunks(input, []), { code: "timeout" });
	assert.equal(requests.length, 1);

	now = startedAt;
	const pendingProvider = createAnalysisProvider(settings(), apiKey);
	now = startedAt + ANALYSIS_TASK_TIMEOUT_MS - 1;
	let finishRequest: (value: RequestUrlResponse) => void = () => { throw new Error("Request did not start"); };
	queueResponse(() => new Promise((resolve) => { finishRequest = resolve; }));
	const events: unknown[][] = [];
	await assert.rejects(pendingProvider.analyze({ ...input, diagnostics: { event: (...event: unknown[]) => { events.push(event); } } }), { code: "timeout" });
	finishRequest(response(completed("迟到结果不能进入正文")));
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(events.some((event) => event[1] === "analysis-request-finished"), false);
});

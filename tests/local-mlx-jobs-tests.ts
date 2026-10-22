import assert from "node:assert/strict";
import { test } from "node:test";
import type { TFile } from "obsidian";
import { acknowledgeLocalMlxResult, cancelLocalMlxTask, isEligibleLocalMlxEndpoint, LocalMlxCapabilityCache, normalizeLoopbackOrigin, runLocalMlxJob, type LocalAsrCapabilities, type LocalDesktopFiles, type LocalLoopbackHttp } from "../src/providers/local-mlx-jobs";
import type { LocalHttpRequest, LocalLoopbackResponse } from "../src/network/local-http";
import type { LocalTranscriptionTaskResume } from "../src/providers/transcription-provider";
import type { OfflineTranscriptionProviderId, TranscriptionConfig } from "../src/settings/settings";

const origin = "http://127.0.0.1:18081";
const config: TranscriptionConfig<OfflineTranscriptionProviderId> = { provider: "local-openai-compatible", baseUrl: `${origin}/v1`, model: "m/plain", language: "zh" };
const caps: LocalAsrCapabilities = { instanceId: "instance-1", version: "2.0", maxFileBytes: 1073741824, maxDurationSeconds: 28800, chunkBytes: 4194304 };
const capsWire = { service: "echonotes-mlx-asr", protocol: 1, instance_id: caps.instanceId, version: caps.version, models: [config.model], max_file_bytes: caps.maxFileBytes, max_duration_seconds: caps.maxDurationSeconds, chunk_bytes: caps.chunkBytes };
const enhancementCapability = { hotwords: true, context: true, limits: { max_hotwords: 100, max_hotword_characters: 1000, max_context_characters: 400 } };
const reply = (status: number, body: unknown = {}) => ({ status, headers: {}, bodyText: JSON.stringify(body) });
const file = (size: number): TFile => ({ path: "audio/a.wav", name: "a.wav", extension: "wav", stat: { size, mtime: 1234, ctime: 1234 } }) as TFile;

function files(size: number, opts: { identity?: () => string; onRead?: (start: number, length: number) => void; onClose?: () => void } = {}): LocalDesktopFiles {
	return { vaultRoot: () => "/isolated", async openVaultFile() {
		return { path: "/isolated/audio/a.wav", async size() { return size; }, async mtimeMs() { return 1234; },
			async identity() { return opts.identity?.() ?? "file-1"; }, async close() { opts.onClose?.(); },
			async readRange(start, length) { opts.onRead?.(start, length); return new Uint8Array(length).fill(7); } };
	} };
}

function harness(size = 1024) {
	let offset = 0;
	let state = "uploading";
	let requestId: string | undefined;
	let creations = 0;
	let commits = 0;
	const calls: Array<{ url: string; init: LocalHttpRequest }> = [];
	const status = () => ({ job_id: "job-1", instance_id: caps.instanceId, state, stage: state, received_bytes: offset, total_bytes: size });
	const http: LocalLoopbackHttp = { async request(url, init) {
		calls.push({ url, init });
		if (url.endsWith("/capabilities")) return reply(200, capsWire);
		if (url.endsWith("/jobs") && init.method === "POST") {
			const body = JSON.parse(String(init.body));
			if (!requestId) { creations++; requestId = body.client_request_id; }
			assert.equal(body.client_request_id, requestId, "creation retries use the same persisted ID");
			return reply(201, { ...status(), next_offset: offset, chunk_bytes: caps.chunkBytes });
		}
		if (url.endsWith("/audio")) {
			const start = Number(init.headers?.["X-Offset"]);
			assert.ok(init.body instanceof Uint8Array);
			const length = init.body.byteLength;
			assert.ok(length <= 4194304);
			assert.equal(init.headers?.["Content-Range"], `bytes ${start}-${start + length - 1}/${size}`);
			if (start === offset) offset += length;
			else assert.equal(start + length, offset, "only exact last block may be replayed");
			return reply(200, { ...status(), next_offset: offset });
		}
		if (url.endsWith("/commit")) {
			if (state === "uploading") { commits++; state = "succeeded"; }
			return reply(202, status());
		}
		if (url.endsWith("/result")) return reply(200, { text: "完整录音结果" });
		if (init.method === "DELETE") { state = "canceled"; return reply(204); }
		return reply(200, status());
	} };
	return { http, calls, status, setState(value: string) { state = value; }, get creations() { return creations; }, get commits() { return commits; } };
}

function deps(http: LocalLoopbackHttp, size = 1024) {
	return { http, files: files(size), capabilities: caps, origin, apiKey: "", pollIntervalMs: 0, retryDelayMs: 0 };
}

function wrapping(http: LocalLoopbackHttp, wrapper: (url: string, init: LocalHttpRequest, next: () => Promise<LocalLoopbackResponse>) => Promise<LocalLoopbackResponse>): LocalLoopbackHttp {
	return { request: (url, init) => wrapper(url, init, () => http.request(url, init)) };
}

test("prompt snapshot is frozen in creation and changed words cannot resume the old job", async () => {
	const h = harness();
	const enhancement = { version: 1 as const, hotwords: ["星河"], context_text: "人工背景" };
	const outcome = await runLocalMlxJob(file(1024), config, { ...deps(h.http), capabilities: { ...caps, enhancement: enhancementCapability }, enhancement,
		onCheckpoint() { enhancement.hotwords[0] = "changed during upload"; } });
	const body = JSON.parse(String(h.calls.find((call) => call.url.endsWith("/jobs"))!.init.body));
	assert.deepEqual(body.enhancement, { version: 1, hotwords: ["星河"], context_text: "人工背景" });
	assert.doesNotMatch(JSON.stringify(outcome.localTask), /星河|人工背景/);
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), capabilities: { ...caps, enhancement: enhancementCapability },
		enhancement, checkpoint: outcome.localTask }), /配置已变化/);
});

test("old service rejects enabled hints before opening audio; disabled creation stays unchanged", async () => {
	const h = harness();
	let opened = false;
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), files: { vaultRoot: () => "/isolated", async openVaultFile() { opened = true; throw new Error("unexpected file read"); } },
		enhancement: { version: 1, hotwords: [], context_text: "" } }), /增强/);
	assert.equal(opened, false);
	await runLocalMlxJob(file(1024), config, deps(h.http));
	const body = JSON.parse(String(h.calls.find((call) => call.url.endsWith("/jobs"))!.init.body));
	assert.equal("enhancement" in body, false);
});

test("model enhancement capability requires a valid explicit per-model declaration", async () => {
	const cache = new LocalMlxCapabilityCache();
	const response = { ...capsWire, model_capabilities: { [config.model]: { enhancement: { ...enhancementCapability, version: 1, transports: ["jobs"] } } } };
	const result = await cache.probe({ async request() { return reply(200, response); } }, origin, config.model);
	assert.deepEqual(result?.enhancement, enhancementCapability);
});

test("lost enhanced creation is canceled by read-only request lookup without resending prompts", async () => {
	const h = harness();
	const outcome = await runLocalMlxJob(file(1024), config, deps(h.http));
	const http = wrapping(h.http, async (url, init, next) => {
		if (url.endsWith("/capabilities")) return reply(200, { ...capsWire, request_lookup: true });
		if (url.includes("/requests/")) {
			assert.equal(init.method, "GET");
			return reply(200, h.status());
		}
		assert.notEqual(init.method, "POST");
		return next();
	});
	const result = await cancelLocalMlxTask(http, { ...outcome.localTask, jobId: undefined });
	assert.equal(result.confirmed, true);
	assert.equal(result.task.jobId, "job-1");
});

test("MLX gate accepts only current literal loopback service endpoints", () => {
	for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.equal(isEligibleLocalMlxEndpoint(`http://${host}:18081/v1/`), true);
	for (const url of ["https://127.0.0.1:18080/v1", "http://127.1:18080/v1", "http://myhost:18080/v1", "http://127.0.0.1:8080/v1", "http://user:pass@127.0.0.1:18080/v1", "http://127.0.0.1:18080/v1?q=1", "http://127.0.0.1:18080/v1#x"]) assert.equal(isEligibleLocalMlxEndpoint(url), false);
	assert.equal(normalizeLoopbackOrigin("http://localhost:18081/v1"), origin);
});

test("capabilities validate exact service, numbers, model and bound the advertised limits", async () => {
	const cache = new LocalMlxCapabilityCache();
	for (const override of [{ protocol: 2 }, { service: "other" }, { instance_id: "" }, { models: ["other"] }, { max_file_bytes: "1" }, { chunk_bytes: 1024 }]) {
		assert.equal(await cache.probe({ async request() { return reply(200, { ...capsWire, ...override }); } }, origin, config.model), null);
	}
	assert.deepEqual(await cache.probe({ async request() { return reply(200, { ...capsWire, max_file_bytes: 2 ** 40, max_duration_seconds: 999999, chunk_bytes: 8 * 1024 * 1024 }); } }, origin, config.model), caps);
	await assert.rejects(cache.probe({ async request() { return reply(302); } }, origin, config.model), /重定向/);
});

test("awaits durable checkpoints before create and each next upload; success never deletes", async () => {
	const size = 5 * 1024 * 1024 + 3;
	const h = harness(size);
	let persisted: LocalTranscriptionTaskResume | undefined;
	const checkpoints: LocalTranscriptionTaskResume[] = [];
	const http = wrapping(h.http, async (url, init, next) => {
		assert.ok(persisted, "checkpoint is durable before any request");
		if (url.endsWith("/jobs")) assert.equal(persisted.clientRequestId, JSON.parse(String(init.body)).client_request_id);
		if (url.endsWith("/audio")) assert.equal(persisted.confirmedOffset, Number(init.headers?.["X-Offset"]));
		return next();
	});
	const outcome = await runLocalMlxJob(file(size), config, { ...deps(http, size), async onCheckpoint(task) {
		await new Promise((resolve) => setImmediate(resolve)); persisted = task; checkpoints.push(task);
	} });
	assert.equal(outcome.text, "完整录音结果");
	assert.equal(outcome.localTask.phase, "saving");
	assert.ok(checkpoints.some((c) => c.confirmedOffset === 4194304));
	assert.equal(h.calls.some((c) => c.init.method === "DELETE"), false);
	assert.ok(h.calls.every((c) => c.init.headers?.Authorization === undefined), "empty key never sent");
	assert.equal(h.creations, 1); assert.equal(h.commits, 1);
});

test("creation, chunk and commit lost acknowledgements replay idempotently", async () => {
	const h = harness(); const dropped = new Set<string>();
	const http = wrapping(h.http, async (url, _init, next) => {
		const result = await next();
		if (["/jobs", "/audio", "/commit"].some((p) => url.endsWith(p)) && !dropped.has(url)) { dropped.add(url); throw new Error("lost ACK"); }
		return result;
	});
	const outcome = await runLocalMlxJob(file(1024), config, deps(http));
	assert.equal(outcome.text, "完整录音结果"); assert.equal(h.creations, 1); assert.equal(h.commits, 1); assert.equal(dropped.size, 3);
});

test("completed checkpoint resumes by GET result without create, upload or commit", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	h.calls.length = 0;
	const resumed = await runLocalMlxJob(file(1024), config, { ...deps(h.http), checkpoint: first.localTask });
	assert.equal(resumed.text, first.text); assert.ok(h.calls.every((c) => c.init.method === "GET"));
	assert.equal(h.creations, 1); assert.equal(h.commits, 1);
});

test("disconnect leaves job and persisted offset for resume", async () => {
	const size = 5 * 1024 * 1024;
	const h = harness(size); let saved: LocalTranscriptionTaskResume | undefined;
	const broken = wrapping(h.http, async (url, init, next) => { if (url.endsWith("/audio") && init.headers?.["X-Offset"] !== "0") throw new Error("offline"); return next(); });
	await assert.rejects(runLocalMlxJob(file(size), config, { ...deps(broken, size), onCheckpoint(c) { saved = c; } }), /offline/);
	assert.equal(saved?.confirmedOffset, 4194304);
	assert.equal(h.calls.some((c) => c.init.method === "DELETE"), false);
	await runLocalMlxJob(file(size), config, { ...deps(h.http, size), checkpoint: saved });
	assert.equal(h.creations, 1); assert.equal(h.commits, 1);
});

test("checkpoint storage failure stops before network mutation and never cleans", async () => {
	const h = harness();
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), onCheckpoint() { throw new Error("disk full"); } }), /disk full/);
	assert.equal(h.calls.length, 0);
	let calls = 0;
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), onCheckpoint() { if (++calls === 3) throw new Error("disk full"); } }), /disk full/);
	assert.equal(h.commits, 0); assert.equal(h.calls.some((c) => c.init.method === "DELETE"), false);
});

test("source/config/instance changes and expiration never silently create new work", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	for (const checkpoint of [{ ...first.localTask, sourceIdentity: "other" }, { ...first.localTask, model: "other" }, { ...first.localTask, instanceId: "old" }]) {
		h.calls.length = 0;
		await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), checkpoint }), /变化|重启/);
		assert.equal(h.calls.length, 0);
	}
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps({ async request() { return reply(410); } }), checkpoint: first.localTask }), /过期|重启/);
});

test("changed source during upload cannot commit; bounded read is always closed", async () => {
	const h = harness(5 * 1024 * 1024); let changed = false; let closed = false;
	await assert.rejects(runLocalMlxJob(file(5 * 1024 * 1024), config, {
		...deps(h.http, 5 * 1024 * 1024), files: files(5 * 1024 * 1024, { identity: () => changed ? "changed" : "file-1", onRead: () => { changed = true; }, onClose: () => { closed = true; } })
	}), /变化/);
	assert.equal(h.commits, 0); assert.equal(closed, true);
});

test("invalid upload offsets, job IDs and redirects are hard failures without fallback", async () => {
	for (const response of [reply(200, { next_offset: 2000 }), reply(302)]) {
		const h = harness();
		const http = wrapping(h.http, async (url, _init, next) => url.endsWith("/audio") ? response : next());
		await assert.rejects(runLocalMlxJob(file(1024), config, deps(http)), /偏移|重定向/);
		assert.equal(h.commits, 0);
	}
});

test("capability limit rejects before create; no full-file allocation is needed", async () => {
	const h = harness();
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), capabilities: { ...caps, maxFileBytes: 100 } }), /上限/);
	assert.equal(h.calls.length, 0);
});

test("abort after result response cannot return success or delete the job", async () => {
	const h = harness(); const controller = new AbortController();
	const http = wrapping(h.http, async (url, _init, next) => { const result = await next(); if (url.endsWith("/result")) controller.abort(); return result; });
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(http), signal: controller.signal }), /中断/);
	assert.equal(h.calls.some((c) => c.init.method === "DELETE"), false);
});

test("canceling checkpoint cannot resume normal work", async () => {
	const h = harness(); const result = await runLocalMlxJob(file(1024), config, deps(h.http));
	h.calls.length = 0;
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(h.http), checkpoint: { ...result.localTask, cancelRequested: true } }), /取消/);
	assert.equal(h.calls.length, 0);
});

test("explicit cancel confirms only terminal acknowledgment; 202 is not final", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	h.setState("running");
	const pending = wrapping(h.http, async (_url, init, next) => { if (init.method === "DELETE") { h.setState("canceling"); return reply(202); } return next(); });
	const waiting = await cancelLocalMlxTask(pending, first.localTask);
	assert.equal(waiting.confirmed, false); assert.equal(waiting.task.cancelRequested, true); assert.equal(waiting.task.phase, "canceling");
	const done = await cancelLocalMlxTask(h.http, waiting.task);
	assert.equal(done.confirmed, true); assert.equal(done.task.phase, "canceled");
});

test("save acknowledgment is the only result cleanup; errors remain cleanup-pending", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	const broken = wrapping(h.http, async (_url, init, next) => { if (init.method === "DELETE") throw new Error("offline"); return next(); });
	const pending = await acknowledgeLocalMlxResult(broken, first.localTask);
	assert.equal(pending.confirmed, false); assert.equal(pending.task.phase, "cleanup-pending");
	const done = await acknowledgeLocalMlxResult(h.http, pending.task);
	assert.equal(done.confirmed, true); assert.ok(h.calls.some((c) => c.init.method === "DELETE"));
});

test("failed server job never exposes partial text", async () => {
	const h = harness();
	const http = wrapping(h.http, async (url, _init, next) => {
		const result = await next();
		if (url.endsWith("/commit")) h.setState("failed");
		if (url.endsWith("/job-1")) return reply(200, { ...h.status(), error: { message: "duration exceeded" } });
		return result;
	});
	await assert.rejects(runLocalMlxJob(file(1024), config, deps(http)), /duration exceeded/);
	assert.equal(h.calls.some((c) => c.url.endsWith("/result")), false);
});

test("verified service restart terminates old cancellation and cleanup; unreachable or fake identity does not", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	const restarted: LocalLoopbackHttp = { async request(url) {
		assert.ok(url.endsWith("/capabilities"), "must not mutate a job on a new service instance");
		return reply(200, { ...capsWire, instance_id: "instance-2" });
	} };
	const canceled = await cancelLocalMlxTask(restarted, first.localTask);
	assert.equal(canceled.confirmed, true); assert.equal(canceled.expired, true); assert.equal(canceled.task.phase, "canceled");
	const cleaned = await acknowledgeLocalMlxResult(restarted, first.localTask);
	assert.equal(cleaned.confirmed, true); assert.equal(cleaned.expired, true);
	for (const response of [reply(401), reply(200, { ...capsWire, service: "other", instance_id: "fake" })]) {
		const rejected: LocalLoopbackHttp = { async request() { return response; } };
		assert.equal((await cancelLocalMlxTask(rejected, first.localTask)).confirmed, false);
		assert.equal((await acknowledgeLocalMlxResult(rejected, first.localTask)).confirmed, false);
	}
});

test("cancel recovers a creation with a lost acknowledgment through the original request ID", async () => {
	const h = harness(); let checkpoint: LocalTranscriptionTaskResume | undefined;
	const missing = wrapping(h.http, async (url, _init, next) => { const result = await next(); if (url.endsWith("/jobs")) throw new Error("creation ACK lost"); return result; });
	await assert.rejects(runLocalMlxJob(file(1024), config, { ...deps(missing), onCheckpoint(task) { checkpoint = task; } }), /ACK lost/);
	assert.ok(checkpoint); assert.equal(checkpoint.jobId, undefined);
	const canceled = await cancelLocalMlxTask(h.http, checkpoint);
	assert.equal(canceled.confirmed, true); assert.equal(canceled.task.jobId, "job-1"); assert.equal(h.creations, 1); assert.equal(h.commits, 0);
});

// Result presentation is part of the protocol contract: uncertain segments cannot become extra people.
import { parseLocalMlxResult } from "../src/providers/local-mlx-result";
import { renderTranscriptionUtterances } from "../src/transcript/transcript-template";
import { LOCAL_OPENAI_DIARIZATION_MODEL } from "../src/settings/settings";

function diarizedResult() {
	const segments = [
		{ start: 0, end: 0.4, speaker: null, speakers: [], overlap: false, text: "嗯。" },
		{ start: 0.4, end: 1.2, speaker: "speaker_2", speakers: [2], overlap: false, text: "第二个人。" },
		{ start: 1.3, end: 2.5, speaker: null, speakers: [1, 2], overlap: true, text: "重叠。" },
		{ start: 2.6, end: 3.4, speaker: null, speakers: [2, 3], overlap: false, text: "切换处。" },
		{ start: 3.5, end: 4.5, speaker: "speaker_1", speakers: [1], overlap: false, text: "第一人。" },
		{ start: 4.6, end: 4.6, speaker: "speaker_1", speakers: [1], overlap: false, text: "是。" }
	];
	return { text: "已格式化说话人和时间的正文", transcript: segments.map(s => s.text).join("\n"), segments, duration: 5, speaker_count: 3 };
}

test("diarization result preserves typed speaker attribution, timestamp points and exact text", () => {
	const result = diarizedResult();
	const parsed = parseLocalMlxResult(result, LOCAL_OPENAI_DIARIZATION_MODEL);
	assert.equal(parsed.text, result.text);
	assert.equal(parsed.utterances?.length, 6);
	assert.deepEqual(parsed.utterances?.map(u => u.localSpeaker), [
		{ kind: "unassigned", speakers: [] }, { kind: "identified", speakers: [2] },
		{ kind: "overlap", speakers: [1, 2] }, { kind: "boundary", speakers: [2, 3] },
		{ kind: "identified", speakers: [1] }, { kind: "identified", speakers: [1] }
	]);
	assert.equal(parsed.utterances?.at(-1)?.startSeconds, 4.6);
	assert.equal(parsed.utterances?.at(-1)?.endSeconds, 4.6);
	assert.equal(parsed.utterances?.map(u => u.text).join(""), result.transcript.replace(/\n/g, ""));
	assert.equal("raw" in parsed, false);
});

test("native transcript renders known numbers and uncertainty without a fictitious fifth person", () => {
	const { utterances } = parseLocalMlxResult(diarizedResult(), LOCAL_OPENAI_DIARIZATION_MODEL); assert.ok(utterances);
	const zh = renderTranscriptionUtterances(utterances, "zh", "speaker-with-time");
	assert.match(zh, /\*\*说话人未确定（00:00-00:00）\*\*/);
	assert.match(zh, /\*\*说话人 2（00:00-00:01）\*\*/);
	assert.match(zh, /重叠发言（说话人 1 \/ 说话人 2，归属待核对）/);
	assert.match(zh, /说话人切换处（说话人 2 \/ 说话人 3，归属待核对）/);
	assert.match(zh, /第一人。是。/);
	assert.doesNotMatch(zh, /说话人 [45]/);
	const en = renderTranscriptionUtterances(utterances, "en", "speaker");
	assert.match(en, /\*\*Speaker 2\*\*/); assert.match(en, /Speaker undetermined/);
	assert.match(en, /Overlapping speech \(Speaker 1 \/ Speaker 2, attribution unverified\)/);
	assert.doesNotMatch(en, /00:0/);
});

test("uncertain local turns and a long silence retain separate time ranges", () => {
	const { utterances } = parseLocalMlxResult(diarizedResult(), LOCAL_OPENAI_DIARIZATION_MODEL); assert.ok(utterances);
	const unknown = utterances[0]; const known = utterances[1];
	const rendered = renderTranscriptionUtterances([
		unknown, { ...unknown, text: "另一个未知回应。", startSeconds: 0.5, endSeconds: 0.6 },
		known, { ...known, text: "静默之后。", startSeconds: 10, endSeconds: 11 }
	], "zh", "speaker-with-time");
	assert.equal((rendered.match(/\*\*说话人未确定/g) ?? []).length, 2);
	assert.equal((rendered.match(/\*\*说话人 2/g) ?? []).length, 2);
});

test("malformed diarization attribution, chronology and partial text fail instead of silently dropping content", () => {
	const seed = diarizedResult();
	const badSegments = [
		{ ...seed.segments[1], speakers: [5], speaker: "speaker_5" },
		{ ...seed.segments[1], speakers: [2, 2], speaker: null },
		{ ...seed.segments[1], speakers: [3, 2], speaker: null },
		{ ...seed.segments[1], speaker: "speaker_1" },
		{ ...seed.segments[1], overlap: true },
		{ ...seed.segments[1], start: Number.NaN },
		{ ...seed.segments[1], start: -0.2 },
		{ ...seed.segments[1], end: 6 },
		{ ...seed.segments[1], end: 0.1 },
		{ ...seed.segments[1], text: "" },
		{ ...seed.segments[1], speakers: undefined }
	];
	for (const segment of badSegments) {
		assert.throws(() => parseLocalMlxResult({ ...seed, segments: [seed.segments[0], segment, ...seed.segments.slice(2)] }, LOCAL_OPENAI_DIARIZATION_MODEL), /不完整/);
	}
	for (const patch of [{ transcript: "missing words" }, { duration: Infinity }, { speaker_count: 1 }, { segments: [] }, { transcript: undefined }, { segments: [...seed.segments].reverse() }]) {
		assert.throws(() => parseLocalMlxResult({ ...seed, ...patch }, LOCAL_OPENAI_DIARIZATION_MODEL), /不完整/);
	}
});

test("verified silence is legal and ordinary results do not accept arbitrary speaker extensions", () => {
	assert.deepEqual(parseLocalMlxResult({ text: "", transcript: "", segments: [], duration: 30, speaker_count: 0 }, LOCAL_OPENAI_DIARIZATION_MODEL), { text: "" });
	assert.deepEqual(parseLocalMlxResult({ text: "ordinary", segments: [{ speaker: "arbitrary" }], raw: { secret: "forbidden" }, utterances: [{ speakerId: "injected" }] }, "m/plain"), { text: "ordinary" });
});

test("job result delivers native utterances and keeps recoverable results until durable save", async () => {
	const h = harness();
	const http = wrapping(h.http, async (url, _init, next) => url.endsWith("/result") ? reply(200, diarizedResult()) : next());
	const outcome = await runLocalMlxJob(file(1024), { ...config, model: LOCAL_OPENAI_DIARIZATION_MODEL }, deps(http));
	assert.equal(outcome.utterances?.length, 6); assert.equal(outcome.localTask.phase, "saving");
	assert.equal(h.calls.some(c => c.init.method === "DELETE"), false);
});

test("configuration changes have a dedicated error and never delete the old task", async () => {
	const h = harness(); const first = await runLocalMlxJob(file(1024), config, deps(h.http));
	h.calls.length = 0;
	await assert.rejects(runLocalMlxJob(file(1024), { ...config, language: "en" }, { ...deps(h.http), checkpoint: first.localTask }),
		(error: unknown) => error instanceof Error && "code" in error && error.code === "local_configuration_changed");
	assert.equal(h.calls.length, 0);
});

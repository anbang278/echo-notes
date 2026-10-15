import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, open, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { pathToFileURL } from "node:url";
import type { App, TFile } from "obsidian";
import { createLoopbackHttpAdapter } from "../src/network/loopback-http-adapter";
import { createDesktopFiles, type LocalDesktopFiles } from "../src/network/local-desktop-files";
import { parseLoopbackUrl, type LocalLoopbackHttp } from "../src/network/local-http";
import { LocalOpenAICompatibleProvider } from "../src/providers/local-openai-compatible-provider";
import type { LocalTranscriptionTaskResume, TranscriptionProgress } from "../src/providers/transcription-provider";

const runtime = { require: createRequire(import.meta.url), setTimeout, clearTimeout };
Object.assign(globalThis, { window: runtime });
const size = 30 * 1024 * 1024 + 11;
const config = (baseUrl: string) => ({ provider: "local-openai-compatible" as const, baseUrl, model: "custom-local-asr", language: "zh" });
const audio = (bytes = size): TFile => ({ path: "audio.wav", name: "audio.wav", extension: "wav", stat: { size: bytes, mtime: 123, ctime: 123 } }) as TFile;
const app = (root: string): App => ({ vault: { adapter: { getBasePath: () => root, getFullPath: (p: string) => path.join(root, p), getFilePath: (p: string) => pathToFileURL(path.join(root, p)).href }, readBinary() { throw new Error("whole file read forbidden"); } } }) as unknown as App;

async function withServer(handler: (req: IncomingMessage, res: ServerResponse) => void, action: (url: string) => Promise<void>) {
	const server = createServer(handler);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address(); assert.ok(address && typeof address === "object");
	try { await action(`http://127.0.0.1:${address.port}`); }
	finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}

async function withAudio(bytes: number, action: (root: string) => Promise<void>) {
	const root = await mkdtemp(path.join(tmpdir(), "echo-local-stream-"));
	const handle = await open(path.join(root, "audio.wav"), "w");
	await handle.truncate(bytes); await handle.close();
	try { await action(root); } finally { await rm(root, { recursive: true, force: true }); }
}

function fakeFiles(bytes: number): LocalDesktopFiles {
	return { vaultRoot: () => "/isolated", async openVaultFile() { return {
		path: "/isolated/audio.wav", async size() { return bytes; }, async mtimeMs() { return 123; }, async identity() { return "same"; },
		async readRange(_start, length) { return new Uint8Array(length); }, async close() {}
	}; } };
}

test("loopback HTTP rejects remote URLs, shorthand, credentials and query redirects", () => {
	for (const url of ["http://127.1/v1", "http://2130706433/v1", "http://0x7f000001/v1", "http://remote/v1", "http://localhost/v1?q=1", "http://a:b@localhost/v1"]) {
		assert.throws(() => parseLoopbackUrl(url));
	}
	assert.equal(parseLoopbackUrl("https://[::1]:1234/v1").hostname, "[::1]");
});

test("real HTTP multipart streams >25MiB from disk with bounded reads and backpressure", async () => {
	await withAudio(size, async (root) => {
		const desktop = await createDesktopFiles(app(root)); assert.ok(desktop);
		let reads = 0; let maxRead = 0; let closed = false; let received = 0; let declared = 0; let head = "";
		const bounded: LocalDesktopFiles = { ...desktop, async openVaultFile(p) {
			const handle = await desktop.openVaultFile(p);
			return { ...handle, async readRange(start, length) { reads++; maxRead = Math.max(maxRead, length); return handle.readRange(start, length); }, async close() { closed = true; await handle.close(); } };
		} };
		const progress: TranscriptionProgress[] = [];
		await withServer((req, res) => {
			assert.equal(req.url, "/v1/audio/transcriptions"); assert.equal(req.method, "POST"); assert.equal(req.headers.authorization, undefined);
			declared = Number(req.headers["content-length"]);
			req.pause();
			setTimeout(() => { assert.ok(reads <= 2, `read ahead while receiver paused: ${reads}`); req.resume(); }, 100);
			req.on("data", (chunk: Buffer) => { received += chunk.byteLength; if (head.length < 2048) head += chunk.subarray(0, 2048).toString(); });
			req.on("end", () => res.end(JSON.stringify({ text: "长音频成功" })));
		}, async (url) => {
			const provider = new LocalOpenAICompatibleProvider(app(root), config(`${url}/v1`), "", { files: bounded });
			const result = await provider.transcribe({ audioFile: audio(), onProgress(p) { progress.push(p); } });
			assert.equal(result.text, "长音频成功"); assert.equal(result.localTask, undefined);
		});
		assert.equal(declared, received); assert.ok(received > size); assert.ok(maxRead <= 4 * 1024 * 1024);
		assert.equal(reads, Math.ceil(size / (4 * 1024 * 1024))); assert.equal(closed, true);
		assert.match(head, /name="model"\r\n\r\ncustom-local-asr/); assert.match(head, /name="language"\r\n\r\nzh/);
		assert.ok(progress.some((p) => p.type === "local-asr-progress" && p.phase === "waiting"));
		assert.ok(progress.some((p) => p.type === "local-asr-progress" && p.uploadedBytes === size));
	});
});

test("response wait starts after upload and is independent of upload idle timeout", async () => {
	await withServer((req, res) => { req.resume(); req.on("end", () => setTimeout(() => res.end("done"), 80)); }, async (url) => {
		const http = createLoopbackHttpAdapter(); assert.ok(http);
		const response = await http.request(url, { method: "POST", body: new Uint8Array(32), uploadIdleTimeoutMs: 20, responseTimeoutMs: 200 });
		assert.equal(response.bodyText, "done");
	});
});

test("response and stalled upload timeouts destroy the socket", async () => {
	await withServer((req) => { req.resume(); }, async (url) => {
		const http = createLoopbackHttpAdapter(); assert.ok(http);
		await assert.rejects(http.request(url, { method: "POST", body: "hello", responseTimeoutMs: 20 }), /响应超时/);
	});
	await withServer((req) => { req.pause(); }, async (url) => {
		const http = createLoopbackHttpAdapter(); assert.ok(http);
		let reads = 0;
		const body = (async function* () { for (let i = 0; i < 16; i++) { reads++; yield new Uint8Array(4 * 1024 * 1024); } })();
		await assert.rejects(http.request(url, { method: "POST", body, contentLength: 64 * 1024 * 1024, uploadIdleTimeoutMs: 25 }), /上传停滞/);
		assert.ok(reads <= 2);
	});
});

test("redirect is surfaced without following the destination", async () => {
	let redirectedRequests = 0;
	await withServer((_req, res) => { redirectedRequests++; res.end("wrong"); }, async (destination) => {
		await withServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(307, { location: destination }); res.end(); }); }, async (url) => {
			const provider = new LocalOpenAICompatibleProvider(app("/unused"), config(`${url}/v1`), "", { files: fakeFiles(size) });
			await assert.rejects(provider.transcribe({ audioFile: audio() }), /重定向/);
		});
	});
	assert.equal(redirectedRequests, 0);
});

test("generic transport failures report unknown outcome and never retry POST", async () => {
	let calls = 0;
	const http: LocalLoopbackHttp = { async request() { calls++; throw new Error("connection lost"); } };
	const provider = new LocalOpenAICompatibleProvider(app("/unused"), config("http://127.0.0.1:9999/v1"), "", { http, files: fakeFiles(32) });
	await assert.rejects(provider.transcribe({ audioFile: audio(32) }), (error: unknown) => error instanceof Error && "code" in error && error.code === "result_unknown");
	assert.equal(calls, 1);
});

test("mobile module loading succeeds and desktop invocation returns a controlled error", async () => {
	Object.assign(globalThis, { window: { setTimeout, clearTimeout } });
	try {
		assert.equal(createLoopbackHttpAdapter(), null);
		const provider = new LocalOpenAICompatibleProvider(app("/unused"), config("http://127.0.0.1:9999/v1"), "");
		await assert.rejects(provider.transcribe({ audioFile: audio() }), /桌面版/);
	} finally { Object.assign(globalThis, { window: runtime }); }
});

test("desktop file identity detects same-size rewrite and path replacement; no out-of-vault links", async () => {
	await withAudio(16, async (root) => {
		const desktop = await createDesktopFiles(app(root)); assert.ok(desktop);
		const handle = await desktop.openVaultFile("audio.wav");
		try {
			await writeFile(path.join(root, "audio.wav"), new Uint8Array(16).fill(1));
			await assert.rejects(handle.readRange(0, 16), /修改/);
		} finally { await handle.close(); }
		const replacement = await desktop.openVaultFile("audio.wav");
		try {
			await rm(path.join(root, "audio.wav")); await writeFile(path.join(root, "audio.wav"), "replacement");
			await assert.rejects(replacement.identity(), /替换/);
		} finally { await replacement.close(); }
		await symlink(path.join(root, ".."), path.join(root, "outside"));
		await assert.rejects(desktop.openVaultFile("outside"), /Vault/);
		assert.ok((await stat(path.join(root, "audio.wav"))).size > 0);
	});
});

test("short source reads fail without sending a successful full multipart request", async () => {
	const http: LocalLoopbackHttp = { async request(_url, init) {
		assert.ok(init.body && typeof init.body === "object" && Symbol.asyncIterator in init.body);
		for await (const _chunk of init.body) { /* drain until source integrity check fails */ }
		return { status: 200, headers: {}, bodyText: '{"text":"wrong"}' };
	} };
	const broken: LocalDesktopFiles = { ...fakeFiles(1024), async openVaultFile(p) {
		return { ...await fakeFiles(1024).openVaultFile(p), async readRange() { return new Uint8Array(1); } };
	} };
	const provider = new LocalOpenAICompatibleProvider(app("/unused"), config("http://127.0.0.1:9999/v1"), "", { http, files: broken });
	await assert.rejects(provider.transcribe({ audioFile: audio(1024) }), /读取不完整/);
});

test("content-length is mandatory for streaming and oversized chunks are rejected", async () => {
	await withServer((req, res) => { req.resume(); req.on("end", () => res.end("ok")); }, async (url) => {
		const http = createLoopbackHttpAdapter(); assert.ok(http);
		const body = () => (async function* () { yield new Uint8Array(4 * 1024 * 1024 + 1); })();
		await assert.rejects(http.request(url, { method: "POST", body: body() }), /Content-Length/);
		await assert.rejects(http.request(url, { method: "POST", body: body(), contentLength: 4 * 1024 * 1024 + 1 }), /4 MiB/);
	});
});

test("connection deadline is separate from response deadline", async () => {
	class ConnectingRequest extends EventEmitter {
		destroyed = false;
		writableFinished = false;
		write() { return true; }
		end() { this.writableFinished = true; this.emit("finish"); }
		destroy(error?: Error) { this.destroyed = true; if (error) this.emit("error", error); this.emit("close"); return this; }
	}
	Object.assign(globalThis, { window: { ...runtime, require: () => ({ request: () => new ConnectingRequest() }) } });
	try {
		const http = createLoopbackHttpAdapter(); assert.ok(http);
		await assert.rejects(http.request("http://127.0.0.1:9/v1", { method: "GET", connectTimeoutMs: 10, responseTimeoutMs: 1000 }), /连接超时/);
	} finally { Object.assign(globalThis, { window: runtime }); }
});

test("temporarily unavailable MLX capability probe preserves recovery as network error", async () => {
	const checkpoint: LocalTranscriptionTaskResume = {
		protocol: 1, origin: "http://127.0.0.1:18081", clientRequestId: "request", jobId: "job", instanceId: "instance",
		sourcePath: "audio.wav", sourceSize: 1024, sourceMtimeMs: 123, sourceIdentity: "same", model: "custom-local-asr", language: "zh",
		configurationFingerprint: "config", confirmedOffset: 1024, phase: "transcribing"
	};
	let requests = 0;
	const http: LocalLoopbackHttp = { async request() { requests++; throw new Error("service offline"); } };
	const provider = new LocalOpenAICompatibleProvider(app("/unused"), config("http://127.0.0.1:18081/v1"), "", { http, files: fakeFiles(1024) });
	await assert.rejects(provider.transcribe({ audioFile: audio(1024), resumeLocalTask: checkpoint }), (error: unknown) => error instanceof Error && "code" in error && error.code === "network_error");
	assert.equal(requests, 1, "must not fall back to a new standard POST");
});

test("an early successful response cannot turn an incomplete upload into a successful transcript", async () => {
	await withServer((_req, res) => { res.end(JSON.stringify({ text: "premature" })); }, async (url) => {
		const provider = new LocalOpenAICompatibleProvider(app("/unused"), config(`${url}/v1`), "", { files: fakeFiles(size) });
		await assert.rejects(provider.transcribe({ audioFile: audio() }), (error: unknown) => error instanceof Error && "code" in error && error.code === "result_unknown");
	});
});

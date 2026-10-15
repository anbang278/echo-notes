import { LOCAL_UPLOAD_CHUNK_BYTES, parseLoopbackUrl, type LocalLoopbackHttp } from "./local-http";

/** Lazy desktop module loading keeps this module safe to import on mobile. */
export function createLoopbackHttpAdapter(): LocalLoopbackHttp | null {
	const runtime = typeof window === "undefined" ? undefined : window as unknown as { require?: (name: string) => unknown };
	if (typeof runtime?.require !== "function") return null;
	try {
		const http = runtime.require("http") as typeof import("http");
		const https = runtime.require("https") as typeof import("https");
		if (!http?.request || !https?.request) return null;
		return {
			request(target, init) {
				return new Promise((resolve, reject) => {
					let parsed: URL;
					try { parsed = parseLoopbackUrl(target); } catch (error) { reject(error instanceof Error ? error : new Error("本地服务地址无效。")); return; }
					if (init.signal?.aborted) { reject(new Error("本地请求已中断。")); return; }
					const body = init.body;
					const streaming = body !== undefined && typeof body === "object" && Symbol.asyncIterator in body;
					const bytes = streaming || body === undefined ? undefined
						: typeof body === "string" ? new TextEncoder().encode(body)
						: body instanceof Uint8Array ? body : new Uint8Array(body);
					const length = init.contentLength ?? bytes?.byteLength ?? 0;
					if (!Number.isSafeInteger(length) || length < 0 || (streaming && init.contentLength === undefined)) {
						reject(new Error("流式请求需要准确的 Content-Length。")); return;
					}
					const headers: Record<string, string> = {};
					for (const [key, value] of Object.entries(init.headers ?? {})) {
						if (!/^(?:content-length|transfer-encoding|host)$/i.test(key)) headers[key] = value;
					}
					if (body !== undefined) headers["Content-Length"] = String(length);
					const transport = parsed.protocol === "https:" ? https : http;
					const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
					const request = transport.request({
						hostname: hostname === "localhost" ? "127.0.0.1" : hostname,
						...(parsed.protocol === "https:" && hostname === "localhost" ? { servername: "localhost" } : {}),
						port: parsed.port || undefined, path: parsed.pathname, method: init.method, headers, agent: false
					});
					let settled = false;
					let responseStarted = false;
					let uploaded = 0;
					const timers = new Set<number>();
					const timer = (ms: number, message: string) => {
						const id = window.setTimeout(() => request.destroy(new Error(message)), ms);
						timers.add(id); return id;
					};
					const clear = (id: number | undefined) => {
						if (id !== undefined) { window.clearTimeout(id); timers.delete(id); }
					};
					const connect = timer(init.connectTimeoutMs ?? 10_000, "本地服务连接超时。");
					let idle: number | undefined;
					let responseTimer: number | undefined;
					const resetIdle = () => { clear(idle); idle = timer(init.uploadIdleTimeoutMs ?? 60_000, "音频上传停滞超时。"); };
					if (init.timeoutMs !== undefined) timer(init.timeoutMs, "本地服务请求超时。");
					const abort = () => request.destroy(new Error("本地请求已中断。"));
					const cleanup = () => {
						for (const id of timers) window.clearTimeout(id);
						timers.clear(); init.signal?.removeEventListener("abort", abort);
					};
					const fail = (error: unknown) => {
						if (settled) return;
						settled = true; cleanup(); reject(error instanceof Error ? error : new Error("本地服务请求失败。"));
					};
					init.signal?.addEventListener("abort", abort, { once: true });
					request.on("error", fail);
					request.on("socket", (socket) => {
						socket.once(parsed.protocol === "https:" ? "secureConnect" : "connect", () => { clear(connect); resetIdle(); });
					});
					request.once("finish", () => {
						clear(idle);
						if (responseTimer === undefined) responseTimer = timer(init.responseTimeoutMs ?? 30_000, "等待本地服务响应超时。");
					});
					request.on("response", (response) => {
						responseStarted = true; clear(connect); clear(idle);
						if (responseTimer === undefined) responseTimer = timer(init.responseTimeoutMs ?? 30_000, "等待本地服务响应超时。");
						// Reject redirects immediately: a server may close its socket without consuming the upload.
						if ((response.statusCode ?? 0) >= 300 && (response.statusCode ?? 0) < 400) {
							settled = true; cleanup();
							response.on("error", () => undefined);
							response.resume();
							resolve({ status: response.statusCode!, headers: {}, bodyText: "" });
							request.destroy();
							return;
						}
						// A peer may reject an upload early. Stop consuming the file immediately.
						const chunks: Uint8Array[] = [];
						let responseBytes = 0;
						response.on("data", (chunk: Uint8Array) => {
							responseBytes += chunk.byteLength;
							if (responseBytes > 16 * 1024 * 1024) { response.destroy(new Error("本地服务响应超过 16 MiB。")); return; }
							chunks.push(chunk);
						});
						response.on("error", fail);
						response.on("aborted", () => fail(new Error("本地服务响应中断。")));
						response.on("end", () => {
							if (settled) return;
							if ((response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300 && uploaded !== length) {
								fail(new Error("服务在完整上传前返回成功，结果未知。")); request.destroy(); return;
							}
							settled = true; cleanup();
							const responseHeaders: Record<string, string> = {};
							for (const [key, value] of Object.entries(response.headers)) {
								if (value !== undefined) responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
							}
							resolve({ status: response.statusCode ?? 0, headers: responseHeaders, bodyText: decodeResponse(chunks, responseBytes) });
							if (!request.writableFinished) request.destroy();
						});
					});
					const waitForDrain = () => new Promise<void>((done, failed) => {
						const finish = (error?: Error) => {
							request.removeListener("drain", drained); request.removeListener("error", errored);
							request.removeListener("response", drained); request.removeListener("close", drained);
							if (error) failed(error); else done();
						};
						const drained = () => finish();
						const errored = (error: Error) => finish(error);
						request.once("drain", drained); request.once("error", errored);
						request.once("response", drained); request.once("close", drained);
					});
					const upload = async () => {
						const write = async (chunk: Uint8Array) => {
							if (chunk.byteLength > LOCAL_UPLOAD_CHUNK_BYTES) throw new Error("单次上传块不能超过 4 MiB。");
							if (uploaded + chunk.byteLength > length) throw new Error("上传字节超过 Content-Length。");
							if (request.destroyed || init.signal?.aborted) throw new Error("本地请求已中断。");
							resetIdle();
							if (!request.write(chunk)) await waitForDrain();
							if (responseStarted || settled) return;
							resetIdle(); uploaded += chunk.byteLength; await init.onUploadProgress?.(uploaded);
						};
						if (streaming) {
							for await (const chunk of body) {
								if (responseStarted || settled) break;
								await write(chunk);
								if (responseStarted || settled) break;
							}
						} else if (bytes) { await write(bytes); }
						if (responseStarted || settled) return;
						if (uploaded !== length) throw new Error("上传字节不足 Content-Length。");
						request.end();
					};
					void upload().catch((error: unknown) => { fail(error); request.destroy(); });
				});
			}
		};
	} catch { return null; }
}

function decodeResponse(chunks: Uint8Array[], length: number): string {
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
	return new TextDecoder().decode(bytes);
}

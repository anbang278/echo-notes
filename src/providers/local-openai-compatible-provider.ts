import type { App } from "obsidian";
import { getAudioMimeType, isSupportedAudioFile } from "../audio/audio-detector";
import { captureLocalSource, createDesktopFiles, verifyLocalSource, type LocalDesktopFiles } from "../network/local-desktop-files";
import { createLoopbackHttpAdapter } from "../network/loopback-http-adapter";
import { parseLoopbackUrl, type LocalLoopbackHttp } from "../network/local-http";
import { createStreamingMultipart } from "../network/streaming-multipart";
import { validateLocalOpenAIBaseUrl, type OfflineTranscriptionProviderId, type TranscriptionConfig } from "../settings/settings";
import { acknowledgeLocalMlxResult, cancelLocalMlxTask, isEligibleLocalMlxEndpoint, LocalMlxCapabilityCache, normalizeLoopbackOrigin, runLocalMlxJob, throwIfAborted } from "./local-mlx-jobs";
import { createHttpTranscriptionError, TranscriptionError, type LocalTaskControlResult, type LocalTranscriptionTaskResume, type TranscriptionInput, type TranscriptionProvider, type TranscriptionResult } from "./transcription-provider";

interface LocalProviderDependencies {
	http?: LocalLoopbackHttp;
	files?: LocalDesktopFiles;
	capabilityCache?: LocalMlxCapabilityCache;
}

/** Dedicated desktop provider: old LM Studio/Ollama semantics remain unchanged. */
export class LocalOpenAICompatibleProvider implements TranscriptionProvider {
	readonly id = "local-openai-compatible";
	readonly name = "本地模型（OpenAI 兼容）";
	private readonly capabilities: LocalMlxCapabilityCache;

	constructor(private app: App, private settings: TranscriptionConfig<OfflineTranscriptionProviderId>, private apiKey: string, private deps: LocalProviderDependencies = {}) {
		this.capabilities = deps.capabilityCache ?? new LocalMlxCapabilityCache();
	}

	private http(): LocalLoopbackHttp {
		const http = this.deps.http ?? createLoopbackHttpAdapter();
		if (!http) throw new TranscriptionError("unsupported_audio", "本地模型长音频转写仅支持桌面版 Obsidian 与本地文件系统 Vault。");
		return http;
	}

	async transcribe(input: TranscriptionInput): Promise<TranscriptionResult> {
		throwIfAborted(input.signal);
		const invalid = validateLocalOpenAIBaseUrl(this.settings.baseUrl);
		if (invalid) throw new TranscriptionError("api_error", invalid);
		if (!this.settings.model.trim()) throw new TranscriptionError("invalid_model", "请填写本地转写模型名称。");
		if (!isSupportedAudioFile(input.audioFile)) throw new TranscriptionError("unsupported_format", `不支持的音频格式：${input.audioFile.extension}`);
		const http = this.http();
		const files = this.deps.files ?? await createDesktopFiles(this.app);
		if (!files) throw new TranscriptionError("unsupported_audio", "本地模型长音频转写需要桌面版的本地文件系统 Vault。");
		const config = { ...this.settings, language: input.language ?? this.settings.language ?? "auto" };
		const eligible = isEligibleLocalMlxEndpoint(config.baseUrl);
		const origin = normalizeLoopbackOrigin(config.baseUrl);
		const previous = input.resumeLocalTask;
		if (previous && (previous.origin !== origin || previous.model !== config.model || previous.language !== config.language.toLowerCase()
			|| (input.configurationFingerprint !== undefined && previous.configurationFingerprint !== input.configurationFingerprint))) {
			throw new TranscriptionError("local_configuration_changed", "本地任务的转写配置已变化，请切回原配置继续，或取消旧任务后重新转写。");
		}
		const capabilities = eligible ? await this.capabilities.probe(http, origin, config.model, input.signal, this.apiKey) : null;
		throwIfAborted(input.signal);
		if (input.resumeLocalTask && !capabilities) {
			throw new TranscriptionError("network_error", "暂时无法核验原本地任务服务；恢复信息已保留，请恢复原服务后重试。");
		}
		if (capabilities) {
			const result = await runLocalMlxJob(input.audioFile, config, {
				http, files, capabilities, origin, apiKey: this.apiKey,
				configurationFingerprint: input.configurationFingerprint,
				onProgress: input.onProgress, onCheckpoint: input.onLocalCheckpoint,
				signal: input.signal, checkpoint: input.resumeLocalTask
			});
			return { ...result, provider: this.id, model: config.model, configurationFingerprint: input.configurationFingerprint };
		}
		const handle = await files.openVaultFile(input.audioFile.path);
		try {
			const source = await captureLocalSource(handle);
			const multipart = createStreamingMultipart(handle, source, {
				model: config.model, language: config.language, fileName: input.audioFile.name,
				mediaType: getAudioMimeType(input.audioFile), signal: input.signal
			});
			await input.onProgress?.({ type: "local-asr-progress", phase: "uploading", uploadedBytes: 0, totalBytes: source.sourceSize });
			throwIfAborted(input.signal);
			const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/audio/transcriptions`;
			parseLoopbackUrl(endpoint);
			let response;
			try {
				response = await http.request(endpoint, {
					method: "POST", headers: { "Content-Type": multipart.contentType,
						...(this.apiKey.trim() ? { Authorization: `Bearer ${this.apiKey.trim()}` } : {}) },
					body: multipart.body, contentLength: multipart.contentLength,
					connectTimeoutMs: 10_000, uploadIdleTimeoutMs: 60_000, responseTimeoutMs: 12 * 3600 * 1000, signal: input.signal,
					onUploadProgress: async (bytes) => {
						const uploadedBytes = Math.min(source.sourceSize, Math.max(0, bytes - multipart.headerBytes));
						await input.onProgress?.({ type: "local-asr-progress", phase: "uploading", uploadedBytes, totalBytes: source.sourceSize });
						if (bytes === multipart.contentLength) await input.onProgress?.({ type: "local-asr-progress", phase: "waiting", uploadedBytes, totalBytes: source.sourceSize });
					}
				});
			} catch (error) {
				if (error instanceof TranscriptionError && error.code === "source_changed") throw error;
				// A standard POST has no job identity: retrying might perform duplicate inference.
				throw new TranscriptionError("result_unknown", "本地标准接口连接中断，服务端转写结果未知；请核查服务后再手动重试。");
			}
			throwIfAborted(input.signal);
			if (response.status >= 300 && response.status < 400) throw new TranscriptionError("api_error", `本地服务返回重定向（HTTP ${response.status}），已拒绝跟随。`);
			if (response.status < 200 || response.status >= 300) throw createHttpTranscriptionError(this.name, response.status, response.bodyText);
			await verifyLocalSource(handle, source);
			let data: unknown;
			try { data = JSON.parse(response.bodyText); } catch { /* classified below */ }
			if (!data || typeof data !== "object" || !("text" in data) || typeof data.text !== "string") {
				throw new TranscriptionError("invalid_response", "本地服务响应中缺少 text 字段。");
			}
			await input.onProgress?.({ type: "local-asr-progress", phase: "saving" });
			throwIfAborted(input.signal);
			return { text: data.text, provider: this.id, model: config.model,
				traceId: response.headers["x-request-id"], configurationFingerprint: input.configurationFingerprint };
		} finally { await handle.close(); }
	}

	async cancelLocalTask(task: LocalTranscriptionTaskResume): Promise<LocalTaskControlResult> {
		return cancelLocalMlxTask(this.http(), task, this.apiKey);
	}

	async acknowledgeLocalResult(task: LocalTranscriptionTaskResume): Promise<LocalTaskControlResult> {
		return acknowledgeLocalMlxResult(this.http(), task, this.apiKey);
	}
}

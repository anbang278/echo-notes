import { requestUrl } from "obsidian";
import { buildAnalysisMessages } from "./analysis-templates";
import { parseRecordingSummaryResponse } from "./recording-summary";
import { AnalysisError, type AnalysisInput, type AnalysisResult, type ChunkedAnalysisProvider } from "./analysis-provider";
import { createAnalysisDeadline, waitForAnalysisResponse } from "./analysis-timeout";
import { createChunkAnalysisInput, createSynthesisAnalysisInput } from "./analysis-stage-prompts";
import { OPENAI_OFFICIAL_BASE_URL, isOpenAIOfficialBaseUrl } from "./openai-model-catalog";
import {
	buildOpenAIOfficialAnalysisRequest,
	createOpenAIOfficialHttpError,
	parseOpenAIOfficialAnalysisResponse
} from "./openai-official-protocol";
import type { EchoNotesSettings } from "../settings/settings";
import { sanitizeSensitiveText } from "../security/redaction";

export class OpenAIOfficialAnalysisProvider implements ChunkedAnalysisProvider {
	readonly id = "openai-official";
	readonly name = "OpenAI 官方";
	private readonly deadlineAt = createAnalysisDeadline();
	private readonly model: string;
	private readonly baseUrl: string;
	private readonly apiKey: string;

	constructor(settings: EchoNotesSettings, apiKey: string) {
		this.model = settings.analysisModel;
		this.baseUrl = settings.analysisBaseUrl;
		this.apiKey = apiKey.trim();
	}

	async analyze(input: AnalysisInput): Promise<AnalysisResult> {
		return this.requestAnalysis(input);
	}

	async analyzeChunk(input: AnalysisInput, chunkIndex: number, totalChunks: number): Promise<AnalysisResult> {
		return this.requestAnalysis(createChunkAnalysisInput(input, chunkIndex, totalChunks));
	}

	async synthesizeChunks(input: AnalysisInput, chunkResults: AnalysisResult[]): Promise<AnalysisResult> {
		const result = await this.requestAnalysis(createSynthesisAnalysisInput(input, chunkResults));
		const traceIds = [...chunkResults.map((chunk) => chunk.traceId), result.traceId]
			.filter((traceId): traceId is string => Boolean(traceId));
		return { ...result, traceId: Array.from(new Set(traceIds)).join(", ") || undefined };
	}

	private async requestAnalysis(input: AnalysisInput): Promise<AnalysisResult> {
		if (!this.apiKey) {
			throw new AnalysisError("missing_api_key", "请先在 Echo Notes 设置中配置 OpenAI 官方分析 API Key。");
		}
		if (!isOpenAIOfficialBaseUrl(this.baseUrl)) {
			throw new AnalysisError("api_error", `OpenAI 官方分析必须使用 ${OPENAI_OFFICIAL_BASE_URL}，请重新选择分析服务商。`);
		}
		const request = buildOpenAIOfficialAnalysisRequest(this.model, this.apiKey, buildAnalysisMessages(input));
		try {
			const startedAt = Date.now();
			input.diagnostics?.event("request", "analysis-request-started", {
				protocol: "responses",
				endpoint: `${OPENAI_OFFICIAL_BASE_URL}/responses`,
				provider: this.id,
				model: this.model,
				inputCharacters: input.transcriptText.length
			});
			const response = await waitForAnalysisResponse(() => requestUrl({
				url: `${OPENAI_OFFICIAL_BASE_URL}/responses`,
				method: "POST",
				throw: false,
				headers: request.headers,
				body: JSON.stringify(request.body)
			}), this.deadlineAt);
			const traceKey = Object.keys(response.headers).find((key) => key.toLowerCase() === "x-request-id");
			const traceId = traceKey ? sanitizeSensitiveText(response.headers[traceKey], 200) : undefined;
			input.diagnostics?.event("request", "analysis-request-finished", {
				status: response.status,
				traceId,
				durationMs: Date.now() - startedAt
			});
			const succeeded = response.status >= 200 && response.status < 300;
			let data: unknown;
			try {
				data = response.json;
			} catch {
				if (succeeded) {
					throw new AnalysisError("invalid_response", "OpenAI 官方分析返回了无法解析的结果，请稍后重试。", traceId);
				}
			}
			if (!succeeded) {
				throw createOpenAIOfficialHttpError(response.status, data, traceId);
			}
			const text = parseOpenAIOfficialAnalysisResponse(data, traceId);
			const parsed = parseRecordingSummaryResponse(text, input.includeRecordingSummary);
			if (!parsed.text.trim()) {
				throw new AnalysisError("invalid_response", "OpenAI 官方分析响应中缺少分析正文，请稍后重试。", traceId);
			}
			return { ...parsed, provider: this.id, model: request.body.model, traceId };
		} catch (error) {
			// Transport errors may contain a request body or headers, so expose only a fixed message.
			const failure = error instanceof AnalysisError
				? error
				: new AnalysisError("network_error", "OpenAI 官方分析网络调用失败，请检查网络连接后重试。");
			input.diagnostics?.event("result", "analysis-request-failed", { error: failure.message, code: failure.code });
			throw failure;
		}
	}
}

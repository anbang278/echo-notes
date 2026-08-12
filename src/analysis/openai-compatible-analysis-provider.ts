import { requestUrl } from "obsidian";
import { buildAnalysisMessages } from "./analysis-templates";
import { AnalysisError, type AnalysisInput, type AnalysisProvider, type AnalysisResult } from "./analysis-provider";
import { createAnalysisDeadline, waitForAnalysisResponse } from "./analysis-timeout";
import { createChunkAnalysisInput, createSynthesisAnalysisInput } from "./analysis-stage-prompts";
import { ANALYSIS_PROVIDER_LABELS, type EchoNotesSettings } from "../settings/settings";
import { sanitizeSensitiveText } from "../security/redaction";

interface OpenAICompatibleChatResponse {
	choices?: Array<{
		message?: {
			content?: string;
		};
	}>;
}

export class OpenAICompatibleAnalysisProvider implements AnalysisProvider {
	id: string;
	name: string;

	private settings: EchoNotesSettings;
	private apiKey: string;
	private deadlineAt: number;

	constructor(settings: EchoNotesSettings, apiKey: string) {
		this.settings = settings;
		this.apiKey = apiKey;
		this.id = settings.analysisProvider;
		this.name = ANALYSIS_PROVIDER_LABELS[settings.analysisProvider] ?? settings.analysisProvider;
		this.deadlineAt = createAnalysisDeadline();
	}

	async analyze(input: AnalysisInput): Promise<AnalysisResult> {
		return this.requestAnalysis(input);
	}

	async analyzeChunk(input: AnalysisInput, chunkIndex: number, totalChunks: number): Promise<AnalysisResult> {
		return this.requestAnalysis(createChunkAnalysisInput(input, chunkIndex, totalChunks));
	}

	async synthesizeChunks(input: AnalysisInput, chunkResults: AnalysisResult[]): Promise<AnalysisResult> {
		const result = await this.requestAnalysis(createSynthesisAnalysisInput(input, chunkResults));
		return {
			...result,
			traceId: uniqueTraceIds([...chunkResults.map((chunk) => chunk.traceId), result.traceId])
		};
	}

	private async requestAnalysis(input: AnalysisInput): Promise<AnalysisResult> {
		const apiKey = this.apiKey.trim();
		if (!apiKey) {
			throw new AnalysisError("missing_api_key", `请先在 Echo Notes 设置中配置 ${this.name} 分析 API Key。`);
		}

		const messages = buildAnalysisMessages(input);
		const body = {
			model: this.settings.analysisModel,
			temperature: 0.2,
			stream: false,
			messages: [
				{
					role: "system",
					content: messages.system
				},
				{
					role: "user",
					content: messages.user
				}
			]
		};

		try {
			const requestStartedAt = Date.now();
			input.diagnostics?.event("request", "analysis-request-started", {
				protocol: "chat-completions",
				endpoint: `${this.settings.analysisBaseUrl.replace(/\/+$/, "")}/chat/completions`,
				provider: this.id,
				model: this.settings.analysisModel,
				inputCharacters: input.transcriptText.length
			});
			const response = await waitForAnalysisResponse(
				() => requestUrl({
					url: `${this.settings.analysisBaseUrl.replace(/\/+$/, "")}/chat/completions`,
					method: "POST",
					throw: false,
					headers: {
						Authorization: `Bearer ${apiKey}`,
						"Content-Type": "application/json"
					},
					body: JSON.stringify(body)
				}),
				this.deadlineAt
			);

			const traceId = readTraceId(response.headers);
			input.diagnostics?.event("request", "analysis-request-finished", {
				status: response.status,
				traceId,
				durationMs: Date.now() - requestStartedAt
			});
			if (response.status < 200 || response.status >= 300) {
				throw new AnalysisError(
					"api_error",
					`${this.name} 分析 API 请求失败：HTTP ${response.status} ${sanitizeSensitiveText(response.text)}`,
					traceId
				);
			}

			const data = response.json as OpenAICompatibleChatResponse;
			const text = data?.choices?.[0]?.message?.content;
			if (typeof text !== "string" || !text.trim()) {
				throw new AnalysisError("invalid_response", `${this.name} 分析 API 响应中缺少 choices[0].message.content。`, traceId);
			}

			return {
				text,
				provider: this.id,
				model: this.settings.analysisModel,
				traceId,
				raw: data
			};
		} catch (error) {
			input.diagnostics?.event("result", "analysis-request-failed", {
				error: error instanceof Error ? error.message : String(error)
			});
			if (error instanceof AnalysisError) {
				throw error;
			}

			const message = sanitizeSensitiveText(error instanceof Error ? error.message : String(error));
			throw new AnalysisError("network_error", `${this.name} 分析 API 调用失败：${message}`);
		}
	}
}

function uniqueTraceIds(traceIds: Array<string | undefined>): string | undefined {
	const values = Array.from(new Set(traceIds.map((value) => value?.trim()).filter((value): value is string => Boolean(value))));
	return values.length > 0 ? values.join(", ") : undefined;
}

function readTraceId(headers: Record<string, string>): string | undefined {
	const traceHeaders = ["x-request-id", "x-ark-request-id", "x-tt-logid", "x-ds-trace-id", "openai-processing-ms"];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

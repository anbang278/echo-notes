import { requestUrl } from "obsidian";
import { buildAnalysisMessages } from "./analysis-templates";
import { AnalysisError, type AnalysisInput, type AnalysisProvider, type AnalysisResult } from "./analysis-provider";
import { createAnalysisDeadline, waitForAnalysisResponse } from "./analysis-timeout";
import { createChunkAnalysisInput, createSynthesisAnalysisInput } from "./analysis-stage-prompts";
import {
	ANALYSIS_PROVIDER_LABELS,
	OPENCODE_GO_ANALYSIS_BASE_URL,
	type EchoNotesSettings
} from "../settings/settings";
import { sanitizeSensitiveText } from "../security/redaction";
import { buildOpenCodeGoAnalysisRequest, parseOpenCodeGoAnalysisResponse } from "./opencode-go-protocol";

export class OpenCodeGoAnalysisProvider implements AnalysisProvider {
	id = "opencode-go";
	name = ANALYSIS_PROVIDER_LABELS["opencode-go"];

	private settings: EchoNotesSettings;
	private apiKey: string;
	private deadlineAt: number;

	constructor(settings: EchoNotesSettings, apiKey: string) {
		this.settings = settings;
		this.apiKey = apiKey;
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
		try {
			const request = buildOpenCodeGoAnalysisRequest(this.settings.analysisModel, apiKey, messages);
			const response = await waitForAnalysisResponse(
				() => requestUrl({
					url: `${OPENCODE_GO_ANALYSIS_BASE_URL}/${request.path}`,
					method: "POST",
					throw: false,
					headers: request.headers,
					body: JSON.stringify(request.body)
				}),
				this.deadlineAt
			);

			const traceId = readTraceId(response.headers);
			if (response.status < 200 || response.status >= 300) {
				throw new AnalysisError(
					"api_error",
					`${this.name} 分析 API 请求失败：HTTP ${response.status} ${sanitizeSensitiveText(response.text)}`,
					traceId
				);
			}

			const text = parseOpenCodeGoAnalysisResponse(this.settings.analysisModel, response.json);
			if (!text) {
				throw new AnalysisError("invalid_response", `${this.name} 分析 API 响应中缺少文本内容。`, traceId);
			}

			return {
				text,
				provider: this.id,
				model: this.settings.analysisModel,
				traceId,
				raw: response.json
			};
		} catch (error) {
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
	const traceHeaders = [
		"x-request-id",
		"request-id",
		"anthropic-request-id",
		"x-ark-request-id",
		"x-tt-logid",
		"x-ds-trace-id",
		"openai-processing-ms"
	];
	const foundKey = Object.keys(headers).find((key) => traceHeaders.includes(key.toLowerCase()));
	return foundKey ? headers[foundKey] : undefined;
}

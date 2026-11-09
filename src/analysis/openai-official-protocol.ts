import { AnalysisError } from "./analysis-provider";
import { getOpenAIOfficialModelOption } from "./openai-model-catalog";

export interface OpenAIOfficialAnalysisRequest {
	headers: Record<string, string>;
	body: {
		model: string;
		instructions: string;
		input: string;
		stream: false;
		store: false;
		service_tier: "default";
		reasoning: { effort: "medium" };
	};
}

export function buildOpenAIOfficialAnalysisRequest(
	model: string,
	apiKey: string,
	messages: { system: string; user: string }
): OpenAIOfficialAnalysisRequest {
	const option = getOpenAIOfficialModelOption(model);
	if (!option) {
		throw new AnalysisError("api_error", "请从 OpenAI 官方分析模型下拉框选择支持的模型。");
	}
	return {
		headers: {
			Authorization: `Bearer ${apiKey.trim()}`,
			"Content-Type": "application/json"
		},
		body: {
			model: option.id,
			instructions: messages.system,
			input: messages.user,
			stream: false,
			store: false,
			service_tier: "default",
			reasoning: { effort: "medium" }
		}
	};
}

export function parseOpenAIOfficialAnalysisResponse(data: unknown, traceId?: string): string {
	if (!isRecord(data) || data.status !== "completed" || data.error != null || !Array.isArray(data.output)) {
		throw new AnalysisError("invalid_response", "OpenAI 官方分析未返回完整结果，请稍后重试。", traceId);
	}
	const text: string[] = [];
	for (const item of data.output) {
		if (!isRecord(item) || item.type !== "message") {
			continue;
		}
		if (item.role !== "assistant" || item.status !== "completed" || !Array.isArray(item.content)) {
			throw new AnalysisError("invalid_response", "OpenAI 官方分析消息未完成，请稍后重试。", traceId);
		}
		for (const part of item.content) {
			if (!isRecord(part)) {
				continue;
			}
			if (part.type === "refusal") {
				throw new AnalysisError("invalid_response", "OpenAI 官方模型拒绝了本次分析，请检查输入内容或调整分析模板。", traceId);
			}
			if (part.type === "output_text" && typeof part.text === "string" && part.text.trim()) {
				text.push(part.text);
			}
		}
	}
	const result = text.join("\n").trim();
	if (!result) {
		throw new AnalysisError("invalid_response", "OpenAI 官方分析响应中缺少分析正文，请稍后重试。", traceId);
	}
	return result;
}

export function createOpenAIOfficialHttpError(status: number, data: unknown, traceId?: string): AnalysisError {
	let detail = "请稍后重试，并使用请求 ID 排查服务状态。";
	if (status === 401) {
		detail = "请检查 OpenAI 官方分析 API Key 是否有效。";
	} else if (status === 403) {
		detail = "请检查 OpenAI 项目和当前模型的访问权限。";
	} else if (status === 404) {
		detail = "请检查当前 OpenAI 模型是否仍可用，以及项目是否具备访问权限。";
	} else if (status === 429) {
		const error = isRecord(data) && isRecord(data.error) ? data.error : undefined;
		detail = error?.code === "insufficient_quota" || error?.type === "insufficient_quota"
			? "请检查 OpenAI 账户余额和项目配额，再重新分析。"
			: "OpenAI 请求已被限流，请稍后重试并检查项目速率限制。";
	} else if (status === 400) {
		detail = "请检查当前模型的可用性和分析输入，再重新分析。";
	}
	return new AnalysisError("api_error", `OpenAI 官方分析请求失败，HTTP ${status}。${detail}`, traceId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

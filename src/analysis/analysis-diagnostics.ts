import { isInsecureRemoteBaseUrl } from "../security/upload-preview";
import {
	AGENTPLAN_ANALYSIS_BASE_URL,
	AGENTPLAN_ANALYSIS_MODELS,
	ANALYSIS_PROVIDER_LABELS,
	OPENCODE_GO_ANALYSIS_BASE_URL,
	OPENCODE_GO_ANALYSIS_MODELS,
	isAnalysisProviderId,
	type EchoNotesSettings
} from "../settings/settings";

export type AnalysisDiagnosticSeverity = "error" | "warning" | "info";

export interface AnalysisDiagnosticItem {
	severity: AnalysisDiagnosticSeverity;
	title: string;
	detail: string;
}

export interface AnalysisDiagnosticResult {
	providerLabel: string;
	canAttemptAnalysis: boolean;
	items: AnalysisDiagnosticItem[];
}

export function diagnoseAnalysisProviderSettings(
	settings: Pick<EchoNotesSettings, "analysisProvider" | "analysisBaseUrl" | "analysisModel">,
	apiKey: string,
	estimatedCharacters?: number
): AnalysisDiagnosticResult {
	const providerId = isAnalysisProviderId(settings.analysisProvider) ? settings.analysisProvider : "custom-openai-compatible";
	const items: AnalysisDiagnosticItem[] = [];
	const baseUrl = settings.analysisBaseUrl.trim();
	const model = settings.analysisModel.trim();

	if (!apiKey.trim()) {
		items.push({ severity: "error", title: "分析 API Key 缺失", detail: "请先配置当前分析服务商的 API Key。" });
	}
	if (!baseUrl) {
		items.push({ severity: "error", title: "分析 Base URL 缺失", detail: "请填写分析服务商的基础地址。" });
	} else if (!isValidHttpUrl(baseUrl)) {
		items.push({ severity: "error", title: "分析 Base URL 格式无效", detail: "地址必须以 http:// 或 https:// 开头。" });
	} else if (/example\.(com|org|net)/i.test(baseUrl)) {
		items.push({ severity: "error", title: "分析 Base URL 仍是示例地址", detail: "请替换为真实分析服务商地址。" });
	} else if (isInsecureRemoteBaseUrl(baseUrl)) {
		items.push({ severity: "error", title: "分析地址使用未加密 HTTP", detail: "远程分析地址必须使用 HTTPS；localhost 和局域网地址请确认后再使用。" });
	}
	if (!model) {
		items.push({ severity: "error", title: "分析模型缺失", detail: "请填写分析模型名称。" });
	}
	if (providerId === "volcengine-agentplan") {
		if (baseUrl && normalizeBaseUrl(baseUrl) !== AGENTPLAN_ANALYSIS_BASE_URL) {
			items.push({
				severity: "error",
				title: "AgentPlan 分析地址不正确",
				detail: `必须使用套餐专属地址 ${AGENTPLAN_ANALYSIS_BASE_URL}；普通方舟地址不会抵扣 AgentPlan 套餐额度。`
			});
		}
		const selectedModel = AGENTPLAN_ANALYSIS_MODELS.find((option) => option.id === model);
		if (model && !selectedModel) {
			items.push({
				severity: "warning",
				title: "模型不在当前 AgentPlan 清单中",
				detail: "该模型可能是后续新增型号，也可能无法使用；请以 AgentPlan 套餐页面的最新文本模型清单为准。"
			});
		}
		if (selectedModel?.preview) {
			items.push({
				severity: "warning",
				title: "当前模型属于尝鲜体验版",
				detail: "官方提示高峰期可能出现访问拥堵或限流；纪要分析失败时可切换豆包 Seed 系列模型。"
			});
		}
		if (selectedModel?.minimumPlan === "Medium") {
			items.push({
				severity: "warning",
				title: "当前模型需要 Medium 及以上套餐",
				detail: "Kimi K3 不包含在 AgentPlan Small 套餐中，请确认当前套餐档位。"
			});
		}
		items.push({
			severity: "info",
			title: "AgentPlan 专属凭证",
			detail: "分析必须使用 AgentPlan 专属 API Key；实时转写与分析密钥在 Echo Notes 中按用途隔离保存。"
		});
	}
	if (providerId === "opencode-go") {
		if (baseUrl && normalizeBaseUrl(baseUrl) !== OPENCODE_GO_ANALYSIS_BASE_URL) {
			items.push({
				severity: "error",
				title: "OpenCode Go 分析地址不正确",
				detail: `必须使用官方基础地址 ${OPENCODE_GO_ANALYSIS_BASE_URL}；模型会自动路由到对应接口。`
			});
		}
		if (model && !OPENCODE_GO_ANALYSIS_MODELS.some((option) => option.id === model)) {
			items.push({
				severity: "error",
				title: "模型不在当前 OpenCode Go 清单中",
				detail: "请从设置页下拉框选择官方文档当前列出的 OpenCode Go 模型。"
			});
		}
		items.push({
			severity: "info",
			title: "OpenCode Go 订阅凭证",
			detail: "请先订阅 OpenCode Go 并使用对应 API Key；密钥在 Echo Notes 中按服务商与用途隔离保存。"
		});
	}
	if (estimatedCharacters !== undefined && estimatedCharacters > 120000) {
		items.push({ severity: "warning", title: "转写稿可能过长", detail: `当前约 ${estimatedCharacters} 个字符，单次分析可能超出服务商上下文限制，建议启用分块分析。` });
	}
	if (estimatedCharacters !== undefined && estimatedCharacters > 0) {
		items.push({
			severity: "info",
			title: "分析规模估算",
			detail: `当前约 ${estimatedCharacters} 个字符；实际调用次数取决于长文本分块设置。`
		});
	}
	if (items.length === 0) {
		items.push({ severity: "info", title: "分析配置未发现阻塞问题", detail: "这是本地检查，不会调用服务商。" });
	}

	return {
		providerLabel: ANALYSIS_PROVIDER_LABELS[providerId] ?? settings.analysisProvider,
		canAttemptAnalysis: !items.some((item) => item.severity === "error"),
		items
	};
}

function isValidHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function normalizeBaseUrl(value: string): string {
	return value.trim().replace(/\/+$/, "");
}

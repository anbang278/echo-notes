import { isInsecureRemoteBaseUrl } from "../security/upload-preview";
import { ANALYSIS_PROVIDER_LABELS, isAnalysisProviderId, type EchoNotesSettings } from "../settings/settings";

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
		items.push({ severity: "error", title: "分析 API Key 缺失", detail: "请先配置当前分析 Provider 的 API Key。" });
	}
	if (!baseUrl) {
		items.push({ severity: "error", title: "分析 Base URL 缺失", detail: "请填写分析 Provider 的基础地址。" });
	} else if (!isValidHttpUrl(baseUrl)) {
		items.push({ severity: "error", title: "分析 Base URL 格式无效", detail: "地址必须以 http:// 或 https:// 开头。" });
	} else if (/example\.(com|org|net)/i.test(baseUrl)) {
		items.push({ severity: "error", title: "分析 Base URL 仍是示例地址", detail: "请替换为真实分析 Provider 地址。" });
	} else if (isInsecureRemoteBaseUrl(baseUrl)) {
		items.push({ severity: "error", title: "分析地址使用未加密 HTTP", detail: "远程分析地址必须使用 HTTPS；localhost 和局域网地址请确认后再使用。" });
	}
	if (!model) {
		items.push({ severity: "error", title: "分析模型缺失", detail: "请填写分析模型名称。" });
	}
	if (estimatedCharacters !== undefined && estimatedCharacters > 120000) {
		items.push({ severity: "warning", title: "转写稿可能过长", detail: `当前约 ${estimatedCharacters} 个字符，单次分析可能超出 Provider 上下文限制，建议启用分块分析。` });
	}
	if (estimatedCharacters !== undefined && estimatedCharacters > 0) {
		items.push({
			severity: "info",
			title: "分析规模估算",
			detail: `当前约 ${estimatedCharacters} 个字符；实际调用次数取决于长文本分块设置。`
		});
	}
	if (items.length === 0) {
		items.push({ severity: "info", title: "分析配置未发现阻塞问题", detail: "这是本地检查，不会调用 Provider。" });
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

import { isInsecureRemoteBaseUrl } from "../security/upload-preview";
import type { EchoNotesSettings } from "../settings/settings";
import { PROVIDER_LABELS, isProviderId } from "../settings/settings";
import { getTranscriptionProviderCapability } from "./provider-capabilities";

export type ProviderDiagnosticSeverity = "error" | "warning" | "info";

export interface ProviderDiagnosticItem {
	severity: ProviderDiagnosticSeverity;
	title: string;
	detail: string;
}

export interface ProviderDiagnosticResult {
	providerLabel: string;
	canAttemptTranscription: boolean;
	items: ProviderDiagnosticItem[];
}

export function diagnoseTranscriptionProviderSettings(
	settings: Pick<EchoNotesSettings, "provider" | "baseUrl" | "model" | "language">,
	apiKey: string
): ProviderDiagnosticResult {
	const items: ProviderDiagnosticItem[] = [];
	const providerId = isProviderId(settings.provider) ? settings.provider : "custom-openai-compatible";
	const providerLabel = PROVIDER_LABELS[providerId] ?? settings.provider;
	const capability = getTranscriptionProviderCapability(providerId);
	const trimmedApiKey = apiKey.trim();
	const trimmedBaseUrl = settings.baseUrl.trim();
	const trimmedModel = settings.model.trim();

	if (!trimmedApiKey) {
		items.push({
			severity: "error",
			title: "API Key 缺失",
			detail: "请先配置当前转写 Provider 的 API Key。API Key 会保存到 Obsidian SecretStorage。"
		});
	}

	if (!trimmedBaseUrl) {
		items.push({
			severity: "error",
			title: "Base URL 缺失",
			detail: "请填写当前转写 Provider 的 Base URL。"
		});
	} else if (!isValidHttpUrl(trimmedBaseUrl)) {
		items.push({
			severity: "error",
			title: "Base URL 格式无效",
			detail: "Base URL 必须是 http:// 或 https:// 开头的有效地址。"
		});
	} else {
		if (/example\.com/i.test(trimmedBaseUrl)) {
			items.push({
				severity: "error",
				title: "Base URL 仍是示例地址",
				detail: "请把示例地址替换成真实 Provider 地址，否则无法完成转写。"
			});
		}

		if (isInsecureRemoteBaseUrl(trimmedBaseUrl)) {
			items.push({
				severity: "error",
				title: "Base URL 使用未加密 HTTP",
				detail: "该地址不是本地地址，禁止通过未加密连接发送音频。请改用 HTTPS。"
			});
		}
	}

	if (!trimmedModel) {
		items.push({
			severity: "error",
			title: "模型缺失",
			detail: "请填写用于音频转写的模型名称。"
		});
	} else if (capability.recommendedModels.length > 0 && !capability.recommendedModels.includes(trimmedModel)) {
		items.push({
			severity: "info",
			title: "模型不在推荐列表中",
			detail: `当前模型为 ${trimmedModel}；该 Provider 推荐模型：${capability.recommendedModels.join("、")}。如果你确认 Provider 支持当前模型，可以忽略此提示。`
		});
	}

	if (settings.language && settings.language !== "auto" && !capability.supportsLanguage) {
		items.push({
			severity: "warning",
			title: "当前 Provider 不支持语言参数",
			detail: "默认转写语言不会传给当前 Provider，实际仍由模型自动识别。建议保持 auto，或切换到支持语言参数的 Provider。"
		});
	}

	if (capability.endpointShape === "openai-audio") {
		items.push({
			severity: "info",
			title: "OpenAI-compatible 音频端点",
			detail: "插件会调用 {Base URL}/audio/transcriptions。并非所有 OpenAI-compatible Provider 都实现了音频转写接口。"
		});
	}

	if (!capability.supportsChunking) {
		items.push({
			severity: "info",
			title: "长音频分段暂不支持",
			detail: "该 Provider 当前不会自动分段。超过能力表限制的大文件会在上传前被阻止。"
		});
	}

	if (items.length === 0) {
		items.push({
			severity: "info",
			title: "基础配置未发现明显问题",
			detail: "这是本地配置自检，不会上传音频，也不会真实调用 Provider。"
		});
	}

	return {
		providerLabel,
		canAttemptTranscription: !items.some((item) => item.severity === "error"),
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

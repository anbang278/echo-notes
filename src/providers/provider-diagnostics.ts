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

export interface ProviderDiagnosticOptions {
	isMobile?: boolean;
}

export function diagnoseTranscriptionProviderSettings(
	settings: Pick<EchoNotesSettings, "provider" | "baseUrl" | "model" | "language">,
	apiKey: string,
	options: ProviderDiagnosticOptions = {}
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

	if (providerId === "volcengine-agentplan" && options.isMobile) {
		items.push({
			severity: "error",
			title: "AgentPlan 仅支持桌面端",
			detail: "Obsidian 移动端无法在 WebSocket 握手阶段写入 AgentPlan 鉴权请求头，请在桌面端使用该 Provider。"
		});
	}

	if (!trimmedBaseUrl) {
		items.push({
			severity: "error",
			title: "Base URL 缺失",
			detail: "请填写当前转写 Provider 的 Base URL。"
		});
	} else if (!isValidProviderUrl(trimmedBaseUrl, capability.endpointShape)) {
		items.push({
			severity: "error",
			title: "Base URL 格式无效",
			detail:
				capability.endpointShape === "agentplan-asr-websocket"
					? "AgentPlan ASR 地址必须是 wss:// 开头的有效 WebSocket 地址。"
					: "Base URL 必须是 http:// 或 https:// 开头的有效地址。"
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

		if (
			providerId === "volcengine-agentplan" &&
			trimmedBaseUrl !== "wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream"
		) {
			items.push({
				severity: "error",
				title: "AgentPlan WebSocket 地址不匹配",
				detail: "请使用官方单流高准确率端点 wss://openspeech.bytedance.com/api/v3/plan/sauc/bigmodel_nostream。"
			});
		}
	}

	if (!trimmedModel) {
		items.push({
			severity: "error",
			title: "模型缺失",
			detail: "请填写用于音频转写的模型名称。"
		});
	} else if (providerId === "volcengine-agentplan" && trimmedModel !== "doubao-seed-asr-2.0") {
		items.push({
			severity: "error",
			title: "AgentPlan 模型不匹配",
			detail: "当前接入固定使用 doubao-seed-asr-2.0。"
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
	if (capability.endpointShape === "agentplan-asr-websocket") {
		items.push({
			severity: "info",
			title: "AgentPlan WebSocket 实时发送",
			detail: "音频会本地转换为 16 kHz mono WAV，以 200 ms 分包节奏发送，转写耗时通常接近音频时长。"
		});
		items.push({
			severity: "info",
			title: "AgentPlan 说话人分离始终开启",
			detail: "插件会输出说话人编号和 utterance 时间范围，不识别真实姓名；单人录音也会显示说话人 1。非中文语言会自动按 auto 调用。"
		});
	}

	if (!capability.supportsChunking) {
		items.push({
			severity: "info",
			title: providerId === "volcengine-agentplan" ? "单连接整段音频" : "长音频分段暂不支持",
			detail:
				providerId === "volcengine-agentplan"
					? "AgentPlan 使用单条 WebSocket 持续发送整段音频，Echo Notes 不会额外切成多个转写请求。"
					: "该 Provider 当前不会自动分段。超过能力表限制的大文件会在上传前被阻止。"
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

function isValidProviderUrl(value: string, endpointShape: string): boolean {
	try {
		const url = new URL(value);
		if (endpointShape === "agentplan-asr-websocket") {
			return url.protocol === "wss:";
		}
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

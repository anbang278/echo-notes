import { isInsecureRemoteBaseUrl } from "../security/upload-preview";
import type { TranscriptionConfig } from "../settings/settings";
import {
	AGENTPLAN_ASYNC_BASE_URL,
	MOSI_PLAIN_TRANSCRIPTION_MODEL,
	MOSI_TRANSCRIPTION_BASE_URL,
	MOSI_TRANSCRIPTION_MODEL,
	PROVIDER_LABELS,
	isMosiSpeakerDiarizationModel,
	isProviderId
} from "../settings/settings";
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
	isFileSystemVault?: boolean;
	usage?: "offline" | "realtime";
}

export function diagnoseTranscriptionProviderSettings(
	settings: TranscriptionConfig,
	apiKey: string,
	options: ProviderDiagnosticOptions = {}
): ProviderDiagnosticResult {
	const items: ProviderDiagnosticItem[] = [];
	const usage = options.usage ?? "offline";
	const providerId = isProviderId(settings.provider) ? settings.provider : "aliyun-bailian";
	const providerLabel = PROVIDER_LABELS[providerId] ?? settings.provider;
	const capability = getTranscriptionProviderCapability(providerId, usage);
	const trimmedApiKey = apiKey.trim();
	const trimmedBaseUrl = settings.baseUrl.trim();
	const trimmedModel = settings.model.trim();

	if (!trimmedApiKey) {
		items.push({
			severity: "error",
			title: "API Key 缺失",
			detail: "请先配置当前转写服务商的 API Key。API Key 会保存到 Obsidian SecretStorage。"
		});
	}

	if (
		providerId === "volcengine-agentplan" &&
		usage === "realtime" &&
		options.isMobile
	) {
		items.push({
			severity: "error",
			title: "AgentPlan 仅支持桌面端",
			detail: "Obsidian 移动端无法在 WebSocket 握手阶段写入 AgentPlan 鉴权请求头，请在桌面端使用该服务商。"
		});
	}
	if (
		providerId === "volcengine-agentplan" &&
		options.usage === "realtime" &&
		options.isFileSystemVault === false
	) {
		items.push({
			severity: "error",
			title: "实时录音需要本地文件系统 Vault",
			detail: "实时录音会按顺序追加 WebM 分片；当前 Vault 不是 FileSystemAdapter，无法保证录音附件可恢复。"
		});
	}

	if (!trimmedBaseUrl) {
		items.push({
			severity: "error",
			title: "Base URL 缺失",
			detail: "请填写当前转写服务商的 Base URL。"
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
				detail: "请把示例地址替换成真实服务商地址，否则无法完成转写。"
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
			trimmedBaseUrl !== AGENTPLAN_ASYNC_BASE_URL
		) {
			items.push({
				severity: "error",
				title: "AgentPlan Base URL 不匹配",
				detail: `AgentPlan 实时转写固定使用 ${AGENTPLAN_ASYNC_BASE_URL}。`
			});
		}
		if (providerId === "mosi" && trimmedBaseUrl !== MOSI_TRANSCRIPTION_BASE_URL) {
			items.push({
				severity: "error",
				title: "MOSI Base URL 不匹配",
				detail: `MOSI 转写固定使用官方地址 ${MOSI_TRANSCRIPTION_BASE_URL}。`
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
	} else if (
		providerId === "mosi" &&
		trimmedModel !== MOSI_TRANSCRIPTION_MODEL &&
		trimmedModel !== MOSI_PLAIN_TRANSCRIPTION_MODEL
	) {
		items.push({
			severity: "error",
			title: "MOSI 模型不匹配",
			detail: `MOSI 仅使用官方普通转写模型 ${MOSI_PLAIN_TRANSCRIPTION_MODEL} 或多说话人模型 ${MOSI_TRANSCRIPTION_MODEL}。`
		});
	} else if (capability.recommendedModels.length > 0 && !capability.recommendedModels.includes(trimmedModel)) {
		items.push({
			severity: "info",
			title: "模型不在推荐列表中",
			detail: `当前模型为 ${trimmedModel}；该服务商推荐模型：${capability.recommendedModels.join("、")}。如果你确认服务商支持当前模型，可以忽略此提示。`
		});
	}

	if (settings.language && settings.language !== "auto" && !capability.supportsLanguage) {
		items.push({
			severity: "warning",
			title: "当前服务商不支持语言参数",
			detail: "默认转写语言不会传给当前服务商，实际仍由模型自动识别。建议保持 auto，或切换到支持语言参数的服务商。"
		});
	}

	if (capability.endpointShape === "openai-audio") {
		items.push({
			severity: "info",
			title: "OpenAI-compatible 音频端点",
			detail: "插件会调用 {Base URL}/audio/transcriptions。并非所有 OpenAI-compatible 服务商都实现了音频转写接口。"
		});
	}
	if (capability.endpointShape === "agentplan-asr-websocket") {
		items.push({
			severity: "info",
			title: "AgentPlan 麦克风实时转写",
			detail: "Echo Notes 会把麦克风音频连续降混并重采样为 16 kHz mono PCM16，以 200 ms 分包直接发送；确定分句会持续写入转写稿。"
		});
		items.push({
			severity: "info",
			title: "AgentPlan 说话人分离始终开启",
			detail: "插件会输出说话人编号和 utterance 时间范围，不识别真实姓名；单人录音也会显示说话人 1。非中文语言会自动按 auto 调用。"
		});
	}
	if (providerId === "siliconflow") {
		items.push({
			severity: "info",
			title: "硅基流动长音频自动恢复",
			detail:
				"单次音频必须同时不超过 50 MB 和 1 小时；超过任一限制会按约 10 分钟切分。HTTP 500/502/503/504 重试后仍失败或收到 413 时，只会继续缩小失败段。"
		});
	}
	if (providerId === "mosi") {
		const speakerDiarizationEnabled =
			isMosiSpeakerDiarizationModel(trimmedModel);
		items.push({
			severity: "info",
			title: "MOSI 长音频渐进转写",
			detail:
				`3 分钟以内使用单次同步请求；超过 3 分钟会在本地按约 3 分钟切成 WAV 分段，每完成一段立即回写。${
					speakerDiarizationEnabled
						? "当前开启说话人分离，分段内编号独立且时间保持原音频绝对时间。"
						: "当前使用普通转写模式，只输出正文，不请求或渲染说话人编号。"
				} 两种模式都不发送 language、stream 或 async 参数。`
		});
	}

	if (!capability.supportsChunking) {
		items.push({
			severity: "info",
			title:
				providerId === "volcengine-agentplan"
					? "单连接实时会话"
					: "长音频分段暂不支持",
			detail:
				providerId === "volcengine-agentplan"
					? "AgentPlan 使用单条优化双流 WebSocket 持续发送麦克风 PCM；停止录音后等待最终二遍识别结果。"
					: "该服务商当前不会自动分段。超过能力表限制的大文件会在上传前被阻止。"
		});
	}

	if (items.length === 0) {
		items.push({
			severity: "info",
			title: "基础配置未发现明显问题",
			detail: "这是本地配置自检，不会上传音频，也不会真实调用服务商。"
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

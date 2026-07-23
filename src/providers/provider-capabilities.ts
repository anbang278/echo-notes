import { isProviderId, type TranscriptionProviderId } from "../settings/settings";

export type ProviderUploadMode = "multipart" | "base64-data-url" | "websocket-stream";

export type ProviderEndpointShape = "openai-audio" | "chat-audio" | "agentplan-asr-websocket" | "custom";

export interface ProviderCapability {
	maxAudioBytes: number | null;
	maxBase64DataUrlBytes?: number;
	supportsChunking: boolean;
	supportsLanguage: boolean;
	supportsTimestamp: boolean;
	supportsSpeakerDiarization: boolean;
	supportsStreaming: boolean;
	uploadMode: ProviderUploadMode;
	endpointShape: ProviderEndpointShape;
	recommendedModels: string[];
	notes: string[];
}

const MB = 1024 * 1024;
const OPENAI_COMPATIBLE_MAX_AUDIO_BYTES = 25 * MB;
const SILICONFLOW_MAX_AUDIO_BYTES = 50 * MB;
const BAILIAN_MAX_BASE64_DATA_URL_BYTES = 10 * MB;

export const OPENAI_COMPATIBLE_TRANSCRIPTION_PROVIDER_IDS = [
	"openai",
	"ollama",
	"ollama-open-webui",
	"google-gemini",
	"openrouter",
	"lm-studio",
	"groq",
	"302-ai",
	"anthropic",
	"mistral-ai",
	"together-ai",
	"fireworks-ai",
	"perplexity-ai",
	"deepseek",
	"xai",
	"novita-ai",
	"deepinfra",
	"sambanova",
	"cerebras",
	"z-ai",
	"custom-openai-compatible"
] as const satisfies readonly TranscriptionProviderId[];

type OpenAICompatibleTranscriptionProviderId = (typeof OPENAI_COMPATIBLE_TRANSCRIPTION_PROVIDER_IDS)[number];

const OPENAI_COMPATIBLE_RECOMMENDED_MODELS: Partial<Record<OpenAICompatibleTranscriptionProviderId, string[]>> = {
	openai: ["whisper-1"],
	groq: ["whisper-large-v3-turbo"],
	deepinfra: ["openai/whisper-large-v3"],
	"custom-openai-compatible": ["whisper-1"]
};

const openAICompatibleCapabilities = Object.fromEntries(
	OPENAI_COMPATIBLE_TRANSCRIPTION_PROVIDER_IDS.map((providerId) => [
		providerId,
		createOpenAICompatibleCapability(OPENAI_COMPATIBLE_RECOMMENDED_MODELS[providerId] ?? ["whisper-1"])
	])
) as Record<OpenAICompatibleTranscriptionProviderId, ProviderCapability>;

export const TRANSCRIPTION_PROVIDER_CAPABILITIES: Record<TranscriptionProviderId, ProviderCapability> = {
	"volcengine-agentplan": {
		maxAudioBytes: null,
		supportsChunking: false,
		supportsLanguage: true,
		supportsTimestamp: true,
		supportsSpeakerDiarization: true,
		supportsStreaming: true,
		uploadMode: "websocket-stream",
		endpointShape: "agentplan-asr-websocket",
		recommendedModels: ["doubao-seed-asr-2.0"],
		notes: [
			"仅支持 Obsidian 桌面端；移动端无法在 WebSocket 握手阶段写入 AgentPlan 鉴权请求头。",
			"整段音频会在本地转换为 16 kHz mono WAV，在同一条 WebSocket 中以 200 ms 分包节奏实时发送，不额外切成多个转写请求。",
			"始终启用说话人聚类并返回 utterance 级时间范围；仅识别说话人编号，不识别真实姓名。"
		]
	},
	siliconflow: {
		maxAudioBytes: SILICONFLOW_MAX_AUDIO_BYTES,
		supportsChunking: true,
		supportsLanguage: false,
		supportsTimestamp: false,
		supportsSpeakerDiarization: false,
		supportsStreaming: false,
		uploadMode: "multipart",
		endpointShape: "custom",
		recommendedModels: ["FunAudioLLM/SenseVoiceSmall"],
		notes: [
			"SiliconFlow SenseVoiceSmall 目前由 Echo Notes 走专用 multipart 接口。",
			"如果原音频超过 50 MB，Echo Notes 会在本地解码并切成 16 kHz mono WAV 分段逐段上传。"
		]
	},
	"aliyun-bailian": {
		maxAudioBytes: null,
		maxBase64DataUrlBytes: BAILIAN_MAX_BASE64_DATA_URL_BYTES,
		supportsChunking: true,
		supportsLanguage: true,
		supportsTimestamp: false,
		supportsSpeakerDiarization: false,
		supportsStreaming: false,
		uploadMode: "base64-data-url",
		endpointShape: "chat-audio",
		recommendedModels: ["qwen3-asr-flash"],
		notes: [
			"整段音频会先编码为 Base64 Data URL。",
			"如果编码后超过 10 MB，Echo Notes 会在本地解码并切成 16 kHz mono WAV 分段。"
		]
	},
	...openAICompatibleCapabilities
};

export function getTranscriptionProviderCapability(providerId: string): ProviderCapability {
	const normalizedProviderId = isProviderId(providerId) ? providerId : "custom-openai-compatible";
	return TRANSCRIPTION_PROVIDER_CAPABILITIES[normalizedProviderId];
}

export function formatProviderCapabilityBytes(bytes: number): string {
	const megabytes = bytes / MB;
	return `${Number.isInteger(megabytes) ? megabytes : megabytes.toFixed(1)} MB`;
}

export function getProviderCapabilitySummary(capability: ProviderCapability): string[] {
	const uploadLimit = capability.maxAudioBytes
		? `单次音频上限：${formatProviderCapabilityBytes(capability.maxAudioBytes)}`
		: capability.maxBase64DataUrlBytes
			? `单次编码输入上限：${formatProviderCapabilityBytes(capability.maxBase64DataUrlBytes)}`
			: "单次音频上限：由 Provider 决定";
	const longAudioSummary =
		capability.endpointShape === "agentplan-asr-websocket"
			? "长音频处理：单连接持续发送"
			: capability.supportsChunking
				? "长音频分段：支持"
				: "长音频分段：暂不支持";

	return [
		uploadLimit,
		longAudioSummary,
		capability.supportsLanguage ? "语言参数：支持" : "语言参数：暂不支持",
		capability.supportsTimestamp ? "时间戳：支持" : "时间戳：暂不支持",
		capability.supportsSpeakerDiarization ? "说话人分离：支持" : "说话人分离：暂不支持"
	];
}

function createOpenAICompatibleCapability(recommendedModels: string[]): ProviderCapability {
	return {
		maxAudioBytes: OPENAI_COMPATIBLE_MAX_AUDIO_BYTES,
		supportsChunking: false,
		supportsLanguage: true,
		supportsTimestamp: false,
		supportsSpeakerDiarization: false,
		supportsStreaming: false,
		uploadMode: "multipart",
		endpointShape: "openai-audio",
		recommendedModels,
		notes: ["按 OpenAI-compatible `/audio/transcriptions` 接口调用；实际可用性取决于该 Provider 是否实现音频端点。"]
	};
}

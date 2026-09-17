export interface SiliconFlowTranscriptionModelOption {
	readonly id: string;
	readonly label: string;
	readonly priceLabel?: string;
	readonly description: string;
	readonly note: string;
}

export const SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID = "FunAudioLLM/SenseVoiceSmall";
export const SILICONFLOW_UPGRADE_RECOMMENDED_MODEL_ID = "Qwen/Qwen3-ASR-1.7B";
export const SILICONFLOW_SENSEVOICE_MODEL_ID = SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID;
export const SILICONFLOW_CUSTOM_MODEL_DESCRIPTION =
	"当前使用自定义模型，暂无内置功能说明；可用性和能力以硅基流动实际服务为准。";
export const SILICONFLOW_LEGACY_TELESPEECH_MODEL_ID = "TeleAI/TeleSpeechASR";

export const SILICONFLOW_TRANSCRIPTION_MODEL_OPTIONS: readonly SiliconFlowTranscriptionModelOption[] = [
	{
		id: "Qwen/Qwen3-ASR-1.7B",
		label: "Qwen/Qwen3-ASR-1.7B（综合且快速）",
		priceLabel: "【0.8元/h】",
		description: "支持多语言与中文方言识别，兼顾准确性与效率。",
		note: "实际耗时受音频长度、网络与服务负载影响。"
	},
	{
		id: "XingChenAGI/XingChenASR-Diarize-V3.0",
		label: "XingChenAGI/XingChenASR-Diarize-V3.0（说话人分离）",
		priceLabel: "【免费】",
		description: "面向复杂会议的语音转写，侧重区分不同话者。",
		note: "当前插件使用服务返回的文本；结构化说话人展示尚未接入。"
	},
	{
		id: "XingChenAGI/XingChenASR-V3.2-Ultra",
		label: "XingChenAGI/XingChenASR-V3.2-Ultra（方言优化）",
		priceLabel: "【免费】",
		description: "面向中英与方言混合语音，增强方言识别。",
		note: "具体覆盖与效果以服务商说明和实际音频测试为准。"
	},
	{
		id: "XingChenAGI/XingChenGSR-V1.0",
		label: "XingChenAGI/XingChenGSR-V1.0（语义理解矫正）",
		priceLabel: "【免费】",
		description: "结合上下文进行语义增强，改善转写内容。",
		note: "关键人名、数字和专有名词建议对照原始录音复核。"
	},
	{
		id: SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID,
		label: SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID,
		description: "通用多语言语音识别，适合日常录音与常见中英文内容。",
		note: "保留现有默认值；发起转写时可选择更换，不会强制替换。"
	}
];

export const SILICONFLOW_TRANSCRIPTION_MODELS: readonly string[] =
	SILICONFLOW_TRANSCRIPTION_MODEL_OPTIONS.map((option) => option.id);

export function getSiliconFlowModelOption(modelId: string): SiliconFlowTranscriptionModelOption | undefined {
	return SILICONFLOW_TRANSCRIPTION_MODEL_OPTIONS.find((option) => option.id === modelId);
}

export function formatSiliconFlowModelDisplayLabel(option: SiliconFlowTranscriptionModelOption): string {
	return option.priceLabel ? `${option.priceLabel}${option.label}` : option.label;
}

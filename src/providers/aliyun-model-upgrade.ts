import {
	ALIYUN_FILETRANS_MODEL,
	ALIYUN_FILETRANS_V30_MODEL,
	ALIYUN_LEGACY_ASR_MODEL
} from "../settings/settings";

export const ALIYUN_ASR_PRICING_URL = "https://help.aliyun.com/zh/model-studio/model-pricing";

export const ALIYUN_ASR_MODELS = {
	[ALIYUN_FILETRANS_MODEL]: { name: "Qwen-Audio 3.1 · 长录音", capabilities: "多人会议 · 说话人分离 · 时间戳" },
	[ALIYUN_FILETRANS_V30_MODEL]: { name: "Qwen-Audio 3.0 · 长录音", capabilities: "长录音 · 说话人分离 · 时间戳" },
	[ALIYUN_LEGACY_ASR_MODEL]: { name: "Qwen3-ASR-Flash", capabilities: "同步转写 · 兼容接口" }
};

export const ALIYUN_ASR_PRICE_REFERENCE = "北京区参考单价 · 2026-11-18";
export const ALIYUN_ASR_FILETRANS_DESCRIPTION =
	"适合转写会议、访谈和通话录音。支持多语种与中文方言，可结合热词和上下文提高人名、行业术语的识别准确率。开启说话人分离后可区分发言人，转写结果提供句级和词级时间戳。";

export function isAliyunUpgradeModel(model: string): model is typeof ALIYUN_FILETRANS_V30_MODEL | typeof ALIYUN_LEGACY_ASR_MODEL {
	return model === ALIYUN_FILETRANS_V30_MODEL || model === ALIYUN_LEGACY_ASR_MODEL;
}

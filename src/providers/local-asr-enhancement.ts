import type { TranscriptionEnhancementSnapshot } from "./transcription-provider";

export const LOCAL_ENHANCEMENT_LIMITS = {
	max_hotwords: 100, max_hotword_characters: 1000, max_context_characters: 400
} as const;

export interface LocalAsrEnhancement {
	version: 1;
	hotwords: string[];
	context_text: string;
}

export interface LocalEnhancementCapability {
	hotwords: boolean;
	context: boolean;
	limits: { max_hotwords: number; max_hotword_characters: number; max_context_characters: number };
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	if (typeof value !== "string" || Array.from(value).some((char) => {
		const point = char.codePointAt(0)!;
		return point >= 0xd800 && point <= 0xdfff;
	})) throw new Error("本地增强包含无效文本。");
	return value.trim();
}

export function normalizeLocalEnhancement(value: unknown): LocalAsrEnhancement {
	if (!record(value) || value.version !== 1 || Object.keys(value).some((key) => !["version", "hotwords", "context_text"].includes(key))) {
		throw new Error("本地增强格式或版本无效。");
	}
	const words = value.hotwords === undefined ? [] : value.hotwords;
	if (!Array.isArray(words)) throw new Error("本地热词必须是列表。");
	const hotwords = [...new Set(words.map(text).filter(Boolean))];
	const context_text = text(value.context_text === undefined ? "" : value.context_text);
	if (hotwords.length > LOCAL_ENHANCEMENT_LIMITS.max_hotwords ||
		hotwords.reduce((sum, word) => sum + Array.from(word).length, 0) > LOCAL_ENHANCEMENT_LIMITS.max_hotword_characters ||
		Array.from(context_text).length > LOCAL_ENHANCEMENT_LIMITS.max_context_characters) {
		throw new Error("本地增强超过预算：最多 100 个热词、合计 1000 字；会议背景最多 400 字。");
	}
	return { version: 1, hotwords, context_text };
}

export function localEnhancementFromSnapshot(snapshot: TranscriptionEnhancementSnapshot): LocalAsrEnhancement {
	return normalizeLocalEnhancement({ version: 1, hotwords: snapshot.hotwords.map((item) => item.text), context_text: snapshot.contextText ?? "" });
}

export function parseLocalEnhancementCapability(value: unknown): LocalEnhancementCapability | undefined {
	if (!record(value) || value.version !== 1 || !Array.isArray(value.transports) || !value.transports.includes("jobs") ||
		typeof value.hotwords !== "boolean" || typeof value.context !== "boolean" || !record(value.limits)) return undefined;
	const limits = value.limits;
	for (const key of Object.keys(LOCAL_ENHANCEMENT_LIMITS)) {
		if (typeof limits[key] !== "number" || !Number.isSafeInteger(limits[key]) || limits[key] <= 0) return undefined;
	}
	return { hotwords: value.hotwords, context: value.context, limits: {
		max_hotwords: Math.min(limits.max_hotwords as number, LOCAL_ENHANCEMENT_LIMITS.max_hotwords),
		max_hotword_characters: Math.min(limits.max_hotword_characters as number, LOCAL_ENHANCEMENT_LIMITS.max_hotword_characters),
		max_context_characters: Math.min(limits.max_context_characters as number, LOCAL_ENHANCEMENT_LIMITS.max_context_characters)
	} };
}

export function requireLocalEnhancementCapability(capability: LocalEnhancementCapability | undefined, enhancement: LocalAsrEnhancement): void {
	if (!capability) throw new Error("已开启本地增强，但当前服务或模型未声明增强能力。请升级本地服务或关闭增强。");
	if (enhancement.hotwords.length && !capability.hotwords) throw new Error("当前本地模型不支持热词增强。");
	if (enhancement.context_text && !capability.context) throw new Error("当前本地模型不支持会议背景增强。");
	const limits = capability.limits;
	if (enhancement.hotwords.length > limits.max_hotwords ||
		enhancement.hotwords.reduce((sum, word) => sum + Array.from(word).length, 0) > limits.max_hotword_characters ||
		Array.from(enhancement.context_text).length > limits.max_context_characters) {
		throw new Error("本地增强超过当前服务声明的预算，请调整人工配置后重试。");
	}
}

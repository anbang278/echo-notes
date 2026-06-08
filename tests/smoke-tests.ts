import assert from "node:assert/strict";
import {
	ANALYSIS_LINKS_END,
	ANALYSIS_LINKS_START,
	TRANSCRIPT_ANALYSIS_END,
	TRANSCRIPT_ANALYSIS_START,
	extractTranscriptText,
	insertOrReplaceTranscriptAnalysis,
	renderTranscriptAnalysisBlock
} from "../src/analysis/analysis-output";
import {
	ANALYSIS_TEMPLATE_ORDER,
	buildAnalysisMessages,
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	selectAnalysisTemplateForContext
} from "../src/analysis/analysis-templates";
import { parseAudioLinks } from "../src/audio/audio-link-parser";
import {
	createAudioSegmentRanges,
	estimateBase64DataUrlByteLength,
	formatSegmentTimeRange
} from "../src/audio/audio-segmenter";
import { LinkService } from "../src/obsidian/link-service";
import {
	formatProviderCapabilityBytes,
	getProviderCapabilitySummary,
	getTranscriptionProviderCapability,
	OPENAI_COMPATIBLE_TRANSCRIPTION_PROVIDER_IDS,
	TRANSCRIPTION_PROVIDER_CAPABILITIES
} from "../src/providers/provider-capabilities";
import { diagnoseTranscriptionProviderSettings } from "../src/providers/provider-diagnostics";
import {
	classifyHttpTranscriptionError,
	createHttpTranscriptionError,
	createNetworkTranscriptionError,
	shouldWriteFailedTranscript,
	TranscriptionError
} from "../src/providers/transcription-provider";
import { sanitizeSensitiveText } from "../src/security/redaction";
import {
	buildTranscriptionUploadPreview,
	formatFileSize,
	isInsecureRemoteBaseUrl
} from "../src/security/upload-preview";
import {
	createAnalysisTemplateId,
	createCustomAnalysisTemplate,
	ANALYSIS_PROVIDER_DEFAULTS,
	ANALYSIS_PROVIDER_LABELS,
	DEFAULT_SETTINGS,
	DEFAULT_ANALYSIS_SYSTEM_PROMPT,
	DEFAULT_ANALYSIS_TEMPLATES,
	formatHotkey,
	normalizeAnalysisTemplates,
	normalizeEchoNotesSettings,
	parseHotkeyInput,
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS
} from "../src/settings/settings";
import {
	renderFailedTranscriptTemplate,
	renderProgressTranscriptTemplate,
	renderTranscriptTemplate,
	renderTranscriptionSegments
} from "../src/transcript/transcript-template";
import {
	createTranscriptFileName,
	getLegacyCustomFolderTranscriptPathForAudioPath,
	getTranscriptPathForAudioPath
} from "../src/transcript/transcript-path";

const sample = [
	"![[Recording 20260531001942.m4a]]",
	"[[Recording 20260531001942.m4a|录音]]",
	"[录音](Attachments/Recording%2020260531001942.m4a)",
	"[中文录音](素材/会议录音.wav)"
].join("\n");

const links = parseAudioLinks(sample);
assert.equal(links.length, 4);
assert.equal(links[0].linkPath, "Recording 20260531001942.m4a");
assert.equal(links[1].linkPath, "Recording 20260531001942.m4a");
assert.equal(links[2].linkPath, "Attachments/Recording 20260531001942.m4a");
assert.equal(links[3].linkPath, "素材/会议录音.wav");

const fakeApp = {
	fileManager: {
		generateMarkdownLink: (_file: unknown, _sourcePath: string, _subpath?: string, alias?: string) =>
			`[[Recording 20260531001942/Recording 20260531001942.transcript|${alias ?? "Recording 20260531001942.transcript"}]]`
	}
};
const linkService = new LinkService(fakeApp as never, { insertStyle: "linkOnly" } as never);
const englishLinkService = new LinkService(
	fakeApp as never,
	{ insertStyle: "linkOnly", copyLanguage: "en" } as never
);
const audioOnly = "![[Recording 20260531001942.m4a]]";
const audioMatch = parseAudioLinks(audioOnly)[0];
const transcriptLink = "[[Recording 20260531001942/Recording 20260531001942.transcript|查看转写稿]]";
const englishTranscriptLink =
	"[[Recording 20260531001942/Recording 20260531001942.transcript|View the transcribed manuscript]]";

assert.equal(linkService.createTranscriptLink({} as never, "Daily.md"), transcriptLink);
assert.equal(englishLinkService.createTranscriptLink({} as never, "Daily.md"), englishTranscriptLink);

assert.equal(
	linkService.insertTranscriptLinkAfterMatch(audioOnly, audioMatch, transcriptLink),
	`${audioOnly}\n${transcriptLink}`
);

assert.equal(
	linkService.insertTranscriptLinkAfterMatch(`${audioOnly}\n${transcriptLink}`, audioMatch, transcriptLink),
	`${audioOnly}\n${transcriptLink}`
);

const templateApp = {
	fileManager: {
		generateMarkdownLink: (file: { basename: string }) => `[[${file.basename}]]`
	}
};
const audioFile = {
	basename: "Recording 20260531001942",
	name: "Recording 20260531001942.m4a"
};
const sourceNote = {
	basename: "Daily"
};

const chineseTranscript = renderTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	sourceNote: sourceNote as never,
	result: {
		text: "会议内容",
		provider: "siliconflow",
		model: "TeleAI/TeleSpeechASR"
	},
	copyLanguage: "zh"
});

assert.match(chineseTranscript, /# 转写稿 Recording 20260531001942/);
assert.match(chineseTranscript, /原始录音：!\[\[Recording 20260531001942\]\]/);
assert.match(chineseTranscript, /来源笔记：\[\[Daily\]\]/);
assert.doesNotMatch(chineseTranscript, /# Recording 20260531001942 转写稿/);
assert.ok(chineseTranscript.indexOf("来源笔记：[[Daily]]") < chineseTranscript.indexOf("# 转写稿 Recording 20260531001942"));

const englishTranscript = renderTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	sourceNote: sourceNote as never,
	result: {
		text: "Meeting notes",
		provider: "openai",
		model: "whisper-1"
	},
	copyLanguage: "en"
});

assert.match(englishTranscript, /# Transcribed manuscript Recording 20260531001942/);
assert.match(englishTranscript, /Original recording: !\[\[Recording 20260531001942\]\]/);
assert.match(englishTranscript, /Source note: \[\[Daily\]\]/);
assert.doesNotMatch(englishTranscript, /# Recording 20260531001942 Transcribed manuscript/);

const englishFailedTranscript = renderFailedTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	provider: "openai",
	model: "whisper-1",
	error: "No text field.",
	copyLanguage: "en"
});

assert.match(englishFailedTranscript, /# Transcription failed/);
assert.match(englishFailedTranscript, /Error reason:/);

assert.equal(estimateBase64DataUrlByteLength(3, "audio/wav"), "data:audio/wav;base64,".length + 4);
assert.equal(estimateBase64DataUrlByteLength(4, "audio/wav"), "data:audio/wav;base64,".length + 8);
assert.equal(formatSegmentTimeRange({ startSeconds: 0, endSeconds: 180 }), "00:00-03:00");
assert.equal(formatSegmentTimeRange({ startSeconds: 3661, endSeconds: 3725 }), "01:01:01-01:02:05");

const plannedRanges = createAudioSegmentRanges(
	560,
	{ targetSegmentSeconds: 180, minSegmentSeconds: 30 },
	(targetSeconds) => targetSeconds + 5
);
assert.deepEqual(
	plannedRanges.map((range) => [range.index, range.total, range.startSeconds, range.endSeconds]),
	[
		[1, 3, 0, 185],
		[2, 3, 185, 370],
		[3, 3, 370, 560]
	]
);
const fallbackRanges = createAudioSegmentRanges(
	390,
	{ targetSegmentSeconds: 180, minSegmentSeconds: 30 },
	() => 10
);
assert.deepEqual(
	fallbackRanges.map((range) => [range.index, range.total, range.startSeconds, range.endSeconds]),
	[
		[1, 2, 0, 180],
		[2, 2, 180, 390]
	]
);

const transcriptSegments = [
	{
		index: 1,
		total: 2,
		startSeconds: 0,
		endSeconds: 180,
		text: "第一段内容。",
		traceId: "trace-1"
	},
	{
		index: 2,
		total: 2,
		startSeconds: 180,
		endSeconds: 321.4,
		text: "第二段内容。"
	}
];
const renderedSegments = renderTranscriptionSegments(transcriptSegments, "zh");
assert.match(renderedSegments, /## 分段 01（00:00-03:00）/);
assert.match(renderedSegments, /<!-- trace_id: trace-1 -->/);
assert.match(renderedSegments, /## 分段 02（03:00-05:21）/);

const segmentedTranscript = renderTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	result: {
		text: "第一段内容。\n\n第二段内容。",
		provider: "aliyun-bailian",
		model: "qwen3-asr-flash",
		segments: transcriptSegments
	},
	copyLanguage: "zh"
});
assert.match(segmentedTranscript, /status: done/);
assert.match(segmentedTranscript, /# 转写稿 Recording 20260531001942/);
assert.match(segmentedTranscript, /## 分段 01（00:00-03:00）/);

const progressTranscript = renderProgressTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	provider: "aliyun-bailian",
	model: "qwen3-asr-flash",
	segments: [transcriptSegments[0]],
	copyLanguage: "zh"
});
assert.match(progressTranscript, /status: transcribing/);
assert.match(progressTranscript, /长音频正在逐段转写/);
assert.match(progressTranscript, /# 转写稿 Recording 20260531001942/);
assert.match(progressTranscript, /第一段内容。/);

const partialFailedTranscript = renderFailedTranscriptTemplate({
	app: templateApp as never,
	audioFile: audioFile as never,
	transcriptPath: "Recording 20260531001942.transcript.md",
	provider: "aliyun-bailian",
	model: "qwen3-asr-flash",
	error: "第 2 段请求失败。",
	segments: [transcriptSegments[0]],
	copyLanguage: "zh"
});
assert.match(partialFailedTranscript, /status: failed/);
assert.match(partialFailedTranscript, /长音频逐段转写已中断/);
assert.match(partialFailedTranscript, /# 转写稿 Recording 20260531001942/);
assert.match(partialFailedTranscript, /第一段内容。/);

const expectedAnalysisTemplateOrder = [
	"work-minutes",
	"study-notes",
	"product-requirement-mining",
	"manager-sync-minutes",
	"product-manager-minutes",
	"project-manager-minutes",
	"engineering-minutes",
	"sales-minutes",
	"customer-success-minutes",
	"operations-minutes",
	"hr-minutes"
];
assert.deepEqual(ANALYSIS_TEMPLATE_ORDER, expectedAnalysisTemplateOrder);
assert.match(DEFAULT_ANALYSIS_SYSTEM_PROMPT, /专业的录音文本分析助手/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["work-minutes"].customPrompt, /## 摘要/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["work-minutes"].customPrompt, /## 行动项/);
assert.deepEqual(DEFAULT_ANALYSIS_TEMPLATES["work-minutes"].recognitionKeywords, ["工作纪要"]);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["study-notes"].customPrompt, /## 核心概念/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["study-notes"].customPrompt, /## 复习清单/);
assert.deepEqual(DEFAULT_ANALYSIS_TEMPLATES["study-notes"].recognitionKeywords, ["学习纪要"]);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"].customPrompt, /## 需求机会/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"].customPrompt, /## 验收标准/);
assert.deepEqual(DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"].recognitionKeywords, ["产品需求挖掘纪要"]);
const roleTemplateExpectations = [
	["manager-sync-minutes", "管理者纪要", /## 管理摘要/, /## 汇报口径/, /行动项.*知识沉淀.*汇报口径/s],
	["product-manager-minutes", "产品经理纪要", /## 背景与目标/, /## 对外同步摘要/, /行动项.*知识沉淀.*对外同步摘要/s],
	["project-manager-minutes", "项目经理纪要", /## 项目进展/, /## 下次检查点/, /行动项.*知识沉淀.*下次检查点/s],
	["engineering-minutes", "研发/技术纪要", /## 技术背景/, /## 沉淀要点/, /行动项.*知识沉淀.*汇报内容/s],
	["sales-minutes", "销售纪要", /## 客户背景/, /## 汇报摘要/, /下一步行动.*知识沉淀.*汇报摘要/s],
	["customer-success-minutes", "客户成功纪要", /## 客户现状/, /## 客户同步口径/, /行动项.*知识沉淀.*客户同步口径/s],
	["operations-minutes", "运营纪要", /## 目标与指标/, /## 复盘沉淀/, /优化动作.*知识沉淀.*汇报内容/s],
	["hr-minutes", "HR/人力纪要", /## 组织\/岗位背景/, /## 管理同步摘要/, /行动项.*知识沉淀.*管理同步摘要/s]
] as const;
for (const [templateId, keyword, firstHeading, finalHeading, guidance] of roleTemplateExpectations) {
	const template = DEFAULT_ANALYSIS_TEMPLATES[templateId];
	assert.equal(template.builtin, true);
	assert.equal(template.enabled, false);
	assert.ok(template.recognitionKeywords.includes(keyword));
	assert.match(template.customPrompt, firstHeading);
	assert.match(template.customPrompt, finalHeading);
	assert.match(template.customPrompt, guidance);
}
assert.deepEqual(Object.keys(ANALYSIS_PROVIDER_LABELS), Object.keys(PROVIDER_LABELS));
assert.deepEqual(Object.keys(ANALYSIS_PROVIDER_DEFAULTS), Object.keys(PROVIDER_LABELS));
assert.equal(DEFAULT_SETTINGS.provider, "aliyun-bailian");
assert.equal(DEFAULT_SETTINGS.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(DEFAULT_SETTINGS.model, "qwen3-asr-flash");
assert.equal(PROVIDER_DEFAULTS["aliyun-bailian"].model, "qwen3-asr-flash");
assert.equal(DEFAULT_SETTINGS.analysisProvider, "aliyun-bailian");
assert.equal(DEFAULT_SETTINGS.analysisBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(DEFAULT_SETTINGS.analysisModel, "deepseek-v4-pro");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.deepseek.analysisBaseUrl, "https://api.deepseek.com/v1");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.deepseek.analysisModel, "deepseek-v4-pro");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.siliconflow.analysisBaseUrl, "https://api.siliconflow.cn/v1");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.siliconflow.analysisModel, "deepseek-ai/DeepSeek-V3");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"].analysisModel, "deepseek-v4-pro");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.openai.analysisModel, "gpt-4o-mini");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.groq.analysisModel, "llama-3.3-70b-versatile");
assert.deepEqual(Object.keys(TRANSCRIPTION_PROVIDER_CAPABILITIES), Object.keys(PROVIDER_LABELS));
assert.equal(formatProviderCapabilityBytes(25 * 1024 * 1024), "25 MB");
assert.equal(getTranscriptionProviderCapability("aliyun-bailian").supportsChunking, true);
assert.equal(getTranscriptionProviderCapability("aliyun-bailian").uploadMode, "base64-data-url");
assert.equal(getTranscriptionProviderCapability("aliyun-bailian").endpointShape, "chat-audio");
assert.equal(getTranscriptionProviderCapability("aliyun-bailian").maxBase64DataUrlBytes, 10 * 1024 * 1024);
assert.equal(getTranscriptionProviderCapability("siliconflow").maxAudioBytes, 50 * 1024 * 1024);
assert.equal(getTranscriptionProviderCapability("siliconflow").supportsLanguage, false);
assert.equal(getTranscriptionProviderCapability("openai").maxAudioBytes, 25 * 1024 * 1024);
assert.equal(getTranscriptionProviderCapability("openai").supportsLanguage, true);
assert.equal(getTranscriptionProviderCapability("openai").supportsTimestamp, false);
assert.equal(getTranscriptionProviderCapability("unknown-provider").endpointShape, "openai-audio");
assert.ok(getProviderCapabilitySummary(getTranscriptionProviderCapability("aliyun-bailian")).includes("长音频分段：支持"));
assert.ok(getProviderCapabilitySummary(getTranscriptionProviderCapability("openai")).includes("长音频分段：暂不支持"));
for (const providerId of OPENAI_COMPATIBLE_TRANSCRIPTION_PROVIDER_IDS) {
	const capability = getTranscriptionProviderCapability(providerId);
	assert.equal(capability.endpointShape, "openai-audio");
	assert.equal(capability.uploadMode, "multipart");
	assert.equal(capability.maxAudioBytes, 25 * 1024 * 1024);
}
const sensitiveErrorText = [
	"Authorization: Bearer sk-testsecret123456",
	'{"api_key":"sk-jsonsecret123456"}',
	"data:audio/wav;base64,QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo="
].join("\n");
const sanitizedErrorText = sanitizeSensitiveText(sensitiveErrorText);
assert.doesNotMatch(sanitizedErrorText, /testsecret/);
assert.doesNotMatch(sanitizedErrorText, /jsonsecret/);
assert.doesNotMatch(sanitizedErrorText, /QUJDREV/);
assert.match(sanitizedErrorText, /Authorization: Bearer \[REDACTED\]/);
assert.match(sanitizedErrorText, /"api_key":"\[REDACTED\]"/);
assert.match(sanitizedErrorText, /data:audio\/wav;base64,\[REDACTED\]/);
assert.match(sanitizeSensitiveText("响应内容".repeat(260)), /已截断/);
assert.equal(classifyHttpTranscriptionError(401, "unauthorized"), "authentication_failed");
assert.equal(classifyHttpTranscriptionError(403, "forbidden"), "authentication_failed");
assert.equal(classifyHttpTranscriptionError(413, "too large"), "file_too_large");
assert.equal(classifyHttpTranscriptionError(429, "rate limited"), "rate_limited");
assert.equal(classifyHttpTranscriptionError(400, "insufficient_quota"), "quota_exceeded");
assert.equal(classifyHttpTranscriptionError(400, "model_not_found"), "invalid_model");
assert.equal(classifyHttpTranscriptionError(500, "server error"), "api_error");
const httpError = createHttpTranscriptionError("OpenAI", 429, sensitiveErrorText, "trace-rate");
assert.equal(httpError.code, "rate_limited");
assert.equal(httpError.traceId, "trace-rate");
assert.doesNotMatch(httpError.message, /testsecret|jsonsecret|QUJDREV/);
const networkError = createNetworkTranscriptionError("OpenAI", new Error("Bearer sk-networksecret123456"));
assert.equal(networkError.code, "network_error");
assert.doesNotMatch(networkError.message, /networksecret/);
assert.equal(shouldWriteFailedTranscript(new TranscriptionError("unsupported_format", "bad format")), false);
assert.equal(shouldWriteFailedTranscript(new TranscriptionError("missing_api_key", "missing key")), false);
assert.equal(shouldWriteFailedTranscript(new TranscriptionError("rate_limited", "slow down")), true);
assert.equal(shouldWriteFailedTranscript(new TranscriptionError("invalid_model", "bad model")), true);
assert.equal(formatFileSize(512), "512 B");
assert.equal(formatFileSize(1536), "1.5 KB");
assert.equal(formatFileSize(2 * 1024 * 1024), "2 MB");
assert.equal(isInsecureRemoteBaseUrl("http://api.example.com/v1"), true);
assert.equal(isInsecureRemoteBaseUrl("https://api.example.com/v1"), false);
assert.equal(isInsecureRemoteBaseUrl("http://localhost:11434/v1"), false);
const uploadPreview = buildTranscriptionUploadPreview(
	{
		...DEFAULT_SETTINGS,
		baseUrl: "http://api.example.com/v1",
		analysisEnabled: true,
		analysisBaseUrl: "http://analysis.example.com/v1"
	},
	{
		name: "Meeting.m4a",
		path: "Projects/Meeting.m4a",
		stat: {
			size: 1536
		}
	}
);
assert.equal(uploadPreview.rows.find((row) => row.label === "音频文件")?.value, "Meeting.m4a");
assert.equal(uploadPreview.rows.find((row) => row.label === "文件大小")?.value, "1.5 KB");
assert.equal(uploadPreview.rows.find((row) => row.label === "AI 分析模型")?.value, DEFAULT_SETTINGS.analysisModel);
assert.equal(uploadPreview.warnings.length, 2);
const missingProviderDiagnostics = diagnoseTranscriptionProviderSettings(
	{
		...DEFAULT_SETTINGS,
		baseUrl: "",
		model: ""
	},
	""
);
assert.equal(missingProviderDiagnostics.canAttemptTranscription, false);
assert.ok(missingProviderDiagnostics.items.some((item) => item.severity === "error" && item.title === "API Key 缺失"));
assert.ok(missingProviderDiagnostics.items.some((item) => item.severity === "error" && item.title === "Base URL 缺失"));
assert.ok(missingProviderDiagnostics.items.some((item) => item.severity === "error" && item.title === "模型缺失"));
const warningProviderDiagnostics = diagnoseTranscriptionProviderSettings(
	{
		...DEFAULT_SETTINGS,
		provider: "custom-openai-compatible",
		baseUrl: "http://example.com/v1",
		model: "custom-whisper",
		language: "zh"
	},
	"sk-valid"
);
assert.equal(warningProviderDiagnostics.canAttemptTranscription, false);
assert.ok(warningProviderDiagnostics.items.some((item) => item.severity === "error" && item.title === "Base URL 仍是示例地址"));
assert.ok(warningProviderDiagnostics.items.some((item) => item.severity === "warning" && item.title === "Base URL 使用未加密 HTTP"));
assert.ok(warningProviderDiagnostics.items.some((item) => item.severity === "info" && item.title === "模型不在推荐列表中"));
assert.ok(warningProviderDiagnostics.items.some((item) => item.severity === "info" && item.title === "OpenAI-compatible 音频端点"));
const validProviderDiagnostics = diagnoseTranscriptionProviderSettings(DEFAULT_SETTINGS, "sk-valid");
assert.equal(validProviderDiagnostics.canAttemptTranscription, true);
assert.equal(validProviderDiagnostics.providerLabel, PROVIDER_LABELS["aliyun-bailian"]);
assert.equal(validProviderDiagnostics.items.some((item) => item.severity === "error"), false);
assert.equal(formatHotkey(DEFAULT_SETTINGS.officialRecorderStartHotkey), "Ctrl+L");
assert.equal(formatHotkey(DEFAULT_SETTINGS.officialRecorderStopHotkey), "Ctrl+S");
assert.equal(formatHotkey(DEFAULT_SETTINGS.transcribeAllAudioHotkey), "Ctrl+Z");
assert.deepEqual(parseHotkeyInput("Control + L"), { modifiers: ["Ctrl"], key: "L" });
assert.deepEqual(parseHotkeyInput("Cmd+Shift+P"), { modifiers: ["Meta", "Shift"], key: "P" });
assert.equal(parseHotkeyInput("not a hotkey"), undefined);

const normalizedSettings = normalizeEchoNotesSettings({
	autoAnalyzeAfterTranscription: true,
	promptForAnalysisAfterTranscription: true,
	analysisTemplates: [
		{
			id: "work-minutes",
			name: "",
			description: "",
			prompt: "",
			enabled: false
		},
		{
			name: "访谈纪要",
			description: "从访谈中提炼事实和机会。",
			prompt: "请输出访谈纪要。",
			enabled: true
		}
	]
});
assert.equal(normalizedSettings.analysisEnabled, true);
assert.equal(normalizedSettings.provider, "aliyun-bailian");
assert.equal(normalizedSettings.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(normalizedSettings.model, "qwen3-asr-flash");
assert.equal(normalizedSettings.analysisProvider, "aliyun-bailian");
assert.equal(normalizedSettings.analysisBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(normalizedSettings.analysisModel, "deepseek-v4-pro");
assert.equal(normalizedSettings.defaultAnalysisTemplateId, "work-minutes");
assert.equal(normalizedSettings.analysisTemplates[0].id, "work-minutes");
assert.equal(normalizedSettings.analysisTemplates[0].name, "工作纪要");
assert.equal(normalizedSettings.analysisTemplates[0].enabled, false);
assert.equal(normalizedSettings.analysisTemplates[0].builtin, true);
assert.equal(normalizedSettings.analysisTemplates[0].systemPrompt, DEFAULT_ANALYSIS_SYSTEM_PROMPT);
assert.deepEqual(
	normalizedSettings.analysisTemplates.slice(0, expectedAnalysisTemplateOrder.length).map((template) => template.id),
	expectedAnalysisTemplateOrder
);
for (const templateId of expectedAnalysisTemplateOrder.slice(3)) {
	assert.equal(normalizedSettings.analysisTemplates.find((template) => template.id === templateId)?.enabled, false);
}
const normalizedCustomTemplate = normalizedSettings.analysisTemplates.find((template) => template.id === "custom-template");
assert.equal(normalizedCustomTemplate?.name, "访谈纪要");
assert.equal(normalizedCustomTemplate?.systemPrompt, DEFAULT_ANALYSIS_SYSTEM_PROMPT);
assert.equal(normalizedCustomTemplate?.customPrompt, "请输出访谈纪要。");
assert.deepEqual(normalizedCustomTemplate?.recognitionKeywords, ["访谈纪要"]);
assert.equal(Object.prototype.hasOwnProperty.call(normalizedSettings, "autoAnalyzeAfterTranscription"), false);
assert.equal(Object.prototype.hasOwnProperty.call(normalizedSettings, "promptForAnalysisTemplateOnTranscription"), false);
assert.equal(normalizedSettings.confirmBeforeTranscription, false);
assert.equal(formatHotkey(normalizedSettings.officialRecorderStartHotkey), "Ctrl+L");
assert.equal(formatHotkey(normalizedSettings.officialRecorderStopHotkey), "Ctrl+S");
assert.equal(formatHotkey(normalizedSettings.transcribeAllAudioHotkey), "Ctrl+Z");
const customHotkeySettings = normalizeEchoNotesSettings({
	officialRecorderStartHotkey: "Control + L",
	officialRecorderStopHotkey: "Cmd+Shift+P",
	transcribeAllAudioHotkey: null
});
assert.equal(formatHotkey(customHotkeySettings.officialRecorderStartHotkey), "Ctrl+L");
assert.equal(formatHotkey(customHotkeySettings.officialRecorderStopHotkey), "Meta+Shift+P");
assert.equal(formatHotkey(customHotkeySettings.transcribeAllAudioHotkey), "");
const invalidHotkeySettings = normalizeEchoNotesSettings({
	officialRecorderStartHotkey: "not a hotkey",
	officialRecorderStopHotkey: { modifiers: ["Ctrl", "Bad"], key: "S" },
	transcribeAllAudioHotkey: { modifiers: ["Ctrl"], key: "has space" }
});
assert.equal(formatHotkey(invalidHotkeySettings.officialRecorderStartHotkey), "Ctrl+L");
assert.equal(formatHotkey(invalidHotkeySettings.officialRecorderStopHotkey), "Ctrl+S");
assert.equal(formatHotkey(invalidHotkeySettings.transcribeAllAudioHotkey), "Ctrl+Z");
assert.equal(normalizeEchoNotesSettings({ confirmBeforeTranscription: true }).confirmBeforeTranscription, true);
const migratedDefaultTemplateSettings = normalizeEchoNotesSettings({ autoAnalysisTemplate: "study-notes" });
assert.equal(migratedDefaultTemplateSettings.defaultAnalysisTemplateId, "study-notes");
assert.equal(Object.prototype.hasOwnProperty.call(migratedDefaultTemplateSettings, "autoAnalysisTemplate"), false);
const siliconFlowAnalysisSettings = normalizeEchoNotesSettings({ analysisProvider: "siliconflow" });
assert.equal(siliconFlowAnalysisSettings.analysisProvider, "siliconflow");
assert.equal(siliconFlowAnalysisSettings.analysisBaseUrl, "https://api.siliconflow.cn/v1");
assert.equal(siliconFlowAnalysisSettings.analysisModel, "deepseek-ai/DeepSeek-V3");
const customOpenAIAnalysisSettings = normalizeEchoNotesSettings({
	analysisProvider: "openai",
	analysisBaseUrl: "https://proxy.example.com/v1",
	analysisModel: "my-chat-model"
});
assert.equal(customOpenAIAnalysisSettings.analysisProvider, "openai");
assert.equal(customOpenAIAnalysisSettings.analysisBaseUrl, "https://proxy.example.com/v1");
assert.equal(customOpenAIAnalysisSettings.analysisModel, "my-chat-model");
const invalidAnalysisProviderSettings = normalizeEchoNotesSettings({
	analysisProvider: "unknown-provider",
	analysisBaseUrl: "https://example.invalid/v1",
	analysisModel: "wrong-model"
});
assert.equal(invalidAnalysisProviderSettings.analysisProvider, "aliyun-bailian");
assert.equal(invalidAnalysisProviderSettings.analysisBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(invalidAnalysisProviderSettings.analysisModel, "deepseek-v4-pro");
const missingAnalysisProviderSettings = normalizeEchoNotesSettings({
	analysisBaseUrl: "https://example.invalid/v1",
	analysisModel: "wrong-model"
});
assert.equal(missingAnalysisProviderSettings.analysisProvider, "aliyun-bailian");
assert.equal(missingAnalysisProviderSettings.analysisBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(missingAnalysisProviderSettings.analysisModel, "deepseek-v4-pro");
const invalidTranscriptionProviderSettings = normalizeEchoNotesSettings({
	provider: "unknown-provider",
	baseUrl: "https://example.invalid/v1",
	model: "wrong-model",
	language: "en"
});
assert.equal(invalidTranscriptionProviderSettings.provider, "aliyun-bailian");
assert.equal(invalidTranscriptionProviderSettings.baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
assert.equal(invalidTranscriptionProviderSettings.model, "qwen3-asr-flash");
assert.equal(invalidTranscriptionProviderSettings.language, "auto");
assert.equal(createTranscriptFileName("Projects/A/Meeting.m4a"), "Meeting.transcript.md");
const hashedTranscriptA = createTranscriptFileName("Projects/A/Meeting.m4a", true);
const hashedTranscriptB = createTranscriptFileName("Projects/B/Meeting.m4a", true);
assert.match(hashedTranscriptA, /^Meeting-[a-z0-9]+\.transcript\.md$/);
assert.match(hashedTranscriptB, /^Meeting-[a-z0-9]+\.transcript\.md$/);
assert.notEqual(hashedTranscriptA, hashedTranscriptB);
assert.equal(hashedTranscriptA, createTranscriptFileName("Projects/A/Meeting.m4a", true));
assert.equal(
	getTranscriptPathForAudioPath("Projects/A/Meeting.m4a", {
		outputStrategy: "custom-folder",
		customOutputFolder: "Transcripts"
	}),
	`Transcripts/${hashedTranscriptA}`
);
assert.equal(
	getTranscriptPathForAudioPath("Projects/B/Meeting.m4a", {
		outputStrategy: "custom-folder",
		customOutputFolder: "Transcripts"
	}),
	`Transcripts/${hashedTranscriptB}`
);
assert.equal(
	getTranscriptPathForAudioPath("Projects/A/Meeting.m4a", {
		outputStrategy: "same-folder",
		customOutputFolder: DEFAULT_SETTINGS.customOutputFolder
	}),
	"Projects/A/Meeting.transcript.md"
);
assert.equal(
	getLegacyCustomFolderTranscriptPathForAudioPath("Projects/A/Meeting.m4a", {
		outputStrategy: "custom-folder",
		customOutputFolder: "Transcripts"
	}),
	"Transcripts/Meeting.transcript.md"
);

assert.equal(createAnalysisTemplateId("review", ["review"]), "review-2");
const customTemplate = createCustomAnalysisTemplate("自定义模板", []);
assert.equal(customTemplate.id, "custom-template");
assert.equal(customTemplate.name, "自定义模板");
assert.equal(customTemplate.systemPrompt, DEFAULT_ANALYSIS_SYSTEM_PROMPT);
assert.match(customTemplate.customPrompt, /结构化纪要/);
assert.deepEqual(customTemplate.recognitionKeywords, ["自定义模板"]);
assert.deepEqual(
	normalizeAnalysisTemplates([{ id: "custom-review", name: "复盘纪要", prompt: "请复盘。", enabled: true }]).map(
		(template) => template.id
	),
	[...expectedAnalysisTemplateOrder, "custom-review"]
);
assert.equal(
	normalizeAnalysisTemplates([{ id: "custom-review", name: "复盘纪要", prompt: "请复盘。", enabled: true }])[
		expectedAnalysisTemplateOrder.length
	].customPrompt,
	"请复盘。"
);
assert.equal(getDefaultAnalysisTemplate(normalizedSettings)?.id, "study-notes");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里标记为访谈纪要。")?.id, "custom-template");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里标记为学习纪要。")?.id, "study-notes");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里标记为管理者纪要。")?.id, "study-notes");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里没有任何关键字。")?.id, "study-notes");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "学习纪要和产品需求挖掘纪要同时出现。")?.id, "study-notes");

const contextNote = [
	"第 0 行不应进入上下文",
	"第 1 行：学习纪要",
	"第 2 行",
	"第 3 行",
	"![[Recording 20260531001942.m4a]]",
	"第 5 行",
	"第 6 行",
	"第 7 行",
	"第 8 行：产品需求挖掘纪要"
].join("\n");
const contextMatch = parseAudioLinks(contextNote)[0];
const contextText = getAnalysisContextAroundAudioMatch(contextNote, contextMatch);
assert.match(contextText, /学习纪要/);
assert.doesNotMatch(contextText, /第 0 行/);
assert.doesNotMatch(contextText, /产品需求挖掘纪要/);
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, contextText)?.id, "study-notes");

const workMinutesPrompt = buildAnalysisMessages({
	template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"],
	transcriptTitle: "Recording 20260531001942.transcript",
	transcriptText: "张三负责下周提交方案。",
	copyLanguage: "zh"
});
assert.match(workMinutesPrompt.system, /简体中文/);
assert.match(workMinutesPrompt.system, /专业的录音文本分析助手/);
assert.match(workMinutesPrompt.user, /分析方案：工作纪要/);
assert.match(workMinutesPrompt.user, /行动项/);

const productPrompt = buildAnalysisMessages({
	template: DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"],
	transcriptTitle: "Interview.transcript",
	transcriptText: "用户希望减少重复录入。",
	copyLanguage: "en"
});
assert.match(productPrompt.system, /English/);
assert.match(productPrompt.user, /分析方案：产品需求挖掘纪要/);
assert.match(productPrompt.user, /P0\/P1\/P2/);

const workAnalysisBlock = renderTranscriptAnalysisBlock({
	templateId: "work-minutes",
	templateName: "工作纪要",
	result: {
		text: "# 工作纪要\n\n## 摘要\n\n### 细节\n\n```mermaid\n# code fence heading should stay unchanged\n```\n\n这是纪要。",
		provider: "deepseek",
		model: "deepseek-chat",
		traceId: "trace-1"
	},
	copyLanguage: "zh"
});
assert.match(workAnalysisBlock, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(workAnalysisBlock, /^## 工作纪要$/m);
assert.match(workAnalysisBlock, /Provider：deepseek/);
assert.match(workAnalysisBlock, /模型：deepseek-chat/);
assert.match(workAnalysisBlock, /Trace ID：trace-1/);
assert.match(workAnalysisBlock, /^### 工作纪要$/m);
assert.match(workAnalysisBlock, /^### 摘要$/m);
assert.match(workAnalysisBlock, /^#### 细节$/m);
assert.match(workAnalysisBlock, /```mermaid\n# code fence heading should stay unchanged\n```/);
assert.doesNotMatch(workAnalysisBlock, /^# 工作纪要$/m);
assert.doesNotMatch(workAnalysisBlock, /^## 摘要$/m);

const transcriptWithFrontmatter = [
	"---",
	"type: audio-transcript",
	"---",
	"",
	"原始录音：![[Recording]]",
	"来源笔记：[[Daily]]",
	"",
	TRANSCRIPT_ANALYSIS_START,
	"# 纪要分析 Recording",
	"",
	workAnalysisBlock,
	TRANSCRIPT_ANALYSIS_END,
	"",
	ANALYSIS_LINKS_START,
	"## AI 纪要分析",
	"",
	"- [[Analysis|工作纪要]]",
	ANALYSIS_LINKS_END,
	"",
	"# 转写稿 Recording",
	"",
	"正文内容"
].join("\n");
assert.equal(extractTranscriptText(transcriptWithFrontmatter), "正文内容");

const legacyTranscriptWithFrontmatter = [
	"---",
	"type: audio-transcript",
	"---",
	"",
	"# Recording 转写稿",
	"",
	"## 转写稿",
	"",
	"正文内容",
	"",
	TRANSCRIPT_ANALYSIS_START,
	"## AI 纪要分析",
	"",
	workAnalysisBlock,
	TRANSCRIPT_ANALYSIS_END
].join("\n");
assert.equal(extractTranscriptText(legacyTranscriptWithFrontmatter), "正文内容");

const baseTranscriptForAnalysis = [
	"原始录音：![[Recording]]",
	"来源笔记：[[Daily]]",
	"",
	"# 转写稿 Recording",
	"",
	"正文内容"
].join("\n");
const transcriptWithWorkAnalysis = insertOrReplaceTranscriptAnalysis(
	baseTranscriptForAnalysis,
	workAnalysisBlock,
	"work-minutes",
	"纪要分析 Recording",
	"转写稿 Recording"
);
assert.match(transcriptWithWorkAnalysis, /<!-- echo-notes-analysis:start -->/);
assert.match(transcriptWithWorkAnalysis, /^# 纪要分析 Recording$/m);
assert.match(transcriptWithWorkAnalysis, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(transcriptWithWorkAnalysis, /这是纪要。/);
assert.ok(transcriptWithWorkAnalysis.indexOf(TRANSCRIPT_ANALYSIS_START) < transcriptWithWorkAnalysis.indexOf("# 转写稿 Recording"));

const updatedWorkAnalysisBlock = renderTranscriptAnalysisBlock({
	templateId: "work-minutes",
	templateName: "工作纪要",
	result: {
		text: "## 摘要\n\n这是新纪要。",
		provider: "deepseek",
		model: "deepseek-chat"
	},
	copyLanguage: "zh"
});
const transcriptWithUpdatedWorkAnalysis = insertOrReplaceTranscriptAnalysis(
	transcriptWithWorkAnalysis,
	updatedWorkAnalysisBlock,
	"work-minutes",
	"纪要分析 Recording",
	"转写稿 Recording"
);
assert.doesNotMatch(transcriptWithUpdatedWorkAnalysis, /这是纪要。/);
assert.match(transcriptWithUpdatedWorkAnalysis, /这是新纪要。/);
assert.equal(
	(transcriptWithUpdatedWorkAnalysis.match(/<!-- echo-notes-analysis-item:start work-minutes -->/g) ?? []).length,
	1
);
assert.equal((transcriptWithUpdatedWorkAnalysis.match(/^# 纪要分析 Recording$/gm) ?? []).length, 1);
assert.ok(
	transcriptWithUpdatedWorkAnalysis.indexOf(TRANSCRIPT_ANALYSIS_START) <
		transcriptWithUpdatedWorkAnalysis.indexOf("# 转写稿 Recording")
);

const studyAnalysisBlock = renderTranscriptAnalysisBlock({
	templateId: "study-notes",
	templateName: "学习纪要",
	result: {
		text: "## 核心概念\n\n概念说明。",
		provider: "deepseek",
		model: "deepseek-chat"
	},
	copyLanguage: "zh"
});
const transcriptWithTwoAnalyses = insertOrReplaceTranscriptAnalysis(
	transcriptWithUpdatedWorkAnalysis,
	studyAnalysisBlock,
	"study-notes",
	"纪要分析 Recording",
	"转写稿 Recording"
);
assert.match(transcriptWithTwoAnalyses, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(transcriptWithTwoAnalyses, /<!-- echo-notes-analysis-item:start study-notes -->/);
assert.equal((transcriptWithTwoAnalyses.match(/^# 纪要分析 Recording$/gm) ?? []).length, 1);
assert.ok(transcriptWithTwoAnalyses.indexOf(TRANSCRIPT_ANALYSIS_START) < transcriptWithTwoAnalyses.indexOf("# 转写稿 Recording"));

const legacyBaseTranscriptForAnalysis = [
	"# Recording 转写稿",
	"",
	"原始录音：![[Recording]]",
	"来源笔记：[[Daily]]",
	"",
	"## 转写稿",
	"",
	"正文内容"
].join("\n");
const legacyBottomAnalysisTranscript = [
	legacyBaseTranscriptForAnalysis,
	"",
	TRANSCRIPT_ANALYSIS_START,
	"## AI 纪要分析",
	"",
	workAnalysisBlock,
	TRANSCRIPT_ANALYSIS_END
].join("\n");
const transcriptWithLegacyUpdatedWorkAnalysis = insertOrReplaceTranscriptAnalysis(
	legacyBottomAnalysisTranscript,
	updatedWorkAnalysisBlock,
	"work-minutes",
	"纪要分析 Recording",
	["转写稿 Recording", "转写稿"]
);
assert.equal((transcriptWithLegacyUpdatedWorkAnalysis.match(/## AI 纪要分析/g) ?? []).length, 1);
assert.ok(
	transcriptWithLegacyUpdatedWorkAnalysis.indexOf(TRANSCRIPT_ANALYSIS_START) <
		transcriptWithLegacyUpdatedWorkAnalysis.indexOf("## 转写稿")
);

console.log("Smoke tests passed.");

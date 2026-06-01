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
import { LinkService } from "../src/obsidian/link-service";
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
	PROVIDER_LABELS
} from "../src/settings/settings";
import { renderFailedTranscriptTemplate, renderTranscriptTemplate } from "../src/transcript/transcript-template";

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

assert.match(chineseTranscript, /# Recording 20260531001942 转写稿/);
assert.match(chineseTranscript, /原始录音：!\[\[Recording 20260531001942\]\]/);
assert.match(chineseTranscript, /来源笔记：\[\[Daily\]\]/);
assert.match(chineseTranscript, /## 转写稿/);

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

assert.match(englishTranscript, /# Recording 20260531001942 Transcribed manuscript/);
assert.match(englishTranscript, /Original recording: !\[\[Recording 20260531001942\]\]/);
assert.match(englishTranscript, /Source note: \[\[Daily\]\]/);
assert.match(englishTranscript, /## Transcribed manuscript/);

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

assert.deepEqual(ANALYSIS_TEMPLATE_ORDER, ["work-minutes", "study-notes", "product-requirement-mining"]);
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
assert.deepEqual(Object.keys(ANALYSIS_PROVIDER_LABELS), Object.keys(PROVIDER_LABELS));
assert.deepEqual(Object.keys(ANALYSIS_PROVIDER_DEFAULTS), Object.keys(PROVIDER_LABELS));
assert.equal(DEFAULT_SETTINGS.analysisProvider, "deepseek");
assert.equal(DEFAULT_SETTINGS.analysisBaseUrl, "https://api.deepseek.com/v1");
assert.equal(DEFAULT_SETTINGS.analysisModel, "deepseek-v4-pro");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.deepseek.analysisBaseUrl, "https://api.deepseek.com/v1");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.deepseek.analysisModel, "deepseek-v4-pro");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.siliconflow.analysisBaseUrl, "https://api.siliconflow.cn/v1");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.siliconflow.analysisModel, "deepseek-ai/DeepSeek-V3");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"].analysisModel, "qwen-plus");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.openai.analysisModel, "gpt-4o-mini");
assert.equal(ANALYSIS_PROVIDER_DEFAULTS.groq.analysisModel, "llama-3.3-70b-versatile");
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
assert.equal(normalizedSettings.analysisProvider, "deepseek");
assert.equal(normalizedSettings.analysisModel, "deepseek-v4-pro");
assert.equal(normalizedSettings.defaultAnalysisTemplateId, "work-minutes");
assert.equal(normalizedSettings.analysisTemplates[0].id, "work-minutes");
assert.equal(normalizedSettings.analysisTemplates[0].name, "工作纪要");
assert.equal(normalizedSettings.analysisTemplates[0].enabled, false);
assert.equal(normalizedSettings.analysisTemplates[0].builtin, true);
assert.equal(normalizedSettings.analysisTemplates[0].systemPrompt, DEFAULT_ANALYSIS_SYSTEM_PROMPT);
assert.equal(normalizedSettings.analysisTemplates[3].id, "custom-template");
assert.equal(normalizedSettings.analysisTemplates[3].name, "访谈纪要");
assert.equal(normalizedSettings.analysisTemplates[3].systemPrompt, DEFAULT_ANALYSIS_SYSTEM_PROMPT);
assert.equal(normalizedSettings.analysisTemplates[3].customPrompt, "请输出访谈纪要。");
assert.deepEqual(normalizedSettings.analysisTemplates[3].recognitionKeywords, ["访谈纪要"]);
assert.equal(Object.prototype.hasOwnProperty.call(normalizedSettings, "autoAnalyzeAfterTranscription"), false);
assert.equal(Object.prototype.hasOwnProperty.call(normalizedSettings, "promptForAnalysisTemplateOnTranscription"), false);
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
assert.equal(invalidAnalysisProviderSettings.analysisProvider, "deepseek");
assert.equal(invalidAnalysisProviderSettings.analysisBaseUrl, "https://api.deepseek.com/v1");
assert.equal(invalidAnalysisProviderSettings.analysisModel, "deepseek-v4-pro");
const missingAnalysisProviderSettings = normalizeEchoNotesSettings({
	analysisBaseUrl: "https://example.invalid/v1",
	analysisModel: "wrong-model"
});
assert.equal(missingAnalysisProviderSettings.analysisProvider, "deepseek");
assert.equal(missingAnalysisProviderSettings.analysisBaseUrl, "https://api.deepseek.com/v1");
assert.equal(missingAnalysisProviderSettings.analysisModel, "deepseek-v4-pro");

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
	["work-minutes", "study-notes", "product-requirement-mining", "custom-review"]
);
assert.equal(normalizeAnalysisTemplates([{ id: "custom-review", name: "复盘纪要", prompt: "请复盘。", enabled: true }])[3].customPrompt, "请复盘。");
assert.equal(getDefaultAnalysisTemplate(normalizedSettings)?.id, "study-notes");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里标记为访谈纪要。")?.id, "custom-template");
assert.equal(selectAnalysisTemplateForContext(normalizedSettings, "这里标记为学习纪要。")?.id, "study-notes");
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
		text: "## 摘要\n\n这是纪要。",
		provider: "deepseek",
		model: "deepseek-chat",
		traceId: "trace-1"
	},
	copyLanguage: "zh"
});
assert.match(workAnalysisBlock, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(workAnalysisBlock, /### 工作纪要/);
assert.match(workAnalysisBlock, /Provider：deepseek/);
assert.match(workAnalysisBlock, /模型：deepseek-chat/);
assert.match(workAnalysisBlock, /Trace ID：trace-1/);
assert.match(workAnalysisBlock, /## 摘要/);

const transcriptWithFrontmatter = [
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
	ANALYSIS_LINKS_START,
	"## AI 纪要分析",
	"",
	"- [[Analysis|工作纪要]]",
	ANALYSIS_LINKS_END,
	"",
	TRANSCRIPT_ANALYSIS_START,
	"## AI 纪要分析",
	"",
	workAnalysisBlock,
	TRANSCRIPT_ANALYSIS_END
].join("\n");
assert.equal(extractTranscriptText(transcriptWithFrontmatter), "# Recording 转写稿\n\n## 转写稿\n\n正文内容");

const transcriptWithWorkAnalysis = insertOrReplaceTranscriptAnalysis("正文内容", workAnalysisBlock, "work-minutes", "AI 纪要分析");
assert.match(transcriptWithWorkAnalysis, /<!-- echo-notes-analysis:start -->/);
assert.match(transcriptWithWorkAnalysis, /## AI 纪要分析/);
assert.match(transcriptWithWorkAnalysis, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(transcriptWithWorkAnalysis, /这是纪要。/);

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
	"AI 纪要分析"
);
assert.doesNotMatch(transcriptWithUpdatedWorkAnalysis, /这是纪要。/);
assert.match(transcriptWithUpdatedWorkAnalysis, /这是新纪要。/);
assert.equal(
	(transcriptWithUpdatedWorkAnalysis.match(/<!-- echo-notes-analysis-item:start work-minutes -->/g) ?? []).length,
	1
);
assert.equal((transcriptWithUpdatedWorkAnalysis.match(/## AI 纪要分析/g) ?? []).length, 1);

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
	"AI 纪要分析"
);
assert.match(transcriptWithTwoAnalyses, /<!-- echo-notes-analysis-item:start work-minutes -->/);
assert.match(transcriptWithTwoAnalyses, /<!-- echo-notes-analysis-item:start study-notes -->/);
assert.equal((transcriptWithTwoAnalyses.match(/## AI 纪要分析/g) ?? []).length, 1);

console.log("Smoke tests passed.");

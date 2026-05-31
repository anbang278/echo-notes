import assert from "node:assert/strict";
import {
	extractTranscriptText,
	getAnalysisPathForTranscriptPath,
	insertAnalysisLinkBlock,
	renderAnalysisMarkdown
} from "../src/analysis/analysis-output";
import { ANALYSIS_TEMPLATE_ORDER, buildAnalysisMessages, getCommandAnalysisTemplates } from "../src/analysis/analysis-templates";
import { parseAudioLinks } from "../src/audio/audio-link-parser";
import { LinkService } from "../src/obsidian/link-service";
import {
	createAnalysisTemplateId,
	createCustomAnalysisTemplate,
	DEFAULT_ANALYSIS_TEMPLATES,
	normalizeAnalysisTemplates,
	normalizeEchoNotesSettings
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
assert.match(DEFAULT_ANALYSIS_TEMPLATES["work-minutes"].prompt, /## 摘要/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["work-minutes"].prompt, /## 行动项/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["study-notes"].prompt, /## 核心概念/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["study-notes"].prompt, /## 复习清单/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"].prompt, /## 需求机会/);
assert.match(DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"].prompt, /## 验收标准/);

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
assert.equal(normalizedSettings.promptForAnalysisTemplateOnTranscription, true);
assert.equal(normalizedSettings.analysisTemplates[0].id, "work-minutes");
assert.equal(normalizedSettings.analysisTemplates[0].name, "工作纪要");
assert.equal(normalizedSettings.analysisTemplates[0].enabled, false);
assert.equal(normalizedSettings.analysisTemplates[0].builtin, true);
assert.equal(normalizedSettings.analysisTemplates[3].id, "custom-template");
assert.equal(normalizedSettings.analysisTemplates[3].name, "访谈纪要");
assert.equal(Object.prototype.hasOwnProperty.call(normalizedSettings, "autoAnalyzeAfterTranscription"), false);

assert.equal(createAnalysisTemplateId("review", ["review"]), "review-2");
assert.equal(createCustomAnalysisTemplate("自定义模板", []).id, "custom-template");
assert.deepEqual(
	normalizeAnalysisTemplates([{ id: "custom-review", name: "复盘纪要", prompt: "请复盘。", enabled: true }]).map(
		(template) => template.id
	),
	["work-minutes", "study-notes", "product-requirement-mining", "custom-review"]
);
assert.deepEqual(
	getCommandAnalysisTemplates(normalizedSettings).map((template) => template.id),
	["study-notes", "product-requirement-mining", "custom-template"]
);

const workMinutesPrompt = buildAnalysisMessages({
	template: DEFAULT_ANALYSIS_TEMPLATES["work-minutes"],
	transcriptTitle: "Recording 20260531001942.transcript",
	transcriptText: "张三负责下周提交方案。",
	copyLanguage: "zh"
});
assert.match(workMinutesPrompt.system, /简体中文/);
assert.match(workMinutesPrompt.user, /分析模板：工作纪要/);
assert.match(workMinutesPrompt.user, /行动项/);

const productPrompt = buildAnalysisMessages({
	template: DEFAULT_ANALYSIS_TEMPLATES["product-requirement-mining"],
	transcriptTitle: "Interview.transcript",
	transcriptText: "用户希望减少重复录入。",
	copyLanguage: "en"
});
assert.match(productPrompt.system, /English/);
assert.match(productPrompt.user, /分析模板：产品需求挖掘纪要/);
assert.match(productPrompt.user, /P0\/P1\/P2/);

assert.equal(
	getAnalysisPathForTranscriptPath("Daily/Recording 20260531001942/Recording 20260531001942.transcript.md", "work-minutes"),
	"Daily/Recording 20260531001942/Recording 20260531001942.transcript.analysis.work-minutes.md"
);

const analysisMarkdown = renderAnalysisMarkdown({
	sourceTranscriptLink: "[[Recording 20260531001942.transcript]]",
	transcriptBaseName: "Recording 20260531001942.transcript",
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
assert.match(analysisMarkdown, /type: audio-analysis/);
assert.match(analysisMarkdown, /analysis_template: "work-minutes"/);
assert.match(analysisMarkdown, /provider: "deepseek"/);
assert.match(analysisMarkdown, /model: "deepseek-chat"/);
assert.match(analysisMarkdown, /trace_id: "trace-1"/);
assert.match(analysisMarkdown, /# Recording 20260531001942\.transcript 工作纪要/);
assert.match(analysisMarkdown, /来源转写稿：\[\[Recording 20260531001942\.transcript\]\]/);
assert.match(analysisMarkdown, /## 分析结果/);

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
	"<!-- echo-notes-analysis-links:start -->",
	"## AI 纪要分析",
	"",
	"- [[Analysis|工作纪要]]",
	"<!-- echo-notes-analysis-links:end -->"
].join("\n");
assert.equal(extractTranscriptText(transcriptWithFrontmatter), "# Recording 转写稿\n\n## 转写稿\n\n正文内容");

const analysisLink = "[[Recording 20260531001942.transcript.analysis.work-minutes|工作纪要]]";
const transcriptWithAnalysisLink = insertAnalysisLinkBlock("正文内容", analysisLink, "Recording 20260531001942.transcript.analysis.work-minutes", "AI 纪要分析");
assert.match(transcriptWithAnalysisLink, /<!-- echo-notes-analysis-links:start -->/);
assert.match(transcriptWithAnalysisLink, /## AI 纪要分析/);
assert.match(transcriptWithAnalysisLink, /\[\[Recording 20260531001942\.transcript\.analysis\.work-minutes\|工作纪要\]\]/);
assert.equal(
	insertAnalysisLinkBlock(transcriptWithAnalysisLink, analysisLink, "Recording 20260531001942.transcript.analysis.work-minutes", "AI 纪要分析"),
	transcriptWithAnalysisLink
);

console.log("Smoke tests passed.");

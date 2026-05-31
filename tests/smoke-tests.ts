import assert from "node:assert/strict";
import {
	extractTranscriptText,
	getAnalysisPathForTranscriptPath,
	insertAnalysisLinkBlock,
	renderAnalysisMarkdown
} from "../src/analysis/analysis-output";
import { ANALYSIS_TEMPLATE_ORDER, ANALYSIS_TEMPLATES, buildAnalysisMessages } from "../src/analysis/analysis-templates";
import { parseAudioLinks } from "../src/audio/audio-link-parser";
import { LinkService } from "../src/obsidian/link-service";
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
assert.deepEqual(ANALYSIS_TEMPLATES["work-minutes"].sections.zh, ["摘要", "关键结论", "行动项", "风险/阻塞", "待确认问题"]);
assert.deepEqual(ANALYSIS_TEMPLATES["study-notes"].sections.zh, ["核心概念", "知识要点", "案例/例子", "易混淆点", "复习清单"]);
assert.deepEqual(ANALYSIS_TEMPLATES["product-requirement-mining"].sections.zh, [
	"用户/场景",
	"痛点",
	"需求机会",
	"功能建议",
	"优先级",
	"验收标准",
	"开放问题"
]);

const workMinutesPrompt = buildAnalysisMessages({
	templateId: "work-minutes",
	transcriptTitle: "Recording 20260531001942.transcript",
	transcriptText: "张三负责下周提交方案。",
	copyLanguage: "zh"
});
assert.match(workMinutesPrompt.system, /简体中文/);
assert.match(workMinutesPrompt.user, /关键结论/);
assert.match(workMinutesPrompt.user, /行动项/);

const productPrompt = buildAnalysisMessages({
	templateId: "product-requirement-mining",
	transcriptTitle: "Interview.transcript",
	transcriptText: "用户希望减少重复录入。",
	copyLanguage: "en"
});
assert.match(productPrompt.system, /English/);
assert.match(productPrompt.user, /Requirement opportunities/);
assert.match(productPrompt.user, /Acceptance criteria/);

assert.equal(
	getAnalysisPathForTranscriptPath("Daily/Recording 20260531001942/Recording 20260531001942.transcript.md", "work-minutes"),
	"Daily/Recording 20260531001942/Recording 20260531001942.transcript.analysis.work-minutes.md"
);

const analysisMarkdown = renderAnalysisMarkdown({
	sourceTranscriptLink: "[[Recording 20260531001942.transcript]]",
	transcriptBaseName: "Recording 20260531001942.transcript",
	templateId: "work-minutes",
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

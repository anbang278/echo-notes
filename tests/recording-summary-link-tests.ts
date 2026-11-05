import assert from "node:assert/strict";
import type { App, MarkdownView, TFile } from "obsidian";
import type { AudioFileService } from "../src/audio/audio-file-service";
import { parseAudioLinks } from "../src/audio/audio-link-parser";
import type { LinkService } from "../src/obsidian/link-service";
import { TranscriptLinkService } from "../src/obsidian/transcript-link-service";
import { updateRecordingSummaryContent } from "../src/obsidian/recording-summary-content";
import { RECORDING_SUMMARY_END, RECORDING_SUMMARY_START } from "../src/analysis/recording-summary";

const TIME = "录音时间：08:54–09:16（22分钟）";
const AUDIO = "![[meeting.m4a]]";
const SUMMARY = "新员工通过模拟客户沟通练习销售话术、提问顺序和表达语气。";
const managed = (text = SUMMARY) => `${RECORDING_SUMMARY_START}｜AI 总结：${text}${RECORDING_SUMMARY_END}`;

function update(content: string, summary = SUMMARY) {
	return updateRecordingSummaryContent(content, parseAudioLinks(content)[0], summary);
}

function fixture(initial = `${TIME}\n${AUDIO}\n结尾`) {
	const sourceNote = { path: "Daily.md", extension: "md" } as TFile;
	const audioFile = { path: "Attachments/meeting.m4a", extension: "m4a" } as TFile;
	const transcriptFile = { path: "Attachments/meeting.transcript.md", extension: "md" } as TFile;
	const otherAudio = { path: "Attachments/other.m4a", extension: "m4a" } as TFile;
	const files = new Map([sourceNote, audioFile, transcriptFile, otherAudio].map((file) => [file.path, file]));
	let content = initial;
	let transcript = `---\nsource_note: "[[Daily]]"\nsource_audio: "[[meeting.m4a]]"\nsource_audio_path: "Attachments/meeting.m4a"\n---\n`;
	let editors: MarkdownView["editor"][] = [];
	let disposed = false;
	let fail = false;
	let beforeProcess: (() => void) | undefined;
	let beforeMutation: (() => Promise<void>) | undefined;
	let mutationCount = 0;
	let diskWrites = 0;
	let editorWrites = 0;
	let resolveAudioFile: (path: string) => TFile | null = (path) => path === "meeting.m4a" ? audioFile : path === "other.m4a" ? otherAudio : null;
	const app = {
		vault: {
			getAbstractFileByPath: (path: string) => files.get(path),
			getFileByPath: (path: string) => files.get(path),
			read: async (file: TFile) => file === transcriptFile ? transcript : content,
			process: async (_file: TFile, transform: (text: string) => string) => {
				beforeProcess?.();
				if (fail) throw new Error("disk write failed");
				content = transform(content);
				diskWrites++;
			}
		},
		metadataCache: { getFirstLinkpathDest: (path: string) => path === "Daily" ? sourceNote : null },
		workspace: {
			getLeavesOfType: () => editors.map((editor) => ({ view: { getViewType: () => "markdown", file: sourceNote, editor } }))
		}
	} as unknown as App;
	const linkService = {
		hasTranscriptLinkNear: (text: string) => text.includes("[[transcript]]"),
		insertTranscriptLinkAfterMatch: (text: string, match: { end: number }) => `${text.slice(0, match.end)}\n[[transcript]]${text.slice(match.end)}`
	} as unknown as LinkService;
	const service = new TranscriptLinkService(app, { resolveAudioFile: (path: string) => resolveAudioFile(path) } as unknown as AudioFileService, linkService, {
		isDisposed: () => disposed,
		withMutatingFile: async (_file, operation) => {
			mutationCount++;
			await beforeMutation?.();
			await operation();
		}
	});
	const createEditor = (ownContent?: string) => ({
		getValue: () => ownContent ?? content,
		getLine: (line: number) => (ownContent ?? content).split("\n")[line].replace(/\r$/, ""),
		replaceRange: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
			if (fail) throw new Error("editor write failed");
			assert.equal(from.line, to.line, "摘要只能更新时间行");
			const lines = content.split("\n");
			const offset = lines.slice(0, from.line).reduce((total, line) => total + line.length + 1, 0);
			content = `${content.slice(0, offset + from.ch)}${text}${content.slice(offset + to.ch)}`;
			editorWrites++;
		}
	}) as MarkdownView["editor"];
	return {
		service, sourceNote, audioFile, transcriptFile, files, createEditor,
		anchor: () => service.captureAnchor(sourceNote, audioFile, "meeting.m4a", content),
		content: () => content,
		setContent: (value: string) => { content = value; },
		setTranscript: (value: string) => { transcript = value; },
		setAudioResolver: (value: (path: string) => TFile | null) => { resolveAudioFile = value; },
		setEditors: (value: MarkdownView["editor"][]) => { editors = value; },
		setDisposed: () => { disposed = true; },
		setFail: () => { fail = true; },
		setBeforeProcess: (value: () => void) => { beforeProcess = value; },
		setBeforeMutation: (value: () => Promise<void>) => { beforeMutation = value; },
		counts: () => ({ mutationCount, diskWrites, editorWrites })
	};
}

export async function runRecordingSummaryLinkTests(): Promise<void> {
	for (const suffix of ["", "：", "：手写说明。", "  "]) {
		const original = `前言\n${TIME}${suffix}\n${AUDIO}\n后记`;
		const first = update(original);
		assert.equal(first.status, "inserted");
		assert.equal(first.content, `前言\n${TIME}${suffix}${managed()}\n${AUDIO}\n后记`);
		assert.equal(update(first.content).status, "already-present");
		const changed = update(`${first.content.replace(`\n${AUDIO}`, ` 手写后缀\n${AUDIO}`)}`, "另一段有效用途说明");
		assert.equal(changed.status, "updated");
		assert.equal(changed.content, `前言\n${TIME}${suffix}${managed("另一段有效用途说明")} 手写后缀\n${AUDIO}\n后记`);
	}
	const hiddenTime = `<!--\n${TIME} -->\n${AUDIO}`;
	assert.equal(update(hiddenTime).reason, "missing-recording-time");
	assert.equal(update(`    ${TIME}\n    ${AUDIO}`).status, "skipped");
	assert.equal(update(`${TIME}\n    ${AUDIO}`).reason, "unsupported-audio-context");
	const crlf = `${TIME}：手写\r\n${AUDIO}\r\n结束\r\n`;
	assert.equal(update(crlf).content, `${TIME}：手写${managed()}\r\n${AUDIO}\r\n结束\r\n`);
	const crossDay = `录音时间：2026-11-04 23:50–2026-11-05 00:10（20分钟）\n${AUDIO}`;
	assert.equal(update(crossDay).status, "inserted");
	for (const timing of ["录音时间：08:54–09:16（不到1分钟）", "录音时间：08:54–10:54（2小时）", "录音时间：08:54–10:55（2小时1分钟）"]) {
		assert.equal(update(`${timing}\n${AUDIO}`).status, "inserted");
	}
	for (const prefix of ["普通正文", "录音时间：待定", "录音时间：99:54–09:16（22分钟）", `${TIME}\n`, "", `\`${TIME}\``]) {
		assert.equal(update(`${prefix}\n${AUDIO}`).status, "skipped");
	}
	assert.equal(update(`${TIME}\n${AUDIO}`, "").reason, "invalid-summary");
	assert.equal(update(`${TIME}\n${AUDIO}`, "内容\n换行").reason, "invalid-summary");
	for (const damaged of [RECORDING_SUMMARY_START, RECORDING_SUMMARY_END, `${RECORDING_SUMMARY_END}${RECORDING_SUMMARY_START}`, `${managed()}${managed()}`, "<!-- echo-notes-recording-summary:broken -->", `${RECORDING_SUMMARY_START}不符合托管格式${RECORDING_SUMMARY_END}`]) {
		const original = `${TIME}${damaged}\n${AUDIO}`;
		assert.equal(update(original).reason, "malformed-summary-marker");
		assert.equal(update(original).content, original);
	}

	const disk = fixture();
	const anchor = disk.anchor();
	disk.setContent(`新增前言\n${TIME}：仍需保留\n${AUDIO}\n结尾`);
	assert.equal((await disk.service.insertRecordingSummary(anchor, SUMMARY)).status, "inserted");
	assert.equal(disk.content(), `新增前言\n${TIME}：仍需保留${managed()}\n${AUDIO}\n结尾`);
	assert.equal((await disk.service.insertRecordingSummary(anchor, SUMMARY)).status, "already-present");
	assert.equal((await disk.service.insertRecordingSummary(anchor, "更新用途")).status, "updated");

	const markdown = fixture(`${TIME}\n![音频](meeting.m4a)`);
	assert.equal((await markdown.service.insertRecordingSummary(markdown.anchor(), SUMMARY)).status, "inserted");
	const multi = fixture(`${TIME}\n![[other.m4a]]\n${TIME}：第二段\n${AUDIO}`);
	await multi.service.insertRecordingSummary(multi.anchor(), SUMMARY);
	assert.equal(multi.content(), `${TIME}\n![[other.m4a]]\n${TIME}：第二段${managed()}\n${AUDIO}`);

	const editor = fixture();
	editor.setEditors([editor.createEditor()]);
	assert.equal((await editor.service.insertRecordingSummary(editor.anchor(), SUMMARY)).status, "inserted");
	assert.deepEqual(editor.counts(), { mutationCount: 1, diskWrites: 0, editorWrites: 1 });
	const conflict = fixture();
	conflict.setEditors([conflict.createEditor(), conflict.createEditor("另一份内容")]);
	assert.equal((await conflict.service.insertRecordingSummary(conflict.anchor(), SUMMARY)).reason, "multiple-source-editors");
	const opened = fixture();
	opened.setBeforeProcess(() => opened.setEditors([opened.createEditor()]));
	assert.equal((await opened.service.insertRecordingSummary(opened.anchor(), SUMMARY)).reason, "source-editor-opened");

	for (const fenced of [`\`\`\`md\n${TIME}\n${AUDIO}\n\`\`\``, `<!--\n${TIME}\n${AUDIO}\n-->`]) {
		const ignored = fixture(fenced);
		assert.equal((await ignored.service.insertRecordingSummary(ignored.anchor(), SUMMARY)).reason, "initially-ambiguous");
	}
	const ambiguous = fixture(`${TIME}\n${AUDIO}\n${TIME}\n${AUDIO}`);
	assert.equal((await ambiguous.service.insertRecordingSummary(ambiguous.anchor(), SUMMARY)).reason, "initially-ambiguous");
	const removed = fixture();
	const removedAnchor = removed.anchor();
	removed.setContent(`${TIME}\n移除音频`);
	assert.equal((await removed.service.insertRecordingSummary(removedAnchor, SUMMARY)).reason, "audio-missing");
	const duplicated = fixture();
	const duplicatedAnchor = duplicated.anchor();
	duplicated.setContent(`${TIME}\n${AUDIO}\n${AUDIO}`);
	assert.equal((await duplicated.service.insertRecordingSummary(duplicatedAnchor, SUMMARY)).reason, "ambiguous-audio");
	const sameLine = fixture(`${TIME}\n${AUDIO} ![[other.m4a]]`);
	assert.equal((await sameLine.service.insertRecordingSummary(sameLine.anchor(), SUMMARY)).reason, "multiple-audio-on-line");

	const renamed = fixture();
	const renamedAnchor = renamed.anchor();
	renamed.files.delete(renamed.sourceNote.path);
	renamed.sourceNote.path = "Renamed.md";
	renamed.files.set(renamed.sourceNote.path, renamed.sourceNote);
	assert.equal((await renamed.service.insertRecordingSummary(renamedAnchor, SUMMARY)).sourcePath, "Renamed.md");
	const missingSource = fixture();
	missingSource.files.delete(missingSource.sourceNote.path);
	assert.equal((await missingSource.service.insertRecordingSummary(missingSource.anchor(), SUMMARY)).reason, "source-missing");
	const replacedAudio = fixture();
	replacedAudio.files.set(replacedAudio.audioFile.path, { ...replacedAudio.audioFile } as TFile);
	assert.equal((await replacedAudio.service.insertRecordingSummary(replacedAudio.anchor(), SUMMARY)).reason, "audio-missing");
	for (const useEditor of [false, true]) {
		const failed = fixture();
		if (useEditor) failed.setEditors([failed.createEditor()]);
		failed.setFail();
		assert.equal((await failed.service.insertRecordingSummary(failed.anchor(), SUMMARY)).status, "failed");
	}
	const unloaded = fixture();
	unloaded.setDisposed();
	assert.equal((await unloaded.service.insertRecordingSummary(unloaded.anchor(), SUMMARY)).reason, "plugin-unloaded");
	const stale = fixture();
	assert.equal((await stale.service.insertRecordingSummary(stale.anchor(), SUMMARY, () => false)).reason, "stale-analysis");
	let current = true;
	const late = fixture();
	late.setBeforeProcess(() => { current = false; });
	assert.equal((await late.service.insertRecordingSummary(late.anchor(), SUMMARY, () => current)).reason, "stale-analysis");
	assert.equal(late.content(), `${TIME}\n${AUDIO}\n结尾`);

	const queued = fixture();
	let release: () => void = () => undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	queued.setBeforeMutation(() => gate);
	const first = queued.service.insertRecordingSummary(queued.anchor(), SUMMARY);
	await Promise.resolve();
	const second = queued.service.insertTranscriptLink(queued.anchor(), queued.transcriptFile);
	await Promise.resolve();
	assert.equal(queued.counts().mutationCount, 1, "摘要和回链必须共用同一文件队列");
	release();
	await Promise.all([first, second]);
	assert.equal(queued.content(), `${TIME}${managed()}\n${AUDIO}\n[[transcript]]\n结尾`);

	const restored = fixture("磁盘仍未插入音频");
	restored.setEditors([restored.createEditor(`${TIME}\n${AUDIO}`)]);
	assert.equal((await restored.service.captureTranscriptSourceAnchor(restored.transcriptFile))?.initialReferenceCount, 1);
	restored.setTranscript('---\nsource_note: "[[Daily]]"\nsource_audio_path: "Attachments/meeting.m4a"\n---\n');
	assert.equal((await restored.service.captureTranscriptSourceAnchor(restored.transcriptFile))?.audioFile, restored.audioFile);
	restored.setTranscript('---\nsource_note: ""\n---\n');
	assert.equal(await restored.service.captureTranscriptSourceAnchor(restored.transcriptFile), undefined);
	const shadowed = fixture(`${TIME}：原录音\n![[Attachments/meeting.m4a]]\n${TIME}：另一录音\n![[Transcripts/meeting.m4a]]`);
	const namesake = { path: "Transcripts/meeting.m4a", extension: "m4a" } as TFile;
	shadowed.files.set(namesake.path, namesake);
	shadowed.setAudioResolver((path) => path === "meeting.m4a" ? namesake : shadowed.files.get(path) ?? null);
	assert.equal(await shadowed.service.captureTranscriptSourceAnchor(shadowed.transcriptFile), undefined,
		"短链接与持久音频路径身份冲突时必须跳过，不能选中同名的另一录音");
	assert.equal(shadowed.counts().mutationCount, 0);

	const unresolvedLink = fixture();
	unresolvedLink.setAudioResolver(() => null);
	assert.equal((await unresolvedLink.service.captureTranscriptSourceAnchor(unresolvedLink.transcriptFile))?.audioFile,
		unresolvedLink.audioFile, "链接无法解析时保留精确持久路径身份");

	const movedAudio = fixture();
	movedAudio.files.delete(movedAudio.audioFile.path);
	movedAudio.audioFile.path = "Archive/meeting.m4a";
	movedAudio.files.set(movedAudio.audioFile.path, movedAudio.audioFile);
	assert.equal((await movedAudio.service.captureTranscriptSourceAnchor(movedAudio.transcriptFile))?.audioFile,
		movedAudio.audioFile, "持久路径已失效时允许通过有效链接恢复重命名后的录音");

	const legacyLink = fixture();
	legacyLink.setTranscript('---\nsource_note: "[[Daily]]"\nsource_audio: "[[meeting.m4a]]"\n---\n');
	assert.equal((await legacyLink.service.captureTranscriptSourceAnchor(legacyLink.transcriptFile))?.audioFile, legacyLink.audioFile);

	const nonAudioPath = fixture();
	nonAudioPath.setTranscript('---\nsource_note: "[[Daily]]"\nsource_audio_path: "Daily.md"\n---\n');
	assert.equal(await nonAudioPath.service.captureTranscriptSourceAnchor(nonAudioPath.transcriptFile), undefined,
		"精确路径兜底也必须校验音频类型");
	console.log("Recording summary link tests passed.");
}

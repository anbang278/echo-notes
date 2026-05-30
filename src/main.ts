import { Editor, Notice, Plugin, TFile, type MarkdownFileInfo } from "obsidian";
import { AudioFileService } from "./audio/audio-file-service";
import { isSupportedAudioFile } from "./audio/audio-detector";
import { normalizeAudioLinkPath, parseAudioLinks, type AudioLinkMatch } from "./audio/audio-link-parser";
import { EditorService } from "./obsidian/editor-service";
import { LinkService } from "./obsidian/link-service";
import { createTranscriptionProvider } from "./providers/provider-registry";
import { shouldWriteFailedTranscript, TranscriptionError } from "./providers/transcription-provider";
import { DEFAULT_SETTINGS, type EchoNotesSettings } from "./settings/settings";
import { EchoNotesSettingTab } from "./settings/settings-tab";
import { TranscriptService } from "./transcript/transcript-service";

export default class EchoNotesPlugin extends Plugin {
	settings: EchoNotesSettings = { ...DEFAULT_SETTINGS };

	private audioFileService: AudioFileService;
	private transcriptService: TranscriptService;
	private linkService: LinkService;
	private editorService = new EditorService();
	private processingAudio = new Set<string>();
	private mutatingFiles = new Set<string>();
	private markdownDebounceTimers = new Map<string, number>();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshServices();
		this.addSettingTab(new EchoNotesSettingTab(this.app, this));
		this.registerCommands();
		this.registerAutomation();
	}

	onunload(): void {
		for (const timer of this.markdownDebounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.markdownDebounceTimers.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshServices();
	}

	refreshServices(): void {
		this.audioFileService = new AudioFileService(this.app);
		this.transcriptService = new TranscriptService(this.app, this.settings);
		this.linkService = new LinkService(this.app, this.settings);
	}

	private registerCommands(): void {
		this.addCommand({
			id: "transcribe-selected-audio",
			name: "Transcribe selected audio",
			editorCallback: (editor, view) => {
				void this.handleTranscribeSelectedAudio(editor, view);
			}
		});

		this.addCommand({
			id: "transcribe-all-audio-files-in-current-note",
			name: "Transcribe all audio files in current note",
			editorCallback: (editor, view) => {
				void this.handleTranscribeAllAudioInCurrentNote(editor, view);
			}
		});
	}

	private registerAutomation(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!this.settings.autoTranscribeOnAudioLink || !(file instanceof TFile) || !this.isScannableMarkdown(file)) {
					return;
				}
				if (this.mutatingFiles.has(file.path)) {
					this.log("跳过 Echo Notes 自己触发的 Markdown 修改", file.path);
					return;
				}
				this.scheduleMarkdownScan(file);
			})
		);

		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!this.settings.autoTranscribeOnAudioCreated || !(file instanceof TFile) || !isSupportedAudioFile(file)) {
					return;
				}
				void this.processAudioToTranscript(file, undefined);
			})
		);
	}

	private async handleTranscribeSelectedAudio(editor: Editor, view: MarkdownFileInfo): Promise<void> {
		const sourceNote = view.file;
		if (!sourceNote) {
			new Notice("当前没有可用的 Markdown 文件。");
			return;
		}

		const range = this.editorService.getSelectionOrCurrentLine(editor);
		const matches = parseAudioLinks(range.text);
		if (matches.length === 0) {
			new Notice("没有在选区或当前行中找到音频链接。");
			return;
		}

		const audioMatch = matches[0];
		const audioFile = this.audioFileService.resolveAudioFile(audioMatch.linkPath, sourceNote);
		if (!audioFile) {
			new Notice(`文件不存在或格式不支持：${audioMatch.linkPath}`);
			return;
		}

		const transcriptFile = await this.processAudioToTranscript(audioFile, sourceNote);
		if (!transcriptFile) {
			return;
		}

		const absoluteMatch = toAbsoluteMatch(audioMatch, range.lineStart);
		const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
		if (this.linkService.hasTranscriptLinkNear(editor.getValue(), absoluteMatch, transcriptLink)) {
			new Notice("transcript 链接已存在，已跳过插入。");
			return;
		}

		this.editorService.insertAfterLine(editor, absoluteMatch.lineEnd, transcriptLink);
		new Notice("已插入 transcript 链接。");
	}

	private async handleTranscribeAllAudioInCurrentNote(editor: Editor, view: MarkdownFileInfo): Promise<void> {
		const sourceNote = view.file;
		if (!sourceNote) {
			new Notice("当前没有可用的 Markdown 文件。");
			return;
		}

		const matches = parseAudioLinks(editor.getValue());
		if (matches.length === 0) {
			new Notice("没有在当前笔记中找到音频文件。");
			return;
		}

		let completed = 0;
		let linked = 0;

		for (const audioMatch of [...matches].reverse()) {
			const audioFile = this.audioFileService.resolveAudioFile(audioMatch.linkPath, sourceNote);
			if (!audioFile) {
				new Notice(`文件不存在或格式不支持：${audioMatch.linkPath}`);
				continue;
			}

			const transcriptFile = await this.processAudioToTranscript(audioFile, sourceNote);
			if (!transcriptFile) {
				continue;
			}

			const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
			if (!this.linkService.hasTranscriptLinkNear(editor.getValue(), audioMatch, transcriptLink)) {
				this.editorService.insertAfterLine(editor, audioMatch.lineEnd, transcriptLink);
				linked += 1;
			}
			completed += 1;
		}

		new Notice(`Echo Notes 处理完成：${completed} 个音频，插入 ${linked} 个链接。`);
	}

	private async processAudioToTranscript(audioFile: TFile, sourceNote: TFile | undefined): Promise<TFile | null> {
		const existingTranscript = this.transcriptService.getTranscriptFile(audioFile);
		if (existingTranscript && this.settings.skipExistingTranscript) {
			new Notice("transcript 已存在，已跳过转写。");
			return existingTranscript;
		}

		if (this.processingAudio.has(audioFile.path)) {
			new Notice(`音频正在转写中：${audioFile.name}`);
			return existingTranscript;
		}

		this.processingAudio.add(audioFile.path);
		try {
			new Notice(`开始转写：${audioFile.name}`);
			const provider = createTranscriptionProvider(this.app, this.settings);
			const result = await provider.transcribe({
				audioFile,
				sourceNote,
				language: this.settings.language
			});
			const transcriptFile = await this.transcriptService.writeSuccessTranscript(audioFile, sourceNote, result);
			new Notice(`转写完成：${audioFile.name}`);
			return transcriptFile;
		} catch (error) {
			const message = getErrorMessage(error);
			new Notice(`转写失败：${message}`);
			this.log("转写失败", error);

			if (shouldWriteFailedTranscript(error)) {
				try {
					const traceId = error instanceof TranscriptionError ? error.traceId : undefined;
					return await this.transcriptService.writeFailedTranscript(
						audioFile,
						sourceNote,
						this.settings.provider,
						this.settings.model,
						message,
						traceId
					);
				} catch (writeError) {
					new Notice(`写入失败 transcript 时出错：${getErrorMessage(writeError)}`);
				}
			}

			return null;
		} finally {
			this.processingAudio.delete(audioFile.path);
		}
	}

	private scheduleMarkdownScan(file: TFile): void {
		const existingTimer = this.markdownDebounceTimers.get(file.path);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timer = window.setTimeout(() => {
			this.markdownDebounceTimers.delete(file.path);
			void this.handleAutoMarkdownFile(file);
		}, 1000);
		this.markdownDebounceTimers.set(file.path, timer);
	}

	private async handleAutoMarkdownFile(file: TFile): Promise<void> {
		if (!this.settings.autoTranscribeOnAudioLink || !this.isScannableMarkdown(file)) {
			return;
		}

		const content = await this.app.vault.cachedRead(file);
		const matches = parseAudioLinks(content);
		if (matches.length === 0) {
			return;
		}

		for (const audioMatch of matches) {
			const audioFile = this.audioFileService.resolveAudioFile(audioMatch.linkPath, file);
			if (!audioFile) {
				this.log("自动扫描未能解析音频文件", audioMatch.linkPath);
				continue;
			}

			const transcriptFile = await this.processAudioToTranscript(audioFile, file);
			if (!transcriptFile) {
				continue;
			}

			await this.insertTranscriptLinkIntoFile(file, audioMatch.linkPath, transcriptFile);
		}
	}

	private async insertTranscriptLinkIntoFile(sourceNote: TFile, audioLinkPath: string, transcriptFile: TFile): Promise<void> {
		const normalizedAudioPath = normalizeAudioLinkPath(audioLinkPath);
		const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);

		await this.withMutatingFile(sourceNote, async () => {
			await this.app.vault.process(sourceNote, (content) => {
				const freshMatches = parseAudioLinks(content);
				const freshMatch = freshMatches.find((match) => normalizeAudioLinkPath(match.linkPath) === normalizedAudioPath);
				if (!freshMatch || this.linkService.hasTranscriptLinkNear(content, freshMatch, transcriptLink)) {
					return content;
				}

				return this.linkService.insertTranscriptLinkAfterMatch(content, freshMatch, transcriptLink);
			});
		});
	}

	private async withMutatingFile(file: TFile, operation: () => Promise<void>): Promise<void> {
		this.mutatingFiles.add(file.path);
		try {
			await operation();
		} finally {
			window.setTimeout(() => {
				this.mutatingFiles.delete(file.path);
			}, 1500);
		}
	}

	private isScannableMarkdown(file: TFile): boolean {
		return file.extension === "md" && !file.basename.endsWith(".transcript");
	}

	private log(message: string, ...args: unknown[]): void {
		if (this.settings.verboseLog) {
			console.log(`[Echo Notes] ${message}`, ...args);
		}
	}
}

function toAbsoluteMatch(match: AudioLinkMatch, lineOffset: number): AudioLinkMatch {
	return {
		...match,
		lineStart: match.lineStart + lineOffset,
		lineEnd: match.lineEnd + lineOffset
	};
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

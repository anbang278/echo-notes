import { Editor, Notice, Plugin, TFile, type MarkdownFileInfo } from "obsidian";
import { AnalysisService } from "./analysis/analysis-service";
import {
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	selectAnalysisTemplateForContext
} from "./analysis/analysis-templates";
import { OpenAICompatibleAnalysisProvider } from "./analysis/openai-compatible-analysis-provider";
import { AudioFileService } from "./audio/audio-file-service";
import { isSupportedAudioFile } from "./audio/audio-detector";
import { normalizeAudioLinkPath, parseAudioLinks, type AudioLinkMatch } from "./audio/audio-link-parser";
import { EditorService } from "./obsidian/editor-service";
import { LinkService } from "./obsidian/link-service";
import { createTranscriptionProvider } from "./providers/provider-registry";
import { shouldWriteFailedTranscript, TranscriptionError } from "./providers/transcription-provider";
import { normalizeEchoNotesSettings, type AnalysisTemplateConfig, type EchoNotesSettings } from "./settings/settings";
import { EchoNotesSettingTab } from "./settings/settings-tab";
import { TranscriptService } from "./transcript/transcript-service";

const API_KEY_SECRET_ID = "echo-notes-api-key";
const ANALYSIS_API_KEY_SECRET_ID = "echo-notes-analysis-api-key";

interface ProcessAudioResult {
	transcriptFile: TFile;
	analysisEligible: boolean;
}

export default class EchoNotesPlugin extends Plugin {
	settings: EchoNotesSettings = normalizeEchoNotesSettings(undefined);

	private audioFileService: AudioFileService;
	private transcriptService: TranscriptService;
	private linkService: LinkService;
	private analysisService: AnalysisService;
	private editorService = new EditorService();
	private processingAudio = new Set<string>();
	private processingAnalyses = new Set<string>();
	private mutatingFiles = new Set<string>();
	private markdownDebounceTimers = new Map<string, number>();
	private loadedAt = Date.now();

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
		this.settings = normalizeEchoNotesSettings(await this.loadData());
		await this.migrateApiKeyToSecretStorage();
		await this.migrateAnalysisApiKeyToSecretStorage();
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeEchoNotesSettings(this.settings);
		delete this.settings.apiKey;
		delete this.settings.analysisApiKey;
		await this.saveData(this.settings);
		this.refreshServices();
	}

	getApiKey(): string {
		return this.app.secretStorage.getSecret(API_KEY_SECRET_ID) ?? this.settings.apiKey ?? "";
	}

	async saveApiKey(apiKey: string): Promise<void> {
		this.app.secretStorage.setSecret(API_KEY_SECRET_ID, apiKey);
		if (this.settings.apiKey !== undefined) {
			delete this.settings.apiKey;
			await this.saveSettings();
		}
	}

	getAnalysisApiKey(): string {
		return this.app.secretStorage.getSecret(ANALYSIS_API_KEY_SECRET_ID) ?? this.settings.analysisApiKey ?? "";
	}

	async saveAnalysisApiKey(apiKey: string): Promise<void> {
		this.app.secretStorage.setSecret(ANALYSIS_API_KEY_SECRET_ID, apiKey);
		if (this.settings.analysisApiKey !== undefined) {
			delete this.settings.analysisApiKey;
			await this.saveSettings();
		}
	}

	refreshServices(): void {
		this.audioFileService = new AudioFileService(this.app);
		this.transcriptService = new TranscriptService(this.app, this.settings);
		this.linkService = new LinkService(this.app, this.settings);
		this.analysisService = new AnalysisService(this.app);
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

	private async migrateApiKeyToSecretStorage(): Promise<void> {
		const legacyApiKey = this.settings.apiKey?.trim();
		if (!legacyApiKey) {
			delete this.settings.apiKey;
			return;
		}

		if (!this.app.secretStorage.getSecret(API_KEY_SECRET_ID)) {
			this.app.secretStorage.setSecret(API_KEY_SECRET_ID, legacyApiKey);
		}
		delete this.settings.apiKey;
		await this.saveData(this.settings);
	}

	private async migrateAnalysisApiKeyToSecretStorage(): Promise<void> {
		const legacyApiKey = this.settings.analysisApiKey?.trim();
		if (!legacyApiKey) {
			delete this.settings.analysisApiKey;
			return;
		}

		if (!this.app.secretStorage.getSecret(ANALYSIS_API_KEY_SECRET_ID)) {
			this.app.secretStorage.setSecret(ANALYSIS_API_KEY_SECRET_ID, legacyApiKey);
		}
		delete this.settings.analysisApiKey;
		await this.saveData(this.settings);
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

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				this.app.vault.on("create", (file) => {
					if (!this.settings.autoTranscribeOnAudioCreated || !(file instanceof TFile) || !isSupportedAudioFile(file)) {
						return;
					}
					if (file.stat.ctime < this.loadedAt) {
						return;
					}
					void this.processAudioToTranscript(file, undefined)
						.then((result) => {
							if (result?.analysisEligible) {
								this.startAnalysisTask(result.transcriptFile, this.getDefaultAnalysisTemplateForAnalysis());
							}
						})
						.catch((error) => {
							new Notice(`自动转写失败：${getErrorMessage(error)}`);
							this.log("自动转写失败", error);
						});
				})
			);
		});
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
			new Notice(`文件不存在或格式不支持，请确认链接包含正确的 Vault 路径：${audioMatch.linkPath}`);
			return;
		}

		const absoluteMatch = toAbsoluteMatch(audioMatch, range.lineStart);
		const analysisTemplate = this.resolveAnalysisTemplateForAudioMatch(editor.getValue(), absoluteMatch);
		const result = await this.processAudioToTranscript(audioFile, sourceNote);
		if (!result) {
			return;
		}
		const transcriptFile = result.transcriptFile;

		const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
		if (this.linkService.hasTranscriptLinkNear(editor.getValue(), absoluteMatch, transcriptLink)) {
			new Notice("transcript 链接已存在，已跳过插入。");
		} else {
			this.editorService.insertAfterLine(editor, absoluteMatch.lineEnd, transcriptLink);
			new Notice("已插入 transcript 链接。");
		}

		if (result.analysisEligible) {
			this.startAnalysisTask(transcriptFile, analysisTemplate);
		}
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
				new Notice(`文件不存在或格式不支持，请确认链接包含正确的 Vault 路径：${audioMatch.linkPath}`);
				continue;
			}

			const analysisTemplate = this.resolveAnalysisTemplateForAudioMatch(editor.getValue(), audioMatch);
			const result = await this.processAudioToTranscript(audioFile, sourceNote);
			if (!result) {
				continue;
			}
			const transcriptFile = result.transcriptFile;

			const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
			if (!this.linkService.hasTranscriptLinkNear(editor.getValue(), audioMatch, transcriptLink)) {
				this.editorService.insertAfterLine(editor, audioMatch.lineEnd, transcriptLink);
				linked += 1;
			}
			if (result.analysisEligible) {
				this.startAnalysisTask(transcriptFile, analysisTemplate);
			}
			completed += 1;
		}

		new Notice(`Echo Notes 处理完成：${completed} 个音频，插入 ${linked} 个链接。`);
	}

	private async processAudioToTranscript(
		audioFile: TFile,
		sourceNote: TFile | undefined
	): Promise<ProcessAudioResult | null> {
		const existingTranscript = this.transcriptService.getTranscriptFile(audioFile);
		if (existingTranscript && this.settings.skipExistingTranscript) {
			new Notice("transcript 已存在，已跳过转写。");
			return { transcriptFile: existingTranscript, analysisEligible: true };
		}

		if (this.processingAudio.has(audioFile.path)) {
			new Notice(`音频正在转写中：${audioFile.name}`);
			return existingTranscript ? { transcriptFile: existingTranscript, analysisEligible: true } : null;
		}

		this.processingAudio.add(audioFile.path);
		try {
			new Notice(`开始转写：${audioFile.name}`);
			const provider = createTranscriptionProvider(this.app, this.settings, this.getApiKey());
			const result = await provider.transcribe({
				audioFile,
				sourceNote,
				language: this.settings.language
			});
			const transcriptFile = await this.transcriptService.writeSuccessTranscript(audioFile, sourceNote, result);
			new Notice(`转写完成：${audioFile.name}`);
			return { transcriptFile, analysisEligible: true };
		} catch (error) {
			const message = getErrorMessage(error);
			new Notice(`转写失败：${message}`);
			this.log("转写失败", error);

			if (shouldWriteFailedTranscript(error)) {
				try {
					const traceId = error instanceof TranscriptionError ? error.traceId : undefined;
					const transcriptFile = await this.transcriptService.writeFailedTranscript(
						audioFile,
						sourceNote,
						this.settings.provider,
						this.settings.model,
						message,
						traceId
					);
					return { transcriptFile, analysisEligible: false };
				} catch (writeError) {
					new Notice(`写入失败 transcript 时出错：${getErrorMessage(writeError)}`);
				}
			}

			return null;
		} finally {
			this.processingAudio.delete(audioFile.path);
		}
	}

	private resolveAnalysisTemplateForAudioMatch(content: string, audioMatch: AudioLinkMatch): AnalysisTemplateConfig | null {
		if (!this.settings.analysisEnabled) {
			return null;
		}

		const contextText = getAnalysisContextAroundAudioMatch(content, audioMatch);
		const template = selectAnalysisTemplateForContext(this.settings, contextText);
		if (!template) {
			new Notice("没有启用的 AI 纪要分析模板，已跳过分析。");
			return null;
		}

		this.log(`AI 纪要分析模板：${template.name}`, {
			audioLink: audioMatch.linkPath,
			keywords: template.recognitionKeywords
		});
		return template;
	}

	private getDefaultAnalysisTemplateForAnalysis(): AnalysisTemplateConfig | null {
		if (!this.settings.analysisEnabled) {
			return null;
		}

		const template = getDefaultAnalysisTemplate(this.settings);
		if (!template) {
			new Notice("没有启用的 AI 纪要分析模板，已跳过分析。");
		}
		return template;
	}

	private startAnalysisTask(transcriptFile: TFile, template: AnalysisTemplateConfig | null | undefined): void {
		if (!template || !this.settings.analysisEnabled) {
			return;
		}

		const templateTitle = template.name;
		const processingKey = `${transcriptFile.path}:${template.id}`;
		if (this.processingAnalyses.has(processingKey)) {
			new Notice(`正在后台生成 ${templateTitle}：${transcriptFile.name}`);
			return;
		}

		this.processingAnalyses.add(processingKey);
		new Notice(`后台生成 ${templateTitle}：${transcriptFile.name}`);
		void this.runAnalysisTask(transcriptFile, template, processingKey);
	}

	private async runAnalysisTask(transcriptFile: TFile, template: AnalysisTemplateConfig, processingKey: string): Promise<void> {
		if (!this.settings.analysisEnabled) {
			new Notice("AI 纪要分析未启用，请先在 Echo Notes 设置中开启。");
			this.processingAnalyses.delete(processingKey);
			return;
		}

		const templateTitle = template.name;
		try {
			const transcriptText = await this.analysisService.readTranscriptText(transcriptFile);
			if (!transcriptText.trim()) {
				new Notice("转写稿内容为空，已跳过 AI 纪要分析。");
				return;
			}

			const provider = new OpenAICompatibleAnalysisProvider(this.settings, this.getAnalysisApiKey());
			const result = await provider.analyze({
				template,
				transcriptTitle: transcriptFile.basename,
				transcriptText,
				copyLanguage: this.settings.copyLanguage
			});
			await this.analysisService.writeAnalysisToTranscript(
				transcriptFile,
				template,
				result,
				this.settings.copyLanguage
			);
			new Notice(`${templateTitle} 已写入转写稿：${transcriptFile.name}`);
		} catch (error) {
			new Notice(`${templateTitle} 生成失败：${getErrorMessage(error)}`);
			this.log("AI 纪要分析失败", error);
		} finally {
			this.processingAnalyses.delete(processingKey);
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

			const analysisTemplate = this.resolveAnalysisTemplateForAudioMatch(content, audioMatch);
			const result = await this.processAudioToTranscript(audioFile, file);
			if (!result) {
				continue;
			}
			const transcriptFile = result.transcriptFile;

			await this.insertTranscriptLinkIntoFile(file, audioMatch.linkPath, transcriptFile);
			if (result.analysisEligible) {
				this.startAnalysisTask(transcriptFile, analysisTemplate);
			}
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

import { Editor, Notice, Plugin, TFile, type Hotkey, type MarkdownFileInfo } from "obsidian";
import { createAnalysisProvider } from "./analysis/analysis-provider-registry";
import { AnalysisService } from "./analysis/analysis-service";
import {
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	selectAnalysisTemplateForContext
} from "./analysis/analysis-templates";
import { AudioFileService } from "./audio/audio-file-service";
import { isSupportedAudioFile } from "./audio/audio-detector";
import { normalizeAudioLinkPath, parseAudioLinks, type AudioLinkMatch } from "./audio/audio-link-parser";
import { EditorService } from "./obsidian/editor-service";
import { LinkService } from "./obsidian/link-service";
import { createTranscriptionProvider } from "./providers/provider-registry";
import {
	shouldWriteFailedTranscript,
	TranscriptionError,
	type TranscriptionProgress,
	type TranscriptionSegment
} from "./providers/transcription-provider";
import {
	cloneHotkey,
	normalizeEchoNotesSettings,
	type AnalysisTemplateConfig,
	type EchoNotesHotkeySetting,
	type EchoNotesSettings
} from "./settings/settings";
import { EchoNotesSettingTab } from "./settings/settings-tab";
import { TranscriptService } from "./transcript/transcript-service";

const API_KEY_SECRET_ID = "echo-notes-api-key";
const ANALYSIS_API_KEY_SECRET_ID = "echo-notes-analysis-api-key";
const AUDIO_RECORDER_PLUGIN_ID = "audio-recorder";
const AUDIO_RECORDER_START_COMMAND_ID = "audio-recorder:start";
const AUDIO_RECORDER_STOP_COMMAND_ID = "audio-recorder:stop";

const ECHO_NOTES_COMMAND_IDS = [
	"start-official-audio-recorder",
	"stop-official-audio-recorder",
	"transcribe-selected-audio",
	"transcribe-all-audio-files-in-current-note"
];

interface ProcessAudioResult {
	transcriptFile: TFile;
	analysisEligible: boolean;
}

interface ProcessAudioOptions {
	onTranscriptFileReady?: (transcriptFile: TFile) => Promise<void> | void;
}

interface ObsidianCommandManager {
	executeCommandById?: (id: string) => boolean | void;
	commands?: Record<string, unknown>;
}

interface InternalPlugin {
	enabled?: boolean;
	enable?: (save?: boolean) => Promise<void> | void;
	disable?: (save?: boolean) => Promise<void> | void;
}

interface InternalPlugins {
	plugins?: Record<string, InternalPlugin>;
	getPluginById?: (id: string) => InternalPlugin | null | undefined;
	getEnabledPluginById?: (id: string) => InternalPlugin | null | undefined;
	enablePlugin?: (id: string) => Promise<void> | void;
	disablePlugin?: (id: string) => Promise<void> | void;
	setEnable?: (id: string, enabled: boolean) => Promise<void> | void;
}

interface AppWithInternals {
	commands?: ObsidianCommandManager;
	internalPlugins?: InternalPlugins;
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

	refreshRegisteredCommands(): void {
		this.registerCommands();
	}

	isOfficialAudioRecorderEnabled(): boolean | null {
		const internalPlugins = this.getInternalPlugins();
		const internalPlugin = this.getInternalPlugin(AUDIO_RECORDER_PLUGIN_ID);
		if (!internalPlugins || !internalPlugin) {
			return null;
		}

		if (typeof internalPlugin.enabled === "boolean") {
			return internalPlugin.enabled;
		}

		if (typeof internalPlugins.getEnabledPluginById === "function") {
			return Boolean(internalPlugins.getEnabledPluginById(AUDIO_RECORDER_PLUGIN_ID));
		}

		return null;
	}

	async setOfficialAudioRecorderEnabled(enabled: boolean): Promise<boolean> {
		const internalPlugins = this.getInternalPlugins();
		const internalPlugin = this.getInternalPlugin(AUDIO_RECORDER_PLUGIN_ID);
		if (!internalPlugins || !internalPlugin) {
			new Notice("当前 Obsidian 版本未暴露核心插件录音机内部 API，请到 Core plugins 手动开启 Audio recorder。");
			return false;
		}

		try {
			if (typeof internalPlugins.setEnable === "function") {
				await internalPlugins.setEnable(AUDIO_RECORDER_PLUGIN_ID, enabled);
			} else if (enabled && typeof internalPlugin.enable === "function") {
				await internalPlugin.enable(true);
			} else if (!enabled && typeof internalPlugin.disable === "function") {
				await internalPlugin.disable(true);
			} else if (enabled && typeof internalPlugins.enablePlugin === "function") {
				await internalPlugins.enablePlugin(AUDIO_RECORDER_PLUGIN_ID);
			} else if (!enabled && typeof internalPlugins.disablePlugin === "function") {
				await internalPlugins.disablePlugin(AUDIO_RECORDER_PLUGIN_ID);
			} else {
				new Notice("无法切换 Obsidian 核心插件录音机，请到 Core plugins 手动调整 Audio recorder。");
				return false;
			}
		} catch (error) {
			new Notice(`切换 Obsidian 核心插件录音机失败：${getErrorMessage(error)}`);
			this.log("切换 Obsidian 核心插件录音机失败", error);
			return false;
		}

		new Notice(enabled ? "已开启 Obsidian 核心插件录音机。" : "已关闭 Obsidian 核心插件录音机。");
		return true;
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
		this.removeRegisteredCommands();

		this.addCommand({
			id: "start-official-audio-recorder",
			name: "Start Obsidian core plugin audio recorder",
			hotkeys: this.getCommandHotkeys(this.settings.officialRecorderStartHotkey),
			callback: () => {
				this.executeOfficialAudioRecorderCommand(AUDIO_RECORDER_START_COMMAND_ID, "开始录音");
			}
		});

		this.addCommand({
			id: "stop-official-audio-recorder",
			name: "Stop Obsidian core plugin audio recorder",
			hotkeys: this.getCommandHotkeys(this.settings.officialRecorderStopHotkey),
			callback: () => {
				this.executeOfficialAudioRecorderCommand(AUDIO_RECORDER_STOP_COMMAND_ID, "停止录音");
			}
		});

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
			hotkeys: this.getCommandHotkeys(this.settings.transcribeAllAudioHotkey),
			editorCallback: (editor, view) => {
				void this.handleTranscribeAllAudioInCurrentNote(editor, view);
			}
		});
	}

	private removeRegisteredCommands(): void {
		for (const commandId of ECHO_NOTES_COMMAND_IDS) {
			this.removeCommandIfRegistered(commandId);
			this.removeCommandIfRegistered(`${this.manifest.id}:${commandId}`);
		}
	}

	private removeCommandIfRegistered(commandId: string): void {
		try {
			this.removeCommand(commandId);
		} catch {
			// 命令尚未注册时，部分 Obsidian 版本会抛错。
		}
	}

	private getCommandHotkeys(hotkey: EchoNotesHotkeySetting): Hotkey[] {
		const cloned = cloneHotkey(hotkey);
		return cloned ? [cloned] : [];
	}

	private executeOfficialAudioRecorderCommand(commandId: string, actionLabel: string): void {
		if (this.isOfficialAudioRecorderEnabled() === false) {
			new Notice("Obsidian 核心插件录音机未开启，请先在 Echo Notes 设置中打开。");
			return;
		}

		const commandManager = this.getCommandManager();
		if (commandManager?.commands && !commandManager.commands[commandId]) {
			new Notice(`找不到 Obsidian 核心插件录音机命令：${commandId}`);
			return;
		}

		try {
			const executed = commandManager?.executeCommandById?.(commandId);
			if (executed === false || !commandManager?.executeCommandById) {
				new Notice(`无法执行 Obsidian 核心插件录音机命令：${actionLabel}`);
			}
		} catch (error) {
			new Notice(`Obsidian 核心插件录音机命令执行失败：${getErrorMessage(error)}`);
			this.log("Obsidian 核心插件录音机命令执行失败", error);
		}
	}

	private getCommandManager(): ObsidianCommandManager | undefined {
		return (this.app as unknown as AppWithInternals).commands;
	}

	private getInternalPlugins(): InternalPlugins | undefined {
		return (this.app as unknown as AppWithInternals).internalPlugins;
	}

	private getInternalPlugin(pluginId: string): InternalPlugin | null {
		const internalPlugins = this.getInternalPlugins();
		if (!internalPlugins) {
			return null;
		}

		return (
			internalPlugins.getPluginById?.(pluginId) ??
			internalPlugins.plugins?.[pluginId] ??
			internalPlugins.getEnabledPluginById?.(pluginId) ??
			null
		);
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
		const result = await this.processAudioToTranscript(audioFile, sourceNote, {
			onTranscriptFileReady: async (transcriptFile) => {
				this.insertTranscriptLinkIntoEditor(editor, sourceNote, absoluteMatch, transcriptFile, true);
			}
		});
		if (!result) {
			return;
		}
		const transcriptFile = result.transcriptFile;

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
			const result = await this.processAudioToTranscript(audioFile, sourceNote, {
				onTranscriptFileReady: async (transcriptFile) => {
					if (this.insertTranscriptLinkIntoEditor(editor, sourceNote, audioMatch, transcriptFile, false)) {
						linked += 1;
					}
				}
			});
			if (!result) {
				continue;
			}
			const transcriptFile = result.transcriptFile;
			if (result.analysisEligible) {
				this.startAnalysisTask(transcriptFile, analysisTemplate);
			}
			completed += 1;
		}

		new Notice(`Echo Notes 处理完成：${completed} 个音频，插入 ${linked} 个链接。`);
	}

	private async processAudioToTranscript(
		audioFile: TFile,
		sourceNote: TFile | undefined,
		options: ProcessAudioOptions = {}
	): Promise<ProcessAudioResult | null> {
		let notifiedTranscriptPath: string | null = null;
		const notifyTranscriptFileReady = async (transcriptFile: TFile): Promise<void> => {
			if (notifiedTranscriptPath === transcriptFile.path) {
				return;
			}

			notifiedTranscriptPath = transcriptFile.path;
			await options.onTranscriptFileReady?.(transcriptFile);
		};

		const existingTranscript = this.transcriptService.getTranscriptFile(audioFile);
		if (existingTranscript && this.settings.skipExistingTranscript) {
			new Notice("transcript 已存在，已跳过转写。");
			await notifyTranscriptFileReady(existingTranscript);
			return { transcriptFile: existingTranscript, analysisEligible: true };
		}

		if (this.processingAudio.has(audioFile.path)) {
			new Notice(`音频正在转写中：${audioFile.name}`);
			if (existingTranscript) {
				await notifyTranscriptFileReady(existingTranscript);
			}
			return existingTranscript ? { transcriptFile: existingTranscript, analysisEligible: true } : null;
		}

		this.processingAudio.add(audioFile.path);
		let completedSegments: TranscriptionSegment[] = [];
		try {
			new Notice(`开始转写：${audioFile.name}`);
			const provider = createTranscriptionProvider(this.app, this.settings, this.getApiKey());
			const handleProgress = async (progress: TranscriptionProgress): Promise<void> => {
				if (progress.type === "long-audio-preparing") {
					completedSegments = [];
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						this.settings.model,
						completedSegments
					);
					await notifyTranscriptFileReady(transcriptFile);
					new Notice(`正在准备长音频分段：${audioFile.name}`);
					return;
				}

				if (progress.type === "long-audio-started") {
					completedSegments = [];
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						this.settings.model,
						completedSegments
					);
					await notifyTranscriptFileReady(transcriptFile);
					new Notice(`长音频将分 ${progress.totalSegments} 段逐步转写：${audioFile.name}`);
					return;
				}

				if (progress.type === "segment-started") {
					new Notice(
						`开始转写分段 ${progress.segment.index}/${progress.segment.total}：${audioFile.name}`
					);
					return;
				}

				completedSegments = progress.segments;
				await this.transcriptService.writeTranscribingTranscript(
					audioFile,
					sourceNote,
					provider.id,
					this.settings.model,
					completedSegments
				);
				new Notice(`已写入分段 ${progress.segment.index}/${progress.segment.total}：${audioFile.name}`);
			};
			const result = await provider.transcribe({
				audioFile,
				sourceNote,
				language: this.settings.language,
				onProgress: handleProgress
			});
			const transcriptFile = await this.transcriptService.writeSuccessTranscript(audioFile, sourceNote, result);
			await notifyTranscriptFileReady(transcriptFile);
			new Notice(`转写完成：${audioFile.name}`);
			return { transcriptFile, analysisEligible: true };
		} catch (error) {
			const message = getErrorMessage(error);
			new Notice(`转写失败：${message}`);
			this.log("转写失败", error);

			if (completedSegments.length > 0 || shouldWriteFailedTranscript(error)) {
				try {
					const traceId = error instanceof TranscriptionError ? error.traceId : undefined;
					const transcriptFile = await this.transcriptService.writeFailedTranscript(
						audioFile,
						sourceNote,
						this.settings.provider,
						this.settings.model,
						message,
						traceId,
						completedSegments
					);
					await notifyTranscriptFileReady(transcriptFile);
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

	private insertTranscriptLinkIntoEditor(
		editor: Editor,
		sourceNote: TFile,
		audioMatch: AudioLinkMatch,
		transcriptFile: TFile,
		showNotice: boolean
	): boolean {
		const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
		if (this.linkService.hasTranscriptLinkNear(editor.getValue(), audioMatch, transcriptLink)) {
			if (showNotice) {
				new Notice("transcript 链接已存在，已跳过插入。");
			}
			return false;
		}

		this.editorService.insertAfterLine(editor, audioMatch.lineEnd, transcriptLink);
		if (showNotice) {
			new Notice("已插入 transcript 链接。");
		}
		return true;
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

			const provider = createAnalysisProvider(this.settings, this.getAnalysisApiKey());
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
			const result = await this.processAudioToTranscript(audioFile, file, {
				onTranscriptFileReady: async (transcriptFile) => {
					await this.insertTranscriptLinkIntoFile(file, audioMatch.linkPath, transcriptFile);
				}
			});
			if (!result) {
				continue;
			}
			const transcriptFile = result.transcriptFile;

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

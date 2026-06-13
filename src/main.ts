import { App, Editor, Modal, Notice, Plugin, Setting, TFile, type Hotkey, type MarkdownFileInfo } from "obsidian";
import { createAnalysisProvider } from "./analysis/analysis-provider-registry";
import { AnalysisService } from "./analysis/analysis-service";
import {
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	getEnabledAnalysisTemplates,
	selectAnalysisTemplatesForSourceMarkdown
} from "./analysis/analysis-templates";
import { AudioFileService } from "./audio/audio-file-service";
import { isSupportedAudioFile } from "./audio/audio-detector";
import { createAudioLinkFingerprints } from "./audio/audio-link-fingerprint";
import { normalizeAudioLinkPath, parseAudioLinks, type AudioLinkMatch } from "./audio/audio-link-parser";
import { EditorService } from "./obsidian/editor-service";
import { LinkService } from "./obsidian/link-service";
import { shouldSkipAutomationForPrivateNote } from "./privacy/note-privacy";
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
import { getSanitizedErrorMessage, sanitizeLogValue } from "./security/redaction";
import { redactAnalysisInputText } from "./security/content-redaction";
import {
	buildTranscriptionUploadPreview,
	type UploadPreviewAudioFile
} from "./security/upload-preview";
import { EchoNotesSettingTab } from "./settings/settings-tab";
import { createTaskId, TaskCenterStore, type EchoNotesTask } from "./task-center/task-center-store";
import { ECHO_NOTES_TASK_CENTER_VIEW_TYPE, EchoNotesTaskCenterView } from "./task-center/task-center-view";
import {
	markTranscriptAnalysisDone,
	markTranscriptAnalysisFailed,
	markTranscriptAnalysisPending
} from "./transcript/transcript-analysis-metadata";
import { TranscriptService } from "./transcript/transcript-service";

const API_KEY_SECRET_ID = "echo-notes-api-key";
const ANALYSIS_API_KEY_SECRET_ID = "echo-notes-analysis-api-key";
const AUDIO_RECORDER_PLUGIN_ID = "audio-recorder";
const AUDIO_RECORDER_START_COMMAND_ID = "audio-recorder:start";
const AUDIO_RECORDER_STOP_COMMAND_ID = "audio-recorder:stop";

const ECHO_NOTES_COMMAND_IDS = [
	"start-official-audio-recorder",
	"stop-official-audio-recorder",
	"open-task-center",
	"transcribe-selected-audio",
	"transcribe-all-audio-files-in-current-note",
	"analyze-current-transcript-with-template"
];

interface ProcessAudioResult {
	transcriptFile: TFile;
	analysisEligible: boolean;
}

interface ProcessAudioOptions {
	onTranscriptFileReady?: (transcriptFile: TFile) => Promise<void> | void;
	allowUploadConfirmation?: boolean;
	audioLinkPath?: string;
	forceTranscription?: boolean;
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

interface ObsidianHotkeyManager {
	getHotkeys?: (commandId: string) => Hotkey[] | undefined;
	getDefaultHotkeys?: (commandId: string) => Hotkey[] | undefined;
	setHotkeys?: (commandId: string, hotkeys: Hotkey[]) => void;
	save?: () => Promise<void> | void;
}

interface AppWithInternals {
	internalPlugins?: InternalPlugins;
	hotkeyManager?: ObsidianHotkeyManager;
}

export default class EchoNotesPlugin extends Plugin {
	settings: EchoNotesSettings = normalizeEchoNotesSettings(undefined);

	private audioFileService: AudioFileService;
	private transcriptService: TranscriptService;
	private linkService: LinkService;
	private analysisService: AnalysisService;
	private taskCenter = new TaskCenterStore();
	private editorService = new EditorService();
	private processingAudio = new Set<string>();
	private processingAnalyses = new Set<string>();
	private mutatingFiles = new Set<string>();
	private markdownDebounceTimers = new Map<string, number>();
	private processedMarkdownAudioLinks = new Set<string>();
	private loadedAt = Date.now();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshServices();
		this.addSettingTab(new EchoNotesSettingTab(this.app, this));
		this.registerView(ECHO_NOTES_TASK_CENTER_VIEW_TYPE, (leaf) => new EchoNotesTaskCenterView(leaf, this));
		this.addRibbonIcon("list-checks", "Echo Notes 任务中心", () => {
			void this.activateTaskCenterView();
		});
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

	async activateTaskCenterView(): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(ECHO_NOTES_TASK_CENTER_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("无法打开 Echo Notes Task Center。");
			return;
		}

		await leaf.setViewState({ type: ECHO_NOTES_TASK_CENTER_VIEW_TYPE, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	getTaskCenterTasks(): EchoNotesTask[] {
		return this.taskCenter.getTasks();
	}

	subscribeTaskCenter(listener: () => void): () => void {
		return this.taskCenter.subscribe(listener);
	}

	async retryTaskCenterTask(taskId: string): Promise<boolean> {
		return this.taskCenter.retryTask(taskId);
	}

	clearFinishedTaskCenterTasks(): void {
		this.taskCenter.clearFinishedTasks();
	}

	async openTaskCenterTask(task: EchoNotesTask): Promise<void> {
		const path = task.outputPath ?? task.targetPath;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`任务文件不存在：${path}`);
			return;
		}

		await this.app.workspace.getLeaf(false).openFile(file);
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

	getOfficialAudioRecorderStartHotkey(): EchoNotesHotkeySetting {
		return this.getObsidianCommandHotkey(AUDIO_RECORDER_START_COMMAND_ID, this.settings.officialRecorderStartHotkey);
	}

	getOfficialAudioRecorderStopHotkey(): EchoNotesHotkeySetting {
		return this.getObsidianCommandHotkey(AUDIO_RECORDER_STOP_COMMAND_ID, this.settings.officialRecorderStopHotkey);
	}

	async setOfficialAudioRecorderStartHotkey(hotkey: EchoNotesHotkeySetting): Promise<boolean> {
		const saved = await this.setObsidianCommandHotkey(AUDIO_RECORDER_START_COMMAND_ID, hotkey, "开始录音");
		if (saved) {
			this.settings.officialRecorderStartHotkey = cloneHotkey(hotkey);
		}
		return saved;
	}

	async setOfficialAudioRecorderStopHotkey(hotkey: EchoNotesHotkeySetting): Promise<boolean> {
		const saved = await this.setObsidianCommandHotkey(AUDIO_RECORDER_STOP_COMMAND_ID, hotkey, "停止录音");
		if (saved) {
			this.settings.officialRecorderStopHotkey = cloneHotkey(hotkey);
		}
		return saved;
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
			id: "open-task-center",
			name: "Open Task Center",
			callback: () => {
				void this.activateTaskCenterView();
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

		this.addCommand({
			id: "analyze-current-transcript-with-template",
			name: "Analyze current transcript with selected template",
			callback: () => {
				void this.handleAnalyzeCurrentTranscriptWithTemplate();
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

	private getInternalPlugins(): InternalPlugins | undefined {
		return (this.app as unknown as AppWithInternals).internalPlugins;
	}

	private getHotkeyManager(): ObsidianHotkeyManager | undefined {
		return (this.app as unknown as AppWithInternals).hotkeyManager;
	}

	private getObsidianCommandHotkey(commandId: string, fallback: EchoNotesHotkeySetting): EchoNotesHotkeySetting {
		const hotkeyManager = this.getHotkeyManager();
		const customHotkeys = hotkeyManager?.getHotkeys?.(commandId);
		if (Array.isArray(customHotkeys)) {
			return this.firstHotkeyOrNull(customHotkeys);
		}

		const defaultHotkeys = hotkeyManager?.getDefaultHotkeys?.(commandId);
		if (Array.isArray(defaultHotkeys)) {
			return this.firstHotkeyOrNull(defaultHotkeys);
		}

		return cloneHotkey(fallback);
	}

	private firstHotkeyOrNull(hotkeys: Hotkey[]): EchoNotesHotkeySetting {
		const hotkey = hotkeys[0];
		return hotkey ? cloneHotkey(hotkey) : null;
	}

	private async setObsidianCommandHotkey(
		commandId: string,
		hotkey: EchoNotesHotkeySetting,
		actionLabel: string
	): Promise<boolean> {
		const hotkeyManager = this.getHotkeyManager();
		if (typeof hotkeyManager?.setHotkeys !== "function" || typeof hotkeyManager?.save !== "function") {
			new Notice("当前 Obsidian 版本未暴露快捷键内部 API，请到 Obsidian 快捷键设置中手动修改 Audio recorder。");
			return false;
		}

		try {
			hotkeyManager.setHotkeys(commandId, this.getCommandHotkeys(hotkey));
			await hotkeyManager.save();
			new Notice(`已保存 Obsidian 核心插件录音机${actionLabel}快捷键。`);
			return true;
		} catch (error) {
			new Notice(`保存 Obsidian 核心插件录音机快捷键失败：${getErrorMessage(error)}`);
			this.log("保存 Obsidian 核心插件录音机快捷键失败", { commandId, error });
			return false;
		}
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
					void this.processAudioToTranscript(file, undefined, { allowUploadConfirmation: false })
						.then((result) => {
							if (result?.analysisEligible) {
								this.startAnalysisTasks(result.transcriptFile, this.getDefaultAnalysisTemplatesForAnalysis());
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
		const analysisTemplates = this.resolveAnalysisTemplatesForAudioMatch(editor.getValue(), absoluteMatch);
		const result = await this.processAudioToTranscript(audioFile, sourceNote, {
			audioLinkPath: audioMatch.linkPath,
			onTranscriptFileReady: async (transcriptFile) => {
				this.insertTranscriptLinkIntoEditor(editor, sourceNote, absoluteMatch, transcriptFile, true);
			}
		});
		if (!result) {
			return;
		}
		const transcriptFile = result.transcriptFile;

		if (result.analysisEligible) {
			this.startAnalysisTasks(transcriptFile, analysisTemplates);
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

			const analysisTemplates = this.resolveAnalysisTemplatesForAudioMatch(editor.getValue(), audioMatch);
			const result = await this.processAudioToTranscript(audioFile, sourceNote, {
				audioLinkPath: audioMatch.linkPath,
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
				this.startAnalysisTasks(transcriptFile, analysisTemplates);
			}
			completed += 1;
		}

		new Notice(`Echo Notes 处理完成：${completed} 个音频，插入 ${linked} 个链接。`);
	}

	private async handleAnalyzeCurrentTranscriptWithTemplate(): Promise<void> {
		const transcriptFile = this.app.workspace.getActiveFile();
		if (!transcriptFile || !this.isTranscriptMarkdownFile(transcriptFile)) {
			new Notice("请先打开一个 Echo Notes 转写稿。");
			return;
		}

		if (!this.settings.analysisEnabled) {
			new Notice("AI 纪要分析未启用，请先在 Echo Notes 设置中开启。");
			return;
		}

		const templates = getEnabledAnalysisTemplates(this.settings);
		if (templates.length === 0) {
			new Notice("没有启用的 AI 纪要分析模板。");
			return;
		}

		new AnalysisTemplatePickerModal(this.app, templates, (template) => {
			this.startAnalysisTask(transcriptFile, template);
		}).open();
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

		const transcriptionTaskId = createTaskId("transcription", audioFile.path);
		const existingTranscript = this.transcriptService.getTranscriptFile(audioFile);
		const reusableTranscript =
			existingTranscript && this.settings.skipExistingTranscript && !options.forceTranscription
				? await this.transcriptService.getReusableTranscriptFile(audioFile)
				: null;
		if (reusableTranscript) {
			this.taskCenter.upsertTask({
				id: transcriptionTaskId,
				kind: "transcription",
				title: audioFile.name,
				status: "success",
				stage: "已复用现有 transcript",
				provider: this.settings.provider,
				model: this.settings.model,
				targetPath: audioFile.path,
				sourcePath: sourceNote?.path,
				outputPath: reusableTranscript.path,
				bytes: audioFile.stat.size,
				currentSegment: undefined,
				totalSegments: undefined,
				error: undefined,
				traceId: undefined,
				completedAt: Date.now()
			});
			new Notice("transcript 已存在，已跳过转写。");
			await notifyTranscriptFileReady(reusableTranscript);
			return { transcriptFile: reusableTranscript, analysisEligible: true };
		}

		if (existingTranscript && this.settings.skipExistingTranscript && !options.forceTranscription) {
			this.log("已存在 transcript 但源音频或转写配置不匹配，将重新转写", {
				audioPath: audioFile.path,
				transcriptPath: existingTranscript.path,
				provider: this.settings.provider,
				model: this.settings.model
			});
		}

		if (this.processingAudio.has(audioFile.path)) {
			new Notice(`音频正在转写中：${audioFile.name}`);
			if (existingTranscript) {
				await notifyTranscriptFileReady(existingTranscript);
			}
			return existingTranscript ? { transcriptFile: existingTranscript, analysisEligible: true } : null;
		}

		if (this.settings.confirmBeforeTranscription) {
			if (options.allowUploadConfirmation === false) {
				new Notice("已跳过自动转写：当前开启了手动转写前确认上传。");
				return null;
			}

			const confirmed = await this.confirmTranscriptionUpload(audioFile);
			if (!confirmed) {
				new Notice(`已取消转写：${audioFile.name}`);
				return null;
			}
		}

		this.taskCenter.upsertTask({
			id: transcriptionTaskId,
			kind: "transcription",
			title: audioFile.name,
			status: "running",
			stage: "准备转写",
			provider: this.settings.provider,
			model: this.settings.model,
			targetPath: audioFile.path,
			sourcePath: sourceNote?.path,
			outputPath: undefined,
			bytes: audioFile.stat.size,
			currentSegment: undefined,
			totalSegments: undefined,
			error: undefined,
			traceId: undefined,
			completedAt: undefined,
			retry: {
				label: "重试转写",
				run: () => this.retryTranscriptionTask(audioFile.path, sourceNote?.path, options.audioLinkPath)
			}
		});
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
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: "正在准备长音频分段",
						outputPath: transcriptFile.path,
						currentSegment: 0,
						totalSegments: undefined
					});
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
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `长音频分段已开始，共 ${progress.totalSegments} 段`,
						outputPath: transcriptFile.path,
						currentSegment: 0,
						totalSegments: progress.totalSegments
					});
					new Notice(`长音频将分 ${progress.totalSegments} 段逐步转写：${audioFile.name}`);
					return;
				}

				if (progress.type === "segment-started") {
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `正在转写分段 ${progress.segment.index}/${progress.segment.total}`,
						currentSegment: progress.segment.index,
						totalSegments: progress.segment.total
					});
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
				this.taskCenter.updateTask(transcriptionTaskId, {
					stage: `已写入分段 ${progress.segment.index}/${progress.segment.total}`,
					currentSegment: progress.segment.index,
					totalSegments: progress.segment.total
				});
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
			this.taskCenter.updateTask(transcriptionTaskId, {
				status: "success",
				stage: "转写完成",
				provider: result.provider,
				model: result.model,
				outputPath: transcriptFile.path,
				traceId: result.traceId,
				currentSegment: result.segments?.length,
				totalSegments: result.segments?.length,
				error: undefined,
				completedAt: Date.now()
			});
			new Notice(`转写完成：${audioFile.name}`);
			return { transcriptFile, analysisEligible: true };
		} catch (error) {
			const message = getErrorMessage(error);
			const traceId = error instanceof TranscriptionError ? error.traceId : undefined;
			this.taskCenter.updateTask(transcriptionTaskId, {
				status: "failed",
				stage: "转写失败",
				error: message,
				traceId,
				completedAt: Date.now()
			});
			new Notice(`转写失败：${message}`);
			this.log("转写失败", error);

			if (completedSegments.length > 0 || shouldWriteFailedTranscript(error)) {
				try {
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
					this.taskCenter.updateTask(transcriptionTaskId, {
						outputPath: transcriptFile.path
					});
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

	private async retryTranscriptionTask(audioPath: string, sourcePath: string | undefined, audioLinkPath: string | undefined): Promise<void> {
		const audioFile = this.app.vault.getAbstractFileByPath(audioPath);
		if (!(audioFile instanceof TFile) || !isSupportedAudioFile(audioFile)) {
			const taskId = createTaskId("transcription", audioPath);
			this.taskCenter.upsertTask({
				id: taskId,
				kind: "transcription",
				title: getPathBasename(audioPath),
				status: "failed",
				stage: "无法重试",
				targetPath: audioPath,
				sourcePath,
				error: "音频文件不存在或格式不支持。",
				completedAt: Date.now()
			});
			new Notice(`无法重试转写，音频文件不存在或格式不支持：${audioPath}`);
			return;
		}

		const sourceFile = sourcePath ? this.app.vault.getAbstractFileByPath(sourcePath) : null;
		const sourceNote = sourceFile instanceof TFile ? sourceFile : undefined;
		const result = await this.processAudioToTranscript(audioFile, sourceNote, {
			allowUploadConfirmation: true,
			audioLinkPath,
			forceTranscription: true,
			onTranscriptFileReady: async (transcriptFile) => {
				if (sourceNote && audioLinkPath) {
					await this.insertTranscriptLinkIntoFile(sourceNote, audioLinkPath, transcriptFile);
				}
			}
		});

		if (result?.analysisEligible) {
			this.startAnalysisTasks(result.transcriptFile, this.getDefaultAnalysisTemplatesForAnalysis());
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

	private resolveAnalysisTemplatesForAudioMatch(content: string, audioMatch: AudioLinkMatch): AnalysisTemplateConfig[] {
		if (!this.settings.analysisEnabled) {
			return [];
		}

		const contextText = getAnalysisContextAroundAudioMatch(content, audioMatch);
		const templates = selectAnalysisTemplatesForSourceMarkdown(this.settings, content, contextText);
		if (templates.length === 0) {
			new Notice("没有启用的 AI 纪要分析模板，已跳过分析。");
			return [];
		}

		this.log(`AI 纪要分析模板：${templates.map((template) => template.name).join("、")}`, {
			audioLink: audioMatch.linkPath,
			templates: templates.map((template) => ({
				id: template.id,
				keywords: template.recognitionKeywords
			}))
		});
		return templates;
	}

	private getDefaultAnalysisTemplatesForAnalysis(): AnalysisTemplateConfig[] {
		if (!this.settings.analysisEnabled) {
			return [];
		}

		const template = getDefaultAnalysisTemplate(this.settings);
		if (!template) {
			new Notice("没有启用的 AI 纪要分析模板，已跳过分析。");
		}
		return template ? [template] : [];
	}

	private startAnalysisTasks(transcriptFile: TFile, templates: AnalysisTemplateConfig[]): void {
		for (const template of templates) {
			this.startAnalysisTask(transcriptFile, template);
		}
	}

	private startAnalysisTask(transcriptFile: TFile, template: AnalysisTemplateConfig | null | undefined): void {
		if (!template || !this.settings.analysisEnabled) {
			return;
		}

		const templateTitle = template.name;
		const processingKey = `${transcriptFile.path}:${template.id}`;
		const analysisTaskId = createTaskId("analysis", transcriptFile.path, template.id);
		if (this.processingAnalyses.has(processingKey)) {
			new Notice(`正在后台生成 ${templateTitle}：${transcriptFile.name}`);
			return;
		}

		this.taskCenter.upsertTask({
			id: analysisTaskId,
			kind: "analysis",
			title: `${templateTitle}：${transcriptFile.name}`,
			status: "running",
			stage: "等待 AI 分析返回",
			provider: this.settings.analysisProvider,
			model: this.settings.analysisModel,
			targetPath: transcriptFile.path,
			outputPath: transcriptFile.path,
			error: undefined,
			traceId: undefined,
			completedAt: undefined,
			retry: {
				label: "重试分析",
				run: () => this.startAnalysisTask(transcriptFile, template)
			}
		});
		this.processingAnalyses.add(processingKey);
		new Notice(`后台生成 ${templateTitle}：${transcriptFile.name}`);
		void this.runAnalysisTask(transcriptFile, template, processingKey, analysisTaskId);
	}

	private async runAnalysisTask(
		transcriptFile: TFile,
		template: AnalysisTemplateConfig,
		processingKey: string,
		analysisTaskId: string
	): Promise<void> {
		if (!this.settings.analysisEnabled) {
			this.taskCenter.updateTask(analysisTaskId, {
				status: "skipped",
				stage: "AI 纪要分析未启用",
				completedAt: Date.now()
			});
			new Notice("AI 纪要分析未启用，请先在 Echo Notes 设置中开启。");
			this.processingAnalyses.delete(processingKey);
			return;
		}

		const templateTitle = template.name;
		try {
			await this.updateTranscriptAnalysisMetadata(transcriptFile, (content) =>
				markTranscriptAnalysisPending(content, {
					templateId: template.id,
					provider: this.settings.analysisProvider,
					model: this.settings.analysisModel,
					timestamp: new Date().toISOString()
				})
			);
			const transcriptText = await this.analysisService.readTranscriptText(transcriptFile);
			if (!transcriptText.trim()) {
				await this.updateTranscriptAnalysisMetadata(transcriptFile, (content) =>
					markTranscriptAnalysisFailed(content, {
						templateId: template.id,
						provider: this.settings.analysisProvider,
						model: this.settings.analysisModel,
						timestamp: new Date().toISOString(),
						error: "转写稿内容为空"
					})
				);
				this.taskCenter.updateTask(analysisTaskId, {
					status: "skipped",
					stage: "转写稿内容为空",
					completedAt: Date.now()
				});
				new Notice("转写稿内容为空，已跳过 AI 纪要分析。");
				return;
			}

			const provider = createAnalysisProvider(this.settings, this.getAnalysisApiKey());
			const analysisTranscriptText = this.settings.redactTranscriptBeforeAnalysis
				? redactAnalysisInputText(transcriptText)
				: transcriptText;
			const result = await provider.analyze({
				template,
				transcriptTitle: transcriptFile.basename,
				transcriptText: analysisTranscriptText,
				copyLanguage: this.settings.copyLanguage
			});
			await this.analysisService.writeAnalysisToTranscript(
				transcriptFile,
				template,
				result,
				this.settings.copyLanguage
			);
			await this.updateTranscriptAnalysisMetadata(transcriptFile, (content) =>
				markTranscriptAnalysisDone(content, {
					templateId: template.id,
					provider: result.provider,
					model: result.model,
					timestamp: new Date().toISOString()
				})
			);
			this.taskCenter.updateTask(analysisTaskId, {
				status: "success",
				stage: `${templateTitle} 已写入转写稿`,
				provider: result.provider,
				model: result.model,
				traceId: result.traceId,
				error: undefined,
				completedAt: Date.now()
			});
			new Notice(`${templateTitle} 已写入转写稿：${transcriptFile.name}`);
		} catch (error) {
			const message = getErrorMessage(error);
			await this.updateTranscriptAnalysisMetadata(transcriptFile, (content) =>
				markTranscriptAnalysisFailed(content, {
					templateId: template.id,
					provider: this.settings.analysisProvider,
					model: this.settings.analysisModel,
					timestamp: new Date().toISOString(),
					error: message
				})
			);
			this.taskCenter.updateTask(analysisTaskId, {
				status: "failed",
				stage: "AI 分析失败",
				error: message,
				completedAt: Date.now()
			});
			new Notice(`${templateTitle} 生成失败：${message}`);
			this.log("AI 纪要分析失败", error);
		} finally {
			this.processingAnalyses.delete(processingKey);
		}
	}

	private async updateTranscriptAnalysisMetadata(transcriptFile: TFile, update: (content: string) => string): Promise<void> {
		try {
			await this.app.vault.process(transcriptFile, update);
		} catch (error) {
			this.log("更新 AI 纪要分析 frontmatter 失败", error);
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
		if (shouldSkipAutomationForPrivateNote(content)) {
			this.log("跳过隐私标记笔记的 Markdown 音频链接自动化", file.path);
			return;
		}

		const matches = parseAudioLinks(content);
		if (matches.length === 0) {
			return;
		}

		const fingerprints = createAudioLinkFingerprints(file.path, matches);
		for (const [index, audioMatch] of matches.entries()) {
			const fingerprint = fingerprints[index];
			if (this.processedMarkdownAudioLinks.has(fingerprint)) {
				this.log("跳过已处理的 Markdown 音频链接", {
					source: file.path,
					audioLink: audioMatch.linkPath,
					lineStart: audioMatch.lineStart
				});
				continue;
			}

			const audioFile = this.audioFileService.resolveAudioFile(audioMatch.linkPath, file);
			if (!audioFile) {
				this.log("自动扫描未能解析音频文件", audioMatch.linkPath);
				continue;
			}

			const analysisTemplates = this.resolveAnalysisTemplatesForAudioMatch(content, audioMatch);
			const result = await this.processAudioToTranscript(audioFile, file, {
				allowUploadConfirmation: false,
				audioLinkPath: audioMatch.linkPath,
				onTranscriptFileReady: async (transcriptFile) => {
					await this.insertTranscriptLinkIntoFile(file, audioMatch.linkPath, transcriptFile);
				}
			});
			if (!result) {
				continue;
			}
			this.processedMarkdownAudioLinks.add(fingerprint);
			const transcriptFile = result.transcriptFile;

			if (result.analysisEligible) {
				this.startAnalysisTasks(transcriptFile, analysisTemplates);
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

	private async confirmTranscriptionUpload(audioFile: TFile): Promise<boolean> {
		return new Promise((resolve) => {
			new TranscriptionUploadConfirmModal(this.app, this.settings, audioFile, resolve).open();
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

	private isTranscriptMarkdownFile(file: TFile): boolean {
		return file.extension === "md" && file.basename.endsWith(".transcript");
	}

	private log(message: string, ...args: unknown[]): void {
		if (this.settings.verboseLog) {
			console.log(`[Echo Notes] ${message}`, ...args.map(sanitizeLogValue));
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
	return getSanitizedErrorMessage(error);
}

function getPathBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").filter(Boolean).pop() ?? path;
}

class TranscriptionUploadConfirmModal extends Modal {
	private settings: EchoNotesSettings;
	private audioFile: UploadPreviewAudioFile;
	private onResolved: (confirmed: boolean) => void;
	private resolved = false;

	constructor(app: App, settings: EchoNotesSettings, audioFile: UploadPreviewAudioFile, onResolved: (confirmed: boolean) => void) {
		super(app);
		this.settings = settings;
		this.audioFile = audioFile;
		this.onResolved = onResolved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("echo-notes-upload-confirm-modal");
		this.titleEl.setText("确认上传音频");

		contentEl.createEl("p", {
			text: "Echo Notes 将把以下音频发送给你配置的转写 Provider。确认后才会开始上传。"
		});

		const preview = buildTranscriptionUploadPreview(this.settings, this.audioFile);
		const tableEl = contentEl.createDiv({ cls: "echo-notes-upload-preview-table" });
		for (const row of preview.rows) {
			const rowEl = tableEl.createDiv({ cls: "echo-notes-upload-preview-row" });
			rowEl.createDiv({ cls: "echo-notes-upload-preview-label", text: row.label });
			rowEl.createDiv({ cls: "echo-notes-upload-preview-value", text: row.value });
		}

		if (preview.warnings.length > 0) {
			const warningEl = contentEl.createDiv({ cls: "echo-notes-upload-preview-warning" });
			warningEl.createDiv({ cls: "echo-notes-upload-preview-warning-title", text: "风险提示" });
			const listEl = warningEl.createEl("ul");
			for (const warning of preview.warnings) {
				listEl.createEl("li", { text: warning });
			}
		}

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("取消")
					.onClick(() => {
						this.resolve(false);
					})
			)
			.addButton((button) =>
				button
					.setButtonText("确认上传")
					.setCta()
					.onClick(() => {
						this.resolve(true);
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.onResolved(false);
		}
	}

	private resolve(confirmed: boolean): void {
		if (this.resolved) {
			return;
		}

		this.resolved = true;
		this.onResolved(confirmed);
		this.close();
	}
}

class AnalysisTemplatePickerModal extends Modal {
	private templates: AnalysisTemplateConfig[];
	private onSelect: (template: AnalysisTemplateConfig) => void;

	constructor(app: App, templates: AnalysisTemplateConfig[], onSelect: (template: AnalysisTemplateConfig) => void) {
		super(app);
		this.templates = templates;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("echo-notes-analysis-template-picker-modal");
		this.titleEl.setText("选择 AI 纪要模板");

		const listEl = contentEl.createDiv({ cls: "echo-notes-analysis-template-picker-list" });
		for (const template of this.templates) {
			const itemEl = listEl.createEl("button", { cls: "echo-notes-analysis-template-picker-item" });
			itemEl.type = "button";
			itemEl.createDiv({ cls: "echo-notes-analysis-template-picker-title", text: template.name || template.id });
			itemEl.createDiv({
				cls: "echo-notes-analysis-template-picker-desc",
				text: template.description || template.recognitionKeywords.join("、") || template.id
			});
			itemEl.addEventListener("click", () => {
				this.onSelect(template);
				this.close();
			});
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

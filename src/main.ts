import {
	App,
	Editor,
	FileSystemAdapter,
	MarkdownView,
	Modal,
	Notice,
	Platform,
	Plugin,
	Setting,
	TFile,
	type Hotkey,
	type MarkdownFileInfo
} from "obsidian";
import { createAnalysisProvider } from "./analysis/analysis-provider-registry";
import type { AnalysisResult, ChunkedAnalysisProvider } from "./analysis/analysis-provider";
import { AnalysisService } from "./analysis/analysis-service";
import { diagnoseAnalysisProviderSettings } from "./analysis/analysis-diagnostics";
import { splitAnalysisText, estimateAnalysisTextTokens } from "./analysis/analysis-chunking";
import {
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	getEnabledAnalysisTemplates,
	selectAnalysisTemplatesForSourceMarkdown
} from "./analysis/analysis-templates";
import { AudioFileService } from "./audio/audio-file-service";
import {
	ChunkedMediaRecorder,
	RealtimePcmCapture,
	REALTIME_RECORDING_EXTENSION,
	VaultRecordingSink,
	listAudioInputDevices,
	requestRealtimeMicrophone,
	type AudioInputDevice
} from "./audio/realtime-audio-capture";
import { isSupportedAudioFile } from "./audio/audio-detector";
import { formatSegmentTimeRange, formatSegmentTimestamp } from "./audio/audio-segmenter";
import { createAudioLinkFingerprints } from "./audio/audio-link-fingerprint";
import { normalizeAudioLinkPath, parseAudioLinks, type AudioLinkMatch } from "./audio/audio-link-parser";
import { EditorService } from "./obsidian/editor-service";
import { LinkService } from "./obsidian/link-service";
import { getMissingRealtimeLinkLines } from "./obsidian/realtime-link-insertion";
import { shouldSkipAutomationForPrivateNote } from "./privacy/note-privacy";
import { createTranscriptionProvider } from "./providers/provider-registry";
import { diagnoseTranscriptionProviderSettings } from "./providers/provider-diagnostics";
import {
	shouldWriteFailedTranscript,
	TranscriptionError,
	type StreamingTranscriptionState,
	type TranscriptionProgress,
	type TranscriptionSegment
} from "./providers/transcription-provider";
import {
	AgentPlanRealtimeSession,
	type AgentPlanRealtimeSessionResult
} from "./providers/volcengine-agentplan-realtime-session";
import { normalizeAgentPlanError } from "./providers/volcengine-agentplan-client";
import { loadAgentPlanSocketFactory } from "./providers/volcengine-agentplan-socket";
import {
	cloneHotkey,
	getSelectedTranscriptionConfig,
	isRemovedAnalysisProviderId,
	normalizeEchoNotesSettings,
	type AnalysisTemplateConfig,
	type EchoNotesHotkeySetting,
	type EchoNotesSettings,
	type TranscriptionProviderId
} from "./settings/settings";
import { getSanitizedErrorMessage, sanitizeLogValue } from "./security/redaction";
import { redactAnalysisInputText } from "./security/content-redaction";
import {
	getAnalysisApiKeySecretId,
	getRemovedAnalysisApiKeySecretId,
	getTranscriptionApiKeySecretId,
	migrateLegacySecret,
	migrateSecretIfTargetEmpty
} from "./security/provider-secrets";
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

const LEGACY_API_KEY_SECRET_ID = "echo-notes-api-key";
const LEGACY_ANALYSIS_API_KEY_SECRET_ID = "echo-notes-analysis-api-key";
const AUDIO_RECORDER_PLUGIN_ID = "audio-recorder";
const AUDIO_RECORDER_START_COMMAND_ID = "audio-recorder:start";
const AUDIO_RECORDER_STOP_COMMAND_ID = "audio-recorder:stop";

const ECHO_NOTES_COMMAND_IDS = [
	"start-official-audio-recorder",
	"stop-official-audio-recorder",
	"open-task-center",
	"transcribe-selected-audio",
	"transcribe-all-audio-files-in-current-note",
	"start-realtime-transcription",
	"stop-realtime-transcription",
	"open-active-realtime-transcript",
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

interface ActiveRealtimeRecording {
	audioFile: TFile;
	sourceNote: TFile;
	transcriptFile: TFile;
	mediaStream: MediaStream;
	mediaRecorder: ChunkedMediaRecorder;
	pcmCapture: RealtimePcmCapture;
	agentPlanSession: AgentPlanRealtimeSession;
	startedAt: number;
	streamingState: StreamingTranscriptionState;
	asrError?: Error;
	stopping: boolean;
	writeTimer?: number;
	writeQueue: Promise<void>;
	taskId: string;
}

export default class EchoNotesPlugin extends Plugin {
	settings: EchoNotesSettings = normalizeEchoNotesSettings(undefined);

	private audioFileService: AudioFileService;
	private transcriptService: TranscriptService;
	private linkService: LinkService;
	private analysisService: AnalysisService;
	private taskCenter = new TaskCenterStore();
	private editorService = new EditorService();
	private processingAudio = new Map<string, Promise<ProcessAudioResult | null>>();
	private processingAnalyses = new Set<string>();
	private mutatingFiles = new Set<string>();
	private markdownDebounceTimers = new Map<string, number>();
	private processedMarkdownAudioLinks = new Set<string>();
	private realtimeAudioPaths = new Set<string>();
	private audioInputDevices: AudioInputDevice[] = [];
	private activeRealtimeRecording: ActiveRealtimeRecording | null = null;
	private realtimeRibbonEl: HTMLElement | null = null;
	private realtimeStatusEl: HTMLElement | null = null;
	private realtimeStatusTimer: number | null = null;
	private loadedAt = Date.now();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshServices();
		this.addSettingTab(new EchoNotesSettingTab(this.app, this));
		this.registerView(ECHO_NOTES_TASK_CENTER_VIEW_TYPE, (leaf) => new EchoNotesTaskCenterView(leaf, this));
		this.realtimeRibbonEl = this.addRibbonIcon("audio-lines", "开始 Echo Notes 实时转写", () => {
			if (this.activeRealtimeRecording) {
				void this.stopRealtimeTranscription();
			} else {
				void this.startRealtimeTranscription();
			}
		});
		this.realtimeRibbonEl.addClass("echo-notes-realtime-ribbon");
		this.addRibbonIcon("list-checks", "Echo Notes 任务中心", () => {
			void this.activateTaskCenterView();
		});
		this.realtimeStatusEl = this.addStatusBarItem();
		this.realtimeStatusEl.addClass("echo-notes-realtime-status");
		this.realtimeStatusEl.addEventListener("click", () => {
			if (this.activeRealtimeRecording) {
				void this.stopRealtimeTranscription();
			}
		});
		this.updateRealtimeUi();
		this.registerCommands();
		this.registerAutomation();
	}

	onunload(): void {
		for (const timer of this.markdownDebounceTimers.values()) {
			window.clearTimeout(timer);
		}
		this.markdownDebounceTimers.clear();
		if (this.realtimeStatusTimer !== null) {
			window.clearInterval(this.realtimeStatusTimer);
		}
		if (this.activeRealtimeRecording) {
			this.activeRealtimeRecording.agentPlanSession.abort("Echo Notes 插件已停用。");
			void this.stopRealtimeTranscription();
		}
	}

	async loadSettings(): Promise<void> {
		const loadedSettings = await this.loadData() as Record<string, unknown> | null;
		this.settings = normalizeEchoNotesSettings(loadedSettings);
		const shouldPersistSettingsMigration =
			Boolean(loadedSettings) &&
			JSON.stringify(loadedSettings) !== JSON.stringify(this.settings);
		await this.migrateApiKeyToSecretStorage();
		this.migrateRemovedAnalysisProviderApiKey(loadedSettings);
		await this.migrateAnalysisApiKeyToSecretStorage();
		if (shouldPersistSettingsMigration) {
			await this.saveData(this.settings);
		}
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeEchoNotesSettings(this.settings);
		delete this.settings.apiKey;
		delete this.settings.analysisApiKey;
		await this.saveData(this.settings);
		this.refreshServices();
		this.updateRealtimeUi();
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

	async setTranscribeAllAudioHotkey(hotkey: EchoNotesHotkeySetting): Promise<boolean> {
		const commandId = `${this.manifest.id}:transcribe-all-audio-files-in-current-note`;
		const hotkeyManager = this.getHotkeyManager();
		if (typeof hotkeyManager?.setHotkeys !== "function" || typeof hotkeyManager?.save !== "function") {
			new Notice("当前 Obsidian 版本未暴露快捷键内部 API，请到 Obsidian 快捷键设置中手动修改 Echo Notes 命令。");
			return false;
		}

		try {
			hotkeyManager.setHotkeys(commandId, this.getCommandHotkeys(hotkey));
			await hotkeyManager.save();
			this.settings.transcribeAllAudioHotkey = cloneHotkey(hotkey);
			new Notice("已保存 Echo Notes 转写当前笔记全部音频快捷键。");
			return true;
		} catch (error) {
			const message = getErrorMessage(error);
			new Notice(`保存 Echo Notes 快捷键失败：${message}`);
			this.log("保存 Echo Notes 快捷键失败", { commandId, error: message });
			return false;
		}
	}

	getApiKey(provider: TranscriptionProviderId = getSelectedTranscriptionConfig(this.settings).provider): string {
		return this.app.secretStorage.getSecret(getTranscriptionApiKeySecretId(provider)) ?? this.settings.apiKey ?? "";
	}

	async saveApiKey(provider: TranscriptionProviderId, apiKey: string): Promise<void> {
		try {
			this.app.secretStorage.setSecret(getTranscriptionApiKeySecretId(provider), apiKey);
		} catch (error) {
			this.log("API Key 保存失败", error);
			throw new Error(`无法写入 Obsidian SecretStorage：${getSanitizedErrorMessage(error)}`, { cause: error });
		}
		if (this.settings.apiKey !== undefined) {
			delete this.settings.apiKey;
			await this.saveSettings();
		}
	}

	getCachedAudioInputDevices(): AudioInputDevice[] {
		return this.audioInputDevices.slice();
	}

	async refreshAudioInputDevices(): Promise<AudioInputDevice[]> {
		this.audioInputDevices = await listAudioInputDevices(true);
		const selectedDeviceId = this.settings.realtimeTranscription.inputDeviceId;
		if (selectedDeviceId && !this.audioInputDevices.some((device) => device.deviceId === selectedDeviceId)) {
			this.settings.realtimeTranscription.inputDeviceId = "";
			await this.saveSettings();
			new Notice("原麦克风设备已不可用，已回退到系统默认麦克风。");
		}
		return this.getCachedAudioInputDevices();
	}

	getAnalysisApiKey(): string {
		return this.app.secretStorage.getSecret(getAnalysisApiKeySecretId(this.settings.analysisProvider)) ?? this.settings.analysisApiKey ?? "";
	}

	async saveAnalysisApiKey(apiKey: string): Promise<void> {
		try {
			this.app.secretStorage.setSecret(getAnalysisApiKeySecretId(this.settings.analysisProvider), apiKey);
		} catch (error) {
			this.log("分析 API Key 保存失败", error);
			throw new Error(`无法写入 Obsidian SecretStorage：${getSanitizedErrorMessage(error)}`, { cause: error });
		}
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
			editorCallback: (editor, view) => {
				void this.handleTranscribeAllAudioInCurrentNote(editor, view);
			}
		});

		this.addCommand({
			id: "start-realtime-transcription",
			name: "Start realtime transcription",
			checkCallback: (checking) => {
				const available = !this.activeRealtimeRecording;
				if (available && !checking) {
					void this.startRealtimeTranscription();
				}
				return available;
			}
		});

		this.addCommand({
			id: "stop-realtime-transcription",
			name: "Stop realtime transcription",
			checkCallback: (checking) => {
				const available = Boolean(this.activeRealtimeRecording);
				if (available && !checking) {
					void this.stopRealtimeTranscription();
				}
				return available;
			}
		});

		this.addCommand({
			id: "open-active-realtime-transcript",
			name: "Open active realtime transcript",
			checkCallback: (checking) => {
				const recording = this.activeRealtimeRecording;
				if (recording && !checking) {
					void this.app.workspace.getLeaf(false).openFile(recording.transcriptFile);
				}
				return Boolean(recording);
			}
		});

		this.addCommand({
			id: "analyze-current-transcript-with-template",
			name: "Analyze current transcript with selected template",
			callback: () => {
				void this.handleAnalyzeCurrentTranscriptWithTemplate();
			}
		});

		this.applyConfiguredTranscribeAllAudioHotkey();
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

	private applyConfiguredTranscribeAllAudioHotkey(): void {
		const hotkey = cloneHotkey(this.settings.transcribeAllAudioHotkey);
		if (!hotkey) {
			return;
		}
		this.getHotkeyManager()?.setHotkeys?.(
			`${this.manifest.id}:transcribe-all-audio-files-in-current-note`,
			[hotkey]
		);
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
		const targetSecretId = getTranscriptionApiKeySecretId(getSelectedTranscriptionConfig(this.settings).provider);
		migrateLegacySecret(this.app.secretStorage, LEGACY_API_KEY_SECRET_ID, targetSecretId, this.settings.apiKey);
		if (this.settings.apiKey !== undefined) {
			delete this.settings.apiKey;
			await this.saveData(this.settings);
		}
	}

	private async migrateAnalysisApiKeyToSecretStorage(): Promise<void> {
		const targetSecretId = getAnalysisApiKeySecretId(this.settings.analysisProvider);
		migrateLegacySecret(
			this.app.secretStorage,
			LEGACY_ANALYSIS_API_KEY_SECRET_ID,
			targetSecretId,
			this.settings.analysisApiKey
		);
		if (this.settings.analysisApiKey !== undefined) {
			delete this.settings.analysisApiKey;
			await this.saveData(this.settings);
		}
	}

	private migrateRemovedAnalysisProviderApiKey(loadedSettings: Record<string, unknown> | null): void {
		const provider = typeof loadedSettings?.analysisProvider === "string" ? loadedSettings.analysisProvider : "";
		if (!isRemovedAnalysisProviderId(provider)) {
			return;
		}

		migrateSecretIfTargetEmpty(
			this.app.secretStorage,
			getRemovedAnalysisApiKeySecretId(provider),
			getAnalysisApiKeySecretId("custom-openai-compatible")
		);
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
					if (this.realtimeAudioPaths.has(file.path)) {
						this.log("跳过正在实时录制的音频文件", file.path);
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
		const inFlightTranscription = this.processingAudio.get(audioFile.path);
		if (inFlightTranscription) {
			new Notice(`音频正在转写中：${audioFile.name}`);
			const result = await inFlightTranscription;
			if (result) {
				await options.onTranscriptFileReady?.(result.transcriptFile);
			}
			return result;
		}

		const processingPromise = this.performAudioToTranscript(audioFile, sourceNote, options);
		this.processingAudio.set(audioFile.path, processingPromise);
		try {
			return await processingPromise;
		} finally {
			if (this.processingAudio.get(audioFile.path) === processingPromise) {
				this.processingAudio.delete(audioFile.path);
			}
		}
	}

	private async performAudioToTranscript(
		audioFile: TFile,
		sourceNote: TFile | undefined,
		options: ProcessAudioOptions
	): Promise<ProcessAudioResult | null> {
		const transcriptionConfig = this.settings.offlineTranscription;
		let notifiedTranscriptPath: string | null = null;
		const notifyTranscriptFileReady = async (transcriptFile: TFile): Promise<void> => {
			if (notifiedTranscriptPath === transcriptFile.path) {
				return;
			}

			notifiedTranscriptPath = transcriptFile.path;
			try {
				await options.onTranscriptFileReady?.(transcriptFile);
			} catch (error) {
				const message = getErrorMessage(error);
				new Notice(`转写稿已生成，但来源笔记链接回写失败：${message}`);
				this.log("来源笔记链接回写失败，不影响转写结果", {
					transcriptPath: transcriptFile.path,
					sourcePath: sourceNote?.path,
					error
				});
			}
		};

		const transcriptionTaskId = createTaskId("transcription", audioFile.path);
		const existingTranscript = this.transcriptService.getTranscriptFile(audioFile);
		const reusableTranscript =
			existingTranscript && this.settings.skipExistingTranscript && !options.forceTranscription
				? await this.transcriptService.getReusableTranscriptFile(
						audioFile,
						transcriptionConfig.provider,
						transcriptionConfig.model
					)
				: null;
		if (reusableTranscript) {
			this.taskCenter.upsertTask({
				id: transcriptionTaskId,
				kind: "transcription",
				title: audioFile.name,
				status: "success",
				stage: "已复用现有 transcript",
				provider: transcriptionConfig.provider,
				model: transcriptionConfig.model,
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
				provider: transcriptionConfig.provider,
				model: transcriptionConfig.model
			});
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
			provider: transcriptionConfig.provider,
			model: transcriptionConfig.model,
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
		let completedSegments: TranscriptionSegment[] = [];
		let streamingState: StreamingTranscriptionState | undefined;
		let diagnosticsPassed = false;
		try {
			const diagnostics = diagnoseTranscriptionProviderSettings(
				transcriptionConfig,
				this.getApiKey(transcriptionConfig.provider),
				{ isMobile: Platform.isMobile, usage: "offline" }
			);
			if (!diagnostics.canAttemptTranscription) {
				throw new Error(diagnostics.items.filter((item) => item.severity === "error").map((item) => item.detail).join("；"));
			}
			diagnosticsPassed = true;
			const provider = createTranscriptionProvider(
				this.app,
				transcriptionConfig,
				this.getApiKey(transcriptionConfig.provider)
			);
			const initialTranscriptFile = await this.transcriptService.writeTranscribingTranscript(
				audioFile,
				sourceNote,
				provider.id,
				transcriptionConfig.model,
				completedSegments
			);
			await notifyTranscriptFileReady(initialTranscriptFile);
			this.taskCenter.updateTask(transcriptionTaskId, {
				stage: "正在准备音频",
				outputPath: initialTranscriptFile.path
			});
			new Notice(`已创建转写稿，开始准备音频：${audioFile.name}`);
			const handleProgress = async (progress: TranscriptionProgress): Promise<void> => {
				if (progress.type === "whole-audio-request-started") {
					const attemptText = progress.totalAttempts > 1
						? `尝试 ${progress.attempt}/${progress.totalAttempts} · `
						: "";
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `${attemptText}正在高速上传 ${formatMegabytes(progress.audioBytes)} MB 并等待识别`,
						outputPath: initialTranscriptFile.path
					});
					return;
				}

				if (progress.type === "streaming-result") {
					streamingState = {
						text: progress.text,
						utterances: progress.utterances,
						processedSeconds: progress.processedSeconds,
						totalSeconds: progress.totalSeconds,
						traceId: progress.traceId
					};
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						transcriptionConfig.model,
						completedSegments,
						streamingState
					);
					await notifyTranscriptFileReady(transcriptFile);
					const stableUtteranceCount = progress.utterances?.length ?? 0;
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `正在转写 ${formatSegmentTimestamp(progress.processedSeconds)} / ${formatSegmentTimestamp(progress.totalSeconds)}${stableUtteranceCount > 0 ? `，已写入 ${stableUtteranceCount} 个确定分句` : ""}`,
						outputPath: transcriptFile.path,
						traceId: progress.traceId
					});
					return;
				}

				if (progress.type === "long-audio-preparing") {
					completedSegments = [];
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						transcriptionConfig.model,
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
						transcriptionConfig.model,
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

				if (progress.type === "segment-retrying") {
					const rangeText = progress.segment
						? `（${formatSegmentTimeRange(progress.segment)}）`
						: "";
					const targetText = progress.segment
						? `分段 ${progress.segment.index}/${progress.segment.total}`
						: "整段音频";
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `${targetText}${rangeText} 服务端失败，${Math.round(progress.delayMs / 1000)} 秒后重试 ${progress.attempt}/${progress.maxAttempts}`,
						currentSegment: progress.segment?.index,
						totalSegments: progress.segment?.total
					});
					new Notice(
						`${targetText}${rangeText} 转写失败，正在进行第 ${progress.attempt}/${progress.maxAttempts} 次重试。`
					);
					return;
				}

				if (progress.type === "segment-split") {
					completedSegments = progress.segments;
					await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						transcriptionConfig.model,
						completedSegments
					);
					const rangeText = formatSegmentTimeRange(progress.segment);
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `分段 ${rangeText} 已缩小为 ${progress.replacementSegments.length} 段`,
						currentSegment: completedSegments.length,
						totalSegments: progress.totalSegments
					});
					new Notice(
						`分段 ${rangeText} 持续失败，已自动缩小为 ${progress.replacementSegments.length} 段；已完成内容不会重传。`
					);
					return;
				}

				completedSegments = progress.segments;
				await this.transcriptService.writeTranscribingTranscript(
					audioFile,
					sourceNote,
					provider.id,
					transcriptionConfig.model,
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
				language: transcriptionConfig.language,
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
			const traceId = error instanceof TranscriptionError ? error.traceId ?? streamingState?.traceId : streamingState?.traceId;
			this.taskCenter.updateTask(transcriptionTaskId, {
				status: "failed",
				stage: "转写失败",
				error: message,
				traceId,
				completedAt: Date.now()
			});
			new Notice(`转写失败：${message}`);
			this.log("转写失败", error);

			if (
				diagnosticsPassed &&
				(completedSegments.length > 0 || streamingState?.text.trim() || shouldWriteFailedTranscript(error))
			) {
				try {
					const transcriptFile = await this.transcriptService.writeFailedTranscript(
						audioFile,
						sourceNote,
						transcriptionConfig.provider,
						transcriptionConfig.model,
						message,
						traceId,
						completedSegments,
						streamingState
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

			const diagnostics = diagnoseAnalysisProviderSettings(
				this.settings,
				this.getAnalysisApiKey(),
				transcriptText.length
			);
			if (!diagnostics.canAttemptAnalysis) {
				throw new Error(diagnostics.items.filter((item) => item.severity === "error").map((item) => item.detail).join("；"));
			}
			const provider = createAnalysisProvider(this.settings, this.getAnalysisApiKey());
			const analysisTranscriptText = this.settings.redactTranscriptBeforeAnalysis
				? redactAnalysisInputText(transcriptText)
				: transcriptText;
			const analysisInput = {
				template,
				transcriptTitle: transcriptFile.basename,
				transcriptText: analysisTranscriptText,
				copyLanguage: this.settings.copyLanguage
			};
			const chunks = this.settings.analysisLongTextEnabled
				? splitAnalysisText(analysisTranscriptText, {
						maxCharacters: this.settings.analysisChunkCharacters,
						overlapCharacters: 400
					})
				: [];
			const maxAnalysisChunks = 20;
			if (chunks.length > maxAnalysisChunks) {
				throw new Error(
					`转写稿将产生 ${chunks.length} 个分析分块，超过安全上限 ${maxAnalysisChunks}。请提高分块字符数、缩短转写稿或拆分文件后重试。`
				);
			}
			if (!this.settings.analysisLongTextEnabled && analysisTranscriptText.length > this.settings.analysisChunkCharacters) {
				throw new Error("转写稿超过单次分析安全长度，且长文本分块已关闭。请开启长文本分块分析或拆分转写稿。");
			}
			let result: AnalysisResult;
			if (chunks.length > 1 && isChunkedAnalysisProvider(provider)) {
				const chunkResults: AnalysisResult[] = [];
				for (const chunk of chunks) {
					this.taskCenter.updateTask(analysisTaskId, {
						stage: `正在分析长文本分块 ${chunk.index}/${chunk.total}（约 ${estimateAnalysisTextTokens(chunk.text)} tokens）`
					});
					chunkResults.push(await provider.analyzeChunk({ ...analysisInput, transcriptText: chunk.text }, chunk.index, chunk.total));
				}
				this.taskCenter.updateTask(analysisTaskId, { stage: `正在汇总 ${chunks.length} 个分析分块` });
				result = await provider.synthesizeChunks(analysisInput, chunkResults);
			} else {
				result = await provider.analyze(analysisInput);
			}
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

	private async startRealtimeTranscription(): Promise<void> {
		if (this.activeRealtimeRecording) {
			new Notice("实时转写已经在运行。");
			await this.app.workspace.getLeaf(false).openFile(this.activeRealtimeRecording.transcriptFile);
			return;
		}
		if (Platform.isMobile) {
			new Notice("实时转写仅支持 Obsidian 桌面端；移动端仍可使用离线转写。");
			return;
		}
		if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
			new Notice("实时录音仅支持本地文件系统 Vault。");
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		const sourceNote = view?.file;
		if (!view || !sourceNote || sourceNote.extension !== "md") {
			new Notice("请先打开一篇已保存的 Markdown 笔记，再开始实时转写。");
			return;
		}

		const config = this.settings.realtimeTranscription;
		const apiKey = this.getApiKey(config.provider);
		const diagnostics = diagnoseTranscriptionProviderSettings(config, apiKey, {
			isMobile: false,
			isFileSystemVault: this.app.vault.adapter instanceof FileSystemAdapter,
			usage: "realtime"
		});
		if (!diagnostics.canAttemptTranscription) {
			new Notice(
				`实时转写配置不可用：${diagnostics.items
					.filter((item) => item.severity === "error")
					.map((item) => item.detail)
					.join("；")}`
			);
			return;
		}

		let mediaStream: MediaStream | null = null;
		let mediaRecorder: ChunkedMediaRecorder | null = null;
		let pcmCapture: RealtimePcmCapture | null = null;
		let agentPlanSession: AgentPlanRealtimeSession | null = null;
		let audioPath = "";
		try {
			mediaStream = await requestRealtimeMicrophone(config.inputDeviceId);
			const audioName = `Recording ${formatRecordingTimestamp(new Date())}`;
			const attachmentVault = this.app.vault as typeof this.app.vault & {
				getAvailablePathForAttachments(name: string, extension: string, sourceFile: TFile): Promise<string>;
			};
			audioPath = await attachmentVault.getAvailablePathForAttachments(
				audioName,
				REALTIME_RECORDING_EXTENSION,
				sourceNote
			);
			this.realtimeAudioPaths.add(audioPath);
			const sink = await VaultRecordingSink.create(this.app, audioPath);
			const audioFile = sink.file;
			const startedAt = Date.now();
			const streamingState: StreamingTranscriptionState = {
				text: "",
				provisionalText: "",
				utterances: undefined,
				processedSeconds: 0,
				totalSeconds: 0,
				realtime: true,
				connectionStatus: "正在连接 AgentPlan"
			};
			const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
				audioFile,
				sourceNote,
				config.provider,
				config.model,
				[],
				streamingState
			);
			try {
				this.insertRealtimeLinks(view.editor, sourceNote, audioFile, transcriptFile);
			} catch (error) {
				new Notice("录音和转写稿已创建，但未能写入当前笔记；实时录音仍会继续。");
				this.log("实时录音链接写回失败", error);
			}

			const socketFactory = await loadAgentPlanSocketFactory();
			const session = new AgentPlanRealtimeSession({
				url: config.baseUrl,
				apiKey,
				language: config.language,
				createSocket: socketFactory,
				onProgress: (progress) => {
					const recording = this.activeRealtimeRecording;
					if (!recording || recording.audioFile.path !== audioFile.path) {
						return;
					}
					recording.streamingState.text = progress.text;
					recording.streamingState.utterances = progress.utterances;
					recording.streamingState.provisionalText = progress.provisionalText;
					recording.streamingState.traceId = progress.traceId;
					recording.streamingState.connectionStatus = "AgentPlan 已连接";
					this.queueRealtimeTranscriptWrite(recording);
					this.updateRealtimeTask(recording);
				}
			});
			agentPlanSession = session;
			mediaRecorder = new ChunkedMediaRecorder(mediaStream, sink);
			pcmCapture = new RealtimePcmCapture(mediaStream, (packet) => {
				const recording = this.activeRealtimeRecording;
				if (!recording || recording.asrError) {
					return;
				}
				try {
					session.pushPcm(packet);
				} catch (error) {
					recording.asrError = normalizeAgentPlanError(error);
					recording.streamingState.connectionStatus = "AgentPlan 已中断，本地录音继续";
					this.queueRealtimeTranscriptWrite(recording, true);
				}
			});
			const taskId = createTaskId("transcription", audioFile.path, "realtime");
			const recording: ActiveRealtimeRecording = {
				audioFile,
				sourceNote,
				transcriptFile,
				mediaStream,
				mediaRecorder,
				pcmCapture,
				agentPlanSession,
				startedAt,
				streamingState,
				stopping: false,
				writeQueue: Promise.resolve(),
				taskId
			};
			this.activeRealtimeRecording = recording;
			this.taskCenter.upsertTask({
				id: taskId,
				kind: "transcription",
				title: audioFile.name,
				status: "running",
				stage: "正在实时录音，连接 AgentPlan",
				provider: config.provider,
				model: config.model,
				targetPath: audioFile.path,
				sourcePath: sourceNote.path,
				outputPath: transcriptFile.path,
				bytes: 0,
				error: undefined,
				traceId: undefined,
				completedAt: undefined
			});
			mediaRecorder.start();
			await pcmCapture.start();
			void agentPlanSession.start().catch((error) => {
				if (!this.activeRealtimeRecording || this.activeRealtimeRecording !== recording) {
					return;
				}
				recording.asrError = normalizeAgentPlanError(error);
				recording.streamingState.connectionStatus = "AgentPlan 已中断，本地录音继续";
				this.queueRealtimeTranscriptWrite(recording, true);
				this.updateRealtimeTask(recording);
			});
			this.startRealtimeStatusTimer();
			this.updateRealtimeUi();
			new Notice(`已开始实时转写：${audioFile.name}`);
		} catch (error) {
			agentPlanSession?.abort("实时录音启动失败，已中止 AgentPlan 会话。");
			await pcmCapture?.stop().catch(() => undefined);
			await mediaRecorder?.stop().catch(() => undefined);
			mediaStream?.getTracks().forEach((track) => track.stop());
			if (audioPath) {
				this.realtimeAudioPaths.delete(audioPath);
			}
			this.activeRealtimeRecording = null;
			this.updateRealtimeUi();
			new Notice(`无法开始实时转写：${getErrorMessage(error)}`);
			this.log("开始实时转写失败", error);
		}
	}

	private async stopRealtimeTranscription(): Promise<void> {
		const recording = this.activeRealtimeRecording;
		if (!recording || recording.stopping) {
			return;
		}
		recording.stopping = true;
		recording.streamingState.connectionStatus = "正在完成录音和最终识别";
		this.queueRealtimeTranscriptWrite(recording, true);
		this.updateRealtimeUi();

		let remainder: Uint8Array | null = null;
		try {
			remainder = await recording.pcmCapture.stop();
		} catch (error) {
			recording.asrError ??= toError(error);
		}
		if (remainder && !recording.asrError) {
			try {
				recording.agentPlanSession.pushPcm(remainder);
			} catch (error) {
				recording.asrError = normalizeAgentPlanError(error);
			}
		}

		const audioResult = recording.mediaRecorder.stop();
		const asrResult: Promise<AgentPlanRealtimeSessionResult> = recording.asrError
			? Promise.reject(recording.asrError)
			: recording.agentPlanSession.finish();
		const [savedAudio, finalAsr] = await Promise.allSettled([audioResult, asrResult]);
		recording.mediaStream.getTracks().forEach((track) => track.stop());
		recording.streamingState.processedSeconds = (Date.now() - recording.startedAt) / 1000;

		const audioSaveError =
			savedAudio.status === "rejected"
				? new Error(`本地录音保存失败：${getErrorMessage(savedAudio.reason)}`)
				: null;
		if (recording.writeTimer !== undefined) {
			window.clearTimeout(recording.writeTimer);
			recording.writeTimer = undefined;
		}

		if (finalAsr.status === "fulfilled" && !audioSaveError) {
			const result = finalAsr.value;
			await recording.writeQueue;
			const transcriptFile = await this.transcriptService.writeSuccessTranscript(
				recording.audioFile,
				recording.sourceNote,
				{
					text: result.text,
					utterances: result.utterances,
					provider: this.settings.realtimeTranscription.provider,
					model: this.settings.realtimeTranscription.model,
					traceId: result.traceId,
					raw: result.raw
				}
			);
			recording.transcriptFile = transcriptFile;
			this.taskCenter.updateTask(recording.taskId, {
				status: "success",
				stage: "实时转写完成",
				bytes: savedAudio.status === "fulfilled" ? savedAudio.value : undefined,
				outputPath: transcriptFile.path,
				traceId: result.traceId,
				error: undefined,
				completedAt: Date.now()
			});
			new Notice(`实时转写完成：${recording.audioFile.name}`);
			this.startAnalysisTasks(
				transcriptFile,
				this.getDefaultAnalysisTemplatesForAnalysis()
			);
		} else {
			if (finalAsr.status === "fulfilled") {
				recording.streamingState.text = finalAsr.value.text;
				recording.streamingState.utterances = finalAsr.value.utterances;
				recording.streamingState.traceId = finalAsr.value.traceId;
			}
			const error =
				audioSaveError ??
				normalizeAgentPlanError(
					finalAsr.status === "rejected"
						? finalAsr.reason
						: recording.asrError ?? "AgentPlan 实时转写失败"
				);
			recording.streamingState.provisionalText = "";
			recording.streamingState.connectionStatus = audioSaveError
				? "本地录音保存失败"
				: "实时识别已中断";
			await recording.writeQueue;
			const transcriptFile = await this.transcriptService.writeFailedTranscript(
				recording.audioFile,
				recording.sourceNote,
				this.settings.realtimeTranscription.provider,
				this.settings.realtimeTranscription.model,
				getErrorMessage(error),
				recording.streamingState.traceId,
				[],
				recording.streamingState
			);
			recording.transcriptFile = transcriptFile;
			this.taskCenter.updateTask(recording.taskId, {
				status: "failed",
				stage: audioSaveError
					? "本地录音保存失败，转写内容已保留"
					: "实时识别中断，本地录音已保留",
				bytes: savedAudio.status === "fulfilled" ? savedAudio.value : undefined,
				outputPath: transcriptFile.path,
				error: getErrorMessage(error),
				traceId: recording.streamingState.traceId,
				completedAt: Date.now(),
				retry: {
					label: "使用离线 Provider 重试",
					run: () => this.retryTranscriptionTask(
						recording.audioFile.path,
						recording.sourceNote.path,
						recording.audioFile.path
					)
				}
			});
			new Notice(
				audioSaveError
					? `实时转写已结束，但本地录音保存失败：${getErrorMessage(error)}`
					: `实时识别已中断，本地录音和部分文字已保留：${getErrorMessage(error)}`
			);
		}

		this.realtimeAudioPaths.delete(recording.audioFile.path);
		this.activeRealtimeRecording = null;
		this.stopRealtimeStatusTimer();
		this.updateRealtimeUi();
	}

	private insertRealtimeLinks(editor: Editor, sourceNote: TFile, audioFile: TFile, transcriptFile: TFile): void {
		const audioLink = this.app.fileManager.generateMarkdownLink(audioFile, sourceNote.path);
		const transcriptLink = this.linkService.createTranscriptLink(transcriptFile, sourceNote.path);
		const content = editor.getValue();
		const missingLines = getMissingRealtimeLinkLines(content, audioLink, transcriptLink);
		if (missingLines.length === 0) {
			return;
		}
		const block = missingLines.join("\n");
		const insertAt = editor.getCursor("to");
		const leadingNewline = insertAt.ch > 0 ? "\n" : "";
		this.mutatingFiles.add(sourceNote.path);
		editor.replaceRange(`${leadingNewline}${block}\n`, insertAt);
		window.setTimeout(() => this.mutatingFiles.delete(sourceNote.path), 1500);
	}

	private queueRealtimeTranscriptWrite(recording: ActiveRealtimeRecording, force = false): void {
		recording.streamingState.processedSeconds = (Date.now() - recording.startedAt) / 1000;
		if (recording.writeTimer !== undefined) {
			if (!force) {
				return;
			}
			window.clearTimeout(recording.writeTimer);
			recording.writeTimer = undefined;
		}
		const write = (): void => {
			recording.writeTimer = undefined;
			recording.writeQueue = recording.writeQueue
				.then(async () => {
					recording.transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						recording.audioFile,
						recording.sourceNote,
						this.settings.realtimeTranscription.provider,
						this.settings.realtimeTranscription.model,
						[],
						{ ...recording.streamingState }
					);
				})
				.catch((error) => {
					this.log("实时转写稿写入失败", error);
				});
		};
		if (force) {
			write();
		} else {
			recording.writeTimer = window.setTimeout(write, 500);
		}
	}

	private updateRealtimeTask(recording: ActiveRealtimeRecording): void {
		const elapsed = Math.max(0, Math.round((Date.now() - recording.startedAt) / 1000));
		const utteranceCount = recording.streamingState.utterances?.length ?? 0;
		this.taskCenter.updateTask(recording.taskId, {
			stage: `实时录音 ${formatSegmentTimestamp(elapsed)} · ${recording.streamingState.connectionStatus ?? "连接中"} · ${utteranceCount} 个确定分句`,
			traceId: recording.streamingState.traceId
		});
		this.updateRealtimeUi();
	}

	private startRealtimeStatusTimer(): void {
		this.stopRealtimeStatusTimer();
		this.realtimeStatusTimer = window.setInterval(() => {
			const recording = this.activeRealtimeRecording;
			if (!recording) {
				return;
			}
			this.updateRealtimeTask(recording);
			this.queueRealtimeTranscriptWrite(recording);
		}, 1000);
	}

	private stopRealtimeStatusTimer(): void {
		if (this.realtimeStatusTimer !== null) {
			window.clearInterval(this.realtimeStatusTimer);
			this.realtimeStatusTimer = null;
		}
	}

	private updateRealtimeUi(): void {
		const recording = this.activeRealtimeRecording;
		if (this.realtimeRibbonEl) {
			this.realtimeRibbonEl.toggleClass("is-active", Boolean(recording));
			this.realtimeRibbonEl.toggle(
				!Platform.isMobile &&
					(this.settings.transcriptionMode === "realtime" || Boolean(recording))
			);
			this.realtimeRibbonEl.setAttribute(
				"aria-label",
				recording ? "停止 Echo Notes 实时转写" : "开始 Echo Notes 实时转写"
			);
		}
		if (!this.realtimeStatusEl) {
			return;
		}
		if (!recording) {
			this.realtimeStatusEl.empty();
			this.realtimeStatusEl.hide();
			return;
		}
		const elapsed = Math.max(0, Math.round((Date.now() - recording.startedAt) / 1000));
		this.realtimeStatusEl.setText(
			`Echo Notes ${formatSegmentTimestamp(elapsed)} · ${recording.streamingState.connectionStatus ?? "连接中"}`
		);
		this.realtimeStatusEl.show();
	}

	private scheduleMarkdownScan(file: TFile): void {
		const existingTimer = this.markdownDebounceTimers.get(file.path);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timer = window.setTimeout(() => {
			this.markdownDebounceTimers.delete(file.path);
			void this.handleAutoMarkdownFile(file).catch((error) => {
				this.log("Markdown 音频链接自动化扫描失败", {
					path: file.path,
					error: getErrorMessage(error)
				});
				new Notice(`Echo Notes 自动化扫描失败：${getErrorMessage(error)}`);
			});
		}, 1000);
		this.markdownDebounceTimers.set(file.path, timer);
	}

	private async handleAutoMarkdownFile(file: TFile): Promise<void> {
		if (!this.settings.autoTranscribeOnAudioLink || !this.isScannableMarkdown(file)) {
			return;
		}
		const currentFile = this.app.vault.getAbstractFileByPath(file.path);
		if (!(currentFile instanceof TFile) || currentFile !== file) {
			this.log("跳过已移动或删除的 Markdown 文件", file.path);
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
			console.debug(`[Echo Notes] ${message}`, ...args.map(sanitizeLogValue));
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

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function formatRecordingTimestamp(date: Date): string {
	const pad = (value: number): string => value.toString().padStart(2, "0");
	return [
		date.getFullYear(),
		pad(date.getMonth() + 1),
		pad(date.getDate()),
		pad(date.getHours()),
		pad(date.getMinutes()),
		pad(date.getSeconds())
	].join("");
}

function isChunkedAnalysisProvider(provider: unknown): provider is ChunkedAnalysisProvider {
	return (
		typeof provider === "object" &&
		provider !== null &&
		"analyzeChunk" in provider &&
		typeof provider.analyzeChunk === "function" &&
		"synthesizeChunks" in provider &&
		typeof provider.synthesizeChunks === "function"
	);
}

function getPathBasename(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	return normalized.split("/").filter(Boolean).pop() ?? path;
}

function formatMegabytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
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

		const preview = buildTranscriptionUploadPreview(
			{
				...this.settings.offlineTranscription,
				analysisEnabled: this.settings.analysisEnabled,
				analysisProvider: this.settings.analysisProvider,
				analysisBaseUrl: this.settings.analysisBaseUrl,
				analysisModel: this.settings.analysisModel
			},
			this.audioFile
		);
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

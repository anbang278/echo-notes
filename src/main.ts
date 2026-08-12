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
	setIcon,
	TFile,
	type Hotkey,
	type MarkdownFileInfo
} from "obsidian";
import { createAnalysisProvider } from "./analysis/analysis-provider-registry";
import type { AnalysisResult, ChunkedAnalysisProvider } from "./analysis/analysis-provider";
import { analyzeChunkSequence } from "./analysis/analysis-chunked-service";
import { AnalysisService } from "./analysis/analysis-service";
import { diagnoseAnalysisProviderSettings } from "./analysis/analysis-diagnostics";
import { splitAnalysisText, estimateAnalysisTextTokens } from "./analysis/analysis-chunking";
import {
	ANALYSIS_CHECKPOINT_MAX_CHUNKS,
	createAnalysisCheckpoint,
	createAnalysisCheckpointIdentity,
	prepareAnalysisCheckpointResult
} from "./analysis/analysis-checkpoint";
import {
	getAnalysisContextAroundAudioMatch,
	getDefaultAnalysisTemplate,
	getEnabledAnalysisTemplates,
	selectAnalysisTemplatesForSourceMarkdown
} from "./analysis/analysis-templates";
import { AudioFileService } from "./audio/audio-file-service";
import {
	DiagnosticStore
} from "./diagnostics/diagnostic-store";
import { createDiagnosticArchive, type DiagnosticExportContent } from "./diagnostics/diagnostic-export";
import {
	DiagnosticExportCompletedModal,
	DiagnosticExportModal,
	type DiagnosticExportCompletedActions,
	type DiagnosticExportOptions
} from "./diagnostics/diagnostic-export-modal";
import {
	getDiagnosticFolderRevealLabel,
	revealDiagnosticExportInFolder,
	type DiagnosticFolderRevealShell
} from "./diagnostics/diagnostic-folder-reveal";
import type { DiagnosticSession, DiagnosticTaskKind } from "./diagnostics/diagnostic-types";
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
import {
	type GettingStartedGuideActions,
	type GettingStartedGuideSnapshot,
	type GettingStartedTaskSnapshot,
} from "./getting-started/getting-started-guide";
import {
	cloneGettingStartedHotkeys,
	findHotkeyAssignmentConflicts,
	saveHotkeyAssignments,
	validateGettingStartedHotkeys,
	type GettingStartedHotkeyId,
	type GettingStartedHotkeys,
	type HotkeyCommandAssignment
} from "./getting-started/getting-started-hotkeys";
import {
	getAvailableGettingStartedNotePath,
	selectNewGettingStartedAudio
} from "./getting-started/getting-started-files";
import { selectGettingStartedTranscript } from "./getting-started/getting-started-transcript-picker";
import { getTaskFailureNotice } from "./task-center/task-center-copy";
import { clearStatusIndicator, renderStatusIndicator } from "./ui/status-indicator";
import {
	acknowledgeFirstGettingStartedChapter,
	acknowledgeShortcutGettingStartedChapter,
	beginFirstGettingStartedPractice,
	beginFirstGettingStartedTranscription,
	beginShortcutGettingStartedPractice,
	cancelGettingStartedReview,
	cancelFirstGettingStartedRecording,
	cancelFirstGettingStartedTranscription,
	canSkipGettingStartedChapter,
	confirmGettingStartedHotkeys,
	confirmGettingStartedRecorder,
	dismissGettingStarted,
	getCurrentGettingStartedChapter,
	getGettingStartedActiveAudioPath,
	getGettingStartedActiveTranscriptPath,
	getGettingStartedExperienceNotePath,
	getGettingStartedFailureTaskId,
	getFirstIncompleteGettingStartedStep,
	getGettingStartedMemorySourcePath,
	getGettingStartedPracticeStage,
	getGettingStartedProgress,
	getGettingStartedTrackedPaths,
	markGettingStartedShown,
	markGettingStartedTaskRunning,
	recordFirstGettingStartedAudio,
	recordGettingStartedAnalysis,
	recordGettingStartedFailure,
	recordGettingStartedMemory,
	recordGettingStartedTranscription,
	recordShortcutGettingStartedAudio,
	removeGettingStartedPath,
	selectGettingStartedMemorySource,
	shouldAutoOpenGettingStarted,
	shouldStartGettingStartedOnOpen,
	skipGettingStartedChapter,
	startGettingStartedReview,
	startGettingStarted,
	updateGettingStartedPath,
	waitForShortcutGettingStartedTranscription,
	type GettingStartedFailureKind,
	type GettingStartedReadiness
} from "./getting-started/getting-started-state";
import { MemoryInitializationModal } from "./memory/memory-initialization-modal";
import { MemoryContextModal } from "./memory/memory-context-modal";
import { MemoryRelationModal } from "./memory/memory-relation-modal";
import { MemoryReviewModal } from "./memory/memory-review-modal";
import { MemoryService } from "./memory/memory-service";
import { diagnoseMemoryProviderSettings } from "./memory/memory-provider";
import { parseMemoryCandidate } from "./memory/memory-output";
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
	formatHotkey,
	getSelectedTranscriptionConfig,
	groupAnalysisTemplatesByCategory,
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
	getMemoryApiKeySecretId,
	getRemovedAnalysisApiKeySecretId,
	getTranscriptionApiKeySecretId,
	migrateLegacySecret,
	migrateSecretIfTargetEmpty
} from "./security/provider-secrets";
import {
	buildTranscriptionUploadPreview,
	type UploadPreviewAudioFile
} from "./security/upload-preview";
import {
	EchoNotesSettingTab,
	type EchoNotesSettingsDestination,
	type EchoNotesSettingsNavigationOptions
} from "./settings/settings-tab";
import {
	createTaskCenterState,
	createTaskId,
	markInterruptedTasks,
	TaskCenterStore,
	type EchoNotesTask,
	type EchoNotesTaskRecovery,
	type EchoNotesTaskRetry
} from "./task-center/task-center-store";
import { ECHO_NOTES_TASK_CENTER_VIEW_TYPE, EchoNotesTaskCenterView } from "./task-center/task-center-view";
import {
	markTranscriptAnalysisDone,
	markTranscriptAnalysisFailed,
	markTranscriptAnalysisPending
} from "./transcript/transcript-analysis-metadata";
import { createTranscriptionCheckpointIdentity } from "./transcript/transcript-checkpoint";
import { TranscriptService } from "./transcript/transcript-service";
import { extractTranscriptAnalyses, extractTranscriptText } from "./analysis/analysis-output";
import { FileService } from "./obsidian/file-service";

const LEGACY_API_KEY_SECRET_ID = "echo-notes-api-key";
const LEGACY_ANALYSIS_API_KEY_SECRET_ID = "echo-notes-analysis-api-key";
const AUDIO_RECORDER_PLUGIN_ID = "audio-recorder";
const AUDIO_RECORDER_START_COMMAND_ID = "audio-recorder:start";
const AUDIO_RECORDER_STOP_COMMAND_ID = "audio-recorder:stop";

const ECHO_NOTES_COMMAND_IDS = [
	"start-official-audio-recorder",
	"stop-official-audio-recorder",
	"open-task-center",
	"open-getting-started",
	"transcribe-selected-audio",
	"transcribe-all-audio-files-in-current-note",
	"start-realtime-transcription",
	"stop-realtime-transcription",
	"open-active-realtime-transcript",
	"analyze-current-transcript-with-template",
	"initialize-echo-memory",
	"extract-memory-from-current-transcript",
	"review-current-memory-candidate",
	"manage-current-memory-relations",
	"open-echo-memory-home",
	"open-echo-memory-timeline",
	"create-personal-agent-context-package",
	"rebuild-memory-profiles",
	"export-diagnostic-package"
];

interface ProcessAudioResult {
	transcriptFile: TFile;
	analysisEligible: boolean;
	diagnosticChainId: string;
}

interface ProcessAudioOptions {
	onTranscriptFileReady?: (transcriptFile: TFile) => Promise<void> | void;
	allowUploadConfirmation?: boolean;
	audioLinkPath?: string;
	forceTranscription?: boolean;
	diagnosticChainId?: string;
	diagnosticRetryOfSessionId?: string;
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

interface ObsidianCommandDefinition {
	id?: string;
	name?: string;
}

interface ObsidianCommands {
	commands?: Record<string, ObsidianCommandDefinition>;
	executeCommandById?: (commandId: string) => boolean;
}

interface ObsidianSettingsTabDefinition {
	id?: string;
	name?: string;
}

interface AppWithInternals {
	internalPlugins?: InternalPlugins;
	hotkeyManager?: ObsidianHotkeyManager;
	commands?: ObsidianCommands;
	setting?: {
		open?: () => void;
		close?: () => void;
		openTabById?: (id: string) => Promise<void> | void;
		tabs?: ObsidianSettingsTabDefinition[];
	};
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
	diagnosticSessionId: string;
	diagnosticChainId: string;
}

interface ActiveMemoryTask {
	controller: AbortController;
	promise: Promise<void>;
	diagnosticSessionId: string;
}

export default class EchoNotesPlugin extends Plugin {
	settings: EchoNotesSettings = normalizeEchoNotesSettings(undefined);

	private audioFileService: AudioFileService;
	private transcriptService: TranscriptService;
	private linkService: LinkService;
	private analysisService: AnalysisService;
	private memoryService: MemoryService;
	private diagnostics = new DiagnosticStore();
	private diagnosticFiles: FileService;
	private taskCenter = new TaskCenterStore();
	private editorService = new EditorService();
	private processingAudio = new Map<string, Promise<ProcessAudioResult | null>>();
	private processingAnalyses = new Set<string>();
	private activeMemoryTasks = new Map<string, ActiveMemoryTask>();
	private mutatingFiles = new Set<string>();
	private markdownDebounceTimers = new Map<string, number>();
	private processedMarkdownAudioLinks = new Set<string>();
	private realtimeAudioPaths = new Set<string>();
	private audioInputDevices: AudioInputDevice[] = [];
	private activeRealtimeRecording: ActiveRealtimeRecording | null = null;
	private realtimeRibbonEl: HTMLElement | null = null;
	private realtimeStatusEl: HTMLElement | null = null;
	private realtimeStatusTimer: number | null = null;
	private persistentStateTimer: number | null = null;
	private persistenceQueue: Promise<void> = Promise.resolve();
	private unsubscribeTaskCenterPersistence: (() => void) | null = null;
	private unsubscribeDiagnosticsPersistence: (() => void) | null = null;
	private settingTab: EchoNotesSettingTab | null = null;
	private settingsListeners = new Set<() => void>();
	private gettingStartedListeners = new Set<() => void>();
	private gettingStartedNativeSettingsTimer: number | null = null;
	private gettingStartedKnownAudioPaths = new Set<string>();
	private loadedAt = Date.now();

	async onload(): Promise<void> {
		await this.loadSettings();
		this.refreshServices();
		this.diagnosticFiles = new FileService(this.app);
		this.diagnostics.restore(this.settings.diagnosticState);
		this.unsubscribeTaskCenterPersistence = this.taskCenter.subscribe(() => {
			this.schedulePersistentState();
		});
		this.unsubscribeDiagnosticsPersistence = this.diagnostics.subscribe(() => this.schedulePersistentState());
		this.diagnostics.markInterruptedSessions();
		this.restoreTaskCenter();
		this.settingTab = new EchoNotesSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
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
		this.registerEditorContextMenu();
		this.registerAutomation();
		this.app.workspace.onLayoutReady(() => {
			this.registerGettingStartedFileEvents();
			void (async () => {
				try {
					await this.reconcileGettingStartedFiles();
				} catch (error) {
					this.log("恢复新人旅程文件状态失败", error);
				}
				await this.maybeOpenGettingStartedGuide();
			})();
		});
	}

	onunload(): void {
		if (this.persistentStateTimer !== null) {
			window.clearTimeout(this.persistentStateTimer);
			this.persistentStateTimer = null;
		}
		void this.persistPersistentState().catch((error) => {
			this.log("持久化 Task Center 状态失败", error);
		});
		this.unsubscribeTaskCenterPersistence?.();
		this.unsubscribeTaskCenterPersistence = null;
		this.unsubscribeDiagnosticsPersistence?.();
		this.unsubscribeDiagnosticsPersistence = null;
		this.settingTab?.closeSettingsGuide();
		if (this.gettingStartedNativeSettingsTimer !== null) {
			window.clearInterval(this.gettingStartedNativeSettingsTimer);
			this.gettingStartedNativeSettingsTimer = null;
		}
		this.settingsListeners.clear();
		this.gettingStartedListeners.clear();
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
		for (const task of this.activeMemoryTasks.values()) {
			task.controller.abort(new Error("Echo Notes 插件已停用。"));
		}
		this.activeMemoryTasks.clear();
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
		this.capturePersistentRuntimeState();
		this.settings = normalizeEchoNotesSettings(this.settings);
		delete this.settings.apiKey;
		delete this.settings.analysisApiKey;
		delete this.settings.memoryApiKey;
		await this.enqueueSettingsWrite();
		this.refreshServices();
		this.updateRealtimeUi();
		this.notifySettingsChanged();
		this.notifyGettingStartedChanged();
	}

	refreshRegisteredCommands(): void {
		this.registerCommands();
	}

	async activateTaskCenterView(options: { revealGettingStarted?: boolean } = {}): Promise<void> {
		const existingLeaf = this.app.workspace.getLeavesOfType(ECHO_NOTES_TASK_CENTER_VIEW_TYPE)[0];
		const leaf = existingLeaf ?? this.app.workspace.getRightLeaf(false);
		if (!leaf) {
			new Notice("无法打开 Echo Notes Task Center。");
			return;
		}

		if (!existingLeaf) {
			await leaf.setViewState({ type: ECHO_NOTES_TASK_CENTER_VIEW_TYPE, active: true });
		}
		await this.app.workspace.revealLeaf(leaf);
		if (options.revealGettingStarted && leaf.view instanceof EchoNotesTaskCenterView) {
			leaf.view.revealGettingStarted();
		}
	}

	getTaskCenterTasks(): EchoNotesTask[] {
		return this.taskCenter.getTasks();
	}

	subscribeTaskCenter(listener: () => void): () => void {
		return this.taskCenter.subscribe(listener);
	}

	openDiagnosticExport(task?: EchoNotesTask): void {
		new DiagnosticExportModal(this.app, (options) => this.exportDiagnosticPackage(options, task)).open();
	}

	async clearDiagnosticRecords(): Promise<void> {
		this.diagnostics.clear();
		await this.persistPersistentState();
		new Notice("已清空插件内保存的诊断记录；此前生成的 zip 不会被删除。");
	}

	setDiagnosticRetentionEnabled(enabled: boolean): void {
		this.diagnostics.setEnabled(enabled);
	}

	isDiagnosticRetentionEnabled(): boolean {
		return this.diagnostics.isEnabled();
	}

	private async exportDiagnosticPackage(options: DiagnosticExportOptions, task?: EchoNotesTask): Promise<void> {
		try {
			const allTasks = this.taskCenter.getTasks();
			const chainId = task?.diagnosticChainId;
			const selectedTasks = chainId
				? allTasks.filter((item) => item.diagnosticChainId === chainId)
				: task ? [task] : allTasks;
			const sessions = this.diagnostics.getState().sessions.filter((session) =>
				chainId ? session.chainId === chainId : task?.diagnosticSessionId ? session.id === task.diagnosticSessionId : true
			);
			const content = await this.collectDiagnosticExportContent(options, selectedTasks);
			const appVersion = (this.app as unknown as { version?: unknown }).version;
			const archive = createDiagnosticArchive({
				pluginVersion: this.manifest.version,
				obsidianVersion: typeof appVersion === "string" ? appVersion : undefined,
				platform: Platform.isMobile ? "mobile" : "desktop",
				applicationLanguage: navigator.language || "unknown",
				sessions,
				tasks: selectedTasks.map((item) => ({
					id: item.id,
					kind: item.kind,
					status: item.status,
					provider: item.provider,
					model: item.model,
					traceId: item.traceId,
					diagnosticSessionId: item.diagnosticSessionId,
					diagnosticChainId: item.diagnosticChainId,
					error: item.error
				})),
				content
			});
			const directory = "Echo Notes/诊断包";
			await this.diagnosticFiles.ensureFolder(directory);
			const path = `${directory}/${archive.fileName}`;
			await this.app.vault.createBinary(path, Uint8Array.from(archive.bytes).buffer);
			new DiagnosticExportCompletedModal(this.app, path, this.getDiagnosticFolderRevealActions(path)).open();
		} catch (error) {
			const message = getSanitizedErrorMessage(error);
			new Notice(`导出诊断包失败：${message}`);
			throw error;
		}
	}

	private getDiagnosticFolderRevealActions(vaultPath: string): DiagnosticExportCompletedActions {
		if (!Platform.isDesktopApp || !(this.app.vault.adapter instanceof FileSystemAdapter)) {
			return {};
		}
		const shell = getDesktopElectronShell();
		if (!shell) {
			return {};
		}
		const adapter = this.app.vault.adapter;
		return {
			revealLabel: getDiagnosticFolderRevealLabel(getDesktopRuntimePlatform()),
			onRevealInFolder: () => revealDiagnosticExportInFolder({ shell, adapter, vaultPath })
		};
	}

	private async collectDiagnosticExportContent(
		options: DiagnosticExportOptions,
		tasks: readonly EchoNotesTask[]
	): Promise<DiagnosticExportContent | undefined> {
		const result: DiagnosticExportContent = {};
		const transcriptPaths = uniquePaths(tasks.filter((task) => task.kind === "transcription").map((task) => task.outputPath));
		const analysisPaths = uniquePaths(tasks.filter((task) => task.kind === "analysis").map((task) => task.outputPath));
		const memoryPaths = uniquePaths(tasks.filter((task) => task.kind === "memory").map((task) => task.outputPath));
		if (options.includeTranscript) {
			const blocks = await this.readDiagnosticTextFiles(transcriptPaths, (content) => extractTranscriptText(content));
			if (blocks.length > 0) {
				result.transcript = blocks.map((block, index) => `## 转写正文 ${index + 1}\n\n${block}`).join("\n\n");
			}
		}
		if (options.includeAnalyses) {
			const blocks = await this.readDiagnosticTextFiles(uniquePaths([...transcriptPaths, ...analysisPaths]), (content) =>
				extractTranscriptAnalyses(content).map((analysis) => analysis.markdown).join("\n\n")
			);
			if (blocks.length > 0) {
				result.analyses = blocks.map((block, index) => `## AI 分析 ${index + 1}\n\n${block}`).join("\n\n");
			}
		}
		if (options.includeMemoryCandidate) {
			const candidates: unknown[] = [];
			for (const path of memoryPaths) {
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) {
					continue;
				}
				const candidate = parseMemoryCandidate(await this.app.vault.cachedRead(file));
				candidates.push({
					provider: candidate.provider,
					model: candidate.model,
					createdAt: candidate.createdAt,
					rejectedAssertionCount: candidate.rejectedAssertionCount,
					assertions: candidate.assertions.map(({ sourcePath: _sourcePath, ...assertion }) => assertion)
				});
			}
			if (candidates.length > 0) {
				result.memoryCandidate = JSON.stringify(candidates, null, 2);
			}
		}
		const selectedBytes = new TextEncoder().encode(Object.values(result).join("\n")).byteLength;
		if (selectedBytes > 10 * 1024 * 1024) {
			throw new Error("所选可选内容超过 10 MB，请减少勾选内容后重试。");
		}
		return Object.keys(result).length > 0 ? result : undefined;
	}

	private async readDiagnosticTextFiles(paths: readonly string[], extract: (content: string) => string): Promise<string[]> {
		const blocks: string[] = [];
		for (const path of paths) {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (!(file instanceof TFile)) {
				continue;
			}
			const value = extract(await this.app.vault.cachedRead(file)).trim();
			if (value) {
				blocks.push(value);
			}
		}
		return blocks;
	}

	private startDiagnosticSession(
		kind: DiagnosticTaskKind,
		chainId?: string,
		retryOfSessionId?: string
	): DiagnosticSession {
		const session = this.diagnostics.startSession({ kind, chainId, retryOfSessionId });
		if (this.diagnostics.isEnabled()) {
			this.diagnostics.record(session.id, "environment", "host-environment", {
				pluginVersion: this.manifest.version,
				platform: Platform.isMobile ? "mobile" : "desktop",
				applicationLanguage: navigator.language || "unknown"
			});
		}
		return session;
	}

	private recordTranscriptionDiagnosticProgress(sessionId: string, progress: TranscriptionProgress): void {
		if (progress.type === "whole-audio-request-started") {
			this.diagnostics.record(sessionId, "request", "whole-audio-request", {
				attempt: progress.attempt,
				totalAttempts: progress.totalAttempts,
				audioBytes: progress.audioBytes
			});
			return;
		}
		if (progress.type === "streaming-result") {
			this.diagnostics.record(sessionId, "progress", "streaming-result", {
				processedSeconds: Math.round(progress.processedSeconds),
				totalSeconds: Math.round(progress.totalSeconds),
				utteranceCount: progress.utterances?.length ?? 0,
				traceId: progress.traceId
			});
			return;
		}
		if (progress.type === "long-audio-preparing") {
			this.diagnostics.record(sessionId, "lifecycle", "long-audio-preparing", {
				completedSegments: progress.segments.length
			});
			return;
		}
		if (progress.type === "long-audio-started") {
			this.diagnostics.record(sessionId, "lifecycle", "long-audio-segmented", {
				totalSegments: progress.totalSegments,
				resumedSegments: progress.segments.length
			});
			return;
		}
		if (progress.type === "segment-split") {
			this.diagnostics.record(sessionId, "lifecycle", "segment-shortened", {
				segmentIndex: progress.segment.index,
				segmentTotal: progress.segment.total,
				replacementCount: progress.replacementSegments.length,
				totalSegments: progress.totalSegments
			});
			return;
		}
		if (progress.type === "segment-retrying") {
			this.diagnostics.record(sessionId, "lifecycle", "segment-retry", {
				attempt: progress.attempt,
				maxAttempts: progress.maxAttempts,
				delayMs: progress.delayMs,
				segmentIndex: progress.segment?.index,
				segmentTotal: progress.segment?.total
			});
			return;
		}
		this.diagnostics.record(sessionId, "progress", progress.type === "segment-started" ? "segment-started" : "segment-completed", {
			segmentIndex: progress.segment.index,
			segmentTotal: progress.segment.total,
			startSeconds: Math.round(progress.segment.startSeconds),
			endSeconds: Math.round(progress.segment.endSeconds)
		});
	}

	subscribeSettings(listener: () => void): () => void {
		this.settingsListeners.add(listener);
		return () => {
			this.settingsListeners.delete(listener);
		};
	}

	subscribeGettingStarted(listener: () => void): () => void {
		this.gettingStartedListeners.add(listener);
		return () => {
			this.gettingStartedListeners.delete(listener);
		};
	}

	getGettingStartedGuideSnapshot(): GettingStartedGuideSnapshot {
		const state = this.settings.gettingStartedState;
		const transcriptionConfig = this.settings.offlineTranscription;
		const transcriptionDiagnostics = diagnoseTranscriptionProviderSettings(
			transcriptionConfig,
			this.getApiKey(transcriptionConfig.provider),
			{
				isMobile: Platform.isMobile,
				isFileSystemVault: this.app.vault.adapter instanceof FileSystemAdapter,
				usage: "offline"
			}
		);
		const analysisDiagnostics = diagnoseAnalysisProviderSettings(
			this.settings,
			this.getAnalysisApiKey()
		);
		const analysisReady =
			this.settings.analysisEnabled &&
			getEnabledAnalysisTemplates(this.settings).length > 0 &&
			analysisDiagnostics.canAttemptAnalysis;
		const recorderEnabled = this.isOfficialAudioRecorderEnabled();
		const hotkeys = this.getGettingStartedHotkeys();
		const hotkeyValidation = validateGettingStartedHotkeys(hotkeys);
		const memoryDiagnostics = diagnoseMemoryProviderSettings({
			provider: this.settings.memoryProvider,
			baseUrl: this.settings.memoryBaseUrl,
			model: this.settings.memoryModel,
			apiKey: this.getMemoryApiKey()
		});
		const readiness: GettingStartedReadiness = {
			transcriptionReady: transcriptionDiagnostics.canAttemptTranscription,
			analysisReady,
			recorderReady: recorderEnabled === true || Boolean(state.recorderManuallyConfirmedAt),
			hotkeysReady: hotkeyValidation.valid || Boolean(state.hotkeysManuallyConfirmedAt),
			memoryReady: this.settings.memoryInitialized && memoryDiagnostics.canAttempt
		};
		const memorySourcePath = getGettingStartedMemorySourcePath(state);
		const memorySourceFile = this.getGettingStartedFile(memorySourcePath);
		return {
			state,
			step: getFirstIncompleteGettingStartedStep(state, readiness),
			progress: getGettingStartedProgress(state),
			readiness,
			memoryInitialized: this.settings.memoryInitialized,
			recorderEnabled,
			hotkeys,
			hotkeyManagerReadable:
				typeof this.getHotkeyManager()?.getHotkeys === "function" ||
				typeof this.getHotkeyManager()?.getDefaultHotkeys === "function",
			hotkeyManagerWritable:
				typeof this.getHotkeyManager()?.setHotkeys === "function" &&
				typeof this.getHotkeyManager()?.save === "function",
			memorySourcePath,
			memorySourceAvailable: Boolean(memorySourceFile && this.isTranscriptMarkdownFile(memorySourceFile)),
			task: this.getGettingStartedTaskSnapshot()
		};
	}

	async openGettingStarted(): Promise<void> {
		if (shouldStartGettingStartedOnOpen(
			this.settings.gettingStartedState.status,
			Platform.isMobile
		)) {
			this.settings.gettingStartedState = startGettingStarted(this.settings.gettingStartedState);
			await this.saveSettings();
		}
		if (document.querySelector(".modal.mod-settings")) {
			(this.app as App & AppWithInternals).setting?.close?.();
		}
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	async openSettingsDestination(
		destination: EchoNotesSettingsDestination,
		options: EchoNotesSettingsNavigationOptions = {}
	): Promise<boolean> {
		const settingsManager = (this.app as App & AppWithInternals).setting;
		const label = getSettingsDestinationLabel(destination);
		if (!settingsManager?.open || !settingsManager.openTabById || !this.settingTab) {
			new Notice(`无法自动定位设置，请手动打开「设置 → Echo Notes → ${label}」。`);
			return false;
		}

		settingsManager.open();
		await settingsManager.openTabById(this.manifest.id);
		this.settingTab.showDestination(destination, options);
		return true;
	}

	async retryTaskCenterTask(taskId: string): Promise<boolean> {
		return this.taskCenter.retryTask(taskId);
	}

	clearFinishedTaskCenterTasks(): void {
		this.taskCenter.clearFinishedTasks();
	}

	private getGettingStartedHotkeys(): GettingStartedHotkeys {
		return {
			start: this.getOfficialAudioRecorderStartHotkey(),
			stop: this.getOfficialAudioRecorderStopHotkey(),
			transcribe: this.getObsidianCommandHotkey(
				`${this.manifest.id}:transcribe-all-audio-files-in-current-note`,
				this.settings.transcribeAllAudioHotkey
			)
		};
	}

	private getGettingStartedHotkeyConflicts(
		hotkeys: GettingStartedHotkeys
	): Partial<Record<GettingStartedHotkeyId, string[]>> {
		const hotkeyManager = this.getHotkeyManager();
		const commands = (this.app as unknown as AppWithInternals).commands?.commands;
		if (
			!commands ||
			(typeof hotkeyManager?.getHotkeys !== "function" &&
				typeof hotkeyManager?.getDefaultHotkeys !== "function")
		) {
			return {};
		}
		return findHotkeyAssignmentConflicts(
			this.getGettingStartedHotkeyAssignments(hotkeys),
			commands,
			hotkeyManager
		);
	}

	getHotkeyConflicts(commandId: string, hotkey: EchoNotesHotkeySetting): string[] {
		const hotkeyManager = this.getHotkeyManager();
		const commands = (this.app as unknown as AppWithInternals).commands?.commands;
		if (
			!commands ||
			(typeof hotkeyManager?.getHotkeys !== "function" &&
				typeof hotkeyManager?.getDefaultHotkeys !== "function")
		) {
			return [];
		}
		return findHotkeyAssignmentConflicts(
			[{ id: "hotkey", commandId, hotkey }],
			commands,
			hotkeyManager
		).hotkey ?? [];
	}

	private getGettingStartedHotkeyAssignments(
		hotkeys: GettingStartedHotkeys
	): HotkeyCommandAssignment<GettingStartedHotkeyId>[] {
		return [
			{ id: "start", commandId: AUDIO_RECORDER_START_COMMAND_ID, hotkey: hotkeys.start },
			{ id: "stop", commandId: AUDIO_RECORDER_STOP_COMMAND_ID, hotkey: hotkeys.stop },
			{
				id: "transcribe",
				commandId: `${this.manifest.id}:transcribe-all-audio-files-in-current-note`,
				hotkey: hotkeys.transcribe
			}
		];
	}

	private getGettingStartedTaskSnapshot(): GettingStartedTaskSnapshot | undefined {
		const state = this.settings.gettingStartedState;
		const failureTaskId = getGettingStartedFailureTaskId(state);
		const activeAudioPath = getGettingStartedActiveAudioPath(state);
		const activeTranscriptPath = getGettingStartedActiveTranscriptPath(state);
		const memorySourcePath = getGettingStartedMemorySourcePath(state);
		const practiceStage = getGettingStartedPracticeStage(state);
		const task = failureTaskId
			? this.taskCenter.getTasks().find((candidate) => candidate.id === failureTaskId)
			: this.taskCenter.getTasks().find((candidate) => {
				if (
					candidate.kind === "transcription" &&
					(practiceStage === "first-transcribing" || practiceStage === "shortcut-transcribing")
				) {
					return candidate.targetPath === activeAudioPath;
				}
				if (candidate.kind === "analysis" && practiceStage === "analyzing") {
					return candidate.targetPath === activeTranscriptPath;
				}
				if (candidate.kind === "memory" && practiceStage === "memory-running") {
					return candidate.targetPath === memorySourcePath;
				}
				return false;
			});
		if (!task) {
			return undefined;
		}
		return {
			id: task.id,
			kind: task.kind,
			status: task.status === "skipped" ? "success" : task.status,
			stage: task.stage,
			error: task.error,
			canRetry: Boolean(task.retry)
		};
	}

	getGettingStartedGuideActions(): GettingStartedGuideActions {
		return {
			dismiss: async () => {
				this.settings.gettingStartedState = dismissGettingStarted(this.settings.gettingStartedState);
				await this.saveSettings();
			},
			skipChapter: async (chapter) => {
				const state = this.settings.gettingStartedState;
				if (!canSkipGettingStartedChapter(state, chapter)) {
					new Notice("当前阶段正在处理，暂时无法跳过。");
					return;
				}
				this.settings.gettingStartedState = skipGettingStartedChapter(state, chapter);
				await this.saveSettings();
			},
			relearnChapter: async (chapter) => {
				const state = this.settings.gettingStartedState;
				const nextState = startGettingStartedReview(state, chapter);
				if (!nextState.activeReview || nextState.activeReview === state.activeReview) {
					new Notice("当前有正在进行的新人任务，请结束后再学一次。");
					return;
				}
				this.settings.gettingStartedState = nextState;
				await this.saveSettings();
			},
			cancelRelearn: async () => {
				const state = this.settings.gettingStartedState;
				const nextState = cancelGettingStartedReview(state);
				if (nextState.activeReview) {
					new Notice("当前阶段正在处理，请结束后再退出复习。");
					return;
				}
				this.settings.gettingStartedState = nextState;
				await this.saveSettings();
			},
			openTranscriptionSettings: () => this.openGettingStartedSettings("transcription-service"),
			openAnalysisSettings: () => this.openGettingStartedSettings("analysis-model"),
			enableRecorder: async () => {
				await this.setOfficialAudioRecorderEnabled(true);
				this.notifyGettingStartedChanged();
			},
			confirmRecorder: async () => {
				this.settings.gettingStartedState = confirmGettingStartedRecorder(this.settings.gettingStartedState);
				await this.saveSettings();
			},
			openCorePluginSettings: () => this.openNativeSettingsForGettingStarted("core"),
			getHotkeyConflicts: (hotkeys) => this.getGettingStartedHotkeyConflicts(hotkeys),
			saveHotkeys: (hotkeys) => this.saveGettingStartedHotkeys(hotkeys),
			confirmHotkeys: async () => {
				this.settings.gettingStartedState = confirmGettingStartedHotkeys(this.settings.gettingStartedState);
				await this.saveSettings();
			},
			openHotkeySettings: () => this.openNativeSettingsForGettingStarted("hotkeys"),
			createExperienceNote: () => this.createGettingStartedExperienceNote(),
			stopFirstRecording: () => this.stopGettingStartedFirstRecording(),
			transcribeFirstRecording: () => this.transcribeGettingStartedFirstRecording(),
			acknowledgeFirstChapter: async () => {
				this.settings.gettingStartedState = acknowledgeFirstGettingStartedChapter(this.settings.gettingStartedState);
				await this.saveSettings();
			},
			startShortcutPractice: () => this.startGettingStartedShortcutPractice(),
			resumeShortcutPractice: () => this.openGettingStartedExperienceNote(),
			startShortcutTranscription: () => this.waitForGettingStartedShortcutTranscription(),
			acknowledgeShortcutChapter: async () => {
				this.settings.gettingStartedState = acknowledgeShortcutGettingStartedChapter(this.settings.gettingStartedState);
				await this.saveSettings();
			},
			initializeMemory: () => this.initializeGettingStartedMemory(),
			openMemorySettings: () => this.openGettingStartedSettings("memory-model"),
			selectMemoryTranscript: () => this.selectGettingStartedMemoryTranscript(),
			startMemory: () => this.startGettingStartedMemory(),
			retryTask: async (taskId) => {
				if (!await this.retryTaskCenterTask(taskId)) {
					new Notice("当前任务无法重试。");
				}
			},
			openExperienceNote: () => this.openGettingStartedExperienceNote(),
			openFirstTranscript: () => this.openGettingStartedTranscript("first"),
			openShortcutTranscript: () => this.openGettingStartedTranscript("shortcut"),
			openMemoryCandidate: () => this.openGettingStartedMemoryCandidate()
		};
	}

	private async openGettingStartedSettings(destination: EchoNotesSettingsDestination): Promise<void> {
		const opened = await this.openSettingsDestination(destination, {
			guide: "provider-api-key",
			onGuideFinished: () => {
				(this.app as unknown as AppWithInternals).setting?.close?.();
				window.setTimeout(() => {
					void this.activateTaskCenterView({ revealGettingStarted: true });
				}, 0);
			}
		});
		if (!opened) {
			await this.activateTaskCenterView({ revealGettingStarted: true });
		}
	}

	private async openNativeSettingsForGettingStarted(kind: "core" | "hotkeys"): Promise<void> {
		const settingsManager = (this.app as unknown as AppWithInternals).setting;
		if (!settingsManager?.open || !settingsManager.openTabById) {
			new Notice("无法自动打开 Obsidian 设置，请手动完成后重新打开新人指引。");
			await this.activateTaskCenterView({ revealGettingStarted: true });
			return;
		}
		settingsManager.open();
		const tabs = settingsManager.tabs ?? [];
		const tab = tabs.find((candidate) => {
			const haystack = `${candidate.id ?? ""} ${candidate.name ?? ""}`.toLowerCase();
			return kind === "hotkeys"
				? haystack.includes("hotkey") || haystack.includes("快捷键")
				: haystack.includes("core") || haystack.includes("核心插件");
		});
		await settingsManager.openTabById(tab?.id ?? (kind === "hotkeys" ? "hotkeys" : "core"));
		this.watchNativeSettingsClose();
	}

	private watchNativeSettingsClose(): void {
		if (this.gettingStartedNativeSettingsTimer !== null) {
			window.clearInterval(this.gettingStartedNativeSettingsTimer);
		}
		this.gettingStartedNativeSettingsTimer = window.setInterval(() => {
			if (document.querySelector(".modal.mod-settings")) {
				return;
			}
			if (this.gettingStartedNativeSettingsTimer !== null) {
				window.clearInterval(this.gettingStartedNativeSettingsTimer);
				this.gettingStartedNativeSettingsTimer = null;
			}
			void this.activateTaskCenterView({ revealGettingStarted: true });
		}, 300);
	}

	private async saveGettingStartedHotkeys(hotkeys: GettingStartedHotkeys): Promise<boolean> {
		const validation = validateGettingStartedHotkeys(hotkeys);
		const manager = this.getHotkeyManager();
		const commands = (this.app as unknown as AppWithInternals).commands?.commands;
		if (!validation.valid || !commands || !manager?.setHotkeys || !manager.save) {
			new Notice("三组快捷键尚未完整配置，或当前 Obsidian 版本无法写入快捷键。");
			return false;
		}
		const originalSettings = this.getGettingStartedHotkeys();
		const result = await saveHotkeyAssignments(
			this.getGettingStartedHotkeyAssignments(hotkeys),
			commands,
			{
				getHotkeys: (commandId) => manager.getHotkeys?.(commandId),
				getDefaultHotkeys: (commandId) => manager.getDefaultHotkeys?.(commandId),
				setHotkeys: (commandId, commandHotkeys) => manager.setHotkeys?.(commandId, commandHotkeys),
				save: () => manager.save?.()
			}
		);
		if (Object.keys(result.conflicts).length > 0) {
			new Notice(`快捷键与其他命令冲突，整批未保存：${Object.values(result.conflicts).flat().join("、")}`);
			return false;
		}
		if (!result.saved) {
			if (result.rollbackError) {
				this.log("回滚新人向导快捷键失败", result.rollbackError);
			}
			new Notice(`保存快捷键失败：${getErrorMessage(result.error)}`);
			return false;
		}
		try {
			const cloned = cloneGettingStartedHotkeys(hotkeys);
			this.settings.officialRecorderStartHotkey = cloned.start;
			this.settings.officialRecorderStopHotkey = cloned.stop;
			this.settings.transcribeAllAudioHotkey = cloned.transcribe;
			delete this.settings.gettingStartedState.hotkeysManuallyConfirmedAt;
			await this.saveSettings();
			new Notice("三组快捷键已保存。");
			return true;
		} catch (error) {
			try {
				await result.rollback?.();
			} catch (rollbackError) {
				this.log("回滚新人向导快捷键失败", rollbackError);
			}
			this.settings.officialRecorderStartHotkey = cloneHotkey(originalSettings.start);
			this.settings.officialRecorderStopHotkey = cloneHotkey(originalSettings.stop);
			this.settings.transcribeAllAudioHotkey = cloneHotkey(originalSettings.transcribe);
			try {
				await this.saveSettings();
			} catch (rollbackSettingsError) {
				this.log("回滚新人向导快捷键设置失败", rollbackSettingsError);
			}
			new Notice(`保存快捷键失败：${getErrorMessage(error)}`);
			return false;
		}
	}


	private restoreTaskCenter(): void {
		const restoredTasks = markInterruptedTasks(this.settings.taskCenterState.tasks).map((task): EchoNotesTask => ({
			...task,
			retry: this.createTaskRecoveryRetry(task.recovery)
		}));
		this.taskCenter.restoreTasks(restoredTasks);
	}

	private createTaskRecoveryRetry(recovery: EchoNotesTaskRecovery | undefined): EchoNotesTaskRetry | undefined {
		if (!recovery) {
			return undefined;
		}
		switch (recovery.kind) {
			case "transcription":
				return {
					label: "重试转写",
					run: () => this.retryTranscriptionTask(
						recovery.audioPath,
						recovery.sourcePath,
						recovery.audioLinkPath
					)
				};
			case "analysis":
				return {
					label: "重试分析",
					run: () => this.retryAnalysisTask(recovery.transcriptPath, recovery.templateId)
				};
			case "memory-extraction":
				return {
					label: "重试记忆提取",
					run: () => this.retryMemoryTask(recovery.transcriptPath, recovery.analysisTemplateIds)
				};
			case "memory-rebuild":
				return { label: "重试重建", run: () => this.rebuildMemoryProfiles() };
		}
	}

	private schedulePersistentState(): void {
		if (this.persistentStateTimer !== null) {
			return;
		}
		this.persistentStateTimer = window.setTimeout(() => {
			this.persistentStateTimer = null;
			void this.persistPersistentState().catch((error) => {
				this.log("持久化 Echo Notes 运行状态失败", error);
			});
		}, 1000);
	}

	private capturePersistentRuntimeState(): void {
		this.settings.taskCenterState = createTaskCenterState(this.taskCenter.getTasks());
		this.settings.diagnosticState = this.diagnostics.getState();
	}

	private async persistPersistentState(): Promise<void> {
		this.capturePersistentRuntimeState();
		await this.enqueueSettingsWrite();
	}

	private enqueueSettingsWrite(): Promise<void> {
		const snapshot = JSON.parse(JSON.stringify(this.settings)) as EchoNotesSettings;
		this.persistenceQueue = this.persistenceQueue
			.catch(() => undefined)
			.then(() => this.saveData(snapshot));
		return this.persistenceQueue;
	}

	private async maybeOpenGettingStartedGuide(): Promise<void> {
		const state = this.settings.gettingStartedState;
		const status = state.status;
		if (!shouldAutoOpenGettingStarted(status, Platform.isMobile, Boolean(state.activeReview))) {
			return;
		}
		if (state.activeReview) {
			await this.activateTaskCenterView({ revealGettingStarted: true });
			return;
		}
		if (status === "not-started") {
			this.settings.gettingStartedState = markGettingStartedShown(this.settings.gettingStartedState);
			await this.saveSettings();
			await this.activateTaskCenterView({ revealGettingStarted: true });
			return;
		}
		if (status === "in-progress") {
			await this.activateTaskCenterView({ revealGettingStarted: true });
		}
	}

	private registerGettingStartedFileEvents(): void {
		this.registerEvent(this.app.vault.on("modify", (file) => {
			if (
				file instanceof TFile &&
				file.path === getGettingStartedExperienceNotePath(this.settings.gettingStartedState)
			) {
				void this.detectGettingStartedAudio(file);
			}
		}));
		this.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
			const nextState = updateGettingStartedPath(this.settings.gettingStartedState, oldPath, file.path);
			if (JSON.stringify(nextState) !== JSON.stringify(this.settings.gettingStartedState)) {
				this.settings.gettingStartedState = nextState;
				void this.saveSettings();
			}
		}));
		this.registerEvent(this.app.vault.on("delete", (file) => {
			const nextState = removeGettingStartedPath(this.settings.gettingStartedState, file.path);
			if (JSON.stringify(nextState) !== JSON.stringify(this.settings.gettingStartedState)) {
				this.settings.gettingStartedState = nextState;
				void this.saveSettings();
			}
		}));
	}

	private async reconcileGettingStartedFiles(): Promise<void> {
		let nextState = this.settings.gettingStartedState;
		for (const path of getGettingStartedTrackedPaths(nextState)) {
			if (path && !this.app.vault.getAbstractFileByPath(path)) {
				nextState = removeGettingStartedPath(nextState, path);
			}
		}
		if (JSON.stringify(nextState) !== JSON.stringify(this.settings.gettingStartedState)) {
			this.settings.gettingStartedState = nextState;
			await this.saveSettings();
		}
		const sourceNote = this.getGettingStartedFile(getGettingStartedExperienceNotePath(nextState));
		if (sourceNote) {
			await this.detectGettingStartedAudio(sourceNote);
		}
	}

	private async detectGettingStartedAudio(sourceNote: TFile): Promise<void> {
		const state = this.settings.gettingStartedState;
		if (sourceNote.path !== getGettingStartedExperienceNotePath(state)) {
			return;
		}
		const practiceStage = getGettingStartedPracticeStage(state);
		const waitingForFirst = practiceStage === "waiting-for-first-audio";
		const waitingForShortcut = practiceStage === "waiting-for-shortcut-audio";
		if (!waitingForFirst && !waitingForShortcut) {
			return;
		}
		const startedAt = state.activeReview?.practiceStartedAt ??
			(waitingForFirst ? state.firstPracticeStartedAt : state.shortcutPracticeStartedAt);
		if (!startedAt) {
			return;
		}
		const content = await this.app.vault.cachedRead(sourceNote);
		const candidates = parseAudioLinks(content)
			.map((match) => this.audioFileService.resolveAudioFile(match.linkPath, sourceNote))
			.filter((file): file is TFile => Boolean(file))
			.filter((file) => isSupportedAudioFile(file))
			.map((file) => ({ path: file.path, createdAt: file.stat.ctime, value: file }));
		const audioFile = selectNewGettingStartedAudio(
			candidates,
			startedAt,
			this.gettingStartedKnownAudioPaths,
			waitingForFirst ? undefined : state.firstAudioPath
		);
		if (!audioFile) {
			return;
		}
		const recordedState = waitingForFirst
			? recordFirstGettingStartedAudio(state, audioFile.path)
			: recordShortcutGettingStartedAudio(state, audioFile.path);
		this.settings.gettingStartedState = waitingForShortcut
			? waitForShortcutGettingStartedTranscription(recordedState)
			: recordedState;
		await this.saveSettings();
		this.gettingStartedKnownAudioPaths.add(audioFile.path);
		await this.activateTaskCenterView({ revealGettingStarted: true });
		if (waitingForShortcut) {
			await this.openFileInMainWorkspace(sourceNote);
			const hotkey = formatHotkey(this.getGettingStartedHotkeys().transcribe);
			new Notice(
				hotkey
					? `录音已保存，请按 ${hotkey} 转写当前笔记全部音频。转写成功后会自动生成 AI 分析。`
					: "录音已保存，请执行“转写当前笔记全部音频”命令。",
				0
			);
		}
	}

	private async createGettingStartedExperienceNote(): Promise<void> {
		let note = this.getGettingStartedFile(
			getGettingStartedExperienceNotePath(this.settings.gettingStartedState)
		) ?? this.getGettingStartedFile(this.settings.gettingStartedState.experienceNotePath);
		if (!note) {
			note = await this.createNewGettingStartedExperienceNote();
		}
		await this.captureGettingStartedKnownAudioPaths(note);
		this.settings.gettingStartedState = beginFirstGettingStartedPractice(
			this.settings.gettingStartedState,
			note.path
		);
		await this.saveSettings();
		await this.openFileInMainWorkspace(note);
		await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
		const started = this.executeObsidianCommand(AUDIO_RECORDER_START_COMMAND_ID);
		if (!started) {
			new Notice("无法启动核心录音机，请确认 Audio recorder 已开启后重试。");
			this.settings.gettingStartedState = cancelFirstGettingStartedRecording(
				this.settings.gettingStartedState
			);
			await this.saveSettings();
		} else {
			new Notice("录音已开始，说几句话后在右侧新人指引中点击停止录音。");
		}
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private async stopGettingStartedFirstRecording(): Promise<void> {
		if (!this.executeObsidianCommand(AUDIO_RECORDER_STOP_COMMAND_ID)) {
			new Notice("无法停止核心录音机，请确认录音正在进行。");
			this.settings.gettingStartedState = cancelFirstGettingStartedRecording(
				this.settings.gettingStartedState
			);
			await this.saveSettings();
			await this.activateTaskCenterView({ revealGettingStarted: true });
			return;
		}
		new Notice("正在等待 Obsidian 保存录音并插入体验笔记。");
		const note = this.getGettingStartedFile(
			getGettingStartedExperienceNotePath(this.settings.gettingStartedState)
		);
		if (note) {
			window.setTimeout(() => void this.detectGettingStartedAudio(note), 300);
		}
	}

	private async transcribeGettingStartedFirstRecording(): Promise<void> {
		const state = this.settings.gettingStartedState;
		const audioFile = this.getGettingStartedFile(getGettingStartedActiveAudioPath(state));
		const sourceNote = this.getGettingStartedFile(getGettingStartedExperienceNotePath(state));
		if (!audioFile || !sourceNote) {
			new Notice("体验录音或笔记不存在，请重新开始新人旅程。");
			return;
		}
		this.settings.gettingStartedState = beginFirstGettingStartedTranscription(state);
		await this.saveSettings();
		await this.openFileInMainWorkspace(sourceNote);
		const content = await this.app.vault.cachedRead(sourceNote);
		const audioMatch = parseAudioLinks(content).find((match) =>
			this.audioFileService.resolveAudioFile(match.linkPath, sourceNote)?.path === audioFile.path
		);
		const result = await this.processAudioToTranscript(audioFile, sourceNote, {
			audioLinkPath: audioMatch?.linkPath,
			onTranscriptFileReady: audioMatch
				? (transcriptFile) => this.insertTranscriptLinkIntoFile(sourceNote, audioMatch.linkPath, transcriptFile)
				: undefined
		});
		if (!result && getGettingStartedPracticeStage(this.settings.gettingStartedState) === "first-transcribing") {
			this.settings.gettingStartedState = cancelFirstGettingStartedTranscription(
				this.settings.gettingStartedState
			);
			await this.saveSettings();
			await this.activateTaskCenterView({ revealGettingStarted: true });
		}
	}

	private async startGettingStartedShortcutPractice(): Promise<void> {
		let state = this.settings.gettingStartedState;
		let note = this.getGettingStartedFile(getGettingStartedExperienceNotePath(state)) ??
			this.getGettingStartedFile(state.experienceNotePath);
		if (!note) {
			note = await this.createNewGettingStartedExperienceNote();
		}
		if (state.activeReview?.chapter === "shortcut") {
			state = {
				...state,
				activeReview: { ...state.activeReview, experienceNotePath: note.path }
			};
		} else if (!state.experienceNotePath) {
			state = { ...state, experienceNotePath: note.path };
		}
		this.settings.gettingStartedState = beginShortcutGettingStartedPractice(state);
		await this.captureGettingStartedKnownAudioPaths(note);
		await this.saveSettings();
		await this.openFileInMainWorkspace(note);
		const hotkeys = this.getGettingStartedHotkeys();
		new Notice(`请按 ${formatHotkey(hotkeys.start)} 开始录音，说几句话后按 ${formatHotkey(hotkeys.stop)} 停止。`, 0);
	}

	private async openGettingStartedExperienceNote(): Promise<void> {
		const state = this.settings.gettingStartedState;
		const note = this.getGettingStartedFile(getGettingStartedExperienceNotePath(state)) ??
			this.getGettingStartedFile(state.chapters.shortcut.latestReviewExperienceNotePath) ??
			this.getGettingStartedFile(state.chapters.first.latestReviewExperienceNotePath) ??
			this.getGettingStartedFile(state.experienceNotePath);
		if (!note) {
			new Notice("体验笔记不存在。");
			return;
		}
		await this.openFileInMainWorkspace(note);
	}

	private async waitForGettingStartedShortcutTranscription(): Promise<void> {
		this.settings.gettingStartedState = waitForShortcutGettingStartedTranscription(
			this.settings.gettingStartedState
		);
		await this.saveSettings();
		await this.openGettingStartedExperienceNote();
		new Notice(`请按 ${formatHotkey(this.getGettingStartedHotkeys().transcribe)} 开始转写，AI 分析会在转写成功后自动执行。`, 0);
	}

	private async initializeGettingStartedMemory(): Promise<void> {
		this.openMemoryInitialization(
			undefined,
			() => window.setTimeout(() => {
				void this.activateTaskCenterView({ revealGettingStarted: true });
			}, 0)
		);
	}

	private async startGettingStartedMemory(): Promise<void> {
		const transcript = this.getGettingStartedFile(
			getGettingStartedMemorySourcePath(this.settings.gettingStartedState)
		);
		if (!transcript || !this.isTranscriptMarkdownFile(transcript)) {
			new Notice("请先选择一份有效的 Echo Notes 转写稿。");
			return;
		}
		await this.startMemoryTask(transcript, undefined, true);
	}

	private async selectGettingStartedMemoryTranscript(): Promise<void> {
		const transcripts = this.app.vault.getMarkdownFiles()
			.filter((file) => this.isTranscriptMarkdownFile(file))
			.sort((left, right) => right.stat.mtime - left.stat.mtime);
		if (transcripts.length === 0) {
			new Notice("Vault 中还没有可用的 Echo Notes 转写稿。");
			return;
		}
		const transcript = await selectGettingStartedTranscript(this.app, transcripts);
		if (!transcript) {
			return;
		}
		this.settings.gettingStartedState = selectGettingStartedMemorySource(
			this.settings.gettingStartedState,
			transcript.path
		);
		await this.saveSettings();
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private async openGettingStartedTranscript(kind: "first" | "shortcut"): Promise<void> {
		const state = this.settings.gettingStartedState;
		const transcript = this.getGettingStartedFile(
			kind === "shortcut"
				? state.chapters.shortcut.latestReviewTranscriptPath ?? state.shortcutTranscriptPath
				: state.chapters.first.latestReviewTranscriptPath ?? state.firstTranscriptPath
		);
		if (!transcript) {
			new Notice("新人旅程转写稿不存在。");
			return;
		}
		await this.openFileInMainWorkspace(transcript);
	}

	private async openGettingStartedMemoryCandidate(): Promise<void> {
		const state = this.settings.gettingStartedState;
		const candidate = this.getGettingStartedFile(
			state.chapters.memory.latestReviewCandidatePath ?? state.memoryCandidatePath
		);
		if (!candidate) {
			new Notice("候选记忆文件不存在或旧版新人指引未记录该路径。");
			return;
		}
		await this.openFileInMainWorkspace(candidate);
	}

	private getGettingStartedFile(path: string | undefined): TFile | null {
		if (!path) {
			return null;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		return file instanceof TFile ? file : null;
	}

	private async createNewGettingStartedExperienceNote(): Promise<TFile> {
		const path = getAvailableGettingStartedNotePath((candidatePath) =>
			Boolean(this.app.vault.getAbstractFileByPath(candidatePath))
		);
		return this.app.vault.create(
			path,
			"---\necho_notes_getting_started: true\n---\n\n# Echo Notes 首次体验\n\n"
		);
	}

	private async openFileInMainWorkspace(file: TFile): Promise<void> {
		const activeMarkdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
		const leaf = activeMarkdownView?.leaf ?? this.app.workspace.getLeaf("tab");
		await leaf.openFile(file);
		this.app.workspace.setActiveLeaf(leaf, { focus: true });
	}

	private executeObsidianCommand(commandId: string): boolean {
		return (this.app as unknown as AppWithInternals).commands?.executeCommandById?.(commandId) ?? false;
	}

	private async captureGettingStartedKnownAudioPaths(sourceNote: TFile): Promise<void> {
		const content = await this.app.vault.cachedRead(sourceNote);
		this.gettingStartedKnownAudioPaths = new Set(
			parseAudioLinks(content)
				.map((match) => this.audioFileService.resolveAudioFile(match.linkPath, sourceNote)?.path)
				.filter((path): path is string => Boolean(path))
		);
	}

	private async markGettingStartedRunning(
		kind: GettingStartedFailureKind,
		targetPath: string
	): Promise<void> {
		if (!this.matchesGettingStartedTarget(kind, targetPath)) {
			return;
		}
		this.settings.gettingStartedState = markGettingStartedTaskRunning(
			this.settings.gettingStartedState,
			kind
		);
		await this.saveSettings();
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private async markGettingStartedTranscriptionSuccess(audioPath: string, transcriptPath: string): Promise<void> {
		const nextState = recordGettingStartedTranscription(
			this.settings.gettingStartedState,
			audioPath,
			transcriptPath
		);
		if (JSON.stringify(nextState) === JSON.stringify(this.settings.gettingStartedState)) {
			return;
		}
		this.settings.gettingStartedState = nextState;
		await this.saveSettings();
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private async markGettingStartedAnalysisSuccess(transcriptPath: string): Promise<void> {
		const nextState = recordGettingStartedAnalysis(this.settings.gettingStartedState, transcriptPath);
		if (JSON.stringify(nextState) === JSON.stringify(this.settings.gettingStartedState)) {
			return;
		}
		this.settings.gettingStartedState = nextState;
		await this.saveSettings();
		const transcript = this.getGettingStartedFile(transcriptPath);
		if (transcript) {
			await this.openFileInMainWorkspace(transcript);
		}
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private async markGettingStartedMemorySuccess(transcriptPath: string, candidatePath: string): Promise<void> {
		const nextState = recordGettingStartedMemory(
			this.settings.gettingStartedState,
			transcriptPath,
			candidatePath
		);
		if (JSON.stringify(nextState) === JSON.stringify(this.settings.gettingStartedState)) {
			return;
		}
		this.settings.gettingStartedState = nextState;
		await this.saveSettings();
		await this.activateTaskCenterView();
	}

	private async markGettingStartedFailure(
		kind: GettingStartedFailureKind,
		targetPath: string,
		taskId: string
	): Promise<void> {
		if (!this.matchesGettingStartedTarget(kind, targetPath)) {
			return;
		}
		this.settings.gettingStartedState = recordGettingStartedFailure(
			this.settings.gettingStartedState,
			kind,
			taskId
		);
		await this.saveSettings();
		await this.activateTaskCenterView({ revealGettingStarted: true });
	}

	private matchesGettingStartedTarget(kind: GettingStartedFailureKind, targetPath: string): boolean {
		const state = this.settings.gettingStartedState;
		const review = state.activeReview;
		if (review) {
			if (kind === "transcription") {
				return (review.chapter === "first" || review.chapter === "shortcut") &&
					targetPath === review.audioPath;
			}
			if (kind === "analysis") {
				return review.chapter === "shortcut" && targetPath === review.transcriptPath;
			}
			return review.chapter === "memory" && targetPath === review.memorySourceTranscriptPath;
		}
		if (state.status !== "in-progress") {
			return false;
		}
		if (kind === "transcription") {
			return state.step === "first-practice" && targetPath === state.firstAudioPath ||
				state.step === "shortcut-practice" && targetPath === state.shortcutAudioPath;
		}
		if (kind === "analysis") {
			return state.step === "shortcut-practice" &&
				state.chapters.shortcut.outcome === "pending" &&
				targetPath === state.shortcutTranscriptPath;
		}
		return getCurrentGettingStartedChapter(state) === "memory" &&
			targetPath === getGettingStartedMemorySourcePath(state);
	}

	private notifySettingsChanged(): void {
		for (const listener of this.settingsListeners) {
			listener();
		}
	}

	private notifyGettingStartedChanged(): void {
		for (const listener of this.gettingStartedListeners) {
			listener();
		}
	}

	async openTaskCenterTask(task: EchoNotesTask): Promise<void> {
		const path = task.outputPath ?? task.targetPath;
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`任务文件不存在：${path}`);
			return;
		}

		await this.openFileInMainWorkspace(file);
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
			new Notice("当前 Obsidian 版本未暴露核心插件录音机内部 API，请到核心插件设置中手动开启“录音机”。");
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
				new Notice("无法切换 Obsidian 核心插件录音机，请到核心插件设置中手动调整“录音机”。");
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
		const saved = await this.setObsidianCommandHotkey(commandId, hotkey, "转写当前笔记全部音频", "Echo Notes");
		if (saved) {
			this.settings.transcribeAllAudioHotkey = cloneHotkey(hotkey);
		}
		return saved;
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
		} else {
			this.notifySettingsChanged();
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
		} else {
			this.notifySettingsChanged();
		}
	}

	getMemoryApiKey(): string {
		return this.app.secretStorage.getSecret(getMemoryApiKeySecretId(this.settings.memoryProvider)) ?? "";
	}

	async saveMemoryApiKey(apiKey: string): Promise<void> {
		try {
			this.app.secretStorage.setSecret(getMemoryApiKeySecretId(this.settings.memoryProvider), apiKey);
		} catch (error) {
			this.log("记忆 API Key 保存失败", error);
			throw new Error(`无法写入 Obsidian SecretStorage：${getSanitizedErrorMessage(error)}`, { cause: error });
		}
	}

	openMemoryInitialization(onInitialized?: () => void, onClosed?: () => void): void {
		if (this.settings.memoryInitialized) {
			new Notice("Echo Memory 已初始化。");
			void this.openMemoryHome().finally(() => onClosed?.());
			return;
		}
		new MemoryInitializationModal(this.app, async (profile) => {
			const homeFile = await this.memoryService.initialize(this.settings, profile);
			this.settings.memoryInitialized = true;
			this.settings.memoryEnabled = true;
			this.settings.memoryPathLanguage = this.settings.copyLanguage;
			await this.saveSettings();
			onInitialized?.();
			await this.app.workspace.getLeaf(false).openFile(homeFile);
			new Notice("Echo Memory 已初始化并启用。");
		}, onClosed).open();
	}

	async openMemoryHome(): Promise<void> {
		try {
			const homeFile = await this.memoryService.getHomeFile(this.settings);
			await this.app.workspace.getLeaf(false).openFile(homeFile);
		} catch (error) {
			new Notice(getErrorMessage(error));
		}
	}

	async openMemoryTimeline(): Promise<void> {
		try {
			const timelineFile = await this.memoryService.getTimelineFile(this.settings);
			await this.app.workspace.getLeaf(false).openFile(timelineFile);
		} catch (error) {
			new Notice(getErrorMessage(error));
		}
	}

	async openPersonalAgentContextPackage(): Promise<void> {
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		try {
			const context = await this.memoryService.getMemoryContextPackageContext(this.settings);
			new MemoryContextModal(this.app, context.entries, context.choices, context.language, {
				onGenerate: async (options) => {
					const result = await this.memoryService.createMemoryContextPackage(this.settings, options);
					const file = this.app.vault.getAbstractFileByPath(result.path);
					if (!(file instanceof TFile)) {
						throw new Error(`上下文包已生成，但文件不存在：${result.path}`);
					}
					await this.app.workspace.getLeaf(false).openFile(file);
					new Notice(`Personal Agent 上下文包已生成：${result.preview.includedCount}/${result.preview.matchingCount} 条记忆。`);
				}
			}).open();
		} catch (error) {
			new Notice(`无法打开 Personal Agent 上下文包：${getErrorMessage(error)}`);
		}
	}

	async rebuildMemoryProfiles(): Promise<void> {
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		const taskId = createTaskId("memory", this.settings.memoryRootFolder, "rebuild");
		this.taskCenter.upsertTask({
			id: taskId,
			kind: "memory",
			title: "重建 Echo Memory 画像与聚合视图",
			status: "running",
			stage: "正在读取记忆候选包",
			targetPath: this.settings.memoryRootFolder,
			provider: "本地编译器",
			model: "候选包 Schema v1",
			recovery: { kind: "memory-rebuild" },
			completedAt: undefined,
			error: undefined,
			retry: { label: "重试重建", run: () => this.rebuildMemoryProfiles() }
		});
		try {
			const count = await this.memoryService.compileProfiles(this.settings);
			const homeFile = await this.memoryService.getHomeFile(this.settings);
			this.taskCenter.updateTask(taskId, {
				status: "success",
				stage: `已重建 ${count} 份画像和 3 份聚合视图`,
				outputPath: homeFile.path,
				completedAt: Date.now()
			});
			new Notice(`Echo Memory 已从候选包重建 ${count} 份画像和 3 份聚合视图。`);
		} catch (error) {
			const message = getErrorMessage(error);
			this.taskCenter.updateTask(taskId, {
				status: "failed",
				stage: "画像与聚合视图重建失败",
				error: message,
				completedAt: Date.now()
			});
			new Notice(`Echo Memory 画像与聚合视图重建失败：${message}`);
		}
	}

	async reviewCurrentMemoryCandidate(): Promise<void> {
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) {
			new Notice("请先打开一个 Echo Memory 候选包或审核文件。");
			return;
		}
		await this.openMemoryCandidateReview(currentFile);
	}

	async reviewMemoryCandidatePath(path: string): Promise<void> {
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(`候选记忆文件不存在：${path}`);
			return;
		}
		await this.openMemoryCandidateReview(file);
	}

	private async openMemoryCandidateReview(file: TFile): Promise<void> {
		try {
			const context = await this.memoryService.getReviewContext(this.settings, file);
			new MemoryReviewModal(this.app, context.candidate, context.review, async (updates) => {
				const result = await this.memoryService.saveMemoryReview(this.settings, context.candidatePath, updates);
				const reviewFile = this.app.vault.getAbstractFileByPath(result.reviewPath);
				if (reviewFile instanceof TFile) {
					await this.app.workspace.getLeaf(false).openFile(reviewFile);
				}
				const compilation = result.compiledProfiles === undefined
					? "画像与聚合视图未自动重建"
					: `已重建 ${result.compiledProfiles} 份画像和 3 份聚合视图`;
				new Notice(
					`审核已保存：批准 ${result.counts.approved} 条，拒绝 ${result.counts.rejected} 条，待审核 ${result.counts.pending} 条；${compilation}。`
				);
			}).open();
		} catch (error) {
			new Notice(`无法打开候选审核：${getErrorMessage(error)}`);
		}
	}

	private showMemoryReviewNotice(message: string, candidatePath: string): void {
		const fragment = createFragment();
		fragment.createSpan({ text: message });
		fragment.appendText(" ");
		const buttonEl = fragment.createEl("button", {
			cls: "echo-notes-notice-action",
			text: "立即审核",
			attr: { type: "button" }
		});
		const notice = new Notice(fragment, 12000);
		buttonEl.addEventListener("click", () => {
			notice.hide();
			void this.reviewMemoryCandidatePath(candidatePath);
		});
	}

	async manageCurrentMemoryRelations(): Promise<void> {
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		const currentFile = this.app.workspace.getActiveFile();
		if (!currentFile) {
			new Notice("请先打开一个 Echo Memory 候选包或审核文件。");
			return;
		}
		try {
			const context = await this.memoryService.getMemoryRelationContext(this.settings, currentFile);
			const reloadContext = async () => {
				const candidateFile = this.app.vault.getAbstractFileByPath(context.candidatePath);
				if (!(candidateFile instanceof TFile)) {
					throw new Error(`记忆候选包不存在：${context.candidatePath}`);
				}
				return this.memoryService.getMemoryRelationContext(this.settings, candidateFile);
			};
			new MemoryRelationModal(this.app, context, {
				onConfirm: async (input) => {
					const result = await this.memoryService.confirmMemoryRelation(
						this.settings,
						context.candidatePath,
						input.type,
						input.source,
						input.target,
						input.note
					);
					const compilation = result.compiledProfiles === undefined
						? "画像与聚合视图未自动重建"
						: `已重建 ${result.compiledProfiles} 份画像和 3 份聚合视图`;
					new Notice(`记忆关系已确认：${compilation}。`);
					return reloadContext();
				},
				onRevoke: async (relationId, note) => {
					const result = await this.memoryService.revokeMemoryRelation(
						this.settings,
						context.candidatePath,
						relationId,
						note
					);
					const compilation = result.compiledProfiles === undefined
						? "画像与聚合视图未自动重建"
						: `已重建 ${result.compiledProfiles} 份画像和 3 份聚合视图`;
					new Notice(`记忆关系已撤销：${compilation}。`);
					return reloadContext();
				}
			}).open();
		} catch (error) {
			new Notice(`无法管理记忆关系：${getErrorMessage(error)}`);
		}
	}

	refreshServices(): void {
		this.audioFileService = new AudioFileService(this.app);
		this.transcriptService = new TranscriptService(this.app, this.settings);
		this.linkService = new LinkService(this.app, this.settings);
		this.analysisService = new AnalysisService(this.app);
		this.memoryService = new MemoryService(this.app);
	}

	private registerCommands(): void {
		this.removeRegisteredCommands();

		this.addCommand({
			id: "open-task-center",
			name: "打开任务中心",
			callback: () => {
				void this.activateTaskCenterView();
			}
		});

		this.addCommand({
			id: "open-getting-started",
			name: "打开新人指引",
			callback: () => {
				void this.openGettingStarted();
			}
		});

		this.addCommand({
			id: "transcribe-selected-audio",
			name: "转写选中音频",
			editorCallback: (editor, view) => {
				void this.handleTranscribeSelectedAudio(editor, view);
			}
		});

		this.addCommand({
			id: "transcribe-all-audio-files-in-current-note",
			name: "转写当前笔记全部音频",
			editorCallback: (editor, view) => {
				void this.handleTranscribeAllAudioInCurrentNote(editor, view);
			}
		});

		this.addCommand({
			id: "start-realtime-transcription",
			name: "开始实时转写",
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
			name: "停止实时转写",
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
			name: "打开当前实时转写稿",
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
			name: "使用选定模板分析当前转写稿",
			callback: () => {
				void this.handleAnalyzeCurrentTranscriptWithTemplate();
			}
		});

		this.addCommand({
			id: "initialize-echo-memory",
			name: "初始化 Echo Memory",
			callback: () => this.openMemoryInitialization()
		});

		this.addCommand({
			id: "extract-memory-from-current-transcript",
			name: "从当前转写稿提取记忆",
			callback: () => {
				void this.handleExtractMemoryFromCurrentTranscript();
			}
		});

		this.addCommand({
			id: "review-current-memory-candidate",
			name: "审核当前记忆候选",
			callback: () => {
				void this.reviewCurrentMemoryCandidate();
			}
		});

		this.addCommand({
			id: "manage-current-memory-relations",
			name: "管理当前记忆关系",
			callback: () => {
				void this.manageCurrentMemoryRelations();
			}
		});

		this.addCommand({
			id: "open-echo-memory-home",
			name: "打开 Echo Memory 首页",
			callback: () => {
				void this.openMemoryHome();
			}
		});

		this.addCommand({
			id: "open-echo-memory-timeline",
			name: "打开 Echo Memory 时间线",
			callback: () => {
				void this.openMemoryTimeline();
			}
		});

		this.addCommand({
			id: "create-personal-agent-context-package",
			name: ["生成", "Personal Agent", "上下文包"].join(" "),
			callback: () => {
				void this.openPersonalAgentContextPackage();
			}
		});

		this.addCommand({
			id: "rebuild-memory-profiles",
			name: "从候选包重建记忆画像与聚合视图",
			callback: () => {
				void this.rebuildMemoryProfiles();
			}
		});

		this.addCommand({
			id: "export-diagnostic-package",
			name: "导出诊断日志包",
			callback: () => this.openDiagnosticExport()
		});

	}

	private registerEditorContextMenu(): void {
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor, info) => {
				menu.addItem((item) => {
					item
						.setTitle("转写当前笔记音频")
						.setIcon("audio-lines")
						.onClick(() => {
							void this.handleTranscribeAllAudioInCurrentNote(editor, info);
						});
				});
			})
		);
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
		actionLabel: string,
		commandOwner = "Obsidian 核心插件录音机"
	): Promise<boolean> {
		const hotkeyManager = this.getHotkeyManager();
		const commands = (this.app as unknown as AppWithInternals).commands?.commands;
		if (!commands || typeof hotkeyManager?.setHotkeys !== "function" || typeof hotkeyManager?.save !== "function") {
			new Notice("当前 Obsidian 版本未暴露快捷键内部 API，请到 Obsidian 快捷键设置中手动修改“录音机”。");
			return false;
		}
		const result = await saveHotkeyAssignments(
			[{ id: "hotkey", commandId, hotkey }],
			commands,
			{
				getHotkeys: (id) => hotkeyManager.getHotkeys?.(id),
				getDefaultHotkeys: (id) => hotkeyManager.getDefaultHotkeys?.(id),
				setHotkeys: (id, commandHotkeys) => hotkeyManager.setHotkeys?.(id, commandHotkeys),
				save: () => hotkeyManager.save?.()
			}
		);
		if (result.conflicts.hotkey?.length) {
			new Notice(`快捷键与其他命令冲突，未保存：${result.conflicts.hotkey.join("、")}`);
			return false;
		}
		if (result.saved) {
			new Notice(`已保存${commandOwner}${actionLabel}快捷键。`);
			return true;
		}
		if (result.rollbackError) {
			this.log("回滚快捷键失败", { commandId, error: result.rollbackError });
		}
		new Notice(`保存${commandOwner}快捷键失败：${getErrorMessage(result.error)}`);
		this.log(`保存${commandOwner}快捷键失败`, { commandId, error: result.error });
		return false;
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
								this.startAnalysisTasks(result.transcriptFile, this.getDefaultAnalysisTemplatesForAnalysis(), result.diagnosticChainId);
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
			this.startAnalysisTasks(transcriptFile, analysisTemplates, result.diagnosticChainId);
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
				this.startAnalysisTasks(transcriptFile, analysisTemplates, result.diagnosticChainId);
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
			this.startAnalysisTasks(transcriptFile, [template]);
		}).open();
	}

	private async handleExtractMemoryFromCurrentTranscript(): Promise<void> {
		const transcriptFile = this.app.workspace.getActiveFile();
		if (!transcriptFile || !this.isTranscriptMarkdownFile(transcriptFile)) {
			new Notice("请先打开一个 Echo Notes 转写稿。");
			return;
		}
		if (!this.settings.memoryInitialized) {
			new Notice("请先初始化 Echo Memory。");
			return;
		}
		void this.startMemoryTask(transcriptFile, undefined, true);
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
		const diagnostic = this.startDiagnosticSession(
			"transcription",
			options.diagnosticChainId,
			options.diagnosticRetryOfSessionId
		);
		const diagnosticSink = this.diagnostics.getSink(diagnostic.id);
		this.diagnostics.record(diagnostic.id, "configuration", "transcription-configuration", {
			provider: transcriptionConfig.provider,
			baseUrl: transcriptionConfig.baseUrl,
			model: transcriptionConfig.model,
			language: transcriptionConfig.language || "auto",
			keyPresent: Boolean(this.getApiKey(transcriptionConfig.provider).trim()),
			audioExtension: audioFile.extension,
			audioBytes: audioFile.stat.size
		});
		const checkpointIdentity = createTranscriptionCheckpointIdentity(audioFile, transcriptionConfig);
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
				diagnosticSessionId: diagnostic.id,
				diagnosticChainId: diagnostic.chainId,
				completedAt: Date.now()
			});
			this.diagnostics.complete(diagnostic.id, "skipped", { reason: "existing-transcript-reused" });
			new Notice("Transcript 已存在，已跳过转写。");
			await notifyTranscriptFileReady(reusableTranscript);
			await this.markGettingStartedTranscriptionSuccess(audioFile.path, reusableTranscript.path);
			return { transcriptFile: reusableTranscript, analysisEligible: true, diagnosticChainId: diagnostic.chainId };
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
				this.diagnostics.complete(diagnostic.id, "skipped", { reason: "upload-confirmation-required" });
				new Notice("已跳过自动转写：当前开启了手动转写前确认上传。");
				return null;
			}

			const confirmed = await this.confirmTranscriptionUpload(audioFile);
			if (!confirmed) {
				this.diagnostics.complete(diagnostic.id, "skipped", { reason: "user-cancelled-upload" });
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
			diagnosticSessionId: diagnostic.id,
			diagnosticChainId: diagnostic.chainId,
			recovery: {
				kind: "transcription",
				audioPath: audioFile.path,
				sourcePath: sourceNote?.path,
				audioLinkPath: options.audioLinkPath
			},
			completedAt: undefined,
			retry: {
				label: "重试转写",
				run: () => this.retryTranscriptionTask(audioFile.path, sourceNote?.path, options.audioLinkPath)
			}
		});
		await this.markGettingStartedRunning("transcription", audioFile.path);
		let completedSegments: TranscriptionSegment[] = [];
		let streamingState: StreamingTranscriptionState | undefined;
		let diagnosticsPassed = false;
		let longAudioNotice: Notice | null = null;
		const updateLongAudioNotice = (message: string): void => {
			if (!longAudioNotice) {
				longAudioNotice = new Notice(message, 0);
				return;
			}
			longAudioNotice.setMessage(message);
		};
		const hideLongAudioNotice = (): void => {
			longAudioNotice?.hide();
			longAudioNotice = null;
		};
		try {
			const diagnostics = diagnoseTranscriptionProviderSettings(
				transcriptionConfig,
				this.getApiKey(transcriptionConfig.provider),
				{ isMobile: Platform.isMobile, usage: "offline" }
			);
			this.diagnostics.record(diagnostic.id, "configuration", "transcription-local-diagnostics", {
				canAttempt: diagnostics.canAttemptTranscription,
				items: diagnostics.items.map((item) => ({ severity: item.severity, title: item.title }))
			});
			if (!diagnostics.canAttemptTranscription) {
				throw new Error(diagnostics.items.filter((item) => item.severity === "error").map((item) => item.detail).join("；"));
			}
			diagnosticsPassed = true;
			const provider = createTranscriptionProvider(
				this.app,
				transcriptionConfig,
				this.getApiKey(transcriptionConfig.provider)
			);
			completedSegments = await this.transcriptService.getResumableTranscriptionSegments(
				audioFile,
				checkpointIdentity
			);
			const initialTranscriptFile = await this.transcriptService.writeTranscribingTranscript(
				audioFile,
				sourceNote,
				provider.id,
				transcriptionConfig.model,
				completedSegments,
				undefined,
				checkpointIdentity
			);
			await notifyTranscriptFileReady(initialTranscriptFile);
			this.taskCenter.updateTask(transcriptionTaskId, {
				stage: "正在准备音频",
				outputPath: initialTranscriptFile.path
			});
			new Notice(`已创建转写稿，开始准备音频：${audioFile.name}`);
			const handleProgress = async (progress: TranscriptionProgress): Promise<void> => {
				this.recordTranscriptionDiagnosticProgress(diagnostic.id, progress);
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
						streamingState,
						checkpointIdentity
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
					completedSegments = progress.segments;
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						transcriptionConfig.model,
						completedSegments,
						undefined,
						checkpointIdentity
					);
					await notifyTranscriptFileReady(transcriptFile);
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: "正在准备长音频分段",
						outputPath: transcriptFile.path,
						currentSegment: completedSegments.length,
						totalSegments: undefined
					});
					updateLongAudioNotice(`长音频处理中：正在准备分段 · ${audioFile.name}`);
					return;
				}

				if (progress.type === "long-audio-started") {
					completedSegments = progress.segments;
					const transcriptFile = await this.transcriptService.writeTranscribingTranscript(
						audioFile,
						sourceNote,
						provider.id,
						transcriptionConfig.model,
						completedSegments,
						undefined,
						checkpointIdentity
					);
					await notifyTranscriptFileReady(transcriptFile);
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: completedSegments.length > 0
							? `已恢复 ${completedSegments.length}/${progress.totalSegments} 个成功分段`
							: `长音频分段已开始，共 ${progress.totalSegments} 段`,
						outputPath: transcriptFile.path,
						currentSegment: completedSegments.length,
						totalSegments: progress.totalSegments
					});
					updateLongAudioNotice(
						completedSegments.length > 0
							? `长音频处理中：已恢复 ${completedSegments.length}/${progress.totalSegments} 段，继续转写剩余内容 · ${audioFile.name}`
							: `长音频处理中：共 ${progress.totalSegments} 段，正在逐段转写 · ${audioFile.name}`
					);
					return;
				}

				if (progress.type === "segment-started") {
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `正在转写分段 ${progress.segment.index}/${progress.segment.total}`,
						currentSegment: progress.segment.index,
						totalSegments: progress.segment.total
					});
					updateLongAudioNotice(
						`长音频处理中：正在转写分段 ${progress.segment.index}/${progress.segment.total} · ${audioFile.name}`
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
					updateLongAudioNotice(
						`长音频处理中：${targetText}${rangeText}失败，${Math.round(progress.delayMs / 1000)} 秒后重试 ${progress.attempt}/${progress.maxAttempts} · ${audioFile.name}`
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
						completedSegments,
						undefined,
						checkpointIdentity
					);
					const rangeText = formatSegmentTimeRange(progress.segment);
					this.taskCenter.updateTask(transcriptionTaskId, {
						stage: `分段 ${rangeText} 已缩小为 ${progress.replacementSegments.length} 段`,
						currentSegment: completedSegments.length,
						totalSegments: progress.totalSegments
					});
					updateLongAudioNotice(
						`长音频处理中：分段 ${rangeText} 已缩小为 ${progress.replacementSegments.length} 段，已完成内容不会重传 · ${audioFile.name}`
					);
					return;
				}

				completedSegments = progress.segments;
				await this.transcriptService.writeTranscribingTranscript(
					audioFile,
					sourceNote,
					provider.id,
					transcriptionConfig.model,
					completedSegments,
					undefined,
					checkpointIdentity
				);
				this.taskCenter.updateTask(transcriptionTaskId, {
					stage: `已写入分段 ${progress.segment.index}/${progress.segment.total}`,
					currentSegment: progress.segment.index,
					totalSegments: progress.segment.total
				});
				updateLongAudioNotice(
					`长音频处理中：已完成分段 ${progress.segment.index}/${progress.segment.total} · ${audioFile.name}`
				);
			};
			const result = await provider.transcribe({
				audioFile,
				sourceNote,
				language: transcriptionConfig.language,
				resumeSegments: completedSegments,
				onProgress: handleProgress,
				diagnostics: diagnosticSink
			});
			const transcriptFile = await this.transcriptService.writeSuccessTranscript(audioFile, sourceNote, result);
			await notifyTranscriptFileReady(transcriptFile);
			hideLongAudioNotice();
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
			this.diagnostics.complete(diagnostic.id, "success", {
				traceId: result.traceId,
				segmentCount: result.segments?.length ?? 0
			});
			await this.markGettingStartedTranscriptionSuccess(audioFile.path, transcriptFile.path);
			new Notice(`转写完成：${audioFile.name}`);
			return { transcriptFile, analysisEligible: true, diagnosticChainId: diagnostic.chainId };
		} catch (error) {
			hideLongAudioNotice();
			const message = getErrorMessage(error);
			const traceId = error instanceof TranscriptionError ? error.traceId ?? streamingState?.traceId : streamingState?.traceId;
			this.taskCenter.updateTask(transcriptionTaskId, {
				status: "failed",
				stage: "转写失败",
				error: message,
				traceId,
				completedAt: Date.now()
			});
			this.diagnostics.complete(diagnostic.id, "failed", {
				error: message,
				traceId,
				errorCategory: classifyDiagnosticError(error)
			});
			await this.markGettingStartedFailure("transcription", audioFile.path, transcriptionTaskId);
			new Notice(getTaskFailureNotice("transcription", message));
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
						streamingState,
						checkpointIdentity
					);
					await notifyTranscriptFileReady(transcriptFile);
					this.taskCenter.updateTask(transcriptionTaskId, {
						outputPath: transcriptFile.path
					});
					return { transcriptFile, analysisEligible: false, diagnosticChainId: diagnostic.chainId };
				} catch (writeError) {
					new Notice(`写入失败 transcript 时出错：${getErrorMessage(writeError)}`);
				}
			}

			return null;
		}
	}

	private async retryTranscriptionTask(
		audioPath: string,
		sourcePath: string | undefined,
		audioLinkPath: string | undefined,
		diagnosticChainId?: string,
		diagnosticRetryOfSessionId?: string
	): Promise<void> {
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
		const previousTask = this.taskCenter.getTask(createTaskId("transcription", audioPath));
		const result = await this.processAudioToTranscript(audioFile, sourceNote, {
			allowUploadConfirmation: true,
			audioLinkPath,
			forceTranscription: true,
			diagnosticChainId: diagnosticChainId ?? previousTask?.diagnosticChainId,
			diagnosticRetryOfSessionId: diagnosticRetryOfSessionId ?? previousTask?.diagnosticSessionId,
			onTranscriptFileReady: async (transcriptFile) => {
				if (sourceNote && audioLinkPath) {
					await this.insertTranscriptLinkIntoFile(sourceNote, audioLinkPath, transcriptFile);
				}
			}
		});

		if (result?.analysisEligible) {
			this.startAnalysisTasks(result.transcriptFile, this.getDefaultAnalysisTemplatesForAnalysis(), result.diagnosticChainId);
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
				new Notice("Transcript 链接已存在，已跳过插入。");
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

	private startAnalysisTasks(
		transcriptFile: TFile,
		templates: AnalysisTemplateConfig[],
		diagnosticChainId?: string
	): void {
		if (templates.length === 0) {
			return;
		}
		void this.runAnalysisBatch(transcriptFile, templates, diagnosticChainId);
	}

	private async runAnalysisBatch(
		transcriptFile: TFile,
		templates: AnalysisTemplateConfig[],
		diagnosticChainId?: string
	): Promise<void> {
		const results = await Promise.all(
			templates.map(async (template) => ({
				template,
				success: await this.startAnalysisTask(transcriptFile, template, diagnosticChainId)
			}))
		);
		const successfulTemplateIds = results
			.filter((result) => result.success)
			.map((result) => result.template.id);
		if (successfulTemplateIds.length > 0) {
			void this.startMemoryTask(transcriptFile, successfulTemplateIds, false, false, diagnosticChainId);
		}
	}

	private async startAnalysisTask(
		transcriptFile: TFile,
		template: AnalysisTemplateConfig | null | undefined,
		diagnosticChainId?: string,
		diagnosticRetryOfSessionId?: string
	): Promise<boolean> {
		if (!template || !this.settings.analysisEnabled) {
			return false;
		}

		const templateTitle = template.name;
		const processingKey = `${transcriptFile.path}:${template.id}`;
		const analysisTaskId = createTaskId("analysis", transcriptFile.path, template.id);
		if (this.processingAnalyses.has(processingKey)) {
			new Notice(`正在后台生成 ${templateTitle}：${transcriptFile.name}`);
			return false;
		}
		const diagnostic = this.startDiagnosticSession("analysis", diagnosticChainId, diagnosticRetryOfSessionId);

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
			diagnosticSessionId: diagnostic.id,
			diagnosticChainId: diagnostic.chainId,
			recovery: {
				kind: "analysis",
				transcriptPath: transcriptFile.path,
				templateId: template.id
			},
			completedAt: undefined,
			retry: {
				label: "重试分析",
				run: () => this.retryAnalysisTask(transcriptFile.path, template.id)
			}
		});
		this.processingAnalyses.add(processingKey);
		await this.markGettingStartedRunning("analysis", transcriptFile.path);
		new Notice(`后台生成 ${templateTitle}：${transcriptFile.name}`);
		return this.runAnalysisTask(transcriptFile, template, processingKey, analysisTaskId, diagnostic.id);
	}

	private async retryAnalysisTask(transcriptPath: string, templateId: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(transcriptPath);
		if (!(file instanceof TFile) || !this.isTranscriptMarkdownFile(file)) {
			new Notice(`无法重试分析，转写稿不存在：${transcriptPath}`);
			return;
		}
		const template = this.settings.analysisTemplates.find((item) => item.id === templateId);
		if (!template) {
			new Notice(`无法重试分析，模板不存在：${templateId}`);
			return;
		}
		const previousTask = this.taskCenter.getTask(createTaskId("analysis", transcriptPath, templateId));
		await this.startAnalysisTask(file, template, previousTask?.diagnosticChainId, previousTask?.diagnosticSessionId);
	}

	private async runAnalysisTask(
		transcriptFile: TFile,
		template: AnalysisTemplateConfig,
		processingKey: string,
		analysisTaskId: string,
		diagnosticSessionId: string
	): Promise<boolean> {
		if (!this.settings.analysisEnabled) {
			this.taskCenter.updateTask(analysisTaskId, {
				status: "skipped",
				stage: "AI 纪要分析未启用",
				completedAt: Date.now()
			});
			new Notice("AI 纪要分析未启用，请先在 Echo Notes 设置中开启。");
			await this.markGettingStartedFailure("analysis", transcriptFile.path, analysisTaskId);
			this.diagnostics.complete(diagnosticSessionId, "skipped", { reason: "analysis-disabled" });
			this.processingAnalyses.delete(processingKey);
			return false;
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
				await this.markGettingStartedFailure("analysis", transcriptFile.path, analysisTaskId);
				this.diagnostics.complete(diagnosticSessionId, "skipped", { reason: "empty-transcript" });
				return false;
			}

			const diagnostics = diagnoseAnalysisProviderSettings(
				this.settings,
				this.getAnalysisApiKey(),
				transcriptText.length
			);
			if (!diagnostics.canAttemptAnalysis) {
				throw new Error(diagnostics.items.filter((item) => item.severity === "error").map((item) => item.detail).join("；"));
			}
			this.diagnostics.record(diagnosticSessionId, "configuration", "analysis-configuration", {
				provider: this.settings.analysisProvider,
				baseUrl: this.settings.analysisBaseUrl,
				model: this.settings.analysisModel,
				keyPresent: Boolean(this.getAnalysisApiKey().trim()),
				templateType: template.builtin ? "builtin" : "custom",
				inputCharacters: transcriptText.length,
				redactTranscriptBeforeAnalysis: this.settings.redactTranscriptBeforeAnalysis,
				localChecks: diagnostics.items.map((item) => ({ severity: item.severity, title: item.title }))
			});
			const provider = createAnalysisProvider(this.settings, this.getAnalysisApiKey());
			const analysisTranscriptText = this.settings.redactTranscriptBeforeAnalysis
				? redactAnalysisInputText(transcriptText)
				: transcriptText;
			const analysisInput = {
				template,
				transcriptTitle: transcriptFile.basename,
				transcriptText: analysisTranscriptText,
				copyLanguage: this.settings.copyLanguage,
				diagnostics: this.diagnostics.getSink(diagnosticSessionId)
			};
			const chunks = this.settings.analysisLongTextEnabled
				? splitAnalysisText(analysisTranscriptText, {
						maxCharacters: this.settings.analysisChunkCharacters,
						overlapCharacters: 400
					})
				: [];
			if (chunks.length > ANALYSIS_CHECKPOINT_MAX_CHUNKS) {
				throw new Error(
					`转写稿将产生 ${chunks.length} 个分析分块，超过安全上限 ${ANALYSIS_CHECKPOINT_MAX_CHUNKS}。请提高分块字符数、缩短转写稿或拆分文件后重试。`
				);
			}
			this.diagnostics.record(diagnosticSessionId, "lifecycle", "analysis-chunks-prepared", {
				chunkCount: chunks.length || 1,
				chunked: chunks.length > 1,
				inputCharacters: analysisTranscriptText.length
			});
			if (!this.settings.analysisLongTextEnabled && analysisTranscriptText.length > this.settings.analysisChunkCharacters) {
				throw new Error("转写稿超过单次分析安全长度，且长文本分块已关闭。请开启长文本分块分析或拆分转写稿。");
			}
			let result: AnalysisResult;
			if (chunks.length > 1 && isChunkedAnalysisProvider(provider)) {
				const checkpointIdentity = createAnalysisCheckpointIdentity({
					transcriptPath: transcriptFile.path,
					analysisText: analysisTranscriptText,
					template,
					settings: this.settings,
					overlapCharacters: 400
				});
				const resumeResults = await this.analysisService.readResumableChunkResults(
					transcriptFile,
					checkpointIdentity,
					chunks
				);
				if (resumeResults.length > 0) {
					this.diagnostics.record(diagnosticSessionId, "lifecycle", "analysis-chunks-recovered", {
						recoveredChunks: resumeResults.length,
						totalChunks: chunks.length
					});
					this.taskCenter.updateTask(analysisTaskId, {
						stage: `已恢复 ${resumeResults.length}/${chunks.length} 个分析分块`,
						currentSegment: resumeResults.length,
						totalSegments: chunks.length
					});
				}
				result = await analyzeChunkSequence({
					analysisInput,
					chunks,
					resumeResults,
					analyzeChunk: (input, chunk) => provider.analyzeChunk(input, chunk.index, chunk.total),
					prepareResult: prepareAnalysisCheckpointResult,
					synthesize: (input, chunkResults) => provider.synthesizeChunks(input, chunkResults),
					onChunkStart: (chunk) => {
						this.diagnostics.record(diagnosticSessionId, "progress", "analysis-chunk-started", {
							chunkIndex: chunk.index,
							totalChunks: chunk.total,
							characters: chunk.text.length
						});
						this.taskCenter.updateTask(analysisTaskId, {
							stage: `正在分析长文本分块 ${chunk.index}/${chunk.total}（约 ${estimateAnalysisTextTokens(chunk.text)} tokens）`,
							currentSegment: chunk.index - 1,
							totalSegments: chunk.total
						});
					},
					onChunkComplete: async (chunk, chunkResults) => {
						await this.analysisService.writeAnalysisCheckpoint(
							transcriptFile,
							createAnalysisCheckpoint(checkpointIdentity, chunks, chunkResults)
						);
						this.taskCenter.updateTask(analysisTaskId, {
							stage: `已保存分析分块 ${chunk.index}/${chunk.total}`,
							currentSegment: chunk.index,
							totalSegments: chunk.total
						});
						this.diagnostics.record(diagnosticSessionId, "progress", "analysis-chunk-completed", {
							chunkIndex: chunk.index,
							totalChunks: chunk.total
						});
					},
					onSynthesisStart: () => {
						this.diagnostics.record(diagnosticSessionId, "lifecycle", "analysis-synthesis-started", {
							totalChunks: chunks.length
						});
						this.taskCenter.updateTask(analysisTaskId, {
							stage: `正在汇总 ${chunks.length} 个分析分块`,
							currentSegment: chunks.length,
							totalSegments: chunks.length
						});
					}
				});
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
			try {
				await this.analysisService.clearAnalysisCheckpoint(transcriptFile, template.id);
			} catch (error) {
				this.log("清理 AI 分析检查点失败", error);
			}
			this.taskCenter.updateTask(analysisTaskId, {
				status: "success",
				stage: `${templateTitle} 已写入转写稿`,
				provider: result.provider,
				model: result.model,
				traceId: result.traceId,
				error: undefined,
				completedAt: Date.now()
			});
			this.diagnostics.complete(diagnosticSessionId, "success", { traceId: result.traceId });
			await this.markGettingStartedAnalysisSuccess(transcriptFile.path);
			new Notice(`${templateTitle} 已写入转写稿：${transcriptFile.name}`);
			return true;
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
			this.diagnostics.complete(diagnosticSessionId, "failed", {
				error: message,
				errorCategory: classifyDiagnosticError(error)
			});
			await this.markGettingStartedFailure("analysis", transcriptFile.path, analysisTaskId);
			new Notice(getTaskFailureNotice("analysis", message));
			this.log("AI 纪要分析失败", error);
			return false;
		} finally {
			this.processingAnalyses.delete(processingKey);
		}
	}

	private async startMemoryTask(
		transcriptFile: TFile,
		analysisTemplateIds: readonly string[] | undefined,
		manual: boolean,
		retryRequested = false,
		diagnosticChainId?: string,
		diagnosticRetryOfSessionId?: string
	): Promise<void> {
		if (!this.settings.memoryInitialized || (!manual && !this.settings.memoryEnabled)) {
			return;
		}
		const processingKey = transcriptFile.path;
		const taskId = createTaskId("memory", transcriptFile.path);
		const activeTask = this.activeMemoryTasks.get(processingKey);
		if (activeTask) {
			if (!retryRequested) {
				new Notice(`正在后台提取记忆：${transcriptFile.name}`);
				return;
			}
			this.diagnostics.record(activeTask.diagnosticSessionId, "lifecycle", "memory-retry-requested");
			this.diagnostics.complete(activeTask.diagnosticSessionId, "failed", { error: "用户发起重试，当前提取已取消" });
			activeTask.controller.abort(new Error("当前记忆提取已由用户重试。"));
			await activeTask.promise;
		}

		if (retryRequested) {
			try {
				await this.memoryService.appendExtractionRetryLog(this.settings, transcriptFile.path);
			} catch (error) {
				this.log("写入 Echo Memory 重试日志失败", error);
			}
		}

		const diagnostic = this.startDiagnosticSession("memory", diagnosticChainId, diagnosticRetryOfSessionId);
		const controller = new AbortController();
		const task = {
			id: taskId,
			kind: "memory",
			title: `记忆提取：${transcriptFile.name}`,
			status: "running",
			stage: "正在准备转写正文与成功纪要",
			provider: this.settings.memoryProvider,
			model: this.settings.memoryModel,
			targetPath: transcriptFile.path,
			sourcePath: transcriptFile.path,
			error: undefined,
			traceId: undefined,
			diagnosticSessionId: diagnostic.id,
			diagnosticChainId: diagnostic.chainId,
			recovery: {
				kind: "memory-extraction",
				transcriptPath: transcriptFile.path,
				analysisTemplateIds: analysisTemplateIds ? [...analysisTemplateIds] : undefined
			},
			completedAt: undefined,
			retry: {
				label: "重试记忆提取",
				allowWhileRunning: true,
				run: () => this.retryMemoryTask(transcriptFile.path, analysisTemplateIds)
			}
		} as const;
		this.taskCenter.restartTask(task);
		await this.markGettingStartedRunning("memory", transcriptFile.path);
		new Notice(`${retryRequested ? "重新开始" : "后台提取"}记忆：${transcriptFile.name}`);
		const activeMemoryTask: ActiveMemoryTask = {
			controller,
			promise: Promise.resolve(),
			diagnosticSessionId: diagnostic.id
		};
		this.activeMemoryTasks.set(processingKey, activeMemoryTask);
		activeMemoryTask.promise = this.runMemoryTask(
			transcriptFile,
			analysisTemplateIds,
			processingKey,
			taskId,
			controller,
			diagnostic.id
		);
	}

	private async retryMemoryTask(
		transcriptPath: string,
		analysisTemplateIds: readonly string[] | undefined
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(transcriptPath);
		if (!(file instanceof TFile) || !this.isTranscriptMarkdownFile(file)) {
			new Notice(`无法重试记忆提取，转写稿不存在：${transcriptPath}`);
			return;
		}
		const previousTask = this.taskCenter.getTask(createTaskId("memory", transcriptPath));
		await this.startMemoryTask(
			file,
			analysisTemplateIds,
			true,
			true,
			previousTask?.diagnosticChainId,
			previousTask?.diagnosticSessionId
		);
	}

	private async runMemoryTask(
		transcriptFile: TFile,
		analysisTemplateIds: readonly string[] | undefined,
		processingKey: string,
		taskId: string,
		controller: AbortController,
		diagnosticSessionId: string
	): Promise<void> {
		try {
			this.diagnostics.record(diagnosticSessionId, "configuration", "memory-configuration", {
				provider: this.settings.memoryProvider,
				baseUrl: this.settings.memoryBaseUrl,
				model: this.settings.memoryModel,
				keyPresent: Boolean(this.getMemoryApiKey().trim()),
				analysisTemplateCount: analysisTemplateIds?.length ?? 0
			});
			const result = await this.memoryService.extractFromTranscript(this.settings, transcriptFile, {
				apiKey: this.getMemoryApiKey(),
				analysisTemplateIds,
				signal: controller.signal,
				diagnostics: this.diagnostics.getSink(diagnosticSessionId),
				onProgress: (stage, progress) => {
					this.diagnostics.record(diagnosticSessionId, "progress", "memory-progress", {
						stage,
						currentChunk: progress?.currentChunk,
						totalChunks: progress?.totalChunks
					});
					if (this.activeMemoryTasks.get(processingKey)?.controller === controller) {
						this.taskCenter.updateTask(taskId, {
							stage,
							currentSegment: progress?.currentChunk,
							totalSegments: progress?.totalChunks
						});
					}
				}
			});
			if (this.activeMemoryTasks.get(processingKey)?.controller !== controller) {
				return;
			}
			this.taskCenter.updateTask(taskId, {
				status: result.skipped ? "skipped" : "success",
				stage: result.skipped
					? "输入与已有候选包一致，已跳过模型调用"
					: `${result.assertionCount} 条候选记忆已写入${result.compiled ? "并编译画像" : ""}${formatRejectedMemoryAssertionSummary(result.rejectedAssertionCount)}`,
				provider: result.provider,
				model: result.model,
				outputPath: result.candidateFilePath,
				traceId: result.traceIds.join(", ") || undefined,
				completedAt: Date.now()
			});
			this.diagnostics.complete(diagnosticSessionId, result.skipped ? "skipped" : "success", {
				assertionCount: result.assertionCount,
				rejectedAssertionCount: result.rejectedAssertionCount,
				compiled: result.compiled,
				traceIdCount: result.traceIds.length
			});
			await this.markGettingStartedMemorySuccess(
				transcriptFile.path,
				result.candidateFilePath
			);
			this.showMemoryReviewNotice(
				result.skipped
					? `记忆候选已存在：${transcriptFile.name}`
					: `已沉淀 ${result.assertionCount} 条候选记忆${formatRejectedMemoryAssertionSummary(result.rejectedAssertionCount)}：${transcriptFile.name}`,
				result.candidateFilePath
			);
		} catch (error) {
			if (controller.signal.aborted || this.activeMemoryTasks.get(processingKey)?.controller !== controller) {
				return;
			}
			const message = getErrorMessage(error);
			this.taskCenter.updateTask(taskId, {
				status: "failed",
				stage: "记忆提取失败",
				error: message,
				completedAt: Date.now()
			});
			this.diagnostics.complete(diagnosticSessionId, "failed", {
				error: message,
				errorCategory: classifyDiagnosticError(error)
			});
			await this.markGettingStartedFailure("memory", transcriptFile.path, taskId);
			try {
				await this.memoryService.appendExtractionFailureLog(this.settings, transcriptFile.path, message);
			} catch (logError) {
				this.log("写入 Echo Memory 失败日志失败", logError);
			}
			new Notice(getTaskFailureNotice("memory", message));
			this.log("Echo Memory 记忆提取失败", error);
		} finally {
			if (this.activeMemoryTasks.get(processingKey)?.controller === controller) {
				this.activeMemoryTasks.delete(processingKey);
			}
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
		const diagnostic = this.startDiagnosticSession("transcription");
		this.diagnostics.record(diagnostic.id, "configuration", "realtime-transcription-configuration", {
			provider: config.provider,
			baseUrl: config.baseUrl,
			model: config.model,
			language: config.language || "auto",
			keyPresent: Boolean(apiKey.trim()),
			localChecks: diagnostics.items.map((item) => ({ severity: item.severity, title: item.title }))
		});
		if (!diagnostics.canAttemptTranscription) {
			this.diagnostics.complete(diagnostic.id, "failed", { error: "实时转写配置不可用" });
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
				diagnostics: this.diagnostics.getSink(diagnostic.id),
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
				taskId,
				diagnosticSessionId: diagnostic.id,
				diagnosticChainId: diagnostic.chainId
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
				diagnosticSessionId: diagnostic.id,
				diagnosticChainId: diagnostic.chainId,
				recovery: {
					kind: "transcription",
					audioPath: audioFile.path,
					sourcePath: sourceNote.path,
					audioLinkPath: audioFile.path
				},
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
			this.diagnostics.complete(diagnostic.id, "failed", {
				error: getErrorMessage(error),
				errorCategory: classifyDiagnosticError(error)
			});
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
			this.diagnostics.complete(recording.diagnosticSessionId, "success", {
				traceId: result.traceId,
				utteranceCount: result.utterances?.length ?? 0
			});
			new Notice(`实时转写完成：${recording.audioFile.name}`);
			this.startAnalysisTasks(
				transcriptFile,
				this.getDefaultAnalysisTemplatesForAnalysis(),
				recording.diagnosticChainId
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
					label: "使用离线服务商重试",
					run: () => this.retryTranscriptionTask(
						recording.audioFile.path,
						recording.sourceNote.path,
						recording.audioFile.path,
						recording.diagnosticChainId,
						recording.diagnosticSessionId
					)
				}
			});
			this.diagnostics.complete(recording.diagnosticSessionId, "failed", {
				error: getErrorMessage(error),
				traceId: recording.streamingState.traceId,
				errorCategory: classifyDiagnosticError(error)
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
			clearStatusIndicator(this.realtimeStatusEl);
			this.realtimeStatusEl.hide();
			return;
		}
		const elapsed = Math.max(0, Math.round((Date.now() - recording.startedAt) / 1000));
		renderStatusIndicator(this.realtimeStatusEl, {
			tone: "running",
			text: `Echo Notes ${formatSegmentTimestamp(elapsed)} · ${recording.streamingState.connectionStatus ?? "连接中"}`
		}, setIcon);
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
				this.startAnalysisTasks(transcriptFile, analysisTemplates, result.diagnosticChainId);
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

function formatRejectedMemoryAssertionSummary(count: number): string {
	return count > 0 ? `（证据校验拒绝 ${count} 条）` : "";
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

function uniquePaths(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function getDesktopElectronShell(): DiagnosticFolderRevealShell | null {
	const runtime = window.activeWindow as Window & {
		require?: (moduleName: string) => unknown;
	};
	if (typeof runtime.require !== "function") {
		return null;
	}
	try {
		const electron = runtime.require("electron") as { shell?: unknown };
		const shell = electron?.shell;
		return shell && typeof (shell as DiagnosticFolderRevealShell).showItemInFolder === "function"
			? shell as DiagnosticFolderRevealShell
			: null;
	} catch {
		return null;
	}
}

function getDesktopRuntimePlatform(): string {
	const runtime = window.activeWindow as Window & {
		process?: { platform?: unknown };
	};
	return typeof runtime.process?.platform === "string" ? runtime.process.platform : "unknown";
}

function classifyDiagnosticError(error: unknown): string {
	const message = getErrorMessage(error).toLocaleLowerCase();
	if (/timeout|超时/.test(message)) {
		return "timeout";
	}
	if (/network|网络|fetch|socket|websocket|连接/.test(message)) {
		return "network";
	}
	if (/401|403|鉴权|api key|密钥|unauthorized|forbidden/.test(message)) {
		return "authentication";
	}
	if (/429|rate limit|频率|限流/.test(message)) {
		return "rate-limit";
	}
	if (/4\d\d|5\d\d|http/.test(message)) {
		return "http";
	}
	return "unknown";
}

function formatMegabytes(bytes: number): string {
	return (bytes / (1024 * 1024)).toFixed(1);
}

function getSettingsDestinationLabel(destination: EchoNotesSettingsDestination): string {
	switch (destination) {
		case "transcription-service":
			return "录音转写 → 转写服务";
		case "analysis-model":
			return "AI 分析 → 模型配置";
		case "memory-model":
			return "Echo Memory → 模型配置";
		case "transcription-recording":
			return "录音转写 → 录音控制";
	}
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
			text: "Echo Notes 将把以下音频发送给你配置的转写服务商。确认后才会开始上传。"
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

		const groupsEl = contentEl.createDiv({ cls: "echo-notes-analysis-template-picker-groups" });
		for (const group of groupAnalysisTemplatesByCategory(this.templates)) {
			if (group.templates.length === 0) {
				continue;
			}

			const groupEl = groupsEl.createEl("section", {
				cls: "echo-notes-analysis-template-picker-group",
				attr: { "data-template-category": group.category.id }
			});
			groupEl.createEl("h3", {
				cls: "echo-notes-analysis-template-picker-group-title",
				text: group.category.label
			});
			const listEl = groupEl.createDiv({ cls: "echo-notes-analysis-template-picker-list" });
			for (const template of group.templates) {
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
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

import { Notice, Platform, Setting, setIcon } from "obsidian";
import {
	captureHotkeyFromKeyboardEvent,
	cloneGettingStartedHotkeys,
	fillMissingGettingStartedHotkeys,
	getRecommendedGettingStartedHotkeys,
	validateGettingStartedHotkeys,
	type GettingStartedHotkeyId,
	type GettingStartedHotkeys
} from "./getting-started-hotkeys";
import type {
	GettingStartedChapterId,
	GettingStartedProgress,
	GettingStartedReadiness,
	GettingStartedState,
	GettingStartedStep
} from "./getting-started-state";
import {
	canSkipGettingStartedChapter,
	getGettingStartedExperienceNotePath,
	getGettingStartedFailureKind,
	getGettingStartedPracticeStage,
	isGettingStartedBusy
} from "./getting-started-state";
import { formatHotkey } from "../settings/settings";
import { renderStatusIndicator } from "../ui/status-indicator";

export interface GettingStartedTaskSnapshot {
	id: string;
	kind: "transcription" | "analysis" | "memory";
	status: "running" | "failed" | "success";
	stage: string;
	error?: string;
	canRetry: boolean;
}

export interface GettingStartedGuideSnapshot {
	state: GettingStartedState;
	step: GettingStartedStep;
	progress: GettingStartedProgress;
	readiness: GettingStartedReadiness;
	memoryInitialized: boolean;
	recorderEnabled: boolean | null;
	hotkeys: GettingStartedHotkeys;
	hotkeyManagerReadable: boolean;
	hotkeyManagerWritable: boolean;
	memorySourcePath?: string;
	memorySourceAvailable: boolean;
	task?: GettingStartedTaskSnapshot;
}

export interface GettingStartedGuideActions {
	dismiss(): Promise<void>;
	skipChapter(chapter: GettingStartedChapterId): Promise<void>;
	relearnChapter(chapter: GettingStartedChapterId): Promise<void>;
	cancelRelearn(): Promise<void>;
	openTranscriptionSettings(): Promise<void>;
	openAnalysisSettings(): Promise<void>;
	enableRecorder(): Promise<void>;
	confirmRecorder(): Promise<void>;
	openCorePluginSettings(): Promise<void>;
	getHotkeyConflicts(hotkeys: GettingStartedHotkeys): Partial<Record<GettingStartedHotkeyId, string[]>>;
	saveHotkeys(hotkeys: GettingStartedHotkeys): Promise<boolean>;
	confirmHotkeys(): Promise<void>;
	openHotkeySettings(): Promise<void>;
	createExperienceNote(): Promise<void>;
	stopFirstRecording(): Promise<void>;
	transcribeFirstRecording(): Promise<void>;
	acknowledgeFirstChapter(): Promise<void>;
	startShortcutPractice(): Promise<void>;
	resumeShortcutPractice(): Promise<void>;
	startShortcutTranscription(): Promise<void>;
	acknowledgeShortcutChapter(): Promise<void>;
	initializeMemory(): Promise<void>;
	openMemorySettings(): Promise<void>;
	selectMemoryTranscript(): Promise<void>;
	startMemory(): Promise<void>;
	retryTask(taskId: string): Promise<void>;
	openExperienceNote(): Promise<void>;
	openFirstTranscript(): Promise<void>;
	openShortcutTranscript(): Promise<void>;
	openMemoryCandidate(): Promise<void>;
}

const CHAPTER_DEFINITIONS = [
	{ id: "first", label: "第一次转写" },
	{ id: "shortcut", label: "快捷转写与分析" },
	{ id: "memory", label: "记忆沉淀" }
] as const;

const HOTKEY_LABELS: Record<GettingStartedHotkeyId, string> = {
	start: "开始录音",
	stop: "停止录音",
	transcribe: "转写当前笔记全部音频"
};

export class GettingStartedGuide {
	private readonly getSnapshot: () => GettingStartedGuideSnapshot;
	private readonly actions: GettingStartedGuideActions;
	private readonly requestRender: () => void;
	private contentEl!: HTMLElement;
	private expanded: boolean;
	private forceVisible = false;
	private selectedChapter: GettingStartedChapterId | null = null;
	private lastStep: GettingStartedStep | null = null;
	private recordingHotkeyId: GettingStartedHotkeyId | null = null;
	private hotkeyDraft: GettingStartedHotkeys | null = null;
	private skipConfirmationChapter: GettingStartedChapterId | null = null;
	private lastContextKey: string | null = null;
	private lastHadActiveReview = false;
	private readonly handleKeydown = (event: KeyboardEvent): void => {
		this.handleHotkeyCapture(event);
	};

	constructor(
		getSnapshot: () => GettingStartedGuideSnapshot,
		actions: GettingStartedGuideActions,
		requestRender: () => void
	) {
		this.getSnapshot = getSnapshot;
		this.actions = actions;
		this.requestRender = requestRender;
		const snapshot = getSnapshot();
		this.expanded = snapshot.state.status !== "completed" || Boolean(snapshot.state.activeReview);
	}

	destroy(): void {
		this.stopHotkeyCapture();
	}

	open(): void {
		const snapshot = this.getSnapshot();
		this.forceVisible = true;
		this.expanded = true;
		this.selectedChapter = snapshot.state.activeReview?.chapter ?? this.getActiveChapter(snapshot.step) ?? "memory";
		this.requestRender();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	isVisible(): boolean {
		return this.getSnapshot().state.status !== "dismissed" || this.forceVisible;
	}

	private render(): void {
		this.requestRender();
	}

	renderInto(parentEl: HTMLElement): void {
		const snapshot = this.getSnapshot();
		if (!this.isVisible()) {
			return;
		}
		const activeChapter = snapshot.state.activeReview?.chapter ?? this.getActiveChapter(snapshot.step);
		const contextKey = `${snapshot.step}:${snapshot.state.activeReview?.chapter ?? "journey"}`;
		if (this.lastContextKey !== contextKey) {
			if (
				snapshot.step === "completed" &&
				!snapshot.state.activeReview &&
				!this.lastHadActiveReview &&
				this.lastContextKey !== null
			) {
				this.expanded = false;
			}
			if (!this.lastHadActiveReview || activeChapter) {
				this.selectedChapter = activeChapter ?? "memory";
			}
			this.lastStep = snapshot.step;
			this.lastContextKey = contextKey;
			this.skipConfirmationChapter = null;
		}
		this.lastHadActiveReview = Boolean(snapshot.state.activeReview);

		const sectionEl = parentEl.createEl("section", {
			cls: `echo-notes-getting-started-guide${snapshot.state.status === "completed" ? " is-completed" : ""}`,
			attr: { "aria-labelledby": "echo-notes-getting-started-guide-title" }
		});
		const headerEl = sectionEl.createDiv({ cls: "echo-notes-getting-started-guide-header" });
		const headingEl = headerEl.createDiv({ cls: "echo-notes-getting-started-guide-heading" });
		headingEl.createDiv({
			cls: "echo-notes-getting-started-guide-title",
			text: "开始使用 Echo Notes",
			attr: { id: "echo-notes-getting-started-guide-title" }
		});
		headingEl.createDiv({
			cls: "echo-notes-getting-started-guide-progress",
			text: `${snapshot.progress.resolvedChapters}/${snapshot.progress.totalChapters}`,
			attr: {
				"aria-label": `已处理 ${snapshot.progress.resolvedChapters} 个，共 ${snapshot.progress.totalChapters} 个阶段；完成 ${snapshot.progress.completedChapters} 个，跳过 ${snapshot.progress.skippedChapters} 个`
			}
		});

		const headerActionsEl = headerEl.createDiv({ cls: "echo-notes-getting-started-guide-header-actions" });
		if (!Platform.isMobile && snapshot.state.status !== "completed") {
			const laterEl = headerActionsEl.createEl("button", {
				cls: "echo-notes-getting-started-guide-later",
				text: "稍后",
				attr: { type: "button" }
			});
			laterEl.addEventListener("click", () => {
				void this.dismiss();
			});
		}
		const toggleEl = headerActionsEl.createEl("button", {
			cls: "clickable-icon echo-notes-getting-started-guide-toggle",
			attr: {
				type: "button",
				title: this.expanded ? "收起新人指引" : "展开新人指引",
				"aria-label": this.expanded ? "收起新人指引" : "展开新人指引",
				"aria-expanded": String(this.expanded),
				"aria-controls": "echo-notes-getting-started-guide-body"
			}
		});
		setIcon(toggleEl, this.expanded ? "chevron-up" : "chevron-down");
		toggleEl.addEventListener("click", () => {
			this.expanded = !this.expanded;
			if (!this.expanded) {
				this.stopHotkeyCapture();
			}
			this.render();
		});

		const bodyEl = sectionEl.createDiv({
			cls: "echo-notes-getting-started-guide-body",
			attr: { id: "echo-notes-getting-started-guide-body" }
		});
		if (!this.expanded) {
			bodyEl.hidden = true;
			return;
		}

		if (Platform.isMobile) {
			this.contentEl = bodyEl;
			this.renderMobileMessage();
			return;
		}

		bodyEl.createDiv({
			cls: "echo-notes-getting-started-guide-copy",
			text: "按由易到难的三个任务完成首次转写、快捷转写与分析，再沉淀第一份候选记忆。API Key 仅保存在 Obsidian SecretStorage。"
		});
		if (snapshot.state.activeReview) {
			bodyEl.createDiv({
				cls: "echo-notes-getting-started-review-banner",
				text: `正在复习：${this.getChapterLabel(snapshot.state.activeReview.chapter)}`,
				attr: { role: "status", "aria-live": "polite" }
			});
		}
		if (snapshot.step !== "hotkeys") {
			this.stopHotkeyCapture();
			this.hotkeyDraft = null;
		}
		this.selectedChapter ??= activeChapter ?? "memory";
		this.renderChapterNavigation(bodyEl, snapshot, activeChapter);

		const detailEl = bodyEl.createDiv({ cls: "echo-notes-getting-started-guide-detail" });
		this.contentEl = detailEl;
		if (this.selectedChapter !== activeChapter && this.selectedChapter) {
			this.renderResolvedChapter(snapshot, this.selectedChapter);
			return;
		}
		this.renderCurrentStep(snapshot);
	}

	private renderCurrentStep(snapshot: GettingStartedGuideSnapshot): void {
		switch (snapshot.step) {
			case "transcription":
				this.renderServiceStep(
					"audio-lines",
					"配置转写服务",
					"选择离线转写服务商并保存对应 API Key。配置只在本地检查，不会上传音频。",
					snapshot.readiness.transcriptionReady,
					() => this.runExternal(() => this.actions.openTranscriptionSettings())
				);
				break;
			case "analysis":
				this.renderServiceStep(
					"sparkles",
					"配置 AI 分析",
					"开启 AI 分析，选择服务商，并保存独立的分析 API Key。",
					snapshot.readiness.analysisReady,
					() => this.runExternal(() => this.actions.openAnalysisSettings())
				);
				break;
			case "recorder":
				this.renderRecorderStep(snapshot);
				break;
			case "hotkeys":
				this.renderHotkeyStep(snapshot);
				break;
			case "first-practice":
				this.renderFirstPracticeStep(snapshot);
				break;
			case "shortcut-practice":
				this.renderShortcutPracticeStep(snapshot);
				break;
			case "memory":
				this.renderMemoryStep(snapshot);
				break;
			case "completed":
				this.renderCompletedStep(snapshot);
				break;
		}
		this.renderChapterControls(snapshot);
	}

	private async dismiss(): Promise<void> {
		this.forceVisible = false;
		this.expanded = false;
		this.stopHotkeyCapture();
		await this.actions.dismiss();
		this.render();
	}

	private renderMobileMessage(): void {
		this.renderStepIntro(
			"monitor",
			"请在桌面端完成首次体验",
			"移动端不会修改新人进度。请在桌面端打开同一 Vault，再运行 Echo Notes 的新人指引。"
		);
	}

	private renderChapterNavigation(
		containerEl: HTMLElement,
		snapshot: GettingStartedGuideSnapshot,
		activeChapter: GettingStartedChapterId | null
	): void {
		const stepsEl = containerEl.createDiv({
			cls: "echo-notes-getting-started-progress-steps",
			attr: { "aria-label": "新人指引阶段" }
		});
		for (const chapter of CHAPTER_DEFINITIONS) {
			const outcome = snapshot.progress.chapterOutcomes[chapter.id];
			const completed = outcome === "completed";
			const skipped = outcome === "skipped";
			const active = chapter.id === activeChapter;
			const available = outcome !== "pending" || active || snapshot.step === "completed";
			const selected = chapter.id === this.selectedChapter;
			const stepEl = stepsEl.createEl("button", {
				cls: `echo-notes-getting-started-progress-step${completed ? " is-completed" : ""}${skipped ? " is-skipped" : ""}${active ? " is-active" : ""}`,
				attr: {
					type: "button",
					"aria-expanded": String(selected),
					"aria-disabled": String(!available)
				}
			});
			stepEl.disabled = !available;
			const iconEl = stepEl.createSpan({ cls: "echo-notes-getting-started-progress-icon" });
			iconEl.setAttribute("aria-hidden", "true");
			setIcon(iconEl, completed ? "circle-check" : skipped ? "circle-minus" : active ? "circle-dot" : "lock-keyhole");
			const copyEl = stepEl.createSpan({ cls: "echo-notes-getting-started-progress-step-copy" });
			copyEl.createSpan({ text: chapter.label });
			copyEl.createSpan({
				text: completed ? "已完成" : skipped ? "已跳过" : active ? "进行中" : "尚未解锁"
			});
			const chevronEl = stepEl.createSpan({ cls: "echo-notes-getting-started-progress-chevron" });
			chevronEl.setAttribute("aria-hidden", "true");
			setIcon(chevronEl, selected ? "chevron-up" : "chevron-down");
			stepEl.addEventListener("click", () => {
				this.selectedChapter = selected && chapter.id !== activeChapter ? activeChapter : chapter.id;
				this.render();
			});
		}
	}

	private renderResolvedChapter(
		snapshot: GettingStartedGuideSnapshot,
		chapter: GettingStartedChapterId
	): void {
		const outcome = snapshot.progress.chapterOutcomes[chapter];
		if (outcome === "pending") {
			return;
		}
		if (snapshot.step === "completed" && chapter === "memory") {
			this.renderCompletedStep(snapshot);
			return;
		}
		if (outcome === "skipped") {
			this.renderStepIntro(
				"circle-minus",
				`${this.getChapterLabel(chapter)}已跳过`,
				"这一阶段没有被标记为成功，你可以随时再学一次补齐实操。"
			);
			this.renderRelearnAction(chapter);
			return;
		}
		if (chapter === "first") {
			this.renderStepIntro("file-audio", "第一次转写已完成", "体验笔记、录音和第一份转写稿均已保留。");
			const actions: Array<[string, () => Promise<void>]> = [];
			if (this.hasExperienceNote(snapshot, chapter)) {
				actions.push(["打开体验笔记", () => this.actions.openExperienceNote()]);
			}
			if (this.hasTranscript(snapshot, chapter)) {
				actions.push(["打开首次转写稿", () => this.actions.openFirstTranscript()]);
			}
			this.renderArtifactActions(actions);
			this.renderRelearnAction(chapter);
			return;
		}
		if (chapter === "shortcut") {
			this.renderStepIntro("keyboard", "快捷转写与分析已完成", "三组快捷键已经通过实操，AI 分析保存在快捷工作流转写稿中。");
			if (this.hasTranscript(snapshot, chapter)) {
				this.renderArtifactActions([["打开转写与分析", () => this.actions.openShortcutTranscript()]]);
			}
			this.renderRelearnAction(chapter);
			return;
		}
		this.renderMemoryChapterResult(snapshot);
	}

	private renderArtifactActions(actions: Array<[string, () => Promise<void>]>): void {
		if (actions.length === 0) {
			return;
		}
		const setting = new Setting(this.contentEl).setClass("echo-notes-getting-started-actions");
		for (const [label, action] of actions) {
			setting.addButton((button) => button.setButtonText(label).onClick(() => this.runExternal(action)));
		}
	}

	private renderServiceStep(
		icon: string,
		title: string,
		description: string,
		ready: boolean,
		onConfigure: () => void
	): void {
		this.renderStepIntro(icon, title, description);
		this.renderStatus(ready ? "配置检查已通过" : "还需要完成服务商与 API Key 配置", ready);
		new Setting(this.contentEl)
			.setClass("echo-notes-getting-started-actions")
			.addButton((button) => button
				.setCta()
				.setButtonText(ready ? "查看配置" : "去配置")
				.onClick(onConfigure));
	}

	private renderRecorderStep(snapshot: GettingStartedGuideSnapshot): void {
		this.renderStepIntro(
			"mic-2",
			"启用 Obsidian 核心录音机",
			"离线流程使用 Obsidian 核心插件“录音机”保存录音，停止后音频会插入当前笔记。"
		);
		const manuallyConfirmed = Boolean(snapshot.state.recorderManuallyConfirmedAt);
		const enabled = snapshot.recorderEnabled === true;
		this.renderStatus(
			enabled
				? "已检测到核心录音机开启"
				: manuallyConfirmed
					? "已由你确认手动开启，实操阶段会再次验证"
					: snapshot.recorderEnabled === false
						? "核心录音机尚未开启"
						: "当前 Obsidian 版本无法读取核心录音机状态",
			enabled || manuallyConfirmed
		);

		const actions = new Setting(this.contentEl).setClass("echo-notes-getting-started-actions");
		if (snapshot.recorderEnabled === false) {
			actions.addButton((button) => button
				.setCta()
				.setButtonText("立即启用")
				.onClick(async () => {
					await this.actions.enableRecorder();
					this.render();
				}));
		} else if (snapshot.recorderEnabled === null && !manuallyConfirmed) {
			actions.addButton((button) => button
				.setButtonText("打开核心插件设置")
				.onClick(() => this.runExternal(() => this.actions.openCorePluginSettings())));
			actions.addButton((button) => button
				.setCta()
				.setButtonText("我已手动开启")
				.onClick(async () => {
					await this.actions.confirmRecorder();
					this.render();
				}));
		}
		if (!enabled && !manuallyConfirmed) {
			actions.addButton((button) => button
				.setButtonText("重新检测")
				.onClick(() => this.render()));
		}
	}

	private renderHotkeyStep(snapshot: GettingStartedGuideSnapshot): void {
		const recommendation = Platform.isMacOS
			? { platform: "Mac", hotkeys: getRecommendedGettingStartedHotkeys("macOS") }
			: Platform.isWin
				? { platform: "Windows", hotkeys: getRecommendedGettingStartedHotkeys("windows") }
				: null;
		this.renderStepIntro(
			"keyboard",
			"配置三组快捷键",
			recommendation
				? `已为 ${recommendation.platform} 填入统一推荐组合。保存后会写入 Obsidian 全局快捷键设置，但不会移除其他命令已有的绑定。`
				: "点击录入按钮后直接按组合键。Echo Notes 不会自动覆盖其他命令。"
		);
		const draft = this.hotkeyDraft ?? (recommendation
			? fillMissingGettingStartedHotkeys(snapshot.hotkeys, recommendation.hotkeys)
			: cloneGettingStartedHotkeys(snapshot.hotkeys));
		this.hotkeyDraft = draft;
		if (recommendation) {
			this.renderInlineMessage(
				recommendation.platform === "Mac"
					? "Mac 统一推荐：Control+L 开始录音，Control+S 停止录音，Control+Z 转写。"
					: "Windows 统一推荐：Alt+L 开始录音，Alt+A 停止录音，Alt+Z 转写。",
				"warning"
			);
		}
		const conflicts = this.actions.getHotkeyConflicts(draft);
		const hasConflicts = Object.values(conflicts).some((items) => (items?.length ?? 0) > 0);
		for (const id of ["start", "stop", "transcribe"] as GettingStartedHotkeyId[]) {
			this.renderHotkeyCapture(conflicts, id, draft);
		}

		const validation = validateGettingStartedHotkeys(draft);
		if (validation.missing.length > 0) {
			this.renderInlineMessage("还有快捷键尚未录入。", "warning");
		}
		if (validation.duplicates.length > 0) {
			this.renderInlineMessage("三组快捷键不能重复，请重新录入。", "error");
		}
		if (hasConflicts) {
			this.renderInlineMessage("快捷键与其他命令冲突，请重新录入后再保存。", "error");
		}
		if (!snapshot.hotkeyManagerWritable) {
			this.renderInlineMessage(
				"当前 Obsidian 版本无法由 Echo Notes 写入快捷键，请到快捷键设置中手动配置。",
				"warning"
			);
		}

		const actions = new Setting(this.contentEl).setClass("echo-notes-getting-started-actions");
		if (snapshot.hotkeyManagerWritable) {
			if (recommendation && !this.hotkeysMatch(draft, recommendation.hotkeys)) {
				actions.addButton((button) => button
					.setButtonText("使用推荐组合")
					.onClick(() => {
						this.hotkeyDraft = cloneGettingStartedHotkeys(recommendation.hotkeys);
						this.render();
					}));
			}
			actions.addButton((button) => button
				.setCta()
				.setDisabled(!validation.valid || hasConflicts)
				.setButtonText("保存并继续")
				.onClick(async () => {
					const saved = await this.actions.saveHotkeys(draft);
					if (saved) {
						this.hotkeyDraft = null;
						this.render();
					}
				}));
		} else {
			actions.addButton((button) => button
				.setButtonText("打开快捷键设置")
				.onClick(() => {
					this.hotkeyDraft = null;
					this.runExternal(() => this.actions.openHotkeySettings());
				}));
			if (!snapshot.hotkeyManagerReadable) {
				actions.addButton((button) => button
					.setCta()
					.setButtonText("我已手动配置")
					.onClick(async () => {
						await this.actions.confirmHotkeys();
						this.render();
					}));
			}
		}
	}

	private renderHotkeyCapture(
		conflictsById: Partial<Record<GettingStartedHotkeyId, string[]>>,
		id: GettingStartedHotkeyId,
		draft: GettingStartedHotkeys
	): void {
		const rowEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-hotkey-row" });
		const copyEl = rowEl.createDiv({ cls: "echo-notes-getting-started-hotkey-copy" });
		copyEl.createDiv({ cls: "echo-notes-getting-started-hotkey-label", text: HOTKEY_LABELS[id] });
		const conflicts = conflictsById[id] ?? [];
		if (conflicts.length > 0) {
			const conflictEl = copyEl.createDiv({ cls: "echo-notes-getting-started-hotkey-conflict" });
			renderStatusIndicator(conflictEl, {
				tone: "warning",
				text: `快捷键冲突：${conflicts.join("、")}`,
				live: "polite"
			}, setIcon);
		}

		const controlsEl = rowEl.createDiv({ cls: "echo-notes-getting-started-hotkey-controls" });
		const captureEl = controlsEl.createEl("button", {
			cls: `echo-notes-getting-started-hotkey-capture${this.recordingHotkeyId === id ? " is-recording" : ""}`,
			attr: { type: "button" }
		});
		captureEl.createSpan({
			text: this.recordingHotkeyId === id
				? "请按组合键"
				: formatHotkey(draft[id]) || "点击录入"
		});
		captureEl.addEventListener("click", () => {
			this.startHotkeyCapture(id);
			window.setTimeout(() => {
				this.contentEl.querySelector<HTMLButtonElement>(".echo-notes-getting-started-hotkey-capture.is-recording")?.focus();
			}, 0);
		});
		if (draft[id]) {
			const clearEl = controlsEl.createEl("button", {
				cls: "clickable-icon echo-notes-getting-started-hotkey-clear",
				attr: { type: "button", title: `清除${HOTKEY_LABELS[id]}`, "aria-label": `清除${HOTKEY_LABELS[id]}` }
			});
			setIcon(clearEl, "x");
			clearEl.addEventListener("click", () => {
				draft[id] = null;
				this.stopHotkeyCapture();
				this.render();
			});
		}
	}

	private renderFirstPracticeStep(snapshot: GettingStartedGuideSnapshot): void {
		this.renderStepIntro(
			"file-audio",
			"任务一：完成第一次转写",
			"这一阶段先用向导按钮完成录音和转写，不要求记住任何快捷键。"
		);
		const stage = getGettingStartedPracticeStage(snapshot.state);
		const experienceNotePath = getGettingStartedExperienceNotePath(snapshot.state);
		if (stage === "idle" || !experienceNotePath) {
			this.renderStatus(
				experienceNotePath ? "体验笔记已保留，可以重新开始录音" : "尚未创建体验笔记",
				false
			);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
						.setButtonText(experienceNotePath ? "重新开始录音" : "创建体验笔记并开始录音")
						.onClick(() => this.runExternal(() => this.actions.createExperienceNote())));
			return;
		}

		this.contentEl.createDiv({
			cls: "echo-notes-getting-started-artifact-path",
			text: experienceNotePath
		});
		if (stage === "waiting-for-first-audio") {
			this.renderStatus("核心录音机正在录音，说几句话后停止", false, true);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
						.setCta()
						.setButtonText("停止录音")
						.onClick(async () => {
							await this.actions.stopFirstRecording();
							this.render();
						}));
			return;
		}
		if (stage === "first-audio-ready") {
			this.renderStatus("录音已保存并插入体验笔记", true);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
						.setCta()
						.setButtonText("开始第一次转写")
						.onClick(() => this.runExternal(() => this.actions.transcribeFirstRecording())));
			return;
		}
		if (stage === "first-transcription-completed") {
			this.renderStatus("第一份转写稿已生成", true);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
						.setButtonText("查看转写稿")
						.onClick(() => this.runExternal(() => this.actions.openFirstTranscript())))
				.addButton((button) => button
						.setCta()
						.setButtonText("进入快捷工作流")
						.onClick(async () => {
							await this.actions.acknowledgeFirstChapter();
							this.render();
						}));
			return;
		}
		if (stage === "failed" && getGettingStartedFailureKind(snapshot.state) === "transcription") {
			this.renderTaskFailure(snapshot, "重试转写");
			return;
		}

		this.renderStatus(
			snapshot.task?.stage ?? "正在转写录音",
			false,
			true
		);
	}

	private renderShortcutPracticeStep(snapshot: GettingStartedGuideSnapshot): void {
		this.renderStepIntro(
			"keyboard",
			"任务二：快捷转写并生成 AI 分析",
			"再录一段短音频，依次使用开始录音、停止录音和转写快捷键。转写成功后会自动生成 AI 分析。"
		);
		const stage = getGettingStartedPracticeStage(snapshot.state);
		const practiceStartedAt = snapshot.state.activeReview?.practiceStartedAt ?? snapshot.state.shortcutPracticeStartedAt;
		const experienceNotePath = getGettingStartedExperienceNotePath(snapshot.state);
		if (stage === "idle" || !practiceStartedAt) {
			this.renderStatus("准备验证三组快捷键", false);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText("开始快捷工作流")
					.onClick(() => this.runExternal(() => this.actions.startShortcutPractice())));
			return;
		}
		if (experienceNotePath) {
			this.contentEl.createDiv({
				cls: "echo-notes-getting-started-artifact-path",
				text: experienceNotePath
			});
		}
		if (stage === "waiting-for-shortcut-audio") {
			this.renderStatus("等待你用快捷键开始和停止录音", false);
			this.renderPracticeHotkeys(snapshot.hotkeys, ["start", "stop"]);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setButtonText("返回体验笔记")
					.onClick(() => this.runExternal(() => this.actions.resumeShortcutPractice())));
			return;
		}
		if (stage === "shortcut-audio-ready") {
			const transcribeHotkey = formatHotkey(snapshot.hotkeys.transcribe);
			this.renderStatus(
				transcribeHotkey
					? `录音已保存，请按 ${transcribeHotkey} 转写当前笔记全部音频`
					: "录音已保存，请执行“转写当前笔记全部音频”命令",
				true
			);
			this.renderPracticeHotkeys(snapshot.hotkeys, ["transcribe"]);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText("继续快捷转写")
					.onClick(() => this.runExternal(() => this.actions.startShortcutTranscription())));
			return;
		}
		if (stage === "waiting-for-shortcut-transcription") {
			const transcribeHotkey = formatHotkey(snapshot.hotkeys.transcribe);
			this.renderStatus(
				transcribeHotkey
					? `录音已保存，请按 ${transcribeHotkey} 转写当前笔记全部音频`
					: "录音已保存，等待执行转写命令",
				true
			);
			this.renderPracticeHotkeys(snapshot.hotkeys, ["transcribe"]);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setButtonText("返回体验笔记")
					.onClick(() => this.runExternal(() => this.actions.startShortcutTranscription())));
			return;
		}
		if (stage === "shortcut-completed") {
			this.renderStatus("快捷转写与 AI 分析均已完成", true);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setButtonText("查看转写与分析")
					.onClick(() => this.runExternal(() => this.actions.openShortcutTranscript())))
				.addButton((button) => button
					.setCta()
					.setButtonText("进入记忆沉淀")
					.onClick(async () => {
						await this.actions.acknowledgeShortcutChapter();
						this.render();
					}));
			return;
		}
		const failureKind = getGettingStartedFailureKind(snapshot.state);
		if (stage === "failed" && failureKind !== "memory") {
			this.renderTaskFailure(
				snapshot,
				failureKind === "analysis" ? "重试分析" : "重试转写"
			);
			return;
		}
		this.renderStatus(
			snapshot.task?.stage ?? (stage === "analyzing" ? "正在生成 AI 分析" : "正在快捷转写"),
			false,
			true
		);
	}

	private renderMemoryStep(snapshot: GettingStartedGuideSnapshot): void {
		this.renderStepIntro(
			"brain",
			"任务三：沉淀第一份候选记忆",
			"Echo Memory 会从转写稿和成功分析中提取带原文证据的候选记忆，供你后续审核。"
		);
		if (!snapshot.memoryInitialized) {
			this.renderStatus("Echo Memory 尚未初始化", false);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText("初始化 Echo Memory")
					.onClick(() => this.runExternal(() => this.actions.initializeMemory())));
			return;
		}
		if (!snapshot.readiness.memoryReady) {
			this.renderStatus("还需要配置独立的记忆服务商和 API Key", false);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText("配置记忆模型")
					.onClick(() => this.runExternal(() => this.actions.openMemorySettings())));
			return;
		}
		const stage = getGettingStartedPracticeStage(snapshot.state);
		if (stage === "failed" && getGettingStartedFailureKind(snapshot.state) === "memory") {
			this.renderTaskFailure(snapshot, "重试记忆提取");
			return;
		}
		if (stage === "memory-running" || snapshot.task?.kind === "memory") {
			this.renderStatus(snapshot.task?.stage ?? "正在提取候选记忆", false, true);
			return;
		}
		if (!snapshot.memorySourceAvailable) {
			this.renderStatus("请选择一份 Echo Notes 转写稿作为记忆来源", false);
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText("选择转写稿")
					.onClick(() => this.runExternal(() => this.actions.selectMemoryTranscript())));
			return;
		}
		if (snapshot.memorySourcePath) {
			this.contentEl.createDiv({
				cls: "echo-notes-getting-started-artifact-path",
				text: snapshot.memorySourcePath
			});
		}
		this.renderStatus("记忆工作区和模型配置已就绪", true);
		new Setting(this.contentEl)
			.setClass("echo-notes-getting-started-actions")
			.addButton((button) => button
				.setButtonText("更换转写稿")
				.onClick(() => this.runExternal(() => this.actions.selectMemoryTranscript())))
			.addButton((button) => button
				.setCta()
				.setButtonText("沉淀第一份记忆")
				.onClick(async () => {
					await this.actions.startMemory();
					this.render();
				}));
	}

	private renderTaskFailure(snapshot: GettingStartedGuideSnapshot, retryLabel: string): void {
		this.renderStatus(snapshot.task?.stage ?? "处理失败", false);
		if (snapshot.task?.error) {
			this.renderInlineMessage(snapshot.task.error, "error");
		}
		if (snapshot.task?.canRetry) {
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-actions")
				.addButton((button) => button
					.setCta()
					.setButtonText(retryLabel)
					.onClick(async () => {
						await this.actions.retryTask(snapshot.task!.id);
						this.render();
					}));
		}
	}

	private renderCompletedStep(snapshot: GettingStartedGuideSnapshot): void {
		const hasSkipped = snapshot.progress.skippedChapters > 0;
		this.renderStepIntro(
			hasSkipped ? "list-checks" : "circle-check-big",
			"三阶段新人旅程已结束",
			`完成 ${snapshot.progress.completedChapters} 个阶段，跳过 ${snapshot.progress.skippedChapters} 个阶段。已跳过的阶段仍可随时再学一次。`
		);
		const candidatePath = snapshot.state.chapters.memory.latestReviewCandidatePath ??
			snapshot.state.memoryCandidatePath;
		if (candidatePath) {
			this.contentEl.createDiv({
				cls: "echo-notes-getting-started-artifact-path",
				text: candidatePath
			});
		}
		const actions: Array<[string, () => Promise<void>]> = [];
		if (this.hasExperienceNote(snapshot, "shortcut") || this.hasExperienceNote(snapshot, "first")) {
			actions.push(["打开体验笔记", () => this.actions.openExperienceNote()]);
		}
		if (this.hasTranscript(snapshot, "shortcut")) {
			actions.push(["打开转写与分析", () => this.actions.openShortcutTranscript()]);
		}
		if (candidatePath) {
			actions.push(["打开候选记忆", () => this.actions.openMemoryCandidate()]);
		}
		this.renderArtifactActions(actions);
		this.renderRelearnAction("memory");
	}

	private renderMemoryChapterResult(snapshot: GettingStartedGuideSnapshot): void {
		this.renderStepIntro(
			"brain",
			"记忆沉淀已完成",
			"第一份候选记忆已经生成并保留，可在 Echo Memory 中继续审核。"
		);
		const candidatePath = snapshot.state.chapters.memory.latestReviewCandidatePath ??
			snapshot.state.memoryCandidatePath;
		if (candidatePath) {
			this.contentEl.createDiv({
				cls: "echo-notes-getting-started-artifact-path",
				text: candidatePath
			});
			this.renderArtifactActions([["打开候选记忆", () => this.actions.openMemoryCandidate()]]);
		}
		this.renderRelearnAction("memory");
	}

	private renderChapterControls(snapshot: GettingStartedGuideSnapshot): void {
		const activeChapter = snapshot.state.activeReview?.chapter ?? this.getActiveChapter(snapshot.step);
		if (!activeChapter || snapshot.step === "completed") {
			return;
		}
		if (snapshot.state.activeReview) {
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-chapter-controls")
				.addButton((button) => button
					.setDisabled(isGettingStartedBusy(snapshot.state))
					.setButtonText("结束本次复习")
					.onClick(async () => {
						await this.actions.cancelRelearn();
						this.render();
					}));
			return;
		}
		if (snapshot.progress.chapterOutcomes[activeChapter] !== "pending") {
			return;
		}
		const canSkip = canSkipGettingStartedChapter(snapshot.state, activeChapter);
		if (this.skipConfirmationChapter !== activeChapter) {
			new Setting(this.contentEl)
				.setClass("echo-notes-getting-started-chapter-controls")
				.addButton((button) => button
					.setDisabled(!canSkip)
					.setButtonText("跳过此阶段")
					.onClick(() => {
						this.skipConfirmationChapter = activeChapter;
						this.render();
					}));
			return;
		}

		const confirmationEl = this.contentEl.createDiv({
			cls: "echo-notes-getting-started-skip-confirmation",
			attr: { role: "group", "aria-label": `确认跳过${this.getChapterLabel(activeChapter)}` }
		});
		confirmationEl.createDiv({
			text: "跳过后不会生成本阶段的新人产物，但会解锁下一阶段。之后仍可再学一次。",
			attr: { role: "status", "aria-live": "polite" }
		});
		new Setting(confirmationEl)
			.setClass("echo-notes-getting-started-actions")
			.addButton((button) => button
				.setButtonText("取消")
				.onClick(() => {
					this.skipConfirmationChapter = null;
					this.render();
				}))
			.addButton((button) => button
				.setCta()
				.setDisabled(!canSkip)
				.setButtonText("确认跳过")
				.onClick(async () => {
					await this.actions.skipChapter(activeChapter);
					this.skipConfirmationChapter = null;
					this.render();
				}));
	}

	private renderRelearnAction(chapter: GettingStartedChapterId): void {
		const snapshot = this.getSnapshot();
		new Setting(this.contentEl)
			.setClass("echo-notes-getting-started-chapter-controls")
			.addButton((button) => button
				.setCta()
				.setDisabled(Boolean(snapshot.state.activeReview) || isGettingStartedBusy(snapshot.state))
				.setButtonText("再学一次")
				.onClick(async () => {
					await this.actions.relearnChapter(chapter);
					this.render();
				}));
	}

	private hasExperienceNote(
		snapshot: GettingStartedGuideSnapshot,
		chapter: "first" | "shortcut"
	): boolean {
		return Boolean(
			snapshot.state.chapters[chapter].latestReviewExperienceNotePath ??
			snapshot.state.experienceNotePath
		);
	}

	private hasTranscript(
		snapshot: GettingStartedGuideSnapshot,
		chapter: "first" | "shortcut"
	): boolean {
		return Boolean(
			snapshot.state.chapters[chapter].latestReviewTranscriptPath ??
			(chapter === "first" ? snapshot.state.firstTranscriptPath : snapshot.state.shortcutTranscriptPath)
		);
	}

	private getChapterLabel(chapter: GettingStartedChapterId): string {
		return CHAPTER_DEFINITIONS.find((definition) => definition.id === chapter)?.label ?? chapter;
	}

	private renderPracticeHotkeys(
		hotkeys: GettingStartedHotkeys,
		ids: GettingStartedHotkeyId[]
	): void {
		const containerEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-practice-hotkeys" });
		for (const id of ids) {
			const itemEl = containerEl.createDiv({ cls: "echo-notes-getting-started-practice-hotkey" });
			itemEl.createSpan({ text: HOTKEY_LABELS[id] });
			itemEl.createEl("kbd", { text: formatHotkey(hotkeys[id]) || "请在快捷键设置中配置" });
		}
	}

	private renderStepIntro(icon: string, title: string, description: string): void {
		const introEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-step-intro" });
		const iconEl = introEl.createSpan({ cls: "echo-notes-getting-started-step-intro-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, icon);
		const copyEl = introEl.createDiv();
		copyEl.createEl("h3", { text: title });
		copyEl.createEl("p", { text: description });
	}

	private renderStatus(text: string, success: boolean, busy = false): void {
		const statusEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-status" });
		renderStatusIndicator(statusEl, {
			tone: busy ? "running" : success ? "success" : "warning",
			text,
			live: "polite"
		}, setIcon);
	}

	private renderInlineMessage(text: string, severity: "warning" | "error"): void {
		const messageEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-inline-message" });
		renderStatusIndicator(messageEl, {
			tone: severity === "error" ? "failed" : "warning",
			text,
			live: severity === "error" ? "assertive" : "polite"
		}, setIcon);
	}

	private handleHotkeyCapture(event: KeyboardEvent): void {
		if (!this.recordingHotkeyId || !this.hotkeyDraft) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		if (event.key === "Escape") {
			this.stopHotkeyCapture();
			this.render();
			return;
		}
		const hotkey = captureHotkeyFromKeyboardEvent(event);
		if (!hotkey) {
			return;
		}
		this.hotkeyDraft[this.recordingHotkeyId] = hotkey;
		this.stopHotkeyCapture();
		this.render();
	}

	private startHotkeyCapture(id: GettingStartedHotkeyId): void {
		this.stopHotkeyCapture();
		this.recordingHotkeyId = id;
		window.addEventListener("keydown", this.handleKeydown, true);
		this.render();
	}

	private stopHotkeyCapture(): void {
		window.removeEventListener("keydown", this.handleKeydown, true);
		this.recordingHotkeyId = null;
	}

	private hotkeysMatch(left: GettingStartedHotkeys, right: GettingStartedHotkeys): boolean {
		return (["start", "stop", "transcribe"] as GettingStartedHotkeyId[])
			.every((id) => formatHotkey(left[id]) === formatHotkey(right[id]));
	}

	private getActiveChapter(step: GettingStartedStep): "first" | "shortcut" | "memory" | null {
		if (step === "transcription" || step === "recorder" || step === "first-practice") {
			return "first";
		}
		if (step === "analysis" || step === "hotkeys" || step === "shortcut-practice") {
			return "shortcut";
		}
		return step === "memory" ? "memory" : null;
	}

	private runExternal(action: () => Promise<void>): void {
		void action().catch((error) => {
			new Notice(error instanceof Error ? error.message : String(error));
		});
	}
}

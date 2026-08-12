import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type EchoNotesPlugin from "../main";
import { GettingStartedGuide } from "../getting-started/getting-started-guide";
import { renderStatusIndicator, type StatusIndicatorTone } from "../ui/status-indicator";
import {
	formatTaskBytes,
	formatTaskElapsedTime,
	summarizeTaskCounts,
	type EchoNotesTask,
	type EchoNotesTaskStatus
} from "./task-center-store";
import {
	filterTaskCenterTasks,
	formatTaskDetailsForClipboard,
	getDefaultTaskCenterSection,
	getTaskFailureGuidance,
	getTaskNextStep,
	getTaskPathDisplayName,
	type TaskCenterSection
} from "./task-center-copy";

export const ECHO_NOTES_TASK_CENTER_VIEW_TYPE = "echo-notes-task-center";

export class EchoNotesTaskCenterView extends ItemView {
	private plugin: EchoNotesPlugin;
	private unsubscribers: Array<() => void> = [];
	private gettingStartedGuide: GettingStartedGuide | null = null;
	private statusFilter: EchoNotesTaskStatus | "all" = "all";
	private kindFilter: EchoNotesTask["kind"] | "all" = "all";
	private query = "";
	private activeSection: TaskCenterSection = "tasks";

	constructor(leaf: WorkspaceLeaf, plugin: EchoNotesPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return ECHO_NOTES_TASK_CENTER_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Echo Notes 任务中心";
	}

	getIcon(): string {
		return "list-checks";
	}

	async onOpen(): Promise<void> {
		this.activeSection = getDefaultTaskCenterSection(
			this.plugin.getGettingStartedGuideSnapshot().state.status
		);
		this.gettingStartedGuide = new GettingStartedGuide(
			() => this.plugin.getGettingStartedGuideSnapshot(),
			this.plugin.getGettingStartedGuideActions(),
			() => this.render()
		);
		this.unsubscribers = [
			this.plugin.subscribeTaskCenter(() => this.render()),
			this.plugin.subscribeGettingStarted(() => this.render())
		];
		this.render();
	}

	async onClose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];
		this.gettingStartedGuide?.destroy();
		this.gettingStartedGuide = null;
		this.contentEl.empty();
	}

	revealGettingStarted(): void {
		this.activeSection = "guide";
		this.gettingStartedGuide?.open();
	}

	private render(): void {
		if (this.activeSection === "guide" && !this.gettingStartedGuide?.isVisible()) {
			this.activeSection = "tasks";
		}

		this.contentEl.empty();
		this.contentEl.addClass("echo-notes-task-center");
		const panels = this.renderSectionTabs();
		if (this.activeSection === "guide") {
			this.gettingStartedGuide?.renderInto(panels.guide);
			return;
		}

		this.renderTaskList(panels.tasks);
	}

	private renderSectionTabs(): Record<TaskCenterSection, HTMLElement> {
		const tabsEl = this.contentEl.createDiv({ cls: "echo-notes-task-center-tabs" });
		tabsEl.setAttribute("role", "tablist");
		tabsEl.setAttribute("aria-label", "任务中心视图");
		const definitions: ReadonlyArray<{ id: TaskCenterSection; label: string; icon: string }> = [
			{ id: "guide", label: "新人指引", icon: "compass" },
			{ id: "tasks", label: "任务列表", icon: "list-checks" }
		];
		const panels = {} as Record<TaskCenterSection, HTMLElement>;

		for (const [index, definition] of definitions.entries()) {
			const active = definition.id === this.activeSection;
			const tabId = `echo-notes-task-center-tab-${definition.id}`;
			const panelId = `echo-notes-task-center-panel-${definition.id}`;
			const buttonEl = tabsEl.createEl("button", {
				cls: `echo-notes-task-center-tab${active ? " is-active" : ""}`,
				attr: {
					type: "button",
					role: "tab",
					id: tabId,
					"aria-selected": String(active),
					"aria-controls": panelId,
					tabindex: active ? "0" : "-1"
				}
			});
			const iconEl = buttonEl.createSpan({ cls: "echo-notes-task-center-tab-icon" });
			iconEl.setAttribute("aria-hidden", "true");
			setIcon(iconEl, definition.icon);
			buttonEl.createSpan({ text: definition.label });
			buttonEl.addEventListener("click", () => this.activateSection(definition.id));
			buttonEl.addEventListener("keydown", (event) => {
				let targetIndex: number;
				switch (event.key) {
					case "ArrowLeft":
						targetIndex = (index - 1 + definitions.length) % definitions.length;
						break;
					case "ArrowRight":
						targetIndex = (index + 1) % definitions.length;
						break;
					case "Home":
						targetIndex = 0;
						break;
					case "End":
						targetIndex = definitions.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				this.activateSection(definitions[targetIndex].id, true);
			});
		}

		for (const definition of definitions) {
			const active = definition.id === this.activeSection;
			const panelEl = this.contentEl.createDiv({ cls: "echo-notes-task-center-panel" });
			panelEl.id = `echo-notes-task-center-panel-${definition.id}`;
			panelEl.setAttribute("role", "tabpanel");
			panelEl.setAttribute("aria-labelledby", `echo-notes-task-center-tab-${definition.id}`);
			panelEl.hidden = !active;
			panels[definition.id] = panelEl;
		}
		return panels;
	}

	private activateSection(section: TaskCenterSection, focusTab = false): void {
		this.activeSection = section;
		if (section === "guide") {
			this.gettingStartedGuide?.open();
		} else {
			this.render();
		}
		if (focusTab) {
			window.requestAnimationFrame(() => {
				this.contentEl.querySelector<HTMLButtonElement>(`#echo-notes-task-center-tab-${section}`)?.focus();
			});
		}
	}

	private renderTaskList(containerEl: HTMLElement): void {
		const allTasks = this.plugin.getTaskCenterTasks();
		const counts = summarizeTaskCounts(allTasks);
		const tasks = filterTaskCenterTasks(allTasks, {
			status: this.statusFilter,
			kind: this.kindFilter,
			query: this.query
		});

		const headerEl = containerEl.createDiv({ cls: "echo-notes-task-center-header" });
		const titleWrapEl = headerEl.createDiv({ cls: "echo-notes-task-center-title-wrap" });
		titleWrapEl.createDiv({ cls: "echo-notes-task-center-title", text: "任务概览" });
		titleWrapEl.createDiv({
			cls: "echo-notes-task-center-summary",
			text: `运行中 ${counts.running} · 失败 ${counts.failed} · 完成 ${counts.success} · 已跳过 ${counts.skipped}`
		});

		const actionsEl = headerEl.createDiv({ cls: "echo-notes-task-center-actions" });
		this.createIconButton(actionsEl, "refresh-cw", "刷新", () => this.render());
		this.createIconButton(actionsEl, "trash-2", "清除已结束任务", () => {
			this.plugin.clearFinishedTaskCenterTasks();
		});

		if (allTasks.length === 0) {
			containerEl.createDiv({
				cls: "echo-notes-task-center-empty",
				text: "暂无任务。完成一次转写或分析后，任务会自动出现在这里。"
			});
			return;
		}

		const filtersEl = containerEl.createDiv({ cls: "echo-notes-task-center-filters" });
		const searchEl = filtersEl.createEl("input", {
			cls: "echo-notes-task-center-search",
			attr: { type: "search", placeholder: "搜索任务、文件或阶段", "aria-label": "搜索任务、文件或阶段" }
		});
		searchEl.value = this.query;
		searchEl.addEventListener("input", () => {
			this.query = searchEl.value;
		});
		searchEl.addEventListener("change", () => this.render());
		searchEl.addEventListener("keydown", (event) => {
			if (event.key === "Enter") {
				event.preventDefault();
				this.render();
			}
		});
		this.createFilterSelect(filtersEl, "任务类型", this.kindFilter, {
			all: "全部类型",
			transcription: "转写",
			analysis: "AI 分析",
			memory: "记忆"
		}, (value) => {
			this.kindFilter = value as EchoNotesTask["kind"] | "all";
			this.render();
		});
		this.createFilterSelect(filtersEl, "任务状态", this.statusFilter, {
			all: "全部状态",
			running: "运行中",
			failed: "失败",
			success: "完成",
			skipped: "已跳过"
		}, (value) => {
			this.statusFilter = value as EchoNotesTaskStatus | "all";
			this.render();
		});
		filtersEl.createSpan({
			cls: "echo-notes-task-center-filter-summary",
			text: tasks.length === allTasks.length ? "" : `显示 ${tasks.length}/${allTasks.length} 个任务`
		});

		if (tasks.length === 0) {
			containerEl.createDiv({
				cls: "echo-notes-task-center-empty",
				text: "没有匹配的任务，请调整筛选条件。"
			});
			return;
		}

		const listEl = containerEl.createDiv({ cls: "echo-notes-task-center-list" });
		for (const task of tasks) {
			this.renderTask(listEl, task);
		}
	}

	private renderTask(containerEl: HTMLElement, task: EchoNotesTask): void {
		const taskEl = containerEl.createDiv({ cls: `echo-notes-task-card is-${task.status}` });
		const mainEl = taskEl.createDiv({ cls: "echo-notes-task-card-main" });
		const headerEl = mainEl.createDiv({ cls: "echo-notes-task-card-header" });
		const statusEl = headerEl.createSpan({ cls: "echo-notes-task-status" });
		renderStatusIndicator(statusEl, {
			tone: getStatusTone(task.status),
			text: getStatusLabel(task.status)
		}, setIcon);
		headerEl.createDiv({ cls: "echo-notes-task-kind", text: getTaskKindLabel(task.kind) });

		mainEl.createDiv({ cls: "echo-notes-task-title", text: task.title });
		mainEl.createDiv({ cls: "echo-notes-task-stage", text: task.stage });
		mainEl.createDiv({ cls: "echo-notes-task-next-step", text: `下一步：${getTaskNextStep(task)}` });

		const detailsEl = mainEl.createEl("details", { cls: "echo-notes-task-details" });
		detailsEl.createEl("summary", { text: "任务详情" });
		const metaEl = detailsEl.createDiv({ cls: "echo-notes-task-meta" });
		this.renderMeta(metaEl, "服务商", task.provider ?? "未记录");
		this.renderMeta(metaEl, "模型", task.model ?? "未记录");
		if (task.kind === "transcription") {
			this.renderMeta(metaEl, "音频大小", formatTaskBytes(task.bytes));
		}
		this.renderMeta(metaEl, "耗时", formatTaskElapsedTime(task));
		if (task.totalSegments) {
			this.renderMeta(
				metaEl,
				task.kind === "transcription" ? "分段" : "分块",
				`${task.currentSegment ?? 0}/${task.totalSegments}`
			);
		}
		if (task.sourcePath) {
			this.renderPathMeta(metaEl, "来源", task.sourcePath);
		}
		this.renderPathMeta(metaEl, task.outputPath ? "输出" : "目标", task.outputPath ?? task.targetPath);
		if (task.traceId) {
			this.renderMeta(metaEl, "Trace ID", task.traceId, true);
		}

		if (task.error) {
			const guidance = getTaskFailureGuidance(task.kind, task.error);
			const errorEl = mainEl.createDiv({ cls: "echo-notes-task-error" });
			errorEl.createDiv({ cls: "echo-notes-task-error-cause", text: `发生原因：${guidance.causedBy}` });
			errorEl.createDiv({ cls: "echo-notes-task-error-next", text: `处理建议：${guidance.nextStep}` });
			const details = errorEl.createEl("details", { cls: "echo-notes-task-error-details" });
			details.createEl("summary", { text: "技术详情" });
			details.createEl("pre", { text: task.error });
		}

		const actionsEl = taskEl.createDiv({ cls: "echo-notes-task-card-actions" });
		this.createIconButton(actionsEl, "file-search", "打开任务文件", () => {
			void this.plugin.openTaskCenterTask(task);
		});
		this.createIconButton(actionsEl, "copy", "复制任务详情", async () => {
			try {
				await navigator.clipboard.writeText(formatTaskDetailsForClipboard(task));
				new Notice("任务详情已复制。");
			} catch {
				new Notice("任务详情复制失败。");
			}
		});
		this.createIconButton(actionsEl, "package", "导出诊断包", () => {
			this.plugin.openDiagnosticExport(task);
		});
		if (task.kind === "memory" && task.status === "success" && task.outputPath) {
			this.createTextAction(actionsEl, "clipboard-check", "立即审核", () => {
				void this.plugin.reviewMemoryCandidatePath(task.outputPath!);
			});
		}
		if (task.retry && (task.status === "failed" || (task.status === "running" && task.retry.allowWhileRunning))) {
			this.createIconButton(actionsEl, "rotate-ccw", task.retry.label, async () => {
				const retried = await this.plugin.retryTaskCenterTask(task.id);
				if (!retried) {
					new Notice("当前任务无法重试。");
				}
			});
		}
	}

	private createFilterSelect(
		containerEl: HTMLElement,
		label: string,
		value: string,
		options: Record<string, string>,
		onChange: (value: string) => void
	): void {
		const selectEl = containerEl.createEl("select", {
			cls: "echo-notes-task-center-filter",
			attr: { "aria-label": label }
		});
		for (const [optionValue, optionLabel] of Object.entries(options)) {
			selectEl.createEl("option", { value: optionValue, text: optionLabel });
		}
		selectEl.value = value;
		selectEl.addEventListener("change", () => onChange(selectEl.value));
	}

	private createTextAction(
		containerEl: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): HTMLButtonElement {
		const buttonEl = containerEl.createEl("button", {
			cls: "echo-notes-task-text-action",
			attr: { type: "button", "aria-label": label, title: label }
		});
		setIcon(buttonEl, icon);
		buttonEl.createSpan({ text: label });
		buttonEl.addEventListener("click", onClick);
		return buttonEl;
	}

	private renderMeta(containerEl: HTMLElement, label: string, value: string, technical = false): void {
		const itemEl = containerEl.createDiv({ cls: "echo-notes-task-meta-item" });
		itemEl.createSpan({ cls: "echo-notes-task-meta-label", text: `${label}:` });
		itemEl.createSpan({
			cls: `echo-notes-task-meta-value${technical ? " is-technical" : ""}`,
			text: value
		});
	}

	private renderPathMeta(containerEl: HTMLElement, label: string, path: string): void {
		const itemEl = containerEl.createDiv({ cls: "echo-notes-task-meta-item is-path" });
		itemEl.createSpan({ cls: "echo-notes-task-meta-label", text: `${label}:` });
		itemEl.createSpan({
			cls: "echo-notes-task-meta-value",
			text: getTaskPathDisplayName(path),
			attr: { title: path }
		});
	}

	private createIconButton(
		containerEl: HTMLElement,
		icon: string,
		title: string,
		onClick: (event: MouseEvent) => Promise<void> | void
	): HTMLButtonElement {
		const buttonEl = containerEl.createEl("button", {
			cls: "clickable-icon echo-notes-task-icon-button",
			attr: {
				"aria-label": title,
				title
			}
		});
		buttonEl.type = "button";
		setIcon(buttonEl, icon);
		buttonEl.addEventListener("click", (event) => {
			void onClick(event);
		});
		return buttonEl;
	}
}

function getTaskKindLabel(kind: EchoNotesTask["kind"]): string {
	switch (kind) {
		case "transcription":
			return "转写";
		case "analysis":
			return "分析";
		case "memory":
			return "记忆";
	}
}

function getStatusLabel(status: EchoNotesTaskStatus): string {
	switch (status) {
		case "running":
			return "进行中";
		case "success":
			return "完成";
		case "failed":
			return "失败";
		case "skipped":
			return "已跳过";
	}
}

function getStatusTone(status: EchoNotesTaskStatus): StatusIndicatorTone {
	switch (status) {
		case "running":
			return "running";
		case "success":
			return "success";
		case "failed":
			return "failed";
		case "skipped":
			return "neutral";
	}
}

import { ItemView, Notice, setIcon, type WorkspaceLeaf } from "obsidian";
import type EchoNotesPlugin from "../main";
import type { GettingStartedChecklistSnapshot } from "../main";
import {
	formatTaskBytes,
	formatTaskElapsedTime,
	summarizeTaskCounts,
	type EchoNotesTask,
	type EchoNotesTaskStatus
} from "./task-center-store";

export const ECHO_NOTES_TASK_CENTER_VIEW_TYPE = "echo-notes-task-center";

export class EchoNotesTaskCenterView extends ItemView {
	private plugin: EchoNotesPlugin;
	private unsubscribers: Array<() => void> = [];

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
		this.unsubscribers = [
			this.plugin.subscribeTaskCenter(() => this.render()),
			this.plugin.subscribeSettings(() => this.render())
		];
		this.render();
	}

	async onClose(): Promise<void> {
		for (const unsubscribe of this.unsubscribers) {
			unsubscribe();
		}
		this.unsubscribers = [];
		this.contentEl.empty();
	}

	private render(): void {
		const tasks = this.plugin.getTaskCenterTasks();
		const counts = summarizeTaskCounts(tasks);

		this.contentEl.empty();
		this.contentEl.addClass("echo-notes-task-center");
		this.renderGettingStarted(this.plugin.getGettingStartedChecklistSnapshot());

		const headerEl = this.contentEl.createDiv({ cls: "echo-notes-task-center-header" });
		const titleWrapEl = headerEl.createDiv({ cls: "echo-notes-task-center-title-wrap" });
		titleWrapEl.createDiv({ cls: "echo-notes-task-center-title", text: "任务中心" });
		titleWrapEl.createDiv({
			cls: "echo-notes-task-center-summary",
			text: `运行中 ${counts.running} · 失败 ${counts.failed} · 完成 ${counts.success} · 已跳过 ${counts.skipped}`
		});

		const actionsEl = headerEl.createDiv({ cls: "echo-notes-task-center-actions" });
		this.createIconButton(actionsEl, "refresh-cw", "刷新", () => this.render());
		this.createIconButton(actionsEl, "trash-2", "清除已结束任务", () => {
			this.plugin.clearFinishedTaskCenterTasks();
		});

		if (tasks.length === 0) {
			this.contentEl.createDiv({ cls: "echo-notes-task-center-empty", text: "暂无任务。" });
			return;
		}

		const listEl = this.contentEl.createDiv({ cls: "echo-notes-task-center-list" });
		for (const task of tasks) {
			this.renderTask(listEl, task);
		}
	}

	private renderGettingStarted(snapshot: GettingStartedChecklistSnapshot): void {
		if (snapshot.state.status === "dismissed") {
			return;
		}

		const sectionEl = this.contentEl.createEl("section", {
			cls: `echo-notes-getting-started-checklist${snapshot.completionVisible ? " is-completed" : ""}`,
			attr: { "aria-labelledby": "echo-notes-getting-started-checklist-title" }
		});
		const headerEl = sectionEl.createDiv({ cls: "echo-notes-getting-started-checklist-header" });
		const headingEl = headerEl.createDiv({ cls: "echo-notes-getting-started-checklist-heading" });
		headingEl.createDiv({
			cls: "echo-notes-getting-started-checklist-title",
			text: "开始使用 Echo Notes",
			attr: { id: "echo-notes-getting-started-checklist-title" }
		});
		headingEl.createDiv({
			cls: "echo-notes-getting-started-checklist-progress",
			text: `${snapshot.progress.completedSteps}/3`,
			attr: { "aria-label": `已完成 ${snapshot.progress.completedSteps} 个，共 3 个步骤` }
		});

		const toggleEl = this.createIconButton(
			headerEl,
			snapshot.guideExpanded ? "chevron-up" : "chevron-down",
			snapshot.guideExpanded ? "收起新人指引" : "展开新人指引",
			() => this.plugin.setGettingStartedGuideExpanded(!snapshot.guideExpanded)
		);
		toggleEl.addClass("echo-notes-getting-started-toggle");

		if (!snapshot.guideExpanded && !snapshot.completionVisible) {
			return;
		}

		if (snapshot.completionVisible) {
			const successEl = sectionEl.createDiv({
				cls: "echo-notes-getting-started-success",
				attr: { role: "status", "aria-live": "polite" }
			});
			const iconEl = successEl.createSpan({ cls: "echo-notes-getting-started-success-icon" });
			iconEl.setAttribute("aria-hidden", "true");
			setIcon(iconEl, "party-popper");
			successEl.createSpan({ text: "首次转写与 AI 分析已完成" });
		}

		const listEl = sectionEl.createDiv({ cls: "echo-notes-getting-started-steps" });
		this.renderGettingStartedStep(
			listEl,
			snapshot.progress.transcriptionReady,
			"转写服务可用",
			snapshot.progress.transcriptionReady ? "查看配置" : "去配置",
			() => this.plugin.openSettingsDestination(
				"transcription-service",
				{ guide: "provider-api-key" }
			)
		);
		this.renderGettingStartedStep(
			listEl,
			snapshot.progress.analysisReady,
			"AI 分析可用",
			snapshot.progress.analysisReady ? "查看配置" : "去配置",
			() => this.plugin.openSettingsDestination(
				"analysis-model",
				{ guide: "provider-api-key" }
			)
		);
		this.renderGettingStartedStep(
			listEl,
			snapshot.progress.firstProcessingCompleted,
			"完成首次处理",
			snapshot.processingActionLabel,
			snapshot.processingAction
				? () => this.plugin.runGettingStartedProcessingAction(snapshot)
				: undefined,
			snapshot.processingStatus
		);
	}

	private renderGettingStartedStep(
		containerEl: HTMLElement,
		completed: boolean,
		label: string,
		actionLabel: string | null,
		onAction?: () => Promise<unknown> | void,
		status?: string
	): void {
		const rowEl = containerEl.createDiv({
			cls: `echo-notes-getting-started-step${completed ? " is-completed" : ""}`
		});
		const statusIconEl = rowEl.createSpan({ cls: "echo-notes-getting-started-step-icon" });
		statusIconEl.setAttribute("aria-hidden", "true");
		setIcon(statusIconEl, completed ? "circle-check" : "circle");
		const textEl = rowEl.createDiv({ cls: "echo-notes-getting-started-step-text" });
		textEl.createDiv({ cls: "echo-notes-getting-started-step-label", text: label });
		if (status) {
			textEl.createDiv({ cls: "echo-notes-getting-started-step-status", text: status });
		}
		if (actionLabel && onAction) {
			const buttonEl = rowEl.createEl("button", {
				cls: "echo-notes-getting-started-step-action",
				text: actionLabel,
				attr: { type: "button" }
			});
			buttonEl.addEventListener("click", () => {
				void onAction();
			});
		}
	}

	private renderTask(containerEl: HTMLElement, task: EchoNotesTask): void {
		const taskEl = containerEl.createDiv({ cls: `echo-notes-task-card is-${task.status}` });
		const mainEl = taskEl.createDiv({ cls: "echo-notes-task-card-main" });
		const headerEl = mainEl.createDiv({ cls: "echo-notes-task-card-header" });
		headerEl.createDiv({
			cls: `echo-notes-task-status is-${task.status}`,
			text: getStatusLabel(task.status)
		});
		headerEl.createDiv({ cls: "echo-notes-task-kind", text: getTaskKindLabel(task.kind) });

		mainEl.createDiv({ cls: "echo-notes-task-title", text: task.title });
		mainEl.createDiv({ cls: "echo-notes-task-stage", text: task.stage });

		const metaEl = mainEl.createDiv({ cls: "echo-notes-task-meta" });
		this.renderMeta(metaEl, "Provider", task.provider ?? "未记录");
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
			this.renderMeta(metaEl, "来源", task.sourcePath);
		}
		this.renderMeta(metaEl, task.outputPath ? "输出" : "目标", task.outputPath ?? task.targetPath);
		if (task.traceId) {
			this.renderMeta(metaEl, "Trace ID", task.traceId);
		}

		if (task.error) {
			mainEl.createDiv({ cls: "echo-notes-task-error", text: task.error });
		}

		const actionsEl = taskEl.createDiv({ cls: "echo-notes-task-card-actions" });
		this.createIconButton(actionsEl, "file-search", "打开任务文件", () => {
			void this.plugin.openTaskCenterTask(task);
		});
		if (task.retry && (task.status === "failed" || (task.status === "running" && task.retry.allowWhileRunning))) {
			this.createIconButton(actionsEl, "rotate-ccw", task.retry.label, async () => {
				const retried = await this.plugin.retryTaskCenterTask(task.id);
				if (!retried) {
					new Notice("当前任务无法重试。");
				}
			});
		}
	}

	private renderMeta(containerEl: HTMLElement, label: string, value: string): void {
		const itemEl = containerEl.createDiv({ cls: "echo-notes-task-meta-item" });
		itemEl.createSpan({ cls: "echo-notes-task-meta-label", text: `${label}:` });
		itemEl.createSpan({ cls: "echo-notes-task-meta-value", text: value });
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
			return "运行中";
		case "success":
			return "完成";
		case "failed":
			return "失败";
		case "skipped":
			return "跳过";
	}
}

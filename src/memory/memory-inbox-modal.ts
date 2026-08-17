import { App, Modal, Notice, Setting, setIcon } from "obsidian";
import {
	formatMemoryType,
	type MemoryType,
	type MemoryReviewUpdate,
	type MemoryTier,
	type MemoryValidity
} from "./memory-types";
import type { MemoryInboxContext, MemoryInboxItem } from "./memory-service";

export interface MemoryInboxViewCallbacks {
	onSave: (candidatePath: string, updates: MemoryReviewUpdate[]) => Promise<void>;
	onReload: () => Promise<MemoryInboxContext>;
	onOpenCandidate: (candidatePath: string) => void;
	onCreateCandidates?: () => void;
	onChange?: () => void;
}

interface MemoryInboxDraft {
	effectiveValue: string;
	effectiveTier: MemoryTier;
	validity: MemoryValidity;
}

type MemoryInboxTierFilter = "all" | "core_candidate" | "long_term_candidate" | "working_candidate" | "low_priority";
type MemoryInboxSort = "recommendation" | "latest" | "confidence";

export class MemoryInboxView {
	private readonly app: App;
	private readonly contentEl: HTMLElement;
	private context: MemoryInboxContext;
	private callbacks: MemoryInboxViewCallbacks;
	private drafts = new Map<string, MemoryInboxDraft>();
	private selectedIds = new Set<string>();
	private tierFilter: MemoryInboxTierFilter = "all";
	private memoryTypeFilter: MemoryType | "all" = "all";
	private sourceFilter = "all";
	private sortMode: MemoryInboxSort = "recommendation";
	private submitting = false;

	constructor(
		app: App,
		contentEl: HTMLElement,
		context: MemoryInboxContext,
		callbacks: MemoryInboxViewCallbacks
	) {
		this.app = app;
		this.contentEl = contentEl;
		this.context = context;
		this.callbacks = callbacks;
		this.syncDrafts();
	}

	render(): void {
		this.contentEl.empty();
		this.contentEl.addClass("echo-notes-memory-inbox");
		const { counts } = this.context;
		const hero = this.contentEl.createDiv({ cls: "echo-notes-memory-inbox-hero" });
		const heroTitle = hero.createDiv({ cls: "echo-notes-memory-inbox-hero-title" });
		heroTitle.createSpan({ cls: "echo-notes-memory-inbox-hero-count", text: String(counts.total) });
		heroTitle.createSpan({ cls: "echo-notes-memory-inbox-hero-label", text: "条待审核" });
		const breakdown = hero.createDiv({ cls: "echo-notes-memory-inbox-hero-breakdown" });
		for (const [label, value, tone] of [
			["核心建议", counts.coreCandidate, "is-core"],
			["长期建议", counts.longTermCandidate, "is-long-term"],
			["工作记忆", counts.workingCandidate, "is-working"],
			["低优先级", counts.lowPriority, "is-low"]
		] as const) {
			const chip = breakdown.createDiv({ cls: `echo-notes-memory-chip ${tone}` });
			chip.createSpan({ cls: "echo-notes-memory-chip-label", text: label });
			chip.createSpan({ cls: "echo-notes-memory-chip-value", text: String(value) });
		}

		this.renderFilters();
		this.renderBulkActions();
		const list = this.contentEl.createDiv({ cls: "echo-notes-memory-inbox-list" });
		if (this.context.pending.length === 0) {
			const empty = list.createDiv({ cls: "echo-notes-memory-inbox-empty" });
			empty.createEl("p", { text: "目前没有待审核的记忆候选。选择一份转写稿并提取记忆，候选会出现在这里。" });
			if (this.callbacks.onCreateCandidates) {
				const action = empty.createEl("button", {
					cls: "mod-cta",
					text: "选择转写稿并提取",
					attr: { type: "button" }
				});
				action.addEventListener("click", this.callbacks.onCreateCandidates);
			}
			return;
		}
		const visibleItems = this.getVisibleItems();
		if (visibleItems.length === 0) {
			list.createDiv({ cls: "echo-notes-memory-inbox-empty", text: "当前筛选条件下没有候选，请调整筛选条件。" });
			return;
		}
		for (const item of visibleItems) {
			this.renderItem(list, item);
		}
	}

	destroy(): void {
		this.contentEl.empty();
	}

	private renderFilters(): void {
		const hasActiveFilter = this.tierFilter !== "all" || this.memoryTypeFilter !== "all" || this.sourceFilter !== "all" || this.sortMode !== "recommendation";
		const toolbar = this.contentEl.createEl("details", { cls: "echo-notes-memory-inbox-filters", attr: { "aria-label": "审核筛选与排序" } });
		toolbar.open = hasActiveFilter;
		toolbar.createEl("summary", { cls: "echo-notes-memory-inbox-filters-title", text: hasActiveFilter ? "筛选与排序（已调整）" : "筛选与排序" });
		const grid = toolbar.createDiv({ cls: "echo-notes-memory-inbox-filters-grid" });
		this.renderSelect(grid, "优先级", [
			["all", "全部优先级"],
			["core_candidate", "核心建议"],
			["long_term_candidate", "长期建议"],
			["working_candidate", "工作记忆"],
			["low_priority", "低优先级"]
		], this.tierFilter, (value) => {
			this.tierFilter = value as MemoryInboxTierFilter;
			this.render();
		});
		this.renderSelect(grid, "记忆类型", [
			["all", "全部类型"],
			["fact", "事实"],
			["decision", "决策"],
			["preference", "偏好"],
			["belief", "信念"],
			["experience", "经验"],
			["goal", "目标"]
		], this.memoryTypeFilter, (value) => {
			this.memoryTypeFilter = value as MemoryType | "all";
			this.render();
		});
		const sources = Array.from(new Set(this.context.pending.map((item) => item.assertion.sourcePath))).sort();
		this.renderSelect(grid, "来源", [["all", "全部来源"], ...sources.map((source) => [source, truncate(source, 42)] as [string, string])], this.sourceFilter, (value) => {
			this.sourceFilter = value;
			this.render();
		});
		this.renderSelect(grid, "排序", [
			["recommendation", "推荐优先"],
			["latest", "最新来源"],
			["confidence", "置信度"]
		], this.sortMode, (value) => {
			this.sortMode = value as MemoryInboxSort;
			this.render();
		});
	}

	private renderSelect(
		containerEl: HTMLElement,
		label: string,
		options: Array<[string, string]>,
		value: string,
		onChange: (value: string) => void
	): void {
		const field = containerEl.createDiv({ cls: "echo-notes-memory-inbox-filter" });
		field.createEl("label", { text: label });
		const select = field.createEl("select", { attr: { "aria-label": label } });
		for (const [optionValue, optionLabel] of options) {
			select.createEl("option", { value: optionValue, text: optionLabel });
		}
		select.value = value;
		select.addEventListener("change", () => onChange(select.value));
	}

	private renderBulkActions(): void {
		const actions = this.contentEl.createDiv({ cls: "echo-notes-memory-inbox-bulk-actions" });
		const visibleItems = this.getVisibleItems();
		const selection = actions.createEl("label", { cls: "echo-notes-memory-inbox-selection" });
		const selectAll = selection.createEl("input", { attr: { type: "checkbox" } });
		selectAll.checked = visibleItems.length > 0 && visibleItems.every((item) => this.selectedIds.has(item.assertion.id));
		selectAll.indeterminate = visibleItems.some((item) => this.selectedIds.has(item.assertion.id)) && !selectAll.checked;
		selectAll.addEventListener("change", () => {
			for (const item of visibleItems) {
				if (selectAll.checked) this.selectedIds.add(item.assertion.id);
				else this.selectedIds.delete(item.assertion.id);
			}
			this.render();
		});
		selection.createSpan({ text: `已选 ${this.getSelectedItems().length} 条` });
		const buttons = actions.createDiv({ cls: "echo-notes-memory-inbox-bulk-buttons" });
		this.addActionButton(buttons, "check-check", `批准已选${this.getSelectedItems().length ? ` ${this.getSelectedItems().length} 条` : ""}`, this.getSelectedItems().length === 0 || this.submitting, () => void this.bulkApproveSelected());
		this.addActionButton(buttons, "circle-x", `拒绝已选${this.getSelectedItems().length ? ` ${this.getSelectedItems().length} 条` : ""}`, this.getSelectedItems().length === 0 || this.submitting, () => void this.bulkRejectSelected());
		this.addActionButton(buttons, "circle-x", "拒绝低优先级", this.submitting, () => void this.bulkRejectLowPriority());
		this.addActionButton(buttons, "check-check", "批准工作记忆", this.submitting, () => void this.bulkApproveWorking());
	}

	private addActionButton(containerEl: HTMLElement, icon: string, label: string, disabled: boolean, onClick: () => void): void {
		const button = containerEl.createEl("button", { cls: "echo-notes-memory-inbox-bulk-button", attr: { type: "button" } });
		button.disabled = disabled;
		button.setAttribute("aria-label", label);
		setIcon(button, icon);
		button.createSpan({ text: label });
		button.addEventListener("click", onClick);
	}

	private getVisibleItems(): MemoryInboxItem[] {
		return this.context.pending
			.filter((item) => this.tierFilter === "all" || item.admission.recommendation === this.tierFilter)
			.filter((item) => this.memoryTypeFilter === "all" || item.assertion.memoryType === this.memoryTypeFilter)
			.filter((item) => this.sourceFilter === "all" || item.assertion.sourcePath === this.sourceFilter)
			.sort((left, right) => {
				if (this.sortMode === "latest") return right.assertion.observedAt.localeCompare(left.assertion.observedAt);
				if (this.sortMode === "confidence") return right.assertion.confidence - left.assertion.confidence;
				return recommendationRank(left.admission.recommendation) - recommendationRank(right.admission.recommendation) || right.admission.score - left.admission.score;
			});
	}

	private getSelectedItems(): MemoryInboxItem[] {
		return this.context.pending.filter((item) => this.selectedIds.has(item.assertion.id));
	}

	private async bulkApproveSelected(): Promise<void> {
		const selected = this.getSelectedItems();
		if (selected.length === 0) return;
		if (!await this.confirmAction(`确认批准已选 ${selected.length} 条候选吗？`)) return;
		await this.persistByCandidate(selected.map((item) => this.buildUpdate(item, "approved")));
	}

	private async bulkRejectSelected(): Promise<void> {
		const selected = this.getSelectedItems();
		if (selected.length === 0) return;
		if (!await this.confirmAction(`确认拒绝已选 ${selected.length} 条候选吗？`)) return;
		await this.persistByCandidate(selected.map((item) => this.buildUpdate(item, "rejected")));
	}

	private buildUpdate(item: MemoryInboxItem, status: MemoryReviewUpdate["status"]): MemoryReviewUpdate {
		const draft = this.drafts.get(item.assertion.id);
		return {
			assertionId: item.assertion.id,
			status,
			effectiveValue: draft?.effectiveValue ?? item.assertion.value,
			note: "",
			effectiveTier: draft?.effectiveTier ?? (item.assertion.proposedTier === "working" ? "working" : "long_term"),
			validity: draft?.validity ?? "active"
		};
	}

	private renderItem(containerEl: HTMLElement, item: MemoryInboxItem): void {
		const card = containerEl.createDiv({ cls: "echo-notes-memory-inbox-card" });
		const selectLabel = card.createEl("label", { cls: "echo-notes-memory-inbox-card-select" });
		const checkbox = selectLabel.createEl("input", { attr: { type: "checkbox", "aria-label": `选择候选：${item.assertion.subjectName} ${item.assertion.predicate}` } });
		checkbox.checked = this.selectedIds.has(item.assertion.id);
		checkbox.addEventListener("change", () => {
			if (checkbox.checked) this.selectedIds.add(item.assertion.id);
			else this.selectedIds.delete(item.assertion.id);
			this.render();
		});
		const head = card.createDiv({ cls: "echo-notes-memory-inbox-head" });
		head.createEl("h3", {
			cls: "echo-notes-memory-inbox-title",
			text: `${item.assertion.subjectName} · ${item.assertion.predicate}`
		});
		head.createDiv({
			cls: `echo-notes-memory-inbox-tier ${formatRecommendationTone(item.admission.recommendation)}`,
			text: formatRecommendationShort(item.admission.recommendation)
		});
		card.createDiv({
			cls: "echo-notes-memory-inbox-meta",
			text: `[${formatMemoryType(item.assertion.memoryType)}] · 评分 ${item.admission.score}/12`
		});
		const evidenceRail = card.createDiv({ cls: "echo-notes-memory-inbox-evidence-rail" });
		const candidateBlock = evidenceRail.createDiv({ cls: "echo-notes-memory-inbox-evidence-step" });
		candidateBlock.createSpan({ cls: "echo-notes-memory-inbox-evidence-label", text: "AI 候选" });
		candidateBlock.createEl("blockquote", {
			cls: "echo-notes-memory-inbox-value",
			text: item.assertion.value
		});
		const sourceBlock = evidenceRail.createDiv({ cls: "echo-notes-memory-inbox-evidence-step" });
		sourceBlock.createSpan({ cls: "echo-notes-memory-inbox-evidence-label", text: "原文证据" });
		sourceBlock.createEl("blockquote", {
			cls: "echo-notes-memory-inbox-evidence",
			text: `“${item.assertion.evidenceQuote}”`
		});
		const details = card.createEl("details", { cls: "echo-notes-memory-inbox-insight-details" });
		details.createEl("summary", { text: "查看 AI 判断依据与关联建议" });
		if (item.assertion.whyRemember) {
			details.createEl("blockquote", {
				cls: "echo-notes-memory-inbox-reason",
				text: `为什么值得记住：${item.assertion.whyRemember}`
			});
		}
		details.createDiv({
			cls: "echo-notes-memory-inbox-admission",
			text: item.admission.reasons.join(" · ")
		});
		const source = card.createDiv({ cls: "echo-notes-memory-inbox-source" });
		source.createSpan({ text: `来源：${item.assertion.observedAt} · ` });
		source.createSpan({ text: item.assertion.sourcePath });
		const openCandidate = source.createEl("button", {
			cls: "echo-notes-memory-inbox-open-link",
			text: "打开候选",
			attr: { type: "button" }
		});
		openCandidate.addEventListener("click", () => this.callbacks.onOpenCandidate(item.candidatePath));
		if (item.relatedSuggestions.length > 0) {
			const related = details.createDiv({ cls: "echo-notes-memory-inbox-related" });
			related.createSpan({ text: `可能相关：${item.relatedSuggestions.length} 条` });
			for (const suggestion of item.relatedSuggestions) {
				related.createDiv({
					text: `${suggestion.kind}：${suggestion.target.predicate}：${truncate(suggestion.target.effectiveValue, 80)}`
				});
			}
			related.createDiv({ cls: "echo-notes-memory-inbox-related-hint", text: "关系不会自动建立，需在审核后人工确认。" });
		}

		const draft = this.drafts.get(item.assertion.id);
		if (draft) {
			const editDetails = card.createEl("details", { cls: "echo-notes-memory-inbox-edit" });
			editDetails.createEl("summary", { text: "修改记忆内容、层级和有效性" });
			new Setting(editDetails)
				.setName("生效内容")
				.addTextArea((text) => {
					text.inputEl.rows = 2;
					return text.setValue(draft.effectiveValue).onChange((value) => {
						draft.effectiveValue = value;
					});
				});
			new Setting(editDetails)
				.setName("层级")
				.addDropdown((dropdown) => dropdown
					.addOptions({ working: "工作记忆", long_term: "长期", core: "核心" })
					.setValue(draft.effectiveTier)
					.onChange((value) => {
						draft.effectiveTier = value as MemoryTier;
					}));
			new Setting(editDetails)
				.setName("有效性")
				.addDropdown((dropdown) => dropdown
					.addOptions({ active: "当前有效", historical: "历史状态", uncertain: "待确认" })
					.setValue(draft.validity)
					.onChange((value) => {
						draft.validity = value as MemoryValidity;
					}));
		}

		const actions = new Setting(card).setClass("echo-notes-memory-inbox-actions");
		actions.setName("你的决定");
		actions.addButton((button) => {
			button.setIcon("check").setCta().setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "批准" });
			button.onClick(() => void this.save(item, "approved"));
		});
		actions.addButton((button) => {
			button.setIcon("circle-x").setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "拒绝" });
			button.onClick(() => void this.save(item, "rejected"));
		});
		const advanced = card.createEl("details", { cls: "echo-notes-memory-inbox-advanced-actions" });
		advanced.createEl("summary", { text: "更多审核动作" });
		const advancedSetting = new Setting(advanced).setClass("echo-notes-memory-inbox-actions");
		advancedSetting.addButton((button) => {
			button.setIcon("star").setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "设为核心并批准" });
			button.onClick(() => void this.promoteToCore(item));
		});
		advancedSetting.addButton((button) => {
			button.setIcon("rotate-ccw").setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "恢复待审核" });
			button.onClick(() => void this.save(item, "pending"));
		});
	}

	private async save(item: MemoryInboxItem, status: MemoryReviewUpdate["status"]): Promise<void> {
		if (this.submitting) {
			return;
		}
		const draft = this.drafts.get(item.assertion.id);
		if (!draft) {
			return;
		}
		const effectiveValue = draft.effectiveValue.trim();
		if (!effectiveValue) {
			new Notice("生效内容不能为空。");
			return;
		}
		const update: MemoryReviewUpdate = {
			assertionId: item.assertion.id,
			status,
			effectiveValue,
			note: "",
			effectiveTier: draft.effectiveTier,
			validity: draft.validity
		};
		await this.persist(item.candidatePath, [update]);
	}

	private async promoteToCore(item: MemoryInboxItem): Promise<void> {
		const draft = this.drafts.get(item.assertion.id);
		if (!draft) {
			return;
		}
		if (!await this.confirmAction("确认将这条候选设为核心记忆并批准吗？")) return;
		draft.effectiveTier = "core";
		await this.save(item, "approved");
	}

	private async bulkRejectLowPriority(): Promise<void> {
		const lowPriority = this.context.pending.filter((item) => item.admission.recommendation === "low_priority");
		if (lowPriority.length === 0) {
			new Notice("没有低优先级候选。");
			return;
		}
		if (!await this.confirmAction(`确认拒绝低优先级候选 ${lowPriority.length} 条吗？`)) return;
		await this.persistByCandidate(
			lowPriority.map((item) => ({
				assertionId: item.assertion.id,
				status: "rejected",
				effectiveValue: item.assertion.value,
				note: ""
			}))
		);
	}

	private async bulkApproveWorking(): Promise<void> {
		const working = this.context.pending.filter((item) => item.admission.recommendation === "working_candidate");
		if (working.length === 0) {
			new Notice("没有工作记忆候选。");
			return;
		}
		if (!await this.confirmAction(`确认批准工作记忆候选 ${working.length} 条吗？`)) return;
		await this.persistByCandidate(
			working.map((item) => ({
				assertionId: item.assertion.id,
				status: "approved",
				effectiveValue: item.assertion.value,
				note: "",
				effectiveTier: "working",
				validity: "active"
			}))
		);
	}

	private async persistByCandidate(updates: MemoryReviewUpdate[]): Promise<void> {
		const byCandidate = new Map<string, MemoryReviewUpdate[]>();
		for (const update of updates) {
			const item = this.context.pending.find((entry) => entry.assertion.id === update.assertionId);
			if (!item) {
				continue;
			}
			byCandidate.set(item.candidatePath, [...(byCandidate.get(item.candidatePath) ?? []), update]);
		}
		for (const [candidatePath, candidateUpdates] of byCandidate) {
			await this.persist(candidatePath, candidateUpdates);
		}
	}

	private confirmAction(message: string): Promise<boolean> {
		return new Promise((resolve) => {
			new MemoryInboxConfirmModal(this.app, message, resolve).open();
		});
	}

	private async persist(candidatePath: string, updates: MemoryReviewUpdate[]): Promise<void> {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		this.render();
		try {
			await this.callbacks.onSave(candidatePath, updates);
			this.context = await this.callbacks.onReload();
			for (const update of updates) this.selectedIds.delete(update.assertionId);
			this.syncDrafts();
			this.callbacks.onChange?.();
			new Notice(`已保存审核：${updates.length} 条候选。`);
		} catch (error) {
			new Notice(`审核保存失败：${getErrorMessage(error)}`);
		} finally {
			this.submitting = false;
			this.render();
		}
	}

	private syncDrafts(): void {
		for (const item of this.context.pending) {
			if (!this.drafts.has(item.assertion.id)) {
				this.drafts.set(item.assertion.id, {
					effectiveValue: item.assertion.value,
					effectiveTier: item.assertion.proposedTier === "working" ? "working" : "long_term",
					validity: "active"
				});
			}
		}
	}
}

function truncate(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatRecommendationShort(value: string): string {
	switch (value) {
		case "core_candidate":
			return "核心候选";
		case "long_term_candidate":
			return "长期候选";
		case "working_candidate":
			return "工作记忆";
		case "low_priority":
			return "低优先级";
		default:
			return value;
	}
}

function formatRecommendationTone(value: string): string {
	switch (value) {
		case "core_candidate":
			return "is-core";
		case "long_term_candidate":
			return "is-long-term";
		case "working_candidate":
			return "is-working";
		case "low_priority":
			return "is-low";
		default:
			return "";
	}
}

function recommendationRank(value: string): number {
	switch (value) {
		case "core_candidate":
			return 0;
		case "long_term_candidate":
			return 1;
		case "working_candidate":
			return 2;
		case "low_priority":
			return 3;
		default:
			return 4;
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

class MemoryInboxConfirmModal extends Modal {
	private resolved = false;

	constructor(app: App, private readonly message: string, private readonly onResolved: (confirmed: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("确认批量审核");
		this.contentEl.addClass("echo-notes-memory-inbox-confirm-modal");
		this.contentEl.createEl("p", { text: this.message });
		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button.setButtonText("取消").onClick(() => this.resolve(false)));
		actions.addButton((button) => button.setButtonText("确认").setCta().onClick(() => this.resolve(true)));
	}

	onClose(): void {
		this.resolve(false);
	}

	private resolve(value: boolean): void {
		if (this.resolved) return;
		this.resolved = true;
		this.onResolved(value);
		this.close();
	}
}

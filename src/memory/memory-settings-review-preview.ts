import { Notice, setIcon } from "obsidian";
import type { MemoryInboxContext, MemoryInboxItem } from "./memory-service";
import type { MemoryReviewUpdate } from "./memory-types";

export interface MemorySettingsReviewPreviewCallbacks {
	getContext: () => Promise<MemoryInboxContext>;
	save: (candidatePath: string, updates: MemoryReviewUpdate[]) => Promise<void>;
	openCenter: () => void;
	openCandidate?: (candidatePath: string) => void;
}

type PreviewFilter = "all" | "long_term_candidate" | "working_candidate";

export class MemorySettingsReviewPreview {
	private context: MemoryInboxContext | null = null;
	private filter: PreviewFilter = "all";
	private savingId: string | null = null;
	private destroyed = false;

	constructor(
		private readonly contentEl: HTMLElement,
		private readonly callbacks: MemorySettingsReviewPreviewCallbacks
	) {}

	render(): void {
		this.destroyed = false;
		this.renderLoading();
		void this.load();
	}

	destroy(): void {
		this.destroyed = true;
		this.contentEl.empty();
	}

	private renderLoading(): void {
		this.contentEl.empty();
		this.contentEl.createDiv({
			cls: "echo-notes-memory-settings-review-loading",
			text: "正在读取待审核候选…"
		});
	}

	private async load(): Promise<void> {
		try {
			this.context = await this.callbacks.getContext();
			if (!this.destroyed) {
				this.renderContent();
			}
		} catch (error) {
			if (this.destroyed) return;
			this.context = null;
			this.contentEl.empty();
			const detail = error instanceof Error ? error.message : String(error);
			const needsInitialization = detail.includes("尚未初始化") || detail.includes("初始化清单");
			const errorEl = this.contentEl.createDiv({
				cls: "echo-notes-memory-settings-review-error",
				text: needsInitialization ? "请先初始化 Echo Memory，再查看待审核候选。" : "暂时无法读取待审核候选，请先检查记忆配置后重试。"
			});
			errorEl.createEl("small", { text: detail });
			if (needsInitialization) {
				this.renderAction(errorEl, "打开记忆中心", "clipboard-check", this.callbacks.openCenter, true);
			}
			this.renderAction(errorEl, "重试", "refresh-cw", () => this.render());
		}
	}

	private renderContent(): void {
		if (!this.context) return;
		this.contentEl.empty();
		const pending = this.context.pending;
		const header = this.contentEl.createDiv({ cls: "echo-notes-memory-settings-review-header" });
		const heading = header.createDiv({ cls: "echo-notes-memory-settings-review-heading" });
		heading.createEl("p", { cls: "echo-notes-memory-settings-eyebrow", text: "下一步" });
		heading.createEl("h2", { text: "审核中心" });
		heading.createEl("p", { text: "先看证据，再决定是否保存。" });
		header.createSpan({
		cls: "echo-notes-memory-settings-review-count",
		text: `${pending.length} 条待审核`
	});

		const filters = this.contentEl.createDiv({
			cls: "echo-notes-memory-settings-review-filters",
			attr: { role: "tablist", "aria-label": "候选层级筛选" }
		});
		this.renderFilter(filters, "all", `全部 ${pending.length}`);
		this.renderFilter(filters, "long_term_candidate", `长期 ${pending.filter((item) => item.admission.recommendation === "long_term_candidate").length}`);
		this.renderFilter(filters, "working_candidate", `工作 ${pending.filter((item) => item.admission.recommendation === "working_candidate").length}`);

		const list = this.contentEl.createDiv({ cls: "echo-notes-memory-settings-review-list" });
		const visible = pending.filter((item) => this.filter === "all" || item.admission.recommendation === this.filter).slice(0, 3);
		if (visible.length === 0) {
			const empty = list.createDiv({ cls: "echo-notes-memory-settings-review-empty" });
			empty.createEl("p", {
				text: pending.length === 0 ? "目前没有待审核候选。" : "当前筛选条件下没有候选。"
			});
			this.renderAction(empty, pending.length === 0 ? "进入审核中心" : "显示全部候选", pending.length === 0 ? "clipboard-check" : "list", pending.length === 0 ? this.callbacks.openCenter : () => {
				this.filter = "all";
				this.renderContent();
			});
		} else {
			for (const item of visible) {
				this.renderItem(list, item);
			}
		}

		const footer = this.contentEl.createDiv({ cls: "echo-notes-memory-settings-review-footer" });
		footer.createEl("p", { text: "审核记录会追加保存，原始候选保持不变。" });
		this.renderAction(footer, "进入审核中心 →", "arrow-right", this.callbacks.openCenter, true);
	}

	private renderFilter(containerEl: HTMLElement, filter: PreviewFilter, label: string): void {
		const button = containerEl.createEl("button", {
			cls: `echo-notes-memory-settings-review-filter${this.filter === filter ? " is-active" : ""}`,
			text: label,
			attr: { type: "button", role: "tab", "aria-selected": String(this.filter === filter) }
		});
		button.addEventListener("click", () => {
			this.filter = filter;
			this.renderContent();
		});
	}

	private renderItem(containerEl: HTMLElement, item: MemoryInboxItem): void {
		const card = containerEl.createDiv({ cls: "echo-notes-memory-settings-review-card" });
		const head = card.createDiv({ cls: "echo-notes-memory-settings-review-card-head" });
		head.createEl("h3", { text: `${item.assertion.subjectName} · ${item.assertion.predicate}` });
		head.createSpan({
			cls: `echo-notes-memory-settings-review-tier ${formatRecommendationTone(item.admission.recommendation)}`,
			text: formatRecommendationShort(item.admission.recommendation)
		});
		card.createEl("p", {
			cls: "echo-notes-memory-settings-review-meta",
			text: `来源：${truncate(item.assertion.sourcePath, 46)} · 评分 ${item.admission.score}/12`
		});

		const evidence = card.createDiv({ cls: "echo-notes-memory-settings-review-evidence" });
		this.renderEvidence(evidence, "AI 候选", item.assertion.value);
		this.renderEvidence(evidence, "原文证据", `“${item.assertion.evidenceQuote}”`);

		const footer = card.createDiv({ cls: "echo-notes-memory-settings-review-card-footer" });
		footer.createSpan({ text: "等待你的决定" });
		const actions = footer.createDiv({ cls: "echo-notes-memory-settings-review-actions" });
		this.renderAction(actions, "批准", "check", () => void this.save(item, "approved"), true, this.savingId === item.assertion.id);
		this.renderAction(actions, "拒绝", "circle-x", () => void this.save(item, "rejected"), false, this.savingId === item.assertion.id);
		const open = card.createEl("button", {
			cls: "echo-notes-memory-settings-review-source",
			text: "打开候选",
			attr: { type: "button" }
		});
		open.addEventListener("click", () => this.callbacks.openCandidate?.(item.candidatePath));
	}

	private renderEvidence(containerEl: HTMLElement, label: string, value: string): void {
		const block = containerEl.createDiv({ cls: "echo-notes-memory-settings-review-evidence-block" });
		block.createSpan({ text: label });
		block.createEl("p", { text: value });
	}

	private renderAction(
		containerEl: HTMLElement,
		label: string,
		icon: string,
		onClick: () => void,
		cta = false,
		disabled = false
	): void {
		const button = containerEl.createEl("button", {
			cls: cta ? "mod-cta" : "",
			attr: { type: "button" }
		});
		button.disabled = disabled;
		setIcon(button, icon);
		button.createSpan({ text: label });
		button.addEventListener("click", onClick);
	}

	private async save(item: MemoryInboxItem, status: MemoryReviewUpdate["status"]): Promise<void> {
		if (this.savingId) return;
		this.savingId = item.assertion.id;
		this.renderContent();
		const update: MemoryReviewUpdate = {
			assertionId: item.assertion.id,
			status,
			effectiveValue: item.assertion.value,
			note: "",
			effectiveTier: item.assertion.proposedTier === "working" ? "working" : "long_term",
			validity: "active"
		};
		try {
			await this.callbacks.save(item.candidatePath, [update]);
			this.context = await this.callbacks.getContext();
			new Notice(status === "approved" ? "已批准候选，原始候选保持不变。" : "已拒绝候选，原始候选仍保留。");
		} catch (error) {
			new Notice(`审核保存失败：${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.savingId = null;
			if (!this.destroyed) this.renderContent();
		}
	}
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

function truncate(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

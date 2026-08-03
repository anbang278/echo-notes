import { App, Modal, Notice, Setting } from "obsidian";
import type {
	MemoryCandidatePackage,
	MemoryReviewPackage,
	MemoryReviewStatus,
	MemoryReviewUpdate
} from "./memory-types";

interface MemoryReviewDraft {
	status: MemoryReviewStatus;
	effectiveValue: string;
	note: string;
}

export class MemoryReviewModal extends Modal {
	private candidate: MemoryCandidatePackage;
	private drafts = new Map<string, MemoryReviewDraft>();
	private onSaveReview: (updates: MemoryReviewUpdate[]) => Promise<void>;
	private submitting = false;

	constructor(
		app: App,
		candidate: MemoryCandidatePackage,
		review: MemoryReviewPackage,
		onSaveReview: (updates: MemoryReviewUpdate[]) => Promise<void>
	) {
		super(app);
		this.candidate = candidate;
		this.onSaveReview = onSaveReview;
		for (const assertion of candidate.assertions) {
			const item = review.reviews[assertion.id];
			this.drafts.set(assertion.id, {
				status: item?.status ?? "pending",
				effectiveValue: item?.effectiveValue ?? assertion.value,
				note: item?.note ?? ""
			});
		}
	}

	onOpen(): void {
		this.setTitle("审核记忆候选");
		this.contentEl.addClass("echo-notes-memory-review-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const counts = this.getDraftCounts();
		this.contentEl.createDiv({
			cls: "echo-notes-memory-review-summary",
			text: `${this.candidate.source.transcriptTitle} · 待审核 ${counts.pending} · 已批准 ${counts.approved} · 已拒绝 ${counts.rejected}`
		});

		const bulkActions = new Setting(this.contentEl).setClass("echo-notes-memory-review-bulk-actions");
		bulkActions.addButton((button) => {
			button.setIcon("check-check").setTooltip("将所有断言设为已批准");
			button.buttonEl.createSpan({ text: "全部批准" });
			button.onClick(() => this.setAllStatuses("approved"));
		});
		bulkActions.addButton((button) => {
			button.setIcon("circle-x").setTooltip("将所有断言设为已拒绝");
			button.buttonEl.createSpan({ text: "全部拒绝" });
			button.onClick(() => this.setAllStatuses("rejected"));
		});

		const list = this.contentEl.createDiv({ cls: "echo-notes-memory-review-list" });
		if (this.candidate.assertions.length === 0) {
			list.createDiv({ cls: "echo-notes-memory-review-empty", text: "当前候选包没有断言。" });
		}
		for (const assertion of this.candidate.assertions) {
			const draft = this.drafts.get(assertion.id);
			if (!draft) {
				continue;
			}
			const item = list.createDiv({ cls: "echo-notes-memory-review-item" });
			item.createEl("h3", {
				cls: "echo-notes-memory-review-item-title",
				text: `${assertion.subjectName} · ${assertion.predicate}`
			});
			item.createDiv({
				cls: "echo-notes-memory-review-item-meta",
				text: `${assertion.subjectType} · ${assertion.category} · 置信度 ${assertion.confidence.toFixed(2)}`
			});
			item.createEl("blockquote", {
				cls: "echo-notes-memory-review-evidence",
				text: assertion.evidenceQuote
			});

			new Setting(item)
				.setName("审核状态")
				.addDropdown((dropdown) => dropdown
					.addOptions({ pending: "待审核", approved: "已批准", rejected: "已拒绝" })
					.setValue(draft.status)
					.onChange((value) => {
						draft.status = value as MemoryReviewStatus;
					}));
			new Setting(item)
				.setName("生效内容")
				.addTextArea((text) => {
					text.inputEl.rows = 3;
					return text.setValue(draft.effectiveValue).onChange((value) => {
						draft.effectiveValue = value;
					});
				});
			new Setting(item)
				.setName("审核备注")
				.addTextArea((text) => {
					text.inputEl.rows = 2;
					return text.setPlaceholder("可选").setValue(draft.note).onChange((value) => {
						draft.note = value;
					});
				});
		}

		const actions = new Setting(this.contentEl).setClass("echo-notes-memory-review-actions");
		actions.addButton((button) => {
			button.setIcon("x").setTooltip("取消审核编辑").setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "取消" });
			button.onClick(() => this.close());
		});
		actions.addButton((button) => {
			button.setIcon("save").setTooltip("保存审核状态与事件历史").setCta().setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: "保存审核" });
			button.onClick(async () => {
				if (this.submitting) {
					return;
				}
				const updates = this.buildUpdates();
				if (updates.some((update) => !update.effectiveValue.trim())) {
					new Notice("每条断言的生效内容都不能为空。");
					return;
				}
				this.submitting = true;
				this.render();
				try {
					await this.onSaveReview(updates);
					this.close();
				} catch (error) {
					this.submitting = false;
					this.render();
					new Notice(`候选审核操作未完成：${error instanceof Error ? error.message : String(error)}`);
				}
			});
		});
	}

	private setAllStatuses(status: MemoryReviewStatus): void {
		for (const draft of this.drafts.values()) {
			draft.status = status;
		}
		this.render();
	}

	private buildUpdates(): MemoryReviewUpdate[] {
		return this.candidate.assertions.map((assertion) => {
			const draft = this.drafts.get(assertion.id);
			if (!draft) {
				throw new Error(`缺少断言审核状态：${assertion.id}`);
			}
			return { assertionId: assertion.id, ...draft };
		});
	}

	private getDraftCounts(): Record<MemoryReviewStatus, number> {
		const counts: Record<MemoryReviewStatus, number> = { pending: 0, approved: 0, rejected: 0 };
		for (const draft of this.drafts.values()) {
			counts[draft.status] += 1;
		}
		return counts;
	}
}

import { App, Modal, Notice, Setting } from "obsidian";
import {
	MEMORY_RELATION_TYPE_LABELS,
	type MemoryRelationEndpoint,
	type MemoryRelationType
} from "./memory-relation";
import type { MemoryRelationSuggestion } from "./relations/memory-relation-suggestion";

interface MemoryRelationSuggestionModalCallbacks {
	onConfirm: (input: {
		type: MemoryRelationType;
		source: MemoryRelationEndpoint;
		target: MemoryRelationEndpoint;
		note: string;
	}) => Promise<void>;
}

export class MemoryRelationSuggestionModal extends Modal {
	private suggestions: MemoryRelationSuggestion[];
	private callbacks: MemoryRelationSuggestionModalCallbacks;
	private selectedTypes = new Map<MemoryRelationSuggestion, MemoryRelationType>();
	private submitting = false;

	constructor(
		app: App,
		suggestions: MemoryRelationSuggestion[],
		callbacks: MemoryRelationSuggestionModalCallbacks
	) {
		super(app);
		this.suggestions = suggestions;
		this.callbacks = callbacks;
	}

	onOpen(): void {
		this.setTitle("发现可能相关的记忆");
		this.contentEl.addClass("echo-notes-memory-relation-suggestion-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		if (this.suggestions.length === 0) {
			this.contentEl.createDiv({
				cls: "echo-notes-memory-relation-suggestion-empty",
				text: "没有发现可能相关的历史记忆。"
			});
			return;
		}
		this.contentEl.createDiv({
			cls: "echo-notes-memory-relation-suggestion-summary",
			text: `发现 ${this.suggestions.length} 条可能的关系；先选择关系类型，再逐条确认。默认不会自动建立关系。`
		});
		const list = this.contentEl.createDiv({ cls: "echo-notes-memory-relation-suggestion-list" });
		for (const suggestion of this.suggestions) {
			const item = list.createDiv({ cls: "echo-notes-memory-relation-suggestion-item" });
			item.createEl("h4", {
				text: `${formatKind(suggestion.kind)}：${suggestion.target.predicate}：${truncate(suggestion.target.effectiveValue, 90)}`
			});
			item.createDiv({ text: suggestion.reason });
			if (suggestion.authorityHint) {
				item.createDiv({ text: "系统判断其中一条可能更权威，但不会自动替你升级或覆盖。" });
			}
			const actions = new Setting(item).setClass("echo-notes-memory-relation-suggestion-actions");
			actions.addButton((button) => {
				button.setIcon("circle-minus").setDisabled(this.submitting);
				button.buttonEl.createSpan({ text: "忽略本次" });
				button.onClick(() => {
					this.selectedTypes.delete(suggestion);
					this.suggestions = this.suggestions.filter((entry) => entry !== suggestion);
					this.render();
				});
			});
			for (const type of suggestion.suggestedTypes) {
				actions.addButton((button) => {
					const selected = this.selectedTypes.get(suggestion) === type;
					button.setIcon("link-2").setDisabled(this.submitting);
					button.buttonEl.toggleClass("is-selected", selected);
					button.buttonEl.setAttribute("aria-pressed", String(selected));
					button.buttonEl.createSpan({ text: MEMORY_RELATION_TYPE_LABELS[type] });
					button.onClick(() => {
						this.selectedTypes.set(suggestion, type);
						this.render();
					});
				});
			}
			const selectedType = this.selectedTypes.get(suggestion);
			actions.addButton((button) => {
				button.setIcon("check").setCta().setDisabled(this.submitting || !selectedType);
				button.buttonEl.createSpan({ text: "确认这条关系" });
				button.onClick(() => {
					if (selectedType) void this.confirm(selectedType, suggestion);
				});
			});
		}
	}

	private async confirm(
		type: MemoryRelationType,
		suggestion: MemoryRelationSuggestion
	): Promise<void> {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		this.render();
		try {
			await this.callbacks.onConfirm({
				type,
				source: suggestion.source,
				target: suggestion.target,
				note: suggestion.reason
			});
			this.suggestions = this.suggestions.filter((item) => item !== suggestion);
		} catch (error) {
			new Notice(`记忆关系未确认：${getErrorMessage(error)}`);
		} finally {
			this.submitting = false;
			this.render();
		}
	}
}

function formatKind(kind: MemoryRelationSuggestion["kind"]): string {
	switch (kind) {
		case "repeated_evidence":
			return "重复证据";
		case "potential_conflict":
			return "潜在变化";
		case "time_order":
			return "时间先后";
		default:
			return kind;
	}
}

function truncate(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

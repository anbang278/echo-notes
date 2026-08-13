import { App, Modal, Notice, Setting } from "obsidian";
import type { TranscriptionHotwordWeight } from "../providers/transcription-provider";
import {
	getEffectiveTranscriptionTermText,
	type TranscriptionEnhancementScope,
	type TranscriptionEnhancementScopeType,
	type TranscriptionEnhancementStatus,
	type TranscriptionEnhancementStore,
	type TranscriptionEnhancementTerm
} from "./memory-transcription-enhancement";

interface TranscriptionEnhancementManagerOptions {
	store: TranscriptionEnhancementStore;
	onSave: (store: TranscriptionEnhancementStore) => Promise<void>;
	onOpenManualFile: () => Promise<void>;
	onOpenCandidateFile: () => Promise<void>;
	onOpenSource: (path: string) => Promise<void>;
}

const STATUS_OPTIONS: Record<TranscriptionEnhancementStatus, string> = {
	pending: "待审核",
	approved: "已批准",
	rejected: "已拒绝",
	disabled: "已禁用"
};

const SCOPE_OPTIONS: Record<TranscriptionEnhancementScopeType, string> = {
	global: "全局",
	project: "项目",
	person: "人物",
	organization: "组织"
};

export class TranscriptionEnhancementManagerModal extends Modal {
	private readonly options: TranscriptionEnhancementManagerOptions;
	private readonly terms: TranscriptionEnhancementTerm[];
	private filter: TranscriptionEnhancementStatus = "pending";
	private saving = false;

	constructor(app: App, options: TranscriptionEnhancementManagerOptions) {
		super(app);
		this.options = options;
		this.terms = Object.values(options.store.terms)
			.filter((term) => term.source === "memory")
			.map(cloneTerm);
	}

	onOpen(): void {
		this.modalEl.addClass("echo-notes-transcription-candidate-review-modal");
		this.setTitle("AI 术语候选审核");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: "这里只审核 AI 候选。人工术语和固定 prompt 请在 Markdown 配置文件中维护。",
			cls: "echo-notes-candidate-review-intro"
		});
		this.renderFilters();

		const visibleTerms = this.terms.filter((term) => term.status === this.filter);
		const list = this.contentEl.createDiv({ cls: "echo-notes-candidate-review-list" });
		list.setAttr("aria-live", "polite");
		if (visibleTerms.length === 0) {
			const empty = list.createDiv({ cls: "echo-notes-candidate-review-empty" });
			empty.createEl("strong", { text: `暂无${STATUS_OPTIONS[this.filter]}候选` });
			empty.createEl("p", { text: "可从 Echo Memory 的已批准记忆中生成新候选。" });
		}
		for (const term of visibleTerms) this.renderTerm(list, term);
		this.renderFooter();
	}

	private renderFilters(): void {
		const tabs = this.contentEl.createDiv({ cls: "echo-notes-candidate-review-tabs" });
		tabs.setAttr("role", "tablist");
		for (const status of Object.keys(STATUS_OPTIONS) as TranscriptionEnhancementStatus[]) {
			const count = this.terms.filter((term) => term.status === status).length;
			const button = tabs.createEl("button", {
				text: `${STATUS_OPTIONS[status]} ${count}`,
				cls: status === this.filter ? "is-active" : ""
			});
			button.setAttr("type", "button");
			button.setAttr("role", "tab");
			button.setAttr("aria-selected", String(status === this.filter));
			button.addEventListener("click", () => {
				this.filter = status;
				this.render();
			});
		}
	}

	private renderTerm(container: HTMLElement, term: TranscriptionEnhancementTerm): void {
		const card = container.createDiv({ cls: "echo-notes-candidate-review-card" });
		const header = card.createDiv({ cls: "echo-notes-candidate-review-card-header" });
		const identity = header.createDiv();
		identity.createEl("strong", { text: term.text });
		identity.createSpan({ text: `候选词 · ${formatScope(term.scope)}` });
		header.createSpan({
			text: STATUS_OPTIONS[term.status],
			cls: `echo-notes-candidate-review-status is-${term.status}`
		});

		if (term.evidence) card.createEl("p", { text: `依据：${term.evidence}`, cls: "echo-notes-candidate-review-evidence" });
		if (term.backlink) {
			const source = card.createEl("button", { text: "打开来源与审核记录", cls: "echo-notes-candidate-review-source" });
			source.setAttr("type", "button");
			source.setAttr("aria-label", `打开 ${term.text} 的来源与审核记录`);
			source.addEventListener("click", () => void this.options.onOpenSource(term.backlink!));
		}

		const fields = card.createDiv({ cls: "echo-notes-candidate-review-fields" });
		new Setting(fields)
			.setName("生效词")
			.setDesc("审核时可修正，保留原候选词用于审计。")
			.addText((text) => text
				.setValue(getEffectiveTranscriptionTermText(term))
				.setPlaceholder("输入最终生效词")
				.onChange((value) => { term.effectiveText = value; }));
		new Setting(fields)
			.setName("权重")
			.setDesc("普通术语建议保持 3，50 仅用于极高优先级。")
			.addDropdown((dropdown) => dropdown
				.addOptions({ "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "50": "50" })
				.setValue(String(term.weight))
				.onChange((value) => { term.weight = Number(value) as TranscriptionHotwordWeight; }));
		this.renderScopeSetting(fields, term.scope);

		const actions = card.createDiv({ cls: "echo-notes-candidate-review-actions" });
		const reject = actions.createEl("button", { text: "拒绝" });
		reject.setAttr("type", "button");
		reject.setAttr("aria-label", `拒绝候选 ${term.text}`);
		reject.addEventListener("click", () => {
			term.status = "rejected";
			this.render();
		});
		const approve = actions.createEl("button", { text: term.status === "approved" ? "保持批准" : "批准", cls: "mod-cta" });
		approve.setAttr("type", "button");
		approve.setAttr("aria-label", `批准候选 ${term.text}`);
		approve.addEventListener("click", () => {
			term.status = "approved";
			this.render();
		});
	}

	private renderScopeSetting(container: HTMLElement, scope: TranscriptionEnhancementScope): void {
		const setting = new Setting(container).setName("作用域");
		setting.addDropdown((dropdown) => dropdown
			.addOptions(SCOPE_OPTIONS)
			.setValue(scope.type)
			.onChange((value) => {
				scope.type = value as TranscriptionEnhancementScopeType;
				if (scope.type === "global") delete scope.value;
				else scope.value ??= "";
				this.render();
			}));
		if (scope.type !== "global") {
			setting.addText((text) => text
				.setPlaceholder("作用域名称")
				.setValue(scope.value ?? "")
				.onChange((value) => { scope.value = value; }));
		}
	}

	private renderFooter(): void {
		const footer = new Setting(this.contentEl);
		footer.settingEl.addClass("echo-notes-candidate-review-footer");
		footer.addButton((button) => button.setButtonText("打开人工配置").onClick(() => void this.options.onOpenManualFile()));
		footer.addButton((button) => button.setButtonText("打开候选文件").onClick(() => void this.options.onOpenCandidateFile()));
		footer.addButton((button) => button
			.setButtonText(this.saving ? "正在保存…" : "保存审核")
			.setCta()
			.setDisabled(this.saving)
			.onClick(() => void this.save()));
	}

	private async save(): Promise<void> {
		if (this.saving) return;
		const invalid = this.terms.find((term) =>
			!getEffectiveTranscriptionTermText(term) || (term.scope.type !== "global" && !term.scope.value?.trim())
		);
		if (invalid) {
			new Notice("请补全生效词和非全局作用域名称。");
			return;
		}
		this.saving = true;
		this.render();
		try {
			const at = new Date().toISOString();
			const terms = Object.fromEntries(this.terms.map((draft) => {
				const previous = this.options.store.terms[draft.id];
				const term = finalizeTerm(draft, previous, at);
				return [term.id, term];
			}));
			await this.options.onSave({ ...this.options.store, updatedAt: at, terms, prompts: {} });
			new Notice("AI 术语候选审核已保存。");
			this.close();
		} catch (error) {
			new Notice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
			this.saving = false;
			this.render();
		}
	}
}

function finalizeTerm(
	draft: TranscriptionEnhancementTerm,
	previous: TranscriptionEnhancementTerm | undefined,
	at: string
): TranscriptionEnhancementTerm {
	const normalized: TranscriptionEnhancementTerm = {
		...draft,
		text: draft.text.trim(),
		effectiveText: getEffectiveTranscriptionTermText(draft),
		scope: draft.scope.type === "global" ? { type: "global" } : { type: draft.scope.type, value: draft.scope.value?.trim() },
		updatedAt: at,
		history: [...(previous?.history ?? [])]
	};
	const changed = !previous || JSON.stringify({ ...normalized, history: [], updatedAt: "", approvedAt: undefined }) !==
		JSON.stringify({ ...previous, history: [], updatedAt: "", approvedAt: undefined });
	if (!changed) return previous;
	normalized.history.push({ at, status: normalized.status, note: "用户审核或修正 AI 术语候选" });
	if (normalized.status === "approved" && previous?.status !== "approved") normalized.approvedAt = at;
	return normalized;
}

function formatScope(scope: TranscriptionEnhancementScope): string {
	return scope.type === "global" ? "全局" : `${SCOPE_OPTIONS[scope.type]}：${scope.value ?? ""}`;
}

function cloneTerm(term: TranscriptionEnhancementTerm): TranscriptionEnhancementTerm {
	return { ...term, scope: { ...term.scope }, history: term.history.map((event) => ({ ...event })) };
}

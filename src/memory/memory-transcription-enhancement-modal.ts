import { App, Modal, Notice, Setting } from "obsidian";
import type { TranscriptionHotwordWeight } from "../providers/transcription-provider";
import {
	TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS,
	type TranscriptionEnhancementPrompt,
	type TranscriptionEnhancementScope,
	type TranscriptionEnhancementScopeType,
	type TranscriptionEnhancementStatus,
	type TranscriptionEnhancementStore,
	type TranscriptionEnhancementTerm
} from "./memory-transcription-enhancement";

interface TranscriptionEnhancementManagerOptions {
	store: TranscriptionEnhancementStore;
	onSave: (store: TranscriptionEnhancementStore) => Promise<void>;
	onOpenFile: () => Promise<void>;
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
	private terms: TranscriptionEnhancementTerm[];
	private prompts: TranscriptionEnhancementPrompt[];
	private saving = false;

	constructor(app: App, options: TranscriptionEnhancementManagerOptions) {
		super(app);
		this.options = options;
		this.terms = Object.values(options.store.terms).map(cloneTerm);
		this.prompts = Object.values(options.store.prompts).map(clonePrompt);
	}

	onOpen(): void {
		this.setTitle("术语与转写增强");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", {
			text: "只有已批准且与来源笔记作用域匹配的内容会进入转写请求；关闭“使用 Echo Memory 转写增强”时不会外发任何内容。"
		});

		const termHeading = this.contentEl.createEl("h3", { text: "原生热词" });
		termHeading.tabIndex = -1;
		if (this.terms.length === 0) {
			this.contentEl.createEl("p", { text: "暂无术语。", cls: "setting-item-description" });
		}
		for (const term of this.terms) {
			this.renderTerm(term);
		}
		new Setting(this.contentEl)
			.setName("新增术语")
			.setDesc("手工词条只有在点击底部“保存更改”后才会生效。")
			.addButton((button) => button.setButtonText("添加").onClick(() => {
				this.terms.push(createTermDraft());
				this.render();
			}));

		this.contentEl.createEl("h3", { text: "固定提示词" });
		if (this.prompts.length === 0) {
			this.contentEl.createEl("p", { text: "暂无固定提示词。", cls: "setting-item-description" });
		}
		for (const prompt of this.prompts) {
			this.renderPrompt(prompt);
		}
		new Setting(this.contentEl)
			.setName("新增固定提示词")
			.setDesc(`固定 Prompt 优先于已批准记忆组装；最终上下文总计不超过 ${TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS} 字符。`)
			.addButton((button) => button.setButtonText("添加").onClick(() => {
				this.prompts.push(createPromptDraft());
				this.render();
			}));

		const footer = new Setting(this.contentEl);
		footer.addButton((button) => button.setButtonText("打开审计文件").onClick(async () => {
			await this.options.onOpenFile();
		}));
		footer.addButton((button) => button
			.setButtonText(this.saving ? "正在保存…" : "保存更改")
			.setCta()
			.setDisabled(this.saving)
			.onClick(() => void this.save()));
	}

	private renderTerm(term: TranscriptionEnhancementTerm): void {
		const group = this.contentEl.createDiv({ cls: "echo-notes-settings-advanced" });
		new Setting(group)
			.setName(term.source === "manual" ? "手工术语" : "记忆候选术语")
			.setDesc(term.evidence ? `依据：${term.evidence}` : "正文不会写入诊断日志。")
			.addText((text) => text
				.setPlaceholder("规范词")
				.setValue(term.text)
				.onChange((value) => { term.text = value; }))
			.addDropdown((dropdown) => dropdown
				.addOptions({ "1": "权重 1", "2": "权重 2", "3": "权重 3", "4": "权重 4", "5": "权重 5", "50": "权重 50" })
				.setValue(String(term.weight))
				.onChange((value) => { term.weight = Number(value) as TranscriptionHotwordWeight; }));
		this.renderScopeSetting(group, term.scope, () => this.render());
		new Setting(group)
			.setName("状态")
			.setDesc("待审核、拒绝或禁用状态不会进入请求。")
			.addDropdown((dropdown) => dropdown
				.addOptions(STATUS_OPTIONS)
				.setValue(term.status)
				.onChange((value) => { term.status = value as TranscriptionEnhancementStatus; }));
	}

	private renderPrompt(prompt: TranscriptionEnhancementPrompt): void {
		const group = this.contentEl.createDiv({ cls: "echo-notes-settings-advanced" });
		new Setting(group)
			.setName("Prompt 内容")
			.setDesc(`${prompt.text.length}/${TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS} 字符`)
			.addTextArea((text) => text
				.setPlaceholder("例如：本次音频是产品评审会议，请保留中英文术语。")
				.setValue(prompt.text)
				.onChange((value) => { prompt.text = value; }));
		this.renderScopeSetting(group, prompt.scope, () => this.render());
		new Setting(group)
			.setName("状态")
			.addDropdown((dropdown) => dropdown
				.addOptions(STATUS_OPTIONS)
				.setValue(prompt.status)
				.onChange((value) => { prompt.status = value as TranscriptionEnhancementStatus; }));
	}

	private renderScopeSetting(
		container: HTMLElement,
		scope: TranscriptionEnhancementScope,
		onTypeChange: () => void
	): void {
		const setting = new Setting(container)
			.setName("作用域")
			.addDropdown((dropdown) => dropdown
				.addOptions(SCOPE_OPTIONS)
				.setValue(scope.type)
				.onChange((value) => {
					scope.type = value as TranscriptionEnhancementScopeType;
					if (scope.type === "global") {
						delete scope.value;
					} else {
						scope.value ??= "";
					}
					onTypeChange();
				}));
		if (scope.type !== "global") {
			setting.addText((text) => text
				.setPlaceholder("作用域名称")
				.setValue(scope.value ?? "")
				.onChange((value) => { scope.value = value; }));
		}
	}

	private async save(): Promise<void> {
		if (this.saving) {
			return;
		}
		const invalidTerm = this.terms.find((term) => !term.text.trim() || (term.scope.type !== "global" && !term.scope.value?.trim()));
		const invalidPrompt = this.prompts.find((prompt) =>
			!prompt.text.trim() ||
			prompt.text.trim().length > TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS ||
			(prompt.scope.type !== "global" && !prompt.scope.value?.trim())
		);
		if (invalidTerm || invalidPrompt) {
			new Notice(`请补全术语、Prompt 和非全局作用域名称；单条 Prompt 不得超过 ${TRANSCRIPTION_ENHANCEMENT_MAX_CONTEXT_CHARACTERS} 字符。`);
			return;
		}
		this.saving = true;
		this.render();
		try {
			const at = new Date().toISOString();
			const terms = Object.fromEntries(this.terms.map((draft) => {
				const previous = this.options.store.terms[draft.id];
				const term = finalizeRecord(draft, previous, at);
				return [term.id, term];
			}));
			const prompts = Object.fromEntries(this.prompts.map((draft) => {
				const previous = this.options.store.prompts[draft.id];
				const prompt = finalizeRecord(draft, previous, at);
				return [prompt.id, prompt];
			}));
			await this.options.onSave({
				...this.options.store,
				updatedAt: at,
				terms,
				prompts
			});
			new Notice("术语与转写增强已保存。");
			this.close();
		} catch (error) {
			new Notice(`保存失败：${error instanceof Error ? error.message : String(error)}`);
			this.saving = false;
			this.render();
		}
	}
}

function finalizeRecord<T extends TranscriptionEnhancementTerm | TranscriptionEnhancementPrompt>(
	draft: T,
	previous: T | undefined,
	at: string
): T {
	const changed = !previous || JSON.stringify({ ...draft, history: [], updatedAt: "", approvedAt: undefined }) !==
		JSON.stringify({ ...previous, history: [], updatedAt: "", approvedAt: undefined });
	if (!changed) {
		return previous;
	}
	const result = {
		...draft,
		text: draft.text.trim(),
		scope: draft.scope.type === "global"
			? { type: "global" as const }
			: { type: draft.scope.type, value: draft.scope.value?.trim() },
		updatedAt: at,
		history: [
			...(previous?.history ?? []),
			{ at, status: draft.status, note: previous ? "用户保存修改" : "用户创建并保存" }
		]
	} as T;
	if ("source" in result) {
		const previousApprovedAt = previous && "approvedAt" in previous ? previous.approvedAt : undefined;
		result.approvedAt = draft.status === "approved" ? at : previousApprovedAt;
	}
	return result;
}

function createTermDraft(): TranscriptionEnhancementTerm {
	const at = new Date().toISOString();
	return {
		id: createId("term"),
		text: "",
		weight: 3,
		scope: { type: "global" },
		source: "manual",
		status: "approved",
		updatedAt: at,
		history: []
	};
}

function createPromptDraft(): TranscriptionEnhancementPrompt {
	const at = new Date().toISOString();
	return {
		id: createId("prompt"),
		text: "",
		scope: { type: "global" },
		status: "approved",
		updatedAt: at,
		history: []
	};
}

function createId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneTerm(term: TranscriptionEnhancementTerm): TranscriptionEnhancementTerm {
	return { ...term, scope: { ...term.scope }, history: term.history.map((event) => ({ ...event })) };
}

function clonePrompt(prompt: TranscriptionEnhancementPrompt): TranscriptionEnhancementPrompt {
	return { ...prompt, scope: { ...prompt.scope }, history: prompt.history.map((event) => ({ ...event })) };
}

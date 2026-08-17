import { App, Modal, Notice, Setting } from "obsidian";
import {
	MEMORY_CONTEXT_MAX_CHARACTERS,
	MEMORY_CONTEXT_MIN_CHARACTERS,
	buildMemoryContextPackagePreview,
	createDefaultMemoryContextFilterOptions,
	type MemoryContextFilterChoices,
	type MemoryContextFilterOptions,
	type MemoryContextPackagePreview
} from "./memory-context";
import type { MemoryAggregationEntry } from "./memory-aggregation";
import {
	MEMORY_CONTEXT_PURPOSES,
	MEMORY_PROPOSED_TIERS,
	MEMORY_TYPES,
	formatProposedTier,
	formatMemoryType,
	type ContextPurpose,
	type ProposedMemoryTier,
	type MemoryType
} from "./memory-types";

interface MemoryContextModalCallbacks {
	onGenerate: (options: MemoryContextFilterOptions) => Promise<void>;
}

export class MemoryContextModal extends Modal {
	private entries: readonly MemoryAggregationEntry[];
	private choices: MemoryContextFilterChoices;
	private language: "zh" | "en";
	private callbacks: MemoryContextModalCallbacks;
	private options = createDefaultMemoryContextFilterOptions();
	private selectedMemoryTypes = new Set<MemoryType>();
	private selectedProposedTiers = new Set<ProposedMemoryTier>();
	private preview: MemoryContextPackagePreview;
	private submitting = false;

	constructor(
		app: App,
		entries: readonly MemoryAggregationEntry[],
		choices: MemoryContextFilterChoices,
		language: "zh" | "en",
		callbacks: MemoryContextModalCallbacks
	) {
		super(app);
		this.entries = entries;
		this.choices = choices;
		this.language = language;
		this.callbacks = callbacks;
		this.preview = this.buildPreview();
	}

	onOpen(): void {
		this.setTitle("生成个人上下文包");
		this.contentEl.addClass("echo-notes-memory-context-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const editor = this.contentEl.createDiv({ cls: "echo-notes-memory-context-editor" });
		editor.createEl("h3", { text: "筛选范围" });
		new Setting(editor)
			.setName("项目")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "不限项目");
				for (const project of this.choices.projects) {
					dropdown.addOption(project, project);
				}
				return dropdown.setValue(this.options.project).onChange((value) => {
					this.options.project = value;
					this.refreshPreview();
				});
			});
		new Setting(editor)
			.setName("人物")
			.addDropdown((dropdown) => {
				dropdown.addOption("", "不限人物");
				for (const person of this.choices.people) {
					dropdown.addOption(person, person);
				}
				return dropdown.setValue(this.options.person).onChange((value) => {
					this.options.person = value;
					this.refreshPreview();
				});
			});
		new Setting(editor)
			.setName("开始日期")
			.addText((text) => {
				text.inputEl.type = "date";
				return text.setValue(this.options.startDate).onChange((value) => {
					this.options.startDate = value;
					this.refreshPreview();
				});
			});
		new Setting(editor)
			.setName("结束日期")
			.addText((text) => {
				text.inputEl.type = "date";
				return text.setValue(this.options.endDate).onChange((value) => {
					this.options.endDate = value;
					this.refreshPreview();
				});
			});
		new Setting(editor)
			.setName("字符预算")
			.addText((text) => {
				text.inputEl.type = "number";
				text.inputEl.min = String(MEMORY_CONTEXT_MIN_CHARACTERS);
				text.inputEl.max = String(MEMORY_CONTEXT_MAX_CHARACTERS);
				text.inputEl.step = "1000";
				return text.setValue(String(this.options.maxCharacters)).onChange((value) => {
					const parsed = Number(value);
					if (Number.isFinite(parsed)) {
						this.options.maxCharacters = parsed;
						this.refreshPreview();
					}
				});
			});
		editor.createEl("p", {
			cls: "echo-notes-memory-context-helper",
			text: `字符预算控制上下文包大小（${MEMORY_CONTEXT_MIN_CHARACTERS.toLocaleString()}–${MEMORY_CONTEXT_MAX_CHARACTERS.toLocaleString()} 字符）；预算越小，省略的记忆越多。`
		});
		editor.createEl("h3", { text: "记忆内容" });
		this.renderMemoryTypeFilter(editor);
		this.renderProposedTierFilter(editor);
		editor.createEl("h3", { text: "输出用途" });
		new Setting(editor)
			.setName("用途")
			.addDropdown((dropdown) => {
				for (const purpose of MEMORY_CONTEXT_PURPOSES) {
					dropdown.addOption(purpose, formatPurpose(purpose, this.language));
				}
				return dropdown
					.setValue(this.options.purpose ?? "general")
					.onChange((value) => {
						this.options.purpose = value as ContextPurpose;
						this.refreshPreview();
					});
			});

		const summary = this.contentEl.createDiv({ cls: "echo-notes-memory-context-summary" });
		summary.setText(
			`匹配 ${this.preview.matchingCount} · 纳入 ${this.preview.includedCount} · 预算省略 ${this.preview.omittedCount} · ${this.preview.managedBlock.length}/${this.preview.options.maxCharacters} 字符`
		);
		if (this.preview.matchingCount === 0) {
			summary.createEl("p", {
				cls: "echo-notes-memory-context-empty-hint",
				text: "当前筛选没有匹配的已批准记忆，可调整项目、人物、日期或记忆类型。"
			});
		}
		const previewDetails = this.contentEl.createEl("details", { cls: "echo-notes-memory-context-preview-details" });
		previewDetails.createEl("summary", { text: "查看生成内容预览" });
		previewDetails.createEl("pre", {
			cls: "echo-notes-memory-context-preview",
			text: stripManagedMarkers(this.preview.managedBlock)
		});
		const actions = this.contentEl.createDiv({ cls: "echo-notes-memory-context-actions" });
		new Setting(actions).addButton((button) => {
			button.setIcon("file-plus-2").setTooltip("生成上下文包").setDisabled(this.submitting);
			button.buttonEl.createSpan({ text: this.submitting ? "正在生成" : "生成上下文包" });
			button.onClick(() => void this.generate());
		});
	}

	private refreshPreview(): void {
		try {
			this.preview = this.buildPreview();
			this.render();
		} catch (error) {
			new Notice(getErrorMessage(error));
		}
	}

	private buildPreview(): MemoryContextPackagePreview {
		return buildMemoryContextPackagePreview(this.entries, this.options, this.language);
	}

	private renderMemoryTypeFilter(editor: HTMLElement): void {
		this.addCheckboxFilter(
			editor,
			this.language === "en" ? "Memory types" : "记忆类型",
			MEMORY_TYPES.map((type) => ({ value: type, label: formatMemoryType(type, this.language) })),
			this.selectedMemoryTypes,
			() => {
				this.options.memoryTypes = this.selectedMemoryTypes.size === MEMORY_TYPES.length
					? []
					: [...this.selectedMemoryTypes];
				this.refreshPreview();
			},
			"全部"
		);
	}

	private renderProposedTierFilter(editor: HTMLElement): void {
		this.addCheckboxFilter(
			editor,
			this.language === "en" ? "Memory horizon" : "记忆时效",
			MEMORY_PROPOSED_TIERS.map((horizon) => ({ value: horizon, label: formatProposedTier(horizon, this.language) })),
			this.selectedProposedTiers,
			() => {
				this.options.proposedTiers = this.selectedProposedTiers.size === MEMORY_PROPOSED_TIERS.length
					? []
					: [...this.selectedProposedTiers];
				this.refreshPreview();
			},
			"全部"
		);
	}

	private addCheckboxFilter<T extends string>(
		container: HTMLElement,
		label: string,
		options: Array<{ value: T; label: string }>,
		selected: Set<T>,
		onChange: () => void,
		allLabel: string
	): void {
		const setting = new Setting(container).setName(label);
		const group = setting.controlEl.createDiv({ cls: "echo-notes-memory-context-checkbox-group" });
		const allWrapper = group.createEl("label", { cls: "echo-notes-memory-context-checkbox is-all" });
		const allCheckbox = allWrapper.createEl("input", { type: "checkbox" });
		allCheckbox.checked = selected.size === 0;
		allCheckbox.setAttribute("aria-label", `${label}：${allLabel}`);
		allCheckbox.addEventListener("change", () => {
			if (allCheckbox.checked) {
				selected.clear();
			} else {
				for (const option of options) selected.add(option.value);
			}
			onChange();
		});
		allWrapper.createSpan({ text: allLabel });
		for (const option of options) {
			const wrapper = group.createEl("label", { cls: "echo-notes-memory-context-checkbox" });
			const checkbox = wrapper.createEl("input", { type: "checkbox" });
			checkbox.checked = selected.has(option.value);
			checkbox.addEventListener("change", () => {
				if (checkbox.checked) {
					selected.add(option.value);
				} else {
					selected.delete(option.value);
				}
				onChange();
			});
			wrapper.createSpan({ text: option.label });
		}
	}

	private async generate(): Promise<void> {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		this.render();
		try {
			await this.callbacks.onGenerate({ ...this.options });
			this.close();
		} catch (error) {
			new Notice(`上下文包未生成：${getErrorMessage(error)}`);
		} finally {
			this.submitting = false;
			if (this.containerEl.isConnected) {
				this.render();
			}
		}
	}
}

function stripManagedMarkers(value: string): string {
	return value
		.replace("<!-- echo-memory-context:managed:start -->\n", "")
		.replace("\n<!-- echo-memory-context:managed:end -->", "");
}

function formatPurpose(value: ContextPurpose, language: "zh" | "en"): string {
	if (language === "en") {
		switch (value) {
			case "planning":
				return "Planning";
			case "decision":
				return "Decision";
			case "retrospective":
				return "Retrospective";
			case "self_profile":
				return "Self profile";
			default:
				return "General";
		}
	}
	switch (value) {
		case "planning":
			return "规划";
		case "decision":
			return "决策";
		case "retrospective":
			return "复盘";
		case "self_profile":
			return "自我画像";
		default:
			return "通用";
	}
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

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

interface MemoryContextModalCallbacks {
	onGenerate: (options: MemoryContextFilterOptions) => Promise<void>;
}

export class MemoryContextModal extends Modal {
	private entries: readonly MemoryAggregationEntry[];
	private choices: MemoryContextFilterChoices;
	private language: "zh" | "en";
	private callbacks: MemoryContextModalCallbacks;
	private options = createDefaultMemoryContextFilterOptions();
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
		this.setTitle("预览 personal agent 上下文");
		this.contentEl.addClass("echo-notes-memory-context-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const editor = this.contentEl.createDiv({ cls: "echo-notes-memory-context-editor" });
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

		const summary = this.contentEl.createDiv({ cls: "echo-notes-memory-context-summary" });
		summary.setText(
			`匹配 ${this.preview.matchingCount} · 纳入 ${this.preview.includedCount} · 预算省略 ${this.preview.omittedCount} · ${this.preview.managedBlock.length}/${this.preview.options.maxCharacters} 字符`
		);
		this.contentEl.createEl("pre", {
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

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

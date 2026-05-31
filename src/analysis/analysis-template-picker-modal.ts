import { App, Modal, Setting } from "obsidian";
import type { AnalysisTemplateConfig } from "../settings/settings";

export class AnalysisTemplatePickerModal extends Modal {
	private templates: AnalysisTemplateConfig[];
	private onChoose: (template: AnalysisTemplateConfig | null) => void;
	private selectedTemplateId: string;
	private emptyChoiceLabel: string;
	private resolved = false;

	constructor(
		app: App,
		templates: AnalysisTemplateConfig[],
		onChoose: (template: AnalysisTemplateConfig | null) => void,
		emptyChoiceLabel = "取消"
	) {
		super(app);
		this.templates = templates;
		this.onChoose = onChoose;
		this.selectedTemplateId = templates[0]?.id ?? "";
		this.emptyChoiceLabel = emptyChoiceLabel;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("选择 AI 纪要分析模板");
		contentEl.empty();

		if (this.templates.length === 0) {
			contentEl.createEl("p", { text: "没有启用的分析模板。请先在 Echo Notes 设置中启用或新增模板。" });
			new Setting(contentEl).addButton((button) =>
				button
					.setButtonText("关闭")
					.onClick(() => {
						this.resolve(null);
					})
			);
			return;
		}

		new Setting(contentEl)
			.setName("分析模板")
			.setDesc("选择一个模板后，Echo Notes 会生成独立的分析文档并回写链接。")
			.addDropdown((dropdown) => {
				for (const template of this.templates) {
					dropdown.addOption(template.id, template.name);
				}
				dropdown
					.setValue(this.selectedTemplateId)
					.onChange((value) => {
						this.selectedTemplateId = value;
					});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("生成纪要")
					.setCta()
					.onClick(() => {
						this.resolve(this.templates.find((template) => template.id === this.selectedTemplateId) ?? null);
					})
			)
			.addButton((button) =>
				button
					.setButtonText(this.emptyChoiceLabel)
					.onClick(() => {
						this.resolve(null);
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolve(null);
		}
	}

	private resolve(template: AnalysisTemplateConfig | null): void {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		this.onChoose(template);
		this.close();
	}
}

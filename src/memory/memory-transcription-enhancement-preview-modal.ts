import { App, Modal, Setting } from "obsidian";
import type { TranscriptionEnhancementSnapshot } from "../providers/transcription-provider";

interface TranscriptionEnhancementPreviewOptions {
	snapshot: TranscriptionEnhancementSnapshot;
	sourceLabel: string;
	localOnly?: boolean;
}

export class TranscriptionEnhancementPreviewModal extends Modal {
	constructor(app: App, private readonly options: TranscriptionEnhancementPreviewOptions) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("echo-notes-transcription-enhancement-preview-modal");
		this.setTitle("转写增强生效预览");
		this.render();
	}

	private render(): void {
		this.contentEl.empty();
		const summary = this.contentEl.createDiv({ cls: "echo-notes-enhancement-preview-summary" });
		summary.createEl("strong", { text: this.options.sourceLabel });
		summary.createSpan({ text: this.options.localOnly ? "预览下一次仅在本机使用的人工增强内容，不会发起请求。" : "预览仅展示下一次转写实际可外发的增强内容，不会发起请求。" });

		this.renderSection("匹配作用域", this.options.snapshot.scopeIds.map(formatScopeId));
		this.renderSection(
			`最终热词 ${this.options.snapshot.hotwords.length}`,
			this.options.snapshot.hotwords.map((item) => this.options.localOnly ? item.text : `${item.text} · 权重 ${item.weight}`)
		);

		const contextSection = this.contentEl.createDiv({ cls: "echo-notes-enhancement-preview-section" });
		contextSection.createEl("h3", { text: this.options.localOnly ? "人工会议背景" : "Prompt 与记忆上下文" });
		if (this.options.snapshot.contextText) {
			contextSection.createEl("pre", { text: this.options.snapshot.contextText });
		} else {
			contextSection.createEl("p", { text: "当前无生效上下文。", cls: "setting-item-description" });
		}

		const omitted = this.contentEl.createDiv({ cls: "echo-notes-enhancement-preview-omissions" });
		omitted.createEl("strong", { text: "预算与省略" });
		omitted.createSpan({
			text: `${this.options.localOnly ? "本地最多 100 个热词、合计 1000 字；权重仅用于优先筛选。" : ""}因数量或字数限制省略热词 ${this.options.snapshot.omittedHotwordCount} 项；因 400 字上下文预算省略 ${this.options.snapshot.omittedContextCount} 项。`
		});

		new Setting(this.contentEl).addButton((button) => button
			.setButtonText("关闭")
			.setCta()
			.onClick(() => this.close()));
	}

	private renderSection(title: string, items: string[]): void {
		const section = this.contentEl.createDiv({ cls: "echo-notes-enhancement-preview-section" });
		section.createEl("h3", { text: title });
		if (items.length === 0) {
			section.createEl("p", { text: "暂无。", cls: "setting-item-description" });
			return;
		}
		const list = section.createEl("ul");
		for (const item of items) list.createEl("li", { text: item });
	}
}

function formatScopeId(value: string): string {
	if (value === "global") return "全局";
	const [type, ...name] = value.split(":");
	return `${{ project: "项目", person: "人物", organization: "组织" }[type] ?? type}：${name.join(":")}`;
}

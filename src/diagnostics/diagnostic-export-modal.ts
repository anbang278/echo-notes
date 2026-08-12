import { App, Modal, Notice, Setting } from "obsidian";

export interface DiagnosticExportOptions {
	includeTranscript: boolean;
	includeAnalyses: boolean;
	includeMemoryCandidate: boolean;
}

export interface DiagnosticExportCompletedActions {
	revealLabel?: string;
	onRevealInFolder?: () => void | Promise<void>;
}

export class DiagnosticExportModal extends Modal {
	private onExport: (options: DiagnosticExportOptions) => Promise<void>;
	private options: DiagnosticExportOptions = {
		includeTranscript: false,
		includeAnalyses: false,
		includeMemoryCandidate: false
	};

	constructor(app: App, onExport: (options: DiagnosticExportOptions) => Promise<void>) {
		super(app);
		this.onExport = onExport;
	}

	onOpen(): void {
		this.titleEl.setText("导出 Echo Notes 诊断包");
		this.contentEl.createEl("p", {
			text: "Zip 只在当前 Vault 的 Echo Notes/诊断包 中生成，不会自动上传。默认仅包含脱敏配置、事件与 trace ID。"
		});
		this.contentEl.createEl("p", {
			cls: "mod-warning",
			text: "音频、API Key、鉴权头、Vault 名称、文件名和本地路径永不导出。以下内容仅在你明确勾选后才会读取并写入 zip。"
		});
		new Setting(this.contentEl)
			.setName("包含转写正文")
			.setDesc("用于排查“请求成功但识别质量不佳”的问题。")
			.addToggle((toggle) => toggle.setValue(false).onChange((value) => { this.options.includeTranscript = value; }));
		new Setting(this.contentEl)
			.setName("包含 AI 分析结果")
			.setDesc("仅包含转写稿中的 Echo Notes 托管分析区块。")
			.addToggle((toggle) => toggle.setValue(false).onChange((value) => { this.options.includeAnalyses = value; }));
		new Setting(this.contentEl)
			.setName("包含 memory 候选")
			.setDesc("包含候选断言及其证据，可能含会议内容。")
			.addToggle((toggle) => toggle.setValue(false).onChange((value) => { this.options.includeMemoryCandidate = value; }));
		const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
		const cancel = actions.createEl("button", { text: "取消" });
		cancel.addEventListener("click", () => this.close());
		const submit = actions.createEl("button", { cls: "mod-cta", text: "导出 zip" });
		submit.addEventListener("click", () => {
			submit.disabled = true;
			void this.onExport({ ...this.options })
				.then(() => this.close())
				.catch(() => { submit.disabled = false; });
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

export class DiagnosticExportCompletedModal extends Modal {
	private vaultPath: string;
	private actions: DiagnosticExportCompletedActions;

	constructor(app: App, vaultPath: string, actions: DiagnosticExportCompletedActions = {}) {
		super(app);
		this.vaultPath = vaultPath;
		this.actions = actions;
	}

	onOpen(): void {
		this.titleEl.setText("诊断包已生成");
		this.contentEl.createEl("p", {
			text: "Zip 已仅在当前 Vault 中生成。请自行确认内容后发送给支持人员。"
		});
		new Setting(this.contentEl)
			.setName("Vault 路径")
			.addText((text) => text.setValue(this.vaultPath).setDisabled(true))
			.addButton((button) =>
				button
					.setButtonText("复制路径")
					.onClick(async () => {
						try {
							await navigator.clipboard.writeText(this.vaultPath);
							button.setButtonText("已复制");
						} catch {
							button.setButtonText("复制失败");
						}
					})
			);
		if (this.actions.revealLabel && this.actions.onRevealInFolder) {
			new Setting(this.contentEl)
				.setName("打开所在文件夹")
				.setDesc("会在系统文件管理器中定位并选中此诊断包。")
				.addButton((button) =>
					button
						.setButtonText(this.actions.revealLabel ?? "在文件管理器中打开")
						.onClick(() => {
							button.setDisabled(true);
							void Promise.resolve(this.actions.onRevealInFolder?.())
								.then(() => button.setButtonText("已打开"))
								.catch(() => {
									button.setButtonText("打开失败");
									new Notice("无法在文件管理器中打开诊断包，请使用 Vault 路径手动定位。");
								})
								.finally(() => button.setDisabled(false));
						})
				);
		}
		new Setting(this.contentEl).addButton((button) =>
			button
				.setButtonText("关闭")
				.setCta()
				.onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

import { App, Modal, Notice, Setting } from "obsidian";
import type { MemoryUserProfile } from "./memory-types";

export class MemoryInitializationModal extends Modal {
	private onInitialize: (profile: MemoryUserProfile) => Promise<void>;
	private submitting = false;

	constructor(app: App, onInitialize: (profile: MemoryUserProfile) => Promise<void>) {
		super(app);
		this.onInitialize = onInitialize;
	}

	onOpen(): void {
		this.setTitle("初始化 Echo Memory");
		this.contentEl.addClass("echo-notes-memory-initialization-modal");
		let displayName = "";
		let role = "";
		let recentGoal = "";

		new Setting(this.contentEl)
			.setName("称呼")
			.addText((text) => text.setPlaceholder("你希望被如何称呼").onChange((value) => {
				displayName = value.trim();
			}));
		new Setting(this.contentEl)
			.setName("当前角色")
			.addText((text) => text.setPlaceholder("例如：产品经理").onChange((value) => {
				role = value.trim();
			}));
		new Setting(this.contentEl)
			.setName("近期目标")
			.addTextArea((text) => text.setPlaceholder("当前最重要的一项目标").onChange((value) => {
				recentGoal = value.trim();
			}));

		const actions = new Setting(this.contentEl);
		actions.addButton((button) => button.setButtonText("取消").onClick(() => this.close()));
		actions.addButton((button) => button.setCta().setButtonText("初始化").onClick(async () => {
			if (this.submitting) {
				return;
			}
			if (!displayName || !role || !recentGoal) {
				new Notice("请填写称呼、当前角色和近期目标。");
				return;
			}
			this.submitting = true;
			button.setDisabled(true);
			try {
				await this.onInitialize({ displayName, role, recentGoal });
				this.close();
			} catch (error) {
				new Notice(`Echo Memory 初始化失败：${error instanceof Error ? error.message : String(error)}`);
				button.setDisabled(false);
				this.submitting = false;
			}
		}));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

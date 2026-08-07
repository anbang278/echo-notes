import { App, Modal, Setting, setIcon } from "obsidian";

export class GettingStartedModal extends Modal {
	private onResolved: (start: boolean) => Promise<void> | void;
	private resolved = false;
	private readonly handleKeydown = (event: KeyboardEvent): void => {
		if (event.key !== "Tab") {
			return;
		}
		const focusable = this.getFocusableElements();
		if (focusable.length === 0) {
			event.preventDefault();
			return;
		}
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
			return;
		}
		if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	};

	constructor(app: App, onResolved: (start: boolean) => Promise<void> | void) {
		super(app);
		this.onResolved = onResolved;
	}

	onOpen(): void {
		this.setTitle("把一段录音变成一份 AI 笔记");
		this.titleEl.id = "echo-notes-getting-started-title";
		this.modalEl.addClass("echo-notes-getting-started-modal-shell");
		this.modalEl.setAttribute("aria-labelledby", this.titleEl.id);
		this.modalEl.addEventListener("keydown", this.handleKeydown);
		this.contentEl.addClass("echo-notes-getting-started-modal");

		this.contentEl.createEl("p", {
			cls: "echo-notes-getting-started-copy",
			text: "3 步完成首次转写与 AI 分析。执行转写时，音频会发送给你选择的转写服务；AI 分析会发送转写文本。API key 仅保存在 Obsidian SecretStorage。"
		});

		const tagsEl = this.contentEl.createDiv({ cls: "echo-notes-getting-started-tags" });
		this.createTag(tagsEl, "audio-lines", "配置转写");
		this.createTag(tagsEl, "sparkles", "配置分析");
		this.createTag(tagsEl, "file-audio", "处理录音");

		const actions = new Setting(this.contentEl).setClass("echo-notes-getting-started-actions");
		actions.addButton((button) => button
			.setButtonText("稍后")
			.onClick(() => void this.resolve(false)));
		actions.addButton((button) => {
			button
				.setCta()
				.setButtonText("开始设置")
				.onClick(() => void this.resolve(true));
			window.setTimeout(() => button.buttonEl.focus(), 0);
		});
	}

	onClose(): void {
		this.modalEl.removeEventListener("keydown", this.handleKeydown);
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			void this.onResolved(false);
		}
	}

	private createTag(containerEl: HTMLElement, icon: string, label: string): void {
		const tagEl = containerEl.createDiv({ cls: "echo-notes-getting-started-tag" });
		const iconEl = tagEl.createSpan({ cls: "echo-notes-getting-started-tag-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, icon);
		tagEl.createSpan({ text: label });
	}

	private async resolve(start: boolean): Promise<void> {
		if (this.resolved) {
			return;
		}
		this.resolved = true;
		await this.onResolved(start);
		this.close();
	}

	private getFocusableElements(): HTMLElement[] {
		return Array.from(this.modalEl.querySelectorAll<HTMLElement>(
			'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
		)).filter((element) => !element.hasAttribute("hidden") && element.getClientRects().length > 0);
	}
}

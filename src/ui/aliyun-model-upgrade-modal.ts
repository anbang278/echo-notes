import { type App, Modal, setIcon } from "obsidian";
import {
	ALIYUN_ASR_FILETRANS_DESCRIPTION,
	ALIYUN_ASR_MODELS,
	ALIYUN_ASR_PRICE_REFERENCE,
	ALIYUN_ASR_PRICING_URL
} from "../providers/aliyun-model-upgrade";
import { ALIYUN_FILETRANS_MODEL } from "../settings/settings";

type OlderAliyunModel = Exclude<keyof typeof ALIYUN_ASR_MODELS, typeof ALIYUN_FILETRANS_MODEL>;

export type AliyunUpgradeDecision = "switch" | "keep" | "dismiss";
export const ALIYUN_UPGRADE_CONFIG_CHANGED = "转写配置已变化，请关闭后重新发起转写。";

export class AliyunModelUpgradeModal extends Modal {
	private resolved = false;
	private saving = false;

	constructor(
		app: App,
		private readonly currentModel: OlderAliyunModel,
		private readonly resolve: (decision: AliyunUpgradeDecision | null) => void,
		private readonly persist: (decision: AliyunUpgradeDecision) => Promise<void>
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("echo-notes-aliyun-upgrade-dialog");
		this.contentEl.addClass("echo-notes-aliyun-upgrade");
		this.titleEl.setText("比较当前模型与 3.1");
		this.titleEl.tabIndex = -1;
		const provider = createDiv({ cls: "echo-notes-aliyun-upgrade-provider", text: "Echo Notes · 百炼录音转写" });
		this.titleEl.parentElement?.insertBefore(provider, this.titleEl);

		const comparison = this.contentEl.createDiv({ cls: "echo-notes-aliyun-model-comparison" });
		this.renderCard(comparison, this.currentModel, false);
		const heading = this.renderCard(comparison, ALIYUN_FILETRANS_MODEL, true);
		const modelInfo = heading.createEl("button", {
			cls: "echo-notes-aliyun-model-info",
			attr: { type: "button", "aria-label": "查看 3.1 模型说明", "aria-expanded": "false" }
		});
		setIcon(modelInfo, "info");
		const description = heading.createDiv({
			cls: "echo-notes-aliyun-model-description",
			text: ALIYUN_ASR_FILETRANS_DESCRIPTION,
			attr: { role: "tooltip", id: "echo-notes-aliyun-filetrans-description" }
		});
		description.hidden = true;
		modelInfo.setAttr("aria-controls", description.id);
		modelInfo.setAttr("aria-describedby", description.id);
		const showDescription = (visible: boolean) => {
			description.hidden = !visible;
			modelInfo.setAttr("aria-expanded", String(visible));
		};
		modelInfo.addEventListener("pointerenter", event => {
			if (event.pointerType === "mouse") showDescription(true);
		});
		heading.addEventListener("pointerleave", event => {
			if (event.pointerType === "mouse" && !modelInfo.matches(":focus-visible")) showDescription(false);
		});
		modelInfo.addEventListener("focus", () => {
			if (modelInfo.matches(":focus-visible")) showDescription(true);
		});
		modelInfo.addEventListener("blur", () => {
			if (!heading.matches(":hover")) showDescription(false);
		});
		modelInfo.addEventListener("click", () => showDescription(description.hidden));
		this.contentEl.addEventListener("pointerdown", event => {
			if (event.target instanceof Node && !heading.contains(event.target)) showDescription(false);
		});
		this.scope.register([], "Escape", () => {
			if (description.hidden) {
				this.close();
			} else {
				showDescription(false);
			}
			return false;
		});

		const pricing = this.contentEl.createEl("p", { cls: "echo-notes-aliyun-pricing-reference" });
		pricing.createSpan({ text: ALIYUN_ASR_PRICE_REFERENCE });
		pricing.createEl("a", {
			text: "百炼官方计费",
			attr: { href: ALIYUN_ASR_PRICING_URL, target: "_blank", rel: "noopener noreferrer" }
		});
		this.contentEl.createEl("p", { cls: "echo-notes-aliyun-upgrade-effect", text: "切换后，本次和后续百炼转写使用 3.1。" });
		const status = this.contentEl.createDiv({ cls: "echo-notes-inline-validation", attr: { role: "status", "aria-live": "polite" } });
		const actions = this.contentEl.createDiv({ cls: "echo-notes-aliyun-upgrade-actions" });
		const labels: Array<[AliyunUpgradeDecision, string, string?]> = [
			["dismiss", "不再提醒，继续使用旧版", "echo-notes-aliyun-upgrade-quiet"],
			["keep", "继续使用旧版"],
			["switch", "切换到 3.1 并转写", "mod-cta"]
		];
		for (const [decision, text, cls] of labels) {
			const button = actions.createEl("button", { text, cls, attr: { type: "button" } });
			button.addEventListener("click", () => void this.confirm(decision, actions, status));
		}
		this.titleEl.focus();
	}

	private renderCard(parent: HTMLElement, model: keyof typeof ALIYUN_ASR_MODELS, candidate: boolean): HTMLElement {
		const card = parent.createEl("section", { cls: "echo-notes-aliyun-model-card" });
		if (candidate) card.addClass("is-candidate");
		card.createDiv({ cls: "echo-notes-aliyun-model-state", text: candidate ? "新版模型" : "当前模型" });
		const heading = card.createDiv({ cls: "echo-notes-aliyun-model-heading" });
		heading.createEl("h3", { text: ALIYUN_ASR_MODELS[model].name });
		card.createEl("code", { cls: "echo-notes-aliyun-model-id", text: model });
		card.createEl("p", { cls: "echo-notes-aliyun-model-capabilities", text: ALIYUN_ASR_MODELS[model].capabilities });
		const price = card.createEl("dl", { cls: "echo-notes-aliyun-model-price" });
		const rows = candidate
			? [["输入", "0.8 元", "百万 Token"], ["输出", "2.7 元", "百万 Token"]]
			: [["按时长", "0.00022 元", "计费秒"], ["折合", "约 0.79 元", "计费小时"]];
		for (const [label, value, unit] of rows) {
			const row = price.createDiv();
			row.createEl("dt", { text: label });
			const priceValue = row.createEl("dd", { text: value });
			priceValue.createEl("small", { text: ` / ${unit}` });
		}
		return heading;
	}

	private async confirm(decision: AliyunUpgradeDecision, actions: HTMLElement, status: HTMLElement): Promise<void> {
		if (this.resolved || this.saving) return;
		this.saving = true;
		const buttons = actions.querySelectorAll("button");
		buttons.forEach(button => { button.disabled = true; });
		if (decision !== "keep") status.setText("正在保存…");
		try {
			await this.persist(decision);
			if (this.resolved) return;
			this.resolved = true;
			this.resolve(decision);
			super.close();
		} catch (error) {
			if (this.resolved) return;
			status.setText(error instanceof Error && error.message === ALIYUN_UPGRADE_CONFIG_CHANGED
				? ALIYUN_UPGRADE_CONFIG_CHANGED
				: "设置尚未保存，请重试或继续使用旧版。");
			buttons.forEach(button => { button.disabled = false; });
		} finally {
			this.saving = false;
		}
	}

	close(): void {
		if (!this.saving) super.close();
	}

	abort(): void {
		super.close();
		if (!this.resolved) this.onClose();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.resolved) {
			this.resolved = true;
			this.resolve(null);
		}
	}
}

import { App, Modal, setIcon } from "obsidian";
import type {
	MemoryControlCenterActionId,
	MemoryControlCenterSummary
} from "./memory-types";
import type { MemoryInboxContext } from "./memory-service";
import { MemoryInboxView, type MemoryInboxViewCallbacks } from "./memory-inbox-modal";

export type MemoryCenterTab = "overview" | "inbox";

export interface MemoryCenterCallbacks {
	getSummary: () => Promise<MemoryControlCenterSummary>;
	runAction: (action: MemoryControlCenterActionId) => Promise<void>;
	openSettings: () => Promise<void>;
	openHome: () => Promise<void>;
	openTimeline: () => Promise<void>;
	manageRelations: () => Promise<void>;
	manageEnhancement: () => Promise<void>;
	openContextPackage: () => Promise<void>;
	inbox: MemoryInboxViewCallbacks;
}


export class MemoryCenterView {
	private readonly app: App;
	private readonly contentEl: HTMLElement;
	private readonly callbacks: MemoryCenterCallbacks;
	private activeTab: MemoryCenterTab;
	private overviewPanel: HTMLElement | null = null;
	private inboxPanel: HTMLElement | null = null;
	private overviewTabEl: HTMLButtonElement | null = null;
	private inboxTabEl: HTMLButtonElement | null = null;
	private inboxView: MemoryInboxView | null = null;
	private pendingTotal = 0;

	constructor(app: App, contentEl: HTMLElement, initialTab: MemoryCenterTab, callbacks: MemoryCenterCallbacks) {
		this.app = app;
		this.contentEl = contentEl;
		this.activeTab = initialTab;
		this.callbacks = callbacks;
	}

	render(): void {
		this.contentEl.addClass("echo-notes-memory-center-modal");
		this.contentEl.toggleClass(
			"echo-notes-memory-center-inline",
			Boolean(this.contentEl.closest(".modal.mod-settings")) || !this.contentEl.closest(".modal")
		);
		this.build();
		void this.refreshBadge();
		void this.activateTab(this.activeTab, false);
	}

	destroy(): void {
		this.inboxView?.destroy();
		this.inboxView = null;
		this.contentEl.empty();
	}

	private build(): void {
		this.contentEl.empty();
		const header = this.contentEl.createDiv({ cls: "echo-notes-memory-center-header" });
		header.createEl("p", {
			cls: "echo-notes-memory-center-tagline",
			text: "AI 只提出候选，经过你确认才进入长期记忆。"
		});

		const tabs = header.createDiv({
			cls: "echo-notes-memory-center-tabs",
			attr: { role: "tablist", "aria-label": "记忆中心视图" }
		});
		this.overviewTabEl = this.createTab(tabs, "overview", "总览");
		this.inboxTabEl = this.createTab(tabs, "inbox", "审核中心");

		this.overviewPanel = this.contentEl.createDiv({ cls: "echo-notes-memory-center-panel" });
		this.inboxPanel = this.contentEl.createDiv({ cls: "echo-notes-memory-center-panel" });
		this.overviewPanel.id = "echo-notes-memory-center-panel-overview";
		this.overviewPanel.setAttribute("role", "tabpanel");
		this.inboxPanel.id = "echo-notes-memory-center-panel-inbox";
		this.inboxPanel.setAttribute("role", "tabpanel");
	}

	private createTab(containerEl: HTMLElement, id: MemoryCenterTab, label: string): HTMLButtonElement {
		const buttonEl = containerEl.createEl("button", {
			cls: "echo-notes-memory-center-tab",
			attr: {
				type: "button",
				role: "tab",
				"aria-controls": `echo-notes-memory-center-panel-${id}`,
				"aria-selected": "false",
				tabindex: "-1"
			}
		});
		buttonEl.id = `echo-notes-memory-center-tab-${id}`;
		buttonEl.dataset.memoryCenterTab = id;
		buttonEl.createSpan({ cls: "echo-notes-memory-center-tab-label", text: label });
		buttonEl.addEventListener("click", () => void this.activateTab(id));
		buttonEl.addEventListener("keydown", (event) => {
			const tabIds: MemoryCenterTab[] = ["overview", "inbox"];
			const currentIndex = tabIds.indexOf(id);
			let targetIndex: number;
			switch (event.key) {
				case "ArrowLeft":
				case "ArrowUp":
					targetIndex = (currentIndex - 1 + tabIds.length) % tabIds.length;
					break;
				case "ArrowRight":
				case "ArrowDown":
					targetIndex = (currentIndex + 1) % tabIds.length;
					break;
				case "Home":
					targetIndex = 0;
					break;
				case "End":
					targetIndex = tabIds.length - 1;
					break;
				default:
					return;
			}
			event.preventDefault();
			void this.activateTab(tabIds[targetIndex]);
		});
		return buttonEl;
	}

	private async activateTab(tab: MemoryCenterTab, moveFocus = true): Promise<void> {
		this.activeTab = tab;
		this.overviewTabEl?.toggleClass("is-active", tab === "overview");
		this.inboxTabEl?.toggleClass("is-active", tab === "inbox");
		this.overviewTabEl?.setAttribute("aria-selected", String(tab === "overview"));
		this.inboxTabEl?.setAttribute("aria-selected", String(tab === "inbox"));
		this.overviewTabEl?.setAttribute("tabindex", tab === "overview" ? "0" : "-1");
		this.inboxTabEl?.setAttribute("tabindex", tab === "inbox" ? "0" : "-1");
		if (this.overviewPanel) {
			this.overviewPanel.setAttribute("aria-labelledby", this.overviewTabEl?.id ?? "");
			this.overviewPanel.hidden = tab !== "overview";
		}
		if (this.inboxPanel) {
			this.inboxPanel.setAttribute("aria-labelledby", this.inboxTabEl?.id ?? "");
			this.inboxPanel.hidden = tab !== "inbox";
		}

		if (tab === "overview") {
			await this.renderOverview();
		} else {
			await this.renderInbox();
		}

		if (moveFocus) {
			(tab === "overview" ? this.overviewTabEl : this.inboxTabEl)?.focus();
		}
	}

	private async refreshBadge(): Promise<void> {
		try {
			const summary = await this.callbacks.getSummary();
			this.pendingTotal = summary.pending?.total ?? 0;
		} catch {
			this.pendingTotal = 0;
		}
		this.updateBadge();
	}

	private updateBadge(): void {
		if (!this.inboxTabEl) {
			return;
		}
		this.inboxTabEl.querySelector(".echo-notes-memory-center-tab-badge")?.remove();
		if (this.pendingTotal > 0) {
			this.inboxTabEl.createSpan({
				cls: "echo-notes-memory-center-tab-badge",
				text: String(this.pendingTotal),
				attr: { "aria-hidden": "true" }
			});
		}
	}

	private async renderOverview(): Promise<void> {
		if (!this.overviewPanel) {
			return;
		}
		this.overviewPanel.empty();
		this.overviewPanel.createDiv({
			cls: "echo-notes-memory-center-loading",
			text: "正在读取记忆状态…"
		});

		let summary: MemoryControlCenterSummary;
		try {
			summary = await this.callbacks.getSummary();
		} catch {
			if (!this.overviewPanel.isConnected) {
				return;
			}
			this.overviewPanel.empty();
			const error = this.overviewPanel.createDiv({
				cls: "echo-notes-memory-center-error",
				text: "暂时无法读取记忆状态，请检查记忆模型连接后重试。"
			});
			const actions = error.createDiv({ cls: "echo-notes-memory-center-error-actions" });
			const retry = actions.createEl("button", { cls: "mod-cta", text: "重试", attr: { type: "button" } });
			retry.addEventListener("click", () => void this.renderOverview());
			const settings = actions.createEl("button", { text: "配置记忆模型", attr: { type: "button" } });
			settings.addEventListener("click", () => void this.callbacks.openSettings());
			return;
		}

		if (!this.overviewPanel.isConnected) {
			return;
		}
		this.overviewPanel.empty();

		const hero = this.overviewPanel.createDiv({ cls: "echo-notes-memory-hero" });
		const heroCopy = hero.createDiv({ cls: "echo-notes-memory-hero-copy" });
		heroCopy.createEl("strong", { cls: "echo-notes-memory-hero-title", text: summary.nextAction.title });
		heroCopy.createEl("p", { cls: "echo-notes-memory-hero-description", text: summary.nextAction.description });

		const pending = summary.pending;
		if (pending && pending.total > 0) {
			const breakdown = hero.createDiv({ cls: "echo-notes-memory-hero-breakdown" });
			for (const [label, value, tone] of [
				["核心", pending.coreCandidate, "is-core"],
				["长期", pending.longTermCandidate, "is-long-term"],
				["工作记忆", pending.workingCandidate, "is-working"],
				["低优先级", pending.lowPriority, "is-low"]
			] as const) {
				const chip = breakdown.createDiv({ cls: `echo-notes-memory-chip ${tone}` });
				chip.createSpan({ cls: "echo-notes-memory-chip-label", text: label });
				chip.createSpan({ cls: "echo-notes-memory-chip-value", text: String(value) });
			}
		}

		const heroFooter = hero.createDiv({ cls: "echo-notes-memory-hero-footer" });
		heroFooter.createSpan({ cls: "echo-notes-memory-hero-hint", text: summary.nextAction.hint });
		const cta = heroFooter.createEl("button", {
			cls: "mod-cta echo-notes-memory-hero-button",
			text: summary.nextAction.label,
			attr: { type: "button" }
		});
		cta.addEventListener("click", () => {
			if (summary.nextAction.id === "review") {
				void this.activateTab("inbox");
			} else {
				void this.callbacks.runAction(summary.nextAction.id);
			}
		});

		const status = this.overviewPanel.createDiv({
			cls: "echo-notes-memory-status-strip",
			attr: { role: "status", "aria-live": "polite" }
		});
		const statusItems = [
			["工作区", summary.initialized ? "已初始化" : "尚未初始化", summary.initialized ? "success" : "attention"],
			["模型", summary.modelReady ? "可以提取" : "需要配置", summary.modelReady ? "success" : "attention"],
			["自动提取", summary.autoEnabled ? "已开启" : "未开启", summary.autoEnabled ? "success" : "neutral"]
		] as const;
		for (const [label, value, tone] of statusItems) {
			const item = status.createDiv({ cls: "echo-notes-memory-status-item" });
			item.createSpan({ cls: `echo-notes-memory-status-dot is-${tone}` });
			item.createSpan({ cls: "echo-notes-memory-status-item-label", text: label });
			item.createSpan({ cls: "echo-notes-memory-status-item-value", text: value });
		}
		if (pending !== null) {
			const pendingItem = status.createDiv({ cls: "echo-notes-memory-status-item" });
			pendingItem.createSpan({
				cls: `echo-notes-memory-status-dot ${pending.total > 0 ? "is-attention" : "is-success"}`
			});
			pendingItem.createSpan({ cls: "echo-notes-memory-status-item-label", text: "待审核" });
			const pendingLink = pendingItem.createEl("button", {
				cls: "echo-notes-memory-status-item-link",
				text: `${pending.total} 条`,
				attr: { type: "button" }
			});
			pendingLink.addEventListener("click", () => void this.activateTab("inbox"));
		}
		const settingsLink = status.createEl("button", {
			cls: "echo-notes-memory-status-settings-link",
			text: "配置提取规则",
			attr: { type: "button" }
		});
		settingsLink.addEventListener("click", () => void this.callbacks.openSettings());

		const quickLinks = this.overviewPanel.createDiv({ cls: "echo-notes-memory-quick-links" });
		this.renderQuickLink(quickLinks, "home", "记忆首页", () => void this.callbacks.openHome());
		this.renderQuickLink(quickLinks, "calendar-clock", "时间线", () => void this.callbacks.openTimeline());
		this.renderQuickLink(quickLinks, "clipboard-check", "审核中心", () => void this.activateTab("inbox"));

		const tools = this.overviewPanel.createDiv({ cls: "echo-notes-memory-tools" });
		tools.createEl("h3", { cls: "echo-notes-memory-tools-title", text: "工具" });
		this.renderTool(tools, "git-branch", "管理记忆关系", "确认补充、冲突、替代或失效关系。", () => void this.callbacks.manageRelations());
		this.renderTool(tools, "wand-2", "管理转写增强", "维护术语、固定 prompt 与 AI 术语候选。", () => void this.callbacks.manageEnhancement());
		this.renderTool(tools, "package", "生成 Personal Agent 上下文包", "按项目、人物、日期筛选已批准记忆。", () => void this.callbacks.openContextPackage());
	}

	private renderQuickLink(
		containerEl: HTMLElement,
		icon: string,
		label: string,
		onClick: () => void
	): void {
		const buttonEl = containerEl.createEl("button", {
			cls: "echo-notes-memory-quick-link",
			attr: { type: "button" }
		});
		const iconEl = buttonEl.createSpan({ cls: "echo-notes-memory-quick-link-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, icon);
		buttonEl.createSpan({ cls: "echo-notes-memory-quick-link-label", text: label });
		buttonEl.addEventListener("click", onClick);
	}

	private renderTool(
		containerEl: HTMLElement,
		icon: string,
		title: string,
		description: string,
		onClick: () => void
	): void {
		const row = containerEl.createEl("button", {
			cls: "echo-notes-memory-tool",
			attr: { type: "button" }
		});
		const iconEl = row.createSpan({ cls: "echo-notes-memory-tool-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, icon);
		const copy = row.createSpan({ cls: "echo-notes-memory-tool-copy" });
		copy.createEl("strong", { text: title });
		copy.createSpan({ text: description });
		row.addEventListener("click", onClick);
	}

	private async renderInbox(): Promise<void> {
		if (!this.inboxPanel) {
			return;
		}
		if (this.inboxView) {
			this.inboxView.render();
			return;
		}

		let context: MemoryInboxContext;
		try {
			context = await this.callbacks.inbox.onReload();
		} catch {
			if (!this.inboxPanel.isConnected) {
				return;
			}
			this.inboxPanel.empty();
			this.inboxPanel.addClass("echo-notes-memory-inbox");
			const error = this.inboxPanel.createDiv({
				cls: "echo-notes-memory-inbox-empty",
				text: "暂时无法读取记忆候选，请稍后重试。"
			});
			const actions = error.createDiv({ cls: "echo-notes-memory-inbox-empty-actions" });
			const retry = actions.createEl("button", { cls: "mod-cta", text: "重试", attr: { type: "button" } });
			retry.addEventListener("click", () => void this.renderInbox());
			const settings = actions.createEl("button", { text: "配置记忆模型", attr: { type: "button" } });
			settings.addEventListener("click", () => void this.callbacks.openSettings());
			return;
		}

		if (!this.inboxPanel.isConnected) {
			return;
		}
		this.inboxView = new MemoryInboxView(this.app, this.inboxPanel, context, {
			...this.callbacks.inbox,
			onChange: () => void this.refreshBadge()
		});
		this.inboxView.render();
	}
}

export class MemoryCenterModal extends Modal {
	private readonly initialTab: MemoryCenterTab;
	private readonly callbacks: MemoryCenterCallbacks;
	private view: MemoryCenterView | null = null;

	constructor(app: App, initialTab: MemoryCenterTab, callbacks: MemoryCenterCallbacks) {
		super(app);
		this.initialTab = initialTab;
		this.callbacks = callbacks;
	}

	onOpen(): void {
		this.setTitle("记忆中心");
		this.view = new MemoryCenterView(this.app, this.contentEl, this.initialTab, this.callbacks);
		this.view.render();
	}

	onClose(): void {
		this.view?.destroy();
		this.view = null;
	}
}

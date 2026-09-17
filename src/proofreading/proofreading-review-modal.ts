import { App, Modal, Notice, setIcon } from "obsidian";
import { applyProofreadingDecision, undoProofreadingDecision, type DualModelProofreadingSession } from "./proofreading";

export class ProofreadingReviewModal extends Modal {
	private session: DualModelProofreadingSession;
	private currentIndex = 0;
	private audio: HTMLAudioElement | null = null;

	constructor(app: App, session: DualModelProofreadingSession, private readonly actions: { save(session: DualModelProofreadingSession): Promise<void>; audioUrl?: string }) {
		super(app); this.session = session;
	}

	onOpen(): void { this.modalEl.addClass("echo-notes-proofreading-modal"); this.render(); }
	onClose(): void { this.audio?.pause(); this.audio = null; }

	private render(): void {
		const { contentEl } = this; contentEl.empty();
		contentEl.createEl("h2", { text: "转写校对" });
		const pending = this.session.issues.filter((issue) => !issue.decision).length;
		contentEl.createEl("p", { cls: "echo-notes-proofreading-summary", text: `当前阅读主稿；还有 ${pending} 项待确认。处理一项即保存，可随时撤销。` });
		this.renderAudio(contentEl);
		const issue = this.session.issues[this.currentIndex];
		if (!issue) { contentEl.createEl("p", { text: "没有待处理的两路差异。原稿和记录仍保存在当前转写稿中。" }); return; }
		const label = contentEl.createDiv({ cls: "echo-notes-proofreading-issue-label", text: `${issue.id} · ${issue.risk === "high" ? "关键事实，需人工确认" : "文本差异"}` });
		label.setAttribute("role", "status");
		this.renderEvidence(contentEl, "主稿", issue.primary);
		this.renderEvidence(contentEl, "辅稿", issue.auxiliary || "（辅稿没有对应内容）");
		contentEl.createEl("p", { cls: "echo-notes-proofreading-reason", text: issue.reason });
		const actions = contentEl.createDiv({ cls: "echo-notes-proofreading-actions" });
		this.action(actions, "主稿正确", "check", () => { void this.decide("primary"); });
		this.action(actions, "辅稿正确", "git-compare", () => { void this.decide("auxiliary"); });
		const manual = actions.createEl("button", { text: "两者都不对", cls: "mod-warning" });
		manual.addEventListener("click", () => this.renderManualEntry(contentEl));
		if (issue.decision) this.action(actions, "撤销本项", "undo-2", () => { void this.undo(); });
		const navigation = contentEl.createDiv({ cls: "echo-notes-proofreading-navigation" });
		this.action(navigation, "上一项", "chevron-left", () => { this.currentIndex = Math.max(0, this.currentIndex - 1); this.render(); }, this.currentIndex === 0);
		this.action(navigation, "下一项", "chevron-right", () => { this.currentIndex = Math.min(this.session.issues.length - 1, this.currentIndex + 1); this.render(); }, this.currentIndex >= this.session.issues.length - 1);
	}

	private renderAudio(container: HTMLElement): void {
		const block = container.createDiv({ cls: "echo-notes-proofreading-audio" });
		if (!this.actions.audioUrl) { block.createSpan({ text: "未找到可播放的关联录音；请从转写稿中的音频链接打开后人工定位。" }); return; }
		this.audio ??= new Audio(this.actions.audioUrl);
		const controls = block.createDiv();
		this.action(controls, this.audio.paused ? "播放" : "暂停", this.audio.paused ? "play" : "pause", () => {
			if (!this.audio) return;
			if (this.audio.paused) void this.audio.play(); else this.audio.pause();
			this.render();
		});
		this.action(controls, "后退 5 秒", "rewind", () => { if (this.audio) this.audio.currentTime = Math.max(0, this.audio.currentTime - 5); });
		this.action(controls, "前进 5 秒", "fast-forward", () => { if (this.audio) this.audio.currentTime = Math.min(this.audio.duration || Infinity, this.audio.currentTime + 5); });
		const progress = block.createEl("input", { attr: { type: "range", min: "0", max: String(this.audio.duration || 1), value: String(this.audio.currentTime), "aria-label": "录音进度" } });
		progress.addEventListener("input", () => { if (this.audio) this.audio.currentTime = Number(progress.value); });
		const speed = block.createEl("select", { attr: { "aria-label": "播放倍速" } });
		for (const value of ["0.75", "1", "1.25", "1.5", "2"]) speed.createEl("option", { text: `${value}×`, value, attr: { selected: String(this.audio.playbackRate) === value ? "selected" : "" } });
		speed.addEventListener("change", () => { if (this.audio) this.audio.playbackRate = Number(speed.value); });
	}

	private renderEvidence(container: HTMLElement, title: string, value: string): void { const block = container.createDiv({ cls: "echo-notes-proofreading-evidence" }); block.createEl("strong", { text: title }); block.createEl("p", { text: value }); }
	private renderManualEntry(container: HTMLElement): void { const field = container.createEl("textarea", { attr: { placeholder: "填写正确文本", "aria-label": "手动修正文本" } }); const save = container.createEl("button", { text: "保存手填结果", cls: "mod-cta" }); save.addEventListener("click", () => void this.decide("manual", field.value)); field.focus(); }
	private action(container: HTMLElement, text: string, icon: string, callback: () => void, disabled = false): void { const button = container.createEl("button", { text, attr: { type: "button" } }); setIcon(button, icon); button.disabled = disabled; button.addEventListener("click", callback); }
	private async decide(decision: "primary" | "auxiliary" | "manual", manualText?: string): Promise<void> { try { const issue = this.session.issues[this.currentIndex]; this.session = applyProofreadingDecision(this.session, issue.id, decision, manualText); await this.actions.save(this.session); new Notice("校对选择已保存。"); this.render(); } catch (error) { new Notice(error instanceof Error ? error.message : "无法保存校对选择。"); } }
	private async undo(): Promise<void> { try { const issue = this.session.issues[this.currentIndex]; this.session = undoProofreadingDecision(this.session, issue.id); await this.actions.save(this.session); new Notice("已撤销本项选择。"); this.render(); } catch (error) { new Notice(error instanceof Error ? error.message : "无法撤销校对选择。"); } }
}

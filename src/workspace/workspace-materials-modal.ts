import { Modal, Notice, Setting, type App } from "obsidian";
import type { EvidenceItem } from "../evidence";
import type { MeetingWorkspaceService } from "./meeting-workspace-service";
import type { WorkspaceMaterials } from "./meeting-workspace-view";

export class EvidenceWorkspaceModal extends Modal {
	private revision = 0;
	private busy = false;
	private error = "";
	private active = true;

	constructor(app: App, private service: MeetingWorkspaceService, private materials: WorkspaceMaterials) { super(app); }

	onOpen(): void {
		this.active = true;
		this.modalEl.addClass("echo-notes-evidence-modal");
		this.setTitle("整理问题材料");
		this.render();
	}

	onClose(): void {
		this.active = false;
		this.revision++;
		this.service.notify();
	}

	private run(operation: () => Promise<void>): void {
		if (this.busy) return;
		this.busy = true;
		void operation().catch((error: unknown) => {
			this.error = error instanceof Error ? error.message : String(error);
		}).finally(() => { this.busy = false; if (this.active) this.render(); });
	}

	private async search(): Promise<void> {
		const revision = ++this.revision;
		const result = await this.service.search(this.materials.query);
		if (!this.active || revision !== this.revision) return;
		this.materials.result = result;
		this.materials.previewQuery = JSON.stringify(result.query);
		this.materials.query = result.query;
		this.error = "";
	}

	private render(): void {
		const root = this.contentEl;
		root.empty();
		const query = this.materials.query;
		root.createEl("p", { text: "提出问题 → 查找原文 → 核对来源 → 导出材料", cls: "echo-notes-workspace-meta" });
		new Setting(root).setName("你想厘清的问题").addTextArea((text) => {
			text.setValue(query.question).setPlaceholder("为什么从统一提醒调整为分级处理？");
			text.inputEl.rows = 2;
			text.onChange((value) => { query.question = value; });
		});
		new Setting(root).setName("关键词与同义词").setDesc("用逗号或空格分隔。空关键词时按所选范围整理。").addText((text) => text.setValue(query.keywords.join("，")).setPlaceholder("统一提醒，分级，风险").onChange((value) => { query.keywords = value.split(/[\s,，、]+/u).filter(Boolean); }));
		const advanced = root.createEl("details");
		advanced.createEl("summary", { text: "范围与预算" });
		const fields = advanced.createDiv();
		new Setting(fields).setName("精确短语").setDesc("每行一个，逐字匹配。").addTextArea((text) => text.setValue(query.exactPhrases.join("\n")).onChange((value) => { query.exactPhrases = value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); }));
		new Setting(fields).setName("会议发生起始日").addText((text) => { text.inputEl.type = "date"; text.setValue(query.filters.fromDate ?? "").onChange((value) => { query.filters.fromDate = value || undefined; }); });
		new Setting(fields).setName("会议发生结束日").addText((text) => { text.inputEl.type = "date"; text.setValue(query.filters.toDateInclusive ?? "").onChange((value) => { query.filters.toDateInclusive = value || undefined; }); });
		new Setting(fields).setName("原文与上下文字符预算").setDesc("按 Unicode 字符计数，固定项超预算时需要调整。").addText((text) => { text.inputEl.type = "number"; text.setValue(String(query.maxCharacters)).onChange((value) => { query.maxCharacters = Number(value); }); });
		new Setting(fields).setName("包含历史记忆").setDesc("保留被替代或过期的已批准记忆，并显示历史状态。").addToggle((toggle) => toggle.setValue(query.includeHistoricalMemory).onChange((value) => { query.includeHistoricalMemory = value; }));
		new Setting(fields).setName("包含已批准记忆附录").addToggle((toggle) => toggle.setValue(query.filters.sourceKinds.includes("approved_memory")).onChange((value) => {
			query.filters.sourceKinds = value ? [...new Set([...query.filters.sourceKinds, "approved_memory" as const])] : query.filters.sourceKinds.filter((kind) => kind !== "approved_memory");
		}));
		new Setting(fields).setName("包含 AI 分析").setDesc("分析单独标注，不作为逐字原话。").addToggle((toggle) => toggle.setValue(query.filters.sourceKinds.includes("analysis")).onChange((value) => {
			query.filters.sourceKinds = value ? [...new Set([...query.filters.sourceKinds, "analysis" as const])] : query.filters.sourceKinds.filter((kind) => kind !== "analysis");
		}));
		const scope = root.createEl("p", { cls: "echo-notes-workspace-meta" });
		scope.setText(`项目范围 ${query.filters.projectIds.length || "全部已登记项目"} · 会议范围 ${query.filters.meetingIds.length || "全部已登记会议"} · ${query.filters.timezone} · 本地字面检索`);
		new Setting(root).addButton((button) => button.setButtonText(this.busy ? "处理中…" : "查找材料").setCta().setDisabled(this.busy).onClick(() => this.run(() => this.search()))).addButton((button) => button.setButtonText("清除会议与项目范围").onClick(() => { query.filters.projectIds = []; query.filters.meetingIds = []; this.render(); }));
		if (this.error) root.createEl("p", { cls: "echo-notes-workspace-warning", text: this.error, attr: { role: "alert" } });
		const result = this.materials.result;
		const stale = this.materials.previewQuery !== JSON.stringify(query);
		if (!result) { root.createEl("p", { text: "查找后检查原文和上下文，选材及原始提问会保留在当前工作区。" }); return; }
		if (stale) root.createEl("p", { text: "查询条件已改变，请重新查找材料后核验导出。", cls: "echo-notes-workspace-warning" });
		const coverage = result.coverage;
		root.createEl("p", { cls: "echo-notes-workspace-coverage", attr: { role: "status" }, text: `检查 ${coverage.scannedMeetings} 场 · 匹配 ${coverage.matchedMeetings} 场 · 纳入 ${coverage.includedMeetings} 场 / ${coverage.includedItems} 段 · ${coverage.characters} 字符 · 预算省略 ${coverage.omittedByBudget} 段 · 人工排除 ${coverage.excludedByUser} 段 · 异常来源 ${coverage.abnormalSources}` });
		for (const issue of result.issues) root.createEl("p", { cls: "echo-notes-workspace-warning", text: issue.message });
		if (query.pinnedEvidenceIds.length || query.excludedEvidenceIds.length) new Setting(root).setName("重新确认选材").setDesc("来源更新或范围改变后，可清除旧的固定与排除决定，再重新选择。").addButton((button) => button.setButtonText("重置固定与排除").onClick(() => {
			query.pinnedEvidenceIds = []; query.excludedEvidenceIds = []; this.run(() => this.search());
		}));
		if (!result.items.length) root.createEl("p", { text: "本次范围没有匹配原文。可补充关键词或扩大日期、项目范围。" });
		const list = root.createDiv({ cls: "echo-notes-evidence-results" });
		for (const item of result.items) this.renderItem(list, item);
		if (result.memories.length) {
			root.createEl("h3", { text: "已批准记忆附录" });
			for (const memory of result.memories) {
				const block = root.createDiv({ cls: "echo-notes-workspace-utterance" });
				block.createEl("p", { text: memory.text });
				block.createEl("p", { cls: "echo-notes-workspace-meta", text: `${memory.approval} · ${memory.resolvedValidity} · 来源 ${memory.sourceCheck ?? "unsupported"}` });
			}
		}
		new Setting(root).addButton((button) => button.setButtonText("保存问题").setDisabled(this.busy || !query.question.trim()).onClick(() => this.run(async () => {
			this.materials.question = await this.service.saveQuestion(query, result.items, this.materials.question);
			new Notice("问题及选材意图已保存。");
		}))).addButton((button) => button.setButtonText("核验并导出 Markdown").setCta().setDisabled(this.busy || !result.canFreeze || (!result.selectedItems.length && !result.memories.length)).onClick(() => this.run(async () => {
			if (this.materials.previewQuery !== JSON.stringify(query)) throw new Error("查询条件已改变，请先重新查找材料。");
			const output = await this.service.exportEvidence(query, result.selectedItems);
			await this.service.open(output.path);
			new Notice("证据包已核验并导出，来源和覆盖说明已包含在文件内。");
		})));
	}

	private renderItem(parent: HTMLElement, item: EvidenceItem): void {
		const query = this.materials.query;
		const selected = this.materials.result?.selectedItems.some((entry) => entry.evidenceId === item.evidenceId) ?? false;
		const card = parent.createDiv({ cls: "echo-notes-evidence-item" });
		new Setting(card).setName(`${item.meetingDate ?? "日期待补全"} · ${item.meetingTitle}`).setDesc(`${item.kind === "analysis" ? "AI 分析" : item.kind === "revised_transcript" ? "修订转写正文" : "原始转写正文"} · ${item.sourceCheck} · 命中 ${item.matches.map((match) => match.term).join("、")}`).addToggle((toggle) => toggle.setValue(selected).onChange((value) => {
			query.pinnedEvidenceIds = query.pinnedEvidenceIds.filter((id) => id !== item.evidenceId);
			query.excludedEvidenceIds = query.excludedEvidenceIds.filter((id) => id !== item.evidenceId);
			if (value) query.pinnedEvidenceIds.push(item.evidenceId);
			else query.excludedEvidenceIds.push(item.evidenceId);
			this.run(() => this.search());
		}));
		card.createEl("blockquote", { text: item.quote });
		const context = card.createEl("details");
		context.createEl("summary", { text: "查看前后文与出处" });
		if (item.contextBefore) context.createEl("p", { text: item.contextBefore });
		context.createEl("p", { text: item.quote });
		if (item.contextAfter) context.createEl("p", { text: item.contextAfter });
		context.createEl("code", { text: `${item.sourcePath}\n${item.sourceId}\nSHA-256 ${item.sourceRevision}\nUTF-16 [${item.sourceRange.start}, ${item.sourceRange.end})` });
		new Setting(context).addButton((button) => button.setButtonText("打开原文").onClick(() => { void this.service.open(item.sourcePath).catch((error: unknown) => { new Notice(error instanceof Error ? error.message : String(error)); }); })).addButton((button) => button.setButtonText(query.pinnedEvidenceIds.includes(item.evidenceId) ? "取消固定" : "固定纳入").onClick(() => {
			query.excludedEvidenceIds = query.excludedEvidenceIds.filter((id) => id !== item.evidenceId);
			query.pinnedEvidenceIds = query.pinnedEvidenceIds.includes(item.evidenceId) ? query.pinnedEvidenceIds.filter((id) => id !== item.evidenceId) : [...query.pinnedEvidenceIds, item.evidenceId];
			this.run(() => this.search());
		}));
	}
}

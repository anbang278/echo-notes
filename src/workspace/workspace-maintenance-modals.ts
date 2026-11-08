import { Modal, Notice, Setting, type App } from "obsidian";
import type { CatalogMigrationPlan, MeetingRecord, MeetingTime, ProjectRecord } from "../catalog/catalog-types";
import type { EvidenceKind } from "../evidence";
import type { MeetingWorkspaceService } from "./meeting-workspace-service";

function runModal(operation: () => Promise<void>): void {
	void operation().catch((error: unknown) => { new Notice(error instanceof Error ? error.message : String(error)); });
}

export class ProjectAssociationModal extends Modal {
	private selected = new Set<string>();
	private operation: "replace" | "add" | "remove";
	private result = "";

	constructor(app: App, private service: MeetingWorkspaceService, private meetings: MeetingRecord[], private projects: ProjectRecord[]) {
		super(app);
		this.operation = meetings.length > 1 ? "add" : "replace";
		if (meetings.length === 1) this.selected = new Set(meetings[0].projectIds);
	}

	onOpen(): void { this.setTitle("关联项目"); this.render(); }

	private render(): void {
		const root = this.contentEl; root.empty();
		root.createEl("p", { text: `本次将影响 ${this.meetings.length} 场会议。项目关联保存在会议记录中。` });
		new Setting(root).setName("操作方式").addDropdown((select) => select.addOption("replace", "替换关联").addOption("add", "追加关联").addOption("remove", "取消指定关联").setValue(this.operation).onChange((value) => { this.operation = value as typeof this.operation; }));
		for (const project of this.projects) {
			const duplicate = this.projects.some((other) => other.id !== project.id && other.name === project.name);
			new Setting(root).setName(project.name).setDesc(duplicate ? project.path : project.status === "archived" ? "已归档" : "进行中").addToggle((toggle) => toggle.setValue(this.selected.has(project.id)).onChange((value) => { if (value) this.selected.add(project.id); else this.selected.delete(project.id); }));
		}
		let name = "";
		new Setting(root).setName("新建项目名称").addText((text) => text.onChange((value) => { name = value; })).addButton((button) => button.setButtonText("新建项目").onClick(() => runModal(async () => {
			await this.service.createProject(name); this.projects = (await this.service.snapshot()).projects; this.render();
		})));
		let path = "";
		new Setting(root).setName("登记现有项目笔记").setDesc("输入 Vault 相对路径，保留项目正文和现有属性。").addText((text) => text.setPlaceholder("项目/订单履约.md").onChange((value) => { path = value; })).addButton((button) => button.setButtonText("登记").onClick(() => runModal(async () => {
			await this.service.registerExistingProject(path);
			this.projects = (await this.service.snapshot()).projects; this.render();
		})));
		if (this.result) root.createEl("p", { text: this.result, attr: { role: "status" } });
		new Setting(root).addButton((button) => button.setButtonText("保存关联").setCta().onClick(() => runModal(async () => {
			button.setDisabled(true);
			const failed: MeetingRecord[] = [];
			const errors: string[] = [];
			const current = await this.service.snapshot();
			for (const requested of this.meetings) {
				const meeting = current.meetings.find((item) => item.id === requested.id);
				try {
					if (!meeting) throw new Error("会议已不存在或存在身份冲突。");
					let ids = [...this.selected];
					if (this.operation === "add") ids = [...new Set([...meeting.projectIds, ...ids])];
					if (this.operation === "remove") ids = meeting.projectIds.filter((id) => !this.selected.has(id));
					await this.service.catalog.setMeetingProjects(meeting.id, ids);
				} catch (error) {
					failed.push(requested); errors.push(`${requested.title} — ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			this.result = `成功 ${this.meetings.length - failed.length} 场，失败 ${failed.length} 场${errors.length ? `\n${errors.join("\n")}` : ""}`;
			this.meetings = failed;
			this.service.notify();
			if (!failed.length) { new Notice(this.result); this.close(); } else this.render();
		})));
	}
}

export class MeetingMetadataModal extends Modal {
	constructor(app: App, private service: MeetingWorkspaceService, private meeting: MeetingRecord) { super(app); }

	onOpen(): void {
		this.setTitle("会议时间与描述");
		let precision = this.meeting.time.precision;
		let date = this.meeting.time.precision === "date" ? this.meeting.time.date : "";
		let start = this.meeting.time.precision === "instant" ? this.meeting.time.startedAt : "";
		let end = this.meeting.time.precision === "instant" ? this.meeting.time.endedAt ?? "" : "";
		let timezone = this.meeting.time.precision === "instant" ? this.meeting.time.timezone ?? this.service.timezone : this.service.timezone;
		let excerpt = this.meeting.excerpt ?? "";
		let tags = this.meeting.tags.join("，");
		new Setting(this.contentEl).setName("时间精度").addDropdown((select) => select.addOption("unknown", "日期待补全").addOption("date", "只知道日期").addOption("instant", "精确起止时间").setValue(precision).onChange((value) => { precision = value as typeof precision; }));
		new Setting(this.contentEl).setName("会议日期").addText((text) => { text.inputEl.type = "date"; text.setValue(date).onChange((value) => { date = value; }); });
		new Setting(this.contentEl).setName("实际开始时间").setDesc("使用包含时区的 ISO 时间，例如 2026-11-08T09:00:00+08:00。").addText((text) => text.setValue(start).onChange((value) => { start = value; }));
		new Setting(this.contentEl).setName("实际结束时间").setDesc("未知时留空。").addText((text) => text.setValue(end).onChange((value) => { end = value; }));
		new Setting(this.contentEl).setName("时区").addText((text) => text.setValue(timezone).setPlaceholder("Asia/Taipei").onChange((value) => { timezone = value; }));
		new Setting(this.contentEl).setName("人工简短描述").addTextArea((text) => text.setValue(excerpt).onChange((value) => { excerpt = value; }));
		new Setting(this.contentEl).setName("标签").setDesc("用逗号分隔。").addText((text) => text.setValue(tags).onChange((value) => { tags = value; }));
		new Setting(this.contentEl).addButton((button) => button.setButtonText("保存").setCta().onClick(() => runModal(async () => {
			let time: MeetingTime = { precision: "unknown", reason: "用户尚未确认会议日期" };
			if (precision === "date") time = { precision, date, source: "user", confirmed: true };
			if (precision === "instant") time = { precision, startedAt: start.trim(), ...(end.trim() ? { endedAt: end.trim() } : {}), timezone: timezone.trim(), source: "user", confirmed: true };
			await this.service.catalog.updateMeetingMetadata(this.meeting.id, { time, excerpt, tags: tags.split(/[,，、]/u).map((tag) => tag.trim()).filter(Boolean) });
			this.service.notify(); this.close();
		})));
	}
}

export class CatalogMaintenanceModal extends Modal {
	private plan: CatalogMigrationPlan | null = null;
	private message = "";
	private busy = false;
	private explicitPaths = "";

	constructor(app: App, private service: MeetingWorkspaceService) { super(app); }
	onOpen(): void { this.setTitle("会议资料维护"); this.render(); }

	private render(): void {
		const root = this.contentEl; root.empty();
		root.createEl("p", { text: "先盘点已登记会议、项目和明确来源，预览拟改文件。执行前逐项备份，中断后可接续。" });
		let timezone = this.service.timezone;
		new Setting(root).setName("会议显示时区").addText((text) => text.setValue(timezone).onChange((value) => { timezone = value.trim(); })).addButton((button) => button.setButtonText("保存时区").onClick(() => runModal(async () => { await this.service.setDisplayTimezone(timezone); this.message = "显示时区已保存。"; this.render(); })));
		new Setting(root).setName("额外盘点的明确转写文件").setDesc("每行一个 Vault 相对路径。其余只盘点已登记目录和配置的转写目录。").addTextArea((text) => text.setValue(this.explicitPaths).onChange((value) => { this.explicitPaths = value; }));
		new Setting(root).addButton((button) => button.setButtonText("盘点与迁移预览").setDisabled(this.busy).onClick(() => runModal(async () => { this.plan = await this.service.migrationPlan(this.explicitPaths.split(/\r?\n/).map((path) => path.trim()).filter(Boolean)); this.message = ""; this.render(); })));
		if (this.message) root.createEl("p", { text: this.message, attr: { role: "status" } });
		if (!this.plan) return;
		const plan = this.plan;
		root.createEl("p", { text: `拟修改 ${plan.items.length} 个文件，${plan.issues.length} 项异常。请核对后执行。` });
		for (const issue of plan.issues) root.createEl("p", { cls: "echo-notes-workspace-warning", text: `${issue.path} — ${issue.message}` });
		const list = root.createEl("ul");
		for (const item of plan.items) list.createEl("li", { text: `${item.kind} · ${item.path}` });
		new Setting(root).addButton((button) => button.setButtonText("备份并执行此迁移计划").setCta().setDisabled(this.busy || !plan.items.length).onClick(() => runModal(async () => {
			this.busy = true; this.render();
			try {
				const result = await this.service.applyMigration(plan);
				this.message = `已写入 ${result.written.length} 个，跳过 ${result.skipped.length} 个，冲突 ${result.conflicts.length} 个。${result.conflicts.map((item) => `\n${item.path} — ${item.message}`).join("")}`;
			} finally { this.busy = false; this.render(); }
		}))).addButton((button) => button.setButtonText("保护性回滚此计划").setDisabled(this.busy).onClick(() => runModal(async () => {
			const result = await this.service.catalog.rollbackMigration(plan.id);
			this.message = `已恢复 ${result.written.length} 个，跳过 ${result.skipped.length} 个，冲突 ${result.conflicts.length} 个。后续人工编辑会保留。`;
			this.service.notify(); this.render();
		})));
	}
}

export class AgentConnectionModal extends Modal {
	private kinds: EvidenceKind[] = ["approved_memory"];
	private message = "";
	private busy = false;

	constructor(app: App, private service: MeetingWorkspaceService) { super(app); }
	onOpen(): void { this.setTitle("连接外部 Agent"); this.render(); }

	private render(): void {
		const root = this.contentEl; root.empty();
		root.createEl("p", { text: "Codex 与 Hermes 使用同一只读协议。先选资料范围，再生成完整快照并明确连接本机 Vault。" });
		new Setting(root).setName("已批准记忆").addToggle((toggle) => toggle.setValue(this.kinds.includes("approved_memory")).onChange((value) => this.setKind("approved_memory", value)));
		new Setting(root).setName("原始与修订转写").setDesc("开启后允许查询会议原文。").addToggle((toggle) => toggle.setValue(this.kinds.includes("transcript")).onChange((value) => this.setKind("transcript", value)));
		new Setting(root).setName("AI 分析").setDesc("模型分析单独标注。").addToggle((toggle) => toggle.setValue(this.kinds.includes("analysis")).onChange((value) => this.setKind("analysis", value)));
		new Setting(root).addButton((button) => button.setButtonText("开启只读导出并生成快照").setCta().setDisabled(this.busy).onClick(() => this.execute(async () => {
			if (!this.kinds.length) throw new Error("请选择至少一种允许资料。");
			await this.service.setAgentAccess(true, this.kinds);
			this.message = await this.service.publishAgentSnapshot();
		}))).addButton((button) => button.setButtonText("健康检查").setDisabled(this.busy).onClick(() => this.execute(async () => { this.message = await this.service.agentStatus(); }))).addButton((button) => button.setButtonText("关闭导出").setDisabled(this.busy).onClick(() => this.execute(async () => {
			await this.service.setAgentAccess(false, this.kinds);
			this.message = "导出已关闭，官方读取器的下一次查询将拒绝旧快照。";
		})));
		if (this.message) root.createEl("pre", { text: this.message, cls: "echo-notes-workspace-command", attr: { role: "status" } });
		root.createEl("h3", { text: "首次连接" });
		root.createEl("p", { text: "Skill 测试包随本地交付提供。公开固定版本安装命令将在发布核验后提供。为所选 Hermes profile 使用相同安装和验证目录。" });
		const instructions = root.createEl("pre", { text: this.service.agentConnectionInstructions(this.kinds), cls: "echo-notes-workspace-command" });
		new Setting(root).addButton((button) => button.setButtonText("复制本机连接指引").onClick(() => this.execute(async () => { await navigator.clipboard.writeText(instructions.textContent ?? ""); this.message = "本机连接指引已复制。"; })));
	}

	private setKind(kind: EvidenceKind, value: boolean): void {
		this.kinds = value ? [...new Set([...this.kinds, kind])] : this.kinds.filter((item) => item !== kind);
		this.render();
	}

	private execute(operation: () => Promise<void>): void {
		if (this.busy) return;
		this.busy = true; this.render();
		void operation().catch((error: unknown) => { this.message = error instanceof Error ? error.message : String(error); }).finally(() => { this.busy = false; this.render(); });
	}
}

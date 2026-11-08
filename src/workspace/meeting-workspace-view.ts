import { ItemView, Modal, Notice, Setting, type WorkspaceLeaf } from "obsidian";
import type { MeetingRecord, ProjectRecord, CatalogSnapshot, MeetingTime } from "../catalog/catalog-types";
import { meetingDates } from "../catalog/catalog-time";
import { parseFormalTranscript, type EvidenceDocument, type EvidenceQueryV1, type EvidenceSearchResult, type QuestionRecord } from "../evidence";
import type EchoNotesPlugin from "../main";
import { MeetingWorkspaceService } from "./meeting-workspace-service";
import { createMeetingWorkspaceState, localDateKey, shiftDateKey, visibleWorkspaceMeetings, type MeetingWorkspaceState } from "./workspace-state";
import { EvidenceWorkspaceModal } from "./workspace-materials-modal";
import { AgentConnectionModal, CatalogMaintenanceModal, MeetingMetadataModal, ProjectAssociationModal } from "./workspace-maintenance-modals";

export const ECHO_NOTES_MEETING_VIEW_TYPE = "echo-notes-meeting-workspace";

export interface WorkspaceMaterials {
	query: EvidenceQueryV1;
	result: EvidenceSearchResult | null;
	previewQuery?: string;
	question?: QuestionRecord;
}

export class MeetingWorkspaceView extends ItemView {
	private state: MeetingWorkspaceState;
	private snapshot: CatalogSnapshot | null = null;
	private documents: EvidenceDocument[] = [];
	private questions: QuestionRecord[] = [];
	private unsubscribe: (() => void) | null = null;
	private revision = 0;
	private closed = false;
	private loading = true;
	private error = "";
	private filtersOpen = false;
	private searchFiltersOpen = false;
	private materials: WorkspaceMaterials;
	private detailModal: Modal | null = null;
	private readonly instanceId = `echo-meetings-${crypto.randomUUID()}`;

	constructor(leaf: WorkspaceLeaf, private plugin: EchoNotesPlugin, private service: MeetingWorkspaceService) {
		super(leaf);
		this.state = createMeetingWorkspaceState(plugin.settings.meetingWorkspaceMode, service.timezone);
		this.materials = { query: service.newQuery(), result: null };
	}

	setMode(mode: "reader" | "projects"): void { this.state.mode = mode; this.render(); }

	getViewType(): string { return ECHO_NOTES_MEETING_VIEW_TYPE; }
	getDisplayText(): string { return "Echo Notes 会议中心"; }
	getIcon(): string { return "calendar-days"; }

	async onOpen(): Promise<void> {
		this.closed = false;
		this.unsubscribe = this.service.subscribe(() => { void this.refresh(); });
		this.render();
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.closed = true;
		this.detailModal?.close();
		this.detailModal = null;
		this.revision++;
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.contentEl.empty();
	}

	private async refresh(): Promise<void> {
		const revision = ++this.revision;
		try {
			const snapshot = await this.service.snapshot();
			const [documents, questions] = await Promise.all([this.service.documents(snapshot), this.service.questions()]);
			if (this.closed || revision !== this.revision) return;
			this.snapshot = snapshot;
			this.documents = documents;
			this.questions = questions;
			this.error = "";
		} catch (error) {
			if (this.closed || revision !== this.revision) return;
			this.error = error instanceof Error ? error.message : String(error);
		}
		this.loading = false;
		this.render();
	}

	private run(operation: () => void | Promise<void>): void {
		Promise.resolve().then(operation).catch((error: unknown) => {
			new Notice(error instanceof Error ? error.message : String(error));
		});
	}

	private button(parent: HTMLElement, label: string, operation: () => void | Promise<void>, cls = ""): HTMLButtonElement {
		const button = parent.createEl("button", { text: label, cls, attr: { type: "button" } });
		button.addEventListener("click", () => this.run(operation));
		return button;
	}

	private render(): void {
		const focused = this.contentEl.contains(document.activeElement) ? document.activeElement as HTMLInputElement : null;
		const focusKey = focused?.dataset.focusKey;
		const selection = focused?.selectionStart;
		this.contentEl.empty();
		this.contentEl.addClass("echo-notes-workspace");
		this.contentEl.toggleClass("is-projects-mode", this.state.mode === "projects");
		this.contentEl.toggleClass("is-mobile-detail", this.state.mobileDetail);
		this.contentEl.toggleClass("is-filters-open", this.filtersOpen);
		this.contentEl.toggleClass("is-search-filters-open", this.searchFiltersOpen);
		this.renderHeader();
		if (this.loading) { this.contentEl.createEl("p", { text: "正在读取会议索引…", attr: { role: "status" } }); return; }
		if (this.error) {
			this.contentEl.createEl("p", { cls: "echo-notes-workspace-warning", text: this.error, attr: { role: "alert" } });
			this.button(this.contentEl, "重新读取", () => this.refresh());
			return;
		}
		if (!this.snapshot) return;
		this.renderDateHeading();
		this.renderFilters();
		if (this.snapshot.issues.length) {
			const notice = this.contentEl.createDiv({ cls: "echo-notes-workspace-warning", attr: { role: "status" } });
			notice.createSpan({ text: `${this.snapshot.issues.length} 项资料需要检查` });
			this.button(notice, "查看维护提示", () => { new CatalogMaintenanceModal(this.app, this.service).open(); });
		}
		const visible = visibleWorkspaceMeetings(this.snapshot, this.state, this.service.timezone);
		if (!visible.some((meeting) => meeting.id === this.state.selectedMeetingId)) this.state.selectedMeetingId = visible[0]?.id ?? null;
		const body = this.contentEl.createDiv({ cls: `echo-notes-workspace-body is-${this.state.mode}`, attr: { role: "tabpanel", id: `${this.instanceId}-panel`, "aria-labelledby": `${this.instanceId}-${this.state.mode}` } });
		if (this.state.mode === "projects") this.renderProjectSidebar(body);
		const list = body.createDiv({ cls: "echo-notes-workspace-meetings" });
		this.renderMeetingList(list, visible);
		const selected = visible.find((meeting) => meeting.id === this.state.selectedMeetingId);
		if (this.state.mode === "reader") {
			const detail = body.createDiv({ cls: "echo-notes-workspace-detail" });
			if (selected) this.renderDetail(detail, selected);
			else this.renderEmptyDetail(detail);
		} else this.renderProjectContext(body);
		if (this.detailModal && selected) {
			this.detailModal.contentEl.empty();
			this.renderDetail(this.detailModal.contentEl, selected);
		}
		this.renderMaterialBar();
		if (focusKey) {
			const replacement = this.contentEl.querySelector<HTMLInputElement>(`[data-focus-key="${focusKey}"]`);
			replacement?.focus();
			if (replacement?.type === "search" && selection !== null && selection !== undefined) replacement.setSelectionRange(selection, selection);
		}
	}

	private renderHeader(): void {
		const header = this.contentEl.createDiv({ cls: "echo-notes-workspace-header" });
		header.createEl("strong", { text: "Echo Notes" });
		const modes = header.createDiv({ cls: "echo-notes-workspace-modes", attr: { role: "tablist", "aria-label": "会议工作方式" } });
		const definitions = [{ mode: "reader" as const, text: "B 日期阅读器" }, { mode: "projects" as const, text: "C 项目工作台" }];
		definitions.forEach(({ mode, text }, index) => {
			const active = this.state.mode === mode;
			const button = this.button(modes, text, async () => {
				this.state.mode = mode;
				this.plugin.settings.meetingWorkspaceMode = mode;
				this.render();
				await this.plugin.saveSettings();
			});
			button.id = `${this.instanceId}-${mode}`;
			button.setAttribute("role", "tab");
			button.setAttribute("aria-controls", `${this.instanceId}-panel`);
			button.setAttribute("aria-selected", String(active));
			button.tabIndex = active ? 0 : -1;
			button.addEventListener("keydown", (event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const target = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
				this.state.mode = definitions[target].mode;
				this.plugin.settings.meetingWorkspaceMode = this.state.mode;
				this.render();
				this.contentEl.querySelector<HTMLButtonElement>(`#${this.instanceId}-${this.state.mode}`)?.focus();
				this.run(() => this.plugin.saveSettings());
			});
		});
		const tools = header.createDiv({ cls: "echo-notes-workspace-tools" });
		this.button(tools, "Agent 连接", () => { new AgentConnectionModal(this.app, this.service).open(); });
		this.button(tools, "维护", () => { new CatalogMaintenanceModal(this.app, this.service).open(); });
	}

	private renderDateHeading(): void {
		const heading = this.contentEl.createDiv({ cls: "echo-notes-workspace-date-heading" });
		const names = this.snapshot?.projects.filter((project) => this.state.projectIds.includes(project.id)).map((project) => project.name) ?? [];
		const text = this.state.mode === "projects" ? names.join("、") || "项目讨论工作台" : this.state.dateMode === "undated" ? "日期待补全" : this.state.date;
		heading.createEl("h2", { text });
		const controls = heading.createDiv({ cls: "echo-notes-workspace-date-controls" });
		this.button(controls, "前一天", () => { this.state.date = shiftDateKey(this.state.date, -1); this.state.dateMode = "day"; this.render(); });
		this.button(controls, "今天", () => { this.state.date = localDateKey(new Date(), this.service.timezone); this.state.dateMode = "day"; this.render(); });
		this.button(controls, "后一天", () => { this.state.date = shiftDateKey(this.state.date, 1); this.state.dateMode = "day"; this.render(); });
		const select = controls.createEl("select", { attr: { "aria-label": "会议日期范围" } });
		for (const [value, label] of [["day", "当天会议"], ["week", "近 7 天"], ["all", "全部日期"], ["undated", "日期待补全"]]) select.createEl("option", { text: label, value });
		select.value = this.state.dateMode;
		select.addEventListener("change", () => { this.state.dateMode = select.value as MeetingWorkspaceState["dateMode"]; this.render(); });
		const calendar = heading.createEl("details", { cls: "echo-notes-workspace-calendar-popover" });
		calendar.createEl("summary", { text: "日期导航" });
		this.renderCalendar(calendar);
	}

	private renderFilters(): void {
		const toggle = this.button(this.contentEl, `筛选 · ${this.state.projectIds.length} 个项目 · ${this.state.tags.length} 个标签${this.state.search ? " · 有关键词" : ""}`, () => { this.searchFiltersOpen = !this.searchFiltersOpen; this.render(); }, "echo-notes-workspace-search-toggle");
		toggle.setAttribute("aria-expanded", String(this.searchFiltersOpen));
		toggle.setAttribute("aria-controls", `${this.instanceId}-filters`);
		const filters = this.contentEl.createDiv({ cls: "echo-notes-workspace-filters", attr: { id: `${this.instanceId}-filters` } });
		const projects = filters.createDiv({ cls: "echo-notes-workspace-project-filters" });
		this.button(projects, "全部项目", () => { this.state.projectIds = []; this.state.unlinked = false; this.render(); }).setAttribute("aria-pressed", String(!this.state.projectIds.length && !this.state.unlinked));
		for (const project of this.snapshot?.projects ?? []) {
			const selected = this.state.projectIds.includes(project.id);
			this.button(projects, this.projectLabel(project), () => {
				this.state.projectIds = selected ? this.state.projectIds.filter((id) => id !== project.id) : [...this.state.projectIds, project.id];
				this.state.unlinked = false;
				this.render();
			}).setAttribute("aria-pressed", String(selected));
		}
		const search = filters.createEl("input", { type: "search", value: this.state.search, placeholder: "查找会议与摘要", attr: { "aria-label": "查找会议与摘要", "data-focus-key": "meeting-search" } });
		search.addEventListener("input", () => { this.state.search = search.value; this.render(); });
		const tags = filters.createEl("details", { cls: "echo-notes-workspace-tag-filters" });
		tags.createEl("summary", { text: this.state.tags.length ? `标签 ${this.state.tags.length}` : "标签筛选" });
		const options = tags.createDiv();
		for (const tag of [...new Set(this.snapshot?.meetings.flatMap((meeting) => meeting.tags) ?? [])].sort()) {
			new Setting(options).setName(tag).addToggle((toggle) => toggle.setValue(this.state.tags.includes(tag)).onChange((value) => {
				this.state.tags = value ? [...this.state.tags, tag] : this.state.tags.filter((item) => item !== tag);
				this.render();
			}));
		}
		this.button(filters, "清除筛选", () => { this.state.projectIds = []; this.state.tags = []; this.state.search = ""; this.state.unlinked = false; this.render(); });
	}

	private projectLabel(project: ProjectRecord): string {
		const duplicate = this.snapshot?.projects.some((other) => other.id !== project.id && other.name === project.name);
		return duplicate ? `${project.name} · ${project.path}` : project.name;
	}

	private renderProjectSidebar(parent: HTMLElement): void {
		this.button(parent, this.filtersOpen ? "收起项目导航" : "展开项目导航", () => { this.filtersOpen = !this.filtersOpen; this.render(); }, "echo-notes-workspace-filter-toggle");
		const sidebar = parent.createEl("aside", { cls: "echo-notes-workspace-sidebar", attr: { "aria-label": "项目导航" } });
		sidebar.createEl("h3", { text: "我的工作空间" });
		this.button(sidebar, "全部会议", () => { this.state.projectIds = []; this.state.unlinked = false; this.state.dateMode = "all"; this.render(); });
		this.button(sidebar, "未关联项目", () => { this.state.projectIds = []; this.state.unlinked = true; this.state.dateMode = "all"; this.render(); });
		this.button(sidebar, "日期待补全", () => { this.state.dateMode = "undated"; this.render(); });
		sidebar.createEl("h3", { text: "项目" });
		for (const project of this.snapshot?.projects ?? []) {
			const count = this.snapshot?.meetings.filter((meeting) => meeting.projectIds.includes(project.id)).length ?? 0;
			this.button(sidebar, `${this.projectLabel(project)} · ${count}`, () => {
				this.state.projectIds = [project.id]; this.state.unlinked = false; this.state.dateMode = "all"; this.filtersOpen = false; this.render();
			}).setAttribute("aria-pressed", String(this.state.projectIds.includes(project.id)));
		}
	}

	private renderMeetingList(parent: HTMLElement, meetings: MeetingRecord[]): void {
		parent.createEl("h3", { text: this.state.mode === "projects" ? `讨论时间线 · ${meetings.length} 场` : `${meetings.length} 场会议` });
		if (!meetings.length) {
			parent.createEl("p", { text: this.snapshot?.meetings.length ? "当前范围没有会议，调整日期或清除筛选。" : "开始录音或登记现有转写，会议会保存在这里。" });
			this.button(parent, "登记现有转写", () => this.openTranscriptRegistration());
			return;
		}
		let previousDate = "";
		for (const meeting of meetings) {
			const date = meetingDates(meeting.time, this.service.timezone)[0] ?? "日期待补全";
			if (this.state.mode === "projects" && date !== previousDate) { parent.createEl("h4", { text: date }); previousDate = date; }
			const card = parent.createDiv({ cls: "echo-notes-workspace-meeting-card" });
			card.toggleClass("is-selected", meeting.id === this.state.selectedMeetingId);
			const select = this.button(card, meeting.title, () => { this.state.selectedMeetingId = meeting.id;
				this.state.mobileDetail = this.state.mode === "reader";
				if (this.state.mode === "projects") this.openProjectDetail(meeting);
				this.render(); }, "echo-notes-workspace-meeting-title");
			select.setAttribute("aria-pressed", String(meeting.id === this.state.selectedMeetingId));
			card.createEl("p", { cls: "echo-notes-workspace-meta", text: this.timeLabel(meeting) });
			const excerpt = this.meetingExcerpt(meeting);
			card.createEl("p", { cls: "echo-notes-workspace-meeting-excerpt", text: excerpt.text });
			card.createEl("p", { cls: "echo-notes-workspace-meta", text: `${excerpt.kind} · ${this.stageLabel(meeting)}` });
		}
	}

	private openProjectDetail(meeting: MeetingRecord): void {
		this.detailModal?.close();
		const modal = new Modal(this.app);
		this.detailModal = modal;
		modal.modalEl.addClass("echo-notes-workspace-detail-dialog");
		modal.setTitle(meeting.title);
		modal.onClose = () => { this.detailModal = null; };
		this.renderDetail(modal.contentEl, meeting);
		modal.open();
	}

	private timeLabel(meeting: MeetingRecord): string {
		if (meeting.time.precision === "unknown") return "会议日期待补全";
		if (meeting.time.precision === "date") return `${meeting.time.date} · 时间未记录${meeting.time.warning ? ` · ${meeting.time.warning}` : ""}`;
		const format = new Intl.DateTimeFormat("zh-CN", { timeZone: this.service.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
		return `${format.format(new Date(meeting.time.startedAt))}${meeting.time.endedAt ? ` — ${format.format(new Date(meeting.time.endedAt))}` : " · 结束时间未记录"}${meeting.time.source === "recording" ? " · 录音记录时间" : ""}`;
	}

	private stageLabel(meeting: MeetingRecord): string {
		const stages = meeting.stages;
		const transcription = { none: "尚未转写", running: "转写中", done: "转写完成", failed: "转写失败" }[stages.transcription];
		const analysis = { none: "尚无分析", running: "分析中", done: "分析完成", failed: "分析失败", partial_failed: "部分分析失败" }[stages.analysis];
		return `${stages.recording === "recording" ? "录音中 · " : ""}${transcription} · ${analysis} · ${stages.memory === "available" ? "已有记忆资料" : "未提取记忆"}`;
	}

	private meetingExcerpt(meeting: MeetingRecord): { text: string; kind: string } {
		if (meeting.excerpt?.trim()) return { text: meeting.excerpt, kind: "人工描述" };
		if (meeting.summary?.trim()) return { text: meeting.summary, kind: "已有摘要" };
		const source = this.documents.find((document) => document.meetingId === meeting.id);
		const paragraph = source ? parseFormalTranscript(source.content).paragraphs[0]?.text : undefined;
		return paragraph ? { text: Array.from(paragraph).slice(0, 140).join(""), kind: "原文预览" } : { text: "尚无摘要，可打开录音或转写查看。", kind: "摘要待补充" };
	}

	private renderDetail(parent: HTMLElement, meeting: MeetingRecord): void {
		this.button(parent, "返回会议列表", () => { this.state.mobileDetail = false; this.render(); }, "echo-notes-workspace-back");
		const top = parent.createDiv({ cls: "echo-notes-workspace-detail-top" });
		top.createEl("p", { cls: "echo-notes-workspace-meta", text: this.timeLabel(meeting) });
		this.button(top, "打开原生笔记", () => this.service.open(meeting.path));
		parent.createEl("h2", { text: meeting.title });
		const projects = parent.createDiv({ cls: "echo-notes-workspace-detail-projects" });
		for (const id of meeting.projectIds) {
			const project = this.snapshot?.projects.find((item) => item.id === id);
			this.button(projects, project?.name ?? "项目缺失", () => { this.state.projectIds = [id]; this.state.mode = "projects"; this.state.dateMode = "all"; this.render(); });
		}
		this.button(projects, "关联项目", () => { new ProjectAssociationModal(this.app, this.service, [meeting], this.snapshot?.projects ?? []).open(); });
		this.button(projects, "编辑时间与描述", () => { new MeetingMetadataModal(this.app, this.service, meeting).open(); });
		const tabs = parent.createDiv({ cls: "echo-notes-workspace-detail-tabs", attr: { role: "tablist", "aria-label": "会议内容" } });
		const panelId = `${this.instanceId}-detail-panel`;
		const values = [{ id: "summary" as const, label: "摘要" }, { id: "transcript" as const, label: "原文" }, { id: "memory" as const, label: "记忆" }];
		values.forEach((tab, index) => {
			const button = this.button(tabs, tab.label, () => { this.state.detailTab = tab.id; this.render(); });
			button.id = `${this.instanceId}-detail-${tab.id}`;
			button.setAttribute("role", "tab"); button.setAttribute("aria-selected", String(tab.id === this.state.detailTab));
			button.setAttribute("aria-controls", panelId); button.tabIndex = tab.id === this.state.detailTab ? 0 : -1;
			button.addEventListener("keydown", (event) => {
				if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
				event.preventDefault();
				const target = event.key === "Home" ? 0 : event.key === "End" ? 2 : (index + (event.key === "ArrowLeft" ? 2 : 1)) % 3;
				this.state.detailTab = values[target].id; this.render();
				this.contentEl.querySelector<HTMLButtonElement>(`#${this.instanceId}-detail-${this.state.detailTab}`)?.focus();
			});
		});
		const panel = parent.createDiv({ cls: "echo-notes-workspace-detail-content", attr: { role: "tabpanel", id: panelId, "aria-labelledby": `${this.instanceId}-detail-${this.state.detailTab}` } });
		if (this.state.detailTab === "summary") {
			const excerpt = this.meetingExcerpt(meeting);
			panel.createEl("p", { cls: "echo-notes-workspace-meta", text: excerpt.kind });
			panel.createEl("p", { cls: "echo-notes-workspace-summary", text: excerpt.text });
			panel.createEl("p", { cls: "echo-notes-workspace-meta", text: this.stageLabel(meeting) });
		} else if (this.state.detailTab === "transcript") this.renderTranscript(panel, meeting);
		else this.renderMemory(panel, meeting);
		const resources = parent.createDiv({ cls: "echo-notes-workspace-resource-links" });
		if (meeting.stages.transcription === "failed" || meeting.stages.analysis === "failed" || meeting.stages.analysis === "partial_failed" || meeting.stages.recording === "interrupted") this.button(resources, "打开任务中心检查与重试", () => this.plugin.activateTaskCenterView());
		for (const recording of this.snapshot?.recordings.filter((item) => item.meetingId === meeting.id && item.path) ?? []) this.button(resources, "打开录音", () => this.service.open(recording.path!));
		this.button(resources, "从这场会议整理问题材料", () => this.openMaterials(meeting), "mod-cta");
	}

	private renderTranscript(parent: HTMLElement, meeting: MeetingRecord): void {
		const sources = this.documents.filter((document) => document.meetingId === meeting.id);
		if (!sources.length) parent.createEl("p", { text: "尚无可读取的转写。录音仍保留，可在任务中心检查转写状态。" });
		for (const source of sources) {
			this.button(parent, "打开来源转写", () => this.service.open(source.sourcePath));
			const parsed = parseFormalTranscript(source.content);
			if (parsed.status !== "ok") { parent.createEl("p", { text: "来源正文边界需要检查，请打开原文修复标记。", cls: "echo-notes-workspace-warning" }); continue; }
			for (const paragraph of parsed.paragraphs) {
				const block = parent.createDiv({ cls: "echo-notes-workspace-utterance" });
				if (paragraph.speaker) block.createEl("strong", { text: paragraph.speaker });
				block.createEl("p", { text: paragraph.text });
			}
		}
	}

	private renderMemory(parent: HTMLElement, meeting: MeetingRecord): void {
		parent.createEl("p", { text: "记忆需结合候选、人工审核、关系和有效期读取。" });
		this.button(parent, "读取本会议记忆状态", async () => {
			const memories = await this.service.memoryEvidence();
			const matched = memories.filter((memory) => memory.meetingId === meeting.id);
			parent.empty();
			if (!matched.length) parent.createEl("p", { text: "本会议暂无已登记记忆，原文可独立使用。" });
			for (const memory of matched) {
				const block = parent.createDiv({ cls: "echo-notes-workspace-utterance" });
				block.createEl("p", { text: memory.text });
				block.createEl("p", { cls: "echo-notes-workspace-meta", text: `${memory.approval} · ${memory.resolvedValidity} · 来源 ${memory.sourceCheck ?? "unsupported"}` });
			}
		});
	}

	private renderEmptyDetail(parent: HTMLElement): void {
		parent.createEl("h3", { text: "从一场对话开始阅读" });
		parent.createEl("p", { text: "选择会议，或调整日期与项目范围。" });
	}

	private renderProjectContext(parent: HTMLElement): void {
		const context = parent.createEl("aside", { cls: "echo-notes-workspace-project-context" });
		const project = this.snapshot?.projects.find((item) => this.state.projectIds.length === 1 && item.id === this.state.projectIds[0]);
		if (project) {
			context.createEl("h3", { text: project.name });
			context.createEl("p", { text: project.status === "archived" ? "已归档项目" : "进行中" });
			this.button(context, "打开项目背景", () => this.service.open(project.path));
		}
		context.createEl("h3", { text: "已保存问题" });
		const questions = this.questions.filter((question) => !this.state.projectIds.length || question.query.filters.projectIds.some((id) => this.state.projectIds.includes(id)));
		for (const question of questions) this.button(context, question.query.question, () => {
			this.materials = { query: structuredClone(question.query), result: null, question };
			new EvidenceWorkspaceModal(this.app, this.service, this.materials).open();
		});
		if (!questions.length) context.createEl("p", { text: "保存一个问题，下次继续补充资料。" });
		this.button(context, "整理问题材料", () => this.openMaterials(undefined, true), "mod-cta");
		this.renderCalendar(context);
		const visible = this.snapshot ? visibleWorkspaceMeetings(this.snapshot, this.state, this.service.timezone) : [];
		if (visible.length) this.button(context, `批量关联当前 ${visible.length} 场会议`, () => { new ProjectAssociationModal(this.app, this.service, visible, this.snapshot?.projects ?? []).open(); });
	}

	private renderCalendar(parent: HTMLElement): void {
		const month = this.state.date.slice(0, 7);
		const calendar = parent.createDiv({ cls: "echo-notes-workspace-calendar" });
		const heading = calendar.createDiv({ cls: "echo-notes-workspace-calendar-heading" });
		this.button(heading, "上月", () => { const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); this.state.date = d.toISOString().slice(0, 10); this.render(); });
		heading.createEl("strong", { text: month });
		this.button(heading, "下月", () => { const d = new Date(`${month}-15T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() + 1); this.state.date = d.toISOString().slice(0, 10); this.render(); });
		const native = calendar.createEl("input", { type: "date", value: this.state.date, cls: "echo-notes-workspace-calendar-native", attr: { "aria-label": "选择会议日期" } });
		native.addEventListener("change", () => { if (native.value) { this.state.date = native.value; this.state.dateMode = "day"; this.render(); } });
		const grid = calendar.createDiv({ cls: "echo-notes-workspace-calendar-grid", attr: { "aria-label": "会议月历" } });
		for (const day of ["日", "一", "二", "三", "四", "五", "六"]) grid.createSpan({ text: day });
		const scoped = this.snapshot ? visibleWorkspaceMeetings(this.snapshot, { ...this.state, dateMode: "all" }, this.service.timezone) : [];
		const counts = new Map<string, Set<string>>();
		for (const meeting of scoped) for (const date of meetingDates(meeting.time, this.service.timezone)) {
			if (!date.startsWith(month)) continue;
			if (!counts.has(date)) counts.set(date, new Set());
			counts.get(date)!.add(meeting.id);
		}
		const first = new Date(`${month}-01T12:00:00Z`);
		const start = shiftDateKey(`${month}-01`, -first.getUTCDay());
		for (let index = 0; index < 42; index++) {
			const date = shiftDateKey(start, index);
			const count = counts.get(date)?.size ?? 0;
			const button = this.button(grid, `${Number(date.slice(8))}${count ? ` · ${count}` : ""}`, () => { this.state.date = date; this.state.dateMode = "day"; this.state.mobileDetail = false; this.render(); });
			button.setAttribute("aria-label", `${date}，${count} 场会议`);
			button.setAttribute("aria-pressed", String(date === this.state.date && this.state.dateMode === "day"));
			button.toggleClass("is-other-month", !date.startsWith(month));
		}
	}

	private renderMaterialBar(): void {
		const bar = this.contentEl.createDiv({ cls: "echo-notes-workspace-material-bar" });
		bar.createEl("p", { text: "让历史，成为一个具体问题的材料。" });
		bar.createSpan({ text: `${this.materials.result?.selectedItems.length ?? 0} 段已选原文` });
		this.button(bar, "整理问题材料", () => this.openMaterials(), "mod-cta");
	}

	private openMaterials(meeting?: MeetingRecord, projectScope = false): void {
		if (meeting) {
			this.materials.query.filters.meetingIds = [meeting.id];
			this.materials.query.filters.projectIds = [];
		} else if (projectScope) {
			this.materials.query.filters.projectIds = [...this.state.projectIds];
			this.materials.query.filters.meetingIds = [];
		} else if (!this.materials.query.question && !this.materials.result) this.materials.query.filters.projectIds = [...this.state.projectIds];
		new EvidenceWorkspaceModal(this.app, this.service, this.materials).open();
	}

	private openTranscriptRegistration(): void {
		const modal = new Modal(this.app);
		modal.setTitle("登记现有转写");
		let path = "";
		modal.contentEl.createEl("p", { text: "输入现有转写的 Vault 相对路径。只登记该文件，会议日期可以稍后补全。" });
		new Setting(modal.contentEl).setName("转写文件").addText((text) => text.setPlaceholder("录音/讨论.transcript.md").onChange((value) => { path = value; }));
		new Setting(modal.contentEl).addButton((button) => button.setButtonText("登记").setCta().onClick(() => this.run(async () => {
			await this.service.registerTranscript(path.trim()); modal.close(); await this.refresh();
		})));
		modal.open();
	}
}

export function meetingTimeDraft(time: MeetingTime): string {
	if (time.precision === "date") return time.date;
	if (time.precision === "instant") return time.startedAt;
	return "";
}

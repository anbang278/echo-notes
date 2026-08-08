import { App, Modal, Notice, Setting } from "obsidian";
import {
	MEMORY_RELATION_TYPE_LABELS,
	MEMORY_RELATION_TYPES,
	getMemoryRelationEndpointKey,
	type MemoryRelationEndpoint,
	type MemoryRelationType
} from "./memory-relation";
import type { MemoryRelationContext } from "./memory-service";

interface MemoryRelationModalCallbacks {
	onConfirm: (input: {
		type: MemoryRelationType;
		source: MemoryRelationEndpoint;
		target: MemoryRelationEndpoint;
		note: string;
	}) => Promise<MemoryRelationContext>;
	onRevoke: (relationId: string, note: string) => Promise<MemoryRelationContext>;
}

export class MemoryRelationModal extends Modal {
	private context: MemoryRelationContext;
	private callbacks: MemoryRelationModalCallbacks;
	private selectedSourceKey = "";
	private selectedTargetKey = "";
	private selectedType: MemoryRelationType = "supersedes";
	private note = "";
	private revokeNotes = new Map<string, string>();
	private submitting = false;

	constructor(app: App, context: MemoryRelationContext, callbacks: MemoryRelationModalCallbacks) {
		super(app);
		this.context = context;
		this.callbacks = callbacks;
		this.syncSelections();
	}

	onOpen(): void {
		this.setTitle("管理已批准记忆关系");
		this.contentEl.addClass("echo-notes-memory-relation-modal");
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		const activeCount = this.context.relations.filter((item) => item.relation.status === "active").length;
		this.contentEl.createDiv({
			cls: "echo-notes-memory-relation-summary",
			text: `${this.context.candidate.source.transcriptTitle} · 当前已批准 ${this.context.currentApprovedEndpoints.length} · 相关关系 ${activeCount}`
		});

		this.renderRelationEditor();
		this.renderRelationList();
	}

	private renderRelationEditor(): void {
		const editor = this.contentEl.createDiv({ cls: "echo-notes-memory-relation-editor" });
		editor.createEl("h3", { text: "确认关系" });
		const sources = [...this.context.currentApprovedEndpoints]
			.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
		const source = sources.find((endpoint) => getMemoryRelationEndpointKey(endpoint) === this.selectedSourceKey);
		const targets = source ? this.getTargets(source) : [];
		const target = targets.find((endpoint) => getMemoryRelationEndpointKey(endpoint) === this.selectedTargetKey);

		if (sources.length === 0) {
			editor.createDiv({ cls: "echo-notes-memory-relation-empty", text: "当前候选包没有已批准断言。" });
			return;
		}

		new Setting(editor)
			.setName("当前断言")
			.addDropdown((dropdown) => {
				for (const endpoint of sources) {
					dropdown.addOption(getMemoryRelationEndpointKey(endpoint), formatEndpointOption(endpoint));
				}
				return dropdown.setValue(this.selectedSourceKey).onChange((value) => {
					this.selectedSourceKey = value;
					this.selectedTargetKey = "";
					this.syncSelections();
					this.render();
				});
			});
		new Setting(editor)
			.setName("关联断言")
			.addDropdown((dropdown) => {
				if (targets.length === 0) {
					dropdown.addOption("", "没有其他候选的同主体已批准断言").setDisabled(true);
					return dropdown;
				}
				for (const endpoint of targets) {
					dropdown.addOption(getMemoryRelationEndpointKey(endpoint), formatEndpointOption(endpoint, true));
				}
				return dropdown.setValue(this.selectedTargetKey).onChange((value) => {
					this.selectedTargetKey = value;
				});
			});
		new Setting(editor)
			.setName("关系类型")
			.addDropdown((dropdown) => {
				for (const type of MEMORY_RELATION_TYPES) {
					dropdown.addOption(type, MEMORY_RELATION_TYPE_LABELS[type]);
				}
				return dropdown.setValue(this.selectedType).onChange((value) => {
					this.selectedType = value as MemoryRelationType;
				});
			});
		new Setting(editor)
			.setName("关系备注")
			.addTextArea((text) => {
				text.inputEl.rows = 2;
				return text.setPlaceholder("可选").setValue(this.note).onChange((value) => {
					this.note = value;
				});
			});
		if (source && target) {
			this.renderComparison(editor, source, target);
		}
		const actions = new Setting(editor).setClass("echo-notes-memory-relation-actions");
		actions.addButton((button) => {
			button
				.setIcon("link-2")
				.setTooltip("保存已确认的记忆关系")
				.setCta()
				.setDisabled(this.submitting || !source || !target);
			button.buttonEl.createSpan({ text: "确认关系" });
			button.onClick(() => {
				if (source && target) {
					void this.confirm(source, target);
				}
			});
		});
	}

	private renderComparison(
		containerEl: HTMLElement,
		source: MemoryRelationEndpoint,
		target: MemoryRelationEndpoint
	): void {
		const comparison = containerEl.createDiv({ cls: "echo-notes-memory-relation-comparison" });
		comparison.createEl("h4", { text: `${["记忆 A", "记忆 B"].join(" / ")} 对比` });
		comparison.createDiv({
			cls: "echo-notes-memory-relation-comparison-hint",
			text: "示例：同一主体的“目标”与“状态”可能互相补充；同一目标后来发生变化时，可用“替代旧记忆”明确时间顺序。"
		});
		const fields = [
			["主体", source.subjectName, target.subjectName],
			["时间", formatObservedAt(source.observedAt), formatObservedAt(target.observedAt)],
			["关系/属性", source.predicate, target.predicate],
			["内容", source.effectiveValue, target.effectiveValue],
			["原文证据", source.evidenceQuote ?? "当前关系记录未保存证据，请打开候选包查看", target.evidenceQuote ?? "当前关系记录未保存证据，请打开候选包查看"]
		] as const;
		const grid = comparison.createDiv({ cls: "echo-notes-memory-relation-comparison-grid" });
		this.renderComparisonCard(grid, "记忆 A", source, fields.map((field) => [field[0], field[1]] as const));
		this.renderComparisonCard(grid, "记忆 B", target, fields.map((field) => [field[0], field[2]] as const));
		const differences = comparison.createDiv({ cls: "echo-notes-memory-relation-differences" });
		differences.createSpan({ text: normalizeSubject(source.subjectName) === normalizeSubject(target.subjectName) ? "主体相同" : "主体不同" });
		differences.createSpan({ text: source.observedAt === target.observedAt ? "同一时间" : `时间不同：${formatDateDistance(source.observedAt, target.observedAt)}` });
		differences.createSpan({ text: source.effectiveValue === target.effectiveValue ? "内容相同" : "内容存在差异" });
	}

	private renderComparisonCard(
		containerEl: HTMLElement,
		label: string,
		endpoint: MemoryRelationEndpoint,
		fields: ReadonlyArray<readonly [string, string]>
	): void {
		const card = containerEl.createDiv({ cls: "echo-notes-memory-relation-comparison-card" });
		card.createDiv({ cls: "echo-notes-memory-relation-comparison-label", text: label });
		card.createDiv({ cls: "echo-notes-memory-relation-comparison-subject", text: `${endpoint.subjectType} · ${endpoint.subjectName}` });
		for (const [field, value] of fields) {
			const row = card.createDiv({ cls: "echo-notes-memory-relation-comparison-field" });
			row.createSpan({ cls: "echo-notes-memory-relation-comparison-field-label", text: field });
			row.createSpan({ cls: "echo-notes-memory-relation-comparison-field-value", text: value });
		}
	}

	private renderRelationList(): void {
		const section = this.contentEl.createDiv({ cls: "echo-notes-memory-relation-section" });
		section.createEl("h3", { text: "关系记录" });
		const list = section.createDiv({ cls: "echo-notes-memory-relation-list" });
		if (this.context.relations.length === 0) {
			list.createDiv({ cls: "echo-notes-memory-relation-empty", text: "当前候选包没有关系记录。" });
			return;
		}
		for (const item of this.context.relations) {
			const relation = item.relation;
			const relationEl = list.createDiv({ cls: "echo-notes-memory-relation-item" });
			const status = relation.status === "revoked"
				? "已撤销"
				: item.applicable ? "生效" : "引用已变化";
			relationEl.createEl("h4", {
				cls: "echo-notes-memory-relation-item-title",
				text: `${MEMORY_RELATION_TYPE_LABELS[relation.type]} · ${status}`
			});
			relationEl.createDiv({
				cls: "echo-notes-memory-relation-endpoint",
				text: `来源：${formatEndpointDetail(relation.source)}`
			});
			relationEl.createDiv({
				cls: "echo-notes-memory-relation-endpoint",
				text: `目标：${formatEndpointDetail(relation.target)}`
			});
			relationEl.createDiv({
				cls: "echo-notes-memory-relation-meta",
				text: `${relation.id} · ${relation.updatedAt}${relation.note ? ` · ${relation.note}` : ""}`
			});
			if (relation.status === "active") {
				new Setting(relationEl)
					.setName("撤销备注")
					.addText((text) => text
						.setPlaceholder("可选")
						.setValue(this.revokeNotes.get(relation.id) ?? "")
						.onChange((value) => this.revokeNotes.set(relation.id, value)))
					.addButton((button) => {
						button.setIcon("unlink").setTooltip("撤销该关系").setDisabled(this.submitting);
						button.buttonEl.createSpan({ text: "撤销关系" });
						button.onClick(() => void this.revoke(relation.id));
					});
			}
		}
	}

	private async confirm(source: MemoryRelationEndpoint, target: MemoryRelationEndpoint): Promise<void> {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		this.render();
		try {
			this.context = await this.callbacks.onConfirm({
				type: this.selectedType,
				source,
				target,
				note: this.note
			});
			this.note = "";
			this.syncSelections();
		} catch (error) {
			new Notice(`记忆关系操作未完成：${getErrorMessage(error)}`);
		} finally {
			this.submitting = false;
			this.render();
		}
	}

	private async revoke(relationId: string): Promise<void> {
		if (this.submitting) {
			return;
		}
		this.submitting = true;
		this.render();
		try {
			this.context = await this.callbacks.onRevoke(relationId, this.revokeNotes.get(relationId) ?? "");
			this.revokeNotes.delete(relationId);
			this.syncSelections();
		} catch (error) {
			new Notice(`记忆关系操作未完成：${getErrorMessage(error)}`);
		} finally {
			this.submitting = false;
			this.render();
		}
	}

	private syncSelections(): void {
		const sources = [...this.context.currentApprovedEndpoints]
			.sort((left, right) => right.observedAt.localeCompare(left.observedAt));
		if (!sources.some((endpoint) => getMemoryRelationEndpointKey(endpoint) === this.selectedSourceKey)) {
			this.selectedSourceKey = sources[0] ? getMemoryRelationEndpointKey(sources[0]) : "";
		}
		const source = sources.find((endpoint) => getMemoryRelationEndpointKey(endpoint) === this.selectedSourceKey);
		const targets = source ? this.getTargets(source) : [];
		if (!targets.some((endpoint) => getMemoryRelationEndpointKey(endpoint) === this.selectedTargetKey)) {
			this.selectedTargetKey = targets[0] ? getMemoryRelationEndpointKey(targets[0]) : "";
		}
	}

	private getTargets(source: MemoryRelationEndpoint): MemoryRelationEndpoint[] {
		return this.context.approvedEndpoints
			.filter((endpoint) =>
				endpoint.candidatePath !== source.candidatePath &&
				endpoint.subjectType === source.subjectType &&
				normalizeSubject(endpoint.subjectName) === normalizeSubject(source.subjectName)
			)
			.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
	}
}

function formatEndpointOption(endpoint: MemoryRelationEndpoint, includeSource = false): string {
	const prefix = includeSource ? `${endpoint.observedAt.slice(0, 10)} · ` : "";
	return `${prefix}${endpoint.predicate}：${truncate(endpoint.effectiveValue, 72)}`;
}

function formatEndpointDetail(endpoint: MemoryRelationEndpoint): string {
	return `${endpoint.subjectName} · ${endpoint.predicate}：${truncate(endpoint.effectiveValue, 160)} · ${endpoint.candidatePath}`;
}

function normalizeSubject(value: string): string {
	return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function truncate(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function formatObservedAt(value: string): string {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function formatDateDistance(left: string, right: string): string {
	const leftTime = new Date(left).getTime();
	const rightTime = new Date(right).getTime();
	if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) {
		return "日期待确认";
	}
	const days = Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
	return days === 0 ? "同一天" : `${days} 天`;
}

function getErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { App, Modal, Setting } from "obsidian";
import { createDesktopAsrDiscovery, type DesktopAsrDiscovery, type AsrDiscoveryResult } from "./desktop-discovery-adapter";
import { ASR_DISCOVERY_FIELDS, ASR_DISCOVERY_LABELS, type AsrDiscoveryCandidate, type AsrDiscoveryField } from "./discovery-rules";

export interface AsrDiscoveryDraft { directory: string; result?: AsrDiscoveryResult; selectedId?: string }
export interface AsrDiscoveryHandle { cancel(): void; dispose(): void }
interface DiscoveryOptions {
	app: App;
	baseUrl: string;
	state: AsrDiscoveryDraft;
	isCurrent(): boolean;
	getValues(): Record<AsrDiscoveryField, string>;
	hasEdits(): boolean;
	apply(values: Partial<Record<AsrDiscoveryField, string>>): string | undefined;
	openManual(): void;
	scanner?: DesktopAsrDiscovery;
}

class AsrDirectoryModal extends Modal {
	private controller = new AbortController();
	private generation = 0;
	constructor(app: App, private scanner: DesktopAsrDiscovery, private initial: string, private current: () => boolean, private select: (path: string) => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText("选择 ASR 安装目录");
		this.modalEl.addClass("echo-notes-asr-directory-modal");
		this.contentEl.createEl("p", { text: "粘贴目录路径，或逐级打开文件夹。选择目录不会开始识别。", cls: "echo-notes-local-asr-desc" });
		let requested = this.initial || this.scanner.home, loaded = "", parent = "", cursor: number | undefined;
		const field = new Setting(this.contentEl).setName("当前位置").setClass("echo-notes-asr-directory-field");
		let input: HTMLInputElement;
		field.addText(text => { text.setValue(requested).onChange(value => { requested = value; loaded = ""; parent = ""; this.generation++; }); input = text.inputEl; input.spellcheck = false; input.setAttribute("aria-label", "当前位置"); });
		const controls = new Setting(this.contentEl).setClass("echo-notes-asr-actions");
		const message = this.contentEl.createEl("p", { attr: { role: "status", "aria-live": "polite" }, cls: "echo-notes-local-asr-desc" });
		const list = this.contentEl.createDiv({ cls: "echo-notes-asr-directory-list" });
		const more = this.contentEl.createEl("button", { text: "继续加载目录", attr: { type: "button" } }); more.hide();
		const load = async (append = false): Promise<void> => {
			const generation = ++this.generation;
			if (!append) { list.empty(); cursor = undefined; loaded = ""; }
			message.setText("正在读取当前目录…"); more.hide();
			try {
				const page = await this.scanner.browse(requested, append ? cursor : 0, this.controller.signal);
				if (!this.current() || this.controller.signal.aborted || generation !== this.generation) return;
				loaded = requested = page.path; parent = page.parent; cursor = page.nextCursor; input.value = page.path;
				for (const path of page.directories) {
					const button = list.createEl("button", { text: `▸ ${path.split(/[\\/]/).pop() || path}`, attr: { type: "button" } });
					button.addEventListener("click", () => { requested = path; void load(); });
				}
				message.setText(page.limited ? "已达到目录浏览限制，可粘贴更具体的路径后前往。" : !list.childElementCount ? "当前目录没有可浏览的子目录。" : "可继续打开子目录，或选择当前位置。");
				more.toggle(cursor !== undefined && !page.limited);
			} catch {
				if (!this.controller.signal.aborted && generation === this.generation) message.setText("无法读取目录，请检查路径与权限。" );
			}
		};
		controls.addButton(button => button.setButtonText("上一级").onClick(() => { if (parent) { requested = parent; void load(); } }));
		controls.addButton(button => button.setButtonText("前往").onClick(() => { void load(); }));
		more.addEventListener("click", () => { void load(true); });
		const footer = new Setting(this.contentEl).setClass("echo-notes-asr-actions");
		footer.addButton(button => button.setButtonText("选择此目录").setCta().onClick(async () => {
			if (requested !== loaded) await load();
			if (!loaded || !this.current() || this.controller.signal.aborted) return;
			this.select(loaded); this.close();
		}));
		footer.addButton(button => button.setButtonText("取消").onClick(() => this.close()));
		void load();
	}
	onClose(): void { this.controller.abort(); this.contentEl.empty(); }
}

class AsrConfigurationModal extends Modal {
	constructor(app: App, private candidate: AsrDiscoveryCandidate, private options: DiscoveryOptions, private applied: () => void) { super(app); }
	onOpen(): void {
		this.titleEl.setText("确认填入配置"); this.modalEl.addClass("echo-notes-asr-confirm-modal");
		this.contentEl.createEl("p", { text: "请核对将要修改的字段。填入后自动管理关闭，再由你主动启用。", cls: "echo-notes-local-asr-desc" });
		const existing = this.options.getValues();
		const patch: Partial<Record<AsrDiscoveryField, string>> = {};
		const rows = this.contentEl.createDiv({ cls: "echo-notes-asr-comparison" });
		for (const field of ASR_DISCOVERY_FIELDS) {
			const value = this.candidate.fields[field];
			const clearsCommand = field === "startCommand" || field === "stopCommand";
			if (value.value || clearsCommand) patch[field] = value.value;
			const row = rows.createDiv({ cls: "echo-notes-asr-comparison-row" });
			for (const [caption, text] of [[`当前${ASR_DISCOVERY_LABELS[field]}`, existing[field] || "未配置"], [`填入后${ASR_DISCOVERY_LABELS[field]}`, value.value || (clearsCommand ? "留空，需要补充" : `未识别，保留当前值：${existing[field] || "未配置"}（需要核对）`)]]) {
				const cell = row.createDiv(); cell.createEl("p", { text: caption, cls: "echo-notes-local-asr-desc" }); cell.createEl("code", { text });
			}
		}
		const needsReplace = this.options.hasEdits() || Boolean(existing.startCommand || existing.stopCommand || existing.workingDirectory);
		let replace = !needsReplace, reviewed = this.candidate.complete;
		const confirmation = (label: string, change: (checked: boolean) => void): void => {
			const row = this.contentEl.createEl("label", { cls: "echo-notes-asr-confirm-check" });
			const input = row.createEl("input", { attr: { type: "checkbox" } }); row.createSpan({ text: label });
			input.addEventListener("change", () => { change(input.checked); applyButton.disabled = !replace || !reviewed; });
		};
		if (needsReplace) confirmation("我确认替换当前配置，包括未保存的草稿", checked => { replace = checked; });
		if (!this.candidate.complete) confirmation("我已核对候选及所需参数；未识别的启停命令将留空，就绪地址需手动核对", checked => { reviewed = checked; });
		const error = this.contentEl.createEl("p", { attr: { role: "alert" }, cls: "echo-notes-local-asr-error" });
		const footer = this.contentEl.createDiv({ cls: "echo-notes-asr-actions" });
		const applyButton = footer.createEl("button", { text: "确认填入", cls: "mod-cta", attr: { type: "button" } });
		applyButton.disabled = !replace || !reviewed;
		applyButton.addEventListener("click", () => {
			if (!replace || !reviewed || !this.options.isCurrent()) return;
			const failure = this.options.apply(patch);
			if (failure) { error.setText(failure); return; }
			if (!this.candidate.complete) this.options.openManual();
			this.applied(); this.close();
		});
		footer.createEl("button", { text: "取消", attr: { type: "button" } }).addEventListener("click", () => this.close());
	}
	onClose(): void { this.contentEl.empty(); }
}

/** UI only coordinates static discovery and a confirmed, device-local settings write. */
export function mountAsrDiscovery(container: HTMLElement, options: DiscoveryOptions): AsrDiscoveryHandle {
	const { state } = options;
	const root = container.createDiv({ cls: "echo-notes-asr-discovery" });
	root.createEl("h3", { text: "指定安装目录" });
	root.createEl("p", { text: "选择存放服务程序或启停脚本的文件夹，不是模型缓存目录。", cls: "echo-notes-local-asr-desc" });
	const label = root.createEl("label", { text: "ASR 安装目录", attr: { for: "echo-notes-asr-directory" } }); label.addClass("echo-notes-asr-directory-label");
	const pathRow = root.createDiv({ cls: "echo-notes-asr-path-row" });
	const input = pathRow.createEl("input", { attr: { id: "echo-notes-asr-directory", type: "text", placeholder: "粘贴安装目录的绝对路径", autocomplete: "off", spellcheck: "false" } });
	input.value = state.directory;
	const browse = pathRow.createEl("button", { text: "选择目录…", attr: { type: "button" } });
	const actions = root.createDiv({ cls: "echo-notes-asr-actions" });
	const scan = actions.createEl("button", { text: "识别此目录", cls: "mod-cta", attr: { type: "button" } });
	const cancel = actions.createEl("button", { text: "取消识别", attr: { type: "button" } }); cancel.hide();
	root.createEl("p", { text: "只在所选目录内读取相关脚本、清单和说明；不执行命令，不发送文件。", cls: "echo-notes-local-asr-desc" });
	const results = root.createDiv({ cls: "echo-notes-asr-results" }); results.createEl("h3", { text: "识别结果" });
	const message = results.createEl("p", { cls: "echo-notes-local-asr-desc", attr: { role: "status", "aria-live": "polite" } });
	const candidates = results.createDiv({ attr: { role: "radiogroup", "aria-label": "选择识别出的服务" } });
	const preview = results.createDiv({ cls: "echo-notes-asr-candidate-preview" });
	let scanner = options.scanner, controller: AbortController | undefined, generation = 0, disposed = false;
	let modal: Modal | undefined;
	const current = (): boolean => !disposed && root.isConnected && options.isCurrent();
	const getScanner = (): DesktopAsrDiscovery => scanner ??= createDesktopAsrDiscovery();
	const stop = (): void => {
		generation++; if (controller) { controller.abort(); controller = undefined; message.setText("识别已取消，当前配置未改变。" ); }
		scan.disabled = !input.value.trim(); scan.setText("识别此目录"); cancel.hide(); modal?.close(); modal = undefined;
	};
	const showCandidate = (candidate: AsrDiscoveryCandidate): void => {
		state.selectedId = candidate.id; preview.empty(); preview.createEl("h3", { text: "候选配置" });
		for (const field of ASR_DISCOVERY_FIELDS) {
			const value = candidate.fields[field]; const row = preview.createDiv({ cls: "echo-notes-asr-candidate-field" });
			const heading = row.createDiv({ cls: "echo-notes-asr-value-heading" }); heading.createEl("strong", { text: ASR_DISCOVERY_LABELS[field] });
			heading.createSpan({ text: value.status === "identified" ? "已识别" : value.status === "candidate" ? "候选 · 需核对" : "需要补充", cls: "echo-notes-local-asr-desc" });
			row.createEl("code", { text: value.value || "暂未识别，保留空白" }); row.createEl("p", { text: `依据：${value.source}`, cls: "echo-notes-local-asr-desc" });
		}
		const evidence = preview.createEl("details"); evidence.createEl("summary", { text: "查看识别依据" });
		for (const issue of candidate.issues) evidence.createEl("p", { text: issue, cls: "echo-notes-local-asr-desc" });
		evidence.createEl("p", { text: "文件匹配只说明符合已支持的结构，不代表服务正在运行、模型已就绪或发布者身份可信。", cls: "echo-notes-local-asr-desc" });
		const button = preview.createEl("button", { text: candidate.complete ? "检查并填入配置" : "检查并填入候选字段", cls: "mod-cta echo-notes-asr-preview-apply", attr: { type: "button" } });
		button.addEventListener("click", () => {
			if (!current()) return;
			modal = new AsrConfigurationModal(options.app, candidate, options, () => { message.setText(candidate.complete ? "已填入配置，自动管理保持关闭。请主动启用后再进行转写。" : "已填入候选字段，请在手动配置中核对并补全。" ); });
			modal.open();
		});
	};
	const render = (): void => {
		candidates.empty(); preview.empty();
		const result = state.result;
		if (!result) { message.setText("指定目录并点击识别后，结果会显示在这里。" ); return; }
		const count = result.candidates.length;
		message.setText([count ? `找到 ${count} 个候选。请检查后确认填入。` : "没有识别到服务。已检查脚本、服务清单和说明文件；可选择其他目录或手动配置。", ...result.issues].join(" "));
		if (count === 1) state.selectedId = result.candidates[0].id;
		for (const candidate of result.candidates) {
			const row = candidates.createEl("label", { cls: "echo-notes-asr-candidate" });
			const radio = row.createEl("input", { attr: { type: "radio", name: "echo-notes-asr-candidate" } }); radio.checked = state.selectedId === candidate.id; row.toggleClass("is-selected", radio.checked);
			const copy = row.createDiv(); copy.createEl("strong", { text: candidate.label }); copy.createEl("p", { text: candidate.directory, cls: "echo-notes-asr-directory-value" });
			radio.addEventListener("change", () => { if (radio.checked) { for (const item of Array.from(candidates.children)) item.removeClass("is-selected"); row.addClass("is-selected"); showCandidate(candidate); } });
			if (radio.checked) showCandidate(candidate);
		}
	};
	input.addEventListener("input", () => { stop(); state.directory = input.value; state.result = undefined; state.selectedId = undefined; render(); });
	browse.addEventListener("click", () => {
		if (!current()) return;
		try {
			modal = new AsrDirectoryModal(options.app, getScanner(), state.directory, current, path => { if (!current()) return; modal = undefined; stop(); input.value = state.directory = path; state.result = undefined; state.selectedId = undefined; scan.disabled = false; render(); });
			modal.open();
		} catch { message.setText("无法加载目录浏览环境，请使用桌面版并重试。" ); }
	});
	scan.addEventListener("click", () => {
		if (!current()) return;
		stop(); const active = new AbortController(); controller = active; const request = ++generation;
		state.result = undefined; state.selectedId = undefined; candidates.empty(); preview.empty();
		scan.disabled = true; scan.setText("识别中…"); cancel.show(); message.setText("正在读取目录中的脚本、清单和说明文件…");
		void (async () => {
			try {
				const result = await getScanner().scan(state.directory, options.baseUrl, active.signal);
				if (!current() || active.signal.aborted || request !== generation) return;
				state.result = result; state.selectedId = undefined; state.directory = input.value = result.root; render();
			} catch {
				if (current() && !active.signal.aborted && request === generation) message.setText("无法读取安装目录，请检查路径与权限，或选择其他目录。" );
			} finally {
				if (current() && request === generation) { controller = undefined; scan.disabled = !input.value.trim(); scan.setText("识别此目录"); cancel.hide(); }
			}
		})();
	});
	cancel.addEventListener("click", stop); scan.disabled = !input.value.trim(); render();
	return { cancel: stop, dispose: () => { stop(); disposed = true; } };
}

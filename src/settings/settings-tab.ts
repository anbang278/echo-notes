import {
	App,
	FileSystemAdapter,
	Modal,
	Notice,
	Platform,
	PluginSettingTab,
	Setting,
	setIcon,
	ToggleComponent,
	type SettingDefinitionItem
} from "obsidian";
import type EchoNotesPlugin from "../main";
import {
	getProviderCapabilitySummary,
	getTranscriptionProviderCapability
} from "../providers/provider-capabilities";
import {
	diagnoseTranscriptionProviderSettings,
	type ProviderDiagnosticItem,
	type ProviderDiagnosticSeverity
} from "../providers/provider-diagnostics";
import { diagnoseAnalysisProviderSettings } from "../analysis/analysis-diagnostics";
import { diagnoseMemoryProviderSettings } from "../memory/memory-provider";
import { getSanitizedErrorMessage } from "../security/redaction";
import {
	clearStatusIndicator,
	renderStatusIndicator,
	type StatusIndicatorTone
} from "../ui/status-indicator";
import { SettingsSpotlight, type SettingsSpotlightStep } from "./settings-spotlight";
import {
	ANALYSIS_PROVIDER_DEFAULTS,
	ANALYSIS_PROVIDER_LABELS,
	AGENTPLAN_ANALYSIS_MODELS,
	ANALYSIS_TEMPLATE_CATEGORIES,
	COPY_LANGUAGE_LABELS,
	DEFAULT_ANALYSIS_TEMPLATE_VERSION,
	DEFAULT_ANALYSIS_SYSTEM_PROMPT,
	OFFLINE_TRANSCRIPTION_PROVIDER_LABELS,
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
	SILICONFLOW_TRANSCRIPTION_MODELS,
	TRANSCRIPTION_LANGUAGE_LABELS,
	createCustomAnalysisTemplate,
	formatHotkey,
	getAnalysisTemplateCategoryDefinition,
	groupAnalysisTemplatesByCategory,
	getOfflineTranscriptionProviderDefaults,
	getMosiTranscriptionModel,
	isAnalysisProviderId,
	isOfflineTranscriptionProviderId,
	normalizeTranscriptionLanguageForProvider,
	parseHotkeyInput,
	parseRecognitionKeywordsInput,
	restoreDefaultAnalysisTemplate,
	type AnalysisProviderId,
	type AnalysisTemplateConfig,
	type AnalysisTemplateCategoryId,
	type AgentPlanSpeakerLabelStyle,
	type CopyLanguage,
	type EchoNotesHotkeySetting,
	type InsertStyle,
	type MemoryMode,
	type OfflineTranscriptionProviderId,
	type OutputStrategy,
	type TranscriptionConfig
} from "./settings";

type SettingsStage = "transcription" | "analysis" | "memory";

type TranscriptionSettingsSection = "service" | "recording" | "output" | "automation";
type AnalysisSettingsSection = "model" | "processing" | "templates";
type MemorySettingsSection = "workspace" | "model" | "processing";

export type EchoNotesSettingsDestination =
	| "transcription-service"
	| "analysis-model"
	| "memory-model"
	| "transcription-recording";

export type EchoNotesSettingsGuide = "provider-api-key";

export interface EchoNotesSettingsNavigationOptions {
	guide?: EchoNotesSettingsGuide;
	onGuideFinished?: () => void;
}

type SettingsGuideStep = "analysis-enable" | "provider" | "api-key";

type ActiveSettingsGuide = {
	destination: Extract<EchoNotesSettingsDestination, "transcription-service" | "analysis-model" | "memory-model">;
	step: SettingsGuideStep;
};

type SettingsSectionDefinition<T extends string> = {
	id: T;
	label: string;
};

type SettingsWorkflowStep =
	| { id: SettingsStage; label: string; enabled: true }
	| { id: "agent"; label: string; enabled: false; status: string };

const SETTINGS_WORKFLOW_STEPS: readonly SettingsWorkflowStep[] = [
	{ id: "transcription", label: "录音转写", enabled: true },
	{ id: "analysis", label: "AI 分析", enabled: true },
	{ id: "memory", label: "记忆提取", enabled: true },
	{ id: "agent", label: "调用外部 Agent", enabled: false, status: "研发中" }
];

const ENABLED_SETTINGS_STAGES: readonly SettingsStage[] = ["transcription", "analysis", "memory"];

const ECHO_NOTES_README_URL =
	"https://github.com/anbang278/echo-notes/blob/main/README.zh-CN.md";

const TRANSCRIPTION_SETTINGS_SECTIONS: readonly SettingsSectionDefinition<TranscriptionSettingsSection>[] = [
	{ id: "service", label: "转写服务" },
	{ id: "recording", label: "录音控制" },
	{ id: "output", label: "输出规则" },
	{ id: "automation", label: "自动化与日志" }
];

const ANALYSIS_SETTINGS_SECTIONS: readonly SettingsSectionDefinition<AnalysisSettingsSection>[] = [
	{ id: "model", label: "模型配置" },
	{ id: "processing", label: "处理策略" },
	{ id: "templates", label: "模板管理" }
];

const MEMORY_SETTINGS_SECTIONS: readonly SettingsSectionDefinition<MemorySettingsSection>[] = [
	{ id: "workspace", label: "记忆工作区" },
	{ id: "model", label: "模型配置" },
	{ id: "processing", label: "编译策略" }
];

export class EchoNotesSettingTab extends PluginSettingTab {
	private plugin: EchoNotesPlugin;
	private settingsContainerEl: HTMLElement | null = null;
	private activeSettingsStage: SettingsStage = "transcription";
	private activeTranscriptionSettingsSection: TranscriptionSettingsSection = "service";
	private activeAnalysisSettingsSection: AnalysisSettingsSection = "model";
	private activeMemorySettingsSection: MemorySettingsSection = "workspace";
	private activeAnalysisTemplateCategory: AnalysisTemplateCategoryId = "general";
	private settingsRenderSequence = 0;
	private readonly settingsSpotlight: SettingsSpotlight;
	private activeSettingsGuide: ActiveSettingsGuide | null = null;
	private settingsGuideSyncTimer: number | null = null;
	private settingsGuideFinished: (() => void) | null = null;
	private deferredSaveTimers = new Map<string, number>();
	private customTranscriptionModelProvider: OfflineTranscriptionProviderId | null = null;

	constructor(app: App, plugin: EchoNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		this.settingsSpotlight = new SettingsSpotlight(app);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Echo Notes settings",
				searchable: false,
					render: (setting) => {
					const settingEl = setting.settingEl;
					settingEl.empty();
					settingEl.addClass("echo-notes-settings-definition-row");
					const hostEl = settingEl.createDiv({
						cls: "echo-notes-settings-definition-host"
					});
					this.renderSettings(hostEl);
					return () => {
						if (this.settingsContainerEl === hostEl) {
							this.closeSettingsGuide(true);
							this.settingsContainerEl = null;
						}
						hostEl.remove();
						if (!settingEl.querySelector(":scope > .echo-notes-settings-definition-host")) {
							settingEl.removeClass("echo-notes-settings-definition-row");
						}
					};
				}
			}
		];
	}

	display(): void {
		this.renderSettings(this.containerEl);
	}

	hide(): void {
		this.closeSettingsGuide(true);
		this.clearDeferredSaveTimers();
		this.customTranscriptionModelProvider = null;
		super.hide();
	}

	showDestination(
		destination: EchoNotesSettingsDestination,
		options: EchoNotesSettingsNavigationOptions = {}
	): void {
		switch (destination) {
			case "transcription-service":
				this.activeSettingsStage = "transcription";
				this.activeTranscriptionSettingsSection = "service";
				break;
			case "analysis-model":
				this.activeSettingsStage = "analysis";
				this.activeAnalysisSettingsSection = "model";
				break;
			case "memory-model":
				this.activeSettingsStage = "memory";
				this.activeMemorySettingsSection = "model";
				break;
			case "transcription-recording":
				this.activeSettingsStage = "transcription";
				this.activeTranscriptionSettingsSection = "recording";
				break;
		}
		if (options.guide === "provider-api-key" && destination !== "transcription-recording") {
			this.activeSettingsGuide = {
				destination,
				step: destination === "analysis-model" && !this.plugin.settings.analysisEnabled
					? "analysis-enable"
					: "provider"
			};
			this.settingsGuideFinished = options.onGuideFinished ?? null;
		} else {
			this.closeSettingsGuide();
		}
		if (this.settingsContainerEl?.isConnected) {
			this.refreshSettings();
		}
	}

	closeSettingsGuide(notifyFinished = false): void {
		if (this.settingsGuideSyncTimer !== null) {
			window.clearTimeout(this.settingsGuideSyncTimer);
			this.settingsGuideSyncTimer = null;
		}
		this.activeSettingsGuide = null;
		this.settingsSpotlight.close();
		const onFinished = this.settingsGuideFinished;
		this.settingsGuideFinished = null;
		if (notifyFinished) {
			onFinished?.();
		}
	}

	private renderSettings(containerEl: HTMLElement): void {
		this.settingsContainerEl = containerEl;
		containerEl.closest<HTMLElement>(".modal-content")?.addClass("echo-notes-settings-modal-content");
		containerEl.empty();
		const renderId = ++this.settingsRenderSequence;
		this.renderSettingsIntroduction(containerEl, renderId);
		const workflowEl = this.renderSettingsWorkflow(containerEl, renderId);

		const transcriptionPanelEl = containerEl.createDiv({ cls: "echo-notes-settings-panel" });
		transcriptionPanelEl.id = `echo-notes-settings-panel-${renderId}-transcription`;
		transcriptionPanelEl.setAttribute("role", "tabpanel");
		transcriptionPanelEl.setAttribute(
			"aria-labelledby",
			`echo-notes-settings-step-${renderId}-transcription`
		);
		this.renderTranscriptionSettings(transcriptionPanelEl, renderId);

		const analysisPanelEl = containerEl.createDiv({ cls: "echo-notes-settings-panel" });
		analysisPanelEl.id = `echo-notes-settings-panel-${renderId}-analysis`;
		analysisPanelEl.setAttribute("role", "tabpanel");
		analysisPanelEl.setAttribute(
			"aria-labelledby",
			`echo-notes-settings-step-${renderId}-analysis`
		);
		this.renderAnalysisSettings(analysisPanelEl, renderId);

		const memoryPanelEl = containerEl.createDiv({ cls: "echo-notes-settings-panel" });
		memoryPanelEl.id = `echo-notes-settings-panel-${renderId}-memory`;
		memoryPanelEl.setAttribute("role", "tabpanel");
		memoryPanelEl.setAttribute(
			"aria-labelledby",
			`echo-notes-settings-step-${renderId}-memory`
		);
		this.renderMemorySettings(memoryPanelEl, renderId);

		this.activateSettingsStage(
			workflowEl,
			{
				transcription: transcriptionPanelEl,
				analysis: analysisPanelEl,
				memory: memoryPanelEl
			},
			this.activeSettingsStage,
			false
		);
		this.scheduleSettingsGuideSync();
	}

	private renderSettingsIntroduction(containerEl: HTMLElement, renderId: number): void {
		const headingId = `echo-notes-settings-intro-title-${renderId}`;
		const introEl = containerEl.createEl("section", {
			cls: "echo-notes-settings-intro",
			attr: { "aria-labelledby": headingId }
		});
		const headingContent = createFragment();
		const titleMarkEl = headingContent.createSpan({ cls: "echo-notes-settings-intro-title-mark" });
		titleMarkEl.setAttribute("aria-hidden", "true");
		setIcon(titleMarkEl, "audio-waveform");
		headingContent.createSpan({ text: "记录行动，构建面向未来的 AI Memory" });
		const headingSetting = new Setting(introEl)
			.setName(headingContent)
			.setClass("echo-notes-settings-intro-heading")
			.setHeading();
		const headingEl = headingSetting.nameEl;
		headingEl.addClass("echo-notes-settings-intro-title");
		headingEl.id = headingId;
		const conceptEl = introEl.createEl("p", { cls: "echo-notes-settings-intro-copy" });
		conceptEl.createSpan({
			text: "Echo Notes 以录音为入口，将转写与 AI 分析沉淀为 Vault 中可搜索、可链接、可长期复用的 Markdown 上下文，并为未来的 Personal Agent 构建个人记忆。 "
		});
		const readmeLinkEl = conceptEl.createEl("a", {
			cls: "echo-notes-settings-intro-link echo-notes-settings-intro-inline-action",
			text: "查看完整设计理念",
			attr: {
				href: ECHO_NOTES_README_URL,
				target: "_blank",
				rel: "noopener noreferrer"
			}
		});
		const iconEl = readmeLinkEl.createSpan({ cls: "echo-notes-settings-intro-link-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, "external-link");
		conceptEl.createSpan({
			cls: "echo-notes-settings-intro-link-separator",
			text: "·",
			attr: { "aria-hidden": "true" }
		});
		const gettingStartedButtonEl = conceptEl.createEl("button", {
			cls: "echo-notes-settings-intro-guide-link echo-notes-settings-intro-inline-action",
			attr: { type: "button" }
		});
		gettingStartedButtonEl.createSpan({
			cls: "echo-notes-settings-intro-guide-link-label",
			text: "新人指引"
		});
		const gettingStartedIconEl = gettingStartedButtonEl.createSpan({
			cls: "echo-notes-settings-intro-guide-link-icon"
		});
		gettingStartedIconEl.setAttribute("aria-hidden", "true");
		setIcon(gettingStartedIconEl, "compass");
		gettingStartedButtonEl.addEventListener("click", () => void this.plugin.openGettingStarted());
		containerEl.createEl("p", {
			cls: "echo-notes-settings-intro-guide",
			text: "操作指引：请按下方工作流选择阶段，再进入对应分类完成必要配置。"
		});
	}

	private renderSettingsWorkflow(containerEl: HTMLElement, renderId: number): HTMLElement {
		const workflowEl = containerEl.createDiv({ cls: "echo-notes-settings-workflow" });
		workflowEl.setAttribute("role", "tablist");
		workflowEl.setAttribute("aria-label", "Echo Notes 工作流设置");

		SETTINGS_WORKFLOW_STEPS.forEach((step, index) => {
			const buttonEl = workflowEl.createEl("button", {
				cls: "echo-notes-settings-step",
				attr: { type: "button", role: "tab" }
			});
			buttonEl.id = `echo-notes-settings-step-${renderId}-${step.id}`;
			buttonEl.dataset.settingsStage = step.id;
			buttonEl.createSpan({
				cls: "echo-notes-settings-step-number",
				text: String(index + 1)
			});
			const labelEl = buttonEl.createSpan({ cls: "echo-notes-settings-step-label" });
			labelEl.createSpan({ text: step.label });

			if (!step.enabled) {
				buttonEl.disabled = true;
				buttonEl.tabIndex = -1;
				buttonEl.setAttribute("aria-disabled", "true");
				buttonEl.setAttribute("aria-selected", "false");
				labelEl.createSpan({
					cls: "echo-notes-settings-step-status",
					text: step.status
				});
				return;
			}

			buttonEl.setAttribute(
				"aria-controls",
				`echo-notes-settings-panel-${renderId}-${step.id}`
			);
			buttonEl.addEventListener("click", () => {
				this.closeSettingsGuide();
				this.activateSettingsStageFromWorkflow(workflowEl, step.id);
			});
			buttonEl.addEventListener("keydown", (event) => {
				this.handleSettingsStageKeydown(event, workflowEl, step.id);
			});
		});

		return workflowEl;
	}

	private activateSettingsStageFromWorkflow(workflowEl: HTMLElement, stage: SettingsStage): void {
		const containerEl = workflowEl.parentElement;
		const transcriptionPanelEl = containerEl?.querySelector<HTMLElement>(
			'.echo-notes-settings-panel[role="tabpanel"][id$="-transcription"]'
		);
		const analysisPanelEl = containerEl?.querySelector<HTMLElement>(
			'.echo-notes-settings-panel[role="tabpanel"][id$="-analysis"]'
		);
		const memoryPanelEl = containerEl?.querySelector<HTMLElement>(
			'.echo-notes-settings-panel[role="tabpanel"][id$="-memory"]'
		);
		if (!transcriptionPanelEl || !analysisPanelEl || !memoryPanelEl) {
			return;
		}

		this.activateSettingsStage(
			workflowEl,
			{
				transcription: transcriptionPanelEl,
				analysis: analysisPanelEl,
				memory: memoryPanelEl
			},
			stage
		);
	}

	private activateSettingsStage(
		workflowEl: HTMLElement,
		panels: Record<SettingsStage, HTMLElement>,
		stage: SettingsStage,
		moveFocus = true
	): void {
		this.activeSettingsStage = stage;
		for (const candidate of ENABLED_SETTINGS_STAGES) {
			const isActive = candidate === stage;
			const buttonEl = workflowEl.querySelector<HTMLButtonElement>(
				`[data-settings-stage="${candidate}"]`
			);
			buttonEl?.toggleClass("is-active", isActive);
			buttonEl?.setAttribute("aria-selected", String(isActive));
			if (buttonEl) {
				buttonEl.tabIndex = isActive ? 0 : -1;
			}
			panels[candidate].hidden = !isActive;
		}

		if (moveFocus) {
			workflowEl
				.querySelector<HTMLButtonElement>(`[data-settings-stage="${stage}"]`)
				?.focus();
		}
	}

	private handleSettingsStageKeydown(
		event: KeyboardEvent,
		workflowEl: HTMLElement,
		stage: SettingsStage
	): void {
		let targetIndex: number;
		const currentIndex = ENABLED_SETTINGS_STAGES.indexOf(stage);
		switch (event.key) {
			case "ArrowLeft":
				targetIndex = (currentIndex - 1 + ENABLED_SETTINGS_STAGES.length) % ENABLED_SETTINGS_STAGES.length;
				break;
			case "ArrowRight":
				targetIndex = (currentIndex + 1) % ENABLED_SETTINGS_STAGES.length;
				break;
			case "Home":
				targetIndex = 0;
				break;
			case "End":
				targetIndex = ENABLED_SETTINGS_STAGES.length - 1;
				break;
			default:
				return;
		}

		event.preventDefault();
		this.closeSettingsGuide();
		this.activateSettingsStageFromWorkflow(workflowEl, ENABLED_SETTINGS_STAGES[targetIndex]);
	}

	private renderSettingsSectionTabs<T extends string>(
		containerEl: HTMLElement,
		renderId: number,
		namespace: SettingsStage,
		ariaLabel: string,
		sections: readonly SettingsSectionDefinition<T>[],
		activeSection: T,
		renderSection: (section: T, panelEl: HTMLElement) => void,
		onActiveSectionChange: (section: T) => void
	): void {
		const tabsEl = containerEl.createDiv({ cls: "echo-notes-settings-section-tabs" });
		tabsEl.setAttribute("role", "tablist");
		tabsEl.setAttribute("aria-label", ariaLabel);
		tabsEl.setAttribute("aria-orientation", "horizontal");
		tabsEl.style.setProperty("--echo-notes-settings-section-columns", String(sections.length));

		const buttonEls = new Map<T, HTMLButtonElement>();
		const panelEls = new Map<T, HTMLElement>();
		const activate = (section: T, moveFocus = true): void => {
			onActiveSectionChange(section);
			for (const candidate of sections) {
				const isActive = candidate.id === section;
				const buttonEl = buttonEls.get(candidate.id);
				const panelEl = panelEls.get(candidate.id);
				buttonEl?.toggleClass("is-active", isActive);
				buttonEl?.setAttribute("aria-selected", String(isActive));
				if (buttonEl) {
					buttonEl.tabIndex = isActive ? 0 : -1;
				}
				if (panelEl) {
					panelEl.hidden = !isActive;
				}
			}
			if (moveFocus) {
				buttonEls.get(section)?.focus();
			}
		};

		for (const [index, section] of sections.entries()) {
			const tabId = `echo-notes-settings-section-${renderId}-${namespace}-${section.id}`;
			const panelId = `echo-notes-settings-section-panel-${renderId}-${namespace}-${section.id}`;
			const buttonEl = tabsEl.createEl("button", {
				cls: "echo-notes-settings-section-tab",
				text: section.label,
				attr: {
					type: "button",
					role: "tab",
					id: tabId,
					"aria-controls": panelId
				}
			});
			buttonEls.set(section.id, buttonEl);
			buttonEl.addEventListener("click", () => {
				this.closeSettingsGuide();
				activate(section.id);
			});
			buttonEl.addEventListener("keydown", (event) => {
				let targetIndex: number;
				switch (event.key) {
					case "ArrowLeft":
						targetIndex = (index - 1 + sections.length) % sections.length;
						break;
					case "ArrowRight":
						targetIndex = (index + 1) % sections.length;
						break;
					case "Home":
						targetIndex = 0;
						break;
					case "End":
						targetIndex = sections.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				this.closeSettingsGuide();
				activate(sections[targetIndex].id);
			});

			const panelEl = containerEl.createDiv({ cls: "echo-notes-settings-section-panel" });
			panelEl.id = panelId;
			panelEl.setAttribute("role", "tabpanel");
			panelEl.setAttribute("aria-labelledby", tabId);
			panelEls.set(section.id, panelEl);
			renderSection(section.id, panelEl);
			this.markUniformSettingsFields(panelEl);
		}

		activate(activeSection, false);
	}

	private markUniformSettingsFields(containerEl: HTMLElement): void {
		containerEl.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
			'.setting-item-control > input[type="text"], ' +
			'.setting-item-control > input[type="password"], ' +
			'.setting-item-control > input[type="number"], ' +
			'.setting-item-control > input[type="url"], ' +
			'.setting-item-control > input[type="search"], ' +
			'.setting-item-control > select'
		).forEach((fieldEl) => fieldEl.addClass("echo-notes-settings-field"));
	}

	private renderTranscriptionOutputSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("输出目录策略")
			.setDesc("选择 transcript 生成位置。括号内为配置文件中的英文枚举值。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("same-name-subfolder", "同名子目录（same-name-subfolder）")
					.addOption("same-folder", "音频同目录（same-folder）")
					.addOption("custom-folder", "自定义目录（custom-folder）")
					.setValue(this.plugin.settings.outputStrategy)
					.onChange(async (value) => {
						this.plugin.settings.outputStrategy = value as OutputStrategy;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})
			);

		new Setting(containerEl)
			.setName("自定义输出目录")
			.setDesc("仅在“自定义目录（custom-folder）”策略下使用。为避免不同目录的同名音频互相覆盖，transcript 文件名会追加源路径短 hash。")
			.addText((text) =>
				text
					.setPlaceholder("Transcripts")
					.setValue(this.plugin.settings.customOutputFolder)
					.onChange(async (value) => {
						this.plugin.settings.customOutputFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("插入链接样式")
			.setDesc("选择插入到原笔记的 transcript 链接样式。")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("linkOnly", "普通内部链接（LinkOnly）")
					.addOption("callout", "提示块样式（callout）")
					.setValue(this.plugin.settings.insertStyle)
					.onChange(async (value) => {
						this.plugin.settings.insertStyle = value as InsertStyle;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("文案语言")
			.setDesc("控制插回原笔记的链接别名，以及转写稿正文中的标题和字段文案。")
			.addDropdown((dropdown) =>
				Object.entries(COPY_LANGUAGE_LABELS)
					.reduce((control, [value, label]) => control.addOption(value, label), dropdown)
					.setValue(this.plugin.settings.copyLanguage)
					.onChange(async (value) => {
						this.plugin.settings.copyLanguage = value as CopyLanguage;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderTranscriptionAutomationSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("手动转写前确认上传")
			.setDesc("开启后，手动转写会先显示服务商、Base URL、模型和文件大小；自动化转写会跳过需要确认的上传，避免后台发送音频。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.confirmBeforeTranscription)
					.onChange(async (value) => {
						this.plugin.settings.confirmBeforeTranscription = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("跳过已存在 transcript")
			.setDesc("开启后不会重复调用转写，但仍会尝试补充 transcript 链接。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipExistingTranscript)
					.onChange(async (value) => {
						this.plugin.settings.skipExistingTranscript = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("自动识别 Markdown 音频链接")
			.setDesc("监听笔记变更，发现新增音频链接后将音频后台上传到当前转写服务商，并自动生成转写稿和补充链接。带有 Echo Notes 隐私标记的笔记会跳过自动化。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoTranscribeOnAudioLink)
					.onChange(async (value) => {
						this.plugin.settings.autoTranscribeOnAudioLink = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("自动识别新音频文件")
			.setDesc("监听 Vault 新增音频文件，并在后台上传到当前转写服务商以自动生成转写稿；该模式没有来源笔记隐私标记，也不会回写来源笔记。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoTranscribeOnAudioCreated)
					.onChange(async (value) => {
						this.plugin.settings.autoTranscribeOnAudioCreated = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("显示详细日志")
			.setDesc("开启后在开发者控制台输出更多调试信息。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.verboseLog)
					.onChange(async (value) => {
						this.plugin.settings.verboseLog = value;
						await this.plugin.saveSettings();
					})
			);
	}

	private renderTranscriptionSettings(containerEl: HTMLElement, renderId: number): void {
		new Setting(containerEl)
			.setName("转写模式")
			.setDesc(
				this.isGettingStartedOfflineTranscriptionGuide()
					? "新人体验固定检查离线转写配置，不会自动更改你当前选择的转写模式。"
					: "实时转写由 Echo Notes 直接采集麦克风并持续写入转写稿；离线转写用于 Vault 中已有的音频文件。"
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("realtime", "实时转写")
					.addOption("offline", "离线转写")
					.setValue(this.plugin.settings.transcriptionMode)
					.onChange(async (value) => {
						this.plugin.settings.transcriptionMode = value === "realtime" ? "realtime" : "offline";
						await this.plugin.saveSettings();
						this.refreshSettings();
					})
			);

		this.renderSettingsSectionTabs(
			containerEl,
			renderId,
			"transcription",
			"录音转写配置分类",
			TRANSCRIPTION_SETTINGS_SECTIONS,
			this.activeTranscriptionSettingsSection,
			(section, panelEl) => {
				switch (section) {
					case "service":
						this.renderTranscriptionServiceSettings(panelEl);
						break;
					case "recording":
						this.renderTranscriptionRecordingSettings(panelEl);
						break;
					case "output":
						this.renderTranscriptionOutputSettings(panelEl);
						break;
					case "automation":
						this.renderTranscriptionAutomationSettings(panelEl);
						break;
				}
			},
			(section) => {
				this.activeTranscriptionSettingsSection = section;
			}
		);
	}

	private renderTranscriptionServiceSettings(containerEl: HTMLElement): void {
		const config = this.getSelectedTranscriptionConfig();
		const isRealtime = this.getSelectedTranscriptionMode() === "realtime";
		const isMosi = !isRealtime && config.provider === "mosi";
		const isAgentPlan = config.provider === "volcengine-agentplan";
		if (config.provider !== "siliconflow") {
			this.customTranscriptionModelProvider = null;
		}
		const providerCapability = getTranscriptionProviderCapability(
			config.provider,
			this.getSelectedTranscriptionMode()
		);
		this.renderBasicHeading(containerEl, "连接配置");

		const providerSetting = new Setting(containerEl)
			.setName("服务商")
			.setDesc(
				isRealtime
					? "实时转写目前固定使用火山引擎 AgentPlan。"
					: "选择用于 Vault 中已有音频文件转写的服务商。"
			)
			.addDropdown((dropdown) => {
				if (isRealtime) {
					return dropdown
						.addOption("volcengine-agentplan", PROVIDER_LABELS["volcengine-agentplan"])
						.setValue("volcengine-agentplan")
						.setDisabled(true);
				}

				for (const [value, label] of Object.entries(OFFLINE_TRANSCRIPTION_PROVIDER_LABELS)) {
					dropdown.addOption(value, getProviderOptionLabel(value, label));
				}
				return dropdown
					.setValue(config.provider)
					.onChange(async (value) => {
						if (!isOfflineTranscriptionProviderId(value)) {
							return;
						}
						this.customTranscriptionModelProvider = null;
						this.plugin.settings.offlineTranscription.provider = value;
						this.applyOfflineProviderDefaults(value);
						await this.plugin.saveSettings();
						this.refreshSettings();
					});
			});
		providerSetting.settingEl.dataset.echoNotesGuideTarget = "transcription-provider";

		const apiKey = this.plugin.getApiKey(config.provider);
		const apiKeyDescription = createFragment();
		apiKeyDescription.appendText("按服务商隔离保存到 Obsidian SecretStorage，不会写入插件设置文件。");
		this.appendProviderSignupLink(apiKeyDescription, config.provider);
		const apiKeySetting = new Setting(containerEl)
			.setName(isAgentPlan ? "AgentPlan 专属 API Key" : "API Key")
			.setDesc(apiKeyDescription);
		apiKeySetting.settingEl.dataset.echoNotesGuideTarget = "transcription-api-key";
		const apiKeyStatusEl = this.createSecretSaveStatus(apiKeySetting, apiKey);
		apiKeySetting.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("sk-...")
				.setValue(apiKey);
			this.bindDeferredTextSave(apiKeySetting, `transcription-api-key:${config.provider}`, text.inputEl, async (value) => {
				await this.plugin.saveApiKey(config.provider, value);
				this.setSecretSaveStatus(apiKeyStatusEl, value ? "saved" : "cleared");
			}, (value) => value && value.length < 8 ? "API Key 少于 8 个字符，请确认是否完整。" : undefined, apiKeyStatusEl);
			return text;
		});
		apiKeySetting.controlEl.append(apiKeyStatusEl);

		if (isMosi) {
			new Setting(containerEl)
				.setName("说话人分离")
				.setDesc(
					"开启时使用 MOSI 多说话人模型并输出说话人和时间范围；关闭时使用官方普通转写模型，只输出正文。"
				)
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.mosiSpeakerDiarizationEnabled)
						.onChange(async (value) => {
							this.plugin.settings.mosiSpeakerDiarizationEnabled = value;
							this.plugin.settings.offlineTranscription.model =
								getMosiTranscriptionModel(value);
							await this.plugin.saveSettings();
							this.refreshSettings();
						})
				);
		}

		if (!isRealtime && config.provider === "siliconflow") {
			const isOfficialModel = SILICONFLOW_TRANSCRIPTION_MODELS.some((model) => model === config.model);
			const isChoosingCustomModel = !isOfficialModel || this.customTranscriptionModelProvider === config.provider;
			new Setting(containerEl)
				.setName("转写模型")
				.setDesc("可选择硅基流动官方转写模型，或在下方填写未来新增的自定义模型 ID。")
				.addDropdown((dropdown) => {
					for (const model of SILICONFLOW_TRANSCRIPTION_MODELS) {
						dropdown.addOption(model, model);
					}
					dropdown.addOption("__custom__", "自定义模型");
					return dropdown
						.setValue(isChoosingCustomModel ? "__custom__" : config.model)
						.onChange(async (value) => {
							if (value === "__custom__") {
								this.customTranscriptionModelProvider = "siliconflow";
								this.refreshSettings();
								return;
							}
							this.customTranscriptionModelProvider = null;
							this.plugin.settings.offlineTranscription.model = value;
							await this.plugin.saveSettings();
							this.refreshSettings();
						});
				});

			if (isChoosingCustomModel) {
				const customModelSetting = new Setting(containerEl)
					.setName("自定义转写模型")
					.setDesc("填写后会覆盖上方官方模型选择；切回官方模型不会删除曾使用过的服务商 API Key。");
				customModelSetting.addText((text) => {
					text
						.setPlaceholder("例如未来新增的 organization/model-ID")
						.setValue(isOfficialModel ? "" : config.model);
					this.bindDeferredTextSave(customModelSetting, "transcription-custom-model", text.inputEl, async (value) => {
						this.customTranscriptionModelProvider = "siliconflow";
						this.plugin.settings.offlineTranscription.model = value;
						await this.plugin.saveSettings();
					}, (value) => value ? undefined : "模型 ID 不能为空。");
					return text;
				});
			}
		} else {
			const modelSetting = new Setting(containerEl)
				.setName("转写模型")
				.setDesc(
					isRealtime
						? "AgentPlan 实时转写固定使用 doubao-seed-asr-2.0。"
						: isMosi
							? this.plugin.settings.mosiSpeakerDiarizationEnabled
								? "已开启说话人分离，固定使用 moss-transcribe-diarize。"
								: "已关闭说话人分离，固定使用普通转写模型 moss-transcribe。"
							: "离线转写模型名称。"
				);
			modelSetting.addText((text) => {
				text
					.setPlaceholder(this.getProviderDefaults().model)
					.setValue(config.model)
					.setDisabled(isRealtime || isMosi || isAgentPlan);
				if (!isRealtime && !isMosi && !isAgentPlan) {
					this.bindDeferredTextSave(
						modelSetting,
						"transcription-model",
						text.inputEl,
						async (value) => {
							this.plugin.settings.offlineTranscription.model = value;
							await this.plugin.saveSettings();
						},
						(value) => value ? undefined : "模型 ID 不能为空。"
					);
				}
				return text;
			});
		}

		if (
			providerCapability.supportsSpeakerDiarization &&
			(!isMosi || this.plugin.settings.mosiSpeakerDiarizationEnabled)
		) {
			new Setting(containerEl)
				.setName("说话人标签样式")
				.setDesc(
					isMosi
						? "MOSI 服务端说话人编号会按首次出现顺序显示；长音频的编号仅在当前分段内有效。"
						: "AgentPlan 始终启用说话人聚类；单人录音也会显示“说话人 1”。"
				)
				.addDropdown((dropdown) =>
						dropdown
							.addOption("speaker", "仅说话人")
							.addOption("speaker-with-time", "说话人＋时间")
							.setValue(this.plugin.settings.agentPlanSpeakerLabelStyle)
							.onChange(async (value) => {
								this.plugin.settings.agentPlanSpeakerLabelStyle = value as AgentPlanSpeakerLabelStyle;
								await this.plugin.saveSettings();
							})
					);
		}

		this.renderProviderDiagnostics(containerEl);
		this.renderProviderCapability(containerEl);

		const advancedEl = this.renderAdvancedSection(
			containerEl,
			"高级配置（Base URL、语言与自检）",
			() => undefined
		);
		const baseUrlSetting = new Setting(advancedEl)
			.setName("Base URL")
			.setDesc(this.getBaseUrlDescription());
		baseUrlSetting.addText((text) => {
			text
				.setPlaceholder(this.getProviderDefaults().baseUrl)
				.setValue(config.baseUrl)
				.setDisabled(isRealtime || isMosi || isAgentPlan);
			if (!isRealtime && !isMosi && !isAgentPlan) {
				this.bindDeferredTextSave(
					baseUrlSetting,
					"transcription-base-url",
					text.inputEl,
					async (value) => {
						this.plugin.settings.offlineTranscription.baseUrl = value;
						await this.plugin.saveSettings();
					},
					(value) => validateBaseUrl(value)
				);
			}
			return text;
		});

		new Setting(advancedEl)
			.setName("默认转写语言")
			.setDesc(
				isAgentPlan
					? this.getTranscriptionLanguageDescription()
					: `${this.getTranscriptionLanguageDescription()} 如需其他代码，可使用下方自定义语言代码。`
			)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(TRANSCRIPTION_LANGUAGE_LABELS)) {
					dropdown.addOption(value, label);
				}
				if (!Object.prototype.hasOwnProperty.call(TRANSCRIPTION_LANGUAGE_LABELS, config.language)) {
					dropdown.addOption(config.language, `自定义：${config.language}`);
				}
				return dropdown
					.setValue(config.language || "auto")
					.onChange(async (value) => {
						config.language = normalizeTranscriptionLanguageForProvider(config.provider, value || "auto");
						await this.plugin.saveSettings();
						if (config.language !== value) {
							new Notice("AgentPlan 说话人分离仅支持 auto 或中文，已自动切换为 auto。");
							this.refreshSettings();
						}
					});
			});

		if (!isRealtime && !isAgentPlan) {
			new Setting(advancedEl)
				.setName("自定义语言代码")
				.setDesc("填写当前离线服务商支持的语言代码；清空不会改变当前语言。")
				.addText((text) => {
					const customLanguage = Object.prototype.hasOwnProperty.call(
						TRANSCRIPTION_LANGUAGE_LABELS,
						config.language
					)
						? ""
						: config.language;
					let draftValue = customLanguage;
					text.setPlaceholder("例如 cmn、yue、fr").setValue(customLanguage).onChange((value) => {
						draftValue = value;
					});
					text.inputEl.addEventListener("blur", () => {
						const value = draftValue.trim();
						if (!value || value === config.language) {
							return;
						}
						config.language = value;
						void this.plugin.saveSettings().then(() => this.refreshSettings());
					});
				});
		}

	}

	private renderTranscriptionRecordingSettings(containerEl: HTMLElement): void {
		if (this.plugin.settings.transcriptionMode === "realtime") {
			const devices = this.plugin.getCachedAudioInputDevices();
			const microphoneSetting = new Setting(containerEl)
				.setName("麦克风")
				.setDesc("默认使用系统输入设备。刷新设备时会申请麦克风权限；已选设备失效时自动回退系统默认。")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "系统默认麦克风");
					for (const device of devices) {
						dropdown.addOption(device.deviceId, device.label || `麦克风 ${dropdown.selectEl.options.length}`);
					}
					return dropdown
						.setValue(this.plugin.settings.realtimeTranscription.inputDeviceId)
						.onChange(async (value) => {
							this.plugin.settings.realtimeTranscription.inputDeviceId = value;
							await this.plugin.saveSettings();
						});
				})
				.addButton((button) =>
					button.setButtonText("刷新麦克风").onClick(async () => {
						try {
							await this.plugin.refreshAudioInputDevices();
							this.refreshSettings();
						} catch (error) {
							new Notice(`读取麦克风失败：${getSanitizedErrorMessage(error)}`);
						}
					})
				);
			microphoneSetting.controlEl.addClass("echo-notes-settings-control-composite");
		} else {
			this.renderOfficialRecorderSettings(containerEl);
		}
	}

	private renderOfficialRecorderSettings(containerEl: HTMLElement): void {
		const recorderEnabled = this.plugin.isOfficialAudioRecorderEnabled();
		const status =
			recorderEnabled === null
				? "无法读取状态"
				: recorderEnabled
					? "已开启"
					: "未开启";

		new Setting(containerEl).setName("Obsidian 核心插件录音机").setHeading();

		new Setting(containerEl)
			.setName("启用 Obsidian 核心插件录音机")
			.setDesc(`控制 Obsidian 核心插件“录音机”。当前状态：${status}。`)
			.addToggle((toggle) =>
				toggle
					.setValue(recorderEnabled === true)
					.onChange(async (value) => {
						await this.plugin.setOfficialAudioRecorderEnabled(value);
						this.refreshSettings();
					})
			);

		this.renderHotkeySetting(
			containerEl,
			"Obsidian 核心插件录音机开启快捷键",
			"直接修改 Obsidian 核心命令 audio-recorder:start 的快捷键。Echo Notes 不预设快捷键，避免覆盖已有操作。",
			"例如 Ctrl+L",
			"audio-recorder:start",
			this.plugin.getOfficialAudioRecorderStartHotkey(),
			(hotkey) => this.plugin.setOfficialAudioRecorderStartHotkey(hotkey)
		);

		this.renderHotkeySetting(
			containerEl,
			"Obsidian 核心插件录音机关闭快捷键",
			"直接修改 Obsidian 核心命令 audio-recorder:stop 的快捷键。Echo Notes 不预设快捷键，避免覆盖已有操作。",
			"例如 Ctrl+S",
			"audio-recorder:stop",
			this.plugin.getOfficialAudioRecorderStopHotkey(),
			(hotkey) => this.plugin.setOfficialAudioRecorderStopHotkey(hotkey)
		);

		this.renderHotkeySetting(
			containerEl,
			"转写当前笔记全部音频快捷键",
			"触发“转写当前笔记全部音频”。默认留空，请选择不与撤销等系统操作冲突的组合。",
			"例如 Mod+Shift+T",
			`${this.plugin.manifest.id}:transcribe-all-audio-files-in-current-note`,
			this.plugin.settings.transcribeAllAudioHotkey,
			(hotkey) => this.plugin.setTranscribeAllAudioHotkey(hotkey)
		);
	}

	private renderHotkeySetting(
		containerEl: HTMLElement,
		name: string,
		description: string,
		placeholder: string,
		commandId: string,
		currentHotkey: EchoNotesHotkeySetting,
		applyHotkey: (hotkey: EchoNotesHotkeySetting) => Promise<boolean | void>
	): void {
		let draftValue = formatHotkey(currentHotkey);
		let setSaveDisabled = (_disabled: boolean): void => undefined;
		const hotkeySetting = new Setting(containerEl)
			.setName(name)
			.setDesc(`${description} 支持 Ctrl+L、Control + L、Cmd+Shift+P 等写法；无效输入不会保存。`);
		const validationEl = hotkeySetting.descEl.createDiv({ cls: "echo-notes-hotkey-validation" });
		const validateDraft = (): EchoNotesHotkeySetting | undefined => {
			const hotkey = parseHotkeyInput(draftValue);
			let error = "";
			if (hotkey === undefined) {
				error = `快捷键格式无效：${draftValue}`;
			} else {
				const conflicts = this.plugin.getHotkeyConflicts(commandId, hotkey);
				if (conflicts.length > 0) {
					error = `快捷键冲突：已被 ${conflicts.join("、")} 使用，请更换组合键。`;
				}
			}
			if (error) {
				renderStatusIndicator(validationEl, {
					tone: "failed",
					text: error,
					live: "polite"
				}, setIcon);
			} else {
				clearStatusIndicator(validationEl);
			}
			setSaveDisabled(Boolean(error));
			return error ? undefined : hotkey;
		};
		hotkeySetting
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(draftValue)
					.onChange((value) => {
						draftValue = value;
						validateDraft();
					})
			)
			.addButton((button) => {
				setSaveDisabled = (disabled) => {
					button.setDisabled(disabled);
				};
				button
					.setButtonText("保存")
					.onClick(async () => {
						const hotkey = validateDraft();
						if (hotkey === undefined) {
							return;
						}

						const applied = await applyHotkey(hotkey);
						if (applied === false) {
							return;
						}
						await this.plugin.saveSettings();
						this.plugin.refreshRegisteredCommands();
						this.refreshSettings();
					});
			});
		validateDraft();
		hotkeySetting.controlEl.addClass("echo-notes-settings-control-composite");
	}

	private renderAnalysisSettings(containerEl: HTMLElement, renderId: number): void {
		const analysisEnabledSetting = new Setting(containerEl)
			.setName("启用 AI 纪要分析")
			.setDesc("开启后显示分析模型配置和分析模板设置，并允许对转写稿生成 AI 纪要。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.analysisEnabled)
					.onChange(async (value) => {
						this.plugin.settings.analysisEnabled = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					})
			);
		analysisEnabledSetting.settingEl.dataset.echoNotesGuideTarget = "analysis-enabled";

		if (!this.plugin.settings.analysisEnabled) {
			return;
		}

		this.renderSettingsSectionTabs(
			containerEl,
			renderId,
			"analysis",
			"AI 分析配置分类",
			ANALYSIS_SETTINGS_SECTIONS,
			this.activeAnalysisSettingsSection,
			(section, panelEl) => {
				switch (section) {
					case "model":
						this.renderAnalysisModelSettings(panelEl);
						break;
					case "processing":
						this.renderAnalysisProcessingSettings(panelEl);
						break;
					case "templates":
						this.renderAnalysisTemplateSettings(panelEl, renderId);
						break;
				}
			},
			(section) => {
				this.activeAnalysisSettingsSection = section;
			}
		);
	}

	private renderAnalysisModelSettings(containerEl: HTMLElement): void {
		this.renderBasicHeading(containerEl, "模型配置");
		const analysisProviderSetting = new Setting(containerEl)
			.setName("分析服务商")
			.setDesc("用于对转写稿生成纪要的服务商。火山引擎 AgentPlan 使用套餐专属文本模型和接口，默认仍为阿里百炼。")
			.addDropdown((dropdown) =>
				Object.entries(ANALYSIS_PROVIDER_LABELS)
					.reduce((control, [value, label]) => control.addOption(value, getProviderOptionLabel(value, label)), dropdown)
					.setValue(this.plugin.settings.analysisProvider)
					.onChange(async (value) => {
						if (!isAnalysisProviderId(value)) {
							return;
						}
						this.plugin.settings.analysisProvider = value;
						this.applyAnalysisProviderDefaults(value);
						await this.plugin.saveSettings();
						this.refreshSettings();
					})
			);
		analysisProviderSetting.settingEl.dataset.echoNotesGuideTarget = "analysis-provider";

		const isAgentPlanAnalysis = this.plugin.settings.analysisProvider === "volcengine-agentplan";
		const analysisApiKeyDescription = createFragment();
		analysisApiKeyDescription.appendText(
			isAgentPlanAnalysis
				? "必须使用 AgentPlan 控制台创建的专属 API Key，并与其他用途的密钥隔离保存。"
				: "用于调用当前分析服务商，按服务商隔离保存到 Obsidian SecretStorage。"
		);
		this.appendProviderSignupLink(analysisApiKeyDescription, this.plugin.settings.analysisProvider);
		const analysisApiKeySetting = new Setting(containerEl)
			.setName(isAgentPlanAnalysis ? "AgentPlan 分析专属 API Key" : "分析 API Key")
			.setDesc(analysisApiKeyDescription);
		analysisApiKeySetting.settingEl.dataset.echoNotesGuideTarget = "analysis-api-key";
		const analysisApiKeyStatusEl = this.createSecretSaveStatus(
			analysisApiKeySetting,
			this.plugin.getAnalysisApiKey()
		);
		analysisApiKeySetting.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("sk-...")
				.setValue(this.plugin.getAnalysisApiKey());
			this.bindDeferredTextSave(analysisApiKeySetting, "analysis-api-key", text.inputEl, async (value) => {
				await this.plugin.saveAnalysisApiKey(value);
				this.setSecretSaveStatus(analysisApiKeyStatusEl, value ? "saved" : "cleared");
			}, (value) => value && value.length < 8 ? "API Key 少于 8 个字符，请确认是否完整。" : undefined, analysisApiKeyStatusEl);
			return text;
		});
		analysisApiKeySetting.controlEl.append(analysisApiKeyStatusEl);
		const analysisModelSetting = new Setting(containerEl)
			.setName("分析模型")
			.setDesc(
				isAgentPlanAnalysis
					? "选择 AgentPlan 套餐当前支持的文本生成模型；Kimi K3 仅 Medium 及以上套餐可用。"
					: "用于生成纪要分析的文本模型。"
			);
		if (isAgentPlanAnalysis) {
			analysisModelSetting.addDropdown((dropdown) => {
				for (const option of AGENTPLAN_ANALYSIS_MODELS) {
					dropdown.addOption(option.id, option.label);
				}
				if (!AGENTPLAN_ANALYSIS_MODELS.some((option) => option.id === this.plugin.settings.analysisModel)) {
					dropdown.addOption(
						this.plugin.settings.analysisModel,
						`当前自定义模型：${this.plugin.settings.analysisModel}`
					);
				}
				return dropdown
					.setValue(this.plugin.settings.analysisModel)
					.onChange(async (value) => {
						this.plugin.settings.analysisModel = value;
						await this.plugin.saveSettings();
					});
			});
		} else {
			analysisModelSetting.addText((text) => {
				text
					.setPlaceholder(this.getAnalysisProviderDefaults().analysisModel)
					.setValue(this.plugin.settings.analysisModel)
					.onChange(() => undefined);
				this.bindDeferredTextSave(analysisModelSetting, "analysis-model", text.inputEl, async (value) => {
					this.plugin.settings.analysisModel = value;
					await this.plugin.saveSettings();
				}, (value) => value ? undefined : "模型不能为空。");
				return text;
			});
		}

		const advancedEl = this.renderAdvancedSection(containerEl, "高级配置（Base URL 与自检）", () => undefined);
		const baseUrlSetting = new Setting(advancedEl)
			.setName("分析 Base URL")
			.setDesc(
				isAgentPlanAnalysis
					? "AgentPlan OpenAI-compatible Chat API 专属地址；使用普通方舟地址不会抵扣 AgentPlan 套餐额度。"
					: "OpenAI-compatible chat completions 基础地址。请确认所选服务商支持 {Base URL}/chat/completions。"
			);
		baseUrlSetting.addText((text) => {
			text
				.setPlaceholder(this.getAnalysisProviderDefaults().analysisBaseUrl)
				.setValue(this.plugin.settings.analysisBaseUrl)
				.setDisabled(isAgentPlanAnalysis);
			if (!isAgentPlanAnalysis) {
				this.bindDeferredTextSave(baseUrlSetting, "analysis-base-url", text.inputEl, async (value) => {
					this.plugin.settings.analysisBaseUrl = value;
					await this.plugin.saveSettings();
				}, (value) => validateBaseUrl(value));
			}
			return text;
		});

		new Setting(advancedEl)
			.setName("分析配置自检")
			.setDesc("本地检查分析 API Key、Base URL、HTTPS 和模型；不会发送转写稿，也不会调用服务商。")
			.addButton((button) =>
				button.setButtonText("检查分析配置").onClick(() => {
					const result = diagnoseAnalysisProviderSettings(this.plugin.settings, this.plugin.getAnalysisApiKey());
					new ProviderDiagnosticsModal(this.app, result.providerLabel, result.canAttemptAnalysis, result.items).open();
				})
			);
	}

	private renderAnalysisProcessingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("AI 分析前脱敏 transcript")
			.setDesc("仅在发送给分析模型前遮盖敏感信息，Vault 中的原始转写稿不会被改写。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.redactTranscriptBeforeAnalysis)
					.onChange(async (value) => {
					this.plugin.settings.redactTranscriptBeforeAnalysis = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("长文本分块分析")
			.setDesc("超过分块字符数时，先逐块提取，再汇总为一份去重后的最终纪要；会产生多次模型调用。")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.analysisLongTextEnabled).onChange(async (value) => {
					this.plugin.settings.analysisLongTextEnabled = value;
					await this.plugin.saveSettings();
					this.refreshSettings();
				})
			);

		if (this.plugin.settings.analysisLongTextEnabled) {
			const advancedEl = this.renderAdvancedSection(containerEl, "高级配置（分块参数）", () => undefined);
			const chunkSetting = new Setting(advancedEl)
				.setName("分析分块字符数")
				.setDesc("范围 4,000～100,000。默认 24,000；值越小兼容性越高，但调用次数和成本越高。");
			chunkSetting.addText((text) => {
				text
					.setPlaceholder("24000")
					.setValue(String(this.plugin.settings.analysisChunkCharacters))
					.onChange(() => undefined);
					this.bindDeferredTextSave(chunkSetting, "analysis-chunk-characters", text.inputEl, async (value) => {
						const parsed = Number(value);
						this.plugin.settings.analysisChunkCharacters = Math.min(100000, Math.max(4000, Math.round(parsed)));
						await this.plugin.saveSettings();
					}, (value) => {
						const parsed = Number(value);
						return Number.isInteger(parsed) && parsed >= 4000 && parsed <= 100000 ? undefined : "请输入 4,000～100,000 的整数。";
					});
				return text;
			});
			return;
		}
	}

	private renderMemorySettings(containerEl: HTMLElement, renderId: number): void {
		this.renderSettingsSectionTabs(
			containerEl,
			renderId,
			"memory",
			"Echo Memory 配置分类",
			MEMORY_SETTINGS_SECTIONS,
			this.activeMemorySettingsSection,
			(section, panelEl) => {
				switch (section) {
					case "workspace":
						this.renderMemoryWorkspaceSettings(panelEl);
						break;
					case "model":
						this.renderMemoryModelSettings(panelEl);
						break;
					case "processing":
						this.renderMemoryProcessingSettings(panelEl);
						break;
				}
			},
			(section) => {
				this.activeMemorySettingsSection = section;
			}
		);
	}

	private renderMemoryWorkspaceSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Echo Memory 根目录")
			.setDesc(
				this.plugin.settings.memoryInitialized
					? "目录已由初始化清单锁定；如需迁移，请移动整个目录并同步修改插件数据。"
					: "初始化时将在 Vault 内创建会议、候选、实体、用户和系统目录。"
			)
			.addText((text) => {
				text
					.setPlaceholder("Echo Memory")
					.setValue(this.plugin.settings.memoryRootFolder)
					.setDisabled(this.plugin.settings.memoryInitialized);
				if (!this.plugin.settings.memoryInitialized) {
					text.onChange(async (value) => {
						this.plugin.settings.memoryRootFolder = value.trim();
						await this.plugin.saveSettings();
					});
				}
				return text;
			});

		new Setting(containerEl)
			.setName("初始化状态")
			.setDesc(
				this.plugin.settings.memoryInitialized
					? `已初始化；目录语言固定为 ${this.plugin.settings.memoryPathLanguage === "en" ? "English" : "中文"}。`
					: "首次初始化只收集称呼、当前角色和近期目标。"
			)
			.addButton((button) => button
				.setButtonText(this.plugin.settings.memoryInitialized ? "打开首页" : "开始初始化")
				.setCta()
				.onClick(() => {
					if (this.plugin.settings.memoryInitialized) {
						void this.plugin.openMemoryHome();
					} else {
						this.plugin.openMemoryInitialization(() => this.refreshSettings());
					}
				}));

		new Setting(containerEl)
			.setName("启用自动记忆提取")
			.setDesc("开启后，一批 AI 纪要至少有一个成功时，自动以转写正文和本批成功纪要提取一次记忆。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.memoryEnabled)
				.setDisabled(!this.plugin.settings.memoryInitialized)
				.onChange(async (value) => {
					this.plugin.settings.memoryEnabled = value;
					await this.plugin.saveSettings();
				}));
	}

	private renderMemoryModelSettings(containerEl: HTMLElement): void {
		this.renderBasicHeading(containerEl, "模型配置");
		const providerSetting = new Setting(containerEl)
			.setName("记忆服务商")
			.setDesc("独立用于结构化记忆提取，不复用 AI 分析阶段的服务商、API Key、Base URL 或模型。")
			.addDropdown((dropdown) => Object.entries(ANALYSIS_PROVIDER_LABELS)
				.reduce((control, [value, label]) => control.addOption(value, getProviderOptionLabel(value, label)), dropdown)
				.setValue(this.plugin.settings.memoryProvider)
				.onChange(async (value) => {
					if (!isAnalysisProviderId(value)) {
						return;
					}
					this.plugin.settings.memoryProvider = value;
					this.applyMemoryProviderDefaults(value);
					await this.plugin.saveSettings();
					this.refreshSettings();
				}));
		providerSetting.settingEl.dataset.echoNotesGuideTarget = "memory-provider";

		const apiKeyDescription = createFragment();
		apiKeyDescription.appendText("按服务商隔离保存在 Obsidian SecretStorage，不会写入插件配置或记忆文件。");
		this.appendProviderSignupLink(apiKeyDescription, this.plugin.settings.memoryProvider);
		const apiKeySetting = new Setting(containerEl)
			.setName("记忆 API Key")
			.setDesc(apiKeyDescription);
		apiKeySetting.settingEl.dataset.echoNotesGuideTarget = "memory-api-key";
		const statusEl = this.createSecretSaveStatus(apiKeySetting, this.plugin.getMemoryApiKey());
		apiKeySetting.addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("sk-...")
				.setValue(this.plugin.getMemoryApiKey());
			this.bindDeferredTextSave(apiKeySetting, "memory-api-key", text.inputEl, async (value) => {
				await this.plugin.saveMemoryApiKey(value);
				this.setSecretSaveStatus(statusEl, value ? "saved" : "cleared");
			}, (value) => value && value.length < 8 ? "API Key 少于 8 个字符，请确认是否完整。" : undefined, statusEl);
			return text;
		});
		apiKeySetting.controlEl.append(statusEl);

		const isAgentPlan = this.plugin.settings.memoryProvider === "volcengine-agentplan";
		const modelSetting = new Setting(containerEl)
			.setName("记忆模型")
			.setDesc("模型需要可靠输出 JSON，并为每条断言保留原文证据。");
		if (isAgentPlan) {
			modelSetting.addDropdown((dropdown) => {
				for (const option of AGENTPLAN_ANALYSIS_MODELS) {
					dropdown.addOption(option.id, option.label);
				}
				return dropdown.setValue(this.plugin.settings.memoryModel).onChange(async (value) => {
					this.plugin.settings.memoryModel = value;
					await this.plugin.saveSettings();
				});
			});
		} else {
			modelSetting.addText((text) => {
				text
					.setPlaceholder(this.getMemoryProviderDefaults().analysisModel)
					.setValue(this.plugin.settings.memoryModel)
					.onChange(() => undefined);
				this.bindDeferredTextSave(modelSetting, "memory-model", text.inputEl, async (value) => {
					this.plugin.settings.memoryModel = value;
					await this.plugin.saveSettings();
				}, (value) => value ? undefined : "模型不能为空。");
				return text;
			});
		}

		const advancedEl = this.renderAdvancedSection(containerEl, "高级配置（Base URL 与自检）", () => undefined);
		const baseUrlSetting = new Setting(advancedEl)
			.setName("记忆 Base URL")
			.setDesc("OpenAI-compatible chat completions 基础地址。");
		baseUrlSetting.addText((text) => {
				text
					.setPlaceholder(this.getMemoryProviderDefaults().analysisBaseUrl)
					.setValue(this.plugin.settings.memoryBaseUrl)
					.setDisabled(isAgentPlan);
				if (!isAgentPlan) {
					this.bindDeferredTextSave(baseUrlSetting, "memory-base-url", text.inputEl, async (value) => {
						this.plugin.settings.memoryBaseUrl = value;
						await this.plugin.saveSettings();
					}, (value) => validateBaseUrl(value));
				}
				return text;
		});

		new Setting(advancedEl)
			.setName("记忆配置自检")
			.setDesc("本地检查独立 API Key、Base URL、HTTPS 和模型；不会发送会议内容。")
			.addButton((button) => button.setButtonText("检查记忆配置").onClick(() => {
				const result = diagnoseMemoryProviderSettings({
					provider: this.plugin.settings.memoryProvider,
					baseUrl: this.plugin.settings.memoryBaseUrl,
					model: this.plugin.settings.memoryModel,
					apiKey: this.plugin.getMemoryApiKey()
				});
				new Notice(result.canAttempt ? "记忆配置自检通过。" : result.errors.join("；"));
			}));
	}

	private renderMemoryProcessingSettings(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("沉淀模式")
			.setDesc("候选包与审核 sidecar 始终作为事实源；自动编译模式会在保存审核后，用已批准断言更新画像托管区块。")
			.addDropdown((dropdown) => dropdown
				.addOption("candidates-only", "会议页 + 候选包 + 审核（默认）")
				.addOption("compile-profiles", "审核后自动编译画像")
				.setValue(this.plugin.settings.memoryMode)
				.onChange(async (value) => {
					this.plugin.settings.memoryMode = value as MemoryMode;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("长文本分块提取")
			.setDesc("按自然边界顺序提取，最多 20 块，最后由插件合并并去重结构化断言。")
			.addToggle((toggle) => toggle
				.setValue(this.plugin.settings.memoryLongTextEnabled)
				.onChange(async (value) => {
					this.plugin.settings.memoryLongTextEnabled = value;
					await this.plugin.saveSettings();
					this.refreshSettings();
				}));

		if (this.plugin.settings.memoryLongTextEnabled) {
			const advancedEl = this.renderAdvancedSection(containerEl, "高级配置（分块参数）", () => undefined);
			const chunkSetting = new Setting(advancedEl)
				.setName("记忆分块字符数")
				.setDesc("范围 4,000～100,000，默认 24,000。相邻分块保留 400 字重叠。")
			chunkSetting.addText((text) => {
				text
					.setPlaceholder("24000")
					.setValue(String(this.plugin.settings.memoryChunkCharacters))
					.onChange(() => undefined);
				this.bindDeferredTextSave(chunkSetting, "memory-chunk-characters", text.inputEl, async (value) => {
					const parsed = Number(value);
					this.plugin.settings.memoryChunkCharacters = Math.min(100000, Math.max(4000, Math.round(parsed)));
					await this.plugin.saveSettings();
				}, (value) => {
					const parsed = Number(value);
					return Number.isInteger(parsed) && parsed >= 4000 && parsed <= 100000 ? undefined : "请输入 4,000～100,000 的整数。";
				});
				return text;
			});
		}

		new Setting(containerEl)
			.setName("从候选包重建画像与聚合")
			.setDesc("只读取配置根目录内已批准的断言和关系，重写画像与跨记录视图托管区块，不修改人工正文。")
			.addButton((button) => button
				.setButtonText("立即重建")
				.setDisabled(!this.plugin.settings.memoryInitialized)
				.onClick(() => {
					void this.plugin.rebuildMemoryProfiles();
				}));
	}

	private renderAnalysisTemplateSettings(containerEl: HTMLElement, renderId: number): void {
		new Setting(containerEl)
			.setName("默认分析模板")
			.setDesc("录音链接上下三行未命中任何识别关键字时，使用这个模板生成 AI 纪要。若默认模板被禁用，会自动改用第一个已启用模板。")
			.addDropdown((dropdown) => {
				dropdown.selectEl.replaceChildren();
				for (const group of groupAnalysisTemplatesByCategory(this.plugin.settings.analysisTemplates)) {
					if (group.templates.length === 0) {
						continue;
					}
					const optionGroup = dropdown.selectEl.createEl("optgroup");
					optionGroup.label = group.category.label;
					for (const template of group.templates) {
						const suffix = template.enabled ? "" : "（未启用）";
						optionGroup.append(
							new Option(`${template.name}${suffix}`, template.id)
						);
					}
				}
				dropdown
					.setValue(this.plugin.settings.defaultAnalysisTemplateId)
					.onChange(async (value) => {
						this.plugin.settings.defaultAnalysisTemplateId = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					});
			});

		const groups = groupAnalysisTemplatesByCategory(this.plugin.settings.analysisTemplates);
		const categoryTabsEl = containerEl.createDiv({ cls: "echo-notes-template-category-tabs" });
		categoryTabsEl.setAttribute("role", "tablist");
		categoryTabsEl.setAttribute("aria-label", "分析模板角色分类");
		categoryTabsEl.setAttribute("aria-orientation", "horizontal");

		const categoryButtonEls = new Map<AnalysisTemplateCategoryId, HTMLButtonElement>();
		const groupEls = new Map<AnalysisTemplateCategoryId, HTMLElement>();
		const activateCategory = (categoryId: AnalysisTemplateCategoryId, moveFocus = true): void => {
			this.activeAnalysisTemplateCategory = categoryId;
			for (const group of groups) {
				const isActive = group.category.id === categoryId;
				const buttonEl = categoryButtonEls.get(group.category.id);
				const groupEl = groupEls.get(group.category.id);
				buttonEl?.toggleClass("is-active", isActive);
				buttonEl?.setAttribute("aria-selected", String(isActive));
				if (buttonEl) {
					buttonEl.tabIndex = isActive ? 0 : -1;
				}
				if (groupEl) {
					groupEl.hidden = !isActive;
				}
			}
			if (moveFocus) {
				categoryButtonEls.get(categoryId)?.focus();
			}
		};

		for (const [index, group] of groups.entries()) {
			const enabledCount = group.templates.filter((template) => template.enabled).length;
			const tabId = `echo-notes-template-category-tab-${renderId}-${group.category.id}`;
			const panelId = `echo-notes-template-group-${renderId}-${group.category.id}`;
			const buttonEl = categoryTabsEl.createEl("button", {
				cls: "echo-notes-template-category-tab",
				attr: {
					type: "button",
					role: "tab",
					id: tabId,
					"aria-controls": panelId,
					"aria-label": `${group.category.label}，已启用 ${enabledCount}/${group.templates.length}`,
					"data-template-category-tab": group.category.id
				}
			});
			buttonEl.createSpan({ cls: "echo-notes-template-category-tab-label", text: group.category.label });
			buttonEl.createSpan({
				cls: "echo-notes-template-category-tab-count",
				text: `${enabledCount}/${group.templates.length}`,
				attr: { "aria-hidden": "true" }
			});
			categoryButtonEls.set(group.category.id, buttonEl);
			buttonEl.addEventListener("click", () => activateCategory(group.category.id));
			buttonEl.addEventListener("keydown", (event) => {
				let targetIndex: number;
				switch (event.key) {
					case "ArrowLeft":
						targetIndex = (index - 1 + groups.length) % groups.length;
						break;
					case "ArrowRight":
						targetIndex = (index + 1) % groups.length;
						break;
					case "Home":
						targetIndex = 0;
						break;
					case "End":
						targetIndex = groups.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				activateCategory(groups[targetIndex].category.id);
			});
		}

		const templateGroupsEl = containerEl.createDiv({ cls: "echo-notes-template-groups" });
		for (const group of groups) {
			const groupEl = templateGroupsEl.createEl("section", {
				cls: "echo-notes-template-group",
				attr: {
					role: "tabpanel",
					id: `echo-notes-template-group-${renderId}-${group.category.id}`,
					"aria-labelledby": `echo-notes-template-category-tab-${renderId}-${group.category.id}`,
					"data-template-category": group.category.id
				}
			});
			groupEls.set(group.category.id, groupEl);
			const groupHeaderEl = groupEl.createDiv({ cls: "echo-notes-template-group-header" });
			const groupHeading = new Setting(groupHeaderEl)
				.setName(group.category.label)
				.setClass("echo-notes-template-group-heading")
				.setHeading();
			groupHeading.nameEl.addClass("echo-notes-template-group-title");
			groupHeaderEl.createSpan({
				cls: "echo-notes-template-group-count",
				text: `${group.templates.filter((template) => template.enabled).length}/${group.templates.length} 已启用`
			});

			if (group.templates.length === 0) {
				groupEl.createDiv({ cls: "echo-notes-template-group-empty", text: "暂无模板" });
				continue;
			}

			const templateListEl = groupEl.createDiv({ cls: "echo-notes-template-list" });
			for (const template of group.templates) {
				this.renderAnalysisTemplateCard(templateListEl, template);
			}
		}
		activateCategory(this.activeAnalysisTemplateCategory, false);

		new Setting(containerEl)
			.setName("新增自定义模板")
			.setDesc("创建后可配置角色分类、模板名称、识别关键字、系统提示词和模板任务。启用后会参与录音链接上下文匹配。")
			.addButton((button) =>
				button
					.setButtonText("新增模板")
					.onClick(async () => {
						const template = createCustomAnalysisTemplate("自定义模板", this.plugin.settings.analysisTemplates);
						this.plugin.settings.analysisTemplates.push(template);
						await this.plugin.saveSettings();
						const savedTemplate = this.plugin.settings.analysisTemplates.find((candidate) => candidate.id === template.id) ?? template;
						this.refreshSettings();
						new AnalysisTemplateEditModal(this.app, this.plugin, savedTemplate, () => {
							this.activeAnalysisTemplateCategory = savedTemplate.category;
							this.refreshSettings();
						}).open();
					})
			);
	}

	private renderProviderCapability(containerEl: HTMLElement): void {
		const providerId = this.getSelectedTranscriptionConfig().provider;
		const capability = getTranscriptionProviderCapability(
			providerId,
			this.getSelectedTranscriptionMode()
		);
		const capabilityEl = containerEl.createDiv({ cls: "echo-notes-provider-capability" });
		const headerEl = capabilityEl.createDiv({ cls: "echo-notes-provider-capability-header" });
		headerEl.createDiv({ cls: "echo-notes-provider-capability-title", text: "当前服务商能力" });
		headerEl.createDiv({
			cls: "echo-notes-provider-capability-meta",
			text: `上传方式：${getUploadModeLabel(capability.uploadMode)}；接口形态：${getEndpointShapeLabel(capability.endpointShape)}`
		});

		const summaryEl = capabilityEl.createDiv({ cls: "echo-notes-provider-capability-summary" });
		for (const item of getProviderCapabilitySummary(capability)) {
			const isUnsupported = item.includes("暂不支持");
			summaryEl.createSpan({
				cls: `echo-notes-provider-capability-chip${isUnsupported ? " is-muted" : ""}`,
				text: item
			});
		}

		const modelsEl = capabilityEl.createDiv({ cls: "echo-notes-provider-capability-note" });
		modelsEl.createSpan({ cls: "echo-notes-provider-capability-note-label", text: "推荐模型：" });
		modelsEl.createSpan({ text: capability.recommendedModels.join("、") });

		if (capability.notes.length > 0) {
			const detailsEl = capabilityEl.createEl("details", {
				cls: "echo-notes-provider-capability-details"
			});
			detailsEl.createEl("summary", { text: "查看限制与实现说明" });
			for (const note of capability.notes) {
				detailsEl.createDiv({ cls: "echo-notes-provider-capability-note", text: note });
			}
		}
	}

	private renderProviderDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("转写配置自检")
			.setDesc("本地检查 API Key、Base URL、模型和服务商能力限制；不会上传音频，也不会真实调用服务商接口。")
			.addButton((button) =>
				button
					.setButtonText("检查转写配置")
					.onClick(() => {
					const config = this.getSelectedTranscriptionConfig();
					const result = diagnoseTranscriptionProviderSettings(config, this.plugin.getApiKey(config.provider), {
						isMobile: Platform.isMobile,
						isFileSystemVault: this.app.vault.adapter instanceof FileSystemAdapter,
						usage: this.getSelectedTranscriptionMode()
					});
					new ProviderDiagnosticsModal(
						this.app,
						result.providerLabel,
						result.canAttemptTranscription,
						result.items
					).open();
					})
			);
	}

	private renderAnalysisTemplateCard(containerEl: HTMLElement, template: AnalysisTemplateConfig): void {
		const keywords = template.recognitionKeywords.length > 0 ? template.recognitionKeywords.join("、") : "未设置";
		const cardEl = containerEl.createDiv({ cls: "echo-notes-template-card" });
		if (!template.enabled) {
			cardEl.addClass("is-disabled");
		}

		const contentEl = cardEl.createDiv({ cls: "echo-notes-template-card-content" });
		const headerEl = contentEl.createDiv({ cls: "echo-notes-template-card-header" });
		headerEl.createDiv({ cls: "echo-notes-template-card-title", text: template.name || template.id });

		const badgesEl = headerEl.createDiv({ cls: "echo-notes-template-badges" });
		if (template.id === this.plugin.settings.defaultAnalysisTemplateId) {
			badgesEl.createSpan({ cls: "echo-notes-template-badge is-default", text: "默认" });
		}
		if (template.builtin) {
			badgesEl.createSpan({ cls: "echo-notes-template-badge", text: "预设" });
		}
		badgesEl.createSpan({ cls: "echo-notes-template-badge", text: `v${template.version ?? DEFAULT_ANALYSIS_TEMPLATE_VERSION}` });
		if (!template.enabled) {
			badgesEl.createSpan({ cls: "echo-notes-template-badge is-disabled", text: "未启用" });
		}

		contentEl.createDiv({
			cls: "echo-notes-template-description",
			text: template.description || "未设置用途说明。"
		});

		const keywordEl = contentEl.createDiv({ cls: "echo-notes-template-keywords" });
		keywordEl.createSpan({ cls: "echo-notes-template-keywords-label", text: "识别关键字：" });
		keywordEl.createSpan({ cls: "echo-notes-template-keywords-value", text: keywords });

		const actionEl = cardEl.createDiv({ cls: "echo-notes-template-card-actions" });
		const toggleEl = actionEl.createDiv({ cls: "echo-notes-template-enable" });
		toggleEl.createSpan({ text: "启用" });
		const enabledToggle = new ToggleComponent(toggleEl)
			.setValue(template.enabled)
			.setTooltip(`${template.enabled ? "停用" : "启用"}${template.name || template.id}`)
			.onChange(async (value) => {
				template.enabled = value;
				await this.plugin.saveSettings();
				this.refreshSettings();
			});
		enabledToggle.toggleEl.setAttribute("aria-label", `${template.enabled ? "停用" : "启用"}${template.name || template.id}`);
		const editButton = actionEl.createEl("button", {
			cls: "mod-cta",
			text: "编辑"
		});
		editButton.type = "button";
		editButton.addEventListener("click", () => {
			new AnalysisTemplateEditModal(this.app, this.plugin, template, () => {
				this.activeAnalysisTemplateCategory = template.category;
				this.refreshSettings();
			}).open();
		});

		const secondaryButton = actionEl.createEl("button", {
			text: template.builtin ? "恢复默认" : "删除"
		});
		secondaryButton.type = "button";
		secondaryButton.addEventListener("click", () => {
			if (template.builtin) {
				void this.restoreBuiltInAnalysisTemplate(template.id);
				return;
			}
			void this.deleteCustomAnalysisTemplate(template.id);
		});
	}

	private async restoreBuiltInAnalysisTemplate(templateId: string): Promise<void> {
		const restored = restoreDefaultAnalysisTemplate(templateId);
		if (!restored) {
			return;
		}
		const index = this.plugin.settings.analysisTemplates.findIndex((candidate) => candidate.id === templateId);
		if (index !== -1) {
			this.plugin.settings.analysisTemplates.splice(index, 1, restored);
		}
		await this.plugin.saveSettings();
		this.refreshSettings();
	}

	private async deleteCustomAnalysisTemplate(templateId: string): Promise<void> {
		this.plugin.settings.analysisTemplates = this.plugin.settings.analysisTemplates.filter(
			(candidate) => candidate.id !== templateId
		);
		await this.plugin.saveSettings();
		this.refreshSettings();
	}

	private scheduleSettingsGuideSync(): void {
		if (this.settingsGuideSyncTimer !== null) {
			window.clearTimeout(this.settingsGuideSyncTimer);
		}
		this.settingsGuideSyncTimer = window.setTimeout(() => {
			this.settingsGuideSyncTimer = null;
			this.syncSettingsGuide();
		}, 0);
	}

	private syncSettingsGuide(): void {
		const session = this.activeSettingsGuide;
		const rootEl = this.settingsContainerEl ?? this.containerEl;
		if (!session || !rootEl.isConnected) {
			this.settingsSpotlight.close();
			return;
		}

		if (
			session.destination === "analysis-model" &&
			session.step === "analysis-enable" &&
			this.plugin.settings.analysisEnabled
		) {
			session.step = "provider";
		}

		const step = this.createSettingsSpotlightStep(rootEl, session);
		if (!step) {
			this.settingsSpotlight.close();
			return;
		}
		this.settingsSpotlight.present(
			step,
			{
				onAction: () => this.advanceSettingsGuide(),
				onSecondaryAction: () => this.closeSettingsGuide(),
				onClose: () => this.closeSettingsGuide()
			}
		);
	}

	private createSettingsSpotlightStep(
		rootEl: HTMLElement,
		session: ActiveSettingsGuide
	): SettingsSpotlightStep | null {
		const isAnalysis = session.destination === "analysis-model";
		const isMemory = session.destination === "memory-model";
		let targetName: string;
		let focusSelector: string;
		let stepLabel: string;
		let title: string;
		let description: string;
		let actionLabel: string;
		let actionDisabled = false;
		let secondaryActionLabel: string | undefined;

		switch (session.step) {
			case "analysis-enable":
				targetName = "analysis-enabled";
				focusSelector = ".checkbox-container";
				stepLabel = "准备步骤";
				title = "先开启 AI 分析";
				description = "开启后将显示服务商和 API Key 配置，本指引会自动继续下一步。";
				actionLabel = "开启后继续";
				actionDisabled = true;
				break;
			case "provider":
				targetName = isAnalysis
					? "analysis-provider"
					: isMemory ? "memory-provider" : "transcription-provider";
				focusSelector = "select";
				stepLabel = "1/2";
				if (isAnalysis) {
					title = "选择 AI 分析服务商";
					description = "选择用于把转写稿生成 AI 笔记的服务商。不同服务商使用独立 API Key。";
				} else if (isMemory) {
					title = "选择记忆提取服务商";
					description = "选择用于提取候选记忆的服务商。记忆 API Key 与转写、分析配置相互隔离。";
				} else if (this.getSelectedTranscriptionMode() === "realtime") {
					title = "确认实时转写服务商";
					description = "实时转写目前固定使用火山引擎 AgentPlan，无需修改；下一步填写专属 API Key。";
				} else {
					title = "选择转写服务商";
					description = "选择用于处理音频文件的转写服务商。不同服务商使用独立 API Key。";
				}
				actionLabel = "下一步";
				break;
			case "api-key":
				targetName = isAnalysis
					? "analysis-api-key"
					: isMemory ? "memory-api-key" : "transcription-api-key";
				focusSelector = 'input[type="password"]';
				stepLabel = "2/2";
				title = isAnalysis
					? "填写分析 API Key"
					: isMemory ? "填写记忆 API Key" : "填写转写 API Key";
				description = "在所选服务商后台创建并粘贴密钥。密钥只保存在 Obsidian SecretStorage，不会写入插件设置文件。";
				actionLabel = "返回新人指引";
				secondaryActionLabel = "留在设置";
				break;
		}

		const targetEl = rootEl.querySelector<HTMLElement>(
			`[data-echo-notes-guide-target="${targetName}"]`
		);
		if (!targetEl || targetEl.closest<HTMLElement>("[hidden]")) {
			return null;
		}
		const detailsEl = targetEl.closest<HTMLDetailsElement>("details");
		if (detailsEl && !detailsEl.open) {
			detailsEl.open = true;
		}

		return {
			targetEl,
			focusEl: targetEl.querySelector<HTMLElement>(focusSelector),
			stepLabel,
			title,
			description,
			actionLabel,
			actionDisabled,
			secondaryActionLabel
		};
	}

	private advanceSettingsGuide(): void {
		const session = this.activeSettingsGuide;
		if (!session) {
			return;
		}
		if (session.step === "provider") {
			session.step = "api-key";
			this.syncSettingsGuide();
			return;
		}
		if (session.step === "api-key") {
			this.closeSettingsGuide(true);
		}
	}

	private refreshSettings(): void {
		this.clearDeferredSaveTimers();
		this.renderSettings(this.settingsContainerEl ?? this.containerEl);
	}

	private createSecretSaveStatus(setting: Setting, apiKey: string): HTMLElement {
		setting.controlEl.addClass("echo-notes-settings-control-feedback");
		const statusEl = setting.controlEl.createDiv({
			cls: "echo-notes-inline-validation echo-notes-secret-save-status"
		});
		this.setSecretSaveStatus(statusEl, apiKey ? "saved" : "empty");
		return statusEl;
	}

	private bindDeferredTextSave(
		setting: Setting,
		key: string,
		inputEl: HTMLInputElement,
		save: (value: string) => Promise<void>,
		validate?: (value: string) => string | undefined,
		feedbackEl?: HTMLElement
	): void {
		setting.controlEl.addClass("echo-notes-settings-control-feedback");
		const validationEl = feedbackEl ?? setting.controlEl.createDiv({ cls: "echo-notes-inline-validation" });
		validationEl.addClass("echo-notes-inline-validation");
		validationEl.setAttribute("role", "status");
		validationEl.setAttribute("aria-live", "polite");
		const renderValidation = (value: string): boolean => {
			const message = validate?.(value);
			if (message) {
				renderStatusIndicator(validationEl, { tone: "failed", text: message, live: "polite" }, setIcon);
			} else if (value.trim()) {
				renderStatusIndicator(validationEl, {
					tone: "neutral",
					text: "修改将在失焦后保存",
					live: "polite"
				}, setIcon);
			} else {
				clearStatusIndicator(validationEl);
			}
			return !message;
		};
		const commit = (): void => {
			const existing = this.deferredSaveTimers.get(key);
			if (existing !== undefined) {
				window.clearTimeout(existing);
			}
			this.deferredSaveTimers.delete(key);
			const value = inputEl.value.trim();
			if (!renderValidation(value)) {
				return;
			}
			void save(value).then(() => {
				if (feedbackEl) {
					return;
				}
				renderStatusIndicator(validationEl, {
					tone: "success",
					text: value ? "已保存" : "已清除",
					live: "polite"
				}, setIcon);
			}).catch((error) => {
				renderStatusIndicator(validationEl, {
					tone: "failed",
					text: `保存失败：${getSanitizedErrorMessage(error)}`,
					live: "polite"
				}, setIcon);
			});
		};
		const schedule = (delay: number): void => {
			const existing = this.deferredSaveTimers.get(key);
			if (existing !== undefined) {
				window.clearTimeout(existing);
			}
			const timer = window.setTimeout(commit, delay);
			this.deferredSaveTimers.set(key, timer);
		};
		inputEl.addEventListener("input", () => {
			renderValidation(inputEl.value);
			schedule(650);
		});
		inputEl.addEventListener("blur", () => schedule(80));
	}

	private clearDeferredSaveTimers(): void {
		for (const timer of this.deferredSaveTimers.values()) {
			window.clearTimeout(timer);
		}
		this.deferredSaveTimers.clear();
	}

	private renderAdvancedSection(
		containerEl: HTMLElement,
		title: string,
		render: (contentEl: HTMLElement) => void
	): HTMLElement {
		const detailsEl = containerEl.createEl("details", { cls: "echo-notes-settings-advanced" });
		detailsEl.createEl("summary", { text: title });
		const contentEl = detailsEl.createDiv({ cls: "echo-notes-settings-advanced-content" });
		render(contentEl);
		return contentEl;
	}

	private renderBasicHeading(containerEl: HTMLElement, text = "基础配置"): void {
		containerEl.createDiv({ cls: "echo-notes-settings-basic-heading", text });
	}

	private setSecretSaveStatus(statusEl: HTMLElement, status: "empty" | "saved" | "cleared" | "failed"): void {
		let tone: StatusIndicatorTone;
		let text: string;
		switch (status) {
			case "saved":
				tone = "success";
				text = "已安全保存";
				break;
			case "cleared":
				tone = "success";
				text = "已清除";
				break;
			case "failed":
				tone = "failed";
				text = "保存失败";
				break;
			default:
				tone = "neutral";
				text = "未保存 API Key";
		}
		renderStatusIndicator(statusEl, { tone, text, live: "polite" }, setIcon);
	}

	private applyOfflineProviderDefaults(provider: OfflineTranscriptionProviderId): void {
		const defaults = getOfflineTranscriptionProviderDefaults(provider);
		this.plugin.settings.offlineTranscription.baseUrl = defaults.baseUrl;
		this.plugin.settings.offlineTranscription.model =
			provider === "mosi"
				? getMosiTranscriptionModel(
						this.plugin.settings.mosiSpeakerDiarizationEnabled
					)
				: defaults.model;
		this.plugin.settings.offlineTranscription.language = defaults.language;
	}

	private applyAnalysisProviderDefaults(provider: AnalysisProviderId): void {
		const defaults = ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
		this.plugin.settings.analysisBaseUrl = defaults.analysisBaseUrl;
		this.plugin.settings.analysisModel = defaults.analysisModel;
	}

	private applyMemoryProviderDefaults(provider: AnalysisProviderId): void {
		const defaults = ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
		this.plugin.settings.memoryBaseUrl = defaults.analysisBaseUrl;
		this.plugin.settings.memoryModel = defaults.analysisModel;
	}

	private getProviderDefaults(): Omit<TranscriptionConfig, "provider"> {
		const provider = this.getSelectedTranscriptionConfig().provider;
		if (
			this.getSelectedTranscriptionMode() === "offline" &&
			isOfflineTranscriptionProviderId(provider)
		) {
			return getOfflineTranscriptionProviderDefaults(provider);
		}
		return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS["aliyun-bailian"];
	}

	private getSelectedTranscriptionConfig(): TranscriptionConfig {
		return this.getSelectedTranscriptionMode() === "realtime"
			? this.plugin.settings.realtimeTranscription
			: this.plugin.settings.offlineTranscription;
	}

	private getSelectedTranscriptionMode(): "realtime" | "offline" {
		return this.isGettingStartedOfflineTranscriptionGuide()
			? "offline"
			: this.plugin.settings.transcriptionMode;
	}

	private isGettingStartedOfflineTranscriptionGuide(): boolean {
		return this.activeSettingsGuide?.destination === "transcription-service";
	}

	private getAnalysisProviderDefaults(): Pick<EchoNotesPlugin["settings"], "analysisBaseUrl" | "analysisModel"> {
		const provider = isAnalysisProviderId(this.plugin.settings.analysisProvider)
			? this.plugin.settings.analysisProvider
			: "aliyun-bailian";
		return ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
	}

	private getMemoryProviderDefaults(): Pick<EchoNotesPlugin["settings"], "analysisBaseUrl" | "analysisModel"> {
		const provider = isAnalysisProviderId(this.plugin.settings.memoryProvider)
			? this.plugin.settings.memoryProvider
			: "aliyun-bailian";
		return ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
	}

	private getBaseUrlDescription(): string {
		switch (this.getSelectedTranscriptionConfig().provider) {
			case "volcengine-agentplan":
				return "AgentPlan ASR 优化双流 WebSocket 端点；实时写入确定分句并保留二遍高精度结果，仅支持 Obsidian 桌面端。";
			case "aliyun-bailian":
				return "阿里百炼 OpenAI 兼容模式基础地址。国内默认 https://dashscope.aliyuncs.com/compatible-mode/v1。";
			case "ollama":
				return "Ollama OpenAI 兼容基础地址，默认 http://localhost:11434/v1。需确认本地服务支持音频转写接口。";
			case "lm-studio":
				return "LM Studio OpenAI 兼容基础地址，默认 http://localhost:1234/v1。需确认本地服务支持音频转写接口。";
			case "siliconflow":
				return "硅基流动（SiliconFlow）API 基础地址。";
			case "mosi":
				return "MOSI 官方转写 API 基础地址；普通转写与说话人分离共用该只读地址。";
			default:
				return "该服务商的基础地址。";
		}
	}

	private getTranscriptionLanguageDescription(): string {
		const capability = getTranscriptionProviderCapability(
			this.getSelectedTranscriptionConfig().provider,
			this.getSelectedTranscriptionMode()
		);
		if (!capability.supportsLanguage) {
			return "默认 ASR 转写语言。当前服务商不支持语言参数，此设置不会传给服务商，仍由模型自动识别。";
		}

		return "默认 ASR 转写语言。支持语言参数的服务商会随请求发送该值；auto 表示由服务商自动识别。";
	}

	private appendProviderSignupLink(desc: DocumentFragment, provider: string): void {
		const linkConfig = provider === "volcengine-agentplan"
			? {
				text: "获取 AgentPlan API Key",
				href: "https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan"
			}
			: provider === "mosi"
				? {
					text: "打开 MOSI API Key 管理",
					href: "https://platform.mosi.cn/app/api-keys"
				}
				: provider === "siliconflow"
					? {
						text: "获取硅基流动 API Key",
						href: "https://cloud.siliconflow.cn/i/uTf2euFF"
					}
					: null;
		if (!linkConfig) {
			return;
		}
		const actionRowEl = desc.createSpan({ cls: "echo-notes-settings-api-key-link-row" });
		const linkEl = actionRowEl.createEl("a", {
			cls: "echo-notes-settings-api-key-link",
			attr: {
				href: linkConfig.href,
				target: "_blank",
				rel: "noopener noreferrer"
			}
		});
		linkEl.createSpan({ text: linkConfig.text });
		const iconEl = linkEl.createSpan({ cls: "echo-notes-settings-api-key-link-icon" });
		iconEl.setAttribute("aria-hidden", "true");
		setIcon(iconEl, "external-link");
	}
}

function getProviderOptionLabel(value: string, label: string): string {
	return value === "aliyun-bailian" ? `【推荐】${label}` : label;
}

function getUploadModeLabel(uploadMode: string): string {
	switch (uploadMode) {
		case "multipart":
			return "multipart";
		case "base64-data-url":
			return "Base64 Data URL";
		case "websocket-stream":
			return "WebSocket 实时流";
		default:
			return uploadMode;
	}
}

function getEndpointShapeLabel(endpointShape: string): string {
	switch (endpointShape) {
		case "openai-audio":
			return "/audio/transcriptions";
		case "chat-audio":
			return "/chat/completions + input_audio";
		case "agentplan-asr-websocket":
			return "AgentPlan ASR WebSocket";
		case "mosi-transcription":
			return "MOSI /v1/audio/transcriptions";
		case "custom":
			return "专用接口";
		default:
			return endpointShape;
	}
}

class AnalysisTemplateEditModal extends Modal {
	private plugin: EchoNotesPlugin;
	private template: AnalysisTemplateConfig;
	private onSaved: () => void;
	private draft: AnalysisTemplateConfig;

	constructor(app: App, plugin: EchoNotesPlugin, template: AnalysisTemplateConfig, onSaved: () => void) {
		super(app);
		this.plugin = plugin;
		this.template = template;
		this.onSaved = onSaved;
		this.draft = {
			...template,
			recognitionKeywords: [...template.recognitionKeywords]
		};
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("echo-notes-template-modal");
		this.titleEl.setText("编辑分析模板");

		new Setting(contentEl)
			.setName("模板名称")
			.setDesc("用于设置页展示，以及转写稿内 AI 纪要分析区块的模板标题。")
			.addText((text) =>
				text
					.setValue(this.draft.name)
					.onChange((value) => {
						this.draft.name = value;
					})
			);

		new Setting(contentEl)
			.setName("模板版本")
			.setDesc("用于写入分析结果的 Dataview 元数据。修改提示词或输出结构后，建议同步更新版本。")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_ANALYSIS_TEMPLATE_VERSION)
					.setValue(this.draft.version ?? DEFAULT_ANALYSIS_TEMPLATE_VERSION)
					.onChange((value) => {
						this.draft.version = value;
					})
			);

		if (this.draft.builtin) {
			new Setting(contentEl)
				.setName("角色分类")
				.setDesc(getAnalysisTemplateCategoryDefinition(this.draft.category).label);
		} else {
			new Setting(contentEl)
				.setName("角色分类")
				.setDesc("用于模板管理、默认模板和手动选择时的分组。")
				.addDropdown((dropdown) => {
					for (const category of ANALYSIS_TEMPLATE_CATEGORIES) {
						dropdown.addOption(category.id, category.label);
					}
					dropdown
						.setValue(this.draft.category)
						.onChange((value) => {
							this.draft.category = value as AnalysisTemplateCategoryId;
						});
				});
		}

		new Setting(contentEl)
			.setName("启用模板")
			.setDesc("开启后，此模板会参与录音链接上下三行的关键字识别；关闭后仍保留配置但不会自动使用。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.draft.enabled)
					.onChange((value) => {
						this.draft.enabled = value;
					})
			);

		new Setting(contentEl)
			.setName("识别关键字")
			.setDesc("用于匹配录音链接上下三行文本。支持多个关键字，可用换行、逗号或顿号分隔。")
			.addTextArea((text) => {
				text.inputEl.rows = 4;
				text.inputEl.cols = 60;
				text
					.setPlaceholder("学习纪要\n课程笔记")
					.setValue(this.draft.recognitionKeywords.join("\n"))
					.onChange((value) => {
						this.draft.recognitionKeywords = parseRecognitionKeywordsInput(value);
					});
			});

		new Setting(contentEl)
			.setName("系统提示词")
			.setDesc("定义 AI 的角色、边界、输出原则和通用质量要求。留空保存时会恢复为默认系统提示词。")
			.addTextArea((text) => {
				text.inputEl.rows = 12;
				text.inputEl.cols = 72;
				text
					.setValue(this.draft.systemPrompt)
					.onChange((value) => {
						this.draft.systemPrompt = value;
					});
			});

		new Setting(contentEl)
			.setName("模板任务")
			.setDesc("定义该模板的分析重点、Markdown 结构和特殊输出要求。")
			.addTextArea((text) => {
				text.inputEl.rows = 10;
				text.inputEl.cols = 72;
				text
					.setValue(this.draft.customPrompt)
					.onChange((value) => {
						this.draft.customPrompt = value;
					});
			});

		new Setting(contentEl)
			.addButton((button) =>
				button
					.setButtonText("保存")
					.setCta()
					.onClick(() => {
						void this.save();
					})
			)
			.addButton((button) =>
				button
					.setButtonText("取消")
					.onClick(() => {
						this.close();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private async save(): Promise<void> {
		this.template.name = this.draft.name.trim() || this.template.id;
		this.template.version = this.draft.version?.trim() || DEFAULT_ANALYSIS_TEMPLATE_VERSION;
		if (!this.template.builtin) {
			this.template.category = this.draft.category;
		}
		this.template.enabled = this.draft.enabled;
		this.template.systemPrompt = this.draft.systemPrompt.trim() || DEFAULT_ANALYSIS_SYSTEM_PROMPT;
		this.template.customPrompt = this.draft.customPrompt.trim();
		this.template.recognitionKeywords =
			this.draft.recognitionKeywords.length > 0 ? this.draft.recognitionKeywords : [this.template.name];

		await this.plugin.saveSettings();
		this.onSaved();
		this.close();
	}
}

class ProviderDiagnosticsModal extends Modal {
	private providerLabel: string;
	private canAttemptTranscription: boolean;
	private items: ProviderDiagnosticItem[];

	constructor(app: App, providerLabel: string, canAttemptTranscription: boolean, items: ProviderDiagnosticItem[]) {
		super(app);
		this.providerLabel = providerLabel;
		this.canAttemptTranscription = canAttemptTranscription;
		this.items = items;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("echo-notes-provider-diagnostics-modal");
		this.titleEl.setText("转写配置自检");

		const summaryEl = contentEl.createDiv({ cls: "echo-notes-provider-diagnostics-summary" });
		renderStatusIndicator(summaryEl, {
			tone: this.canAttemptTranscription ? "success" : "failed",
			text: `${this.providerLabel}：${this.canAttemptTranscription ? "未发现阻塞性问题。" : "存在需要先处理的问题。"}`
		}, setIcon);

		const listEl = contentEl.createDiv({ cls: "echo-notes-provider-diagnostics-list" });
		for (const item of this.items) {
			const itemEl = listEl.createDiv({
				cls: `echo-notes-provider-diagnostics-item is-${item.severity}`
			});
			const headerEl = itemEl.createDiv({ cls: "echo-notes-provider-diagnostics-header" });
			const statusEl = headerEl.createSpan({ cls: "echo-notes-provider-diagnostics-badge" });
			renderStatusIndicator(statusEl, {
				tone: getDiagnosticStatusTone(item.severity),
				text: getDiagnosticSeverityLabel(item.severity)
			}, setIcon);
			headerEl.createSpan({ cls: "echo-notes-provider-diagnostics-title", text: item.title });
			itemEl.createDiv({ cls: "echo-notes-provider-diagnostics-detail", text: item.detail });
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("关闭")
				.setCta()
				.onClick(() => {
					this.close();
				})
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

function getDiagnosticSeverityLabel(severity: ProviderDiagnosticSeverity): string {
	switch (severity) {
		case "error":
			return "错误";
		case "warning":
			return "警告";
		case "info":
		default:
			return "提示";
	}
}

function getDiagnosticStatusTone(severity: ProviderDiagnosticSeverity): StatusIndicatorTone {
	return severity === "error" ? "failed" : severity === "warning" ? "warning" : "neutral";
}

function validateBaseUrl(value: string): string | undefined {
	if (!value.trim()) {
		return "Base URL 不能为空。";
	}
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1"].includes(url.hostname)) {
			return "远程 Base URL 必须使用 HTTPS。";
		}
		return undefined;
	} catch {
		return "请输入完整的 URL，例如 https://api.example.com/v1。";
	}
}

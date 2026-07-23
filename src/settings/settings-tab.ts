import { App, Modal, Notice, Platform, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
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
import { getSanitizedErrorMessage } from "../security/redaction";
import {
	ANALYSIS_PROVIDER_DEFAULTS,
	ANALYSIS_PROVIDER_LABELS,
	COPY_LANGUAGE_LABELS,
	DEFAULT_ANALYSIS_TEMPLATE_VERSION,
	DEFAULT_ANALYSIS_SYSTEM_PROMPT,
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
	TRANSCRIPTION_LANGUAGE_LABELS,
	createCustomAnalysisTemplate,
	formatHotkey,
	isAnalysisProviderId,
	isProviderId,
	normalizeTranscriptionLanguageForProvider,
	parseHotkeyInput,
	parseRecognitionKeywordsInput,
	restoreDefaultAnalysisTemplate,
	type AnalysisProviderId,
	type AnalysisTemplateConfig,
	type AgentPlanSpeakerLabelStyle,
	type CopyLanguage,
	type EchoNotesHotkeySetting,
	type InsertStyle,
	type OutputStrategy,
	type TranscriptionProviderId
} from "./settings";

export class EchoNotesSettingTab extends PluginSettingTab {
	private plugin: EchoNotesPlugin;
	private settingsContainerEl: HTMLElement | null = null;

	constructor(app: App, plugin: EchoNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Echo Notes settings",
				searchable: false,
				render: (_setting, group) => {
					this.renderSettings(group.listEl);
				}
			}
		];
	}

	display(): void {
		this.renderSettings(this.containerEl);
	}

	private renderSettings(containerEl: HTMLElement): void {
		this.settingsContainerEl = containerEl;
		containerEl.empty();

		this.renderOfficialRecorderSettings(containerEl);

		new Setting(containerEl).setName("Provider").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("选择用于音频转写的服务商。切换后会自动填入该 Provider 的默认 Base URL 和模型。")
			.addDropdown((dropdown) =>
				Object.entries(PROVIDER_LABELS)
					.reduce((control, [value, label]) => control.addOption(value, getProviderOptionLabel(value, label)), dropdown)
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						if (!isProviderId(value)) {
							return;
						}
						this.plugin.settings.provider = value;
						this.applyProviderDefaults(value);
						await this.plugin.saveSettings();
						this.refreshSettings();
					})
			);

		this.renderProviderSignup(containerEl);
		this.renderProviderCapability(containerEl);

		const apiKeySetting = new Setting(containerEl)
			.setName("API Key")
			.setDesc("用于调用当前服务商的 API Key，会按 Provider 隔离保存到 Obsidian SecretStorage，切换 Provider 不会复用或发送其他服务商的密钥。");
		const apiKeyStatusEl = this.createSecretSaveStatus(apiKeySetting, this.plugin.getApiKey());
		apiKeySetting.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.getApiKey())
					.onChange(async (value) => {
						try {
							const apiKey = value.trim();
							await this.plugin.saveApiKey(apiKey);
							this.setSecretSaveStatus(apiKeyStatusEl, apiKey ? "saved" : "cleared");
						} catch (error) {
							this.setSecretSaveStatus(apiKeyStatusEl, "failed");
							new Notice(`API Key 保存失败：${getSanitizedErrorMessage(error)}`);
						}
					});
			});

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc(this.getBaseUrlDescription())
			.addText((text) =>
				text
					.setPlaceholder(this.getProviderDefaults().baseUrl)
					.setValue(this.plugin.settings.baseUrl)
					.onChange(async (value) => {
						this.plugin.settings.baseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Model")
			.setDesc("转写模型名称。")
			.addText((text) =>
				text
					.setPlaceholder(this.getProviderDefaults().model)
					.setValue(this.plugin.settings.model)
					.onChange(async (value) => {
						this.plugin.settings.model = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("默认转写语言")
			.setDesc(`${this.getTranscriptionLanguageDescription()} 如需 cmn、yue、fr、de 等其他代码，请使用下方自定义语言代码。`)
			.addDropdown((dropdown) => {
				for (const [value, label] of Object.entries(TRANSCRIPTION_LANGUAGE_LABELS)) {
					dropdown.addOption(value, label);
				}
				const currentLanguage = this.plugin.settings.language || "auto";
				if (!Object.prototype.hasOwnProperty.call(TRANSCRIPTION_LANGUAGE_LABELS, currentLanguage)) {
					dropdown.addOption(currentLanguage, `自定义：${currentLanguage}`);
				}
				return dropdown
					.setValue(currentLanguage)
					.onChange(async (value) => {
						const normalizedLanguage = normalizeTranscriptionLanguageForProvider(
							this.plugin.settings.provider,
							value || "auto"
						);
						this.plugin.settings.language = normalizedLanguage;
						await this.plugin.saveSettings();
						if (normalizedLanguage !== value) {
							new Notice("AgentPlan 说话人分离仅支持 auto 或中文，已自动切换为 auto。");
							this.refreshSettings();
						}
					});
			});

		new Setting(containerEl)
			.setName("自定义语言代码")
			.setDesc("可填写当前 Provider 支持的任意语言代码。保存后会覆盖上方预设；清空不会改变当前语言。")
			.addText((text) => {
				const currentLanguage = this.plugin.settings.language;
				const customLanguage = Object.prototype.hasOwnProperty.call(TRANSCRIPTION_LANGUAGE_LABELS, currentLanguage)
					? ""
					: currentLanguage;
				let draftValue = customLanguage;
				text
					.setPlaceholder("例如 cmn、yue、fr")
					.setValue(customLanguage)
					.onChange((value) => {
						draftValue = value;
					});
				text.inputEl.addEventListener("blur", () => {
					const value = draftValue.trim();
					if (!value || value === this.plugin.settings.language) {
						return;
					}
					const normalizedLanguage = normalizeTranscriptionLanguageForProvider(
						this.plugin.settings.provider,
						value
					);
					this.plugin.settings.language = normalizedLanguage;
					if (normalizedLanguage !== value) {
						new Notice("AgentPlan 说话人分离仅支持 auto 或中文，已自动切换为 auto。");
					}
					void this.plugin.saveSettings().then(() => this.refreshSettings());
				});
			});

		if (this.plugin.settings.provider === "volcengine-agentplan") {
			new Setting(containerEl)
				.setName("说话人标签样式")
				.setDesc("AgentPlan 始终启用说话人聚类。可只标记说话人，或同时显示每轮发言的起止时间；单人录音也会显示“说话人 1”。")
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

		this.renderAnalysisSettings(containerEl);

		new Setting(containerEl).setName("输出与插入").setHeading();

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
					.addOption("linkOnly", "普通内部链接（linkOnly）")
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

		new Setting(containerEl).setName("自动化").setHeading();

		new Setting(containerEl)
			.setName("手动转写前确认上传")
			.setDesc("开启后，手动转写会先显示 Provider、Base URL、模型和文件大小；自动化转写会跳过需要确认的上传，避免后台发送音频。")
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
			.setDesc("监听笔记变更，发现新增音频链接后将音频后台上传到当前转写 Provider，并自动生成转写稿和补充链接。带有 Echo Notes 隐私标记的笔记会跳过自动化。")
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
			.setDesc("监听 Vault 新增音频文件，并在后台上传到当前转写 Provider 以自动生成 transcript；该模式没有来源笔记隐私标记，也不会回写来源笔记。")
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
			.setDesc(`控制 Obsidian Core plugin：Audio recorder。当前状态：${status}。`)
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
			this.plugin.getOfficialAudioRecorderStartHotkey(),
			(hotkey) => this.plugin.setOfficialAudioRecorderStartHotkey(hotkey)
		);

		this.renderHotkeySetting(
			containerEl,
			"Obsidian 核心插件录音机关闭快捷键",
			"直接修改 Obsidian 核心命令 audio-recorder:stop 的快捷键。Echo Notes 不预设快捷键，避免覆盖已有操作。",
			"例如 Ctrl+S",
			this.plugin.getOfficialAudioRecorderStopHotkey(),
			(hotkey) => this.plugin.setOfficialAudioRecorderStopHotkey(hotkey)
		);

		this.renderHotkeySetting(
			containerEl,
			"转写当前笔记全部音频快捷键",
			"触发 Echo Notes: Transcribe all audio files in current note。默认留空，请选择不与撤销等系统操作冲突的组合。",
			"例如 Mod+Shift+T",
			this.plugin.settings.transcribeAllAudioHotkey,
			async (hotkey) => {
				this.plugin.settings.transcribeAllAudioHotkey = hotkey;
			}
		);
	}

	private renderHotkeySetting(
		containerEl: HTMLElement,
		name: string,
		description: string,
		placeholder: string,
		currentHotkey: EchoNotesHotkeySetting,
		applyHotkey: (hotkey: EchoNotesHotkeySetting) => Promise<boolean | void>
	): void {
		let draftValue = formatHotkey(currentHotkey);
		new Setting(containerEl)
			.setName(name)
			.setDesc(`${description} 支持 Ctrl+L、Control + L、Cmd+Shift+P 等写法；无效输入不会保存。`)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(draftValue)
					.onChange((value) => {
						draftValue = value;
					})
			)
			.addButton((button) =>
				button
					.setButtonText("保存")
					.onClick(async () => {
						const hotkey = parseHotkeyInput(draftValue);
						if (hotkey === undefined) {
							new Notice(`快捷键格式无效：${draftValue}`);
							return;
						}

						const applied = await applyHotkey(hotkey);
						if (applied === false) {
							return;
						}
						await this.plugin.saveSettings();
						this.plugin.refreshRegisteredCommands();
						this.refreshSettings();
					})
			);
	}

	private renderAnalysisSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("AI 纪要分析").setHeading();

		new Setting(containerEl)
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

		if (!this.plugin.settings.analysisEnabled) {
			return;
		}

		new Setting(containerEl)
			.setName("分析 Provider")
			.setDesc("用于对转写稿生成纪要的服务商。仅转写 Provider 不会出现在此列表中，默认使用阿里百炼。")
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

		const analysisApiKeySetting = new Setting(containerEl)
			.setName("分析 API Key")
			.setDesc("用于调用当前分析 Provider 的 API Key，会按 Provider 隔离保存到 Obsidian SecretStorage。");
		const analysisApiKeyStatusEl = this.createSecretSaveStatus(
			analysisApiKeySetting,
			this.plugin.getAnalysisApiKey()
		);
		analysisApiKeySetting.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.getAnalysisApiKey())
					.onChange(async (value) => {
						try {
							const apiKey = value.trim();
							await this.plugin.saveAnalysisApiKey(apiKey);
							this.setSecretSaveStatus(analysisApiKeyStatusEl, apiKey ? "saved" : "cleared");
						} catch (error) {
							this.setSecretSaveStatus(analysisApiKeyStatusEl, "failed");
							new Notice(`分析 API Key 保存失败：${getSanitizedErrorMessage(error)}`);
						}
					});
			});

		new Setting(containerEl)
			.setName("分析 Base URL")
			.setDesc("OpenAI-compatible Chat Completions 基础地址。请确认所选 Provider 支持 {Base URL}/chat/completions。")
			.addText((text) =>
				text
					.setPlaceholder(this.getAnalysisProviderDefaults().analysisBaseUrl)
					.setValue(this.plugin.settings.analysisBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.analysisBaseUrl = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("分析模型")
			.setDesc("用于生成纪要分析的文本模型。")
			.addText((text) =>
				text
					.setPlaceholder(this.getAnalysisProviderDefaults().analysisModel)
					.setValue(this.plugin.settings.analysisModel)
					.onChange(async (value) => {
						this.plugin.settings.analysisModel = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("分析配置自检")
			.setDesc("本地检查分析 API Key、Base URL、HTTPS 和模型；不会发送转写稿，也不会调用 Provider。")
			.addButton((button) =>
				button.setButtonText("检查分析配置").onClick(() => {
					const result = diagnoseAnalysisProviderSettings(this.plugin.settings, this.plugin.getAnalysisApiKey());
					new ProviderDiagnosticsModal(this.app, result.providerLabel, result.canAttemptAnalysis, result.items).open();
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
			new Setting(containerEl)
				.setName("分析分块字符数")
				.setDesc("范围 4,000～100,000。默认 24,000；值越小兼容性越高，但调用次数和成本越高。")
				.addText((text) =>
					text
						.setPlaceholder("24000")
						.setValue(String(this.plugin.settings.analysisChunkCharacters))
						.onChange(async (value) => {
							const parsed = Number(value);
							if (!Number.isFinite(parsed)) {
								return;
							}
							this.plugin.settings.analysisChunkCharacters = Math.min(100000, Math.max(4000, Math.round(parsed)));
							await this.plugin.saveSettings();
						})
				);
		}

		new Setting(containerEl)
			.setName("AI 分析前脱敏 transcript")
			.setDesc("开启后，仅在发送给分析模型前遮盖邮箱、电话、身份证号、金额、地址以及带标签的人名/公司名字段；Vault 中的原始 transcript 不会被改写。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.redactTranscriptBeforeAnalysis)
					.onChange(async (value) => {
						this.plugin.settings.redactTranscriptBeforeAnalysis = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("默认分析模板")
			.setDesc("录音链接上下三行未命中任何识别关键字时，使用这个模板生成 AI 纪要。若默认模板被禁用，会自动改用第一个已启用模板。")
			.addDropdown((dropdown) => {
				for (const template of this.plugin.settings.analysisTemplates) {
					const suffix = template.enabled ? "" : "（未启用）";
					dropdown.addOption(template.id, `${template.name}${suffix}`);
				}
				dropdown
					.setValue(this.plugin.settings.defaultAnalysisTemplateId)
					.onChange(async (value) => {
						this.plugin.settings.defaultAnalysisTemplateId = value;
						await this.plugin.saveSettings();
						this.refreshSettings();
					});
			});

		new Setting(containerEl).setName("分析模板").setHeading();

		const templateListEl = containerEl.createDiv({ cls: "echo-notes-template-list" });
		for (const template of this.plugin.settings.analysisTemplates) {
			this.renderAnalysisTemplateCard(templateListEl, template);
		}

		new Setting(containerEl)
			.setName("新增自定义模板")
			.setDesc("创建后可配置模板名称、识别关键字、系统提示词和自定义提示词。启用后会参与录音链接上下文匹配。")
			.addButton((button) =>
				button
					.setButtonText("新增模板")
					.onClick(async () => {
						const template = createCustomAnalysisTemplate("自定义模板", this.plugin.settings.analysisTemplates);
						this.plugin.settings.analysisTemplates.push(template);
						await this.plugin.saveSettings();
						const savedTemplate = this.plugin.settings.analysisTemplates.find((candidate) => candidate.id === template.id) ?? template;
						this.refreshSettings();
						new AnalysisTemplateEditModal(this.app, this.plugin, savedTemplate, () => this.refreshSettings()).open();
					})
			);
	}

	private renderProviderCapability(containerEl: HTMLElement): void {
		const providerId = this.plugin.settings.provider;
		const capability = getTranscriptionProviderCapability(providerId);
		const capabilityEl = containerEl.createDiv({ cls: "echo-notes-provider-capability" });
		const headerEl = capabilityEl.createDiv({ cls: "echo-notes-provider-capability-header" });
		headerEl.createDiv({ cls: "echo-notes-provider-capability-title", text: "当前 Provider 能力" });
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

		for (const note of capability.notes) {
			capabilityEl.createDiv({ cls: "echo-notes-provider-capability-note", text: note });
		}
	}

	private renderProviderDiagnostics(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("转写配置自检")
			.setDesc("本地检查 API Key、Base URL、模型和 Provider 能力限制；不会上传音频，也不会真实调用服务商接口。")
			.addButton((button) =>
				button
					.setButtonText("检查转写配置")
					.onClick(() => {
					const result = diagnoseTranscriptionProviderSettings(this.plugin.settings, this.plugin.getApiKey(), {
						isMobile: Platform.isMobile
					});
						new ProviderDiagnosticsModal(this.app, result.providerLabel, result.canAttemptTranscription, result.items).open();
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

		const keywordEl = contentEl.createDiv({ cls: "echo-notes-template-keywords" });
		keywordEl.createSpan({ cls: "echo-notes-template-keywords-label", text: "识别关键字：" });
		keywordEl.createSpan({ cls: "echo-notes-template-keywords-value", text: keywords });

		const actionEl = cardEl.createDiv({ cls: "echo-notes-template-card-actions" });
		const editButton = actionEl.createEl("button", {
			cls: "mod-cta",
			text: "编辑"
		});
		editButton.type = "button";
		editButton.addEventListener("click", () => {
			new AnalysisTemplateEditModal(this.app, this.plugin, template, () => this.refreshSettings()).open();
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

	private refreshSettings(): void {
		this.renderSettings(this.settingsContainerEl ?? this.containerEl);
	}

	private createSecretSaveStatus(setting: Setting, apiKey: string): HTMLElement {
		const statusEl = setting.descEl.createDiv({ cls: "echo-notes-secret-save-status" });
		this.setSecretSaveStatus(statusEl, apiKey ? "saved" : "empty");
		return statusEl;
	}

	private setSecretSaveStatus(statusEl: HTMLElement, status: "empty" | "saved" | "cleared" | "failed"): void {
		statusEl.removeClass("is-success", "is-error");
		switch (status) {
			case "saved":
				statusEl.addClass("is-success");
				statusEl.setText("已安全保存");
				break;
			case "cleared":
				statusEl.addClass("is-success");
				statusEl.setText("已清除");
				break;
			case "failed":
				statusEl.addClass("is-error");
				statusEl.setText("保存失败");
				break;
			default:
				statusEl.setText("未保存 API Key");
		}
	}

	private applyProviderDefaults(provider: TranscriptionProviderId): void {
		const defaults = PROVIDER_DEFAULTS[provider];
		this.plugin.settings.baseUrl = defaults.baseUrl;
		this.plugin.settings.model = defaults.model;
		this.plugin.settings.language = defaults.language;
	}

	private applyAnalysisProviderDefaults(provider: AnalysisProviderId): void {
		const defaults = ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
		this.plugin.settings.analysisBaseUrl = defaults.analysisBaseUrl;
		this.plugin.settings.analysisModel = defaults.analysisModel;
	}

	private getProviderDefaults(): Pick<EchoNotesPlugin["settings"], "baseUrl" | "model" | "language"> {
		const provider = isProviderId(this.plugin.settings.provider) ? this.plugin.settings.provider : "aliyun-bailian";
		return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS["aliyun-bailian"];
	}

	private getAnalysisProviderDefaults(): Pick<EchoNotesPlugin["settings"], "analysisBaseUrl" | "analysisModel"> {
		const provider = isAnalysisProviderId(this.plugin.settings.analysisProvider)
			? this.plugin.settings.analysisProvider
			: "aliyun-bailian";
		return ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS["aliyun-bailian"];
	}

	private getBaseUrlDescription(): string {
		switch (this.plugin.settings.provider) {
			case "volcengine-agentplan":
				return "AgentPlan ASR 单流高准确率 WebSocket 端点；仅支持 Obsidian 桌面端。";
			case "aliyun-bailian":
				return "阿里百炼 OpenAI 兼容模式基础地址。国内默认 https://dashscope.aliyuncs.com/compatible-mode/v1。";
			case "openai":
				return "OpenAI API 基础地址，默认 https://api.openai.com/v1。";
			case "groq":
				return "Groq OpenAI 兼容 API 基础地址，默认 https://api.groq.com/openai/v1。";
			case "ollama":
				return "Ollama OpenAI 兼容基础地址，默认 http://localhost:11434/v1。需确认本地服务支持音频转写接口。";
			case "ollama-open-webui":
				return "Open WebUI 基础地址，默认 http://localhost:3000/api。插件会调用 {Base URL}/audio/transcriptions。";
			case "lm-studio":
				return "LM Studio OpenAI 兼容基础地址，默认 http://localhost:1234/v1。需确认本地服务支持音频转写接口。";
			case "custom-openai-compatible":
				return "自定义 OpenAI 兼容转写接口基础地址，插件会调用 {Base URL}/audio/transcriptions。";
			case "siliconflow":
				return "硅基流动（SiliconFlow）API 基础地址。";
			default:
				return "该服务商的基础地址。新增服务商默认按 OpenAI-compatible 音频转写接口调用 {Base URL}/audio/transcriptions。";
		}
	}

	private getTranscriptionLanguageDescription(): string {
		const capability = getTranscriptionProviderCapability(this.plugin.settings.provider);
		if (!capability.supportsLanguage) {
			return "默认 ASR 转写语言。当前 Provider 不支持语言参数，此设置不会传给 Provider，仍由模型自动识别。";
		}

		return "默认 ASR 转写语言。支持语言参数的 Provider 会随请求发送该值；auto 表示由 Provider 自动识别。";
	}

	private renderProviderSignup(containerEl: HTMLElement): void {
		if (this.plugin.settings.provider === "volcengine-agentplan") {
			const desc = document.createDocumentFragment();
			desc.appendText("请在火山方舟 AgentPlan 控制台创建专属 API Key：");
			const link = document.createElement("a");
			link.href =
				"https://console.volcengine.com/ark/region:ark+cn-beijing/openManagement?LLM=%7B%7D&OpenModelVisible=false&advancedActiveKey=agentPlan";
			link.textContent = "获取 AgentPlan 专属 API Key";
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			desc.appendChild(link);
			new Setting(containerEl).setName("AgentPlan 专属 API Key").setDesc(desc);
			return;
		}

		if (this.plugin.settings.provider !== "siliconflow") {
			return;
		}

		const desc = document.createDocumentFragment();
		desc.appendText("硅基流动免费注册链接：");
		const link = document.createElement("a");
		link.href = "https://cloud.siliconflow.cn/i/uTf2euFF";
		link.textContent = "https://cloud.siliconflow.cn/i/uTf2euFF";
		link.target = "_blank";
		link.rel = "noopener noreferrer";
		desc.appendChild(link);

		new Setting(containerEl)
			.setName("硅基流动注册链接")
			.setDesc(desc);
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
			.setName("自定义提示词")
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

		contentEl.createEl("p", {
			text: `${this.providerLabel}：${this.canAttemptTranscription ? "未发现阻塞性问题。" : "存在需要先处理的问题。"}`
		});

		const listEl = contentEl.createDiv({ cls: "echo-notes-provider-diagnostics-list" });
		for (const item of this.items) {
			const itemEl = listEl.createDiv({
				cls: `echo-notes-provider-diagnostics-item is-${item.severity}`
			});
			const headerEl = itemEl.createDiv({ cls: "echo-notes-provider-diagnostics-header" });
			headerEl.createSpan({
				cls: "echo-notes-provider-diagnostics-badge",
				text: getDiagnosticSeverityLabel(item.severity)
			});
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

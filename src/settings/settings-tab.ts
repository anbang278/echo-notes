import { App, Modal, Notice, PluginSettingTab, Setting } from "obsidian";
import type EchoNotesPlugin from "../main";
import {
	ANALYSIS_PROVIDER_DEFAULTS,
	ANALYSIS_PROVIDER_LABELS,
	COPY_LANGUAGE_LABELS,
	DEFAULT_ANALYSIS_SYSTEM_PROMPT,
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
	createCustomAnalysisTemplate,
	formatHotkey,
	parseHotkeyInput,
	parseRecognitionKeywordsInput,
	restoreDefaultAnalysisTemplate,
	type AnalysisProviderId,
	type AnalysisTemplateConfig,
	type CopyLanguage,
	type EchoNotesHotkeySetting,
	type InsertStyle,
	type OutputStrategy,
	type ProviderId
} from "./settings";

export class EchoNotesSettingTab extends PluginSettingTab {
	private plugin: EchoNotesPlugin;

	constructor(app: App, plugin: EchoNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Provider").setHeading();

		new Setting(containerEl)
			.setName("Provider")
			.setDesc("选择用于音频转写的服务商。切换后会自动填入该 Provider 的默认 Base URL 和模型。")
			.addDropdown((dropdown) =>
				Object.entries(PROVIDER_LABELS)
					.reduce((control, [value, label]) => control.addOption(value, label), dropdown)
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value;
						this.applyProviderDefaults(value as ProviderId);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("API Key")
			.setDesc("用于调用当前服务商的 API Key，会保存到 Obsidian SecretStorage。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.getApiKey())
					.onChange(async (value) => {
						await this.plugin.saveApiKey(value.trim());
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
			.setName("Language")
			.setDesc("转写语言。保持 auto 表示由 Provider 自动识别。")
			.addText((text) =>
				text
					.setPlaceholder("auto")
					.setValue(this.plugin.settings.language)
					.onChange(async (value) => {
						this.plugin.settings.language = value.trim() || "auto";
						await this.plugin.saveSettings();
					})
			);

		this.renderOfficialRecorderSettings(containerEl);
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
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("自定义输出目录")
			.setDesc("仅在“自定义目录（custom-folder）”策略下使用。")
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
			.setDesc("监听笔记变更，发现新增音频链接后自动转写并补充链接。")
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
			.setDesc("监听 Vault 新增音频文件，自动生成 transcript，不回写来源笔记。")
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

		new Setting(containerEl).setName("官方录音机").setHeading();

		new Setting(containerEl)
			.setName("启用 Obsidian 官方录音机")
			.setDesc(`控制 Obsidian Core plugin：Audio recorder。当前状态：${status}。`)
			.addToggle((toggle) =>
				toggle
					.setValue(recorderEnabled === true)
					.onChange(async (value) => {
						await this.plugin.setOfficialAudioRecorderEnabled(value);
						this.display();
					})
			);

		this.renderHotkeySetting(
			containerEl,
			"录音机开启快捷键",
			"触发 Echo Notes: Start official audio recorder，再调用官方 audio-recorder:start 命令。",
			"Ctrl+L",
			this.plugin.settings.officialRecorderStartHotkey,
			async (hotkey) => {
				this.plugin.settings.officialRecorderStartHotkey = hotkey;
			}
		);

		this.renderHotkeySetting(
			containerEl,
			"录音机关闭快捷键",
			"触发 Echo Notes: Stop official audio recorder，再调用官方 audio-recorder:stop 命令。",
			"Ctrl+S",
			this.plugin.settings.officialRecorderStopHotkey,
			async (hotkey) => {
				this.plugin.settings.officialRecorderStopHotkey = hotkey;
			}
		);

		this.renderHotkeySetting(
			containerEl,
			"转写当前笔记全部音频快捷键",
			"触发 Echo Notes: Transcribe all audio files in current note。清空输入可不设置默认快捷键。",
			"Ctrl+Z",
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
		applyHotkey: (hotkey: EchoNotesHotkeySetting) => Promise<void>
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

						await applyHotkey(hotkey);
						await this.plugin.saveSettings();
						this.plugin.refreshRegisteredCommands();
						this.display();
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
						this.display();
					})
			);

		if (!this.plugin.settings.analysisEnabled) {
			return;
		}

		new Setting(containerEl)
			.setName("分析 Provider")
			.setDesc("用于对转写稿生成纪要的服务商。列表与转写 Provider 保持一致，默认使用 DeepSeek。")
			.addDropdown((dropdown) =>
				Object.entries(ANALYSIS_PROVIDER_LABELS)
					.reduce((control, [value, label]) => control.addOption(value, label), dropdown)
					.setValue(this.plugin.settings.analysisProvider)
					.onChange(async (value) => {
						this.plugin.settings.analysisProvider = value as AnalysisProviderId;
						this.applyAnalysisProviderDefaults(value as AnalysisProviderId);
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("分析 API Key")
			.setDesc("用于调用当前分析 Provider 的 API Key，会独立保存到 Obsidian SecretStorage。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.getAnalysisApiKey())
					.onChange(async (value) => {
						await this.plugin.saveAnalysisApiKey(value.trim());
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
						this.display();
					})
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
						this.display();
						new AnalysisTemplateEditModal(this.app, this.plugin, savedTemplate, () => this.display()).open();
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
			new AnalysisTemplateEditModal(this.app, this.plugin, template, () => this.display()).open();
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
		this.display();
	}

	private async deleteCustomAnalysisTemplate(templateId: string): Promise<void> {
		this.plugin.settings.analysisTemplates = this.plugin.settings.analysisTemplates.filter(
			(candidate) => candidate.id !== templateId
		);
		await this.plugin.saveSettings();
		this.display();
	}

	private applyProviderDefaults(provider: ProviderId): void {
		const defaults = PROVIDER_DEFAULTS[provider];
		this.plugin.settings.baseUrl = defaults.baseUrl;
		this.plugin.settings.model = defaults.model;
		this.plugin.settings.language = defaults.language;
	}

	private applyAnalysisProviderDefaults(provider: AnalysisProviderId): void {
		const defaults = ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS.deepseek;
		this.plugin.settings.analysisBaseUrl = defaults.analysisBaseUrl;
		this.plugin.settings.analysisModel = defaults.analysisModel;
	}

	private getProviderDefaults(): Pick<EchoNotesPlugin["settings"], "baseUrl" | "model" | "language"> {
		const provider = this.plugin.settings.provider as ProviderId;
		return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.siliconflow;
	}

	private getAnalysisProviderDefaults(): Pick<EchoNotesPlugin["settings"], "analysisBaseUrl" | "analysisModel"> {
		const provider = this.plugin.settings.analysisProvider as AnalysisProviderId;
		return ANALYSIS_PROVIDER_DEFAULTS[provider] ?? ANALYSIS_PROVIDER_DEFAULTS.deepseek;
	}

	private getBaseUrlDescription(): string {
		switch (this.plugin.settings.provider) {
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

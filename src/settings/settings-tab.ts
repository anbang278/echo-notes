import { App, PluginSettingTab, Setting } from "obsidian";
import type EchoNotesPlugin from "../main";
import {
	ANALYSIS_PROVIDER_DEFAULTS,
	ANALYSIS_PROVIDER_LABELS,
	COPY_LANGUAGE_LABELS,
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
	createCustomAnalysisTemplate,
	restoreDefaultAnalysisTemplate,
	type AnalysisProviderId,
	type AnalysisTemplateConfig,
	type CopyLanguage,
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

	private renderAnalysisSettings(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("AI 纪要分析").setHeading();

		new Setting(containerEl)
			.setName("启用 AI 纪要分析")
			.setDesc("开启后显示分析模型配置、模板提示词设置，并允许对转写稿生成 AI 纪要。")
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
			.setDesc("用于对转写稿生成工作纪要、学习纪要、产品需求挖掘纪要或自定义纪要。")
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
			.setDesc("OpenAI-compatible Chat Completions 基础地址，插件会调用 {Base URL}/chat/completions。")
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
			.setName("转写时选择分析模板")
			.setDesc("开启后，手动发起转写时会先选择分析模板；也可以选择仅转写。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.promptForAnalysisTemplateOnTranscription)
					.onChange(async (value) => {
						this.plugin.settings.promptForAnalysisTemplateOnTranscription = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl).setName("分析模板提示词").setHeading();

		for (const template of this.plugin.settings.analysisTemplates) {
			this.renderAnalysisTemplateSetting(containerEl, template);
		}

		new Setting(containerEl)
			.setName("新增自定义模板")
			.setDesc("创建后会出现在模板选择窗口，并注册对应的命令，方便绑定快捷键。")
			.addButton((button) =>
				button
					.setButtonText("新增模板")
					.onClick(async () => {
						this.plugin.settings.analysisTemplates.push(
							createCustomAnalysisTemplate("自定义模板", this.plugin.settings.analysisTemplates)
						);
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}

	private renderAnalysisTemplateSetting(containerEl: HTMLElement, template: AnalysisTemplateConfig): void {
		const label = template.builtin ? `${template.name}（预设）` : template.name;
		new Setting(containerEl)
			.setName(label)
			.setDesc(template.description || template.id)
			.addToggle((toggle) =>
				toggle
					.setTooltip("是否在模板选择窗口中显示此模板")
					.setValue(template.enabled)
					.onChange(async (value) => {
						template.enabled = value;
						await this.plugin.saveSettings();
					})
			)
			.addButton((button) => {
				if (!template.builtin) {
					button
						.setButtonText("删除")
						.onClick(async () => {
							this.plugin.settings.analysisTemplates = this.plugin.settings.analysisTemplates.filter(
								(candidate) => candidate.id !== template.id
							);
							await this.plugin.saveSettings();
							this.display();
						});
					return;
				}

				button
					.setButtonText("恢复默认")
					.onClick(async () => {
						const restored = restoreDefaultAnalysisTemplate(template.id);
						if (!restored) {
							return;
						}
						const index = this.plugin.settings.analysisTemplates.findIndex((candidate) => candidate.id === template.id);
						if (index !== -1) {
							this.plugin.settings.analysisTemplates.splice(index, 1, restored);
						}
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("模板名称")
			.setDesc("命令面板和生成文件中的显示名称。")
			.addText((text) =>
				text
					.setValue(template.name)
					.onChange(async (value) => {
						template.name = value.trim() || template.id;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("模板说明")
			.setDesc("用于帮助区分模板用途。")
			.addText((text) =>
				text
					.setValue(template.description)
					.onChange(async (value) => {
						template.description = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("模板提示词")
			.setDesc("只填写分析要求和输出结构；系统会自动补充语言、安全和转写稿上下文。")
			.addTextArea((text) => {
				text.inputEl.rows = 8;
				text.inputEl.cols = 60;
				text
					.setValue(template.prompt)
					.onChange(async (value) => {
						template.prompt = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private applyProviderDefaults(provider: ProviderId): void {
		const defaults = PROVIDER_DEFAULTS[provider];
		this.plugin.settings.baseUrl = defaults.baseUrl;
		this.plugin.settings.model = defaults.model;
		this.plugin.settings.language = defaults.language;
	}

	private applyAnalysisProviderDefaults(provider: AnalysisProviderId): void {
		const defaults = ANALYSIS_PROVIDER_DEFAULTS[provider];
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

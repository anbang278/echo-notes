import { App, PluginSettingTab, Setting } from "obsidian";
import type EchoNotesPlugin from "../main";
import {
	PROVIDER_DEFAULTS,
	PROVIDER_LABELS,
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
				dropdown
					.addOption("siliconflow", PROVIDER_LABELS.siliconflow)
					.addOption("aliyun-bailian", PROVIDER_LABELS["aliyun-bailian"])
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
			.setDesc("用于调用当前 Provider 的 API Key。SiliconFlow 使用 SiliconFlow API Key，阿里百炼使用 DashScope API Key。")
			.addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("sk-...")
					.setValue(this.plugin.settings.apiKey)
					.onChange(async (value) => {
						this.plugin.settings.apiKey = value.trim();
						await this.plugin.saveSettings();
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

	private applyProviderDefaults(provider: ProviderId): void {
		const defaults = PROVIDER_DEFAULTS[provider];
		this.plugin.settings.baseUrl = defaults.baseUrl;
		this.plugin.settings.model = defaults.model;
		this.plugin.settings.language = defaults.language;
	}

	private getProviderDefaults(): Pick<EchoNotesPlugin["settings"], "baseUrl" | "model" | "language"> {
		const provider = this.plugin.settings.provider as ProviderId;
		return PROVIDER_DEFAULTS[provider] ?? PROVIDER_DEFAULTS.siliconflow;
	}

	private getBaseUrlDescription(): string {
		if (this.plugin.settings.provider === "aliyun-bailian") {
			return "阿里百炼 OpenAI 兼容模式基础地址。国内默认 https://dashscope.aliyuncs.com/compatible-mode/v1。";
		}

		return "SiliconFlow API 基础地址。";
	}
}

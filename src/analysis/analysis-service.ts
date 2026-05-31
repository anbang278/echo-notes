import { App, normalizePath, TFile } from "obsidian";
import { FileService, getParentPath } from "../obsidian/file-service";
import { getLocalizedCopy, type AnalysisTemplateConfig, type AnalysisTemplateId, type CopyLanguage } from "../settings/settings";
import {
	extractTranscriptText,
	getAnalysisPathForTranscriptPath,
	insertAnalysisLinkBlock,
	renderAnalysisMarkdown
} from "./analysis-output";
import type { AnalysisResult } from "./analysis-provider";

export class AnalysisService {
	private app: App;
	private fileService: FileService;

	constructor(app: App) {
		this.app = app;
		this.fileService = new FileService(app);
	}

	getAnalysisPath(transcriptFile: TFile, templateId: AnalysisTemplateId): string {
		return normalizePath(getAnalysisPathForTranscriptPath(transcriptFile.path, templateId));
	}

	async readTranscriptText(transcriptFile: TFile): Promise<string> {
		const content = await this.app.vault.cachedRead(transcriptFile);
		return extractTranscriptText(content);
	}

	async writeAnalysis(
		transcriptFile: TFile,
		template: AnalysisTemplateConfig,
		result: AnalysisResult,
		copyLanguage: CopyLanguage
	): Promise<TFile> {
		const analysisPath = this.getAnalysisPath(transcriptFile, template.id);
		const sourceTranscriptLink = this.app.fileManager.generateMarkdownLink(transcriptFile, analysisPath);
		const content = renderAnalysisMarkdown({
			sourceTranscriptLink,
			transcriptBaseName: transcriptFile.basename,
			templateId: template.id,
			templateName: template.name,
			result,
			copyLanguage
		});
		return this.writeAnalysisFile(analysisPath, content);
	}

	async insertAnalysisLink(transcriptFile: TFile, analysisFile: TFile, template: AnalysisTemplateConfig, copyLanguage: CopyLanguage): Promise<void> {
		const analysisLink = this.app.fileManager.generateMarkdownLink(
			analysisFile,
			transcriptFile.path,
			undefined,
			template.name
		);
		const copy = getLocalizedCopy(copyLanguage);

		await this.app.vault.process(transcriptFile, (content) => insertAnalysisLinkBlock(content, analysisLink, analysisFile.basename, copy.analysisLinksHeading));
	}

	private async writeAnalysisFile(path: string, content: string): Promise<TFile> {
		const parentPath = getParentPath(path);
		await this.fileService.ensureFolder(parentPath);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			return existing;
		}
		if (existing) {
			throw new Error(`无法写入 analysis，路径已被文件夹占用：${path}`);
		}

		return this.app.vault.create(path, content);
	}
}

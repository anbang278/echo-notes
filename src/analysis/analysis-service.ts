import { App, TFile } from "obsidian";
import { getLocalizedCopy, type AnalysisTemplateConfig, type CopyLanguage } from "../settings/settings";
import {
	extractTranscriptText,
	insertOrReplaceTranscriptAnalysis,
	renderTranscriptAnalysisBlock
} from "./analysis-output";
import type { AnalysisResult } from "./analysis-provider";

export class AnalysisService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async readTranscriptText(transcriptFile: TFile): Promise<string> {
		const content = await this.app.vault.cachedRead(transcriptFile);
		return extractTranscriptText(content);
	}

	async writeAnalysisToTranscript(
		transcriptFile: TFile,
		template: AnalysisTemplateConfig,
		result: AnalysisResult,
		copyLanguage: CopyLanguage
	): Promise<void> {
		const copy = getLocalizedCopy(copyLanguage);
		const analysisBlock = renderTranscriptAnalysisBlock({
			templateId: template.id,
			templateName: template.name,
			result,
			copyLanguage
		});

		await this.app.vault.process(transcriptFile, (content) =>
			insertOrReplaceTranscriptAnalysis(
				content,
				analysisBlock,
				template.id,
				copy.analysisLinksHeading,
				copy.transcriptHeading
			)
		);
	}
}

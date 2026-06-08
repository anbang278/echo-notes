import { App, TFile } from "obsidian";
import {
	DEFAULT_ANALYSIS_TEMPLATE_VERSION,
	getLocalizedCopy,
	type AnalysisTemplateConfig,
	type CopyLanguage
} from "../settings/settings";
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
		const transcriptTitle = getTranscriptTitle(transcriptFile);
		const analysisBlock = renderTranscriptAnalysisBlock({
			templateId: template.id,
			templateName: template.name,
			templateVersion: template.version ?? DEFAULT_ANALYSIS_TEMPLATE_VERSION,
			result,
			copyLanguage
		});

		await this.app.vault.process(transcriptFile, (content) =>
			insertOrReplaceTranscriptAnalysis(
				content,
				analysisBlock,
				template.id,
				formatSectionHeading(copy.analysisLinksHeading, transcriptTitle),
				[formatSectionHeading(copy.transcriptHeading, transcriptTitle), copy.transcriptHeading]
			)
		);
	}
}

function getTranscriptTitle(transcriptFile: TFile): string {
	return transcriptFile.basename.replace(/\.transcript$/, "");
}

function formatSectionHeading(label: string, title: string): string {
	return `${label} ${title}`.trim();
}

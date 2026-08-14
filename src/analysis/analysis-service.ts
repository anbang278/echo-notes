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
	renderTranscriptAnalysisWithTechnicalInfo
} from "./analysis-output";
import type { AnalysisResult } from "./analysis-provider";
import type { AnalysisTextChunk } from "./analysis-chunking";
import {
	readResumableAnalysisResults,
	removeAnalysisCheckpoint,
	upsertAnalysisCheckpoint,
	type AnalysisCheckpoint,
	type AnalysisCheckpointIdentity
} from "./analysis-checkpoint";

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
		const { analysisBlock, technicalBlock } = renderTranscriptAnalysisWithTechnicalInfo({
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
				[formatSectionHeading(copy.transcriptHeading, transcriptTitle), copy.transcriptHeading],
				technicalBlock,
				copyLanguage
			)
		);
	}

	async readResumableChunkResults(
		transcriptFile: TFile,
		identity: AnalysisCheckpointIdentity,
		chunks: readonly AnalysisTextChunk[]
	): Promise<AnalysisResult[]> {
		const content = await this.app.vault.cachedRead(transcriptFile);
		return readResumableAnalysisResults(content, identity, chunks);
	}

	async writeAnalysisCheckpoint(transcriptFile: TFile, checkpoint: AnalysisCheckpoint): Promise<void> {
		await this.app.vault.process(transcriptFile, (content) => upsertAnalysisCheckpoint(content, checkpoint));
	}

	async clearAnalysisCheckpoint(transcriptFile: TFile, templateId: string): Promise<void> {
		await this.app.vault.process(transcriptFile, (content) => removeAnalysisCheckpoint(content, templateId));
	}
}

function getTranscriptTitle(transcriptFile: TFile): string {
	return transcriptFile.basename.replace(/\.transcript$/, "");
}

function formatSectionHeading(label: string, title: string): string {
	return `${label} ${title}`.trim();
}

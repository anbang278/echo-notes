import { App, TFile } from "obsidian";
import type { TranscriptionResult, TranscriptionSegment } from "../providers/transcription-provider";
import type { EchoNotesSettings } from "../settings/settings";
import { FileService, getParentPath } from "../obsidian/file-service";
import {
	renderFailedTranscriptTemplate,
	renderProgressTranscriptTemplate,
	renderTranscriptTemplate
} from "./transcript-template";
import {
	getLegacyCustomFolderTranscriptPathForAudioPath,
	getTranscriptPathForAudioPath
} from "./transcript-path";
import {
	createSourceAudioMetadata,
	isReusableTranscriptForAudio
} from "./transcript-source-metadata";

export class TranscriptService {
	private app: App;
	private settings: EchoNotesSettings;
	private fileService: FileService;

	constructor(app: App, settings: EchoNotesSettings) {
		this.app = app;
		this.settings = settings;
		this.fileService = new FileService(app);
	}

	getTranscriptPath(audioFile: TFile): string {
		return getTranscriptPathForAudioPath(audioFile.path, this.settings);
	}

	getTranscriptFile(audioFile: TFile): TFile | null {
		const path = this.getTranscriptPath(audioFile);
		const file = this.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) {
			return file;
		}

		const legacyPath = this.getLegacyCustomFolderTranscriptPath(audioFile);
		if (!legacyPath || legacyPath === path) {
			return null;
		}

		const legacyFile = this.app.vault.getAbstractFileByPath(legacyPath);
		return legacyFile instanceof TFile ? legacyFile : null;
	}

	async getReusableTranscriptFile(audioFile: TFile): Promise<TFile | null> {
		const transcriptFile = this.getTranscriptFile(audioFile);
		if (!transcriptFile) {
			return null;
		}

		const content = await this.app.vault.cachedRead(transcriptFile);
		return isReusableTranscriptForAudio(content, {
			sourceAudio: createSourceAudioMetadata(audioFile),
			provider: this.settings.provider,
			model: this.settings.model
		})
			? transcriptFile
			: null;
	}

	async writeSuccessTranscript(audioFile: TFile, sourceNote: TFile | undefined, result: TranscriptionResult): Promise<TFile> {
		const transcriptPath = this.getTranscriptPath(audioFile);
		const content = renderTranscriptTemplate({
			app: this.app,
			audioFile,
			transcriptPath,
			sourceNote,
			result,
			copyLanguage: this.settings.copyLanguage
		});
		return this.writeTranscript(transcriptPath, content);
	}

	async writeTranscribingTranscript(
		audioFile: TFile,
		sourceNote: TFile | undefined,
		provider: string,
		model: string,
		segments: TranscriptionSegment[]
	): Promise<TFile> {
		const transcriptPath = this.getTranscriptPath(audioFile);
		const content = renderProgressTranscriptTemplate({
			app: this.app,
			audioFile,
			transcriptPath,
			sourceNote,
			provider,
			model,
			segments,
			copyLanguage: this.settings.copyLanguage
		});
		return this.writeTranscript(transcriptPath, content);
	}

	async writeFailedTranscript(
		audioFile: TFile,
		sourceNote: TFile | undefined,
		provider: string,
		model: string,
		error: string,
		traceId?: string,
		segments?: TranscriptionSegment[]
	): Promise<TFile> {
		const transcriptPath = this.getTranscriptPath(audioFile);
		const content = renderFailedTranscriptTemplate({
			app: this.app,
			audioFile,
			transcriptPath,
			sourceNote,
			provider,
			model,
			error,
			traceId,
			segments,
			copyLanguage: this.settings.copyLanguage
		});
		return this.writeTranscript(transcriptPath, content);
	}

	private async writeTranscript(path: string, content: string): Promise<TFile> {
		const parentPath = getParentPath(path);
		await this.fileService.ensureFolder(parentPath);

		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await this.app.vault.process(existing, () => content);
			return existing;
		}
		if (existing) {
			throw new Error(`无法写入 transcript，路径已被文件夹占用：${path}`);
		}

		return this.app.vault.create(path, content);
	}

	private getLegacyCustomFolderTranscriptPath(audioFile: TFile): string | null {
		return getLegacyCustomFolderTranscriptPathForAudioPath(audioFile.path, this.settings);
	}
}

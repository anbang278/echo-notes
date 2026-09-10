import type { App, MarkdownView, TFile } from "obsidian";
import type { AudioFileService } from "../audio/audio-file-service";
import { parseAudioLinks, type AudioLinkMatch } from "../audio/audio-link-parser";
import type { LinkService } from "./link-service";

export interface SourceAudioAnchor {
	sourceNote: TFile;
	audioFile: TFile;
	audioLinkPath: string;
	initialReferenceCount: number;
}

export type TranscriptLinkResultStatus = "inserted" | "already-present" | "skipped" | "failed";

export interface TranscriptLinkResult {
	status: TranscriptLinkResultStatus;
	sourcePath: string;
	reason?: "source-missing" | "multiple-source-editors" | "initially-ambiguous" | "audio-missing" | "ambiguous-audio" | "multiple-audio-on-line" | "write-failed" | "plugin-unloaded";
}

interface TranscriptLinkServiceOptions {
	withMutatingFile: (file: TFile, operation: () => Promise<void>) => Promise<void>;
	isDisposed: () => boolean;
}

export class TranscriptLinkService {
	private queues = new Map<TFile, Promise<TranscriptLinkResult>>();

	constructor(
		private app: App,
		private audioFileService: AudioFileService,
		private linkService: LinkService,
		private options: TranscriptLinkServiceOptions
	) {}

	captureAnchor(sourceNote: TFile, audioFile: TFile, audioLinkPath: string, content: string): SourceAudioAnchor {
		return {
			sourceNote,
			audioFile,
			audioLinkPath,
			initialReferenceCount: this.findAudioMatches(content, sourceNote, audioFile).length
		};
	}

	async insertTranscriptLink(anchor: SourceAudioAnchor, transcriptFile: TFile): Promise<TranscriptLinkResult> {
		const key = anchor.sourceNote;
		const previous = this.queues.get(key) ?? Promise.resolve({ status: "already-present", sourcePath: key.path } as TranscriptLinkResult);
		const operation = previous.catch(() => undefined).then(() => this.insertTranscriptLinkNow(anchor, transcriptFile));
		this.queues.set(key, operation);
		try {
			return await operation;
		} finally {
			if (this.queues.get(key) === operation) {
				this.queues.delete(key);
			}
		}
	}

	private async insertTranscriptLinkNow(anchor: SourceAudioAnchor, transcriptFile: TFile): Promise<TranscriptLinkResult> {
		const result = (status: TranscriptLinkResultStatus, reason?: TranscriptLinkResult["reason"]): TranscriptLinkResult => ({
			status,
			sourcePath: anchor.sourceNote.path,
			reason
		});
		if (this.options.isDisposed()) return result("skipped", "plugin-unloaded");
		if (this.app.vault.getAbstractFileByPath(anchor.sourceNote.path) !== anchor.sourceNote) return result("skipped", "source-missing");
		if (anchor.initialReferenceCount !== 1) return result("skipped", "initially-ambiguous");

		const editors = this.getSourceEditors(anchor.sourceNote);
		if (editors.length > 1 && new Set(editors.map((editor) => editor.getValue())).size > 1) {
			return result("skipped", "multiple-source-editors");
		}
		if (editors.length > 0) {
			return this.insertIntoEditor(editors[0], anchor, transcriptFile, result);
		}

		let writeResult = result("skipped", "audio-missing");
		try {
			await this.options.withMutatingFile(anchor.sourceNote, async () => {
				await this.app.vault.process(anchor.sourceNote, (content) => {
					const located = this.locate(content, anchor);
					if (located.result) {
						writeResult = located.result;
						return content;
					}
					if (this.linkService.hasTranscriptLinkNear(content, located.match!, transcriptFile, anchor.sourceNote.path)) {
						writeResult = result("already-present");
						return content;
					}
					writeResult = result("inserted");
					return this.linkService.insertTranscriptLinkAfterMatch(content, located.match!, transcriptFile, anchor.sourceNote.path);
				});
			});
			return writeResult;
		} catch {
			return result("failed", "write-failed");
		}
	}

	private insertIntoEditor(
		editor: MarkdownView["editor"],
		anchor: SourceAudioAnchor,
		transcriptFile: TFile,
		result: (status: TranscriptLinkResultStatus, reason?: TranscriptLinkResult["reason"]) => TranscriptLinkResult
	): TranscriptLinkResult {
		const content = editor.getValue();
		const located = this.locate(content, anchor);
		if (located.result) return located.result;
		if (this.linkService.hasTranscriptLinkNear(content, located.match!, transcriptFile, anchor.sourceNote.path)) {
			return result("already-present");
		}
		const line = editor.getLine(located.match!.lineEnd);
		try {
			editor.replaceRange(`\n${this.linkService.createTranscriptLink(transcriptFile, anchor.sourceNote.path)}`, {
				line: located.match!.lineEnd,
				ch: line.length
			});
			return result("inserted");
		} catch {
			return result("failed", "write-failed");
		}
	}

	private locate(content: string, anchor: SourceAudioAnchor): { match?: AudioLinkMatch; result?: TranscriptLinkResult } {
		const result = (reason: NonNullable<TranscriptLinkResult["reason"]>): TranscriptLinkResult => ({ status: "skipped", sourcePath: anchor.sourceNote.path, reason });
		const matches = this.findAudioMatches(content, anchor.sourceNote, anchor.audioFile);
		if (matches.length === 0) return { result: result("audio-missing") };
		if (matches.length > 1) return { result: result("ambiguous-audio") };
		const match = matches[0];
		if (parseAudioLinks(content.split("\n")[match.lineStart]).length !== 1) return { result: result("multiple-audio-on-line") };
		return { match };
	}

	private findAudioMatches(content: string, sourceNote: TFile, audioFile: TFile): AudioLinkMatch[] {
		return parseAudioLinks(content).filter((match) => this.audioFileService.resolveAudioFile(match.linkPath, sourceNote)?.path === audioFile.path);
	}

	private getSourceEditors(sourceNote: TFile): MarkdownView["editor"][] {
		return this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => leaf.view)
			.filter((view): view is MarkdownView => {
				const markdownView = view as MarkdownView;
				return markdownView.getViewType() === "markdown" && markdownView.file === sourceNote;
			})
			.map((view) => view.editor);
	}
}

import type { App, MarkdownView, TFile } from "obsidian";
import type { AudioFileService } from "../audio/audio-file-service";
import { isSupportedAudioFile } from "../audio/audio-detector";
import { parseAudioLinks, type AudioLinkMatch } from "../audio/audio-link-parser";
import type { LinkService } from "./link-service";
import { updateRecordingSummaryContent, type RecordingSummaryContentResult } from "./recording-summary-content";
import { readRecordingSummaryWriteback, writeRecordingSummaryWriteback } from "../transcript/recording-summary-writeback";
import { readTranscriptSourceReferences } from "../transcript/transcript-source-metadata";

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

export interface RecordingSummaryWriteResult {
	status: "inserted" | "updated" | "already-present" | "skipped" | "failed";
	sourcePath: string;
	reason?: string;
}

interface TranscriptLinkServiceOptions {
	withMutatingFile: (file: TFile, operation: () => Promise<void>) => Promise<void>;
	isDisposed: () => boolean;
}

export class TranscriptLinkService {
	private queues = new Map<TFile, Promise<unknown>>();

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

	async captureTranscriptSourceAnchor(transcriptFile: TFile): Promise<SourceAudioAnchor | undefined> {
		const references = readTranscriptSourceReferences(await this.app.vault.read(transcriptFile));
		if (!references.sourceNoteLinkPath) return undefined;
		const sourceNote = this.app.metadataCache.getFirstLinkpathDest(references.sourceNoteLinkPath, transcriptFile.path);
		if (!sourceNote || sourceNote.extension !== "md") return undefined;
		const linkedAudio = references.sourceAudioLinkPath
			? this.audioFileService.resolveAudioFile(references.sourceAudioLinkPath, transcriptFile)
			: null;
		const storedAudio = references.sourceAudioPath
			? this.app.vault.getFileByPath(references.sourceAudioPath)
			: null;
		// A newly created namesake can change a short link's destination.
		if (storedAudio && linkedAudio && storedAudio !== linkedAudio) return undefined;
		const audioFile = storedAudio ?? linkedAudio;
		if (!audioFile || !isSupportedAudioFile(audioFile)) return undefined;
		const editors = this.getSourceEditors(sourceNote);
		const content = editors.length > 0 ? editors[0].getValue() : await this.app.vault.read(sourceNote);
		return this.captureAnchor(sourceNote, audioFile, references.sourceAudioLinkPath ?? audioFile.path, content);
	}

	insertTranscriptLink(anchor: SourceAudioAnchor, transcriptFile: TFile): Promise<TranscriptLinkResult> {
		return this.enqueue(anchor.sourceNote, () => this.insertTranscriptLinkNow(anchor, transcriptFile));
	}

	insertRecordingSummary(
		anchor: SourceAudioAnchor,
		summary: string,
		isCurrent: () => boolean = () => true,
		transcriptFile?: TFile
	): Promise<RecordingSummaryWriteResult> {
		return this.enqueue(anchor.sourceNote, () => this.insertRecordingSummaryNow(anchor, summary, isCurrent, transcriptFile));
	}

	private async enqueue<T>(key: TFile, write: () => Promise<T>): Promise<T> {
		const previous = this.queues.get(key) ?? Promise.resolve();
		const operation = previous.catch(() => undefined).then(write);
		this.queues.set(key, operation);
		try {
			return await operation;
		} finally {
			if (this.queues.get(key) === operation) this.queues.delete(key);
		}
	}

	private async insertRecordingSummaryNow(
		anchor: SourceAudioAnchor,
		summary: string,
		isCurrent: () => boolean,
		transcriptFile?: TFile
	): Promise<RecordingSummaryWriteResult> {
		const result = (status: RecordingSummaryWriteResult["status"], reason?: string): RecordingSummaryWriteResult => ({
			status, sourcePath: anchor.sourceNote.path, reason
		});
		const guard = (checkCurrent = true): string | undefined => {
			if (this.options.isDisposed()) return "plugin-unloaded";
			if (checkCurrent && !isCurrent()) return "stale-analysis";
			if (!transcriptFile || transcriptFile === anchor.sourceNote
				|| this.app.vault.getAbstractFileByPath(transcriptFile.path) !== transcriptFile) return "transcript-missing";
			if (this.app.vault.getAbstractFileByPath(anchor.sourceNote.path) !== anchor.sourceNote) return "source-missing";
			if (this.app.vault.getAbstractFileByPath(anchor.audioFile.path) !== anchor.audioFile) return "audio-missing";
			if (anchor.initialReferenceCount !== 1) return "initially-ambiguous";
			return undefined;
		};
		const initialReason = guard();
		if (initialReason) return result("skipped", initialReason);
		let writeResult = result("skipped", "audio-missing");
		let pendingSummaries: string[] | undefined;
		try {
			const knownSummaries = readRecordingSummaryWriteback(await this.app.vault.read(transcriptFile!));
			if (knownSummaries === null) return result("skipped", "invalid-writeback-state");
			await this.options.withMutatingFile(anchor.sourceNote, async () => {
				const prepare = (content: string, known: readonly string[]): RecordingSummaryContentResult => {
					const reason = guard();
					if (reason) return { status: "skipped", reason, content };
					const located = this.locate(content, anchor);
					if (located.result) return { status: "skipped", reason: located.result.reason, content };
					return updateRecordingSummaryContent(content, located.match!, summary, known);
				};
				const sourceEditors = this.getSourceEditors(anchor.sourceNote);
				if (new Set(sourceEditors.map((editor) => editor.getValue())).size > 1) {
					writeResult = result("skipped", "multiple-source-editors");
					return;
				}
				const initialContent = sourceEditors.length > 0 ? sourceEditors[0].getValue() : await this.app.vault.read(anchor.sourceNote);
				const initialUpdate = prepare(initialContent, knownSummaries);
				writeResult = result(initialUpdate.status, initialUpdate.reason);
				if (initialUpdate.status === "skipped") return;
				const previousSummaries = initialUpdate.previousSummary ? [initialUpdate.previousSummary] : [];
				const nextSummaries = Array.from(new Set([summary.trim(), ...previousSummaries]));
				pendingSummaries = nextSummaries;
				let snapshotSaved = false;
				try {
					await this.options.withMutatingFile(transcriptFile!, async () => {
						await this.app.vault.process(transcriptFile!, (content) => {
							const reason = guard();
							if (reason) {
								writeResult = result("skipped", reason);
								return content;
							}
							const updated = writeRecordingSummaryWriteback(content, nextSummaries);
							if (updated === null) {
								writeResult = result("skipped", "invalid-writeback-state");
								return content;
							}
							snapshotSaved = true;
							return updated;
						});
					});
				} catch {
					writeResult = result("failed", "writeback-state-failed");
					return;
				}
				if (!snapshotSaved) return;

				// Keep this write bound to the initially identified old summary, including its exact end.
				const editors = this.getSourceEditors(anchor.sourceNote);
				if (new Set(editors.map((editor) => editor.getValue())).size > 1) {
					writeResult = result("skipped", "multiple-source-editors");
					return;
				}
				if (editors.length > 0) {
					const updated = prepare(editors[0].getValue(), previousSummaries);
					writeResult = result(updated.status, updated.reason);
					if (updated.edit) {
						const { line, from, to, text } = updated.edit;
						editors[0].replaceRange(text, { line, ch: from }, { line, ch: to });
					}
					return;
				}
				await this.app.vault.process(anchor.sourceNote, (content) => {
					if (this.getSourceEditors(anchor.sourceNote).length > 0) {
						writeResult = result("skipped", "source-editor-opened");
						return content;
					}
					const updated = prepare(content, previousSummaries);
					writeResult = result(updated.status, updated.reason);
					return updated.content;
				});
			});
			if (pendingSummaries && pendingSummaries.length > 1
				&& (writeResult.status === "inserted" || writeResult.status === "updated" || writeResult.status === "already-present")) {
				try {
					let converged = false;
					await this.options.withMutatingFile(transcriptFile!, async () => {
						await this.app.vault.process(transcriptFile!, (content) => {
							// Account for the completed source write even if a newer analysis has started.
							if (guard(false) || JSON.stringify(readRecordingSummaryWriteback(content)) !== JSON.stringify(pendingSummaries)) return content;
							const updated = writeRecordingSummaryWriteback(content, [summary.trim()]);
							if (updated === null) return content;
							converged = true;
							return updated;
						});
					});
					if (!converged) writeResult.reason = "writeback-state-pending";
				} catch {
					// The source write already succeeded. Retain both recovery candidates on failure.
					writeResult.reason = "writeback-state-pending";
				}
			}

			return writeResult;
		} catch {
			return result("failed", "write-failed");
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

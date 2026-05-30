import type { App, TFile } from "obsidian";
import type { AudioLinkMatch } from "../audio/audio-link-parser";
import type { EchoNotesSettings } from "../settings/settings";

export class LinkService {
	private app: App;
	private settings: EchoNotesSettings;

	constructor(app: App, settings: EchoNotesSettings) {
		this.app = app;
		this.settings = settings;
	}

	createTranscriptLink(transcriptFile: TFile, sourcePath: string): string {
		const link = this.app.fileManager.generateMarkdownLink(transcriptFile, sourcePath, undefined, "查看转写稿");
		if (this.settings.insertStyle === "callout") {
			return ["> [!note] Audio Transcript", `> ${link}`].join("\n");
		}

		return link;
	}

	hasTranscriptLinkNear(content: string, audioMatch: AudioLinkMatch, transcriptLink: string): boolean {
		if (content.includes(transcriptLink)) {
			return true;
		}

		const lines = content.split("\n");
		const startLine = audioMatch.lineEnd + 1;
		const endLine = Math.min(lines.length - 1, audioMatch.lineEnd + 3);
		for (let line = startLine; line <= endLine; line += 1) {
			if (lines[line]?.includes(transcriptLink)) {
				return true;
			}
		}

		return false;
	}

	insertTranscriptLinkAfterMatch(content: string, audioMatch: AudioLinkMatch, transcriptLink: string): string {
		if (this.hasTranscriptLinkNear(content, audioMatch, transcriptLink)) {
			return content;
		}

		const lines = content.split("\n");
		const insertLine = Math.min(audioMatch.lineEnd + 1, lines.length);
		lines.splice(insertLine, 0, transcriptLink);
		return lines.join("\n");
	}
}

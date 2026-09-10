import type { App, TFile } from "obsidian";
import { parseAudioLinks, type AudioLinkMatch } from "../audio/audio-link-parser";
import { getLocalizedCopy, type EchoNotesSettings } from "../settings/settings";

export class LinkService {
	private app: App;
	private settings: EchoNotesSettings;

	constructor(app: App, settings: EchoNotesSettings) {
		this.app = app;
		this.settings = settings;
	}

	createTranscriptLink(transcriptFile: TFile, sourcePath: string): string {
		const copy = getLocalizedCopy(this.settings.copyLanguage);
		const link = this.app.fileManager.generateMarkdownLink(transcriptFile, sourcePath, undefined, copy.transcriptLinkAlias);
		if (this.settings.insertStyle === "callout") {
			return [`> [!note] ${copy.calloutTitle}`, `> ${link}`].join("\n");
		}

		return link;
	}

	hasTranscriptLinkNear(content: string, audioMatch: AudioLinkMatch, transcriptFile: TFile, sourcePath: string): boolean {
		const lines = content.split("\n");
		for (let line = audioMatch.lineEnd + 1; line < lines.length; line += 1) {
			const value = lines[line].trim();
			if (!value) {
				continue;
			}
			if (/^#{1,6}\s/.test(value) || parseAudioLinks(lines[line]).length > 0) {
				return false;
			}
			if (this.lineLinksToTranscript(lines[line], transcriptFile, sourcePath)) {
				return true;
			}
			if (!value.startsWith(">")) {
				return false;
			}
		}

		return false;
	}

	insertTranscriptLinkAfterMatch(content: string, audioMatch: AudioLinkMatch, transcriptFile: TFile, sourcePath: string): string {
		if (this.hasTranscriptLinkNear(content, audioMatch, transcriptFile, sourcePath)) {
			return content;
		}

		const lines = content.split("\n");
		const transcriptLink = this.createTranscriptLink(transcriptFile, sourcePath);
		lines.splice(audioMatch.lineEnd + 1, 0, transcriptLink);
		return lines.join("\n");
	}

	private lineLinksToTranscript(line: string, transcriptFile: TFile, sourcePath: string): boolean {
		const candidates = [
			...line.matchAll(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g),
			...line.matchAll(/!?\[[^\]]*]\(([^)#]+)(?:#[^)]*)?\)/g)
		];
		return candidates.some((match) => this.app.metadataCache.getFirstLinkpathDest(match[1].trim(), sourcePath)?.path === transcriptFile.path);
	}
}

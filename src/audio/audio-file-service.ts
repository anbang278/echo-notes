import { App, normalizePath, TFile } from "obsidian";
import { isSupportedAudioFile } from "./audio-detector";
import { normalizeAudioLinkPath } from "./audio-link-parser";

export class AudioFileService {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	resolveAudioFile(linkPath: string, sourceNote?: TFile): TFile | null {
		const normalizedLinkPath = normalizeAudioLinkPath(linkPath);
		const resolved = this.app.metadataCache.getFirstLinkpathDest(normalizedLinkPath, sourceNote?.path ?? "");

		if (resolved instanceof TFile && isSupportedAudioFile(resolved)) {
			return resolved;
		}

		for (const candidate of this.buildPathCandidates(normalizedLinkPath, sourceNote)) {
			const file = this.app.vault.getAbstractFileByPath(candidate);
			if (file instanceof TFile && isSupportedAudioFile(file)) {
				return file;
			}
		}

		const fallback = this.app.vault
			.getFiles()
			.find((file) => file.name === normalizedLinkPath || file.path === normalizedLinkPath);
		return fallback instanceof TFile && isSupportedAudioFile(fallback) ? fallback : null;
	}

	private buildPathCandidates(linkPath: string, sourceNote?: TFile): string[] {
		const candidates = new Set<string>();
		candidates.add(normalizeVaultPath(linkPath));

		if (sourceNote) {
			const sourceFolder = sourceNote.parent?.path ?? "";
			if (sourceFolder) {
				candidates.add(normalizeVaultPath(`${sourceFolder}/${linkPath}`));
			}
		}

		return Array.from(candidates);
	}
}

export function normalizeVaultPath(path: string): string {
	return normalizePath(path.trim().replace(/^\/+/, "").replace(/^\.\//, ""));
}

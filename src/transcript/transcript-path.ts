import type { OutputStrategy } from "../settings/settings";

export interface TranscriptPathOptions {
	outputStrategy: OutputStrategy;
	customOutputFolder: string;
}

export function getTranscriptPathForAudioPath(audioPath: string, options: TranscriptPathOptions): string {
	const audioFolder = getParentPathFromPath(audioPath);
	const audioBaseName = getBaseNameFromPath(audioPath);
	const transcriptFileName = createTranscriptFileName(audioPath);

	switch (options.outputStrategy) {
		case "same-folder":
			return normalizeVaultPath(joinPath(audioFolder, transcriptFileName));
		case "custom-folder":
			return normalizeVaultPath(
				joinPath(options.customOutputFolder || "Transcripts", createTranscriptFileName(audioPath, true))
			);
		case "same-name-subfolder":
		default:
			return normalizeVaultPath(joinPath(audioFolder, audioBaseName, transcriptFileName));
	}
}

export function getLegacyCustomFolderTranscriptPathForAudioPath(
	audioPath: string,
	options: TranscriptPathOptions
): string | null {
	if (options.outputStrategy !== "custom-folder") {
		return null;
	}

	return normalizeVaultPath(joinPath(options.customOutputFolder || "Transcripts", createTranscriptFileName(audioPath)));
}

export function createTranscriptFileName(audioPath: string, includeSourcePathHash = false): string {
	const audioBaseName = getBaseNameFromPath(audioPath);
	if (!includeSourcePathHash) {
		return `${audioBaseName}.transcript.md`;
	}

	return `${audioBaseName}-${createShortPathHash(normalizeVaultPath(audioPath))}.transcript.md`;
}

function getParentPathFromPath(path: string): string {
	const normalized = normalizeVaultPath(path);
	const lastSlashIndex = normalized.lastIndexOf("/");
	return lastSlashIndex === -1 ? "" : normalized.slice(0, lastSlashIndex);
}

function getBaseNameFromPath(path: string): string {
	const normalized = normalizeVaultPath(path);
	const name = normalized.split("/").pop() ?? normalized;
	const lastDotIndex = name.lastIndexOf(".");
	return lastDotIndex === -1 ? name : name.slice(0, lastDotIndex);
}

function joinPath(...parts: string[]): string {
	return parts.filter(Boolean).join("/");
}

function normalizeVaultPath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function createShortPathHash(path: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < path.length; index += 1) {
		hash ^= path.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36).padStart(7, "0").slice(-7);
}

import type { TFile } from "obsidian";

export const SUPPORTED_AUDIO_EXTENSIONS = new Set(["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm"]);

const AUDIO_MIME_TYPES: Record<string, string> = {
	mp3: "audio/mpeg",
	mp4: "audio/mp4",
	mpeg: "audio/mpeg",
	mpga: "audio/mpeg",
	m4a: "audio/mp4",
	wav: "audio/wav",
	webm: "audio/webm"
};

export function isSupportedAudioExtension(extension: string): boolean {
	return SUPPORTED_AUDIO_EXTENSIONS.has(extension.toLowerCase());
}

export function isSupportedAudioFile(file: TFile): boolean {
	return isSupportedAudioExtension(file.extension);
}

export function getAudioMimeType(file: TFile): string {
	return AUDIO_MIME_TYPES[file.extension.toLowerCase()] ?? "application/octet-stream";
}

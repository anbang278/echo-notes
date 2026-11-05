import type { TFile } from "obsidian";
import { normalizeAudioLinkPath } from "../audio/audio-link-parser";

export interface SourceAudioMetadata {
	path: string;
	size: number;
	mtime: number;
}

export interface TranscriptReuseCriteria {
	sourceAudio: SourceAudioMetadata;
	provider: string;
	model: string;
	configurationFingerprint?: string;
}

export function readTranscriptSourceReferences(content: string): {
	sourceNoteLinkPath?: string;
	sourceAudioLinkPath?: string;
	sourceAudioPath?: string;
} {
	const fields = parseFrontmatter(content);
	const linkPath = (value: string | undefined): string | undefined => {
		if (!value) return undefined;
		const wiki = /^!?\[\[([^\]]+)\]\]$/.exec(value);
		const markdown = /^!?\[[^\]]*\]\((.+)\)$/.exec(value);
		const target = wiki ? wiki[1].split("|")[0] : markdown?.[1];
		return target ? normalizeAudioLinkPath(target) : undefined;
	};
	return {
		sourceNoteLinkPath: linkPath(fields?.source_note),
		sourceAudioLinkPath: linkPath(fields?.source_audio),
		sourceAudioPath: fields?.source_audio_path || undefined
	};
}

export function createSourceAudioMetadata(audioFile: TFile): SourceAudioMetadata {
	return {
		path: audioFile.path,
		size: audioFile.stat.size,
		mtime: audioFile.stat.mtime
	};
}

export function renderSourceAudioMetadata(metadata: SourceAudioMetadata): string[] {
	return [
		`source_audio_path: "${escapeYaml(metadata.path)}"`,
		`source_audio_size: ${metadata.size}`,
		`source_audio_mtime: ${metadata.mtime}`
	];
}

export function isReusableTranscriptForAudio(content: string, criteria: TranscriptReuseCriteria): boolean {
	const frontmatter = parseFrontmatter(content);
	if (!frontmatter) {
		return false;
	}

	return (
		frontmatter.status === "done" &&
		frontmatter.provider === criteria.provider &&
		frontmatter.model === criteria.model &&
		frontmatter.source_audio_path === criteria.sourceAudio.path &&
		Number(frontmatter.source_audio_size) === criteria.sourceAudio.size &&
		Number(frontmatter.source_audio_mtime) === criteria.sourceAudio.mtime &&
		(criteria.configurationFingerprint === undefined ||
			frontmatter.transcription_configuration_fingerprint === criteria.configurationFingerprint)
	);
}

function parseFrontmatter(content: string): Record<string, string> | null {
	const normalizedContent = content.replace(/\r\n/g, "\n");
	if (!normalizedContent.startsWith("---\n")) {
		return null;
	}

	const endIndex = normalizedContent.indexOf("\n---", 4);
	if (endIndex === -1) {
		return null;
	}

	const frontmatter: Record<string, string> = {};
	const lines = normalizedContent.slice(4, endIndex).split("\n");
	for (const line of lines) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		const value = line.slice(separatorIndex + 1).trim();
		frontmatter[key] = unquoteYamlScalar(value);
	}

	return frontmatter;
}

function unquoteYamlScalar(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}

	return value;
}

function escapeYaml(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

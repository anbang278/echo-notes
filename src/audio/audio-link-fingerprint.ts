import type { AudioLinkMatch } from "./audio-link-parser";

export function createAudioLinkFingerprint(sourcePath: string, match: AudioLinkMatch): string {
	return createAudioLinkFingerprintWithOccurrence(sourcePath, match, match.lineStart);
}

export function createAudioLinkFingerprints(sourcePath: string, matches: AudioLinkMatch[]): string[] {
	const occurrenceCounts = new Map<string, number>();

	return matches.map((match) => {
		const key = createOccurrenceKey(match);
		const occurrence = occurrenceCounts.get(key) ?? 0;
		occurrenceCounts.set(key, occurrence + 1);
		return createAudioLinkFingerprintWithOccurrence(sourcePath, match, occurrence);
	});
}

function createAudioLinkFingerprintWithOccurrence(sourcePath: string, match: AudioLinkMatch, occurrence: number): string {
	return [
		normalizeFingerprintPart(sourcePath),
		normalizeFingerprintPart(match.linkPath),
		createShortTextHash(match.rawText),
		String(occurrence)
	].join("|");
}

function createOccurrenceKey(match: AudioLinkMatch): string {
	return [normalizeFingerprintPart(match.linkPath), createShortTextHash(match.rawText)].join("|");
}

function normalizeFingerprintPart(value: string): string {
	return value.trim().replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();
}

function createShortTextHash(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index += 1) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}

	return (hash >>> 0).toString(36).padStart(7, "0").slice(-7);
}

export interface GettingStartedAudioCandidate<T> {
	path: string;
	createdAt: number;
	value: T;
}

export function getAvailableGettingStartedNotePath(
	pathExists: (path: string) => boolean
): string {
	let index = 1;
	while (true) {
		const path = index === 1 ? "Echo Notes 首次体验.md" : `Echo Notes 首次体验 ${index}.md`;
		if (!pathExists(path)) {
			return path;
		}
		index += 1;
	}
}

export function selectNewGettingStartedAudio<T>(
	candidates: readonly GettingStartedAudioCandidate<T>[],
	startedAt: number,
	knownPaths: ReadonlySet<string>,
	excludedPath?: string
): T | undefined {
	let selected: T | undefined;
	for (const candidate of candidates) {
		if (
			candidate.createdAt < startedAt ||
			knownPaths.has(candidate.path) ||
			candidate.path === excludedPath
		) {
			continue;
		}
		selected = candidate.value;
	}
	return selected;
}

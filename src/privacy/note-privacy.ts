const PRIVACY_FRONTMATTER_KEYS = [
	"echo_notes_private",
	"echo_notes_disable_automation",
	"echo_notes_disable_auto_transcribe"
];

const PRIVATE_NOTE_TAGS = [
	"echo-notes-private",
	"echo-notes-no-auto",
	"echo-notes-disable-automation",
	"echo-notes-disable-auto-transcribe"
];

export function shouldSkipAutomationForPrivateNote(markdown: string): boolean {
	return hasPrivateFrontmatterFlag(markdown) || hasPrivateNoteTag(markdown);
}

function hasPrivateFrontmatterFlag(markdown: string): boolean {
	const lines = getFrontmatterLines(markdown);
	if (!lines) {
		return false;
	}

	for (const line of lines) {
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim();
		if (!PRIVACY_FRONTMATTER_KEYS.includes(key)) {
			continue;
		}

		return isTruthyYamlScalar(line.slice(separatorIndex + 1).trim());
	}

	return false;
}

function hasPrivateNoteTag(markdown: string): boolean {
	const tags = getSourceNoteTags(markdown).map(normalizeTagValue);
	const privateTags = new Set(PRIVATE_NOTE_TAGS);
	return tags.some((tag) => privateTags.has(tag));
}

function getSourceNoteTags(markdown: string): string[] {
	return [...getFrontmatterTags(markdown), ...getInlineTags(markdown)];
}

function getFrontmatterTags(markdown: string): string[] {
	const lines = getFrontmatterLines(markdown);
	if (!lines) {
		return [];
	}

	const tags: string[] = [];
	for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
		const line = lines[lineIndex];
		const separatorIndex = line.indexOf(":");
		if (separatorIndex === -1 || line.slice(0, separatorIndex).trim() !== "tags") {
			continue;
		}

		const inlineValue = line.slice(separatorIndex + 1).trim();
		if (inlineValue) {
			tags.push(...parseTagValue(inlineValue));
			continue;
		}

		for (let childIndex = lineIndex + 1; childIndex < lines.length; childIndex += 1) {
			const childLine = lines[childIndex];
			const listMatch = childLine.match(/^\s*-\s+(.+)$/);
			if (!listMatch) {
				break;
			}

			tags.push(...parseTagValue(listMatch[1].trim()));
		}
	}

	return tags;
}

function getInlineTags(markdown: string): string[] {
	const content = removeFrontmatter(markdown);
	const tags: string[] = [];
	const tagRegex = /(?:^|[\s([{"'])#([^\s#\])}",.;:!?]+)/g;
	let match: RegExpExecArray | null;

	while ((match = tagRegex.exec(content)) !== null) {
		tags.push(match[1]);
	}

	return tags;
}

function parseTagValue(value: string): string[] {
	const trimmed = value.trim();
	if (!trimmed) {
		return [];
	}

	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((tag) => unquoteYamlScalar(tag.trim()))
			.filter(Boolean);
	}

	return trimmed.split(/\s+/).map(unquoteYamlScalar).filter(Boolean);
}

function normalizeTagValue(value: string): string {
	return value.trim().replace(/^#+/, "").toLowerCase();
}

function getFrontmatterLines(markdown: string): string[] | null {
	if (!markdown.startsWith("---\n")) {
		return null;
	}

	const endIndex = markdown.indexOf("\n---", 4);
	if (endIndex === -1) {
		return null;
	}

	return markdown.slice(4, endIndex).split(/\r?\n/);
}

function removeFrontmatter(markdown: string): string {
	if (!markdown.startsWith("---\n")) {
		return markdown;
	}

	const endIndex = markdown.indexOf("\n---", 4);
	return endIndex === -1 ? markdown : markdown.slice(endIndex + "\n---".length);
}

function isTruthyYamlScalar(value: string): boolean {
	const normalized = unquoteYamlScalar(value).trim().toLowerCase();
	return normalized === "true" || normalized === "yes" || normalized === "1" || normalized === "on";
}

function unquoteYamlScalar(value: string): string {
	if (value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}

	if (value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/''/g, "'");
	}

	return value;
}

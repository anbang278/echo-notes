export function getMissingRealtimeLinkLines(
	content: string,
	audioLink: string,
	transcriptLink: string
): string[] {
	return [
		...(content.includes(audioLink) ? [] : [`!${audioLink}`]),
		...(content.includes(transcriptLink) ? [] : [transcriptLink])
	];
}

export async function evidenceSha256(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createEvidenceId(sourceId: string, revision: string, start: number, end: number): Promise<string> {
	return `ev_${await evidenceSha256(JSON.stringify([1, sourceId, revision, start, end]))}`;
}

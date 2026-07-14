import type { AnalysisProviderId, ProviderId } from "../settings/settings";

const TRANSCRIPTION_SECRET_PREFIX = "echo-notes-transcription-api-key";
const ANALYSIS_SECRET_PREFIX = "echo-notes-analysis-api-key";

export function getTranscriptionApiKeySecretId(provider: ProviderId): string {
	return `${TRANSCRIPTION_SECRET_PREFIX}:${provider}`;
}

export function getAnalysisApiKeySecretId(provider: AnalysisProviderId): string {
	return `${ANALYSIS_SECRET_PREFIX}:${provider}`;
}

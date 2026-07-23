import type { AnalysisProviderId, TranscriptionProviderId } from "../settings/settings";

const TRANSCRIPTION_SECRET_PREFIX = "echo-notes-transcription-api-key";
const ANALYSIS_SECRET_PREFIX = "echo-notes-analysis-api-key";

export interface SecretStorageLike {
	getSecret(id: string): string | null;
	setSecret(id: string, secret: string): void;
}

export function getTranscriptionApiKeySecretId(provider: TranscriptionProviderId): string {
	return `${TRANSCRIPTION_SECRET_PREFIX}-${provider}`;
}

export function getAnalysisApiKeySecretId(provider: AnalysisProviderId): string {
	return `${ANALYSIS_SECRET_PREFIX}-${provider}`;
}

export function migrateLegacySecret(
	secretStorage: SecretStorageLike,
	legacySecretId: string,
	targetSecretId: string,
	settingsLegacySecret?: string
): void {
	const storedLegacySecret = secretStorage.getSecret(legacySecretId)?.trim() ?? "";
	const legacySecret = settingsLegacySecret?.trim() || storedLegacySecret;

	if (legacySecret && !secretStorage.getSecret(targetSecretId)) {
		secretStorage.setSecret(targetSecretId, legacySecret);
	}
	if (storedLegacySecret) {
		secretStorage.setSecret(legacySecretId, "");
	}
}

import assert from "node:assert/strict";
import {
	DEFAULT_SETTINGS,
	LOCAL_OPENAI_BASE_URL,
	LOCAL_OPENAI_DIARIZATION_MODEL,
	LOCAL_OPENAI_TRANSCRIPTION_MODEL,
	OFFLINE_TRANSCRIPTION_PROVIDER_LABELS,
	getOfflineTranscriptionProviderDefaults,
	normalizeEchoNotesSettings,
	switchOfflineTranscriptionProvider,
	validateLocalOpenAIBaseUrl,
	type TranscriptionConfig
} from "../src/settings/settings";
import { getProviderCapabilitySummary, getTranscriptionProviderCapability } from "../src/providers/provider-capabilities";
import { diagnoseTranscriptionProviderSettings } from "../src/providers/provider-diagnostics";
import { getTranscriptionApiKeySecretId, migrateLegacySecret } from "../src/security/provider-secrets";

export function runLocalOpenAISettingsTests(): void {
	const localConfig: TranscriptionConfig = {
		provider: "local-openai-compatible",
		...getOfflineTranscriptionProviderDefaults("local-openai-compatible")
	};
	assert.deepEqual(localConfig, {
		provider: "local-openai-compatible", baseUrl: LOCAL_OPENAI_BASE_URL,
		model: LOCAL_OPENAI_TRANSCRIPTION_MODEL, language: "auto",
		localEnhancement: { hotwordEnhancementEnabled: false, contextEnhancementEnabled: false }
	});
	assert.equal(OFFLINE_TRANSCRIPTION_PROVIDER_LABELS["local-openai-compatible"], "本地模型（OpenAI 兼容）");

	const lmConfig = { provider: "lm-studio", baseUrl: "http://localhost:1234/custom", model: "old/custom-model", language: "yue" };
	for (const raw of [{ offlineTranscription: lmConfig }, lmConfig]) {
		let settings = normalizeEchoNotesSettings(raw);
		assert.deepEqual(settings.offlineTranscription, lmConfig);
		assert.deepEqual(settings.offlineTranscriptionByProvider["lm-studio"], lmConfig);
		assert.equal(settings.offlineTranscriptionByProvider["local-openai-compatible"], undefined);
		switchOfflineTranscriptionProvider(settings, "local-openai-compatible");
		assert.deepEqual(settings.offlineTranscription, localConfig);
		settings.offlineTranscription.baseUrl = "http://[::1]:23456/v1";
		settings.offlineTranscription.model = "custom/local-model";
		settings.offlineTranscription.language = "fr";
		settings = normalizeEchoNotesSettings(settings); // Mirrors the settings write/reload pipeline.
		switchOfflineTranscriptionProvider(settings, "lm-studio");
		assert.deepEqual(settings.offlineTranscription, lmConfig, "Switching back must not reset prior settings");
		switchOfflineTranscriptionProvider(settings, "local-openai-compatible");
		assert.deepEqual(settings.offlineTranscription, {
			provider: "local-openai-compatible", baseUrl: "http://[::1]:23456/v1", model: "custom/local-model", language: "fr",
			localEnhancement: { hotwordEnhancementEnabled: false, contextEnhancementEnabled: false }
		});
		assert.notEqual(settings.offlineTranscriptionByProvider["local-openai-compatible"], settings.offlineTranscription,
			"Stored profiles must not alias live settings");
		settings.offlineTranscription.model = "newer/live-model";
		settings = normalizeEchoNotesSettings(settings);
		assert.equal(settings.offlineTranscriptionByProvider["local-openai-compatible"]?.model, "newer/live-model",
			"Current settings must take precedence over stale profile data");
	}

	const malformed = normalizeEchoNotesSettings({
		offlineTranscription: lmConfig,
		offlineTranscriptionByProvider: {
			"lm-studio": { ...lmConfig, model: "stale", apiKey: "must-not-copy" },
			"local-openai-compatible": { ...localConfig, model: "kept", apiKey: "must-not-copy", raw: { text: "private" } },
			mosi: { provider: "lm-studio", baseUrl: "http://localhost:9/v1" },
			ollama: "invalid",
			"unknown-provider": { ...localConfig }
		}
	});
	assert.deepEqual(malformed.offlineTranscription, lmConfig);
	assert.deepEqual(Object.keys(malformed.offlineTranscriptionByProvider).sort(), ["lm-studio", "local-openai-compatible"]);
	assert.equal(malformed.offlineTranscriptionByProvider["local-openai-compatible"]?.model, "kept");
	assert.doesNotMatch(JSON.stringify(malformed.offlineTranscriptionByProvider), /must-not-copy|private|apiKey|raw/);
	assert.deepEqual(normalizeEchoNotesSettings({ offlineTranscriptionByProvider: [] }).offlineTranscription,
		DEFAULT_SETTINGS.offlineTranscription);
	assert.deepEqual(DEFAULT_SETTINGS.offlineTranscriptionByProvider, {}, "Normalization must not mutate defaults");

	const aliyun = normalizeEchoNotesSettings({
		offlineTranscription: {
			provider: "aliyun-bailian", baseUrl: "https://dashscope.aliyuncs.com", model: "qwen3-asr-flash", language: "en",
			aliyunFiletrans: { diarizationEnabled: false, speakerCount: 3, hotwordEnhancementEnabled: true }
		},
		mosiSpeakerDiarizationEnabled: false
	});
	const beforeSwitch = structuredClone(aliyun.offlineTranscription);
	switchOfflineTranscriptionProvider(aliyun, "local-openai-compatible");
	assert.equal(aliyun.offlineTranscription.aliyunFiletrans, undefined);
	switchOfflineTranscriptionProvider(aliyun, "aliyun-bailian");
	assert.deepEqual(aliyun.offlineTranscription, beforeSwitch);
	aliyun.offlineTranscription.aliyunFiletrans!.speakerCount = 4;
	assert.equal(aliyun.offlineTranscriptionByProvider["aliyun-bailian"]?.aliyunFiletrans?.speakerCount, 3);
	switchOfflineTranscriptionProvider(aliyun, "mosi");
	assert.equal(aliyun.offlineTranscription.model, "moss-transcribe", "MOSI's existing toggle semantics must remain unchanged");

	for (const address of [
		LOCAL_OPENAI_BASE_URL, "http://localhost:9000/v1/", "https://localhost/custom", "http://[::1]:18080/v1",
		"https://127.0.0.1:50000", " http://localhost:1234/v1 "
	]) {
		assert.equal(validateLocalOpenAIBaseUrl(address), undefined, address);
		assert.equal(diagnoseTranscriptionProviderSettings({ ...localConfig, baseUrl: address }, "", {
			isMobile: false, isFileSystemVault: true
		}).canAttemptTranscription, true, address);
	}
	for (const address of [
		"", "http://127.1/v1", "http://2130706433/v1", "http://0x7f000001/v1", "http://127.0.0.2/v1",
		"http://localhost.localdomain/v1", "http://host.local/v1", "http://192.168.1.10/v1", "https://remote.example/v1",
		"http://user:pass@localhost/v1", "http://localhost/v1?", "http://localhost/v1#", "http://localhost/v1?q=1",
		"http://localhost/v1#part", "http://localhost:65536/v1", "file://localhost/v1", "ftp://localhost/v1",
		"http://localhost\\@remote.example/v1", "http://local\nhost/v1", "http://localhost/v1\n/path"
	]) {
		assert.ok(validateLocalOpenAIBaseUrl(address), address);
		assert.equal(diagnoseTranscriptionProviderSettings({ ...localConfig, baseUrl: address }, "", {
			isMobile: false, isFileSystemVault: true
		}).canAttemptTranscription, false, address);
	}
	assert.equal(diagnoseTranscriptionProviderSettings(localConfig, "", { isMobile: true }).canAttemptTranscription, false);
	assert.equal(diagnoseTranscriptionProviderSettings(localConfig, "", { isFileSystemVault: false }).canAttemptTranscription, false);
	assert.equal(diagnoseTranscriptionProviderSettings(localConfig, "", { usage: "realtime" }).canAttemptTranscription, false);
	assert.equal(diagnoseTranscriptionProviderSettings({ ...localConfig, model: "" }, "").canAttemptTranscription, false);
	assert.equal(diagnoseTranscriptionProviderSettings({ ...localConfig, model: "custom/asr" }, "x").canAttemptTranscription, true);
	const optionalKeyDiagnostics = diagnoseTranscriptionProviderSettings(localConfig, "");
	assert.equal(optionalKeyDiagnostics.canAttemptTranscription, true);
	assert.ok(optionalKeyDiagnostics.items.some((item) => item.title === "本地 API Key 可留空"));
	assert.ok(optionalKeyDiagnostics.items.every((item) => item.title !== "长音频分段暂不支持"));
	for (const provider of ["lm-studio", "ollama", "siliconflow", "aliyun-bailian", "mosi"] as const) {
		assert.equal(diagnoseTranscriptionProviderSettings({ provider, ...getOfflineTranscriptionProviderDefaults(provider) }, "").canAttemptTranscription, false);
	}

	const capability = getTranscriptionProviderCapability("local-openai-compatible");
	assert.equal(capability.maxAudioBytes, null);
	assert.equal(capability.supportsStreamingUpload, true);
	assert.equal(capability.supportsStreaming, false);
	assert.equal(capability.supportsChunking, false, "Transport chunks are not independent inference segments");
	assert.equal(capability.supportsSpeakerDiarization, false);
	assert.equal(capability.supportsTimestamp, false);
	const diarization = getTranscriptionProviderCapability("local-openai-compatible", "offline", LOCAL_OPENAI_DIARIZATION_MODEL);
	assert.equal(diarization.supportsSpeakerDiarization, true);
	assert.equal(diarization.supportsTimestamp, true);
	assert.equal(getTranscriptionProviderCapability("local-openai-compatible", "offline", "custom/asr").supportsSpeakerDiarization, false);
	assert.equal(getTranscriptionProviderCapability("lm-studio").maxAudioBytes, 25 * 1024 * 1024);
	assert.equal(getTranscriptionProviderCapability("ollama").maxAudioBytes, 25 * 1024 * 1024);
	assert.ok(getProviderCapabilitySummary(capability).some((line) => line.includes("流式上传")));
	assert.ok(getProviderCapabilitySummary(capability).every((line) => !line.includes("暂不支持") || !line.includes("长音频")));

	const slots = Object.keys(OFFLINE_TRANSCRIPTION_PROVIDER_LABELS).map((provider) => getTranscriptionApiKeySecretId(provider as typeof localConfig.provider));
	assert.equal(new Set(slots).size, slots.length);
	assert.notEqual(getTranscriptionApiKeySecretId("local-openai-compatible"), getTranscriptionApiKeySecretId("lm-studio"));
	const secrets = new Map([["legacy", "legacy-selected-provider-key"]]);
	migrateLegacySecret({
		getSecret: (key) => secrets.get(key) ?? null,
		setSecret: (key, value) => { secrets.set(key, value); }
	}, "legacy", getTranscriptionApiKeySecretId("lm-studio"));
	assert.equal(secrets.get(getTranscriptionApiKeySecretId("lm-studio")), "legacy-selected-provider-key");
	assert.equal(secrets.get(getTranscriptionApiKeySecretId("local-openai-compatible")), undefined);
	assert.equal(secrets.get("legacy"), "");
}

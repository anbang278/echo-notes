import type { OfflineTranscriptionProviderId } from "../settings/settings";

const MB = 1024 * 1024;

export interface ProviderTranscriptionPolicy {
	provider: OfflineTranscriptionProviderId;
	model?: string;
	supportsChunking: boolean;
	maxSourceBytes?: number;
	maxSourceDurationSeconds?: number;
	targetSegmentSeconds?: number;
	minSegmentSeconds?: number;
	retryableHttpStatuses: readonly number[];
	retryDelaysMs: readonly number[];
	maxSplitDepth: number;
}

export interface TranscriptionPolicyInput {
	provider: OfflineTranscriptionProviderId;
	model: string;
}

export interface PreChunkDecisionInput {
	policy: ProviderTranscriptionPolicy;
	sourceBytes: number;
	durationSeconds?: number;
}

const RETRYABLE_SERVER_STATUSES = [500, 502, 503, 504] as const;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000] as const;

const SILICONFLOW_POLICY: Omit<ProviderTranscriptionPolicy, "model"> = {
	provider: "siliconflow",
	supportsChunking: true,
	maxSourceBytes: 50 * MB,
	maxSourceDurationSeconds: 60 * 60,
	targetSegmentSeconds: 10 * 60,
	minSegmentSeconds: 60,
	retryableHttpStatuses: RETRYABLE_SERVER_STATUSES,
	retryDelaysMs: DEFAULT_RETRY_DELAYS_MS,
	maxSplitDepth: 4
};

const EXACT_MODEL_POLICIES: ProviderTranscriptionPolicy[] = [
	{
		...SILICONFLOW_POLICY,
		model: "FunAudioLLM/SenseVoiceSmall"
	},
	{
		...SILICONFLOW_POLICY,
		model: "TeleAI/TeleSpeechASR"
	},
	{
		provider: "aliyun-bailian",
		model: "qwen3-asr-flash",
		supportsChunking: true,
		targetSegmentSeconds: 3 * 60,
		minSegmentSeconds: 30,
		retryableHttpStatuses: [],
		retryDelaysMs: [],
		maxSplitDepth: 0
	}
];

const PROVIDER_POLICIES: Partial<Record<OfflineTranscriptionProviderId, ProviderTranscriptionPolicy>> = {
	siliconflow: {
		...SILICONFLOW_POLICY
	},
	"aliyun-bailian": {
		provider: "aliyun-bailian",
		supportsChunking: true,
		targetSegmentSeconds: 3 * 60,
		minSegmentSeconds: 30,
		retryableHttpStatuses: [],
		retryDelaysMs: [],
		maxSplitDepth: 0
	}
};

export function resolveProviderTranscriptionPolicy(
	input: TranscriptionPolicyInput
): ProviderTranscriptionPolicy {
	const model = input.model.trim();
	const exactPolicy = EXACT_MODEL_POLICIES.find(
		(policy) => policy.provider === input.provider && policy.model === model
	);
	if (exactPolicy) {
		return clonePolicy(exactPolicy);
	}

	const providerPolicy = PROVIDER_POLICIES[input.provider];
	if (providerPolicy) {
		return {
			...clonePolicy(providerPolicy),
			model: model || undefined
		};
	}

	return {
		provider: input.provider,
		model: model || undefined,
		supportsChunking: false,
		retryableHttpStatuses: [],
		retryDelaysMs: [],
		maxSplitDepth: 0
	};
}

export function shouldPreChunkTranscription(input: PreChunkDecisionInput): boolean {
	if (!input.policy.supportsChunking) {
		return false;
	}

	if (
		input.policy.maxSourceBytes !== undefined &&
		input.sourceBytes > input.policy.maxSourceBytes
	) {
		return true;
	}

	return (
		input.policy.maxSourceDurationSeconds !== undefined &&
		input.durationSeconds !== undefined &&
		Number.isFinite(input.durationSeconds) &&
		input.durationSeconds > input.policy.maxSourceDurationSeconds
	);
}

export function isRetryablePolicyStatus(
	policy: ProviderTranscriptionPolicy,
	httpStatus: number | undefined
): boolean {
	return httpStatus !== undefined && policy.retryableHttpStatuses.includes(httpStatus);
}

export function shouldSplitPolicyError(
	policy: ProviderTranscriptionPolicy,
	httpStatus: number | undefined
): boolean {
	return policy.supportsChunking && (httpStatus === 413 || isRetryablePolicyStatus(policy, httpStatus));
}

function clonePolicy(policy: ProviderTranscriptionPolicy): ProviderTranscriptionPolicy {
	return {
		...policy,
		retryableHttpStatuses: [...policy.retryableHttpStatuses],
		retryDelaysMs: [...policy.retryDelaysMs]
	};
}

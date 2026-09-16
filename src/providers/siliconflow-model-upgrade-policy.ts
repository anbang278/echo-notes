import {
	SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID,
	SILICONFLOW_SENSEVOICE_MODEL_ID
} from "./siliconflow-model-catalog";

export interface SiliconFlowUpgradeInput {
	readonly usage: "offline" | "realtime";
	readonly provider: string;
	readonly model: string;
	readonly needsUpload: boolean;
	readonly uploadPolicyAllowsAttempt: boolean;
	readonly reminderDismissed: boolean;
	readonly isRemoteResume: boolean;
}

export type SiliconFlowUpgradeDecision =
	| { readonly kind: "switch"; readonly modelId: string }
	| { readonly kind: "dont-remind" }
	| { readonly kind: "close" };

export function shouldPromptSiliconFlowUpgrade(input: SiliconFlowUpgradeInput): boolean {
	return input.usage === "offline" &&
		input.provider === "siliconflow" &&
		input.model.trim() === SILICONFLOW_SENSEVOICE_MODEL_ID &&
		input.needsUpload &&
		input.uploadPolicyAllowsAttempt &&
		!input.reminderDismissed &&
		!input.isRemoteResume;
}

export function normalizeSiliconFlowUpgradeNoticeDismissed(value: unknown): boolean {
	return value === true;
}

export function isSiliconFlowSenseVoiceModel(model: string): boolean {
	return model.trim() === SILICONFLOW_DEFAULT_TRANSCRIPTION_MODEL_ID;
}

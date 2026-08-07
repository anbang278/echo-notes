export type GettingStartedStatus = "not-started" | "in-progress" | "dismissed" | "completed";
export type GettingStartedMilestone = "transcription" | "analysis";

export interface GettingStartedState {
	schemaVersion: 1;
	status: GettingStartedStatus;
	firstShownAt?: number;
	firstSuccessfulTranscriptionAt?: number;
	firstSuccessfulAnalysisAt?: number;
	completedAt?: number;
}

export interface GettingStartedProgress {
	transcriptionReady: boolean;
	analysisReady: boolean;
	firstProcessingCompleted: boolean;
	completedSteps: number;
}

export function createGettingStartedState(
	status: GettingStartedStatus = "not-started"
): GettingStartedState {
	return {
		schemaVersion: 1,
		status
	};
}

export function normalizeGettingStartedState(
	value: unknown,
	fallbackStatus: GettingStartedStatus = "not-started"
): GettingStartedState {
	if (!isRecord(value) || value.schemaVersion !== 1 || !isGettingStartedStatus(value.status)) {
		return createGettingStartedState(fallbackStatus);
	}

	const normalized: GettingStartedState = {
		schemaVersion: 1,
		status: value.status
	};
	copyTimestamp(value, normalized, "firstShownAt");
	copyTimestamp(value, normalized, "firstSuccessfulTranscriptionAt");
	copyTimestamp(value, normalized, "firstSuccessfulAnalysisAt");
	copyTimestamp(value, normalized, "completedAt");

	if (
		normalized.status === "completed" &&
		(!normalized.firstSuccessfulTranscriptionAt || !normalized.firstSuccessfulAnalysisAt)
	) {
		normalized.status = "in-progress";
		delete normalized.completedAt;
	}

	return normalized;
}

export function markGettingStartedShown(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.status === "completed") {
		return { ...state };
	}
	return {
		...state,
		status: "in-progress",
		firstShownAt: state.firstShownAt ?? now
	};
}

export function dismissGettingStarted(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.status === "completed") {
		return { ...state };
	}
	return {
		...state,
		status: "dismissed",
		firstShownAt: state.firstShownAt ?? now
	};
}

export function startGettingStarted(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.status === "completed") {
		return { ...state };
	}
	return {
		...state,
		status: "in-progress",
		firstShownAt: state.firstShownAt ?? now
	};
}

export function recordGettingStartedMilestone(
	state: GettingStartedState,
	milestone: GettingStartedMilestone,
	now = Date.now()
): GettingStartedState {
	if (state.status !== "in-progress") {
		return { ...state };
	}

	if (milestone === "transcription") {
		return {
			...state,
			firstSuccessfulTranscriptionAt: state.firstSuccessfulTranscriptionAt ?? now
		};
	}

	const nextState: GettingStartedState = {
		...state,
		firstSuccessfulAnalysisAt: state.firstSuccessfulAnalysisAt ?? now
	};
	if (!nextState.firstSuccessfulTranscriptionAt) {
		return nextState;
	}

	return {
		...nextState,
		status: "completed",
		completedAt: state.completedAt ?? now
	};
}

export function getGettingStartedProgress(
	state: GettingStartedState,
	transcriptionReady: boolean,
	analysisReady: boolean
): GettingStartedProgress {
	const firstProcessingCompleted = Boolean(
		state.status === "completed" &&
		state.firstSuccessfulTranscriptionAt &&
		state.firstSuccessfulAnalysisAt
	);
	return {
		transcriptionReady,
		analysisReady,
		firstProcessingCompleted,
		completedSteps:
			Number(transcriptionReady) +
			Number(analysisReady) +
			Number(firstProcessingCompleted)
	};
}

function copyTimestamp(
	source: Record<string, unknown>,
	target: GettingStartedState,
	key: keyof Omit<GettingStartedState, "schemaVersion" | "status">
): void {
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		target[key] = value;
	}
}

function isGettingStartedStatus(value: unknown): value is GettingStartedStatus {
	return value === "not-started" ||
		value === "in-progress" ||
		value === "dismissed" ||
		value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

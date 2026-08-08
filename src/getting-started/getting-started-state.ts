export type GettingStartedStatus = "not-started" | "in-progress" | "dismissed" | "completed";

export type GettingStartedStep =
	| "transcription"
	| "recorder"
	| "first-practice"
	| "analysis"
	| "hotkeys"
	| "shortcut-practice"
	| "memory"
	| "completed";

export type GettingStartedPracticeStage =
	| "idle"
	| "waiting-for-first-audio"
	| "first-audio-ready"
	| "first-transcribing"
	| "first-transcription-completed"
	| "waiting-for-shortcut-audio"
	| "shortcut-audio-ready"
	| "waiting-for-shortcut-transcription"
	| "shortcut-transcribing"
	| "analyzing"
	| "shortcut-completed"
	| "memory-running"
	| "failed"
	| "completed";

export type GettingStartedFailureKind = "transcription" | "analysis" | "memory";
export type GettingStartedChapterId = "first" | "shortcut" | "memory";
export type GettingStartedChapterOutcome = "pending" | "completed" | "skipped";

export interface GettingStartedChapterState {
	outcome: GettingStartedChapterOutcome;
	skippedAt?: number;
	lastReviewCompletedAt?: number;
	latestReviewExperienceNotePath?: string;
	latestReviewAudioPath?: string;
	latestReviewTranscriptPath?: string;
	latestReviewSourceTranscriptPath?: string;
	latestReviewCandidatePath?: string;
}

export interface GettingStartedChapterStates {
	first: GettingStartedChapterState;
	shortcut: GettingStartedChapterState;
	memory: GettingStartedChapterState;
}

export interface GettingStartedReviewAttempt {
	chapter: GettingStartedChapterId;
	practiceStage: GettingStartedPracticeStage;
	startedAt: number;
	experienceNotePath?: string;
	practiceStartedAt?: number;
	audioPath?: string;
	transcriptPath?: string;
	memorySourceTranscriptPath?: string;
	candidatePath?: string;
	lastFailureKind?: GettingStartedFailureKind;
	lastFailureTaskId?: string;
}

export interface GettingStartedState {
	schemaVersion: 3;
	status: GettingStartedStatus;
	step: GettingStartedStep;
	practiceStage: GettingStartedPracticeStage;
	chapters: GettingStartedChapterStates;
	activeReview?: GettingStartedReviewAttempt;
	firstShownAt?: number;
	experienceNotePath?: string;
	firstPracticeStartedAt?: number;
	firstAudioPath?: string;
	firstTranscriptPath?: string;
	firstSuccessfulTranscriptionAt?: number;
	firstChapterAcknowledgedAt?: number;
	shortcutPracticeStartedAt?: number;
	shortcutAudioPath?: string;
	shortcutTranscriptPath?: string;
	firstSuccessfulAnalysisAt?: number;
	shortcutChapterAcknowledgedAt?: number;
	memorySourceTranscriptPath?: string;
	firstSuccessfulMemoryAt?: number;
	memoryCandidatePath?: string;
	recorderManuallyConfirmedAt?: number;
	hotkeysManuallyConfirmedAt?: number;
	lastFailureKind?: GettingStartedFailureKind;
	lastFailureTaskId?: string;
	completedAt?: number;
}

export interface GettingStartedReadiness {
	transcriptionReady: boolean;
	analysisReady: boolean;
	recorderReady: boolean;
	hotkeysReady: boolean;
	memoryReady: boolean;
}

export interface GettingStartedProgress {
	chapterOutcomes: Record<GettingStartedChapterId, GettingStartedChapterOutcome>;
	firstTranscriptionCompleted: boolean;
	shortcutAnalysisCompleted: boolean;
	memoryCompleted: boolean;
	resolvedChapters: number;
	completedChapters: number;
	skippedChapters: number;
	totalChapters: 3;
}

const CHAPTER_IDS: GettingStartedChapterId[] = ["first", "shortcut", "memory"];
const BUSY_STAGES = new Set<GettingStartedPracticeStage>([
	"waiting-for-first-audio",
	"waiting-for-shortcut-audio",
	"first-transcribing",
	"shortcut-transcribing",
	"analyzing",
	"memory-running"
]);

export function createGettingStartedState(
	status: GettingStartedStatus = "not-started"
): GettingStartedState {
	const completed = status === "completed";
	return {
		schemaVersion: 3,
		status,
		step: completed ? "completed" : "transcription",
		practiceStage: completed ? "completed" : "idle",
		chapters: createChapterStates(completed ? "completed" : "pending")
	};
}

export function shouldStartGettingStartedOnOpen(
	status: GettingStartedStatus,
	isMobile: boolean
): boolean {
	return !isMobile && status !== "completed";
}

export function shouldAutoOpenGettingStarted(
	status: GettingStartedStatus,
	isMobile: boolean,
	hasActiveReview = false
): boolean {
	return !isMobile && (
		(hasActiveReview && status !== "dismissed") ||
		status === "not-started" ||
		status === "in-progress"
	);
}

export function normalizeGettingStartedState(
	value: unknown,
	fallbackStatus: GettingStartedStatus = "not-started"
): GettingStartedState {
	if (!isRecord(value) || !isGettingStartedStatus(value.status)) {
		return createGettingStartedState(fallbackStatus);
	}
	if (value.schemaVersion === 1) {
		return migrateLegacyGettingStartedState(value);
	}
	if (value.schemaVersion === 2) {
		return migrateV2GettingStartedState(value);
	}
	if (value.schemaVersion !== 3) {
		return createGettingStartedState(fallbackStatus);
	}

	const status = value.status;
	const normalized: GettingStartedState = {
		schemaVersion: 3,
		status,
		step: isGettingStartedStep(value.step)
			? value.step
			: status === "completed" ? "completed" : "transcription",
		practiceStage: isGettingStartedPracticeStage(value.practiceStage)
			? value.practiceStage
			: status === "completed" ? "completed" : "idle",
		chapters: normalizeChapterStates(value.chapters, status === "completed")
	};
	copyCommonState(value, normalized);
	if (isRecord(value.activeReview)) {
		const activeReview = normalizeReviewAttempt(value.activeReview);
		if (activeReview && normalized.chapters[activeReview.chapter].outcome !== "pending") {
			normalized.activeReview = activeReview;
		}
	}
	return normalizeJourneyCompletion(normalized);
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

export function confirmGettingStartedRecorder(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	return { ...state, recorderManuallyConfirmedAt: state.recorderManuallyConfirmedAt ?? now };
}

export function confirmGettingStartedHotkeys(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	return { ...state, hotkeysManuallyConfirmedAt: state.hotkeysManuallyConfirmedAt ?? now };
}

export function getGettingStartedChapterOutcome(
	state: GettingStartedState,
	chapter: GettingStartedChapterId
): GettingStartedChapterOutcome {
	return state.chapters[chapter].outcome;
}

export function getCurrentGettingStartedChapter(state: GettingStartedState): GettingStartedChapterId | null {
	if (state.activeReview) {
		return state.activeReview.chapter;
	}
	return CHAPTER_IDS.find((chapter) => state.chapters[chapter].outcome === "pending") ?? null;
}

export function getGettingStartedPracticeStage(state: GettingStartedState): GettingStartedPracticeStage {
	return state.activeReview?.practiceStage ?? state.practiceStage;
}

export function getGettingStartedExperienceNotePath(state: GettingStartedState): string | undefined {
	return state.activeReview?.experienceNotePath ?? state.experienceNotePath;
}

export function getGettingStartedActiveAudioPath(state: GettingStartedState): string | undefined {
	if (state.activeReview) {
		return state.activeReview.audioPath;
	}
	return state.step === "first-practice" ? state.firstAudioPath : state.shortcutAudioPath;
}

export function getGettingStartedActiveTranscriptPath(state: GettingStartedState): string | undefined {
	if (state.activeReview) {
		return state.activeReview.transcriptPath;
	}
	return state.step === "first-practice" ? state.firstTranscriptPath : state.shortcutTranscriptPath;
}

export function getGettingStartedMemorySourcePath(state: GettingStartedState): string | undefined {
	return state.activeReview?.memorySourceTranscriptPath ??
		state.memorySourceTranscriptPath ??
		state.chapters.shortcut.latestReviewTranscriptPath ??
		state.shortcutTranscriptPath;
}

export function getGettingStartedFailureKind(state: GettingStartedState): GettingStartedFailureKind | undefined {
	return state.activeReview?.lastFailureKind ?? state.lastFailureKind;
}

export function getGettingStartedFailureTaskId(state: GettingStartedState): string | undefined {
	return state.activeReview?.lastFailureTaskId ?? state.lastFailureTaskId;
}

export function isGettingStartedBusy(state: GettingStartedState): boolean {
	return BUSY_STAGES.has(getGettingStartedPracticeStage(state));
}

export function canSkipGettingStartedChapter(
	state: GettingStartedState,
	chapter: GettingStartedChapterId
): boolean {
	return !state.activeReview &&
		state.chapters[chapter].outcome === "pending" &&
		getCurrentGettingStartedChapter(state) === chapter &&
		!isGettingStartedBusy(state);
}

export function skipGettingStartedChapter(
	state: GettingStartedState,
	chapter: GettingStartedChapterId,
	now = Date.now()
): GettingStartedState {
	if (!canSkipGettingStartedChapter(state, chapter)) {
		return { ...state };
	}
	const chapters = cloneChapterStates(state.chapters);
	chapters[chapter] = { outcome: "skipped", skippedAt: now };
	const next: GettingStartedState = {
		...state,
		status: "in-progress",
		step: getInitialStepForChapter(CHAPTER_IDS.find((id) => chapters[id].outcome === "pending") ?? null),
		practiceStage: "idle",
		chapters,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
	if (chapter === "first") {
		next.firstChapterAcknowledgedAt = state.firstChapterAcknowledgedAt ?? now;
	}
	if (chapter === "shortcut") {
		next.shortcutChapterAcknowledgedAt = state.shortcutChapterAcknowledgedAt ?? now;
		next.memorySourceTranscriptPath ??= state.shortcutTranscriptPath;
	}
	return normalizeJourneyCompletion(next, now);
}

export function startGettingStartedReview(
	state: GettingStartedState,
	chapter: GettingStartedChapterId,
	now = Date.now()
): GettingStartedState {
	if (
		state.activeReview ||
		state.chapters[chapter].outcome === "pending" ||
		isGettingStartedBusy(state)
	) {
		return { ...state };
	}
	const chapterState = state.chapters[chapter];
	const experienceNotePath = chapter === "first"
		? chapterState.latestReviewExperienceNotePath ?? state.experienceNotePath
		: chapter === "shortcut"
			? chapterState.latestReviewExperienceNotePath ??
				state.experienceNotePath ??
				state.chapters.first.latestReviewExperienceNotePath
			: undefined;
	const memorySourceTranscriptPath = chapter === "memory"
		? chapterState.latestReviewSourceTranscriptPath ??
			state.memorySourceTranscriptPath ??
			state.chapters.shortcut.latestReviewTranscriptPath ??
			state.shortcutTranscriptPath
		: undefined;
	return {
		...state,
		activeReview: {
			chapter,
			practiceStage: "idle",
			startedAt: now,
			experienceNotePath,
			memorySourceTranscriptPath
		}
	};
}

export function cancelGettingStartedReview(state: GettingStartedState): GettingStartedState {
	if (!state.activeReview || isGettingStartedBusy(state)) {
		return { ...state };
	}
	return { ...state, activeReview: undefined };
}

export function selectGettingStartedMemorySource(
	state: GettingStartedState,
	transcriptPath: string
): GettingStartedState {
	if (state.activeReview?.chapter === "memory") {
		return {
			...state,
			activeReview: {
				...state.activeReview,
				memorySourceTranscriptPath: transcriptPath,
				practiceStage: "idle",
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (getCurrentGettingStartedChapter(state) !== "memory") {
		return { ...state };
	}
	return {
		...state,
		memorySourceTranscriptPath: transcriptPath,
		practiceStage: "idle",
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function beginFirstGettingStartedPractice(
	state: GettingStartedState,
	experienceNotePath: string,
	now = Date.now()
): GettingStartedState {
	if (state.activeReview?.chapter === "first") {
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "waiting-for-first-audio",
				experienceNotePath,
				practiceStartedAt: now,
				audioPath: undefined,
				transcriptPath: undefined,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	return {
		...state,
		status: "in-progress",
		step: "first-practice",
		practiceStage: "waiting-for-first-audio",
		experienceNotePath,
		firstPracticeStartedAt: now,
		firstAudioPath: undefined,
		firstTranscriptPath: undefined,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined,
		completedAt: undefined
	};
}

export function recordFirstGettingStartedAudio(
	state: GettingStartedState,
	audioPath: string
): GettingStartedState {
	if (state.activeReview?.chapter === "first") {
		if (!state.activeReview.experienceNotePath || !state.activeReview.practiceStartedAt) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "first-audio-ready",
				audioPath,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (
		state.status !== "in-progress" ||
		state.step !== "first-practice" ||
		!state.experienceNotePath ||
		!state.firstPracticeStartedAt
	) {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "first-audio-ready",
		firstAudioPath: audioPath,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function cancelFirstGettingStartedRecording(state: GettingStartedState): GettingStartedState {
	if (state.activeReview?.chapter === "first") {
		if (state.activeReview.audioPath) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "idle",
				practiceStartedAt: undefined,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (state.step !== "first-practice" || state.firstAudioPath) {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "idle",
		firstPracticeStartedAt: undefined,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function beginFirstGettingStartedTranscription(state: GettingStartedState): GettingStartedState {
	if (state.activeReview?.chapter === "first") {
		if (!state.activeReview.audioPath) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "first-transcribing",
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (!state.firstAudioPath || state.status !== "in-progress") {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "first-transcribing",
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function cancelFirstGettingStartedTranscription(state: GettingStartedState): GettingStartedState {
	if (state.activeReview?.chapter === "first") {
		if (!state.activeReview.audioPath) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "first-audio-ready",
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (state.step !== "first-practice" || !state.firstAudioPath) {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "first-audio-ready",
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function acknowledgeFirstGettingStartedChapter(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.activeReview || state.chapters.first.outcome !== "completed") {
		return { ...state };
	}
	return {
		...state,
		step: "analysis",
		practiceStage: "idle",
		firstChapterAcknowledgedAt: state.firstChapterAcknowledgedAt ?? now
	};
}

export function beginShortcutGettingStartedPractice(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.activeReview?.chapter === "shortcut") {
		if (!state.activeReview.experienceNotePath) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "waiting-for-shortcut-audio",
				practiceStartedAt: now,
				audioPath: undefined,
				transcriptPath: undefined,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (!state.experienceNotePath || state.chapters.first.outcome === "pending") {
		return { ...state };
	}
	return {
		...state,
		step: "shortcut-practice",
		practiceStage: "waiting-for-shortcut-audio",
		shortcutPracticeStartedAt: now,
		shortcutAudioPath: undefined,
		shortcutTranscriptPath: undefined,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined,
		completedAt: undefined
	};
}

export function recordShortcutGettingStartedAudio(
	state: GettingStartedState,
	audioPath: string
): GettingStartedState {
	if (state.activeReview?.chapter === "shortcut") {
		if (!state.activeReview.practiceStartedAt) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "shortcut-audio-ready",
				audioPath,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (
		state.status !== "in-progress" ||
		state.step !== "shortcut-practice" ||
		!state.shortcutPracticeStartedAt ||
		audioPath === state.firstAudioPath
	) {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "shortcut-audio-ready",
		shortcutAudioPath: audioPath,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function waitForShortcutGettingStartedTranscription(
	state: GettingStartedState
): GettingStartedState {
	if (state.activeReview?.chapter === "shortcut") {
		if (!state.activeReview.audioPath) {
			return { ...state };
		}
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "waiting-for-shortcut-transcription",
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (!state.shortcutAudioPath || state.status !== "in-progress") {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "waiting-for-shortcut-transcription",
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function markGettingStartedTaskRunning(
	state: GettingStartedState,
	kind: GettingStartedFailureKind
): GettingStartedState {
	if (state.activeReview) {
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: getRunningStage(kind, state.activeReview.chapter),
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (state.status !== "in-progress") {
		return { ...state };
	}
	return {
		...state,
		practiceStage: getRunningStage(kind, getCurrentGettingStartedChapter(state)),
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function recordGettingStartedTranscription(
	state: GettingStartedState,
	audioPath: string,
	transcriptPath: string,
	now = Date.now()
): GettingStartedState {
	const review = state.activeReview;
	if (review?.chapter === "first" && review.audioPath === audioPath) {
		return completeReview(state, {
			...review,
			practiceStage: "first-transcription-completed",
			transcriptPath
		}, now);
	}
	if (review?.chapter === "shortcut" && review.audioPath === audioPath) {
		return {
			...state,
			activeReview: {
				...review,
				practiceStage: "analyzing",
				transcriptPath,
				lastFailureKind: undefined,
				lastFailureTaskId: undefined
			}
		};
	}
	if (state.status !== "in-progress") {
		return { ...state };
	}
	if (state.step === "first-practice" && state.firstAudioPath === audioPath) {
		const chapters = cloneChapterStates(state.chapters);
		chapters.first = { ...chapters.first, outcome: "completed", skippedAt: undefined };
		return {
			...state,
			chapters,
			practiceStage: "first-transcription-completed",
			firstTranscriptPath: transcriptPath,
			firstSuccessfulTranscriptionAt: state.firstSuccessfulTranscriptionAt ?? now,
			lastFailureKind: undefined,
			lastFailureTaskId: undefined
		};
	}
	if (state.step === "shortcut-practice" && state.shortcutAudioPath === audioPath) {
		return {
			...state,
			practiceStage: "analyzing",
			shortcutTranscriptPath: transcriptPath,
			memorySourceTranscriptPath: transcriptPath,
			lastFailureKind: undefined,
			lastFailureTaskId: undefined
		};
	}
	return { ...state };
}

export function recordGettingStartedAnalysis(
	state: GettingStartedState,
	transcriptPath: string,
	now = Date.now()
): GettingStartedState {
	const review = state.activeReview;
	if (review?.chapter === "shortcut" && review.transcriptPath === transcriptPath) {
		return completeReview(state, {
			...review,
			practiceStage: "shortcut-completed"
		}, now);
	}
	if (
		state.status !== "in-progress" ||
		state.step !== "shortcut-practice" ||
		!state.shortcutTranscriptPath ||
		state.shortcutTranscriptPath !== transcriptPath
	) {
		return { ...state };
	}
	const chapters = cloneChapterStates(state.chapters);
	chapters.shortcut = { ...chapters.shortcut, outcome: "completed", skippedAt: undefined };
	return {
		...state,
		chapters,
		practiceStage: "shortcut-completed",
		firstSuccessfulAnalysisAt: state.firstSuccessfulAnalysisAt ?? now,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	};
}

export function acknowledgeShortcutGettingStartedChapter(
	state: GettingStartedState,
	now = Date.now()
): GettingStartedState {
	if (state.activeReview || state.chapters.shortcut.outcome !== "completed") {
		return { ...state };
	}
	return {
		...state,
		step: "memory",
		practiceStage: "idle",
		memorySourceTranscriptPath: state.memorySourceTranscriptPath ?? state.shortcutTranscriptPath,
		shortcutChapterAcknowledgedAt: state.shortcutChapterAcknowledgedAt ?? now
	};
}

export function recordGettingStartedMemory(
	state: GettingStartedState,
	transcriptPath: string,
	candidatePath: string,
	now = Date.now()
): GettingStartedState {
	const review = state.activeReview;
	if (review?.chapter === "memory" && review.memorySourceTranscriptPath === transcriptPath) {
		return completeReview(state, {
			...review,
			practiceStage: "completed",
			candidatePath
		}, now);
	}
	const sourcePath = state.memorySourceTranscriptPath ?? state.shortcutTranscriptPath;
	if (
		state.status !== "in-progress" ||
		getCurrentGettingStartedChapter(state) !== "memory" ||
		!sourcePath ||
		sourcePath !== transcriptPath
	) {
		return { ...state };
	}
	const chapters = cloneChapterStates(state.chapters);
	chapters.memory = { ...chapters.memory, outcome: "completed", skippedAt: undefined };
	return normalizeJourneyCompletion({
		...state,
		chapters,
		practiceStage: "completed",
		firstSuccessfulMemoryAt: state.firstSuccessfulMemoryAt ?? now,
		memoryCandidatePath: candidatePath,
		lastFailureKind: undefined,
		lastFailureTaskId: undefined
	}, now);
}

export function recordGettingStartedFailure(
	state: GettingStartedState,
	kind: GettingStartedFailureKind,
	taskId: string
): GettingStartedState {
	if (state.activeReview) {
		return {
			...state,
			activeReview: {
				...state.activeReview,
				practiceStage: "failed",
				lastFailureKind: kind,
				lastFailureTaskId: taskId
			}
		};
	}
	if (state.status !== "in-progress") {
		return { ...state };
	}
	return {
		...state,
		practiceStage: "failed",
		lastFailureKind: kind,
		lastFailureTaskId: taskId
	};
}

export function resetGettingStartedJourney(state: GettingStartedState): GettingStartedState {
	if (state.status === "completed") {
		return { ...state };
	}
	return {
		...createGettingStartedState("in-progress"),
		firstShownAt: state.firstShownAt,
		recorderManuallyConfirmedAt: state.recorderManuallyConfirmedAt,
		hotkeysManuallyConfirmedAt: state.hotkeysManuallyConfirmedAt
	};
}

export function updateGettingStartedPath(
	state: GettingStartedState,
	oldPath: string,
	newPath: string
): GettingStartedState {
	const nextState: GettingStartedState = {
		...state,
		chapters: cloneChapterStates(state.chapters),
		activeReview: state.activeReview ? { ...state.activeReview } : undefined
	};
	for (const key of [
		"experienceNotePath",
		"firstAudioPath",
		"firstTranscriptPath",
		"shortcutAudioPath",
		"shortcutTranscriptPath",
		"memorySourceTranscriptPath",
		"memoryCandidatePath"
	] as const) {
		nextState[key] = replacePath(nextState[key], oldPath, newPath);
	}
	if (nextState.activeReview) {
		for (const key of [
			"experienceNotePath",
			"audioPath",
			"transcriptPath",
			"memorySourceTranscriptPath",
			"candidatePath"
		] as const) {
			nextState.activeReview[key] = replacePath(nextState.activeReview[key], oldPath, newPath);
		}
	}
	for (const chapter of CHAPTER_IDS) {
		for (const key of [
			"latestReviewExperienceNotePath",
			"latestReviewAudioPath",
			"latestReviewTranscriptPath",
			"latestReviewSourceTranscriptPath",
			"latestReviewCandidatePath"
		] as const) {
			nextState.chapters[chapter][key] = replacePath(nextState.chapters[chapter][key], oldPath, newPath);
		}
	}
	return nextState;
}

export function removeGettingStartedPath(
	state: GettingStartedState,
	deletedPath: string,
	now = Date.now()
): GettingStartedState {
	const deleted = {
		experience: isPathDeleted(state.experienceNotePath, deletedPath),
		firstAudio: isPathDeleted(state.firstAudioPath, deletedPath),
		firstTranscript: isPathDeleted(state.firstTranscriptPath, deletedPath),
		shortcutAudio: isPathDeleted(state.shortcutAudioPath, deletedPath),
		shortcutTranscript: isPathDeleted(state.shortcutTranscriptPath, deletedPath),
		memorySource: isPathDeleted(state.memorySourceTranscriptPath, deletedPath),
		memoryCandidate: isPathDeleted(state.memoryCandidatePath, deletedPath)
	};
	const nextState: GettingStartedState = {
		...state,
		chapters: cloneChapterStates(state.chapters),
		activeReview: state.activeReview ? { ...state.activeReview } : undefined
	};
	for (const [key, wasDeleted] of [
		["experienceNotePath", deleted.experience],
		["firstAudioPath", deleted.firstAudio],
		["firstTranscriptPath", deleted.firstTranscript],
		["shortcutAudioPath", deleted.shortcutAudio],
		["shortcutTranscriptPath", deleted.shortcutTranscript],
		["memorySourceTranscriptPath", deleted.memorySource],
		["memoryCandidatePath", deleted.memoryCandidate]
	] as const) {
		if (wasDeleted) {
			nextState[key] = undefined;
		}
	}

	if (nextState.activeReview) {
		const review = nextState.activeReview;
		const reviewExperienceDeleted = isPathDeleted(review.experienceNotePath, deletedPath);
		const reviewAudioDeleted = isPathDeleted(review.audioPath, deletedPath);
		const reviewTranscriptDeleted = isPathDeleted(review.transcriptPath, deletedPath);
		const reviewSourceDeleted = isPathDeleted(review.memorySourceTranscriptPath, deletedPath);
		const reviewCandidateDeleted = isPathDeleted(review.candidatePath, deletedPath);
		if (reviewExperienceDeleted || reviewAudioDeleted) {
			review.experienceNotePath = reviewExperienceDeleted ? undefined : review.experienceNotePath;
			review.practiceStartedAt = undefined;
			review.audioPath = undefined;
			review.transcriptPath = undefined;
			review.practiceStage = "idle";
		} else if (reviewTranscriptDeleted) {
			review.transcriptPath = undefined;
			review.practiceStage = review.chapter === "first" && review.audioPath
				? "first-audio-ready"
				: review.chapter === "shortcut" && review.audioPath
					? "shortcut-audio-ready"
					: "idle";
		}
		if (reviewSourceDeleted) {
			review.memorySourceTranscriptPath = undefined;
			review.practiceStage = "idle";
		}
		if (reviewCandidateDeleted) {
			review.candidatePath = undefined;
		}
		if (reviewExperienceDeleted || reviewAudioDeleted || reviewTranscriptDeleted || reviewSourceDeleted) {
			review.lastFailureKind = undefined;
			review.lastFailureTaskId = undefined;
		}
	}

	for (const chapter of CHAPTER_IDS) {
		for (const key of [
			"latestReviewExperienceNotePath",
			"latestReviewAudioPath",
			"latestReviewTranscriptPath",
			"latestReviewSourceTranscriptPath",
			"latestReviewCandidatePath"
		] as const) {
			if (isPathDeleted(nextState.chapters[chapter][key], deletedPath)) {
				nextState.chapters[chapter][key] = undefined;
			}
		}
	}

	if (state.status !== "completed" && !state.activeReview) {
		const currentChapter = getCurrentGettingStartedChapter(state);
		if (deleted.experience && (currentChapter === "first" || currentChapter === "shortcut")) {
			nextState.practiceStage = "idle";
			nextState.firstPracticeStartedAt = currentChapter === "first" ? undefined : nextState.firstPracticeStartedAt;
			nextState.shortcutPracticeStartedAt = currentChapter === "shortcut" ? undefined : nextState.shortcutPracticeStartedAt;
			nextState.lastFailureKind = undefined;
			nextState.lastFailureTaskId = undefined;
		}
		if (currentChapter === "first" && (deleted.firstAudio || deleted.firstTranscript)) {
			nextState.firstPracticeStartedAt = undefined;
			nextState.firstAudioPath = undefined;
			nextState.firstTranscriptPath = undefined;
			nextState.practiceStage = "idle";
		}
		if (currentChapter === "shortcut" && (deleted.shortcutAudio || deleted.shortcutTranscript)) {
			nextState.shortcutPracticeStartedAt = deleted.shortcutAudio ? undefined : nextState.shortcutPracticeStartedAt;
			nextState.shortcutAudioPath = deleted.shortcutAudio ? undefined : nextState.shortcutAudioPath;
			nextState.shortcutTranscriptPath = undefined;
			nextState.practiceStage = nextState.shortcutAudioPath ? "shortcut-audio-ready" : "idle";
		}
		if (currentChapter === "memory" && (deleted.memorySource || deleted.shortcutTranscript)) {
			nextState.memorySourceTranscriptPath = undefined;
			nextState.practiceStage = "idle";
		}
	}
	void now;
	return nextState;
}

export function getGettingStartedTrackedPaths(state: GettingStartedState): string[] {
	const paths = new Set<string>();
	for (const path of [
		state.experienceNotePath,
		state.firstAudioPath,
		state.firstTranscriptPath,
		state.shortcutAudioPath,
		state.shortcutTranscriptPath,
		state.memorySourceTranscriptPath,
		state.memoryCandidatePath,
		state.activeReview?.experienceNotePath,
		state.activeReview?.audioPath,
		state.activeReview?.transcriptPath,
		state.activeReview?.memorySourceTranscriptPath,
		state.activeReview?.candidatePath
	]) {
		if (path) {
			paths.add(path);
		}
	}
	for (const chapter of CHAPTER_IDS) {
		const chapterState = state.chapters[chapter];
		for (const path of [
			chapterState.latestReviewExperienceNotePath,
			chapterState.latestReviewAudioPath,
			chapterState.latestReviewTranscriptPath,
			chapterState.latestReviewSourceTranscriptPath,
			chapterState.latestReviewCandidatePath
		]) {
			if (path) {
				paths.add(path);
			}
		}
	}
	return [...paths];
}

export function getGettingStartedProgress(state: GettingStartedState): GettingStartedProgress {
	const chapterOutcomes = {
		first: state.chapters.first.outcome,
		shortcut: state.chapters.shortcut.outcome,
		memory: state.chapters.memory.outcome
	};
	const completedChapters = CHAPTER_IDS.filter((chapter) => chapterOutcomes[chapter] === "completed").length;
	const skippedChapters = CHAPTER_IDS.filter((chapter) => chapterOutcomes[chapter] === "skipped").length;
	return {
		chapterOutcomes,
		firstTranscriptionCompleted: chapterOutcomes.first === "completed",
		shortcutAnalysisCompleted: chapterOutcomes.shortcut === "completed",
		memoryCompleted: chapterOutcomes.memory === "completed",
		resolvedChapters: completedChapters + skippedChapters,
		completedChapters,
		skippedChapters,
		totalChapters: 3
	};
}

export function getFirstIncompleteGettingStartedStep(
	state: GettingStartedState,
	readiness: GettingStartedReadiness
): GettingStartedStep {
	if (state.activeReview) {
		return getReviewStep(state.activeReview.chapter, readiness);
	}
	if (state.status === "completed") {
		return "completed";
	}
	if (state.chapters.first.outcome === "pending") {
		if (!readiness.transcriptionReady) {
			return "transcription";
		}
		if (!readiness.recorderReady) {
			return "recorder";
		}
		return "first-practice";
	}
	if (state.chapters.first.outcome === "completed" && !state.firstChapterAcknowledgedAt) {
		return "first-practice";
	}
	if (state.chapters.shortcut.outcome === "pending") {
		if (!readiness.analysisReady) {
			return "analysis";
		}
		if (!readiness.hotkeysReady) {
			return "hotkeys";
		}
		return "shortcut-practice";
	}
	if (state.chapters.shortcut.outcome === "completed" && !state.shortcutChapterAcknowledgedAt) {
		return "shortcut-practice";
	}
	return state.chapters.memory.outcome === "pending" ? "memory" : "completed";
}

function completeReview(
	state: GettingStartedState,
	review: GettingStartedReviewAttempt,
	now: number
): GettingStartedState {
	const chapters = cloneChapterStates(state.chapters);
	const previous = chapters[review.chapter];
	chapters[review.chapter] = {
		...previous,
		outcome: "completed",
		skippedAt: undefined,
		lastReviewCompletedAt: now,
		latestReviewExperienceNotePath: review.experienceNotePath,
		latestReviewAudioPath: review.audioPath,
		latestReviewTranscriptPath: review.transcriptPath,
		latestReviewSourceTranscriptPath: review.memorySourceTranscriptPath,
		latestReviewCandidatePath: review.candidatePath
	};
	return {
		...state,
		chapters,
		activeReview: undefined
	};
}

function normalizeJourneyCompletion(state: GettingStartedState, now = Date.now()): GettingStartedState {
	const allResolved = CHAPTER_IDS.every((chapter) => state.chapters[chapter].outcome !== "pending");
	if (allResolved) {
		return {
			...state,
			status: "completed",
			step: "completed",
			practiceStage: "completed",
			completedAt: state.completedAt ?? now
		};
	}
	if (state.status === "completed") {
		return {
			...state,
			status: "in-progress",
			step: getInitialStepForChapter(CHAPTER_IDS.find((chapter) => state.chapters[chapter].outcome === "pending") ?? null),
			practiceStage: "idle",
			completedAt: undefined
		};
	}
	return state;
}

function getReviewStep(
	chapter: GettingStartedChapterId,
	readiness: GettingStartedReadiness
): GettingStartedStep {
	if (chapter === "first") {
		return !readiness.transcriptionReady
			? "transcription"
			: !readiness.recorderReady ? "recorder" : "first-practice";
	}
	if (chapter === "shortcut") {
		return !readiness.analysisReady
			? "analysis"
			: !readiness.hotkeysReady ? "hotkeys" : "shortcut-practice";
	}
	return "memory";
}

function getInitialStepForChapter(chapter: GettingStartedChapterId | null): GettingStartedStep {
	return chapter === "first" ? "transcription" : chapter === "shortcut" ? "analysis" : chapter === "memory" ? "memory" : "completed";
}

function getRunningStage(
	kind: GettingStartedFailureKind,
	chapter: GettingStartedChapterId | null
): GettingStartedPracticeStage {
	return kind === "analysis"
		? "analyzing"
		: kind === "memory"
			? "memory-running"
			: chapter === "first" ? "first-transcribing" : "shortcut-transcribing";
}

function createChapterStates(outcome: GettingStartedChapterOutcome): GettingStartedChapterStates {
	return {
		first: { outcome },
		shortcut: { outcome },
		memory: { outcome }
	};
}

function cloneChapterStates(chapters: GettingStartedChapterStates): GettingStartedChapterStates {
	return {
		first: { ...chapters.first },
		shortcut: { ...chapters.shortcut },
		memory: { ...chapters.memory }
	};
}

function normalizeChapterStates(value: unknown, completedFallback: boolean): GettingStartedChapterStates {
	const fallback = completedFallback ? "completed" : "pending";
	if (!isRecord(value)) {
		return createChapterStates(fallback);
	}
	return {
		first: normalizeChapterState(value.first, fallback),
		shortcut: normalizeChapterState(value.shortcut, fallback),
		memory: normalizeChapterState(value.memory, fallback)
	};
}

function normalizeChapterState(
	value: unknown,
	fallback: GettingStartedChapterOutcome
): GettingStartedChapterState {
	if (!isRecord(value)) {
		return { outcome: fallback };
	}
	const normalized: GettingStartedChapterState = {
		outcome: isGettingStartedChapterOutcome(value.outcome) ? value.outcome : fallback
	};
	copyTimestamp(value, normalized, "skippedAt");
	copyTimestamp(value, normalized, "lastReviewCompletedAt");
	for (const key of [
		"latestReviewExperienceNotePath",
		"latestReviewAudioPath",
		"latestReviewTranscriptPath",
		"latestReviewSourceTranscriptPath",
		"latestReviewCandidatePath"
	] as const) {
		copyString(value, normalized, key);
	}
	return normalized;
}

function normalizeReviewAttempt(value: Record<string, unknown>): GettingStartedReviewAttempt | undefined {
	if (
		!isGettingStartedChapterId(value.chapter) ||
		!isGettingStartedPracticeStage(value.practiceStage) ||
		typeof value.startedAt !== "number" ||
		!Number.isFinite(value.startedAt) ||
		value.startedAt <= 0
	) {
		return undefined;
	}
	const normalized: GettingStartedReviewAttempt = {
		chapter: value.chapter,
		practiceStage: value.practiceStage,
		startedAt: value.startedAt
	};
	copyTimestamp(value, normalized, "practiceStartedAt");
	for (const key of [
		"experienceNotePath",
		"audioPath",
		"transcriptPath",
		"memorySourceTranscriptPath",
		"candidatePath",
		"lastFailureTaskId"
	] as const) {
		copyString(value, normalized, key);
	}
	if (isGettingStartedFailureKind(value.lastFailureKind)) {
		normalized.lastFailureKind = value.lastFailureKind;
	}
	return normalized;
}

function migrateV2GettingStartedState(value: Record<string, unknown>): GettingStartedState {
	const status = value.status as GettingStartedStatus;
	const completed = status === "completed";
	const normalized = createGettingStartedState(status);
	normalized.chapters = {
		first: { outcome: completed || isPositiveTimestamp(value.firstSuccessfulTranscriptionAt) ? "completed" : "pending" },
		shortcut: { outcome: completed || isPositiveTimestamp(value.firstSuccessfulAnalysisAt) ? "completed" : "pending" },
		memory: { outcome: completed || isPositiveTimestamp(value.firstSuccessfulMemoryAt) ? "completed" : "pending" }
	};
	normalized.step = isGettingStartedStep(value.step) ? value.step : normalized.step;
	normalized.practiceStage = isGettingStartedPracticeStage(value.practiceStage)
		? value.practiceStage
		: normalized.practiceStage;
	copyCommonState(value, normalized);
	return normalizeJourneyCompletion(normalized);
}

function migrateLegacyGettingStartedState(value: Record<string, unknown>): GettingStartedState {
	const status = value.status as GettingStartedStatus;
	const normalized = createGettingStartedState(status);
	copyTimestamp(value, normalized, "firstShownAt");
	if (status === "completed") {
		copyTimestamp(value, normalized, "firstSuccessfulTranscriptionAt");
		copyTimestamp(value, normalized, "firstSuccessfulAnalysisAt");
		copyTimestamp(value, normalized, "completedAt");
	}
	return normalized;
}

function copyCommonState(source: Record<string, unknown>, target: GettingStartedState): void {
	for (const key of [
		"firstShownAt",
		"firstPracticeStartedAt",
		"firstSuccessfulTranscriptionAt",
		"firstChapterAcknowledgedAt",
		"shortcutPracticeStartedAt",
		"firstSuccessfulAnalysisAt",
		"shortcutChapterAcknowledgedAt",
		"firstSuccessfulMemoryAt",
		"recorderManuallyConfirmedAt",
		"hotkeysManuallyConfirmedAt",
		"completedAt"
	] as const) {
		copyTimestamp(source, target, key);
	}
	for (const key of [
		"experienceNotePath",
		"firstAudioPath",
		"firstTranscriptPath",
		"shortcutAudioPath",
		"shortcutTranscriptPath",
		"memorySourceTranscriptPath",
		"memoryCandidatePath",
		"lastFailureTaskId"
	] as const) {
		copyString(source, target, key);
	}
	if (isGettingStartedFailureKind(source.lastFailureKind)) {
		target.lastFailureKind = source.lastFailureKind;
	}
}

function copyTimestamp<T extends object>(
	source: Record<string, unknown>,
	target: T,
	key: keyof T
): void {
	const value = source[key as string];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) {
		(target as Record<keyof T, unknown>)[key] = value;
	}
}

function copyString<T extends object>(
	source: Record<string, unknown>,
	target: T,
	key: keyof T
): void {
	const value = source[key as string];
	if (typeof value === "string" && value.trim()) {
		(target as Record<keyof T, unknown>)[key] = value.trim();
	}
}

function replacePath(path: string | undefined, oldPath: string, newPath: string): string | undefined {
	if (path === oldPath || path?.startsWith(`${oldPath}/`)) {
		return `${newPath}${path.slice(oldPath.length)}`;
	}
	return path;
}

function isPathDeleted(path: string | undefined, deletedPath: string): boolean {
	return path === deletedPath || Boolean(path?.startsWith(`${deletedPath}/`));
}

function isPositiveTimestamp(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isGettingStartedStatus(value: unknown): value is GettingStartedStatus {
	return value === "not-started" ||
		value === "in-progress" ||
		value === "dismissed" ||
		value === "completed";
}

function isGettingStartedStep(value: unknown): value is GettingStartedStep {
	return value === "transcription" ||
		value === "recorder" ||
		value === "first-practice" ||
		value === "analysis" ||
		value === "hotkeys" ||
		value === "shortcut-practice" ||
		value === "memory" ||
		value === "completed";
}

function isGettingStartedPracticeStage(value: unknown): value is GettingStartedPracticeStage {
	return value === "idle" ||
		value === "waiting-for-first-audio" ||
		value === "first-audio-ready" ||
		value === "first-transcribing" ||
		value === "first-transcription-completed" ||
		value === "waiting-for-shortcut-audio" ||
		value === "shortcut-audio-ready" ||
		value === "waiting-for-shortcut-transcription" ||
		value === "shortcut-transcribing" ||
		value === "analyzing" ||
		value === "shortcut-completed" ||
		value === "memory-running" ||
		value === "failed" ||
		value === "completed";
}

function isGettingStartedFailureKind(value: unknown): value is GettingStartedFailureKind {
	return value === "transcription" || value === "analysis" || value === "memory";
}

function isGettingStartedChapterId(value: unknown): value is GettingStartedChapterId {
	return value === "first" || value === "shortcut" || value === "memory";
}

function isGettingStartedChapterOutcome(value: unknown): value is GettingStartedChapterOutcome {
	return value === "pending" || value === "completed" || value === "skipped";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

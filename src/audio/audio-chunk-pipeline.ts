import type {
	TranscriptionProgress,
	TranscriptionSegment,
	TranscriptionSegmentRange,
	TranscriptionUtterance
} from "../providers/transcription-provider";

export interface AudioChunk extends TranscriptionSegmentRange {
	audioBuffer: ArrayBuffer;
	mimeType: string;
}

export interface AudioChunkTranscriptionResult<RawResponse = unknown> {
	text: string;
	traceId?: string;
	utterances?: TranscriptionUtterance[];
	raw: RawResponse;
}

export interface AudioChunkPipelineResult<RawResponse = unknown> {
	text: string;
	traceId?: string;
	segments: TranscriptionSegment[];
	rawSegments: RawResponse[];
}

export interface AudioChunkPipelineInput<Chunk extends AudioChunk, RawResponse = unknown> {
	createChunks: () => Promise<Chunk[]>;
	transcribeChunk: (chunk: Chunk) => Promise<AudioChunkTranscriptionResult<RawResponse>>;
	initialSegments?: readonly TranscriptionSegment[];
	onProgress?: (progress: TranscriptionProgress) => Promise<void> | void;
	releaseChunkBuffer?: boolean;
}

export interface AdaptiveAudioChunkPipelineInput<Chunk extends AudioChunk, RawResponse = unknown>
	extends AudioChunkPipelineInput<Chunk, RawResponse> {
	splitChunk: (chunk: Chunk) => Promise<Chunk[]> | Chunk[];
	shouldRetry: (error: unknown) => boolean;
	shouldSplit: (error: unknown) => boolean;
	retryDelaysMs: readonly number[];
	maxSplitDepth: number;
	minSegmentSeconds: number;
	sleep?: (delayMs: number) => Promise<void>;
}

export async function runAudioChunkPipeline<Chunk extends AudioChunk, RawResponse = unknown>(
	input: AudioChunkPipelineInput<Chunk, RawResponse>
): Promise<AudioChunkPipelineResult<RawResponse>> {
	await input.onProgress?.({
		type: "long-audio-preparing",
		segments: cloneSegments(input.initialSegments ?? [])
	});

	const chunks = await input.createChunks();
	const completedSegments = getFixedResumePrefix(chunks, input.initialSegments ?? []);
	const rawSegments: RawResponse[] = [];
	for (let index = 0; index < completedSegments.length; index += 1) {
		releaseIfNeeded(input, chunks[index]);
	}

	await input.onProgress?.({
		type: "long-audio-started",
		totalSegments: chunks.length,
		segments: cloneAndNormalizeCompletedSegments(completedSegments, chunks.length)
	});

	try {
		for (const chunk of chunks.slice(completedSegments.length)) {
			await input.onProgress?.({
				type: "segment-started",
				segment: chunk,
				segments: [...completedSegments]
			});

			let result: AudioChunkTranscriptionResult<RawResponse>;
			try {
				result = await input.transcribeChunk(chunk);
			} finally {
				if (input.releaseChunkBuffer !== false) {
					releaseAudioChunkBuffer(chunk);
				}
			}
			const segment: TranscriptionSegment = {
				index: chunk.index,
				total: chunk.total,
				startSeconds: chunk.startSeconds,
				endSeconds: chunk.endSeconds,
				text: result.text,
				traceId: result.traceId,
				utterances: result.utterances
			};
			completedSegments.push(segment);
			rawSegments.push(result.raw);

			await input.onProgress?.({
				type: "segment-completed",
				segment,
				segments: [...completedSegments]
			});
		}
	} catch (error) {
		if (input.releaseChunkBuffer !== false) {
			for (const chunk of chunks) {
				releaseAudioChunkBuffer(chunk);
			}
		}
		throw error;
	}

	const traceId = completedSegments
		.map((segment) => segment.traceId)
		.filter((segmentTraceId): segmentTraceId is string => Boolean(segmentTraceId))
		.join(", ");

	return {
		text: completedSegments.map((segment) => segment.text.trim()).filter(Boolean).join("\n\n"),
		traceId: traceId || undefined,
		segments: completedSegments,
		rawSegments
	};
}

export async function runAdaptiveAudioChunkPipeline<Chunk extends AudioChunk, RawResponse = unknown>(
	input: AdaptiveAudioChunkPipelineInput<Chunk, RawResponse>
): Promise<AudioChunkPipelineResult<RawResponse>> {
	await input.onProgress?.({
		type: "long-audio-preparing",
		segments: cloneSegments(input.initialSegments ?? [])
	});

	const initialChunks = await input.createChunks();
	const prepared = await prepareAdaptiveResume(input, initialChunks);
	const pending = prepared.pending;
	const completedSegments = prepared.completedSegments;
	const rawSegments: RawResponse[] = [];
	const sleep =
		input.sleep ??
		((delayMs: number) => new Promise<void>((resolve) => window.setTimeout(resolve, delayMs)));

	renumberPendingChunks(pending, completedSegments.length);
	await input.onProgress?.({
		type: "long-audio-started",
		totalSegments: completedSegments.length + pending.length,
		segments: cloneAndNormalizeCompletedSegments(
			completedSegments,
			completedSegments.length + pending.length
		)
	});

	try {
		while (pending.length > 0) {
			const pendingChunk = pending.shift();
			if (!pendingChunk) {
				break;
			}

			const { chunk, splitDepth } = pendingChunk;
			renumberChunk(chunk, completedSegments.length + 1, completedSegments.length + 1 + pending.length);
			await input.onProgress?.({
				type: "segment-started",
				segment: chunk,
				segments: cloneAndNormalizeCompletedSegments(completedSegments, completedSegments.length + 1 + pending.length)
			});

			let result: AudioChunkTranscriptionResult<RawResponse> | undefined;
			let failure: unknown;
			for (let attempt = 0; attempt <= input.retryDelaysMs.length; attempt += 1) {
				try {
					result = await input.transcribeChunk(chunk);
					failure = undefined;
					break;
				} catch (error) {
					failure = error;
					const delayMs = input.retryDelaysMs[attempt];
					if (delayMs === undefined || !input.shouldRetry(error)) {
						break;
					}

					await input.onProgress?.({
						type: "segment-retrying",
						segment: { ...chunk },
						attempt: attempt + 1,
						maxAttempts: input.retryDelaysMs.length,
						delayMs,
						httpStatus: readHttpStatus(error),
						segments: cloneAndNormalizeCompletedSegments(
							completedSegments,
							completedSegments.length + 1 + pending.length
						)
					});
					await sleep(delayMs);
				}
			}

			if (!result) {
				if (canSplitChunk(input, chunk, splitDepth, failure)) {
					const replacementChunks = await input.splitChunk(chunk);
					if (replacementChunks.length < 2) {
						throw failure;
					}

					const nextDepth = splitDepth + 1;
					pending.unshift(...replacementChunks.map((replacement) => ({ chunk: replacement, splitDepth: nextDepth })));
					releaseIfNeeded(input, chunk);
					renumberPendingChunks(pending, completedSegments.length);
					const totalSegments = completedSegments.length + pending.length;
					await input.onProgress?.({
						type: "segment-split",
						segment: { ...chunk },
						replacementSegments: replacementChunks.map((replacement) => ({ ...replacement })),
						totalSegments,
						segments: cloneAndNormalizeCompletedSegments(completedSegments, totalSegments)
					});
					continue;
				}

				releaseIfNeeded(input, chunk);
				throw failure;
			}

			const totalSegments = completedSegments.length + 1 + pending.length;
			const segment: TranscriptionSegment = {
				index: completedSegments.length + 1,
				total: totalSegments,
				startSeconds: chunk.startSeconds,
				endSeconds: chunk.endSeconds,
				text: result.text,
				traceId: result.traceId,
				utterances: result.utterances
			};
			completedSegments.push(segment);
			rawSegments.push(result.raw);
			releaseIfNeeded(input, chunk);
			renumberPendingChunks(pending, completedSegments.length);

			await input.onProgress?.({
				type: "segment-completed",
				segment: { ...segment },
				segments: cloneAndNormalizeCompletedSegments(completedSegments, totalSegments)
			});
		}
	} catch (error) {
		for (const pendingChunk of pending) {
			releaseIfNeeded(input, pendingChunk.chunk);
		}
		throw error;
	}

	const normalizedSegments = cloneAndNormalizeCompletedSegments(completedSegments, completedSegments.length);
	const traceId = normalizedSegments
		.map((segment) => segment.traceId)
		.filter((segmentTraceId): segmentTraceId is string => Boolean(segmentTraceId))
		.join(", ");

	return {
		text: normalizedSegments.map((segment) => segment.text.trim()).filter(Boolean).join("\n\n"),
		traceId: traceId || undefined,
		segments: normalizedSegments,
		rawSegments
	};
}

function releaseAudioChunkBuffer(chunk: AudioChunk): void {
	chunk.audioBuffer = new ArrayBuffer(0);
}

function releaseIfNeeded<Chunk extends AudioChunk>(
	input: Pick<AudioChunkPipelineInput<Chunk>, "releaseChunkBuffer">,
	chunk: Chunk
): void {
	if (input.releaseChunkBuffer !== false) {
		releaseAudioChunkBuffer(chunk);
	}
}

function canSplitChunk<Chunk extends AudioChunk, RawResponse>(
	input: AdaptiveAudioChunkPipelineInput<Chunk, RawResponse>,
	chunk: Chunk,
	splitDepth: number,
	error: unknown
): boolean {
	const durationSeconds = chunk.endSeconds - chunk.startSeconds;
	return (
		input.shouldSplit(error) &&
		splitDepth < input.maxSplitDepth &&
		durationSeconds >= input.minSegmentSeconds * 2
	);
}

function renumberPendingChunks<Chunk extends AudioChunk>(
	pending: Array<{ chunk: Chunk; splitDepth: number }>,
	completedCount: number
): void {
	const total = completedCount + pending.length;
	pending.forEach(({ chunk }, index) => renumberChunk(chunk, completedCount + index + 1, total));
}

function renumberChunk(chunk: AudioChunk, index: number, total: number): void {
	chunk.index = index;
	chunk.total = total;
}

function cloneAndNormalizeCompletedSegments(
	segments: TranscriptionSegment[],
	total: number
): TranscriptionSegment[] {
	return segments.map((segment, index) => ({
		...segment,
		index: index + 1,
		total
	}));
}

function getFixedResumePrefix<Chunk extends AudioChunk>(
	chunks: readonly Chunk[],
	initialSegments: readonly TranscriptionSegment[]
): TranscriptionSegment[] {
	const resumeSegments = getContinuousResumePrefix(initialSegments, chunks.at(-1)?.endSeconds);
	const completed: TranscriptionSegment[] = [];
	for (let index = 0; index < Math.min(chunks.length, resumeSegments.length); index += 1) {
		if (!rangesMatch(chunks[index], resumeSegments[index])) {
			break;
		}
		completed.push(cloneSegment(resumeSegments[index]));
	}
	return completed;
}

async function prepareAdaptiveResume<Chunk extends AudioChunk, RawResponse>(
	input: AdaptiveAudioChunkPipelineInput<Chunk, RawResponse>,
	initialChunks: Chunk[]
): Promise<{
	completedSegments: TranscriptionSegment[];
	pending: Array<{ chunk: Chunk; splitDepth: number }>;
}> {
	const resumeSegments = getContinuousResumePrefix(
		input.initialSegments ?? [],
		initialChunks.at(-1)?.endSeconds
	);
	const completedSegments: TranscriptionSegment[] = [];
	const pending: Array<{ chunk: Chunk; splitDepth: number }> = [];
	let resumeIndex = 0;
	let resumeEnabled = resumeSegments.length > 0;

	const prepareChunk = async (chunk: Chunk, splitDepth: number): Promise<void> => {
		const resumeSegment = resumeSegments[resumeIndex];
		if (!resumeEnabled || !resumeSegment) {
			resumeEnabled = false;
			pending.push({ chunk, splitDepth });
			return;
		}
		if (rangesMatch(chunk, resumeSegment)) {
			completedSegments.push(cloneSegment(resumeSegment));
			resumeIndex += 1;
			releaseIfNeeded(input, chunk);
			return;
		}

		const durationSeconds = chunk.endSeconds - chunk.startSeconds;
		const canRecreatePriorSplit = rangesStartTogether(chunk, resumeSegment) &&
			resumeSegment.endSeconds < chunk.endSeconds - RANGE_TOLERANCE_SECONDS &&
			splitDepth < input.maxSplitDepth &&
			durationSeconds >= input.minSegmentSeconds * 2;
		if (!canRecreatePriorSplit) {
			resumeEnabled = false;
			pending.push({ chunk, splitDepth });
			return;
		}

		let replacements: Chunk[];
		try {
			replacements = await input.splitChunk(chunk);
		} catch {
			resumeEnabled = false;
			pending.push({ chunk, splitDepth });
			return;
		}
		if (replacements.length < 2) {
			resumeEnabled = false;
			pending.push({ chunk, splitDepth });
			return;
		}
		releaseIfNeeded(input, chunk);
		for (const replacement of replacements) {
			await prepareChunk(replacement, splitDepth + 1);
		}
	};

	for (const chunk of initialChunks) {
		await prepareChunk(chunk, 0);
	}
	return { completedSegments, pending };
}

function getContinuousResumePrefix(
	segments: readonly TranscriptionSegment[],
	maximumEndSeconds: number | undefined
): TranscriptionSegment[] {
	if (segments.length === 0 || maximumEndSeconds === undefined) {
		return [];
	}
	const completed: TranscriptionSegment[] = [];
	let expectedStart = 0;
	for (const segment of segments) {
		if (
			!Number.isFinite(segment.startSeconds) ||
			!Number.isFinite(segment.endSeconds) ||
			segment.endSeconds <= segment.startSeconds ||
			segment.endSeconds > maximumEndSeconds + RANGE_TOLERANCE_SECONDS ||
			Math.abs(segment.startSeconds - expectedStart) > RANGE_TOLERANCE_SECONDS
		) {
			break;
		}
		completed.push(cloneSegment(segment));
		expectedStart = segment.endSeconds;
	}
	return completed;
}

function rangesMatch(
	left: Pick<TranscriptionSegmentRange, "startSeconds" | "endSeconds">,
	right: Pick<TranscriptionSegmentRange, "startSeconds" | "endSeconds">
): boolean {
	return rangesStartTogether(left, right) &&
		Math.abs(left.endSeconds - right.endSeconds) <= RANGE_TOLERANCE_SECONDS;
}

function rangesStartTogether(
	left: Pick<TranscriptionSegmentRange, "startSeconds">,
	right: Pick<TranscriptionSegmentRange, "startSeconds">
): boolean {
	return Math.abs(left.startSeconds - right.startSeconds) <= RANGE_TOLERANCE_SECONDS;
}

function cloneSegments(segments: readonly TranscriptionSegment[]): TranscriptionSegment[] {
	return segments.map(cloneSegment);
}

function cloneSegment(segment: TranscriptionSegment): TranscriptionSegment {
	return {
		...segment,
		utterances: segment.utterances?.map((utterance) => ({ ...utterance }))
	};
}

const RANGE_TOLERANCE_SECONDS = 0.001;

function readHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("httpStatus" in error)) {
		return undefined;
	}
	const status = (error as { httpStatus?: unknown }).httpStatus;
	return typeof status === "number" ? status : undefined;
}

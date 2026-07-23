import type {
	TranscriptionProgress,
	TranscriptionSegment,
	TranscriptionSegmentRange
} from "../providers/transcription-provider";

export interface AudioChunk extends TranscriptionSegmentRange {
	audioBuffer: ArrayBuffer;
	mimeType: string;
}

export interface AudioChunkTranscriptionResult<RawResponse = unknown> {
	text: string;
	traceId?: string;
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
		segments: []
	});

	const chunks = await input.createChunks();
	const completedSegments: TranscriptionSegment[] = [];
	const rawSegments: RawResponse[] = [];

	await input.onProgress?.({
		type: "long-audio-started",
		totalSegments: chunks.length,
		segments: []
	});

	for (const chunk of chunks) {
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
			traceId: result.traceId
		};
		completedSegments.push(segment);
		rawSegments.push(result.raw);

		await input.onProgress?.({
			type: "segment-completed",
			segment,
			segments: [...completedSegments]
		});
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
		segments: []
	});

	const initialChunks = await input.createChunks();
	const pending = initialChunks.map((chunk) => ({ chunk, splitDepth: 0 }));
	const completedSegments: TranscriptionSegment[] = [];
	const rawSegments: RawResponse[] = [];
	const sleep =
		input.sleep ??
		((delayMs: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, delayMs)));

	renumberPendingChunks(pending, completedSegments.length);
	await input.onProgress?.({
		type: "long-audio-started",
		totalSegments: pending.length,
		segments: []
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
				traceId: result.traceId
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

function readHttpStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("httpStatus" in error)) {
		return undefined;
	}
	const status = (error as { httpStatus?: unknown }).httpStatus;
	return typeof status === "number" ? status : undefined;
}

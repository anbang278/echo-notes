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

		const result = await input.transcribeChunk(chunk);
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

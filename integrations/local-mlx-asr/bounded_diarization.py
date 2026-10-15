"""Bounded diarization: one streaming state per recording, disk-backed audio.

Replaces the full-array `generate_stream(np.ndarray)` path, which extracts
mel features for the entire file and optionally pre-encodes every frame
before the first chunk is scored. This module keeps the exact same Sortformer
model calls (init_streaming_state + feed per bounded chunk) while reading the
decoded PCM through a memory map, so peak GPU/active memory stays bounded for
hour-long meetings.

No model loading here: import diarization.py for timeline helpers only.
"""
from __future__ import annotations

import numpy as np

from diarization import build_turns  # provided by runtime root at install


class Segment:
    __slots__ = ("start", "end", "speaker")

    def __init__(self, start: float, end: float, speaker: int):
        self.start, self.end, self.speaker = start, end, speaker


FEED_SECONDS = 5.0


def feed_chunk_seconds(sr: int) -> int:
    return max(1, int(round(FEED_SECONDS * sr)))


def iter_feed_chunks(audio: np.memmap, sr: int):
    """Yield bounded read-only views of the memmap; never copies the file."""
    step = feed_chunk_seconds(sr)
    total = len(audio)
    offset = 0
    while offset < total:
        end = min(offset + step, total)
        yield np.asarray(audio[offset:end])
        offset = end


def diarize_stream(model, audio: np.memmap, sr: int, cancel, chunk_seconds: float = FEED_SECONDS):
    """Run Sortformer over the whole recording with one persistent state.

    `model` is the loaded Sortformer v2.1. Chunks are fed through
    `init_streaming_state + feed` so the FIFO/speaker-cache stays bounded;
    timestamps are recomputed from real cumulative sample counts, not from
    `state.frames_processed * frame_duration`, because padding inside each
    chunk's feature extraction can accumulate drift otherwise.
    """
    state = model.init_streaming_state()
    raw: list[Segment] = []
    step = max(1, round(chunk_seconds * sr))
    total = len(audio)
    offset = 0
    proc = model._processor_config
    frame_seconds = proc.hop_length * model.config.fc_encoder_config.subsampling_factor / proc.sampling_rate
    while offset < total:
        cancel()
        end = min(offset + step, total)
        chunk = np.asarray(audio[offset:end])
        model_origin = state.frames_processed * frame_seconds
        result, state = model.feed(
            chunk,
            state,
            sample_rate=sr,
            threshold=0.5,
            min_duration=0.0,
            merge_gap=0.0,
        )
        # Recompute this chunk's segment origin from real samples; the model
        # frame clock only sees padded feature frames and drifts with splits.
        base_seconds = offset / sr
        span_seconds = (end - offset) / sr
        for seg in result.segments:
            start = base_seconds + min(max(seg.start - model_origin, 0.0), span_seconds)
            stop = base_seconds + min(max(seg.end - model_origin, 0.0), span_seconds)
            if stop <= start:
                continue
            raw.append(Segment(start, stop, int(seg.speaker)))
        offset = end
    del state
    return raw


def bounded_turns(raw: list[Segment], samples: int, sr: int):
    """Reuse the verified timeline sweep without materializing full arrays."""
    return build_turns(raw, samples, sr)

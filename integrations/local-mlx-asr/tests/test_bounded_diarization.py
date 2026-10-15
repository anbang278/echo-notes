"""Unit tests for bounded diarization plumbing (no MLX model required).

Covers: chunk continuity, sample-clock relocation, A->B->A slot identity,
and the tail-chunk rule (<1s input still produces a complete timeline).
"""
from __future__ import annotations

import sys
import unittest
from types import SimpleNamespace as NS
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent.parent))  # runtime root fallback not needed here

import bounded_diarization as bd  # noqa: E402


class FakeState:
    def __init__(self, frames=0):
        self.frames_processed = frames


class FakeSegment:
    def __init__(self, start, end, speaker):
        self.start, self.end, self.speaker = start, end, speaker


class FakeResult:
    def __init__(self, segments):
        self.segments = segments


class FakeModel:
    """Records chunk sizes and emits scripted per-chunk segments."""

    def __init__(self, script):
        self._processor_config = NS(hop_length=160, sampling_rate=16000)
        self.config = NS(fc_encoder_config=NS(subsampling_factor=8))
        self.script = script  # list of (frames_advanced, [(start,end,spk)])
        self.calls = []
        self.state = FakeState()

    def init_streaming_state(self):
        self.state = FakeState()
        return self.state

    def feed(self, chunk, state, **kwargs):
        self.calls.append(len(chunk))
        frames, segs = self.script[len(self.calls) - 1]
        origin = state.frames_processed * 0.08
        state.frames_processed += frames
        return FakeResult([FakeSegment(s[0]+origin,s[1]+origin,s[2]) for s in segs]), state


class DiarizationStreamTests(unittest.TestCase):
    def test_chunk_continuity_exact(self):
        sr = 16000
        total = sr * 10 + 3  # 2 full chunks + 3-sample tail
        audio = np.zeros(total, dtype="<f4")
        model = FakeModel([(940, [(0.0, 1.0, 0)]), (940, [(0.5, 2.5, 1)]), (1, [])])
        raw = bd.diarize_stream(model, audio, sr, lambda: None)
        # offsets: 0, 5.0, 10.0 -> chunk starts contiguous, no overlap
        self.assertEqual(model.calls, [80000, 80000, 3])
        self.assertTrue(all(s.end > s.start for s in raw))

    def test_sample_clock_relocation_clamps_to_chunk(self):
        sr = 16000
        audio = np.zeros(sr * 5, dtype="<f4")
        # model reports beyond-span timestamps (padding artifact); both clamp into the chunk
        model = FakeModel([(940, [(0.0, 6.5, 0), (7.0, 9.9, 1)])])
        raw = bd.diarize_stream(model, audio, sr, lambda: None)
        # segments that collapse to zero span are dropped, not emitted inverted
        self.assertTrue(all(s.end > s.start for s in raw))
        self.assertTrue(all(s.end <= 5.0 + 1e-9 for s in raw))

    def test_a_b_a_identity_preserved(self):
        sr = 16000
        audio = np.zeros(sr * 15, dtype="<f4")
        model = FakeModel([
            (940, [(0.0, 4.9, 0)]),
            (940, [(0.0, 4.9, 1)]),
            (940, [(0.0, 4.9, 0)]),
        ])
        raw = bd.diarize_stream(model, audio, sr, lambda: None)
        speakers = [s.speaker for s in raw]
        self.assertEqual(speakers, [0, 1, 0])
        turns, mapping = bd.bounded_turns(raw, len(audio), sr)
        # mapped anonymous slots: first appearance order 0->1, 1->2
        self.assertEqual(mapping, {0: 1, 1: 2})
        ordered = [t.speakers for t in turns if t.speakers]
        self.assertEqual(ordered[0][0], 1)
        self.assertEqual(ordered[1][0], 2)
        self.assertEqual(ordered[2][0], 1)

    def test_tail_shorter_than_one_second(self):
        sr = 16000
        audio = np.zeros(sr // 2, dtype="<f4")
        model = FakeModel([(94, [(0.0, 0.4, 2)])])
        raw = bd.diarize_stream(model, audio, sr, lambda: None)
        self.assertEqual(len(raw), 1)
        turns, _ = bd.bounded_turns(raw, len(audio), sr)
        self.assertEqual(turns[0].start, 0)
        self.assertEqual(turns[-1].end, len(audio))

    def test_cancel_stops_midway(self):
        sr = 16000
        audio = np.zeros(sr * 15, dtype="<f4")
        model = FakeModel([(940, []), (940, []), (940, [])])
        calls = {"n": 0}

        def cancel():
            calls["n"] += 1
            if calls["n"] > 1:
                raise RuntimeError("cancelled")

        with self.assertRaises(RuntimeError):
            bd.diarize_stream(model, audio, sr, cancel)
        self.assertEqual(len(model.calls), 1)


if __name__ == "__main__":
    unittest.main()

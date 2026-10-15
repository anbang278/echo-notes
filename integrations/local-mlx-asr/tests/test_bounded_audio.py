"""Unit tests for bounded decode planning (no ffmpeg, no model)."""
from __future__ import annotations

import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import bounded_audio as ba  # noqa: E402


class PlanChunksTests(unittest.TestCase):
    def _memmap(self, samples: np.ndarray) -> np.memmap:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "decoded.f32le"
            path.write_bytes(samples.astype("<f4").tobytes())
            return np.memmap(path, dtype="<f4", mode="r", shape=(len(samples),))

    def test_short_audio_single_chunk(self):
        audio = self._memmap(np.zeros(16000 * 20))
        chunks = list(ba.plan_chunks(audio, 16000, chunk_seconds=30.0))
        self.assertEqual(chunks, [(0, 16000 * 20)])

    def test_exact_continuity_no_overlap(self):
        sr = 16000
        data = np.random.default_rng(7).normal(0, 0.05, sr * 100).astype("<f4")
        audio = self._memmap(data)
        chunks = list(ba.plan_chunks(audio, sr, chunk_seconds=25.0))
        self.assertGreater(len(chunks), 1)
        self.assertEqual(chunks[0][0], 0)
        self.assertEqual(chunks[-1][1], len(data))
        for (a_start, a_end), (b_start, b_end) in zip(chunks, chunks[1:]):
            self.assertEqual(a_end, b_start, "chunks must be contiguous")
            self.assertLessEqual(b_end - b_start, int(30.0 * sr) + sr)  # boundary + search headroom
        for start, end in chunks[:-1]:
            self.assertGreaterEqual(end - start, sr, "non-final chunks keep >= 1s")

    def test_cut_prefers_silence(self):
        sr = 16000
        data = np.zeros(sr * 70, dtype="<f4")
        # loud burst crossing the hard boundary, but quiet in the first half
        # of the ±1s search window so a low-energy cut exists before it
        data[int(sr * 29.5) : int(sr * 31)] = 0.9
        audio = self._memmap(data)
        chunks = list(ba.plan_chunks(audio, sr, chunk_seconds=30.0, search_seconds=1.0))
        first_end = chunks[0][1]
        self.assertLess(first_end / sr, 29.5, "cut should move before the loud burst")
        self.assertAlmostEqual(first_end / sr, 29.05, places=2)

    def test_tail_chunk_shorter_than_one_second(self):
        sr = 16000
        data = np.zeros(sr * 30 + 400, dtype="<f4")
        audio = self._memmap(data)
        chunks = list(ba.plan_chunks(audio, sr, chunk_seconds=30.0))
        self.assertEqual(chunks[-1][1], sr * 30 + 400)
        # final chunk may be any non-empty tail; upstream also splits here (25.05 + 4.975)
        self.assertGreater(chunks[-1][1] - chunks[-1][0], 0)
        # every sample covered exactly once
        covered = sum(e - s for s, e in chunks)
        self.assertEqual(covered, len(data))


    def test_three_hour_virtual_audio_is_contiguous_and_reads_bounded_windows(self):
        # Exact 16 kHz sample arithmetic, without allocating/decoding 3 hours.
        # The energy-search operator is replaced: this checks scheduling and
        # bounded reads, not model quality or natural three-hour performance.
        sr = 16000
        class VirtualAudio:
            def __init__(self): self.largest_read = 0
            def __len__(self): return 3 * 3600 * sr + int(.4 * sr)
            def __getitem__(self, span):
                length = span.stop - span.start
                self.largest_read = max(self.largest_read, length)
                return np.zeros(length, dtype=np.float32)
        audio = VirtualAudio()
        with patch('bounded_audio.np.convolve', side_effect=lambda a,b,mode: np.zeros(len(a)-len(b)+1)):
            chunks = list(ba.plan_chunks(audio, sr, chunk_seconds=30))
        self.assertEqual(chunks[0][0], 0)
        self.assertEqual(chunks[-1][1], len(audio))
        self.assertEqual(sum(end-start for start,end in chunks), len(audio))
        self.assertTrue(all(a[1] == b[0] for a,b in zip(chunks,chunks[1:])))
        self.assertTrue(all(0 < end-start <= 36*sr for start,end in chunks))
        self.assertLessEqual(audio.largest_read, 10*sr)


if __name__ == "__main__":
    unittest.main()

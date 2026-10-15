"""Disk-backed audio decode and bounded chunk planning for long recordings.

ffmpeg writes raw f32le PCM straight to disk; nothing larger than one bounded
window is ever held in memory. Chunk boundaries reuse the verified
low-energy-search semantics of the upstream Qwen3-ASR splitter, but scan the
memmap in windows instead of materializing the whole waveform.
"""
from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

import numpy as np

FFMPEG = "/opt/homebrew/bin/ffmpeg"
SR = 16000


class DecodeFailure(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


@dataclass
class DecodedAudio:
    path: Path
    samples: int
    sample_rate: int
    bytes_on_disk: int

    @property
    def duration_seconds(self) -> float:
        return self.samples / self.sample_rate


def open_memmap(path: Path, samples: int) -> np.memmap:
    return np.memmap(path, dtype="<f4", mode="r", shape=(samples,))


def decode_to_disk(source: Path, work_dir: Path, *, max_duration_seconds: int,
                   progress=None, cancel=None, stall_timeout: float = 120.0,
                   hard_timeout: float = 1800.0) -> DecodedAudio:
    """Decode `source` to `work_dir/decoded.f32le`; fail on stall or overrun.

    ffmpeg counts samples; one extra sample beyond the duration limit means
    the real audio is longer than allowed, and the job fails instead of
    silently truncating. Output size is checked against 8h+1 sample.
    """
    import os
    import selectors
    import shutil
    import threading
    import time

    target = work_dir / "decoded.f32le"
    limit_bytes = int(max_duration_seconds * SR) * 4
    disk_quota = 4 * 1024 ** 3
    reserve = 64 * 1024 ** 2
    source_bytes = source.stat().st_size
    command = [FFMPEG, "-nostdin", "-v", "error", "-i", str(source),
               "-map", "0:a:0", "-ac", "1", "-ar", str(SR),
               "-f", "f32le", "pipe:1"]
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as exc:
        raise DecodeFailure("decode_failed", "ffmpeg could not start") from exc
    # Drain stderr independently; retain only a bounded tail, never source paths.
    error_tail = bytearray()
    def drain():
        while data := process.stderr.read(4096):
            error_tail.extend(data)
            del error_tail[:-4096]
    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    started = last_progress = time.monotonic()
    size = 0
    try:
        with target.open("wb") as sink:
            os.chmod(target, 0o600)
            while True:
                if cancel:
                    cancel()
                now = time.monotonic()
                if hard_timeout and now - started > hard_timeout:
                    raise DecodeFailure("decode_timeout", "Audio decoding exceeded its time budget")
                if now - last_progress > stall_timeout:
                    raise DecodeFailure("decode_stalled", "Audio decoding made no progress")
                if not selector.select(timeout=0.2):
                    continue
                data = os.read(process.stdout.fileno(), 1024 * 1024)
                if not data:
                    break
                size += len(data)
                # Reject the first sample beyond the contract; never truncate to success.
                if size > limit_bytes:
                    raise DecodeFailure("duration_exceeded", "Audio exceeds the maximum supported duration")
                if source_bytes + size > disk_quota or shutil.disk_usage(work_dir).free < len(data) + reserve:
                    raise DecodeFailure("disk_quota", "Insufficient temporary disk space")
                sink.write(data)
                last_progress = time.monotonic()
                if progress:
                    progress(size / (SR * 4))
        process.wait(timeout=5)
        if process.returncode != 0:
            raise DecodeFailure("invalid_audio", "Audio cannot be decoded")
        if size == 0 or size % 4:
            raise DecodeFailure("invalid_audio", "Audio decoded to an invalid sample count")
        return DecodedAudio(target, size // 4, SR, size)
    except OSError as exc:
        raise DecodeFailure("disk_write_failed", "Audio decoding could not write temporary data") from exc
    finally:
        selector.close()
        if process.poll() is None:
            process.kill()
            process.wait()
        reader.join(timeout=1)
        process.stdout.close()
        process.stderr.close()


def plan_chunks(audio: np.memmap, sr: int, *, chunk_seconds: float,
                search_seconds: float = 5.0, min_window_ms: float = 100.0):
    """Plan low-energy chunk boundaries by scanning bounded windows.

    Yields (start_sample, end_sample) with the same invariants as the
    upstream splitter: contiguous, no overlap, every chunk >= 1s of source
    audio (the final chunk may be shorter but never empty), and cut points
    prefer the lowest-energy 100ms window near the target boundary.
    """
    total = len(audio)
    max_chunk = int(chunk_seconds * sr)
    search = int(search_seconds * sr)
    min_window = max(1, int(min_window_ms * sr / 1000))
    start = 0
    while start < total:
        hard_end = min(start + max_chunk, total)
        if hard_end >= total:
            yield (start, total)
            return
        region_start = max(start, hard_end - search)
        region_end = min(total, hard_end + search)
        window = np.abs(np.asarray(audio[region_start:region_end]))
        if len(window) > min_window:
            energy = np.convolve(window * window, np.ones(min_window) / min_window, mode="valid")
            cut = region_start + int(np.argmin(energy)) + min_window // 2
        else:
            cut = hard_end
        cut = min(max(cut, start + sr), total)
        # Do not create an artificial subsecond tail at a low-energy cut.
        if 0 < total - cut < sr:
            cut = total
        yield (start, cut)
        start = cut

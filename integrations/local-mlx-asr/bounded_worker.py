"""Bounded inference worker for long recordings.

Runs in the single MLX thread pool. Reads the uploaded file from disk, decodes
to disk, diarizes with one persistent Sortformer state fed bounded chunks,
transcribes 25/30-second windows, and streams the final text to result.json.
Nothing the size of the whole recording is ever resident: audio comes through
np.memmap views and only one window is materialized at a time.
"""
from __future__ import annotations

import hashlib
import json
import logging
import resource
import sys
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

import bounded_audio as ba
import bounded_diarization as bd
from diarization import align_text_to_speakers, build_turns, format_segment
from job_store import Job, JobStore, atomic_write_json

log = logging.getLogger("echonotes-asr")

TOKEN_BUDGET = 2048
PLAIN_CHUNK_SECONDS = 30.0
PLAIN_RETRY_CHUNK_SECONDS = 12.0  # dense speech can exceed 2048 tokens in 30s; halve once
DIAR_CHUNK_SECONDS = 25.0
DIAR_RETRY_CHUNK_SECONDS = 12.0
MIN_RETRY_SECONDS = 5.0
WATCHDOG_SECONDS = 12 * 3600


class InferenceFailure(Exception):
    def __init__(self, code: str, message: str):
        self.code, self.message = code, message
        super().__init__(message)


class Worker:
    """Wraps the existing Engine model handles with a bounded pipeline."""

    def __init__(self, engine, store: JobStore, observer=None):
        self.engine = engine  # provides load/load_diarizer/load_aligner/generate_text
        self.store = store
        self.observer = observer  # explicit local evaluation only; never enabled by HTTP
        self._watchdog_stop = threading.Event()

    def _timed(self, job, stage, operation, *args, **kwargs):
        started = time.monotonic()
        try:
            return operation(*args, **kwargs)
        finally:
            job.stage_seconds[stage] = job.stage_seconds.get(stage, 0.0) + time.monotonic() - started

    def _generate(self, job, chunk, start, end, sr):
        args = (chunk, language_for(job.language))
        if job.enhancement is not None:
            args += (job.enhancement,)
        result = self._timed(job, "asr", self.engine.generate_text, *args)
        if self.observer:
            self.observer({"event": "raw_asr", "start": start / sr, "end": end / sr,
                           "text": result.text, "language": getattr(result, "language", None)})
        return result

    def cancel_check(self, job: Job):
        if job.started_monotonic is not None and time.monotonic() - job.started_monotonic > WATCHDOG_SECONDS:
            raise InferenceFailure("watchdog", "Job exceeded the 12 hour budget")
        if job.cancel_requested:
            raise InferenceFailure("cancelled", "Job cancelled by client")

    # -- entry point -------------------------------------------------------
    def run(self, job: Job):
        decoded = None
        started = time.monotonic()
        job.started_monotonic = started
        try:
            import mlx.core as mx
            mx.reset_peak_memory()
        except ImportError:
            pass
        job_dir = self.store.jobs_dir / job.id
        source = job_dir / "audio.bin"
        try:
            if time.monotonic() - started > WATCHDOG_SECONDS:
                raise InferenceFailure("watchdog", "Job exceeded the 12 hour budget")
            self.store.transition(job, "running", stage="decoding")
            self.cancel_check(job)
            work = job_dir  # decoded PCM lives beside the upload; cleaned in finally

            def progress(seconds: int):
                self.store.update_progress(job, processed_seconds=float(seconds))

            self.cancel_check(job)
            decoded = self._timed(job, "decode", ba.decode_to_disk,
                source, work,
                max_duration_seconds=8 * 3600,
                progress=progress,
                cancel=lambda: self.cancel_check(job),
            )
            self.store.update_progress(job, duration_seconds=decoded.duration_seconds)
            audio = ba.open_memmap(decoded.path, decoded.samples)
            try:
                if job.model.endswith("sortformer-4spk"):
                    payload = self._run_diarized(job, audio, decoded, started)
                else:
                    payload = self._run_plain(job, audio, decoded, started)
            finally:
                audio._mmap.close()  # noqa: SLF001 - release mapping before cleanup
            self.cancel_check(job)
            self.store.store_result(job, payload)
        except (InferenceFailure, ba.DecodeFailure) as exc:
            if exc.code == "cancelled":
                self.store.transition(job, "canceled")
            else:
                self.store.transition(job, "failed", error={"code": exc.code, "message": exc.message})
            self.store.cleanup_terminal(job)
            raise
        except Exception as exc:  # engine/model failures
            log.error("job=%s inference failed type=%s", job.id, type(exc).__name__)
            self.store.transition(job, "failed", error={"code": "inference_failed",
                                                        "message": "Local model inference failed"})
            self.store.cleanup_terminal(job)
            raise
        finally:
            self.store.cleanup_terminal(job)
            try:
                self.record_metrics(job, decoded, started)
            except OSError:
                log.warning("job=%s metrics could not be saved", job.id)

    # -- plain mode ----------------------------------------------------------
    def _run_plain(self, job: Job, audio: np.memmap, decoded, started) -> str:
        sr = decoded.sample_rate
        texts, segments = [], []
        covered = 0
        boundaries = list(ba.plan_chunks(audio, sr, chunk_seconds=PLAIN_CHUNK_SECONDS))
        total = len(boundaries)
        self.store.update_progress(job, segment_total=total)
        for index, (start, end) in enumerate(boundaries):
            self.cancel_check(job)
            self.store.update_progress(job, stage="transcribing",
                                       segment_index=index + 1, segment_total=total,
                                       processed_seconds=start / sr)
            if start != covered:
                raise InferenceFailure("coverage_error", "Audio chunks are not continuous")
            covered = end
            chunk = np.array(audio[start:end])  # bounded window copy
            if not np.any(chunk):
                continue
            text = self._transcribe_window(job, audio, start, end, sr,
                                           retry_seconds=PLAIN_RETRY_CHUNK_SECONDS)
            texts.append(text)
            segments.append({"start": start / sr, "end": end / sr, "text": text})
        if covered != len(audio):
            raise InferenceFailure("coverage_error", "Audio tail was not processed")
        return {"text": "\n".join(t for t in texts if t), "duration": len(audio) / sr, "segments": segments}

    def _transcribe_window(self, job: Job, audio: np.memmap, start: int, end: int, sr: int,
                           *, retry_seconds: float, depth: int = 0) -> str:
        """Transcribe [start, end); on token exhaustion split at low-energy
        points and retry smaller (bounded depth 2); coverage stays exact."""
        self.cancel_check(job)
        try:
            chunk = np.array(audio[start:end])
            if len(chunk) < sr:
                chunk = np.pad(chunk, (0, sr - len(chunk)))
            return self._generate(job, chunk, start, end, sr).text.strip()
        except Exception as exc:
            if not self._is_token_exhaustion(exc):
                raise
            if depth >= 2 or (end - start) / sr <= MIN_RETRY_SECONDS:
                raise  # already minimal; the failure is real
            job.inference_counters["asr_retries"] = job.inference_counters.get("asr_retries", 0) + 1
            window = np.asarray(audio[start:end])
            sub_boundaries = list(ba.plan_chunks(window, sr, chunk_seconds=retry_seconds))
            texts = []
            cursor = start
            for sub_start, sub_end in sub_boundaries:
                if start + sub_start != cursor:
                    raise InferenceFailure("coverage_error", "Audio chunks are not continuous")
                cursor = start + sub_end
                texts.append(self._transcribe_window(
                    job, audio, start + sub_start, start + sub_end, sr,
                    retry_seconds=retry_seconds / 2, depth=depth + 1))
            if cursor != end:
                raise InferenceFailure("coverage_error", "Retry split lost the tail")
            return "\n".join(t for t in texts if t)

    @staticmethod
    def _resolve_align_language(configured: str | None, result) -> str | None:
        explicit = language_for(configured or "")
        if explicit:
            return explicit
        detected = getattr(result, "language", None)
        if isinstance(detected, list):
            return next((v for v in detected if v), None)
        return detected

    @staticmethod
    def _is_token_exhaustion(exc: Exception) -> bool:
        # service.py raises TranscriptionFailure("token_budget_exhausted",
        # "A segment reached its output limit; ..."); match by type name or message
        name = type(exc).__name__
        message = str(exc).lower()
        if "token_budget_exhausted" in name.lower():
            return True
        return ("output limit" in message) or ("token" in message and "exhaust" in message)

    # -- diarized mode -------------------------------------------------------
    def _run_diarized(self, job: Job, audio: np.memmap, decoded, started) -> str:
        sr = decoded.sample_rate
        self.store.transition(job, "running", stage="diarizing")
        self.cancel_check(job)
        try:
            self._timed(job, "diarizer_load", self.engine.load_diarizer)
        except Exception as exc:
            raise InferenceFailure("diarization_unavailable",
                                   "Speaker model failed to load; ordinary transcription remains available") from exc
        self.cancel_check(job)
        self.store.update_progress(job, stage="diarizing")
        raw = self._timed(job, "diarization", bd.diarize_stream, self.engine.diarizer, audio, sr,
                                cancel=lambda: self.cancel_check(job))
        turns, mapping = build_turns(raw, len(audio), sr)
        self.store.transition(job, "running", stage="aligning")
        self.cancel_check(job)
        try:
            self._timed(job, "aligner_load", self.engine.load_aligner)
        except Exception as exc:
            raise InferenceFailure("alignment_unavailable",
                                   "Alignment model failed to load") from exc
        segments, warnings, transcripts = [], set(), []
        boundaries = list(ba.plan_chunks(audio, sr, chunk_seconds=DIAR_CHUNK_SECONDS))
        total = len(boundaries)
        self.store.update_progress(job, segment_total=total)
        covered = 0
        for index, (start, end) in enumerate(boundaries):
            self.cancel_check(job)
            self.store.update_progress(job, stage="transcribing",
                                       segment_index=index + 1, segment_total=total,
                                       processed_seconds=start / sr)
            if start != covered:
                raise InferenceFailure("coverage_error", "Audio chunks are not continuous")
            actual_duration = (end - start) / sr
            covered = end
            assigned, window_texts, window_warnings = self._diarize_window(
                job, audio, start, end, sr, turns)
            segments.extend(assigned)
            transcripts.extend(window_texts)
            warnings.update(window_warnings)
        self.cancel_check(job)
        if covered != len(audio):
            raise InferenceFailure("coverage_error", "Audio tail was not processed")
        if "".join(s["text"] for s in segments) != "".join(transcripts):
            raise InferenceFailure("coverage_error", "Aligned transcript lost text")
        activities = [{"start": max(0, s.start), "end": min(len(audio) / sr, s.end),
                       "speaker": f"speaker_{mapping[s.speaker]}"} for s in raw if s.speaker in mapping]
        return {"text": "\n".join(format_segment(s) for s in segments),
                "transcript": "\n".join(transcripts), "segments": segments,
                "duration": len(audio) / sr, "speaker_count": len(mapping),
                "diarization": activities, "warnings": sorted(warnings)}

    def _diarize_window(self, job, audio, start, end, sr, turns, depth=0):
        """Retry failed ASR/alignment on smaller real spans; never repair timestamps.

        The aligner must cover every character within the actual source interval.
        Re-transcription is bounded to two subdivisions and preserves all samples.
        """
        self.cancel_check(job)
        chunk = np.array(audio[start:end])
        if not np.any(chunk):
            return [], [], set()
        if len(chunk) < sr:
            chunk = np.pad(chunk, (0, sr - len(chunk)))
        text = None
        try:
            self.store.update_progress(job, stage="transcribing")
            result = self._generate(job, chunk, start, end, sr)
            text = result.text.strip()
            if not text:
                return [], [], set()
            self.cancel_check(job)
            assigned, warnings, _ = self._timed(job, "alignment", self._align_window,
                job, chunk, text, turns, sr, start, (end-start)/sr,
                self._resolve_align_language(job.language, result))
            return assigned, [text], warnings
        except Exception as exc:
            retryable = self._is_token_exhaustion(exc) or (
                isinstance(exc, InferenceFailure) and exc.code == "alignment_failed")
            if not retryable or depth >= 2 or (end-start)/sr <= MIN_RETRY_SECONDS:
                raise
            job.inference_counters["alignment_retries"] = job.inference_counters.get("alignment_retries", 0) + 1
            target = min(DIAR_RETRY_CHUNK_SECONDS / (2 ** depth), (end-start)/sr/2)
            boundaries = list(ba.plan_chunks(np.asarray(audio[start:end]), sr,
                                            chunk_seconds=target, search_seconds=min(1.0, target/4)))
            if len(boundaries) < 2:
                midpoint = (end-start)//2
                boundaries = [(0, midpoint), (midpoint, end-start)]
            log.info("job=%s retry_stage=%s start=%.3f seconds=%.3f depth=%d", job.id,
                     getattr(exc, "code", "token_budget"), start/sr, (end-start)/sr, depth+1)
            segments, texts, warnings = [], [], set()
            covered = 0
            for left, right in boundaries:
                if left != covered:
                    raise InferenceFailure("coverage_error", "Retry windows are not continuous")
                current, transcript, flags = self._diarize_window(
                    job, audio, start+left, start+right, sr, turns, depth+1)
                segments.extend(current)
                texts.extend(transcript)
                warnings.update(flags)
                covered = right
            if covered != end-start:
                raise InferenceFailure("coverage_error", "Retry windows lost the audio tail")
            if text is not None and text != "".join(texts):
                job.inference_counters["retranscription_text_changed"] = job.inference_counters.get("retranscription_text_changed", 0) + 1
                if self.observer:
                    self.observer({"event": "retranscription_changed", "start": start/sr, "end": end/sr,
                                   "before": text, "after": "".join(texts)})
            return segments, texts, warnings

    def _align_window(self, job: Job, chunk: np.ndarray, text: str, turns, sr: int,
                      start: int, duration: float, align_language: str | None):
        """Align one bounded window; returns (segments, warnings, seconds)."""
        self.store.update_progress(job, stage="aligning")
        align_started = time.monotonic()
        try:
            if not align_language:
                raise InferenceFailure("alignment_language_unknown",
                                       "Could not determine the language for timestamp alignment")
            aligned = self.engine.aligner.generate(chunk, text=text, language=align_language)
            assigned = align_text_to_speakers(text, aligned.items, turns, sr, start / sr, duration)
        except InferenceFailure:
            raise
        except Exception as exc:
            raise InferenceFailure("alignment_failed",
                                   "Transcript alignment failed; no partial transcript returned") from exc
        warnings = set()
        for segment in assigned:
            if not segment["speakers"]:
                warnings.add("speaker_unassigned")
            if segment["overlap"]:
                warnings.add("overlap_words_not_separated")
            elif len(segment["speakers"]) > 1:
                warnings.add("speaker_boundary_uncertain")
            if segment["start"] == segment["end"]:
                warnings.add("alignment_point_timestamp")
        return assigned, warnings, time.monotonic() - align_started

    def record_metrics(self, job: Job, decoded, started):
        try:
            import mlx.core as mx
            mlx_peak, mlx_active = mx.get_peak_memory(), mx.get_active_memory()
        except Exception:
            mlx_peak = mlx_active = None
        metrics = {
            "job_id": job.id,
            "state": job.state,
            "stage_seconds": {key: round(value, 6) for key, value in job.stage_seconds.items()},
            "counters": dict(job.inference_counters),
            "enhancement_fingerprint": job.enhancement_fingerprint,
            "hotword_count": len(job.enhancement["hotwords"]) if job.enhancement else 0,
            "context_characters": len(job.enhancement["context_text"]) if job.enhancement else 0,
            "process_rss_scope": "process_lifetime_high_watermark",
            "segments": job.segment_total or 0,
            "mode": "diarized" if job.model.endswith("sortformer-4spk") else "plain",
            "duration_seconds": decoded.duration_seconds if decoded is not None else None,
            "elapsed_seconds": round(time.monotonic() - started, 3),
            "mlx_peak_bytes": mlx_peak,
            "mlx_active_bytes": mlx_active,
            "process_peak_rss_bytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024),
        }
        log.info("job=%s finished state=%s duration=%s elapsed=%.3f mlx_peak=%s rss=%s",
                 job.id, job.state, metrics["duration_seconds"], metrics["elapsed_seconds"],
                 mlx_peak, metrics["process_peak_rss_bytes"])
        self.engine.last_request = metrics
        atomic_write_json(self.store.jobs_dir / job.id / "metrics.json", metrics)


def language_for(language: str):
    return {"auto": None, "zh": "Chinese", "en": "English"}.get(language, language)

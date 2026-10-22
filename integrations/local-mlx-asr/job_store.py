"""Private disk-backed jobs with one atomic admission slot for both protocols."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import threading
import time
import uuid
from pathlib import Path

from enhancement import normalize_enhancement, enhancement_fingerprint

CHUNK_BYTES = 4 * 1024 * 1024
UPLOAD_TTL_SECONDS = 30 * 60
RESULT_TTL_SECONDS = 60 * 60
TERMINAL_CACHE_LIMIT = 10
MAX_FILE_BYTES = 1024 ** 3
MAX_DURATION_SECONDS = 8 * 3600
MAX_JOB_DISK_BYTES = 4 * 1024 ** 3
DISK_RESERVE_BYTES = 64 * 1024 ** 2
JOB_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TERMINAL = {"succeeded", "failed", "canceled"}
MEDIA_TYPES = {"audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg", "audio/mp3",
               "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac", "audio/webm",
               "audio/ogg", "audio/flac", "audio/x-flac", "application/ogg"}
LANGUAGES = {"auto", "zh", "en"}


class JobError(Exception):
    def __init__(self, status, code, message):
        self.status, self.code, self.message = status, code, message
        super().__init__(message)


class Job:
    def __init__(self, job_id, client_request_id, model, language, total_bytes, media_type, instance_id, enhancement=None):
        self.id, self.client_request_id = job_id, client_request_id
        self.model, self.language, self.total_bytes, self.media_type = model, language, total_bytes, media_type
        self.instance_id = instance_id
        self.enhancement = normalize_enhancement(enhancement)
        self.enhancement_fingerprint = enhancement_fingerprint(self.enhancement)
        self.stage_seconds = {}
        self.inference_counters = {}
        self.state = self.stage = "uploading"
        self.received_bytes = 0
        self.duration_seconds = None
        self.processed_seconds = 0.0
        self.segment_index = self.segment_total = self.error = None
        self.created_at = self.updated_at = time.time()
        self.upload_deadline = self.updated_at + UPLOAD_TTL_SECONDS
        self.committed = self.scheduled = self.cancel_requested = False
        self.finished_at = self.request_id = None
        self.response_format = "json"
        self.started_monotonic = None

    def to_meta(self):
        return {k: v for k, v in vars(self).items() if k not in {"started_monotonic", "scheduled", "stage_seconds", "inference_counters"}}

    @staticmethod
    def from_meta(meta, jobs_dir):
        job = Job(meta["id"], meta["client_request_id"], meta["model"], meta["language"],
                  meta["total_bytes"], meta["media_type"], meta["instance_id"], meta.get("enhancement"))
        for key in job.to_meta():
            if key in meta and key not in {"enhancement", "enhancement_fingerprint"}:
                setattr(job, key, meta[key])
        return job

    def public(self):
        value = {"job_id": self.id, "instance_id": self.instance_id, "state": self.state,
                 "stage": self.stage, "received_bytes": self.received_bytes, "total_bytes": self.total_bytes}
        if self.duration_seconds is not None:
            value.update(duration_seconds=self.duration_seconds, processed_seconds=round(self.processed_seconds, 3))
        if self.segment_index is not None:
            value["segment"] = {"index": self.segment_index, "total": self.segment_total}
        if self.request_id:
            value["request_id"] = self.request_id
        if self.error:
            value["error"] = self.error
        return value


def atomic_write_json(path, payload):
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("w") as output:
        os.chmod(tmp, 0o600)
        json.dump(payload, output, ensure_ascii=False)
        output.flush()
        os.fsync(output.fileno())
    os.replace(tmp, path)


def confirmed_size(job_dir):
    marker = job_dir / "confirmed"
    try:
        return int(marker.read_text()) if marker.is_file() else 0
    except ValueError:
        return 0


def validate_client_request_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{8,128}", value):
        raise JobError(422, "invalid_client_request_id", "client_request_id must be 8-128 safe characters")
    return value


class JobStore:
    def __init__(self, root, instance_id, models):
        self.root, self.instance_id, self.models = root, instance_id, models
        self.jobs_dir = root / "jobs"
        if self.jobs_dir.is_symlink():
            raise ValueError("Jobs directory must not be a symlink")
        self.jobs_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = threading.RLock()
        self.jobs = {}

    def _save(self, job):
        atomic_write_json(self.jobs_dir / job.id / "meta.json", job.to_meta())

    def load_existing(self):
        restarted = []
        with self.lock:
            for entry in self.jobs_dir.iterdir():
                if entry.is_symlink() or not entry.is_dir() or not JOB_ID_PATTERN.fullmatch(entry.name):
                    continue
                try:
                    job = Job.from_meta(json.loads((entry / "meta.json").read_text()), self.jobs_dir)
                    if job.id != entry.name:
                        raise ValueError("Mismatched job id")
                except (ValueError, KeyError, OSError):
                    shutil.rmtree(entry)
                    continue
                self.jobs[job.id] = job
                if job.state not in TERMINAL:
                    self.transition(job, "failed", error={"code": "server_restarted", "message": "Service restarted; upload again"})
                    restarted.append(job.id)
                # Never resume compute or keep audio after a service restart.
                self.cleanup_terminal(job)
            self.prune_expired()
        return restarted

    def fail_on_restart(self, job_dir):
        job = self.get(job_dir.name)
        self.transition(job, "failed", error={"code": "server_restarted", "message": "Service restarted; upload again"})
        self.cleanup_terminal(job)

    def prune_expired(self):
        with self.lock:
            now = time.time()
            for job in list(self.jobs.values()):
                if job.state == "uploading" and now > job.upload_deadline:
                    self.discard(job.id)
                elif job.state in TERMINAL and now - (job.finished_at or job.updated_at) > RESULT_TTL_SECONDS:
                    self.discard(job.id)
            self.enforce_terminal_cache()

    def active_job(self):
        with self.lock:
            return next((j for j in self.jobs.values() if j.state not in TERMINAL), None)

    def check_disk(self, additional=0):
        # Reserve worst-case decoded PCM before accepting a recording.
        required = additional + MAX_DURATION_SECONDS * 16000 * 4 + DISK_RESERVE_BYTES
        if required > MAX_JOB_DISK_BYTES or shutil.disk_usage(self.jobs_dir).free < required:
            raise JobError(507, "disk_quota", "Insufficient temporary disk space")

    def create(self, client_request_id, model, language, total_bytes, media_type, enhancement=None):
        try:
            enhancement = normalize_enhancement(enhancement)
        except ValueError as exc:
            raise JobError(422, "invalid_enhancement", str(exc)) from exc
        fingerprint = enhancement_fingerprint(enhancement)
        validate_client_request_id(client_request_id)
        if model not in self.models:
            raise JobError(404, "unknown_model", "Only the configured local models are available")
        if not isinstance(language, str) or language not in LANGUAGES:
            raise JobError(422, "invalid_language", "language must be auto, zh or en")
        if not isinstance(media_type, str) or media_type not in MEDIA_TYPES:
            raise JobError(422, "unsupported_media_type", "Unsupported audio media type")
        if type(total_bytes) is not int or total_bytes <= 0:
            raise JobError(422, "invalid_total_bytes", "total_bytes must be a positive integer")
        if total_bytes > MAX_FILE_BYTES:
            raise JobError(413, "file_too_large", "Audio exceeds the 1 GiB limit")
        with self.lock:
            self.prune_expired()
            for job in self.jobs.values():
                if job.client_request_id == client_request_id:
                    if (job.model, job.language, job.total_bytes, job.media_type, job.enhancement_fingerprint) != (model, language, total_bytes, media_type, fingerprint):
                        raise JobError(409, "request_conflict", "Request id was used with different parameters")
                    return job
            if self.active_job():
                raise JobError(429, "busy", "Another recording is uploading or being processed")
            self.check_disk(total_bytes)
            job = Job(uuid.uuid4().hex, client_request_id, model, language, total_bytes, media_type, self.instance_id, enhancement)
            (self.jobs_dir / job.id).mkdir(mode=0o700)
            self._save(job)
            self.jobs[job.id] = job
            return job

    def reserve_multipart(self):
        # Reserve before reading headers or body. Fields arrive later in multipart.
        return self.create(uuid.uuid4().hex, self.models[0], "auto", MAX_FILE_BYTES, "audio/wav")

    def finish_multipart(self, job, fields, size):
        with self.lock:
            model, language = fields.get("model"), fields.get("language") or "auto"
            language = {"zh-cn": "zh", "zh-tw": "zh"}.get(language.lower(), language)
            if model not in self.models:
                raise JobError(404, "unknown_model", "Only the configured local models are available")
            if not isinstance(language, str) or language not in LANGUAGES:
                raise JobError(422, "invalid_language", "language must be auto, zh or en")
            if fields.get("response_format", "json") not in {"json", "verbose_json"}:
                raise JobError(422, "invalid_format", "response_format must be json or verbose_json")
            if size <= 0:
                raise JobError(422, "empty", "Audio file is empty")
            if size > MAX_FILE_BYTES:
                raise JobError(413, "file_too_large", "Audio exceeds the 1 GiB limit")
            job.model, job.language, job.total_bytes, job.received_bytes = model, language, size, size
            job.response_format = fields.get("response_format", "json")
            (self.jobs_dir / job.id / "confirmed").write_text(str(size))
            self._save(job)

    def get(self, job_id):
        if not isinstance(job_id, str) or not JOB_ID_PATTERN.fullmatch(job_id):
            raise JobError(404, "unknown_job", "No such job")
        with self.lock:
            self.prune_expired()
            job = self.jobs.get(job_id)
            if job is None:
                raise JobError(410, "unknown_job", "Job not found or expired")
            return job

    def get_by_request(self, client_request_id):
        validate_client_request_id(client_request_id)
        with self.lock:
            self.prune_expired()
            job = next((item for item in self.jobs.values() if item.client_request_id == client_request_id), None)
            if job is None:
                raise JobError(410, "unknown_job", "Job not found or expired")
            return job

    def append_chunk(self, job, offset, payload, sha256_hex):
        if type(offset) is not int or offset < 0:
            raise JobError(400, "invalid_offset", "offset must be non-negative")
        if not payload or len(payload) > CHUNK_BYTES:
            raise JobError(413 if payload else 400, "chunk_too_large" if payload else "empty_chunk", "Invalid chunk size")
        if not isinstance(sha256_hex, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256_hex):
            raise JobError(400, "invalid_chunk_hash", "Chunk hash must be SHA-256")
        if hashlib.sha256(payload).hexdigest() != sha256_hex:
            raise JobError(400, "hash_mismatch", "Chunk SHA-256 does not match")
        with self.lock:
            if job.state != "uploading":
                raise JobError(409, "wrong_state", "Job is not accepting uploads")
            if time.time() > job.upload_deadline:
                raise JobError(410, "upload_expired", "Upload expired")
            if offset + len(payload) > job.total_bytes:
                raise JobError(413, "chunk_overflow", "Chunk exceeds declared size")
            directory = self.jobs_dir / job.id
            audio = directory / "audio.bin"
            current = job.received_bytes
            if offset < current:
                if offset + len(payload) > current:
                    raise JobError(409, "chunk_conflict", "Chunk overlaps the unconfirmed boundary")
                with audio.open("rb") as existing:
                    existing.seek(offset)
                    if existing.read(len(payload)) != payload:
                        raise JobError(409, "chunk_conflict", "Different bytes already confirmed")
                return current
            if offset != current:
                raise JobError(409, "gap", "Chunk offset is not the next confirmed byte")
            try:
                with audio.open("r+b" if audio.exists() else "w+b") as output:
                    os.chmod(audio, 0o600)
                    output.truncate(current)  # discard any unconfirmed tail from an interrupted write
                    output.seek(current)
                    output.write(payload)
                    output.flush()
                    os.fsync(output.fileno())
                marker = directory / "confirmed.tmp"
                marker.write_text(str(current + len(payload)))
                os.replace(marker, directory / "confirmed")
                job.received_bytes = current + len(payload)
                job.updated_at = time.time()
                job.upload_deadline = job.updated_at + UPLOAD_TTL_SECONDS
                self._save(job)
            except OSError as exc:
                self.transition(job, "failed", error={"code": "disk_write_failed", "message": "Could not store audio"})
                self.cleanup_terminal(job)
                raise JobError(507, "disk_write_failed", "Could not store audio") from exc
            return job.received_bytes

    def commit(self, job):
        with self.lock:
            if job.committed:
                return job
            if job.state != "uploading":
                raise JobError(409, "wrong_state", "Job cannot be committed")
            if job.received_bytes != job.total_bytes or not job.received_bytes:
                raise JobError(409, "incomplete", "Audio upload is incomplete")
            job.committed = True
            self.transition(job, "queued")
            return job

    def claim_schedule(self, job):
        with self.lock:
            if job.scheduled or not job.committed or job.state != "queued":
                return False
            job.scheduled = True
            return True

    def transition(self, job, state, *, stage=None, error=None):
        with self.lock:
            if job.cancel_requested and state not in TERMINAL and state != "canceling":
                return
            job.state, job.stage, job.updated_at = state, stage or state, time.time()
            if error:
                job.error = error
            if state in TERMINAL:
                job.finished_at = time.time()
            self._save(job)

    def update_progress(self, job, **fields):
        with self.lock:
            if job.cancel_requested:
                return
            for key, value in fields.items():
                setattr(job, key, value)
            job.updated_at = time.time()

    def request_cancel(self, job):
        with self.lock:
            if job.state in TERMINAL:
                return "canceled" if job.state == "canceled" else "already-finished"
            job.cancel_requested = True
            if job.state == "uploading" or (job.state == "queued" and not job.scheduled):
                self.transition(job, "canceled")
                self.cleanup_terminal(job)
                return "canceled"
            self.transition(job, "canceling")
            return "canceling"

    def store_result(self, job, payload):
        with self.lock:
            if job.cancel_requested:
                self.transition(job, "canceled")
                return False
            atomic_write_json(self.jobs_dir / job.id / "result.json", payload)
            self.transition(job, "succeeded")
            return True

    def load_result(self, job):
        with self.lock:
            result = self.jobs_dir / job.id / "result.json"
            if job.state != "succeeded" or not result.is_file():
                raise JobError(409, "not_ready", "Result is not ready")
            return json.loads(result.read_text())

    def discard(self, job_id, keep_meta=False):
        with self.lock:
            if keep_meta:
                self.cleanup_terminal(self.jobs[job_id])
            else:
                shutil.rmtree(self.jobs_dir / job_id, ignore_errors=True)
                self.jobs.pop(job_id, None)

    def cleanup_terminal(self, job):
        for name in ("audio.bin", "decoded.f32le", "chunk.tmp", "confirmed", "confirmed.tmp"):
            (self.jobs_dir / job.id / name).unlink(missing_ok=True)

    def enforce_terminal_cache(self):
        with self.lock:
            terminals = sorted((j for j in self.jobs.values() if j.finished_at), key=lambda j: j.finished_at, reverse=True)
            for job in terminals[TERMINAL_CACHE_LIMIT:]:
                self.discard(job.id)

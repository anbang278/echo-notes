"""Local file transcription for Echo Notes; one MLX worker, no cloud calls.

v2: adds the /v1/local-asr job protocol (capabilities/jobs/chunks/commit/
result/cancel) with disk-backed decoding and bounded diarization, and routes
the legacy multipart endpoint through the same disk pipeline. Loopback only,
manual start/stop, no auto-launch, no result text in logs.
"""
import asyncio
import concurrent.futures
import hashlib
import json
import logging
import os
import sys
import re
import fcntl
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from enhancement import SERVICE_VERSION, model_capabilities
from bounded_worker import Worker
from multipart_stream import MultipartAudio
from job_store import CHUNK_BYTES, MAX_DURATION_SECONDS, MAX_FILE_BYTES, JobError, JobStore

CODE_ROOT = Path(__file__).resolve().parent
ROOT = Path(os.environ.get("ECHONOTES_ASR_ROOT", str(CODE_ROOT))).resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MODEL_ID = "mlx-community/Qwen3-ASR-0.6B-8bit"
REVISION = "89e96d92ba34aca20b3e29fb10cc284097d1219f"
DIAR_MODEL_ID = "local/qwen3-asr-0.6b-sortformer-4spk"
DIAR_REVISION = "8541fc3db304f350b544bbcab1cfae4f3eeb2356"
ALIGN_REVISION = "0e1a68e91d815300c7c9754b2a7639378b23db15"
MODEL_PATH = Path.home() / ".cache/huggingface/hub/models--mlx-community--Qwen3-ASR-0.6B-8bit/snapshots" / REVISION
MAX_BYTES = MAX_FILE_BYTES  # legacy endpoint now honors the same 1 GiB real limit
TOKEN_BUDGET = 2048
SR = 16000
FFMPEG = "/opt/homebrew/bin/ffmpeg"
PROTOCOL = 1
INSTANCE_ID = uuid.uuid4().hex
log = logging.getLogger("echonotes-asr")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")


class TranscriptionFailure(Exception):
    def __init__(self, code, message, status=422):
        self.code, self.message, self.status = code, message, status
        super().__init__(message)


class Engine:
    def __init__(self):
        self.model = None
        self.split = None
        self.last_request = None
        self.diarizer = None
        self.diar_status = "not_loaded"
        self.diar_error = None
        self.aligner = None
        self.align_status = "not_loaded"
        self.align_error = None
        self.current_request = None

    def load(self):
        from mlx_audio.stt.utils import load_model
        from mlx_audio.stt.models.qwen3_asr.qwen3_asr import split_audio_into_chunks
        if not (MODEL_PATH / "model.safetensors").is_file():
            raise RuntimeError("Pinned model cache is missing")
        manifest = json.loads((CODE_ROOT / "model-manifest.json").read_text())
        for name, expected in manifest["files"].items():
            with (MODEL_PATH / name).open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() != expected["sha256"]:
                    raise RuntimeError("Pinned model file checksum differs: " + name)
        self.model = load_model(str(MODEL_PATH))
        self.split = split_audio_into_chunks

    def load_diarizer(self):
        if self.diarizer is not None:
            return
        self.diar_status, self.diar_error = "loading", None
        try:
            from mlx_audio.vad import load
            manifest = json.loads((CODE_ROOT / "diarization-manifest.json").read_text())
            path = Path.home() / ".cache/huggingface/hub/models--mlx-community--diar_streaming_sortformer_4spk-v2.1-fp32/snapshots" / DIAR_REVISION
            if manifest["revision"] != DIAR_REVISION:
                raise ValueError("Diarization revision mismatch")
            for name, expected in manifest["files"].items():
                with (path / name).open("rb") as source:
                    if hashlib.file_digest(source, "sha256").hexdigest() != expected["sha256"]:
                        raise ValueError("Diarization cache checksum mismatch")
            self.diarizer = load(str(path), strict=True)
            self.diar_status = "ready"
        except Exception as exc:
            self.diar_status, self.diar_error = "error", type(exc).__name__
            log.error("diarization loading failed type=%s", type(exc).__name__)
            raise TranscriptionFailure("diarization_unavailable", "Speaker model failed to load; ordinary transcription remains available", 503) from exc

    def load_aligner(self):
        if self.aligner is not None:
            return
        self.align_status, self.align_error = "loading", None
        try:
            from mlx_audio.stt.utils import load_model
            manifest = json.loads((CODE_ROOT / "alignment-manifest.json").read_text())
            path = Path.home() / ".cache/huggingface/hub/models--mlx-community--Qwen3-ForcedAligner-0.6B-8bit/snapshots" / ALIGN_REVISION
            if manifest["revision"] != ALIGN_REVISION:
                raise ValueError("Alignment revision mismatch")
            for name, expected in manifest["files"].items():
                with (path / name).open("rb") as source:
                    if hashlib.file_digest(source, "sha256").hexdigest() != expected["sha256"]:
                        raise ValueError("Alignment cache checksum mismatch")
            self.aligner = load_model(str(path), strict=True)
            self.align_status = "ready"
        except Exception as exc:
            self.align_status, self.align_error = "error", type(exc).__name__
            log.error("alignment loading failed type=%s", type(exc).__name__)
            raise TranscriptionFailure("alignment_unavailable", "Alignment model failed to load; ordinary transcription remains available", 503) from exc

    @staticmethod
    def check_cancel(cancel):
        if cancel.is_set():
            raise TranscriptionFailure("cancelled", "Client disconnected", 499)

    def generate_text(self, chunk, language, enhancement=None):
        kwargs = {}
        if enhancement is not None:
            kwargs = {"hotwords": list(enhancement["hotwords"]), "system_prompt": enhancement["context_text"] or None}
        result = self.model.generate(chunk, language=language, max_tokens=TOKEN_BUDGET,
                                     temperature=0.0, stream=False, verbose=False, **kwargs)
        if result.generation_tokens >= TOKEN_BUDGET:
            raise TranscriptionFailure("token_budget_exhausted", "A segment reached its output limit; no partial transcript returned", 500)
        if not isinstance(result.text, str):
            raise TranscriptionFailure("invalid_model_output", "Model returned an invalid transcript", 500)
        return result



engine = Engine()
worker = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx-asr")
state = {"status": "loading", "busy": False, "error": None}
store = JobStore(ROOT, INSTANCE_ID, [MODEL_ID, DIAR_MODEL_ID])
bounded = Worker(engine, store)


@asynccontextmanager
async def lifespan(app):
    lock_path = Path.home() / ".local/share/echo-notes/mlx-inference.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_handle = lock_path.open("a+")
    try:
        fcntl.flock(lock_handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock_handle.close()
        raise RuntimeError("Another MLX ASR instance holds the global inference lock")
    lock_handle.seek(0)
    lock_handle.truncate()
    lock_handle.write(str(os.getpid()))
    lock_handle.flush()
    async def preload():
        try:
            restarted = await asyncio.to_thread(store.load_existing)
            if restarted:
                log.info("startup: %d jobs marked server_restarted", len(restarted))
            await asyncio.get_running_loop().run_in_executor(worker, engine.load)
            state["status"] = "ready"
            log.info("model ready instance=%s", INSTANCE_ID)
        except Exception as exc:
            state.update(status="error", error=type(exc).__name__)
            log.error("model loading failed type=%s", type(exc).__name__)
    async def housekeeping():
        while True:
            await asyncio.sleep(30)
            await asyncio.to_thread(store.prune_expired)
    task = asyncio.create_task(preload())
    cleaner = asyncio.create_task(housekeeping())
    try:
        yield
    finally:
        state["status"] = "stopping"
        for job in list(store.jobs.values()):
            if job.state not in {"succeeded", "failed", "canceled"}:
                store.request_cancel(job)
        cleaner.cancel()
        task.cancel()
        # The executor retains the lock until all owned MLX work has stopped.
        await asyncio.to_thread(worker.shutdown, wait=True, cancel_futures=True)
        fcntl.flock(lock_handle, fcntl.LOCK_UN)
        lock_handle.close()


app = FastAPI(title="Echo Notes local ASR", lifespan=lifespan)


@app.exception_handler(TranscriptionFailure)
async def transcription_error(request, exc):
    log.warning("transcription failed code=%s", exc.code)
    return JSONResponse(status_code=exc.status, content={"error": {"code": exc.code, "message": exc.message}})


@app.get("/health")
async def health():
    active = await asyncio.to_thread(store.active_job)
    payload = dict(state, busy=active is not None, instance_id=INSTANCE_ID, model=MODEL_ID, revision=REVISION, last_request=engine.last_request,
                   current_request=({**active.public(), "mode": "diarized" if active.model == DIAR_MODEL_ID else "plain"} if active else None),
                   diarization={"status":engine.diar_status,"error":engine.diar_error,"revision":DIAR_REVISION,
                                "model":DIAR_MODEL_ID,"max_speakers":4},
                   alignment={"status":engine.align_status,"error":engine.align_error,"revision":ALIGN_REVISION})
    return JSONResponse(payload, status_code=200 if state["status"] == "ready" else 503)


@app.exception_handler(JobError)
async def job_error(request, exc):
    return JSONResponse(status_code=exc.status,
                         content={"error": {"code": exc.code, "message": exc.message,
                                            "request_id": request.state.request_id if hasattr(request.state, "request_id") else None}})


@app.middleware("http")
async def loopback_guard(request, call_next):
    # Bind host is already 127.0.0.1; reject anything that claims another origin.
    host = (request.headers.get("host") or "").split(":")[0]
    if host not in ("127.0.0.1", "localhost"):
        return JSONResponse(status_code=403, content={"error": {"code": "not_loopback", "message": "Loopback only"}})
    origin = request.headers.get("origin")
    if origin:
        try:
            from urllib.parse import urlparse
            parsed = urlparse(origin)
            if parsed.scheme != "http" or (parsed.hostname or "") not in ("127.0.0.1", "localhost"):
                return JSONResponse(status_code=403, content={"error": {"code": "cross_origin", "message": "Cross-site requests are not accepted"}})
        except ValueError:
            return JSONResponse(status_code=403, content={"error": {"code": "cross_origin", "message": "Cross-site requests are not accepted"}})
    request.state.request_id = uuid.uuid4().hex
    return await call_next(request)


# ---------------------------------------------------------------------------
# Local ASR job protocol v1
# ---------------------------------------------------------------------------

@app.get("/v1/local-asr/capabilities")
async def capabilities():
    return {
        "service": "echonotes-mlx-asr",
        "protocol": PROTOCOL,
        "instance_id": INSTANCE_ID,
        "version": SERVICE_VERSION,
        "models": [MODEL_ID, DIAR_MODEL_ID],
        "model_capabilities": model_capabilities([MODEL_ID, DIAR_MODEL_ID]),
        "max_file_bytes": MAX_FILE_BYTES,
        "max_duration_seconds": MAX_DURATION_SECONDS,
        "chunk_bytes": CHUNK_BYTES,
    }


@app.post("/v1/local-asr/jobs")
async def create_job(request: Request):
    body = await read_limited_json(request, 16 * 1024)
    if state["status"] != "ready":
        raise JobError(503, "not_ready", "Model is not ready; check /health")
    job = await asyncio.to_thread(
        store.create, body.get("client_request_id"), body.get("model"),
        body.get("language") or "auto", body.get("total_bytes"), body.get("media_type"), body.get("enhancement"))
    return JSONResponse(status_code=201, content={
        "job_id": job.id, "instance_id": job.instance_id, "state": job.state,
        "next_offset": job.received_bytes, "chunk_bytes": CHUNK_BYTES,
    }, headers={"X-Request-ID": request.state.request_id})


@app.put("/v1/local-asr/jobs/{job_id}/audio")
async def upload_chunk(job_id: str, request: Request):
    job = await asyncio.to_thread(store.get, job_id)
    offset = parse_int_header(request.headers.get("x-offset"))
    total = parse_int_header(request.headers.get("x-total-bytes"))
    sha = (request.headers.get("x-chunk-sha256") or "").lower()
    if total is not None and total != job.total_bytes:
        raise JobError(409, "total_mismatch", "x-total-bytes conflicts with the declared job size")
    content_range = request.headers.get("content-range")
    expected_length = None
    if content_range:
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
        if not match:
            raise JobError(400, "invalid_range", "Invalid Content-Range")
        start, end, declared_total = map(int, match.groups())
        if end < start or declared_total != job.total_bytes or (offset is not None and offset != start):
            raise JobError(409, "range_conflict", "Conflicting Content-Range")
        offset, expected_length = start, end - start + 1
    payload = await read_limited_body(request, CHUNK_BYTES)
    if expected_length is not None and len(payload) != expected_length:
        raise JobError(400, "range_conflict", "Range does not match actual bytes")
    confirmed = await asyncio.to_thread(store.append_chunk, job, offset, payload, sha)
    return {"job_id": job.id, "state": job.state, "next_offset": confirmed, "chunk_bytes": CHUNK_BYTES}


@app.post("/v1/local-asr/jobs/{job_id}/commit")
async def commit_job(job_id: str, request: Request):
    job = await asyncio.to_thread(store.get, job_id)
    await asyncio.to_thread(store.commit, job)
    start_inference(job)
    return JSONResponse(status_code=202, content={"job_id": job.id, "state": job.state},
                        headers={"X-Request-ID": request.state.request_id})


@app.get("/v1/local-asr/jobs/{job_id}")
async def job_status(job_id: str):
    job = await asyncio.to_thread(store.get, job_id)
    return job.public()


@app.get("/v1/local-asr/jobs/{job_id}/result")
async def job_result(job_id: str):
    job = await asyncio.to_thread(store.get, job_id)
    if job.state == "succeeded":
        result = await asyncio.to_thread(store.load_result, job)
        await asyncio.to_thread(store.enforce_terminal_cache)
        return JSONResponse(result, headers={"Cache-Control": "no-store"})
    if job.state == "failed":
        raise JobError(500 if not job.error else 422, job.error["code"] if job.error else "failed",
                       job.error["message"] if job.error else "Job failed")
    if job.state in ("canceled",):
        raise JobError(410, "canceled", "Job was canceled")
    raise JobError(409, "not_ready", f"Job is {job.state}")


@app.delete("/v1/local-asr/jobs/{job_id}")
async def cancel_job(job_id: str):
    job = await asyncio.to_thread(store.get, job_id)
    outcome = await asyncio.to_thread(store.request_cancel, job)
    if outcome == "canceled":
        return Response(status_code=204)
    if outcome == "already-finished":
        # let the client confirm retrieval and free the terminal cache
        await asyncio.to_thread(store.discard, job.id)
        return Response(status_code=204)
    return JSONResponse(status_code=202, content=job.public())


def start_inference(job):
    if not store.claim_schedule(job):
        return
    state["busy"] = True

    def run_and_release(future):
        state["busy"] = False
        if not future.cancelled():
            future.exception()  # consume errors even if the client is gone

    future = worker.submit(bounded.run, job)
    future.add_done_callback(run_and_release)


async def read_limited_json(request: Request, limit: int) -> dict:
    body = await read_limited_body(request, limit)
    if not body:
        raise JobError(422, "invalid_json", "Request body is required")
    try:
        parsed = json.loads(body)
    except ValueError:
        raise JobError(422, "invalid_json", "Request body must be JSON")
    if not isinstance(parsed, dict):
        raise JobError(422, "invalid_json", "Request body must be a JSON object")
    return parsed


async def iter_limited_body(request, limit):
    declared = request.headers.get("content-length")
    if declared and (not declared.isdigit() or int(declared) > limit):
        raise JobError(413, "body_too_large", "Request body exceeds the limit")
    total = 0
    iterator = request.stream().__aiter__()
    while True:
        try:
            chunk = await asyncio.wait_for(iterator.__anext__(), timeout=120)
        except StopAsyncIteration:
            break
        except asyncio.TimeoutError as exc:
            raise JobError(408, "upload_stalled", "Upload made no progress") from exc
        total += len(chunk)
        if total > limit:
            raise JobError(413, "body_too_large", "Request body exceeds the limit")
        yield chunk
    if declared and total != int(declared):
        raise JobError(400, "body_length_mismatch", "Request body length does not match")


async def read_limited_body(request: Request, limit: int) -> bytes:
    payload = bytearray()
    async for chunk in iter_limited_body(request, limit):
        payload.extend(chunk)
    return bytes(payload)


def parse_int_header(value) -> int | None:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        raise JobError(400, "invalid_header", "Offset headers must be integers")
    return parsed


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": model, "object": "model", "owned_by": "local"}
                                        for model in [MODEL_ID, DIAR_MODEL_ID]]}


@app.post("/v1/audio/transcriptions")
async def transcribe(request: Request):
    if state["status"] != "ready":
        raise JobError(503, "not_ready", "Model is not ready; check /health")
    job = await asyncio.to_thread(store.reserve_multipart)
    parser = None
    try:
        parser = MultipartAudio(request.headers.get("content-type", ""), store.jobs_dir / job.id / "audio.bin")
        async for chunk in iter_limited_body(request, MAX_BYTES + 65536):
            # ASGI delivers bounded network chunks. Split defensively before parsing/writing.
            for offset in range(0, len(chunk), CHUNK_BYTES):
                parser.write(chunk[offset:offset + CHUNK_BYTES])
            job.updated_at = time.time()
            job.upload_deadline = job.updated_at + 1800
        fields, size = parser.finish()
        parser.close()
        parser = None
        store.finish_multipart(job, fields, size)
        store.commit(job)
        start_inference(job)
        while job.state not in {"succeeded", "failed", "canceled"}:
            if await request.is_disconnected():
                store.request_cancel(job)
                raise JobError(499, "client_disconnected", "Client disconnected")
            await asyncio.sleep(0.2)
        if job.state == "succeeded":
            result = store.load_result(job)
            return JSONResponse(result if job.response_format == "verbose_json" else {"text": result["text"]}, headers={"X-Request-ID": request.state.request_id})
        if job.state == "canceled":
            raise JobError(499, "cancelled", "Transcription cancelled")
        raise JobError(422, job.error["code"], job.error["message"])
    except BaseException:
        if job.state not in {"succeeded", "failed", "canceled"}:
            store.request_cancel(job)
        raise
    finally:
        if parser:
            parser.close()
        if job.state in {"succeeded", "failed", "canceled"}:
            store.discard(job.id)


if __name__ == "__main__":
    import sys
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 18080
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=port, access_log=False)

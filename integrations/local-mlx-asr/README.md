# Echo Notes local MLX ASR

An optional, offline macOS Apple Silicon service for recorded audio. It provides
OpenAI-compatible `POST /v1/audio/transcriptions` and resumable local jobs.
The service listens only on `127.0.0.1`, does not start automatically, and loads
three pinned models exclusively from the existing Hugging Face cache. No audio,
transcript, or telemetry is sent to cloud services. API keys are not required.

## Run and stop

The installed runtime normally lives at `~/.local/share/echonotes-asr`. Its
`.venv` must match `requirements.lock`; model file hashes are checked against
three manifests before loading. The control application is a manual launcher.

```
./start.sh
./status.sh
./stop.sh
```

For an isolated instance, supply `--root /absolute/runtime --port 18081` to the
scripts, and set `ECHONOTES_ASR_PYTHON` to an existing matching Python interpreter.
The application accepts the same `--root` and `--port` arguments. Only one MLX
ASR process may hold `~/.local/share/echo-notes/mlx-inference.lock` across roots.
Stop checks the recorded PID, command, port and process creation time before
signaling. It requests task cancellation, then waits for the current model
operator to finish. It never kills an unrelated listener or model process.

Build a staged app with `sh controller/build.sh /absolute/staging/ASR.app`.
Building never installs or overwrites the user's application.

## Echo Notes settings

Choose **本地模型（OpenAI 兼容）**, Base URL
`http://127.0.0.1:18080/v1`, empty API key and language `auto`, `zh` or `en`.
The standard model is `mlx-community/Qwen3-ASR-0.6B-8bit`; speaker-labelled
transcription is `local/qwen3-asr-0.6b-sortformer-4spk` (at most four anonymous
speakers). Speaker labels, overlap and timestamps are approximate, not speaker
identity or a promise of perfect meeting transcription.

## Limits and recovery

Both protocols share a single upload/compute slot. Files may be at most 1 GiB;
actual decoded mono 16 kHz audio may be at most 8 hours. Larger input is rejected,
never silently truncated. Uploads and decoding are streamed to private disk
files, with at most 4 GiB per task. Disk space is checked before admission.
Decoding has a 120-second stall timeout and a 30-minute overall timeout; tasks
have a 12-hour cooperative watchdog. A currently running model operator must
finish before cancellation or the watchdog can stop compute.

`GET /v1/local-asr/capabilities` describes protocol 1. Create a job with
`client_request_id`, `model`, `language`, `total_bytes`, and `media_type`.
Upload chunks of at most 4 MiB using `Content-Range` and `X-Chunk-SHA256`;
`X-Offset`/`X-Total-Bytes` are also supported. Create, chunk acknowledgement and
commit are idempotent. Query state/result without waiting for the compute
executor. `DELETE` returns 202 while canceling and 204 when canceled or when a
terminal result has been removed. Save the transcript before deleting results.

Audio/PCM is deleted at terminal state. Results expire after 60 minutes;
uncommitted uploads expire after 30 idle minutes. At most ten terminal records
are retained. Restarted unfinished jobs fail with `server_restarted` and require
a new upload. Standard multipart callers receive one synchronous JSON result;
there is no reconnect guarantee for that protocol.

## Verification

Run `python -m unittest discover -s tests -v` using the matching interpreter.
Tests use temporary directories and fake compute for state-machine scenarios;
real model validation is separate under `validation/quality.py` and
`validation/long_audio.py`. Those scripts require explicitly supplied public
fixture paths, save evidence outside this source tree and never read a private
Vault. `validation/long_audio.py` labels repeated public speech as a constructed
pressure fixture, not a natural two-hour meeting.

"""JobStore unit tests with a temp runtime root; no FastAPI, no models."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import job_store as js  # noqa: E402

MODELS = ["m/plain", "m/diar"]


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = js.JobStore(self.root, "instance-A", MODELS)

    def tearDown(self):
        self.tmp.cleanup()

    def chunk(self, size=1024, seed=b"x"):
        payload = (seed * (size // len(seed) + 1))[:size]
        import hashlib
        return payload, hashlib.sha256(payload).hexdigest()


class CreateTests(StoreTestCase):
    def test_create_and_idempotent_replay(self):
        job = self.store.create("req-12345678", "m/plain", "zh", 2048, "audio/wav")
        again = self.store.create("req-12345678", "m/plain", "zh", 2048, "audio/wav")
        self.assertEqual(job.id, again.id)

    def test_conflicting_params_rejected(self):
        self.store.create("req-12345678", "m/plain", "zh", 2048, "audio/wav")
        with self.assertRaises(js.JobError) as ctx:
            self.store.create("req-12345678", "m/plain", "en", 2048, "audio/wav")
        self.assertIn(ctx.exception.status, (409, 429))

    def test_busy_during_inference(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        self.store.transition(job, "transcribing")
        with self.assertRaises(js.JobError) as ctx:
            self.store.create("req-87654321", "m/plain", "auto", 512, "audio/wav")
        self.assertEqual(ctx.exception.status, 429)

    def test_limits(self):
        with self.assertRaises(js.JobError):
            self.store.create("req-12345678", "m/plain", "auto", 0, "audio/wav")
        with self.assertRaises(js.JobError):
            self.store.create("req-12345678", "m/plain", "auto", js.MAX_FILE_BYTES + 1, "audio/wav")
        with self.assertRaises(js.JobError):
            self.store.create("req-12345678", "m/unknown", "auto", 512, "audio/wav")
        with self.assertRaises(js.JobError):
            self.store.create("req-12345678", "m/plain", "fr", 512, "audio/wav")
        with self.assertRaises(js.JobError):
            self.store.create("req-12345678", "m/plain", "auto", 512, "video/mp4")


class ChunkTests(StoreTestCase):
    def test_sequential_upload_and_commit(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 2048, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        b, bh = self.chunk(1024, b"b")
        self.assertEqual(self.store.append_chunk(job, 0, a, ah), 1024)
        self.assertEqual(self.store.append_chunk(job, 1024, b, bh), 2048)
        self.store.commit(job)
        self.assertEqual(job.state, "queued")

    def test_gap_rejected(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 2048, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        b, bh = self.chunk(1024, b"b")
        self.store.append_chunk(job, 0, a, ah)
        with self.assertRaises(js.JobError) as ctx:
            self.store.append_chunk(job, 512, b, bh)
        self.assertEqual(ctx.exception.status, 409)

    def test_idempotent_replay_same_chunk(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        self.assertEqual(self.store.append_chunk(job, 0, a, ah), 1024)

    def test_conflict_replay_different_chunk(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        c, ch = self.chunk(1024, b"c")
        self.store.append_chunk(job, 0, a, ah)
        with self.assertRaises(js.JobError) as ctx:
            self.store.append_chunk(job, 0, c, ch)
        self.assertEqual(ctx.exception.status, 409)

    def test_hash_mismatch(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, _ = self.chunk(1024, b"a")
        wrong = "0" * 64
        with self.assertRaises(js.JobError) as ctx:
            self.store.append_chunk(job, 0, a, wrong)
        self.assertEqual(ctx.exception.status, 400)
        self.assertEqual(job.received_bytes, 0)

    def test_chunk_over_limit(self):
        job = self.store.create("req-12345678", "m/plain", "auto", js.CHUNK_BYTES + 1, "audio/wav")
        big = b"z" * (js.CHUNK_BYTES + 1)
        import hashlib
        with self.assertRaises(js.JobError) as ctx:
            self.store.append_chunk(job, 0, big, hashlib.sha256(big).hexdigest())
        self.assertEqual(ctx.exception.status, 413)

    def test_commit_incomplete_fails(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 2048, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        with self.assertRaises(js.JobError) as ctx:
            self.store.commit(job)
        self.assertEqual(ctx.exception.status, 409)

    def test_commit_twice_is_idempotent(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        self.store.commit(job)
        self.store.commit(job)
        self.assertEqual(job.state, "queued")


class CancelRestartTests(StoreTestCase):
    def test_cancel_during_upload_frees_slot(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        outcome = self.store.request_cancel(job)
        self.assertEqual(outcome, "canceled")
        self.assertIsNone(self.store.active_job())

    def test_cancel_during_inference_marks_canceling(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        self.store.commit(job)
        self.store.transition(job, "decoding")
        self.assertEqual(self.store.request_cancel(job), "canceling")

    def test_restart_fails_unfinished_and_cleans_audio(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        # simulate a restart: fresh store over the same root
        store2 = js.JobStore(self.root, "instance-B", MODELS)
        restarted = store2.load_existing()
        self.assertEqual(len(restarted), 1)
        meta = __import__("json").loads((self.root / "jobs" / job.id / "meta.json").read_text())
        self.assertEqual(meta["state"], "failed")
        self.assertEqual(meta["error"]["code"], "server_restarted")
        self.assertFalse((self.root / "jobs" / job.id / "audio.bin").exists())

    def test_result_roundtrip_and_cleanup(self):
        job = self.store.create("req-12345678", "m/plain", "auto", 1024, "audio/wav")
        a, ah = self.chunk(1024, b"a")
        self.store.append_chunk(job, 0, a, ah)
        self.store.commit(job)
        self.store.store_result(job, {"text": "hello"})
        self.assertEqual(job.state, "succeeded")
        self.assertEqual(self.store.load_result(job)["text"], "hello")
        self.store.cleanup_terminal(job)
        # result survives cleanup; audio is gone
        self.assertEqual(self.store.load_result(job)["text"], "hello")
        self.assertFalse((self.root / "jobs" / job.id / "audio.bin").exists())

    def test_unknown_job_410(self):
        with self.assertRaises(js.JobError) as ctx:
            self.store.get("f" * 32)
        self.assertEqual(ctx.exception.status, 410)

    def test_bad_job_id_404(self):
        with self.assertRaises(js.JobError) as ctx:
            self.store.get("../escape")
        self.assertEqual(ctx.exception.status, 404)


if __name__ == "__main__":
    unittest.main()

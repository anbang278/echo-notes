"""Actual Worker lifecycle with deterministic model operators and real ffmpeg."""
import hashlib
import json
import tempfile
import unittest
import wave
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

from bounded_worker import Worker, InferenceFailure
from job_store import JobStore


class WorkerTests(unittest.TestCase):
    def prepare(self, root, seconds=1):
        store=JobStore(root,'test-instance',['model'])
        source=root/'input.wav'
        with wave.open(str(source),'wb') as output:
            output.setnchannels(1);output.setsampwidth(2);output.setframerate(16000)
            output.writeframes(b'\x01\x00'*int(seconds*16000))
        data=source.read_bytes()
        job=store.create('request-123','model','zh',len(data),'audio/wav')
        store.append_chunk(job,0,data,hashlib.sha256(data).hexdigest())
        store.commit(job)
        return store,job

    def test_actual_worker_publishes_running_state_and_saves_before_terminal(self):
        with tempfile.TemporaryDirectory() as tmp:
            store,job=self.prepare(Path(tmp))
            phases=[]
            def generate(*args):
                phases.append((job.state,job.stage));return NS(text='fixture',language='Chinese')
            engine=NS(generate_text=generate,last_request=None)
            worker=Worker(engine,store)
            worker.run(job)
            self.assertEqual(phases,[('running','transcribing')])
            self.assertEqual(job.state,'succeeded')
            self.assertEqual(store.load_result(job)['text'],'fixture')
            self.assertFalse((store.jobs_dir/job.id/'audio.bin').exists())
            self.assertFalse((store.jobs_dir/job.id/'decoded.f32le').exists())
            self.assertGreater(engine.last_request['process_peak_rss_bytes'],0)

    def test_cancel_from_model_operator_does_not_save_late_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            store,job=self.prepare(Path(tmp))
            def generate(*args):
                store.request_cancel(job);return NS(text='late',language='Chinese')
            engine=NS(generate_text=generate,last_request=None)
            with self.assertRaises(InferenceFailure):Worker(engine,store).run(job)
            self.assertEqual(job.state,'canceled')
            self.assertFalse((store.jobs_dir/job.id/'result.json').exists())

    def test_watchdog_checks_each_operator_boundary(self):
        with tempfile.TemporaryDirectory() as tmp:
            store,job=self.prepare(Path(tmp))
            worker=Worker(NS(),store)
            with patch('bounded_worker.WATCHDOG_SECONDS',-1):
                with self.assertRaises(InferenceFailure):worker.run(job)
            self.assertEqual(job.error['code'],'watchdog')

    def test_alignment_retry_retains_detected_language_and_all_samples(self):
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            store,job=self.prepare(Path(tmp),seconds=20)
            job.language='auto'
            calls=[]
            engine=NS(generate_text=lambda audio,language: NS(text='valid',language=['Chinese']))
            worker=Worker(engine,store)
            def align(job, chunk, text, turns, sr, start, duration, language):
                self.assertEqual(language,'Chinese')
                calls.append((start,round(duration*sr)))
                if duration>12:raise InferenceFailure('alignment_failed','bad timestamp')
                return [{'text':text,'start':start/sr,'end':start/sr+duration}],set(),0
            worker._align_window=align
            audio=np.ones(20*16000,dtype=np.float32)
            result,texts,warnings=worker._diarize_window(job,audio,0,len(audio),16000,[])
            self.assertEqual(result[0]['start'],0)
            self.assertEqual(result[-1]['end'],20)
            self.assertEqual(''.join(s['text'] for s in result),''.join(texts))
            self.assertTrue(all(a['end']==b['start'] for a,b in zip(result,result[1:])))

    def test_cancel_before_scheduling_releases_slot(self):
        with tempfile.TemporaryDirectory() as tmp:
            store,job=self.prepare(Path(tmp))
            self.assertEqual(store.request_cancel(job),'canceled')
            self.assertIsNone(store.active_job())
            self.assertFalse(store.claim_schedule(job))


if __name__=='__main__':unittest.main()

"""Enhancement contracts exercised through the actual job store."""
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS

import job_store
from job_store import JobStore, JobError
from bounded_worker import Worker


class EnhancementTests(unittest.TestCase):
    def normalize(self, payload):
        normalize = getattr(job_store, 'normalize_enhancement', None)
        self.assertTrue(callable(normalize), 'Job store must validate enhancement snapshots')
        return normalize(payload)

    def test_normalization_preserves_case_and_unicode_counts(self):
        self.assertEqual(self.normalize({'version': 1, 'hotwords': ['  示例 ', '示例', '', 'AI', 'ai', '🦜'], 'context_text': ' 背景 '}),
                         {'version': 1, 'hotwords': ['示例', 'AI', 'ai', '🦜'], 'context_text': '背景'})
        self.assertIsNone(self.normalize(None))
        self.assertEqual(len(self.normalize({'version': 1, 'hotwords': ['🦜' * 1000]})['hotwords'][0]), 1000)

    def test_invalid_values_and_budgets_are_rejected(self):
        for value in [[], {'version': True}, {'version': 2}, {'version': 1, 'hotwords': 'word'},
                      {'version': 1, 'hotwords': [4]}, {'version': 1, 'hotwords': ['x' * 1001]},
                      {'version': 1, 'hotwords': [str(i) for i in range(101)]},
                      {'version': 1, 'context_text': '字' * 401}]:
            with self.subTest(value_type=type(value).__name__):
                normalize = getattr(job_store, 'normalize_enhancement', None)
                self.assertTrue(callable(normalize), 'Enhancement validator is missing')
                with self.assertRaises(ValueError): normalize(value)

    def test_job_freezes_snapshot_and_detects_conflicting_retry(self):
        self.normalize(None)
        with tempfile.TemporaryDirectory() as tmp:
            store = JobStore(Path(tmp), 'test', ['model'])
            payload = {'version': 1, 'hotwords': ['词'], 'context_text': '背景'}
            job = store.create('request-123', 'model', 'zh', 4, 'audio/wav', enhancement=payload)
            payload['hotwords'].append('later')
            self.assertEqual(job.enhancement['hotwords'], ['词'])
            replay = store.create('request-123', 'model', 'zh', 4, 'audio/wav', enhancement={'version': 1, 'hotwords': [' 词 '], 'context_text': '背景'})
            self.assertIs(replay, job)
            with self.assertRaises(JobError) as error:
                store.create('request-123', 'model', 'zh', 4, 'audio/wav', enhancement={'version': 1, 'hotwords': ['other']})
            self.assertEqual(error.exception.code, 'request_conflict')
            self.assertNotIn('词', json.dumps(job.public(), ensure_ascii=False))
            meta=json.loads((store.jobs_dir/job.id/'meta.json').read_text())
            restored=job_store.Job.from_meta(meta, store.jobs_dir)
            self.assertEqual(restored.enhancement, job.enhancement)
            self.assertEqual(restored.enhancement_fingerprint, job.enhancement_fingerprint)
            meta.pop('enhancement');meta.pop('enhancement_fingerprint')
            self.assertIsNone(job_store.Job.from_meta(meta, store.jobs_dir).enhancement)

    def test_plain_worker_propagates_snapshot_to_retries(self):
        self.normalize(None)
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            store=JobStore(Path(tmp), 'test', ['model'])
            job=store.create('request-123','model','zh',4,'audio/wav',enhancement={'version':1,'hotwords':['词']})
            calls=[]
            def generate(audio, language, enhancement):
                calls.append((len(audio),language,enhancement))
                if len(audio)>16000*12: raise RuntimeError('token exhausted')
                return NS(text='词',language='Chinese')
            worker=Worker(NS(generate_text=generate),store)
            audio=np.ones(20*16000,dtype=np.float32)
            self.assertTrue(worker._transcribe_window(job,audio,0,len(audio),16000,retry_seconds=12))
            self.assertGreater(len(calls),1)
            self.assertTrue(all(call[2]==job.enhancement for call in calls))

    def test_diarized_token_exhaustion_is_not_counted_as_alignment_failure(self):
        self.normalize(None)
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            store=JobStore(Path(tmp),'test',['model'])
            job=store.create('request-123','model','zh',4,'audio/wav')
            def generate(audio, language):
                if len(audio)>12*16000:raise RuntimeError('token exhausted')
                return NS(text='词',language='Chinese')
            worker=Worker(NS(generate_text=generate),store)
            worker._align_window=lambda *args: ([{'text':'词'}],set(),0)
            worker._diarize_window(job,np.ones(20*16000,dtype=np.float32),0,20*16000,16000,[])
            self.assertEqual(job.inference_counters.get('token_budget_retries'),1)
            self.assertEqual(job.inference_counters.get('alignment_retries',0),0)

    def test_diarized_worker_passes_enhancement_and_reports_stage_timings(self):
        self.normalize(None)
        import numpy as np
        with tempfile.TemporaryDirectory() as tmp:
            store=JobStore(Path(tmp),'test',['model'])
            job=store.create('request-123','model','zh',4,'audio/wav',enhancement={'version':1,'context_text':'背景'})
            calls=[]
            def generate(audio, language, enhancement):
                calls.append(enhancement);return NS(text='词',language='Chinese')
            worker=Worker(NS(generate_text=generate),store)
            worker._align_window=lambda *args: ([{'text':'词','start':0,'end':1}],set(),0.01)
            worker._diarize_window(job,np.ones(16000,dtype=np.float32),0,16000,16000,[])
            self.assertEqual(calls,[job.enhancement])
            self.assertIn('asr',job.stage_seconds)


if __name__ == '__main__': unittest.main()

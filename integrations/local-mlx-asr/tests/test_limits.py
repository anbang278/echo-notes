"""Real ffmpeg sample boundaries and store fault/expiry tests without MLX."""
import hashlib
import tempfile
import subprocess
import sys
import time
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

import bounded_audio as ba
from job_store import JobStore, JobError, MAX_FILE_BYTES, RESULT_TTL_SECONDS


class LimitsTests(unittest.TestCase):
    def test_stalled_and_timed_out_decoder_only_terminates_its_child(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input.wav';source.write_bytes(b'fixture')
            children=[];real_popen=subprocess.Popen
            def stalled(*_args,**_kwargs):
                child=real_popen([sys.executable,'-c','import time; time.sleep(30)'],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                children.append(child);return child
            for options,code in [({'stall_timeout':.01},'decode_stalled'),({'hard_timeout':.01},'decode_timeout')]:
                with patch('bounded_audio.subprocess.Popen',side_effect=stalled):
                    with self.assertRaises(ba.DecodeFailure) as failure:
                        ba.decode_to_disk(source,root,max_duration_seconds=1,**options)
                self.assertEqual(failure.exception.code,code)
                self.assertIsNotNone(children[-1].poll())
                self.assertTrue(source.exists())

    def test_mid_decode_disk_failure_is_reported_without_touching_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'input.wav'
            with wave.open(str(source),'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000);wav.writeframes(b'\x01\x00'*16000)
            expected=source.read_bytes();real_open=Path.open
            class FullDisk:
                def __init__(self,handle):self.handle=handle
                def __enter__(self):return self
                def __exit__(self,*_args):self.handle.close()
                def write(self,_data):raise OSError(28,'injected ENOSPC')
            def open_file(path,*args,**kwargs):
                handle=real_open(path,*args,**kwargs)
                return FullDisk(handle) if path.name=='decoded.f32le' and args==('wb',) else handle
            with patch('pathlib.Path.open',open_file):
                with self.assertRaises(ba.DecodeFailure) as failure:ba.decode_to_disk(source,root,max_duration_seconds=1)
            self.assertEqual(failure.exception.code,'disk_write_failed')
            self.assertEqual(source.read_bytes(),expected)

    def test_real_decoding_exact_limit_and_one_extra_sample(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            for samples,allowed in [(16000,True),(16001,False),(6400,True)]:
                source=root/'input.wav'
                with wave.open(str(source),'wb') as wav:
                    wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
                    wav.writeframes(b'\x01\x00'*samples)
                if allowed:
                    result=ba.decode_to_disk(source,root,max_duration_seconds=1)
                    self.assertEqual(result.samples,samples)
                else:
                    with self.assertRaises(ba.DecodeFailure) as failure:
                        ba.decode_to_disk(source,root,max_duration_seconds=1)
                    self.assertEqual(failure.exception.code,'duration_exceeded')

    def test_disk_preflight_and_exact_file_limit(self):
        with tempfile.TemporaryDirectory() as root:
            store=JobStore(Path(root),'instance',['model'])
            job=store.create('request-id','model','auto',MAX_FILE_BYTES,'audio/wav')
            self.assertEqual(job.total_bytes,MAX_FILE_BYTES)
            store.discard(job.id)
            with self.assertRaises(JobError) as error:store.create('oversize-id','model','auto',MAX_FILE_BYTES+1,'audio/wav')
            self.assertEqual(error.exception.status,413)
            with patch('job_store.shutil.disk_usage',return_value=type('Usage',(),{'free':1})()):
                with self.assertRaises(JobError) as error:store.create('disk-low-id','model','auto',1,'audio/wav')
                self.assertEqual(error.exception.status,507)

    def test_expired_job_clears_memory_and_disk_and_terminal_cache(self):
        with tempfile.TemporaryDirectory() as root:
            store=JobStore(Path(root),'instance',['model'])
            job=store.create('request-id','model','auto',4,'audio/wav')
            job.upload_deadline=time.time()-1
            store.prune_expired()
            self.assertIsNone(store.active_job())
            self.assertFalse((store.jobs_dir/job.id).exists())
            for i in range(12):
                job=store.create(f'request-id-{i}','model','auto',4,'audio/wav')
                store.store_result(job,{'text':'ok'})
            store.enforce_terminal_cache()
            self.assertEqual(len(store.jobs),10)
            job.finished_at=time.time()-RESULT_TTL_SECONDS-1
            store.prune_expired()
            self.assertNotIn(job.id,store.jobs)

    def test_cancel_wins_late_result_and_confirmed_tail_is_replaced(self):
        with tempfile.TemporaryDirectory() as root:
            store=JobStore(Path(root),'instance',['model'])
            job=store.create('request-id','model','auto',8,'audio/wav')
            store.append_chunk(job,0,b'abcd',hashlib.sha256(b'abcd').hexdigest())
            with (store.jobs_dir/job.id/'audio.bin').open('ab') as f:f.write(b'bad-unconfirmed')
            store.append_chunk(job,4,b'efgh',hashlib.sha256(b'efgh').hexdigest())
            self.assertEqual((store.jobs_dir/job.id/'audio.bin').read_bytes(),b'abcdefgh')
            store.commit(job)
            self.assertTrue(store.claim_schedule(job));self.assertFalse(store.claim_schedule(job))
            store.request_cancel(job)
            self.assertFalse(store.store_result(job,{'text':'late'}))
            self.assertEqual(job.state,'canceled')
            self.assertFalse((store.jobs_dir/job.id/'result.json').exists())


if __name__=='__main__':unittest.main()

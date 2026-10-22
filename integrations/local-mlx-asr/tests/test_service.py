"""HTTP protocol integration against isolated disk and fake compute (not model quality)."""
import asyncio
import hashlib
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from asgi_client import Client

_TEMP = tempfile.TemporaryDirectory(prefix='asr-http-tests-')
os.environ['ECHONOTES_ASR_ROOT'] = _TEMP.name
import service
from job_store import JobStore, CHUNK_BYTES, MAX_FILE_BYTES


class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.root = tempfile.TemporaryDirectory(prefix='asr-protocol-')
        self.store = JobStore(Path(self.root.name), 'test-instance', [service.MODEL_ID, service.DIAR_MODEL_ID])
        self.patch = patch.object(service, 'store', self.store)
        self.patch.start()
        service.state['status']='ready'
        self.client = Client(service.app)

    async def asyncTearDown(self):
        await self.client.aclose()
        self.patch.stop()
        self.root.cleanup()

    async def create(self, size=4, client='test-request-123'):
        return await self.client.post('/v1/local-asr/jobs',json={'client_request_id':client,'model':service.MODEL_ID,'language':'auto','total_bytes':size,'media_type':'audio/wav'})

    async def upload(self, job, data=b'test'):
        return await self.client.put(f'/v1/local-asr/jobs/{job}/audio',content=data,headers={'Content-Range':f'bytes 0-{len(data)-1}/{len(data)}','X-Chunk-SHA256':hashlib.sha256(data).hexdigest()})

    async def test_commit_once_and_control_requests_do_not_wait_for_compute(self):
        job=(await self.create()).json()['job_id']
        self.assertEqual((await self.upload(job)).status_code,200)
        started,release=threading.Event(),threading.Event()
        calls=[]
        def fake_run(j):
            calls.append(j.id);started.set();release.wait(5)
            self.store.transition(j,'canceled' if j.cancel_requested else 'succeeded')
        with patch.object(service.bounded,'run',fake_run):
            try:
                first=await self.client.post(f'/v1/local-asr/jobs/{job}/commit')
                self.assertEqual(first.status_code,202)
                await asyncio.to_thread(started.wait,1)
                before=time.monotonic()
                repeat=await self.client.post(f'/v1/local-asr/jobs/{job}/commit')
                busy=await self.create(client='different-123')
                status=await self.client.get(f'/v1/local-asr/jobs/{job}')
                cancel=await self.client.delete(f'/v1/local-asr/jobs/{job}')
                self.assertLess(time.monotonic()-before,1)
                self.assertEqual(repeat.status_code,202)
                self.assertEqual(busy.status_code,429)
                self.assertEqual(status.json()['received_bytes'],4)
                self.assertEqual(cancel.status_code,202)
                self.assertEqual(cancel.json()['state'],'canceling')
                self.assertEqual(len(calls),1)
            finally:
                release.set()
                await asyncio.to_thread(service.worker.submit(lambda: None).result,2)

    async def test_chunked_body_limit_without_content_length(self):
        response=await self.create(size=CHUNK_BYTES)
        job=response.json()['job_id']
        yielded=[]
        async def stream():
            for _ in range(10):
                yielded.append(1);yield b'x'*(1024*1024)
        response=await self.client.put(f'/v1/local-asr/jobs/{job}/audio',content=stream(),headers={'X-Offset':'0'})
        self.assertEqual(response.status_code,413)
        self.assertLessEqual(len(yielded),5)
        self.assertEqual(self.store.get(job).received_bytes,0)

    async def test_busy_multipart_does_not_read_body(self):
        await self.create()
        async def stream():
            self.fail('busy request must be rejected before reading body')
            yield b'never'
        response=await self.client.post('/v1/audio/transcriptions',content=stream(),headers={'Content-Type':'multipart/form-data; boundary=x'})
        self.assertEqual(response.status_code,429)

    async def test_streaming_multipart_larger_than_25mib_shares_job_worker(self):
        total=26*1024*1024+7
        expected=hashlib.sha256()
        chunk=b'public-test-audio'*4096
        for offset in range(0,total,len(chunk)):expected.update(chunk[:min(len(chunk),total-offset)])
        captured=[]
        def fake_run(job):
            source=self.store.jobs_dir/job.id/'audio.bin'
            with source.open('rb') as audio:
                captured.append((source.stat().st_size,hashlib.file_digest(audio,'sha256').hexdigest()))
            self.store.store_result(job,{'text':'fixture output'})
        async def stream():
            yield f'--BOUND\r\nContent-Disposition: form-data; name="model"\r\n\r\n{service.MODEL_ID}\r\n--BOUND\r\nContent-Disposition: form-data; name="file"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n'.encode()
            for offset in range(0,total,len(chunk)):yield chunk[:min(len(chunk),total-offset)]
            yield b'\r\n--BOUND--\r\n'
        with patch.object(service.bounded,'run',fake_run):
            response=await self.client.post('/v1/audio/transcriptions',content=stream(),headers={'Content-Type':'multipart/form-data; boundary=BOUND'})
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(captured,[(total,expected.hexdigest())])
        self.assertIsNone(self.store.active_job())
        self.assertEqual(response.json(),{'text':'fixture output'})

    async def test_result_retrieval_retains_until_explicit_delete(self):
        job=(await self.create()).json()['job_id']
        entry=self.store.get(job)
        self.store.store_result(entry,{'text':'kept until transcript saved'})
        for _ in range(2):
            self.assertEqual((await self.client.get(f'/v1/local-asr/jobs/{job}/result')).status_code,200)
        again=await self.create()
        self.assertEqual(again.json()['job_id'],job)
        self.assertEqual((await self.client.delete(f'/v1/local-asr/jobs/{job}')).status_code,204)
        self.assertEqual((await self.client.get(f'/v1/local-asr/jobs/{job}')).status_code,410)

    async def test_model_capabilities_and_enhancement_job_roundtrip(self):
        caps=(await self.client.get('/v1/local-asr/capabilities')).json()
        model_caps=caps.get('model_capabilities', {})
        self.assertIn(service.MODEL_ID, model_caps, 'Service must advertise model enhancement capabilities')
        self.assertEqual(model_caps[service.MODEL_ID]['enhancement']['transports'], ['jobs'])
        payload={'client_request_id':'enhanced-request','model':service.DIAR_MODEL_ID,'language':'zh','total_bytes':4,'media_type':'audio/wav',
                 'enhancement':{'version':1,'hotwords':['示例词'],'context_text':'会议背景'}}
        response=await self.client.post('/v1/local-asr/jobs',json=payload)
        self.assertEqual(response.status_code,201,response.text)
        job=self.store.get(response.json()['job_id'])
        self.assertEqual(job.enhancement['hotwords'],['示例词'])
        payload['enhancement']['hotwords']=['different']
        self.assertEqual((await self.client.post('/v1/local-asr/jobs',json=payload)).status_code,409)

    async def test_invalid_enhancement_is_rejected_before_upload(self):
        payload={'client_request_id':'invalid-enhancement','model':service.MODEL_ID,'language':'zh','total_bytes':4,'media_type':'audio/wav',
                 'enhancement':{'version':1,'context_text':'x'*401}}
        response=await self.client.post('/v1/local-asr/jobs',json=payload)
        self.assertEqual(response.status_code,422)
        self.assertIsNone(self.store.active_job())

    async def test_engine_uses_native_prompt_and_preserves_disabled_kwargs(self):
        from types import SimpleNamespace as NS
        captured=[]
        engine=service.Engine()
        engine.model=NS(generate=lambda audio, **kwargs: (captured.append(kwargs) or NS(text='fixture',generation_tokens=1)))
        engine.generate_text([1],'Chinese')
        self.assertNotIn('hotwords',captured[-1])
        self.assertNotIn('system_prompt',captured[-1])
        self.assertIn('enhancement', __import__('inspect').signature(engine.generate_text).parameters,
                      'Engine must accept the frozen enhancement snapshot')
        engine.generate_text([1],'Chinese',{'version':1,'hotwords':['术语'],'context_text':'人工背景'})
        self.assertEqual(captured[-1]['hotwords'],['术语'])
        self.assertEqual(captured[-1]['system_prompt'],'人工背景')

    async def test_host_and_origin_guards(self):
        self.assertEqual((await self.client.get('/health',headers={'Host':'evil.example'})).status_code,403)
        self.assertEqual((await self.client.get('/health',headers={'Origin':'https://evil.example'})).status_code,403)


if __name__=='__main__':unittest.main()

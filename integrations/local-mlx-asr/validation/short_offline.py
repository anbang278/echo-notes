"""Low-load public 8.4s format/tail checks; all outbound networking denied."""
import argparse
import fcntl
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--fixture',type=Path,required=True)
    parser.add_argument('--runtime',type=Path,required=True)
    args=parser.parse_args()
    fixture=json.loads(args.fixture.read_text())
    source=Path(fixture['path'])
    output=args.runtime/'validation/short-offline'
    output.mkdir(parents=True,exist_ok=True)
    samples=[]
    for extension,codec in [('wav','pcm_s16le'),('mp3','libmp3lame'),('m4a','aac'),('webm','libopus')]:
        path=output/f'public-8.4s.{extension}'
        subprocess.run(['/opt/homebrew/bin/ffmpeg','-nostdin','-v','error','-ss','7','-i',str(source),'-t','8.4','-map','0:a:0','-ac','1','-ar','16000','-c:a',codec,'-y',str(path)],check=True)
        samples.append((extension,path,8.4))
    tail=output/'public-tail-0.4s.wav'
    subprocess.run(['/opt/homebrew/bin/ffmpeg','-nostdin','-v','error','-ss','15.69','-i',str(source),'-t','0.4','-map','0:a:0','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',str(tail)],check=True)
    samples.append(('short-tail',tail,.4))
    attempts=[]
    def denied(*_args,**_kwargs):
        attempts.append('blocked-outbound-call')
        raise AssertionError('Networking is forbidden in this validation')
    socket.socket.connect=denied
    socket.socket.connect_ex=denied
    socket.getaddrinfo=denied
    os.environ['ECHONOTES_ASR_ROOT']=str(args.runtime)
    from service import Engine, MODEL_ID, DIAR_MODEL_ID
    from bounded_worker import Worker
    from job_store import JobStore
    with (Path.home()/'.local/share/echo-notes/mlx-inference.lock').open('a+') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        engine=Engine();engine.load()
        store=JobStore(output/'jobs','short-offline',[MODEL_ID,DIAR_MODEL_ID]);worker=Worker(engine,store)
        records=[]
        for label,path,duration in samples:
            # Each encoded fixture is under 1 MiB; this is not the transport test.
            data=path.read_bytes();assert len(data)<1024*1024
            for mode,model in [('plain',MODEL_ID),('diarized',DIAR_MODEL_ID)]:
                started=time.monotonic()
                job=store.create(uuid.uuid4().hex,model,'zh',len(data),'audio/'+path.suffix[1:])
                store.append_chunk(job,0,data,hashlib.sha256(data).hexdigest())
                store.commit(job);worker.run(job)
                result=store.load_result(job)
                assert job.state=='succeeded'
                assert abs(result['duration']-duration)<.2
                assert all(0<=s['start']<=s['end']<=result['duration']+.001 for s in result['segments'])
                if duration>1:assert result['text'].strip()
                (output/f'{label}-{mode}.result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2))
                record={'case':label,'mode':mode,'status':'PASS','source_sha256':hashlib.sha256(data).hexdigest(),'duration':result['duration'],'text_characters':len(result['text']),'elapsed_seconds':round(time.monotonic()-started,3),'metrics':engine.last_request}
                records.append(record)
                (output/'results.json').write_text(json.dumps({'status':'running','checks':records,'outbound_attempts':attempts},indent=2))
                print(json.dumps(record),flush=True)
                store.discard(job.id)
        assert not attempts
        (output/'results.json').write_text(json.dumps({'status':'PASS','validation':'real ffmpeg + pinned models; four formats and 0.4s tail; outbound sockets/DNS blocked; no long stress','source_public_url':fixture['source'],'source_license':fixture['license'],'source_offsets_seconds':{'formats':7,'tail':15.69},'checks':records,'outbound_attempts':attempts},indent=2))


if __name__=='__main__':main()

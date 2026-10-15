"""Four real HTTP jobs on approved public natural/stress audio; no mocks."""
import argparse
import hashlib
import json
import os
import subprocess
import time
import urllib.request
import uuid
from pathlib import Path


def request(base, path, method='GET', body=None, headers=None):
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers = dict(headers or {}, **{'Content-Type':'application/json'})
    req = urllib.request.Request(base+path, data=body, method=method, headers=headers or {})
    with urllib.request.urlopen(req,timeout=30) as response:
        return json.load(response) if response.status != 204 else None


def main():
    args=argparse.ArgumentParser()
    args.add_argument('--fixture',required=True)
    args.add_argument('--runtime',type=Path,required=True)
    args.add_argument('--port',type=int,default=18081)
    opts=args.parse_args()
    base=f'http://127.0.0.1:{opts.port}'
    output=opts.runtime/'validation'
    output.mkdir(exist_ok=True)
    fixture=json.loads(Path(opts.fixture).read_text())
    source=Path(fixture['path'])
    assert hashlib.file_digest(source.open('rb'),'sha256').hexdigest()==fixture['sha256']
    stress=output/'public-stress-120min.wav'
    if not stress.exists():
        subprocess.run(['/opt/homebrew/bin/ffmpeg','-nostdin','-v','error','-stream_loop','-1','-i',str(source),
                        '-map','0:a:0','-ac','1','-ar','16000','-t','7200','-c:a','pcm_s16le','-y',str(stress)],check=True)
    manifest={'kind':'constructed public speech pressure fixture, not a natural 120-minute meeting',
              'source_sha256':fixture['sha256'],'source_url':fixture['source'],'license':fixture['license'],
              'construction':'ffmpeg stream_loop -1, default downmix to mono, 16kHz s16, 7200 seconds',
              'reference_windows':[{'output_start': t,'source_start':round(t%fixture['duration_seconds'],3),'duration':.4 if t==7199.6 else 20} for t in (0,3590,7180,7199.6)],
              'bytes':stress.stat().st_size,'sha256':hashlib.file_digest(stress.open('rb'),'sha256').hexdigest()}
    (output/'stress-manifest.json').write_text(json.dumps(manifest,indent=2))
    pid=json.loads((opts.runtime/'service.pid').read_text())['pid']
    results=[]
    for name,path in [('natural-26min',source),('constructed-120min',stress)]:
      for mode,model in [('plain','mlx-community/Qwen3-ASR-0.6B-8bit'),('diarized','local/qwen3-asr-0.6b-sortformer-4spk')]:
        label=f'{name}-{mode}'
        existing=output/f'{label}.json'
        if existing.exists() and json.loads(existing.read_text()).get('status')=='PASS':
            results.append(json.loads(existing.read_text()));continue
        started=time.monotonic()
        digest=hashlib.file_digest(path.open('rb'),'sha256').hexdigest()
        job=request(base,'/v1/local-asr/jobs','POST',{'client_request_id':uuid.uuid4().hex,'model':model,'language':'zh','total_bytes':path.stat().st_size,'media_type':'audio/wav'})
        job_id=job['job_id']
        print(f'{label}: uploading {path.stat().st_size} bytes job={job_id}',flush=True)
        offset=0
        with path.open('rb') as audio:
            while chunk:=audio.read(4*1024*1024):
                ack=request(base,f'/v1/local-asr/jobs/{job_id}/audio','PUT',chunk,{'Content-Range':f'bytes {offset}-{offset+len(chunk)-1}/{path.stat().st_size}','X-Chunk-SHA256':hashlib.sha256(chunk).hexdigest()})
                offset+=len(chunk)
                assert ack['next_offset']==offset
        request(base,f'/v1/local-asr/jobs/{job_id}/commit','POST')
        peak_rss=peak_disk=0
        phases={}
        sample_file=output/f'{label}.resources.jsonl'
        last_phase=None
        with sample_file.open('w') as samples:
            while True:
                status=request(base,f'/v1/local-asr/jobs/{job_id}')
                phase=status['stage']
                now=time.monotonic()
                phases.setdefault(phase,{'first_seconds':round(now-started,3),'last_seconds':0})['last_seconds']=round(now-started,3)
                if phase!=last_phase:
                    print(f'{label}: {phase} at {now-started:.1f}s',flush=True);last_phase=phase
                rss=int(subprocess.check_output(['ps','-p',str(pid),'-o','rss='],text=True).strip())*1024
                disk=sum(p.stat().st_size for p in (opts.runtime/'jobs'/job_id).iterdir() if p.is_file())
                peak_rss=max(peak_rss,rss);peak_disk=max(peak_disk,disk)
                sample={'elapsed':round(now-started,3),'stage':phase,'rss':rss,'temporary_disk_bytes':disk,'processed_seconds':status.get('processed_seconds')}
                if int(now-started)%30==0:
                    sample['memory_pressure']=subprocess.check_output(['/usr/bin/memory_pressure','-Q'],text=True).strip()
                samples.write(json.dumps(sample)+'\n');samples.flush()
                if status['state'] in {'succeeded','failed','canceled'}:break
                time.sleep(1)
        if status['state']!='succeeded':
            existing.write_text(json.dumps({'status':'FAIL','job':status},indent=2));raise RuntimeError(status)
        result=request(base,f'/v1/local-asr/jobs/{job_id}/result')
        (output/f'{label}.result.json').write_text(json.dumps(result,ensure_ascii=False))
        metrics=json.loads((opts.runtime/'jobs'/job_id/'metrics.json').read_text())
        duration=result['duration']
        assert abs(duration-(fixture['duration_seconds'] if name.startswith('natural') else 7200))<.01
        segments=result['segments']
        assert all(0<=s['start']<=s['end']<=duration+.001 for s in segments)
        thirds=[sum(len(s['text']) for s in segments if duration*i/3 <= s['start'] < duration*(i+1)/3) for i in range(3)]
        assert all(n>0 for n in thirds)
        passed=peak_rss<=4*1024**3 and metrics['mlx_peak_bytes']<=8*1024**3
        record={'id':label,'status':'PASS' if passed else 'FAIL','input_sha256':digest,'input_bytes':path.stat().st_size,
                'duration_seconds':duration,'received_bytes':offset,'elapsed_seconds':time.monotonic()-started,'metrics':metrics,
                'sampled_peak_rss_bytes':peak_rss,'peak_temporary_disk_bytes':peak_disk,'phases':phases,
                'segments':len(segments),'text_characters_by_third':thirds,'tail_end_seconds':segments[-1]['end'],
                'validation':'actual HTTP job upload and three pinned models, structural/time/first-middle-last text coverage; human word accuracy is separate'}
        existing.write_text(json.dumps(record,indent=2))
        results.append(record)
        print(json.dumps(record),flush=True)
        request(base,f'/v1/local-asr/jobs/{job_id}','DELETE')
        if not passed:raise RuntimeError('Resource gate failed')
    for mode in ('plain','diarized'):
        subset=[r for r in results if r['id'].endswith(mode)]
        short,long=subset
        assert long['sampled_peak_rss_bytes']-short['sampled_peak_rss_bytes'] <= 1024**3
        assert long['metrics']['mlx_peak_bytes']-short['metrics']['mlx_peak_bytes'] <= 1024**3
    (output/'summary.json').write_text(json.dumps({'status':'PASS','runs':results},indent=2))


if __name__=='__main__':main()

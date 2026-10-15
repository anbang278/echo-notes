"""Real standard multipart formats, short tail and active-job cancellation."""
import argparse
import hashlib
import http.client
import json
import subprocess
import time
import uuid
from pathlib import Path
from long_audio import request


def multipart(port,path,model):
    boundary='ASR-'+uuid.uuid4().hex
    before=(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n{model}\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nzh\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\n'
            'Content-Type: application/octet-stream\r\n\r\n').encode()
    after=f'\r\n--{boundary}--\r\n'.encode()
    conn=http.client.HTTPConnection('127.0.0.1',port,timeout=300)
    conn.putrequest('POST','/v1/audio/transcriptions')
    conn.putheader('Content-Type',f'multipart/form-data; boundary={boundary}')
    conn.putheader('Content-Length',str(len(before)+path.stat().st_size+len(after)))
    conn.endheaders();conn.send(before)
    with path.open('rb') as audio:
        while chunk:=audio.read(65536):conn.send(chunk)
    conn.send(after)
    response=conn.getresponse()
    result=json.load(response)
    conn.close()
    if response.status!=200:raise RuntimeError(result)
    return result


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--runtime',type=Path,required=True)
    parser.add_argument('--port',type=int,default=18081)
    args=parser.parse_args()
    output=args.runtime/'validation/formats'
    output.mkdir(exist_ok=True)
    results=[]
    for extension,codec in [('wav','pcm_s16le'),('mp3','libmp3lame'),('m4a','aac'),('webm','libopus')]:
        path=output/f'public-8.4s.{extension}'
        subprocess.run(['/opt/homebrew/bin/ffmpeg','-nostdin','-v','error','-i',str(args.source),'-t','8.4','-map','0:a:0','-ac','1','-ar','16000','-c:a',codec,'-y',str(path)],check=True)
        for mode,model in [('plain','mlx-community/Qwen3-ASR-0.6B-8bit'),('diarized','local/qwen3-asr-0.6b-sortformer-4spk')]:
            start=time.monotonic();result=multipart(args.port,path,model)
            assert result['text'].strip()
            assert abs(result['duration']-8.4)<.2  # lossy container padding is included in real sample count
            assert all(0<=s['start']<=s['end']<=result['duration']+.001 for s in result['segments'])
            with path.open('rb') as audio:digest=hashlib.file_digest(audio,'sha256').hexdigest()
            record={'format':extension,'mode':mode,'status':'PASS','sha256':digest,'duration':result['duration'],'elapsed_seconds':time.monotonic()-start,'text_characters':len(result['text'])}
            results.append(record)
            print(json.dumps(record),flush=True)
    tail=output/'public-tail-0.4s.wav'
    subprocess.run(['/opt/homebrew/bin/ffmpeg','-nostdin','-v','error','-ss','15.69','-i',str(args.source),'-t','0.4','-map','0:a:0','-ac','1','-ar','16000','-c:a','pcm_s16le','-y',str(tail)],check=True)
    for model in ['mlx-community/Qwen3-ASR-0.6B-8bit','local/qwen3-asr-0.6b-sortformer-4spk']:
        result=multipart(args.port,tail,model)
        assert result['duration']==.4
        assert all(0<=s['start']<=s['end']<=.4 for s in result['segments'])
        results.append({'case':'0.4-second real public utterance','model':model,'status':'PASS','segments':len(result['segments'])})
    base=f'http://127.0.0.1:{args.port}'
    cancel_results=[]
    for desired_stage in ['uploading','decoding','diarizing','transcribing','aligning']:
        # Full public meeting makes every real stage observable. Cancel before
        # any result is accepted; the source is never modified.
        job=request(base,'/v1/local-asr/jobs','POST',{'client_request_id':uuid.uuid4().hex,
                    'model':'local/qwen3-asr-0.6b-sortformer-4spk','language':'zh',
                    'total_bytes':args.source.stat().st_size,'media_type':'audio/wav'})
        jid=job['job_id']
        if desired_stage!='uploading':
            offset=0
            with args.source.open('rb') as audio:
                while chunk:=audio.read(4*1024*1024):
                    request(base,f'/v1/local-asr/jobs/{jid}/audio','PUT',chunk,
                            {'Content-Range':f'bytes {offset}-{offset+len(chunk)-1}/{args.source.stat().st_size}',
                             'X-Chunk-SHA256':hashlib.sha256(chunk).hexdigest()})
                    offset+=len(chunk)
            request(base,f'/v1/local-asr/jobs/{jid}/commit','POST')
        before=time.monotonic()
        while True:
            status=request(base,f'/v1/local-asr/jobs/{jid}')
            if status['stage']==desired_stage:break
            assert status['state'] not in {'succeeded','failed','canceled'},status
            if time.monotonic()-before>180:raise RuntimeError('Expected phase was not observed')
            time.sleep(.02)
        start=time.monotonic()
        request(base,f'/v1/local-asr/jobs/{jid}','DELETE')
        ack=time.monotonic()-start
        while True:
            status=request(base,f'/v1/local-asr/jobs/{jid}')
            if status['state']=='canceled':break
            assert status['state']!='succeeded'
            if time.monotonic()-start>60:raise RuntimeError('Cancel did not finish within 60 seconds')
            time.sleep(.05)
        assert not (args.runtime/'jobs'/jid/'result.json').exists()
        assert not (args.runtime/'jobs'/jid/'audio.bin').exists()
        cancel_results.append({'stage':desired_stage,'status':'PASS','ack_seconds':ack,'terminal_seconds':time.monotonic()-start})
        print(json.dumps(cancel_results[-1]),flush=True)
    (output/'results.json').write_text(json.dumps({'status':'PASS','checks':results,'real_cancellation':cancel_results},indent=2))
    print('formats and real short tail PASS',flush=True)


if __name__=='__main__':main()

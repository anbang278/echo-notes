"""Real transport counting at 1 GiB and 1 GiB+1, no long model inference."""
import argparse
import hashlib
import http.client
import json
import time
import uuid
from pathlib import Path
from long_audio import request


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--runtime',type=Path,required=True);parser.add_argument('--port',type=int,default=18081);args=parser.parse_args()
    base=f'http://127.0.0.1:{args.port}'
    total=1024**3;chunk=b'\0'*(4*1024**2)
    digest=hashlib.sha256(chunk).hexdigest()
    job=request(base,'/v1/local-asr/jobs','POST',{'client_request_id':uuid.uuid4().hex,'model':'mlx-community/Qwen3-ASR-0.6B-8bit','language':'auto','total_bytes':total,'media_type':'audio/wav'})
    jid=job['job_id'];started=time.monotonic()
    for offset in range(0,total,len(chunk)):
        ack=request(base,f'/v1/local-asr/jobs/{jid}/audio','PUT',chunk,{'Content-Range':f'bytes {offset}-{offset+len(chunk)-1}/{total}','X-Chunk-SHA256':digest})
        assert ack['next_offset']==offset+len(chunk)
    committed=request(base,f'/v1/local-asr/jobs/{jid}/commit','POST')
    assert committed['state'] in {'queued','running'}
    request(base,f'/v1/local-asr/jobs/{jid}','DELETE')
    while True:
        status=request(base,f'/v1/local-asr/jobs/{jid}')
        if status['state'] in {'canceled','failed'}:break
        time.sleep(.05)
    first={'status':'PASS','case':'1 GiB real streamed bytes acknowledged and commit accepted','bytes':total,'elapsed_seconds':time.monotonic()-started,'terminal':status['state'],'synthetic_content':'zeros; no transcription quality claim'}
    request(base,f'/v1/local-asr/jobs/{jid}','DELETE')
    boundary='BOUNDARY'
    before=(f'--{boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nmlx-community/Qwen3-ASR-0.6B-8bit\r\n'
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="boundary.wav"\r\n\r\n').encode()
    after=f'\r\n--{boundary}--\r\n'.encode()
    conn=http.client.HTTPConnection('127.0.0.1',args.port,timeout=300)
    conn.putrequest('POST','/v1/audio/transcriptions')
    conn.putheader('Content-Type',f'multipart/form-data; boundary={boundary}')
    conn.putheader('Content-Length',str(len(before)+total+1+len(after)))
    conn.endheaders();conn.send(before)
    for _ in range(total//len(chunk)):conn.send(chunk)
    conn.send(b'\0');conn.send(after)
    response=conn.getresponse();body=json.load(response);conn.close()
    assert response.status==413 and body['error']['code']=='file_too_large',body
    second={'status':'PASS','case':'1 GiB+1 actual multipart audio bytes rejected','bytes':total+1,'http_status':response.status,'code':body['error']['code']}
    assert not request(base,'/health')['busy']
    output=args.runtime/'validation/upload-boundaries.json'
    output.write_text(json.dumps({'status':'PASS','kind':'actual HTTP byte counting with synthetic data; not a model test','checks':[first,second]},indent=2))
    print(first,second,flush=True)


if __name__=='__main__':main()

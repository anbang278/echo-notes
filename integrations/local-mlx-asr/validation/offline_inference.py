"""Load and run all pinned models with outbound/DNS sockets forcibly blocked."""
import fcntl
import json
import os
import socket
import sys
import tempfile
import threading
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

attempts=[]
def denied(*args,**kwargs):
    attempts.append('blocked-outbound-call')
    raise AssertionError('Network is forbidden during model validation')
socket.socket.connect=denied
socket.socket.connect_ex=denied
socket.getaddrinfo=denied
from service import Engine, MODEL_ID, DIAR_MODEL_ID
from job_store import JobStore
from bounded_worker import Worker
import hashlib

with (Path.home()/'.local/share/echo-notes/mlx-inference.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 with tempfile.TemporaryDirectory(prefix='asr-offline-validation-') as temp:
  root=Path(temp)
  engine=Engine();engine.load()
  store=JobStore(root,'offline-test',[MODEL_ID,DIAR_MODEL_ID]);worker=Worker(engine,store)
  source=Path(sys.argv[1]);data=source.read_bytes()  # explicitly limited public 8.4s fixture
  assert len(data)<1024*1024
  records=[]
  for model in [MODEL_ID,DIAR_MODEL_ID]:
   job=store.create(model.replace('/','-'),model,'zh',len(data),'audio/wav')
   store.append_chunk(job,0,data,hashlib.sha256(data).hexdigest());store.commit(job);worker.run(job)
   records.append({'model':model,'state':job.state,'text_characters':len(store.load_result(job)['text'])})
  assert not attempts
  Path(sys.argv[2]).write_text(json.dumps({'status':'PASS','network_calls':attempts,'runs':records},indent=2))
  print('all pinned models ran with networking blocked',flush=True)

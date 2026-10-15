"""Reproduce a public-fixture window failure with exact source boundaries."""
import fcntl,json,os,sys,tempfile,traceback
from pathlib import Path
import numpy as np
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bounded_audio as ba
from service import Engine
from diarization import align_text_to_speakers,build_turns

fixture=json.loads(Path(sys.argv[1]).read_text())
with (Path.home()/'.local/share/echo-notes/mlx-inference.lock').open('a+') as lock:
 fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
 engine=Engine();engine.load();engine.load_aligner()
 with tempfile.TemporaryDirectory() as tmp:
  decoded=ba.decode_to_disk(Path(fixture['path']),Path(tmp),max_duration_seconds=8*3600)
  audio=ba.open_memmap(decoded.path,decoded.samples)
  start,end=list(ba.plan_chunks(audio,16000,chunk_seconds=25.0))[35]
  from bounded_worker import Worker
  from types import SimpleNamespace as NS
  worker=Worker(engine, NS(get=lambda *a: None, update_progress=lambda *a,**kw:None))
  worker.cancel_check=lambda *a:None
  job=NS(language='zh',id='public-window36')
  turns=build_turns([],len(audio),16000)[0]
  captures=[]
  original_generate=engine.aligner.generate
  def capture(chunk, text, **kwargs):
   result=original_generate(chunk,text=text,**kwargs)
   captures.append({'samples':len(chunk),'text':text,'items':[vars(i) for i in result.items]})
   Path(sys.argv[2]+'.calls.json').write_text(json.dumps(captures,ensure_ascii=False))
   return result
  engine.aligner.generate=capture

  assigned,texts,warnings=worker._diarize_window(job,audio,start,end,16000,turns)
  report={'start':start/16000,'end':end/16000,'segments':assigned,'texts':texts,'warnings':list(warnings),'status':'PASS'}
  Path(sys.argv[2]).write_text(json.dumps(report,ensure_ascii=False,indent=2))
  print({'status':'PASS','segments':len(assigned),'text_characters':sum(map(len,texts))},flush=True)
  audio._mmap.close()

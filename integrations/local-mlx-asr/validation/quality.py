"""Real-model DER gate over the three approved public fixtures (no network)."""
import argparse
import fcntl
import hashlib
import itertools
import json
import os
import sys
import tempfile
import time
from pathlib import Path

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bounded_audio as ba
import bounded_diarization as bd
from service import Engine


def score(reference, predicted, duration):
    times = np.arange(.01, duration, .02)
    def matrix(segments):
        speakers = sorted(set(s['speaker'] for s in segments))
        data = np.zeros((len(speakers), len(times)), dtype=bool)
        for s in segments:
            data[speakers.index(s['speaker'])] |= (times >= s['start']) & (times < s['end'])
        return data
    ref, hyp = matrix(reference), matrix(predicted)
    n = max(len(ref), len(hyp))
    ref = np.pad(ref, ((0, n-len(ref)), (0, 0)))
    hyp = np.pad(hyp, ((0, n-len(hyp)), (0, 0)))
    counts_r, counts_h = ref.sum(axis=0), hyp.sum(axis=0)
    miss = np.maximum(counts_r-counts_h, 0).sum()
    false = np.maximum(counts_h-counts_r, 0).sum()
    matched = max((ref & hyp[list(p)]).sum() for p in itertools.permutations(range(n)))
    confusion = np.minimum(counts_r, counts_h).sum() - matched
    denominator = counts_r.sum()
    return {'der': float((miss+false+confusion)/denominator), 'miss': float(miss/denominator),
            'false_alarm': float(false/denominator), 'confusion': float(confusion/denominator),
            'method': '20ms midpoint grid; zero collar; includes overlap; optimal recording-level speaker permutation'}


def main():
    args = argparse.ArgumentParser()
    args.add_argument('--dataset', required=True)
    args.add_argument('--output', required=True)
    opts = args.parse_args()
    root = Path(opts.dataset)
    dataset = json.loads((root/'dataset.json').read_text())['cases']
    cases = {c['id']: c for c in dataset}
    baseline = {'ali-meeting-01': .1805, 'ali-long-01': .2530, 'ali-meeting-02': .1778}
    lock = Path.home()/'.local/share/echo-notes/mlx-inference.lock'
    lock.parent.mkdir(parents=True, exist_ok=True)
    with lock.open('a+') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX|fcntl.LOCK_NB)
        engine = Engine()
        engine.load_diarizer()
        results = []
        for name, old in baseline.items():
            case = cases[name]
            path = root/case['audio']
            digest = hashlib.file_digest(path.open('rb'), 'sha256').hexdigest()
            assert digest == case['sha256']
            started = time.monotonic()
            with tempfile.TemporaryDirectory(prefix='asr-public-der-') as work:
                decoded = ba.decode_to_disk(path, Path(work), max_duration_seconds=8*3600)
                audio = ba.open_memmap(decoded.path, decoded.samples)
                try:
                    raw = bd.diarize_stream(engine.diarizer, audio, 16000, lambda: None)
                finally:
                    audio._mmap.close()
            predicted = [dict(start=s.start,end=s.end,speaker=str(s.speaker)) for s in raw]
            metrics = score(case['reference_segments'], predicted, decoded.duration_seconds)
            entry = dict(id=name, sha256=digest, baseline_der=old, quality=metrics,
                         elapsed_seconds=time.monotonic()-started, predictions=predicted,
                         status='PASS' if metrics['der'] <= old+.03 else 'FAIL')
            results.append(entry)
            Path(opts.output).write_text(json.dumps(results,ensure_ascii=False,indent=2))
            print(json.dumps({k:v for k,v in entry.items() if k!='predictions'}), flush=True)
        if any(r['status']!='PASS' for r in results):
            raise SystemExit(1)


if __name__ == '__main__': main()

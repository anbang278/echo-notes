"""Explicit, local-only meeting evaluation. Model references are not ground truth."""
from __future__ import annotations

import argparse
import bisect
import difflib
import fcntl
import hashlib
import inspect
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import unicodedata
from pathlib import Path

NORMALIZATION_VERSION = 1


def parse_reference(source):
    segments, current, lines = [], None, []
    def finish():
        if current is not None:
            current['text'] = '\n'.join(lines).strip()
            if not current['text']:
                raise ValueError('Reference segment has no text')
            segments.append(dict(current))
    for line in source.splitlines():
        match = re.fullmatch(r'发言人(\d+)\s+(\d+):(\d{2})\s*', line)
        if match:
            finish()
            speaker, minutes, seconds = match.groups()
            start = int(minutes)*60+int(seconds)
            if int(seconds) >= 60 or (segments and start < segments[-1]['start']):
                raise ValueError('Reference times are invalid or go backwards')
            current = {'speaker_label': speaker, 'start': start, 'end': None}
            lines = []
        elif current is not None:
            lines.append(line)
    finish()
    if not segments:
        raise ValueError('No supported reference segments')
    return segments


def normalize_text(value):
    return ''.join(c.lower() for c in value if not c.isspace() and not unicodedata.category(c).startswith('P'))


def character_distance(reference, predicted):
    """Exact Levenshtein distance using Myers bit vectors, not difflib's heuristic."""
    if not reference:
        return len(predicted)
    if len(reference) > len(predicted):
        reference, predicted = predicted, reference
    if not reference:
        return len(predicted)
    masks = {}
    for index, char in enumerate(reference):
        masks[char] = masks.get(char, 0) | (1 << index)
    positive, negative, score, last = ~0, 0, len(reference), 1 << (len(reference)-1)
    for char in predicted:
        equal = masks.get(char, 0)
        vertical = equal | negative
        horizontal = (((equal & positive) + positive) ^ positive) | equal
        plus = negative | ~(horizontal | positive)
        minus = positive & horizontal
        score += bool(plus & last) - bool(minus & last)
        plus = (plus << 1) | 1
        minus <<= 1
        positive = minus | ~(vertical | plus)
        negative = plus & vertical
    return score


def score_reference(segments, prediction, approved_terms=()):
    normalized_parts = [normalize_text(s['text']) for s in segments]
    reference, hypothesis = ''.join(normalized_parts), normalize_text(prediction)
    boundaries, position = [], 0
    for part in normalized_parts:
        boundaries.append(position)
        position += len(part)
    edits = character_distance(reference, hypothesis)
    terms = [{"text": word, "reference_count": reference.count(normalize_text(word)), "predicted_count": hypothesis.count(normalize_text(word))} for word in approved_terms]
    approved_ranges = [(m.start(), m.end()) for word in approved_terms if normalize_text(word)
                       for m in re.finditer(re.escape(normalize_text(word)), hypothesis)]
    differences = []
    matcher = difflib.SequenceMatcher(None, reference, hypothesis, autojunk=False)
    for kind, a, b, x, y in matcher.get_opcodes():
        if kind == 'equal':
            continue
        segment = segments[max(0, bisect.bisect_right(boundaries, a)-1)]
        before, after = reference[a:b], hypothesis[x:y]
        flags = []
        if any(left < y and right > x for left, right in approved_ranges):
            flags.append("approved_spelling")
        if any(c.isdigit() for c in before+after):
            flags.append('number')
        if any(c in '不没无未非别否' for c in before+after):
            flags.append('negation')
        if kind == 'delete' and len(before) >= 8:
            flags.append('possible_omission')
        differences.append({'kind': kind, 'reference': before, 'predicted': after,
                            'reference_offset': a, 'predicted_offset': x,
                            'listen_start': segment['start'], 'reference_speaker': segment['speaker_label'],
                            'flags': flags})
    return {'reference_kind': 'model_generated_silver_reference', 'normalization_version': NORMALIZATION_VERSION,
            'reference_characters': len(reference), 'character_edits': edits,
            'character_difference_rate': edits/len(reference) if reference else None,
            'approved_terms': terms, 'approved_terms_are_authoritative': bool(approved_terms),
            'term_count_note': 'Occurrence counts are not acoustic precision or recall; approved spellings override model-reference spelling',
            'der': None, 'der_reason': 'Reference has no verified speaker activity or end times',
            'differences': differences}


def file_hash(path):
    with Path(path).open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def load_inputs(path):
    manifest = json.loads(Path(path).read_text())
    for role in ('audio', 'model_reference'):
        entry = manifest[role]
        if file_hash(entry['path']) != entry['sha256']:
            raise ValueError('Input identity differs from the approved manifest')
    return manifest


def load_candidate_manifest(path):
    manifest = json.loads(Path(path).read_text())
    if not re.fullmatch(r"[0-9a-f]{40}", manifest.get("revision", "")):
        raise ValueError("Candidate revision must be immutable")
    root = Path(manifest['path']).resolve()
    if not manifest.get('files') or manifest.get('backend') not in {'mlx-audio','mlx-audio-plus'}:
        raise ValueError("Unsupported candidate manifest")
    for relative, digest in manifest['files'].items():
        file = root/relative
        if file.is_symlink() or not file.resolve().is_relative_to(root) or file_hash(file) != digest:
            raise ValueError("Candidate file identity differs")
    return manifest


def candidate_engine(service, manifest):
    from types import SimpleNamespace
    engine = service.Engine()
    def load():
        if manifest['backend'] == 'mlx-audio-plus':
            from mlx_audio.stt.models.funasr import Model
            engine.model = Model.from_pretrained(manifest['path'])
        else:
            from mlx_audio.stt.utils import load_model
            engine.model = load_model(manifest['path'], strict=True)
    def generate(chunk, language, enhancement=None):
        if enhancement is not None:
            raise ValueError('Candidate prompt behavior is not approved or verified')
        input_language = {'Chinese': 'zh', 'English': 'en', None: 'auto'}.get(language, language)
        result = engine.model.generate(chunk, language=input_language, max_tokens=service.TOKEN_BUDGET,
                                       temperature=0.0, stream=False, verbose=False)
        text = result.text if hasattr(result, 'text') else result.get('text')
        tokens = getattr(result, 'generation_tokens', None)
        if tokens is None:
            tokens = len(getattr(result, 'tokens', None) or [])
        if not isinstance(text, str):
            raise ValueError('Candidate did not return plain transcription text')
        if isinstance(tokens, int) and tokens >= service.TOKEN_BUDGET:
            raise service.TranscriptionFailure('token_budget_exhausted', 'A segment reached its output limit')
        return SimpleNamespace(text=text, language=getattr(result, 'language', input_language), generation_tokens=tokens)
    engine.load, engine.generate_text = load, generate
    return engine


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    path.chmod(0o600)


def write_report(directory, result):
    lines = ['# Local meeting comparison', '', 'Reference: model-generated, not human ground truth.',
             'DER: N/A. Times are reference start anchors, not verified word timestamps.', '',
             f"Character difference rate: {result['character_difference_rate']}",
             'User-approved spellings are authoritative; corrections to model-reference spellings are not regressions.', '',
             '| Listen | Flags | Reference excerpt | Predicted excerpt |', '| --- | --- | --- | --- |']
    def excerpt(value):
        return value[:160].replace('|', '\\|').replace('\n', ' ')
    for d in result['differences']:
        seconds = d['listen_start']
        lines.append(f"| {seconds//60:02}:{seconds%60:02} | {', '.join(d['flags'])} | {excerpt(d['reference'])} | {excerpt(d['predicted'])} |")
    (directory/'diff.md').write_text('\n'.join(lines)+'\n')


def write_review_materials(directory, reference, payload):
    """Full texts and start-anchor speaker juxtaposition, without invented ends or DER."""
    prediction = payload.get('transcript', payload.get('text', ''))
    lines = ['# 全文对照', '', '参考稿为未校准的模型输出，用户批准的术语拼写优先。',
             '以下保留双方全文；参考稿只提供起始时间，未推断结束时间。', '', '## 模型参考稿', '']
    anchors = []
    for segment in reference:
        start = segment['start']
        lines.extend([f"### {start//60:02}:{start%60:02} · 参考发言人 {segment['speaker_label']}", '', segment['text'], ''])
        nearby = [{key: item.get(key) for key in ('start', 'end', 'speaker', 'speakers', 'overlap', 'text')}
                  for item in payload.get('segments', []) if item.get('start', float('inf')) <= start+2
                  and item.get('end', -1) >= max(0, start-2)]
        anchors.append({'reference_start': start, 'reference_end': None, 'reference_speaker': segment['speaker_label'],
                        'reference_text': segment['text'], 'predicted_near_anchor': nearby,
                        'human_review': 'pending'})
    lines.extend(['## 本地输出全文', '', prediction, ''])
    full = directory/'full-comparison.md'
    full.write_text('\n'.join(lines)); full.chmod(0o600)
    write_json(directory/'speaker-review.json', {'method': 'reference_start_plus_minus_2_seconds',
               'note': 'Anonymous labels are independent. Nearby segments are review aids, not a label mapping, precise turn match or DER.',
               'anchors': anchors})
    review = ['# 说话人回听对照', '', '两套匿名编号彼此独立，不直接将不同编号判错。按参考起点 ±2 秒列出本地真实片段，逐项回听。', '']
    for item in anchors:
        start = item['reference_start']
        review.extend([f"## {start//60:02}:{start%60:02} · 参考发言人 {item['reference_speaker']}", '', item['reference_text'], ''])
        for candidate in item['predicted_near_anchor']:
            review.extend([f"- {candidate['start']:.2f}–{candidate['end']:.2f} 秒 · {candidate['speaker'] or '归属不确定'} · 重叠={candidate['overlap']}：{candidate['text']}", ''])
    target = directory/'speaker-review.md'
    target.write_text('\n'.join(review)); target.chmod(0o600)


def run(opts):
    os.umask(0o077)
    inputs = load_inputs(opts.inputs)
    reference = parse_reference(Path(inputs['model_reference']['path']).read_text())
    approved_terms = json.loads(opts.approved_terms.read_text())['hotwords'] if opts.approved_terms else []
    source_root = opts.source_root.resolve()
    destination = opts.output.resolve()/opts.run_id
    approved_output = Path(inputs['output_root']).resolve()
    if not destination.is_relative_to(approved_output) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', opts.run_id):
        raise ValueError('Output must stay in the explicit evaluation directory')
    sys.path.insert(0, str(source_root))
    os.environ['ECHONOTES_ASR_ROOT'] = str(destination/'runtime')
    import service
    from job_store import JobStore
    from bounded_worker import Worker
    enhancement = None
    if opts.enhancement:
        from enhancement import normalize_enhancement
        enhancement = normalize_enhancement(json.loads(opts.enhancement.read_text()))
    candidate = load_candidate_manifest(opts.candidate_manifest) if opts.candidate_manifest else None
    code_files = [p for p in source_root.glob('*.py') if p.is_file()]
    code_fingerprint = hashlib.sha256(json.dumps({p.name: file_hash(p) for p in sorted(code_files)}, sort_keys=True).encode()).hexdigest()
    identity = {'audio': inputs['audio']['sha256'], 'reference': inputs['model_reference']['sha256'],
                'code_fingerprint': code_fingerprint, 'evaluation_code': file_hash(Path(__file__)),
                'model': service.MODEL_ID, 'asr_revision': service.REVISION,
                'diarizer_revision': service.DIAR_REVISION, 'aligner_revision': service.ALIGN_REVISION,
                'language': opts.language, 'mode': opts.mode, 'enhancement': enhancement,
                'normalization_version': NORMALIZATION_VERSION, 'approved_terms_for_scoring': approved_terms,
                'candidate': candidate, 'requirements_lock': file_hash(source_root/'requirements.lock')}
    if candidate:
        identity.update(model=candidate['model_id'], asr_revision=candidate['revision'])
    key = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    previous = destination/'run.json'
    if previous.exists():
        cached = json.loads(previous.read_text())
        if cached.get('identity_fingerprint') == key and cached.get('state') == 'succeeded':
            print(json.dumps({'run_id': opts.run_id, 'state': 'cached'}), flush=True)
            return
        raise ValueError('Existing run is incomplete or has another identity; use another run ID')
    destination.mkdir(parents=True, exist_ok=True)
    write_json(destination/'reference.json', reference)
    record = {'run_id': opts.run_id, 'identity': identity, 'identity_fingerprint': key, 'state': 'preparing',
              'human_quality_review': 'pending', 'reference_kind': 'model_generated_silver_reference'}
    write_json(previous, record)
    lock_path = Path.home()/'.local/share/echo-notes/mlx-inference.lock'
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open('a+') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        store = JobStore(destination/'runtime', 'evaluation', [service.MODEL_ID, service.DIAR_MODEL_ID])
        model = service.DIAR_MODEL_ID if opts.mode == 'diarized' else service.MODEL_ID
        arguments = ('evaluation-'+key[:24], model, opts.language, inputs['audio']['bytes'], 'audio/mp4')
        job = store.create(*arguments, **({'enhancement': enhancement} if enhancement is not None else {}))
        signal.signal(signal.SIGTERM, lambda *_: store.request_cancel(job))
        signal.signal(signal.SIGINT, lambda *_: store.request_cancel(job))
        with Path(inputs['audio']['path']).open('rb') as source:
            offset = 0
            while chunk := source.read(4*1024*1024):
                store.append_chunk(job, offset, chunk, hashlib.sha256(chunk).hexdigest())
                offset += len(chunk)
        store.commit(job)
        engine = candidate_engine(service, candidate) if candidate else service.Engine()
        trace = (destination/'trace.jsonl').open('w')
        def observe(event):
            trace.write(json.dumps(event, ensure_ascii=False)+'\n')
            trace.flush()
        done = threading.Event()
        def progress():
            while not done.wait(10):
                print(json.dumps({'run_id': opts.run_id, 'stage': job.stage, 'processed_seconds': job.processed_seconds}), flush=True)
        thread = threading.Thread(target=progress, daemon=True)
        thread.start()
        started = time.monotonic()
        try:
            from validation.resource_guard import configure_mlx_limits
            import mlx.core as mx
            configure_mlx_limits(mx)
            engine.load()
            record['load_seconds'] = time.monotonic()-started
            worker = Worker(engine, store, **({'observer': observe} if 'observer' in inspect.signature(Worker).parameters else {}))
            worker.run(job)
            payload = store.load_result(job)
            write_json(destination/'result.json', payload)
            score = score_reference(reference, payload.get('transcript', payload['text']), approved_terms)
            write_json(destination/'comparison.json', score)
            write_report(destination, score)
            write_review_materials(destination, reference, payload)
            metrics_path = store.jobs_dir/job.id/'metrics.json'
            metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else engine.last_request
            write_json(destination/'metrics.json', metrics)
            record.update(state='succeeded', elapsed_seconds=time.monotonic()-started,
                          character_difference_rate=score['character_difference_rate'],
                          duration_seconds=payload['duration'], rtf=(time.monotonic()-started)/payload['duration'])
        except BaseException as exc:
            record.update(state='failed', error_type=type(exc).__name__, job_error=job.error,
                          elapsed_seconds=time.monotonic()-started)
            raise
        finally:
            done.set();thread.join(timeout=1);trace.close()
            write_json(previous, record)
            print(json.dumps({k:record.get(k) for k in ('run_id','state','elapsed_seconds','character_difference_rate')}), flush=True)


def run_guarded(opts, argv, supervisor=None):
    # Validate only the output allowlist in the supervisor; model loading and
    # private audio/reference reads occur in the admitted child process.
    from validation.resource_guard import save_report, supervise
    approved = Path(json.loads(opts.inputs.read_text())['output_root']).resolve()
    output = opts.output.resolve()
    if not output.is_relative_to(approved) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}', opts.run_id):
        raise ValueError('Output must stay in the explicit evaluation directory')
    environment = os.environ.copy()
    environment['ECHONOTES_EVAL_SUPERVISOR'] = str(os.getpid())
    result = (supervisor or supervise)([sys.executable, str(Path(__file__).resolve()), *argv], env=environment)
    report = output/f'{opts.run_id}.resource-guard-{time.time_ns()}.json'
    save_report(report, result)
    if result['state'] == 'stopped':
        record_path = output/opts.run_id/'run.json'
        if record_path.is_file():
            record = json.loads(record_path.read_text())
            if record.get('state') not in {'succeeded', 'failed'}:
                record.update(state='failed', error_type='ResourceGuardStop', job_error=result['reason'])
                write_json(record_path, record)
    print(json.dumps({'run_id': opts.run_id, 'guard_state': result['state'],
                      'reason': result.get('reason')}), flush=True)
    return result['exit_code']


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--inputs', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--run-id', required=True)
    parser.add_argument('--language', choices=['auto','zh','en'], default='auto')
    parser.add_argument('--mode', choices=['plain','diarized'], default='plain')
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--enhancement', type=Path)
    parser.add_argument('--candidate-manifest', type=Path)
    parser.add_argument('--approved-terms', type=Path, help='Scoring-only approved spelling list; never implicitly sent to ASR')
    arguments = sys.argv[1:] if argv is None else argv
    opts = parser.parse_args(arguments)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    os.umask(0o077)
    if os.environ.pop('ECHONOTES_EVAL_SUPERVISOR', None) == str(os.getppid()):
        run(opts)
        return 0
    return run_guarded(opts, arguments)


if __name__ == '__main__':
    raise SystemExit(main())

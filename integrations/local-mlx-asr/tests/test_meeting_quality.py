"""No private audio: deterministic reference/scoring and input identity tests."""
import hashlib
import importlib.util
import json
import random
import tempfile
import unittest
from pathlib import Path


class MeetingQualityTests(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).resolve().parents[1]/'validation/meeting_quality.py'
        self.assertTrue(path.is_file(), 'Explicit local meeting evaluation entry point is missing')
        spec=importlib.util.spec_from_file_location('meeting_quality',path)
        self.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.module)

    def test_reference_retains_unknown_ends_and_rejects_backward_time(self):
        parsed=self.module.parse_reference('会议原文\n2026年\n发言人1   00:00\n不批准三十元。\n\n发言人2   00:12\nAI 2.0\n')
        self.assertEqual(len(parsed),2);self.assertIsNone(parsed[0]['end'])
        self.assertEqual(parsed[1]['start'],12)
        with self.assertRaises(ValueError):self.module.parse_reference('发言人1 00:12\n甲\n发言人2 00:11\n乙')
        with self.assertRaises(ValueError):self.module.parse_reference('发言人1 00:76\n甲')

    def test_normalization_keeps_negation_and_numeric_detail(self):
        self.assertEqual(self.module.normalize_text(' 不批准 30.5 元，AI！'), '不批准305元ai')
        report=self.module.score_reference([{'speaker_label':'1','start':0,'end':None,'text':'不批准30元'}], '批准50元')
        self.assertEqual(report['character_edits'],2)
        self.assertEqual(report['reference_kind'],'model_generated_silver_reference')
        self.assertIsNone(report['der'])
        self.assertTrue(any('negation' in d['flags'] for d in report['differences']))
        self.assertTrue(any('number' in d['flags'] for d in report['differences']))

    def test_review_outputs_keep_full_text_and_use_only_observed_speaker_times(self):
        reference = [{'speaker_label': '1', 'start': 10, 'end': None, 'text': '不批准。'}]
        payload = {'text': '不批准。', 'segments': [{'start': 9.8, 'end': 11.2, 'speaker': 'speaker_2', 'speakers': [2], 'text': '不批准。', 'overlap': False}]}
        with tempfile.TemporaryDirectory() as tmp:
            self.module.write_review_materials(Path(tmp), reference, payload)
            self.assertIn('不批准。', (Path(tmp)/'full-comparison.md').read_text())
            rows = json.loads((Path(tmp)/'speaker-review.json').read_text())['anchors']
            self.assertIsNone(rows[0]['reference_end'])
            self.assertEqual(rows[0]['predicted_near_anchor'][0]['start'], 9.8)
            self.assertEqual(rows[0]['reference_speaker'], '1')

    def test_character_distance_matches_small_dynamic_programming_oracle(self):
        rng=random.Random(23)
        def oracle(a,b):
            row=list(range(len(b)+1))
            for i,x in enumerate(a,1):
                after=[i]
                for j,y in enumerate(b,1):after.append(min(after[-1]+1,row[j]+1,row[j-1]+(x!=y)))
                row=after
            return row[-1]
        for _ in range(100):
            a=''.join(rng.choices('甲乙123',k=rng.randrange(20)))
            b=''.join(rng.choices('甲乙123',k=rng.randrange(20)))
            self.assertEqual(self.module.character_distance(a,b),oracle(a,b))

    def test_candidate_token_limit_is_checked_for_sdk_token_lists(self):
        from types import SimpleNamespace as NS
        class Failure(Exception): pass
        service=NS(Engine=lambda:NS(),TOKEN_BUDGET=2,TranscriptionFailure=Failure)
        engine=self.module.candidate_engine(service,{'backend':'mlx-audio-plus'})
        engine.model=NS(generate=lambda *args,**kwargs:NS(text='fixture',tokens=[1,2],language='zh'))
        with self.assertRaises(Failure):engine.generate_text([1],'Chinese')

    def test_evaluation_uses_supervisor_and_retains_resource_stop_evidence(self):
        from types import SimpleNamespace as NS
        guarded = getattr(self.module, 'run_guarded', None)
        self.assertTrue(callable(guarded), 'Direct meeting evaluation must have resource admission')
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            inputs = root/'inputs.json'
            inputs.write_text(json.dumps({'output_root': str(root)}))
            opts = NS(inputs=inputs, output=root, run_id='fixture')
            result = {'state': 'stopped', 'exit_code': 124, 'reason': 'process_memory'}
            calls = []
            def supervise(command, **kwargs):
                calls.append((command, kwargs))
                return result
            self.assertEqual(guarded(opts, ['--run-id', 'fixture'], supervisor=supervise), 124)
            self.assertEqual(len(calls), 1)
            reports = list(root.glob('fixture.resource-guard-*.json'))
            self.assertEqual(json.loads(reports[0].read_text())['reason'], 'process_memory')
            self.assertFalse((root/'fixture'/'run.json').exists())

    def test_candidate_requires_verified_local_files_before_loading(self):
        verify=getattr(self.module,'load_candidate_manifest',None)
        self.assertTrue(callable(verify),'Candidate assets must be verified before model import')
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);weights=root/'model.safetensors';weights.write_bytes(b'fixture')
            manifest=root/'manifest.json';manifest.write_text(json.dumps({'model_id':'fixture','revision':'a'*40,'path':str(root),'backend':'mlx-audio','files':{'model.safetensors':hashlib.sha256(weights.read_bytes()).hexdigest()}}))
            self.assertEqual(verify(manifest)['model_id'],'fixture')
            weights.write_bytes(b'bad')
            with self.assertRaises(ValueError):verify(manifest)

    def test_user_approved_spelling_is_authoritative_over_model_reference(self):
        score=self.module.score_reference([{'speaker_label':'1','start':0,'end':None,'text':'示例甲'}], '示例乙', approved_terms=['示例乙'])
        self.assertEqual(score['approved_terms'][0]['predicted_count'],1)
        self.assertEqual(score['approved_terms'][0]['reference_count'],0)
        self.assertTrue(score['approved_terms_are_authoritative'])
        self.assertTrue(any('approved_spelling' in d['flags'] for d in score['differences']))
        self.assertGreater(score['character_edits'],0)

    def test_input_hash_mismatch_is_rejected_and_no_neighbor_is_needed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);audio=root/'one.wav';audio.write_bytes(b'fixture')
            reference=root/'reference.md';reference.write_text('发言人1 00:00\n测试')
            manifest={role:{'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()} for role,path in [('audio',audio),('model_reference',reference)]}
            path=root/'inputs.json';path.write_text(json.dumps(manifest))
            data=self.module.load_inputs(path)
            self.assertEqual(data['audio']['sha256'],manifest['audio']['sha256'])
            audio.write_bytes(b'changed')
            with self.assertRaises(ValueError):self.module.load_inputs(path)


if __name__=='__main__':unittest.main()

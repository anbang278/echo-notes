"""Preserve timeline/text contracts from the pre-long-audio implementation."""
import unittest
from types import SimpleNamespace as NS
from diarization import align_text_to_speakers, build_turns, format_segment


class TimelineTests(unittest.TestCase):
    def test_overlap_partition_and_global_ids(self):
        raw=[NS(start=.2,end=3,speaker=3),NS(start=2,end=4,speaker=1),NS(start=4.5,end=6,speaker=3)]
        turns,mapping=build_turns(raw,7*16000,16000)
        self.assertEqual(mapping,{3:1,1:2})
        self.assertEqual(sum(t.end-t.start for t in turns),7*16000)
        result=align_text_to_speakers('甲，乙。丙！丁？',[
            NS(text='甲',start_time=.3,end_time=1),NS(text='乙',start_time=2.2,end_time=2.8),
            NS(text='丙',start_time=4.6,end_time=5),NS(text='丁',start_time=6.2,end_time=6.5)],turns,16000,0,7)
        self.assertTrue(result[1]['overlap'])
        self.assertEqual(result[1]['speakers'],[1,2])
        self.assertEqual(result[2]['speaker'],'speaker_1')
        self.assertEqual(result[3]['speakers'],[])
        self.assertEqual(''.join(s['text'] for s in result),'甲，乙。丙！丁？')
        self.assertIn('归属待核对',format_segment(result[1]))

    def test_missing_and_backward_tokens_fail(self):
        turns,_=build_turns([],16000,16000)
        for items in [[NS(text='你',start_time=0,end_time=1)],
                      [NS(text='你',start_time=0,end_time=.6),NS(text='好',start_time=.55,end_time=.9)]]:
            with self.assertRaises(ValueError):align_text_to_speakers('你好',items,turns,16000,0,1)

    def test_point_timestamp_and_punctuation_only_tail_are_retained(self):
        turns,_=build_turns([],6400,16000)
        result=align_text_to_speakers('好！',[NS(text='好',start_time=.4,end_time=.4)],turns,16000,0,.4)
        self.assertEqual(result[0]['text'],'好！')
        self.assertEqual(result[0]['end'],.4)
        punctuation=align_text_to_speakers('。',[],turns,16000,50,.4)
        self.assertEqual(punctuation[0]['text'],'。')
        self.assertEqual(punctuation[0]['end'],50.4)
        self.assertEqual(punctuation[0]['speakers'],[])

    def test_speaker_change_is_not_claimed_as_overlap(self):
        turns,_=build_turns([NS(start=0,end=.5,speaker=0),NS(start=.5,end=1,speaker=1)],16000,16000)
        result=align_text_to_speakers('好',[NS(text='好',start_time=.25,end_time=.75)],turns,16000,0,1)
        self.assertEqual(result[0]['speakers'],[1,2]);self.assertFalse(result[0]['overlap'])
        self.assertIn('说话人切换处',format_segment(result[0]))

    def test_bad_intervals_and_out_of_source_alignment_fail(self):
        with self.assertRaises(ValueError):build_turns([NS(start=0,end=float('nan'),speaker=0)],16000,16000)
        turns,_=build_turns([],16000,16000)
        with self.assertRaises(ValueError):align_text_to_speakers('好',[NS(text='好',start_time=0,end_time=101)],turns,16000,0,1)


if __name__=='__main__':unittest.main()

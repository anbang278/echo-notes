"""Speaker timeline helpers. No model loading and no file or network access."""
from collections import Counter, defaultdict
from dataclasses import dataclass
import math
import unicodedata
from bisect import bisect_right


@dataclass
class Turn:
    start: int
    end: int
    speakers: tuple[int, ...]


def build_turns(segments, samples, sr):
    """Sweep overlapping activities into a single, gap-free sample timeline.

    A short pause between the SAME speaker set is kept with that turn. Other
    unassigned audio stays unassigned; it is never silently dropped or guessed.
    """
    events = defaultdict(Counter)
    events[0]; events[samples]
    first = {}
    for seg in segments:
        a, b, speaker = float(seg.start), float(seg.end), int(seg.speaker)
        if not (math.isfinite(a) and math.isfinite(b)) or b < a or not 0 <= speaker < 4:
            raise ValueError("Invalid diarization interval")
        start, end = max(0, round(a * sr)), min(samples, round(b * sr))
        if start >= end:
            continue
        events[start][speaker] += 1
        events[end][speaker] -= 1
        first[speaker] = min(start, first.get(speaker, start))
    mapping = {speaker: index + 1 for index, speaker in enumerate(sorted(first, key=lambda s: (first[s], s)))}
    active, turns, previous = Counter(), [], 0
    for position in sorted(events):
        speakers = tuple(sorted(mapping[s] for s, count in active.items() if count > 0))
        if position > previous:
            if turns and turns[-1].speakers == speakers:
                turns[-1].end = position
            else:
                turns.append(Turn(previous, position, speakers))
        active.update(events[position])
        previous = position
    # Preserve short within-speaker pauses without fragmenting words/sentences.
    index = 1
    while index + 1 < len(turns):
        before, gap, after = turns[index-1:index+2]
        if not gap.speakers and gap.end-gap.start <= round(0.4*sr) and before.speakers == after.speakers:
            before.end = after.end
            del turns[index:index+2]
        else:
            index += 1
    if samples and (not turns or turns[0].start != 0 or turns[-1].end != samples):
        raise ValueError("Incomplete diarization coverage")
    if any(a.end != b.start for a,b in zip(turns,turns[1:])):
        raise ValueError("Non-contiguous diarization coverage")
    return turns, mapping


def timestamp(seconds):
    centiseconds = round(seconds * 100)
    minutes, remainder = divmod(centiseconds, 6000)
    seconds, fraction = divmod(remainder, 100)
    return f"{minutes:02d}:{seconds:02d}.{fraction:02d}"


def format_segment(segment):
    speakers = segment["speakers"]
    if not speakers:
        label = "说话人未确定"
    elif len(speakers) > 1:
        kind = "重叠发言" if segment["overlap"] else "说话人切换处"
        label = kind + "（" + " / ".join(f"说话人 {s}" for s in speakers) + "，归属待核对）"
    else:
        label = f"说话人 {speakers[0]}"
    return f"[{timestamp(segment['start'])}–{timestamp(segment['end'])}] {label}：{segment['text']}"


def align_text_to_speakers(text, items, turns, sr, offset, duration):
    """Restore original punctuation/spacing while assigning aligned tokens.

    Every original character is conserved. Bad or incomplete alignment fails;
    it cannot produce a shortened successful transcript.
    """
    positions = [i for i,ch in enumerate(text) if ch == "'" or unicodedata.category(ch).startswith(('L','N'))]
    cleaned = ''.join(text[i] for i in positions)
    if not cleaned and text and not items:
        # Punctuation-only ASR has no alignable tokens. Preserve the text and
        # actual source span without inventing a speaker or token timestamp.
        return [{'start': round(offset, 3), 'end': round(offset+duration, 3),
                 'speaker': None, 'speakers': [], 'overlap': False, 'text': text}]
    if ''.join(item.text for item in items) != cleaned or not items:
        raise ValueError('Alignment does not cover transcript text')
    starts = [turn.start for turn in turns]
    consumed, text_cursor, previous_end, output = 0, 0, 0.0, []
    for item in items:
        start,end = float(item.start_time),float(item.end_time)
        if not (math.isfinite(start) and math.isfinite(end)) or start < -0.05 or end < start or end > duration+0.5:
            raise ValueError('Alignment timestamps are invalid')
        if start < previous_end-0.000001:
            raise ValueError('Alignment timestamps went backwards')
        start,end = max(0,min(duration,start)),max(0,min(duration,end))
        previous_end=end
        consumed += len(item.text)
        boundary = positions[consumed] if consumed < len(positions) else len(text)
        piece = text[text_cursor:boundary]
        text_cursor=boundary
        begin,finish = round((offset+start)*sr),round((offset+end)*sr)
        if finish-begin < round(0.02*sr):
            begin=max(0,begin-round(0.04*sr)); finish+=round(0.04*sr)
        score=Counter(); overlap_samples=0
        turn_index=max(0,bisect_right(starts,begin)-1)
        for turn in turns[turn_index:]:
            if turn.start>=finish: break
            amount=max(0,min(finish,turn.end)-max(begin,turn.start))
            for speaker in turn.speakers: score[speaker]+=amount
            if len(turn.speakers)>1: overlap_samples+=amount
        span=max(1,finish-begin)
        candidates=tuple(sorted(s for s,value in score.items() if value/span>=0.35))
        overlap=len(candidates)>1 and overlap_samples/span>=0.15
        if len(candidates)==1 and score[candidates[0]]/span<0.6:
            candidates=()
        segment={'start':round(offset+start,3),'end':round(offset+end,3),
                 'speaker':f'speaker_{candidates[0]}' if len(candidates)==1 else None,
                 'speakers':list(candidates),'overlap':overlap,'text':piece}
        if output and output[-1]['speakers']==segment['speakers'] and output[-1]['overlap']==overlap and segment['start']-output[-1]['end']<=1.5:
            output[-1]['end']=max(output[-1]['end'],segment['end'])
            output[-1]['text']+=piece
        else: output.append(segment)
    if text_cursor!=len(text) or ''.join(s['text'] for s in output)!=text:
        raise ValueError('Aligned transcript lost characters')
    return output

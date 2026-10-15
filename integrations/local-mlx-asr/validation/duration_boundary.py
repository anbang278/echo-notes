"""Actual 8h/+1-sample decode counting; synthetic PCM, no model inference."""
import argparse
import json
import sys
import tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import bounded_audio as ba


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    import subprocess
    results=[]
    with tempfile.TemporaryDirectory(prefix='asr-duration-boundary-') as temp:
        root=Path(temp)
        # A sparse PCM WAV exercises the real decoder without filling the disk with input.
        import wave
        for extra in [0,1]:
            samples=8*3600*16000+extra
            source=root/'boundary.wav'
            with wave.open(str(source),'wb') as wav:
                wav.setnchannels(1);wav.setsampwidth(2);wav.setframerate(16000)
                wav.setnframes(samples)
                # Build a valid header first, then extend its sparse data section.
                wav.writeframesraw(b'')
            import struct
            with source.open('r+b') as wav:
                wav.seek(4);wav.write(struct.pack('<I',36+samples*2))
                wav.seek(40);wav.write(struct.pack('<I',samples*2));wav.truncate(44+samples*2)
            try:
                decoded=ba.decode_to_disk(source,root,max_duration_seconds=8*3600)
                assert extra==0 and decoded.samples==samples
                results.append({'samples':samples,'status':'PASS','behavior':'exactly 8h accepted'})
            except ba.DecodeFailure as exc:
                assert extra==1 and exc.code=='duration_exceeded'
                results.append({'samples':samples,'status':'PASS','behavior':'8h+1 actual sample rejected'})
            (root/'decoded.f32le').unlink(missing_ok=True)
            print(results[-1],flush=True)
    args.output.write_text(json.dumps({'status':'PASS','kind':'real ffmpeg decode counting; no 8h model inference','checks':results},indent=2))


if __name__=='__main__':main()

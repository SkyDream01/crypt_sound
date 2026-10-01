# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
"""Generate reproducible synthetic codec tests. No Bilibili claims implied."""
import json
import subprocess
import sys
import time
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from crypt_sound.dsp import RATE, Scrambler, StreamDecoder
from crypt_sound.media import write_pcm, pcm_chunks
sys.path.insert(0, str(ROOT / 'tests'))
from test_dsp import music, snr


def main():
    out = ROOT / 'output' / 'benchmark-cs2'
    out.mkdir(parents=True, exist_ok=True)
    original = music(8)
    codec = Scrambler('demo-music-key')
    carrier = np.concatenate([codec.encode(b) for b in original.reshape(-1, RATE, 2)])
    write_pcm(out / 'original.wav', [original])
    write_pcm(out / 'carrier.wav', [carrier])
    results = []
    for name, options, suffix in [
        ('PCM', None, '.wav'),
        ('AAC 256k', ['-c:a','aac','-b:a','256k'], '.m4a'),
        ('AAC 128k', ['-c:a','aac','-b:a','128k'], '.m4a'),
        ('AAC 96k', ['-c:a','aac','-b:a','96k'], '.m4a'),
        ('Opus 128k', ['-c:a','libopus','-b:a','128k'], '.ogg'),
        ('AAC 128k 44.1kHz', ['-c:a','aac','-b:a','128k','-ar','44100'], '.m4a'),
        ('AAC 256k then 128k', ['-c:a','aac','-b:a','128k'], '.m4a'),
    ]:
        path = out / (name.replace(' ', '_') + suffix)
        if options:
            source = out / ('AAC_256k.m4a' if name == 'AAC 256k then 128k' else 'carrier.wav')
            subprocess.run(['ffmpeg','-v','error','-y','-i',str(source),*options,str(path)], check=True)
        else:
            path = out / 'carrier.wav'
        decoder = StreamDecoder(codec)
        decoded = []
        started = time.perf_counter()
        for chunk in pcm_chunks(path):
            decoded.extend(decoder.feed(chunk))
        elapsed = time.perf_counter() - started
        recovered = np.concatenate(decoded) if decoded else np.empty((0,2))
        write_pcm(out / (name.replace(' ','_')+'_decoded.wav'), [recovered])
        result = {'codec':name, 'recovered_packets':len(decoded), 'expected_packets':8,
                  'snr_db':round(snr(original, recovered), 2) if len(recovered)==len(original) else None,
                  'decode_seconds_including_ffmpeg':round(elapsed,3)}
        results.append(result)
        print(result, flush=True)
    (out/'results.json').write_text(json.dumps(results,indent=2,ensure_ascii=False),encoding='utf-8')
    if any(r['recovered_packets'] != 8 for r in results):
        raise SystemExit('Some codecs lost packets; inspect results.json')


if __name__ == '__main__':
    main()

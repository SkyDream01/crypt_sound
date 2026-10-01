# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
"""Run the released standalone DSP against CS2 Python vectors."""
import json
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from crypt_sound.dsp import PILOT_SIZE, RATE, Scrambler, StreamDecoder
from crypt_sound.media import pcm_chunks, write_pcm
from test_dsp import music, snr

SCRIPT = Path(__file__).resolve().parents[1] / 'userscript' / 'crypt-sound.user.js'
RUNNER = r'''
const fs = require('node:fs');
const {mapping, StreamDecoder} = require(process.argv[1]);
(async () => {
  const config = JSON.parse(fs.readFileSync(0, 'utf8'));
  const map = await mapping(config.key);
  const bytes = fs.readFileSync(config.input);
  const input = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset+bytes.byteLength));
  const decoder = new StreamDecoder(map), output = [], starts = [];
  const start = performance.now();
  for (let pos = 0; pos < input.length;) {
    const size = Math.min(input.length-pos, 2*(100+((pos*17+391)%6400)));
    output.push(...decoder.feed(input.subarray(pos,pos+size)));
    starts.push(...decoder.starts);
    pos += size;
    if (decoder.buffer.length >= 96000) throw Error('Unbounded buffer');
  }
  for (const bad of [new Float32Array([NaN,0]), new Float32Array(3), new Float32Array(384002)]) {
    let rejected = false;
    try { decoder.feed(bad); } catch { rejected = true; }
    if (!rejected) throw Error('Invalid PCM accepted');
  }
  fs.writeFileSync(config.output, Buffer.concat(output.map(a => Buffer.from(a.buffer))));
  console.log(JSON.stringify({indices:map.indices,signs:map.signs,packets:decoder.packets,starts,ms:performance.now()-start}));
})().catch(e => { console.error(e); process.exit(1); });
'''


@pytest.mark.skipif(not shutil.which('node'), reason='Node.js required for userscript DSP')
@pytest.mark.parametrize('lossy', [False, True])
def test_userscript_matches_python(tmp_path, lossy):
    if lossy and not shutil.which('ffmpeg'):
        pytest.skip('FFmpeg required')
    key = '独立解密🔑-test' if lossy else 'test-password'
    codec = Scrambler(key)
    original = music(4)
    carrier = np.concatenate([codec.encode(b) for b in original.reshape(-1, RATE, 2)])
    if lossy:
        source, encoded = tmp_path/'carrier.wav', tmp_path/'carrier.m4a'
        write_pcm(source, [carrier])
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(source), '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', str(encoded)], check=True)
        carrier = np.concatenate(list(pcm_chunks(encoded)))
    # Mid-packet join, a full packet of silence, and arbitrary input chunks.
    positive_pilot = codec.encode(original[:RATE])
    positive_pilot[:PILOT_SIZE] *= -1
    carrier = np.concatenate([positive_pilot, carrier[12345:]])
    reference = StreamDecoder(codec)
    expected = []
    for pos in range(0, len(carrier), 4096):
        expected.extend(reference.feed(carrier[pos:pos+4096]))
    input_path, output_path = tmp_path/'input.pcm', tmp_path/'output.pcm'
    carrier.astype('<f4').tofile(input_path)
    result = subprocess.run(['node', '-e', RUNNER, str(SCRIPT)], input=json.dumps(dict(key=key, input=str(input_path), output=str(output_path))), text=True, capture_output=True, check=True, timeout=60)
    info = json.loads(result.stdout)
    assert info['indices'] == codec.indices.tolist()
    assert info['signs'] == codec.signs.tolist()
    assert info['packets'] == len(expected) == 3
    # Keep the original timeline when dropping a partial packet at the start.
    assert abs(info['starts'][0] - (2 * RATE - 12345)) < 16
    assert all(abs(b - a - RATE) < 16 for a, b in zip(info['starts'], info['starts'][1:]))
    actual = np.fromfile(output_path, dtype='<f4').reshape(-1, 2)
    assert snr(np.concatenate(expected), actual) > 100
    assert snr(original[RATE:], actual) > (18 if lossy else 25)
    print(f"userscript lossy={lossy}: {info['packets']} packets, {info['ms']:.0f} ms")

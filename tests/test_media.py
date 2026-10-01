# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
import shutil
import subprocess
import json
import numpy as np
import pytest
from crypt_sound.dsp import RATE, Scrambler, StreamDecoder
from crypt_sound.media import encode_file, decode_file, pcm_chunks, write_pcm


@pytest.mark.skipif(not shutil.which('ffmpeg') or not shutil.which('ffprobe'), reason='FFmpeg required')
def test_video_replaces_all_audio_and_roundtrip(tmp_path):
    source = tmp_path / 'source.mp4'
    output = tmp_path / 'carrier.mp4'
    restored = tmp_path / 'restored.wav'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=size=160x90:rate=25:duration=2',
                    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=2',
                    '-map','0:v','-map','1:a','-map','1:a','-c:v','libx264','-c:a','aac',str(source)],check=True)
    codec = Scrambler('media-test')
    encode_file(source, output, codec)
    info = json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-of','json',str(output)]))
    assert [s['codec_type'] for s in info['streams']] == ['video','audio']
    decoder = StreamDecoder(codec)
    decode_file(output, restored, decoder)
    assert decoder.packets == 2
    assert len(np.concatenate(list(pcm_chunks(restored)))) == 2 * RATE
    with pytest.raises(FileExistsError):
        encode_file(source, output, codec)


@pytest.mark.skipif(not shutil.which('ffmpeg'), reason='FFmpeg required')
def test_failed_decode_does_not_publish(tmp_path):
    source = tmp_path / 'silence.wav'
    target = tmp_path / 'decoded.wav'
    write_pcm(source, [np.zeros((RATE, 2))])
    with pytest.raises(ValueError, match='同步'):
        decode_file(source, target, StreamDecoder(Scrambler('test')))
    assert not target.exists()

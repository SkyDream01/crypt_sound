# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
import numpy as np
import pytest
from crypt_sound.dsp import RATE, BLOCK, PAYLOAD, START, WIDTH, Scrambler, StreamDecoder


def music(seconds=4):
    t = np.arange(RATE * seconds) / RATE
    # Deterministic synthesized musical passage: chords, harmonics and percussion.
    rng = np.random.default_rng(40)
    left = sum(0.06 / h * np.sin(2*np.pi*f*h*t + 0.1*h)
               for f in (220, 277.18, 329.63) for h in range(1, 9))
    envelope = .4 + .6 * np.sin(np.pi*t)**2
    percussion = rng.normal(0, .018, len(t)) * np.exp(-18*(t % .5))
    left = left * envelope + percussion
    right = .8 * left + .04*np.sin(2*np.pi*440*t)
    return np.column_stack((left, right)).astype(np.float32)


def snr(reference, actual):
    return float(10*np.log10(np.sum(reference**2) / max(1e-20, np.sum((reference-actual)**2))))


@pytest.fixture(scope="module")
def codec():
    return Scrambler('test-password')


def test_pcm_roundtrip_and_wrong_key(codec):
    original = music(1)
    packet = codec.encode(original)
    recovered = codec.decode(packet)
    assert snr(original, recovered) > 25
    wrong = Scrambler('wrong-password').decode(packet)
    assert snr(original, wrong) < 1
    assert np.max(abs(packet)) < 1


def test_cs2_frequency_mapping_stays_compatible(codec):
    assert codec.indices[::WIDTH].tolist() == [519, 199, 399, 279, 559, 79, 359, 599,
                                              239, 439, 159, 639, 319, 119, 479, 39]
    assert codec.signs[::WIDTH].tolist() == [1, 1, 1, 1, 1, -1, 1, 1,
                                            1, -1, -1, 1, -1, -1, -1, 1]


def test_stream_arbitrary_chunks_and_seek(codec):
    original = music(4)
    encoded = np.concatenate([codec.encode(b) for b in original.reshape(4, RATE, 2)])
    # Enter midway through a packet, like joining or seeking in a stream.
    encoded = np.concatenate([np.zeros((733, 2)), encoded[12345:]])
    decoder = StreamDecoder(codec)
    output = []
    rng = np.random.default_rng(3)
    pos = 0
    while pos < len(encoded):
        size = int(rng.integers(100, 6500))
        output.extend(decoder.feed(encoded[pos:pos+size]))
        pos += size
    assert len(output) == 3
    assert snr(original[RATE:], np.concatenate(output)) > 25
    assert len(decoder.buffer) < RATE


def test_noise_is_bounded(codec):
    decoder = StreamDecoder(codec)
    rng = np.random.default_rng(100)
    for _ in range(12):
        assert not decoder.feed(rng.normal(0, .03, (RATE, 2)))
        assert len(decoder.buffer) < RATE
    with pytest.raises(ValueError):
        decoder.feed(np.full((32, 2), np.nan))


def test_cs2_spreads_short_event_and_preserves_energy(codec):
    # A brief tone confined to one block must no longer reveal its onset.
    from scipy.fft import idct
    coeff = np.zeros((44, BLOCK, 2))
    coeff[17, 19, :] = 1
    source = idct(coeff, axis=1, norm='ortho').reshape(PAYLOAD, 2)
    enhanced = codec.transform(source)
    energy = np.sum(enhanced.reshape(44, BLOCK, 2)**2, axis=(1, 2))
    assert np.max(energy) / np.sum(energy) < 0.05
    assert np.count_nonzero(energy > 1e-6) == 44
    assert np.isclose(np.sum(enhanced**2), np.sum(source**2), rtol=1e-6)
    assert snr(source, codec.transform(enhanced, inverse=True)) > 100


def test_reject_positive_pilot_and_reacquire_cs2(codec):
    from crypt_sound.dsp import PILOT_SIZE
    original = music(1)
    packet = codec.encode(original)
    positive = packet.copy()
    positive[:PILOT_SIZE] *= -1
    with pytest.raises(ValueError, match="Only CS2"):
        codec.decode(positive)
    decoder = StreamDecoder(codec)
    assert decoder.feed(positive) == []
    output = decoder.feed(packet)
    assert len(output) == 1
    assert snr(original, output[0]) > 25


def test_cs2_silence_and_invalid_input(codec):
    packet = codec.encode(np.zeros((RATE, 2), np.float32))
    assert not np.any(packet[START:START+PAYLOAD])
    assert not np.any(codec.decode(packet))
    with pytest.raises(ValueError, match='Non-finite'):
        codec.encode(np.full((RATE, 2), np.nan))

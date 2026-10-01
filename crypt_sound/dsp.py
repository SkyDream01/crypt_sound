# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
"""CS2 temporal/spectral diffusion.

Codec-tolerant scrambling, not authenticated encryption. Packet energy and
repeated content still leak. Only negative CS2 pilots are accepted.
"""
import hashlib
import numpy as np
from scipy.fft import dct, idct
from scipy.signal import chirp, fftconvolve, resample

RATE = 48000
CHANNELS = 2
BLOCK = 1024
PAYLOAD = 44 * BLOCK
PILOT_SIZE = 2048
GUARD = 256
START = PILOT_SIZE + GUARD
GAIN = 0.22
BANDS = 16
WIDTH = 40
ACTIVE = BANDS * WIDTH  # 15 kHz at 48 kHz before time compression
_t = np.arange(PILOT_SIZE) / RATE
PILOT = (chirp(_t, f0=900, f1=8500, t1=_t[-1], method="linear")
         * np.hanning(PILOT_SIZE) * 0.65).astype(np.float32)


class Scrambler:
    def __init__(self, password: str):
        if not password or len(password) > 1024:
            raise ValueError("密钥不能为空，且不能超过 1024 字符")
        # Historical salt is part of the CS2 wire format.
        seed = hashlib.pbkdf2_hmac("sha256", password.encode(), b"crypt-sound-CS1", 100000)
        order = sorted(range(BANDS), key=lambda i: hashlib.sha256(seed + bytes([i])).digest())
        # Avoid leaving any frequency band in place.
        while any(i == x for i, x in enumerate(order)):
            seed = hashlib.sha256(seed).digest()
            order = sorted(range(BANDS), key=lambda i: hashlib.sha256(seed + bytes([i])).digest())
        self.indices = np.concatenate([np.arange(i*WIDTH, (i+1)*WIDTH)[::-1] for i in order])
        self.signs = np.repeat([1 if b & 1 else -1 for b in seed[:BANDS]], WIDTH)
        seed2 = hashlib.pbkdf2_hmac("sha256", password.encode(), b"crypt-sound-CS2", 100000)
        # Specify expansion byte-for-byte so the standalone browser matches.
        masks = []
        for domain in (0, 1):
            rows = []
            for block in range(44):
                raw = b"".join(hashlib.sha256(seed2 + bytes([domain, block, counter])).digest()
                               for counter in range(3))
                rows.append([1 if raw[i // 8] & (1 << (i % 8)) else -1 for i in range(ACTIVE)])
            masks.append(np.asarray(rows, dtype=np.float64)[:, :, None])
        self.pre_mask, self.post_mask = masks

    def transform(self, audio, inverse=False):
        blocks = np.asarray(audio, dtype=np.float64).reshape(-1, BLOCK, CHANNELS)
        coeff = dct(blocks, axis=1, norm="ortho")
        result = np.zeros_like(coeff)
        if inverse:
            active = coeff[:, :ACTIVE, :]
            active = idct(active * self.post_mask, axis=0, norm="ortho") * self.pre_mask
            result[:, self.indices, :] = active * self.signs[None, :, None]
        else:
            active = coeff[:, self.indices, :] * self.signs[None, :, None]
            active = dct(active * self.pre_mask, axis=0, norm="ortho") * self.post_mask
            result[:, :ACTIVE, :] = active
        return idct(result, axis=1, norm="ortho").reshape(-1, CHANNELS).astype(np.float32)

    def encode(self, audio):
        if audio.shape != (RATE, CHANNELS):
            raise ValueError("CS2 requires 48000 stereo samples per packet")
        if not np.isfinite(audio).all():
            raise ValueError("Non-finite PCM")
        packet = np.zeros((RATE, CHANNELS), np.float32)
        packet[:PILOT_SIZE] = -PILOT[:, None]
        packet[START:START+PAYLOAD] = self.transform(resample(audio, PAYLOAD)) * GAIN
        if np.max(np.abs(packet)) > 1:
            raise ValueError("扰乱后峰值溢出，请先降低源音频音量")
        return packet

    def decode(self, packet):
        if np.sum(packet[:PILOT_SIZE] * PILOT[:, None]) >= 0:
            raise ValueError("Only CS2 packets are supported")
        data = packet[START:START+PAYLOAD] / GAIN
        return resample(self.transform(data, inverse=True), RATE).astype(np.float32)


class StreamDecoder:
    """Bounded incremental decoder; reacquires sync after seeking or dropped input."""
    def __init__(self, scrambler):
        self.scrambler = scrambler
        self.buffer = np.empty((0, CHANNELS), np.float32)
        self.locked = False
        self.packets = 0
        self.discarded = 0

    def feed(self, audio):
        audio = np.asarray(audio, np.float32)
        if audio.ndim != 2 or audio.shape[1] != CHANNELS or len(audio) > RATE * 4:
            raise ValueError("Invalid PCM shape or oversized input")
        if not np.isfinite(audio).all():
            raise ValueError("Non-finite PCM")
        self.buffer = np.concatenate((self.buffer, audio))
        output = []
        while len(self.buffer) >= PILOT_SIZE:
            if not self.locked:
                mono = self.buffer.mean(axis=1)
                corr = fftconvolve(mono, PILOT[::-1], mode="valid")
                energy = np.maximum(fftconvolve(mono*mono, np.ones(PILOT_SIZE), mode="valid"), 1e-12)
                score = np.abs(corr) / np.sqrt(energy * np.dot(PILOT, PILOT))
                candidates = np.flatnonzero(score > 0.72)
                if not len(candidates):
                    n = max(0, len(self.buffer) - PILOT_SIZE + 1)
                    self.buffer = self.buffer[n:]
                    self.discarded += n
                    break
                # Select the peak around the first match, never skip an earlier packet.
                first = int(candidates[0])
                end = min(first + 128, len(score))
                offset = first + int(np.argmax(score[first:end]))
                # Find the true peak before checking polarity; a positive pilot
                # has negative sidelobes that must not be mistaken for CS2.
                if corr[offset] >= 0:
                    self.buffer = self.buffer[offset + PILOT_SIZE:]
                    self.discarded += offset + PILOT_SIZE
                    continue
                self.buffer = self.buffer[offset:]
                self.discarded += offset
                self.locked = True
            if len(self.buffer) < RATE:
                break
            output.append(self.scrambler.decode(self.buffer[:RATE]))
            self.buffer = self.buffer[RATE:]
            self.packets += 1
            self.locked = False
        return output

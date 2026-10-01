# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
"""FFmpeg pipe I/O; memory use is independent of input duration."""
import subprocess
import tempfile
import os
from pathlib import Path
import numpy as np
from .dsp import RATE, CHANNELS


def pcm_chunks(path):
    with tempfile.TemporaryFile() as err:
        proc = subprocess.Popen(["ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
                                 "-f", "f32le", "-ar", str(RATE), "-ac", "2", "-"],
                                stdout=subprocess.PIPE, stderr=err)
        try:
            while True:
                raw = proc.stdout.read(RATE * CHANNELS * 4)
                if not raw:
                    break
                yield np.frombuffer(raw, dtype="<f4").reshape(-1, CHANNELS).copy()
            if proc.wait() != 0:
                err.seek(0)
                raise RuntimeError(err.read().decode(errors="replace"))
        finally:
            proc.stdout.close()
            if proc.poll() is None:
                proc.kill()
            proc.wait()


def write_pcm(path, chunks):
    import wave
    with wave.open(str(path), "wb") as out:
        out.setnchannels(CHANNELS)
        out.setsampwidth(2)
        out.setframerate(RATE)
        for chunk in chunks:
            out.writeframes((np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes())


def _encode_file(source, target, codec):
    target = Path(target)
    if target.exists():
        raise FileExistsError(f"输出已存在：{target}")
    if target.suffix.lower() not in (".wav", ".mp4", ".mkv"):
        raise ValueError("输出格式必须为 .wav / .mp4 / .mkv")
    def packets():
        for block in pcm_chunks(source):
            if len(block) < RATE:
                block = np.pad(block, ((0, RATE-len(block)), (0, 0)))
            yield codec.encode(block)
    if target.suffix.lower() == ".wav":
        write_pcm(target, packets())
        return
    with tempfile.TemporaryDirectory(prefix="crypt-sound-") as directory:
        wav = Path(directory) / "carrier.wav"
        write_pcm(wav, packets())
        # Map exactly one replacement audio track. Never retain source audio tracks.
        subprocess.run(["ffmpeg", "-v", "error", "-n", "-i", str(source), "-i", str(wav),
                        "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1",
                        "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", str(target)], check=True)


def _decode_file(source, target, decoder):
    if Path(target).exists():
        raise FileExistsError(f"输出已存在：{target}")
    if Path(target).suffix.lower() != ".wav":
        raise ValueError("离线解码输出必须是 .wav")
    def blocks():
        for chunk in pcm_chunks(source):
            yield from decoder.feed(chunk)
    write_pcm(target, blocks())
    if not decoder.packets:
        raise ValueError("未检测到 CS2 同步信号，输出仅包含空 WAV 文件")


def _atomic_output(target, operation):
    target = Path(target).resolve()
    if target.exists():
        raise FileExistsError(f"输出已存在：{target}")
    # Same filesystem: publish only complete output, without overwriting a race winner.
    with tempfile.TemporaryDirectory(prefix=".crypt-sound-", dir=target.parent) as folder:
        temporary = Path(folder) / target.name
        operation(temporary)
        os.link(temporary, target)


def encode_file(source, target, codec):
    _atomic_output(target, lambda path: _encode_file(source, path, codec))


def decode_file(source, target, decoder):
    _atomic_output(target, lambda path: _decode_file(source, path, decoder))

# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
import asyncio
import base64
import binascii
import json
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path
import numpy as np
from fastapi import FastAPI, Header, HTTPException, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .dsp import Scrambler, StreamDecoder
from .media import decode_file, encode_file

WEB = Path(__file__).parent / "web"
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
RESULT_TTL_SECONDS = 15 * 60


def create_app(token: str, port: int = 8765):
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=["127.0.0.1", "localhost", "testserver"])
    origins = {f"http://127.0.0.1:{port}", f"http://localhost:{port}"}
    active = set()
    downloads = {}
    expiry_tasks = set()

    @app.get("/")
    async def index():
        return FileResponse(WEB / "index.html")

    @app.get("/client.js")
    async def client():
        return FileResponse(WEB / "client.js", media_type="application/javascript")

    @app.get("/capture.js")
    async def capture():
        return FileResponse(WEB / "capture.js", media_type="application/javascript")

    def check_local_request(request: Request, supplied_token: str):
        if request.headers.get("origin") not in origins:
            raise HTTPException(status_code=403, detail="本地网页来源无效")
        if not secrets.compare_digest(supplied_token, token):
            raise HTTPException(status_code=403, detail="本地访问令牌错误")

    async def expire_download(job_id: str, directory: str):
        await asyncio.sleep(RESULT_TTL_SECONDS)
        if downloads.pop(job_id, None) is not None:
            shutil.rmtree(directory, ignore_errors=True)

    @app.post("/api/process")
    async def process_file(
        request: Request,
        mode: str,
        filename: str = "audio",
        x_local_token: str = Header(default=""),
        x_audio_key_b64: str = Header(default=""),
    ):
        check_local_request(request, x_local_token)
        if mode not in {"encode", "decode"}:
            raise HTTPException(status_code=422, detail="请选择加密或解密")
        if not x_audio_key_b64 or len(x_audio_key_b64) > 6000:
            raise HTTPException(status_code=422, detail="密钥不能为空，且不能超过 1024 字符")
        try:
            audio_key = base64.b64decode(x_audio_key_b64, validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError):
            raise HTTPException(status_code=422, detail="音轨密钥编码无效")
        if not audio_key or len(audio_key) > 1024:
            raise HTTPException(status_code=422, detail="密钥不能为空，且不能超过 1024 字符")
        try:
            content_length = int(request.headers.get("content-length", "0"))
        except ValueError:
            raise HTTPException(status_code=400, detail="上传长度无效")
        if content_length > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="文件超过 2 GB 限制")

        safe_name = "".join(c for c in filename.replace("\\", "/").rsplit("/", 1)[-1] if c.isprintable()).strip()
        if not safe_name or safe_name in {".", ".."} or len(safe_name) > 255:
            raise HTTPException(status_code=400, detail="文件名无效")
        source_suffix = Path(safe_name).suffix.lower()
        stem = Path(safe_name).stem or "audio"
        if mode == "encode":
            result_suffix = source_suffix if source_suffix in {".mp4", ".mkv"} else ".wav"
            result_name = f"{stem}-encrypted{result_suffix}"
        else:
            result_suffix = ".wav"
            result_name = f"{stem}-decrypted.wav"

        directory = tempfile.mkdtemp(prefix="crypt-sound-web-")
        source_path = Path(directory) / f"source{source_suffix}"
        result_path = Path(directory) / f"result{result_suffix}"
        keep_result = False
        try:
            received = 0
            with source_path.open("wb") as output:
                async for chunk in request.stream():
                    received += len(chunk)
                    if received > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="文件超过 2 GB 限制")
                    output.write(chunk)
            if received == 0:
                raise HTTPException(status_code=422, detail="请选择一个非空文件")

            def process():
                codec = Scrambler(audio_key)
                if mode == "encode":
                    encode_file(source_path, result_path, codec)
                else:
                    decode_file(source_path, result_path, StreamDecoder(codec))

            await asyncio.to_thread(process)
            job_id = secrets.token_urlsafe(24)
            downloads[job_id] = {"directory": directory, "path": result_path, "filename": result_name}
            task = asyncio.create_task(expire_download(job_id, directory))
            expiry_tasks.add(task)
            task.add_done_callback(expiry_tasks.discard)
            keep_result = True
            return JSONResponse({"id": job_id, "filename": result_name}, headers={"Cache-Control": "no-store"})
        except HTTPException:
            raise
        except FileNotFoundError:
            raise HTTPException(status_code=503, detail="未找到 FFmpeg。请安装 FFmpeg 并确认 ffmpeg 位于 PATH。")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        except RuntimeError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        except subprocess.CalledProcessError:
            raise HTTPException(status_code=422, detail="FFmpeg 处理失败。请确认文件有效，并且视频文件包含视频轨道。")
        except OSError as exc:
            raise HTTPException(status_code=500, detail=f"本地文件处理失败：{exc}")
        finally:
            if not keep_result:
                shutil.rmtree(directory, ignore_errors=True)

    @app.get("/api/download/{job_id}")
    async def download_file(job_id: str, request: Request, token_query: str = Query(default="", alias="token")):
        origin = request.headers.get("origin")
        if origin is not None and origin not in origins:
            raise HTTPException(status_code=403, detail="本地网页来源无效")
        if not secrets.compare_digest(token_query, token):
            raise HTTPException(status_code=403, detail="本地访问令牌错误")
        result = downloads.pop(job_id, None)
        if result is None:
            raise HTTPException(status_code=404, detail="下载已过期或已使用，请重新处理文件")
        return FileResponse(
            result["path"],
            filename=result["filename"],
            media_type="application/octet-stream",
            headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer"},
            background=BackgroundTask(shutil.rmtree, result["directory"], ignore_errors=True),
        )

    @app.on_event("shutdown")
    async def cleanup_downloads():
        for task in tuple(expiry_tasks):
            task.cancel()
        if expiry_tasks:
            await asyncio.gather(*expiry_tasks, return_exceptions=True)
        for result in downloads.values():
            shutil.rmtree(result["directory"], ignore_errors=True)
        downloads.clear()

    @app.websocket("/stream")
    async def stream(ws: WebSocket):
        if ws.headers.get("origin") not in origins or len(active) >= 2:
            await ws.close(code=1008)
            return
        active.add(ws)
        try:
            await ws.accept()
            raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
            if len(raw) > 4096:
                raise ValueError("Handshake too large")
            hello = json.loads(raw)
            if not isinstance(hello, dict) or not isinstance(hello.get("token"), str):
                raise ValueError("Invalid handshake")
            if not secrets.compare_digest(hello["token"], token):
                await ws.close(code=1008, reason="本地访问令牌错误")
                return
            key = hello.get("key")
            if not isinstance(key, str):
                raise ValueError("Invalid key")
            decoder = StreamDecoder(await asyncio.to_thread(Scrambler, key))
            await ws.send_json({"ready": True, "rate": 48000})
            while True:
                raw = await asyncio.wait_for(ws.receive_bytes(), timeout=30)
                if not raw or len(raw) > 65536 or len(raw) % 8:
                    raise ValueError("Invalid PCM length")
                blocks = await asyncio.to_thread(decoder.feed, np.frombuffer(raw, "<f4").reshape(-1, 2))
                for block in blocks:
                    await ws.send_bytes(block.astype("<f4").tobytes())
                await ws.send_json({"packets": decoder.packets, "discarded": decoder.discarded})
        except WebSocketDisconnect:
            pass
        except (ValueError, TypeError, KeyError, asyncio.TimeoutError):
            await ws.close(code=1008, reason="无效输入或连接超时")
        finally:
            active.discard(ws)
    return app

# SPDX-License-Identifier: GPL-3.0-only
# This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
import argparse
import getpass
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from .dsp import Scrambler, StreamDecoder
from .media import encode_file, decode_file


def _open_browser_when_ready(url, port):
    health_url = f"http://127.0.0.1:{port}/"
    for _ in range(150):
        try:
            with urllib.request.urlopen(health_url, timeout=0.5) as response:
                if response.status == 200:
                    webbrowser.open(url, new=2)
                    return
        except (urllib.error.URLError, TimeoutError, OSError):
            time.sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description="CS2 整轨扰乱原型（不是强加密）")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("encode", "decode"):
        cmd = sub.add_parser(name)
        cmd.add_argument("input", type=Path)
        cmd.add_argument("output", type=Path)
        cmd.add_argument("--key-file", type=Path, help="读取 UTF-8 密钥文件，去除尾部换行")
    serve = sub.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--open-browser", action="store_true", help="服务启动后自动打开本地工作台")
    args = parser.parse_args()
    try:
        if args.command == "serve":
            import uvicorn
            from .server import create_app
            token = secrets.token_urlsafe(32)
            page_url = f"http://127.0.0.1:{args.port}/#{token}"
            print(f"本地工作台：{page_url}", flush=True)
            print("仅监听本机。可在工作台加密/解密文件，或启动实时标签页解码。", flush=True)
            app = create_app(token, args.port)
            if args.open_browser:
                threading.Thread(target=_open_browser_when_ready, args=(page_url, args.port), daemon=True).start()
            uvicorn.run(app, host="127.0.0.1", port=args.port,
                        ws_max_size=65536, ws_max_queue=4, access_log=False)
            return
        key = args.key_file.read_text(encoding="utf-8-sig").rstrip("\r\n") if args.key_file else getpass.getpass("音轨密钥：")
        codec = Scrambler(key)
        if args.command == "encode":
            encode_file(args.input, args.output, codec)
        else:
            decoder = StreamDecoder(codec)
            decode_file(args.input, args.output, decoder)
            print(f"已恢复 {decoder.packets} 个一秒音频包")
        print(f"完成：{args.output.resolve()}")
    except (ValueError, OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"错误：{exc}\n")


if __name__ == "__main__":
    main()

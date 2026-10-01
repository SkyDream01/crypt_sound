# 开发指南

[返回首页](../README.md)

## 环境与检查

需要 Python 3.11+、FFmpeg / ffprobe；完整测试还需要 Node.js（建议 22+）。
从仓库根目录运行：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e ".[test]"
.\.venv\Scripts\python.exe -m pytest -q
node --test tests/test_userscript_links.cjs
.\.venv\Scripts\python.exe scripts/benchmark.py
```

Linux / macOS 将 Python 路径替换为 .venv/bin/python。缺少 Node.js 会跳过 Python 中的油猴兼容性测试，因此跳过不能作为完整验证通过。

## 目录约定

源码放在 crypt_sound/，单文件油猴发布入口放在 userscript/，回归测试放在 tests/，开发工具放在 scripts/，说明文档放在 docs/。
output/、build/、dist/、虚拟环境及缓存为本地产物，不纳入版本控制。不要提交真实音视频、密钥、访问令牌和登录数据。

Python 包版本位于 pyproject.toml，油猴版本位于脚本 @version；两者独立演进。涉及 CS2 格式的改动必须同时核对 Python 与 JavaScript 实现，并更新格式文档和跨语言测试。

## 构建发布包

```powershell
.\.venv\Scripts\python.exe -m pip install build
.\.venv\Scripts\python.exe -m build
```

源码包包含文档、测试、油猴脚本及启动脚本；wheel 包含 Python 模块、本地网页资源和许可证。油猴通过仓库中的单文件脚本独立安装，不由 pip 安装到 Tampermonkey。

发布前检查源码包和 wheel 中的 LICENSE、元数据与网页资源，在干净环境安装 wheel 后执行 crypt-sound --help。运行完整测试；涉及平台请求或播放行为的改动按[验证说明](VALIDATION.md)复测 B 站链路。发布包不要附带 output/ 中的音频或 private.key。

## 文件与参考

- `crypt_sound/dsp.py`：CS2 信号格式与增量同步解码。
- `crypt_sound/media.py`、`cli.py`：FFmpeg 文件编码、解码、视频音轨替换。
- `crypt_sound/server.py`、`web/`：本地 WebSocket 服务与浏览器捕获播放。
- `userscript/crypt-sound.user.js`：单文件 B 站独立解码器（含音频链接解析、下载、Worker DSP 与同步播放）。
- `tests/test_userscript.py`：Node.js 与 Python CS2 格式兼容性测试。
- `tests/test_userscript_links.cjs`：Node 测试，覆盖视频/分 P 识别、音频地址排序与过滤、WBI 签名、页面播放信息、普通 fetch 与 CORS 回退、HTTP 412 分阶段诊断、备用下载、边解密边播放、未解密位置等待恢复、播放同步、取消及切集清理；网络和浏览器使用模拟对象，不代表 B 站端到端验收。

实现参考：[SciPy DCT](https://docs.scipy.org/doc/scipy/reference/generated/scipy.fft.dct.html)、[FastAPI WebSockets](https://fastapi.tiangolo.com/advanced/websockets/)、[标签页捕获 API](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)、[抑制源声音](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackSettings/suppressLocalAudioPlayback)、[Tampermonkey API](https://www.tampermonkey.net/documentation.php)。

WBI 请求流程核对参考：[yt-dlp Bilibili 提取器实现](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)。

若遇 HTTP 412，先确认原页面可正常播放并完成页面要求的验证，避免连续点击重试。新版错误会明确失败阶段；这些请求兼容性改动不能保证解除平台拒绝，遇到新的平台拒绝仍需实际页面排查。

# 第三方依赖与参考

项目原创代码和文档使用 GPL-3.0-only，见 [LICENSE](LICENSE)。依赖与外部工具保留各自许可证，项目许可声明不改变它们的许可。

## 运行及开发依赖

Python 依赖由 pyproject.toml 声明，通过 pip 单独安装：NumPy、SciPy、FastAPI、Uvicorn 及其传递依赖；测试依赖为 pytest、HTTPX。构建使用 setuptools。具体发行版本及其附带组件的许可，以安装包内的许可证和上游声明为准。

FFmpeg / ffprobe 为外部命令行工具，本仓库不包含其二进制。若另行捆绑分发，应核对所选 FFmpeg 构建及其组件的许可。Node.js 用于 JavaScript 测试；浏览器与 Tampermonkey 为用户另行安装的播放环境。

## 实现参考

- [SciPy DCT 文档](https://docs.scipy.org/doc/scipy/reference/generated/scipy.fft.dct.html)：信号变换 API。
- [FastAPI WebSocket 文档](https://fastapi.tiangolo.com/advanced/websockets/)：本地实时接口。
- [Tampermonkey API 文档](https://www.tampermonkey.net/documentation.php)：油猴权限与请求接口。
- [yt-dlp Bilibili 提取器](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/bilibili.py)：WBI 请求流程核对参考。

上述链接用于说明参考来源，不表示这些项目为本项目背书。本清单不是传递依赖的完整物料清单；若引入或分发第三方源码、资源或二进制，需同步补充其版本、许可和原有声明。

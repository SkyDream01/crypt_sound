// SPDX-License-Identifier: GPL-3.0-only
// This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
'use strict';
const $ = id => document.getElementById(id);
const status = text => { $('status').textContent = text; };
$('token').value = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

for (const mode of ['encrypt', 'decrypt']) {
  const input = $(`${mode}-file`);
  const drop = $(`${mode}-drop`);
  const fileLabel = $(`${mode}-file-label`);
  const fileMeta = $(`${mode}-file-meta`);
  const form = $(`${mode}-form`);
  const button = form.querySelector('button[type="submit"]');
  const formStatus = $(`${mode}-status`);
  const progressWrap = $(`${mode}-progress-wrap`);
  const progress = $(`${mode}-progress`);
  const progressLabel = $(`${mode}-progress-label`);
  const download = $(`${mode}-download`);
  download.addEventListener('click', () => {
    window.setTimeout(() => {
      download.hidden = true;
      formStatus.textContent = '下载已发起。若需再次获取，请重新处理原文件。';
    }, 0);
  });
  const showError = message => {
    progressWrap.hidden = true;
    formStatus.classList.add('error');
    formStatus.textContent = message;
    button.disabled = false;
  };

  const showFile = file => {
    if (!file) {
      fileLabel.textContent = '拖入文件，或点击选择';
      fileMeta.textContent = '尚未选择文件';
      return;
    }
    fileLabel.textContent = file.name;
    fileMeta.textContent = `${file.name} · ${formatSize(file.size)}`;
  };
  input.addEventListener('change', () => showFile(input.files[0]));
  for (const eventName of ['dragenter', 'dragover']) {
    drop.addEventListener(eventName, event => {
      event.preventDefault();
      drop.classList.add('drag-over');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    drop.addEventListener(eventName, event => {
      event.preventDefault();
      drop.classList.remove('drag-over');
    });
  }
  drop.addEventListener('drop', event => {
    const file = event.dataTransfer.files[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    showFile(file);
  });

  form.addEventListener('submit', event => {
    event.preventDefault();
    const file = input.files[0];
    const key = $(`${mode}-key`).value;
    const token = $('token').value;
    if (!file) { formStatus.textContent = '请先选择文件。'; return; }
    if (!key) { formStatus.textContent = '请填写音轨密钥。'; return; }
    if (!token) { formStatus.textContent = '请填写启动服务时显示的本地访问令牌。'; $('token').focus(); return; }
    if (file.size > 2 * 1024 * 1024 * 1024) { formStatus.textContent = '文件超过 2 GB 限制。'; return; }

    const action = mode === 'encrypt' ? '加密' : '解密';
    const xhr = new XMLHttpRequest();
    const query = new URLSearchParams({mode: mode === 'encrypt' ? 'encode' : 'decode', filename: file.name});
    const encodedKey = btoa(String.fromCharCode(...new TextEncoder().encode(key)));
    button.disabled = true;
    download.hidden = true;
    formStatus.classList.remove('error');
    progressWrap.hidden = false;
    progress.value = 0;
    progressLabel.textContent = '准备上传';
    formStatus.textContent = `${action}任务准备中…`;
    xhr.open('POST', `/api/process?${query.toString()}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Local-Token', token);
    xhr.setRequestHeader('X-Audio-Key-B64', encodedKey);
    xhr.responseType = 'json';
    xhr.upload.addEventListener('progress', event => {
      if (!event.lengthComputable) {
        progressLabel.textContent = '正在上传文件';
        formStatus.textContent = '正在上传到本机服务…';
        return;
      }
      const percent = Math.round(event.loaded / event.total * 100);
      progress.value = percent;
      progressLabel.textContent = `${percent}%`;
      formStatus.textContent = percent >= 100 ? '上传完成，正在本机处理…' : `正在上传到本机服务 · ${percent}%`;
    });
    xhr.upload.addEventListener('load', () => {
      progress.value = 100;
      progressLabel.textContent = '处理中';
      formStatus.textContent = '文件已上传，正在本机处理…';
    });
    xhr.addEventListener('load', () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        const detail = xhr.response?.detail || '处理失败，请确认文件和密钥后重试。';
        showError(detail);
        return;
      }
      const result = xhr.response;
      if (!result?.id || !result?.filename) {
        showError('本机服务返回了无效结果。');
        return;
      }
      const href = `/api/download/${encodeURIComponent(result.id)}?token=${encodeURIComponent(token)}`;
      download.href = href;
      download.download = result.filename;
      download.textContent = `下载 ${result.filename}`;
      download.hidden = false;
      progressWrap.hidden = true;
      formStatus.textContent = `${action}完成，请点击下方链接下载结果。`;
      button.disabled = false;
    });
    xhr.addEventListener('error', () => {
      showError('无法连接本机服务。请确认服务仍在运行，并检查访问令牌。');
    });
    xhr.addEventListener('abort', () => {
      progressWrap.hidden = true;
      formStatus.textContent = '处理已取消。';
      button.disabled = false;
    });
    xhr.send(file);
  });
}

let session = null;
let generation = 0;
function stop(message = '已停止') {
  generation++;
  if (session) {
    const s = session; session = null;
    s.ws?.close(); s.stream?.getTracks().forEach(t => t.stop());
    s.sources?.forEach(n => { try { n.stop(); } catch {} });
    s.ctx?.close();
  }
  $('start').disabled = false; $('stop').disabled = true; status(message);
}
$('stop').onclick = () => stop();
window.addEventListener('pagehide', () => stop());
$('start').onclick = async () => {
  if (!$('token').value || !$('key').value) { status('请填写本地访问令牌和音轨密钥'); return; }
  const id = ++generation;
  const s = {sources: new Set(), next: 0, packets: 0}; session = s;
  $('start').disabled = true; $('stop').disabled = false;
  try {
    // Must be requested directly during this click's transient user activation.
    s.stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {suppressLocalAudioPlayback: true, echoCancellation: false, noiseSuppression: false, autoGainControl: false},
      selfBrowserSurface: 'exclude', systemAudio: 'exclude', surfaceSwitching: 'exclude'
    });
    if (id !== generation) { s.stream.getTracks().forEach(t => t.stop()); return; }
    const track = s.stream.getAudioTracks()[0];
    if (!track) throw Error('没有捕获到音频。请选择浏览器标签页并勾选共享音频。');
    if (s.stream.getVideoTracks()[0]?.getSettings().displaySurface !== 'browser')
      throw Error('请选择视频所在的浏览器标签页，不能选择桌面或窗口。');
    if (track.getSettings().suppressLocalAudioPlayback !== true)
      throw Error('当前浏览器未启用源声音抑制，请使用支持 suppressLocalAudioPlayback 的 Chrome / Edge。');
    s.stream.getTracks().forEach(t => t.addEventListener('ended', () => { if (session === s) stop('共享已结束'); }));
    s.ctx = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
    await s.ctx.resume();
    if (s.ctx.sampleRate !== 48000) throw Error('浏览器无法提供 48 kHz 音频上下文');
    await s.ctx.audioWorklet.addModule('/capture.js');
    if (id !== generation) return;
    s.ws = new WebSocket(`ws://${location.host}/stream`); s.ws.binaryType = 'arraybuffer';
    s.ws.onopen = () => s.ws.send(JSON.stringify({token: $('token').value, key: $('key').value}));
    s.ws.onerror = () => { if (session === s) stop('连接本地服务失败'); };
    s.ws.onclose = event => { if (session === s) stop(`本地连接已关闭：${event.reason || event.code}`); };
    s.ws.onmessage = event => {
      if (session !== s) return;
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        if (msg.ready) {
          const source = s.ctx.createMediaStreamSource(s.stream);
          const capture = new AudioWorkletNode(s.ctx, 'capture');
          capture.port.onmessage = e => {
            if (session !== s || s.ws.readyState !== WebSocket.OPEN) return;
            if (s.ws.bufferedAmount > 384000) { stop('本地解码跟不上输入，已停止，避免延迟持续增长'); return; }
            s.ws.send(e.data);
          };
          source.connect(capture); capture.connect(s.ctx.destination);
          s.capture = capture; s.input = source;
          status('正在寻找 CS2 同步信号…');
        } else if (msg.packets !== undefined) {
          status(msg.packets ? `已恢复 ${msg.packets} 秒音频 · 等待后续音频包\n当前播放缓冲 ${Math.max(0, s.next-s.ctx.currentTime).toFixed(2)} 秒` : '寻找同步信号…请确认播放的是 CS2 视频、1 倍速、音量 100%');
        }
        return;
      }
      const pcm = new Float32Array(event.data);
      if (pcm.length !== 96000) { stop('服务返回了无效音频包'); return; }
      const buffer = s.ctx.createBuffer(2, 48000, 48000);
      for (let c = 0; c < 2; c++) {
        const out = buffer.getChannelData(c);
        for (let i = 0; i < out.length; i++) out[i] = Math.max(-0.95, Math.min(0.95, pcm[i*2+c])) * 0.65;
      }
      const now = s.ctx.currentTime;
      if (s.next - now > 2.5) { stop('播放积压超过限制，请重新连接'); return; }
      s.next = Math.max(s.next, now + 0.06);
      const node = s.ctx.createBufferSource(); node.buffer = buffer; node.connect(s.ctx.destination);
      s.sources.add(node); node.onended = () => s.sources.delete(node);
      node.start(s.next); s.next += 1;
    };
  } catch (error) { if (id === generation) stop(error.message); }
};

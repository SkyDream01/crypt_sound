// ==UserScript==
// @name         Crypt Sound Bilibili 独立解码
// @namespace    crypt-sound.local
// @version      0.5.0
// @license      GPL-3.0-only
// @description  浏览器内独立恢复 CS2 音轨，无需 Python、本地服务或外部依赖
// @match        https://www.bilibili.com/*
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @connect      bilivideo.net
// @run-at       document-idle
// ==/UserScript==
// SPDX-License-Identifier: GPL-3.0-only
// This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
'use strict';

const MAX_AUDIO_BYTES = 96 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 15 * 60;
// MD5 is used only for Bilibili's WBI request signature, never for audio keys.
function md5(text) {
  const bytes = new TextEncoder().encode(text), size = Math.ceil((bytes.length+9)/64)*64;
  const padded = new Uint8Array(size); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(size-8, bytes.length*8 >>> 0, true);
  view.setUint32(size-4, Math.floor(bytes.length/536870912), true);
  const state = [0x67452301,0xefcdab89,0x98badcfe,0x10325476];
  const shifts = [[7,12,17,22],[5,9,14,20],[4,11,16,23],[6,10,15,21]];
  for (let block=0;block<size;block+=64) {
    let [a,b,c,d] = state;
    for (let i=0;i<64;i++) {
      const round = i>>4;
      const f = round===0 ? (b&c)|(~b&d) : round===1 ? (d&b)|(~d&c) : round===2 ? b^c^d : c^(b|~d);
      const g = round===0 ? i : round===1 ? (5*i+1)%16 : round===2 ? (3*i+5)%16 : 7*i%16;
      const sum = (a+f+Math.floor(Math.abs(Math.sin(i+1))*4294967296)+view.getUint32(block+g*4,true))|0;
      const shift = shifts[round][i%4];
      [a,b,c,d] = [d,(b+((sum<<shift)|(sum>>>(32-shift))))|0,b,c];
    }
    [a,b,c,d].forEach((v,i) => { state[i]=(state[i]+v)|0; });
  }
  return state.map(v => Array.from({length:4},(_,i) => ((v>>>(i*8))&255).toString(16).padStart(2,'0')).join('')).join('');
}
function wbiQuery(params, nav, now = Math.floor(Date.now()/1000)) {
  const images = nav.data?.wbi_img;
  const keys = [images?.img_url,images?.sub_url].map(url => typeof url==='string' ? url.split('/').pop().split('.')[0] : '');
  // nav can return -101 for a logged-out viewer while still supplying WBI keys.
  if (!keys.every(key => /^[a-f0-9]{32}$/i.test(key))) throw Error(`无法获取 WBI 签名参数（code=${nav.code ?? '未知'}），请刷新 B 站页面后重试`);
  const indices = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13];
  const combined = keys.join(''), mixin = indices.map(i => combined[i]).join('');
  const values = {...params,wts:now};
  const query = Object.keys(values).sort().map(key => `${encodeURIComponent(key)}=${encodeURIComponent(String(values[key]).replace(/[!'()*]/g,''))}`).join('&');
  return `${query}&w_rid=${md5(query+mixin)}`;
}
function videoIdentity(href) {
  const url = new URL(href), match = url.pathname.match(/^\/video\/(BV[0-9A-Za-z]+|av\d+)(?:\/|$)/i);
  if (!match) throw Error('请在普通 B 站视频页打开解码（暂不支持直播、番剧）');
  const part = Number(url.searchParams.get('p') || 1);
  if (!Number.isSafeInteger(part) || part < 1) throw Error('无效的分 P 编号');
  return {id:match[1], part};
}
function audioCandidates(payload) {
  if (payload.code !== 0) throw Error(`B 站播放接口错误（code=${payload.code ?? '未知'}）：${payload.message || '未提供原因'}。请确认视频可正常播放；若提示风控，请稍后重试`);
  const tracks = payload.data?.dash?.audio;
  if (!Array.isArray(tracks) || !tracks.length) throw Error('未返回独立 DASH 音频；请确认已登录且视频可正常播放');
  const urls = [];
  for (const track of [...tracks].sort((a,b) => Number(b.bandwidth || 0)-Number(a.bandwidth || 0))) {
    for (const value of [track.baseUrl, track.base_url, ...(track.backupUrl || track.backup_url || [])]) {
      if (typeof value !== 'string') continue;
      try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value);
        if (url.protocol === 'https:' && /(^|\.)bilivideo\.(com|cn|net)$/.test(url.hostname) && !url.username && !url.password) urls.push(url.href);
      } catch {}
    }
  }
  if (!urls.length) throw Error('没有可用的 B 站音频 CDN 地址');
  return [...new Set(urls)];
}

function requestFailure(url, status) {
  const parsed = new URL(url);
  const stage = parsed.pathname === '/x/web-interface/view' ? '视频信息接口' :
    parsed.pathname === '/x/web-interface/nav' ? 'WBI 参数接口' :
    parsed.pathname === '/x/player/wbi/playurl' ? '播放地址接口' : '音频 CDN';
  // Never display signed query strings, tokens or cookies in errors.
  const error = Error(`${stage}请求失败（HTTP ${status}，${parsed.hostname}）${status === 412 ? '。请求被拒绝，请先在原页面确认视频可播放、完成页面验证后再试；不要连续重试' : ''}`);
  error.status = status;
  return error;
}

function pageSnapshot(root, href) {
  try {
    const identity = videoIdentity(href), initial = root.__INITIAL_STATE__, video = initial?.videoData;
    if (!video || (identity.id !== video.bvid && identity.id.toLowerCase() !== `av${video.aid}`)) return null;
    const page = video.pages?.find(p => p.page === identity.part);
    if (!page?.cid || Number(initial.cid) !== Number(page.cid)) return null;
    const play = root.__playinfo__;
    // Capture once at script startup: do not pair an old playinfo with new SPA metadata.
    if (play?.data?.cid && Number(play.data.cid) !== Number(page.cid)) return null;
    return JSON.parse(JSON.stringify({identity,video,play,captured:Date.now()}));
  } catch { return null; }
}

// Self-contained worker body, also exported under Node for compatibility tests.
function decoderWorker() {
  const RATE = 48000, N = 1024, PAYLOAD = 45056, PILOT_SIZE = 2048;
  function fft(re, im, inverse = false) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len *= 2) {
      const a = (inverse ? 2 : -2) * Math.PI / len, cr = Math.cos(a), ci = Math.sin(a);
      for (let start = 0; start < n; start += len) {
        let wr = 1, wi = 0;
        for (let k = 0; k < len / 2; k++) {
          const i = start + k, j = i + len / 2;
          const tr = wr * re[j] - wi * im[j], ti = wr * im[j] + wi * re[j];
          re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
          const next = wr * cr - wi * ci; wi = wr * ci + wi * cr; wr = next;
        }
      }
    }
    if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
  }
  // Bluestein supports both CS2's 45056 payload and 48000 output exactly.
  const plans = new Map();
  function arbitraryFFT(real, imag, inverse = false) {
    const n = real.length;
    if (!plans.has(n)) {
      let size = 1; while (size < 2 * n - 1) size *= 2;
      const cos = new Float64Array(n), sin = new Float64Array(n);
      const br = new Float64Array(size), bi = new Float64Array(size);
      for (let i = 0; i < n; i++) {
        const a = Math.PI * ((i * i) % (2 * n)) / n;
        cos[i] = Math.cos(a); sin[i] = Math.sin(a);
        br[i] = cos[i]; bi[i] = sin[i];
        if (i) { br[size-i] = cos[i]; bi[size-i] = sin[i]; }
      }
      fft(br, bi); plans.set(n, {size, cos, sin, br, bi});
    }
    const {size, cos, sin, br, bi} = plans.get(n);
    const ar = new Float64Array(size), ai = new Float64Array(size);
    for (let i = 0; i < n; i++) {
      const v = inverse ? -imag[i] : imag[i];
      ar[i] = real[i] * cos[i] + v * sin[i]; ai[i] = v * cos[i] - real[i] * sin[i];
    }
    fft(ar, ai);
    for (let i = 0; i < size; i++) {
      const r = ar[i] * br[i] - ai[i] * bi[i]; ai[i] = ar[i] * bi[i] + ai[i] * br[i]; ar[i] = r;
    }
    fft(ar, ai, true);
    for (let i = 0; i < n; i++) {
      real[i] = (ar[i] * cos[i] + ai[i] * sin[i]) / (inverse ? n : 1);
      imag[i] = (ai[i] * cos[i] - ar[i] * sin[i]) * (inverse ? -1 / n : 1);
    }
  }
  function resample(input) {
    const r = Float64Array.from(input), im = new Float64Array(PAYLOAD);
    arbitraryFFT(r, im);
    const out = new Float64Array(RATE), oi = new Float64Array(RATE), half = PAYLOAD / 2;
    out.set(r.subarray(0, half)); oi.set(im.subarray(0, half));
    out.set(r.subarray(half + 1), RATE - half + 1); oi.set(im.subarray(half + 1), RATE - half + 1);
    out[half] = out[RATE-half] = r[half] / 2;
    oi[half] = oi[RATE-half] = im[half] / 2;
    arbitraryFFT(out, oi, true);
    for (let i = 0; i < RATE; i++) out[i] *= RATE / PAYLOAD;
    return out;
  }
  const digest = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  async function mapping(password) {
    if (!password || [...password].length > 1024) throw Error('密钥不能为空，且不能超过 1024 字符');
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    // Historical salt is part of the CS2 wire format.
    let seed = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:new TextEncoder().encode('crypt-sound-CS1'), iterations:100000}, key, 256));
    let order;
    do {
      if (order) seed = await digest(seed);
      const hashes = await Promise.all(Array.from({length:16}, (_, i) => digest(new Uint8Array([...seed, i]))));
      order = Array.from({length:16}, (_, i) => i).sort((a,b) => {
        for (let j = 0; j < 32; j++) if (hashes[a][j] !== hashes[b][j]) return hashes[a][j] - hashes[b][j];
        return 0;
      });
    } while (order.some((v,i) => v === i));
    const seed2 = new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2', hash:'SHA-256', salt:new TextEncoder().encode('crypt-sound-CS2'), iterations:100000}, key, 256));
    const masks = [];
    for (let domain = 0; domain < 2; domain++) {
      const rows = [];
      for (let block = 0; block < 44; block++) {
        const hashes = await Promise.all([0,1,2].map(counter => digest(new Uint8Array([...seed2,domain,block,counter]))));
        const raw = new Uint8Array(96); hashes.forEach((h,i) => raw.set(h,i*32));
        rows.push(Float64Array.from({length:640}, (_,i) => raw[i>>3] & (1<<(i%8)) ? 1 : -1));
      }
      masks.push(rows);
    }
    return {indices: order.flatMap(b => Array.from({length:40}, (_, j) => b*40+39-j)), signs: Array.from({length:640}, (_, i) => seed[Math.floor(i/40)] & 1 ? 1 : -1), pre:masks[0], post:masks[1]};
  }
  // Orthonormal DCT-II transpose: undo diffusion across the 44 time blocks.
  const temporal = Array.from({length:44}, (_,b) => Float64Array.from({length:44}, (_,j) =>
    Math.cos(Math.PI*(b+0.5)*j/44) * (j ? Math.sqrt(2/44) : 1/Math.sqrt(44))));
  function decode(packet, map) {
    let pilotDot = 0;
    for (let i = 0; i < PILOT_SIZE; i++) pilotDot += (packet[2*i]+packet[2*i+1])*pilot[i];
    if (pilotDot >= 0) throw Error('仅支持 CS2 音轨');
    const output = new Float32Array(RATE * 2);
    for (let c = 0; c < 2; c++) {
      const data = new Float64Array(PAYLOAD);
      const spectral = [];
      for (let b = 0; b < 44; b++) {
        const r = new Float64Array(N*2), im = new Float64Array(N*2);
        for (let i = 0; i < N; i++) r[i] = r[2*N-1-i] = packet[(2304+b*N+i)*2+c] / 0.22;
        fft(r, im);
        const coeff = new Float64Array(640);
        for (let k = 0; k < 640; k++) {
          const a = Math.PI*k/(2*N);
          coeff[k] = (r[k]*Math.cos(a)+im[k]*Math.sin(a)) * (k ? 1/Math.sqrt(2*N) : 1/(2*Math.sqrt(N))) * map.post[b][k];
        }
        spectral.push(coeff);
      }
      for (let b = 0; b < 44; b++) {
        const coeff = new Float64Array(N);
        for (let k = 0; k < 640; k++) {
          let value = 0;
          for (let j = 0; j < 44; j++) value += temporal[b][j]*spectral[j][k];
          value *= map.pre[b][k];
          coeff[map.indices[k]] = value*map.signs[k];
        }
        const r = new Float64Array(N*2), im = new Float64Array(N*2);
        for (let k = 0; k < N; k++) {
          const a = Math.PI*k/(2*N), v = coeff[k]*(k ? Math.sqrt(2*N) : 2*Math.sqrt(N));
          r[k] = v*Math.cos(a); im[k] = v*Math.sin(a);
          if (k) { r[2*N-k] = r[k]; im[2*N-k] = -im[k]; }
        }
        fft(r, im, true); data.set(r.subarray(0,N), b*N);
      }
      const channel = resample(data);
      for (let i = 0; i < RATE; i++) output[2*i+c] = channel[i];
    }
    return output;
  }
  const pilot = Float64Array.from({length:PILOT_SIZE}, (_, i) => {
    const t = i/RATE, duration = (PILOT_SIZE-1)/RATE;
    return Math.cos(2*Math.PI*(900*t + 0.5*(8500-900)/duration*t*t)) * (0.5-0.5*Math.cos(2*Math.PI*i/(PILOT_SIZE-1))) * 0.65;
  });
  const pilotEnergy = pilot.reduce((s,v) => s+v*v,0);
  class StreamDecoder {
    constructor(map) { this.map = map; this.buffer = new Float32Array(0); this.locked = false; this.packets = 0; this.offset = 0; this.starts = []; }
    discard(samples) { this.buffer = this.buffer.slice(samples*2); this.offset += samples; }
    feed(input) {
      if (input.length % 2 || input.length > RATE*8 || !input.every(Number.isFinite)) throw Error('无效 PCM 输入');
      const joined = new Float32Array(this.buffer.length+input.length); joined.set(this.buffer); joined.set(input,this.buffer.length); this.buffer = joined;
      const output = [];
      this.starts = [];
      while (this.buffer.length >= PILOT_SIZE*2) {
        if (!this.locked) {
          const length = this.buffer.length/2, count = length-PILOT_SIZE+1;
          let size = 1; while (size < length+PILOT_SIZE-1) size *= 2;
          const r = new Float64Array(size), im = new Float64Array(size), pr = new Float64Array(size), pi = new Float64Array(size);
          const energy = new Float64Array(length+1);
          for (let i = 0; i < length; i++) { r[i] = (this.buffer[2*i]+this.buffer[2*i+1])/2; energy[i+1] = energy[i]+r[i]*r[i]; }
          for (let i = 0; i < PILOT_SIZE; i++) pr[i] = pilot[PILOT_SIZE-1-i];
          fft(r,im); fft(pr,pi);
          for (let i = 0; i < size; i++) { const v = r[i]*pr[i]-im[i]*pi[i]; im[i] = r[i]*pi[i]+im[i]*pr[i]; r[i] = v; }
          fft(r,im,true);
          let first = -1, best = -1, peak = -Infinity;
          for (let i = 0; i < count; i++) {
            const score = Math.abs(r[i+PILOT_SIZE-1])/Math.sqrt(Math.max(energy[i+PILOT_SIZE]-energy[i],1e-12)*pilotEnergy);
            if (first < 0 && score > 0.72) first = i;
            if (first >= 0) {
              if (i >= first+128) break;
              if (score > peak) { peak = score; best = i; }
            }
          }
          if (best < 0) { this.discard(count); break; }
          // Reject positive pilots at their true peak, including their sidelobes.
          if (r[best+PILOT_SIZE-1] >= 0) { this.discard(best+PILOT_SIZE); continue; }
          this.discard(best); this.locked = true;
        }
        if (this.buffer.length < RATE*2) break;
        this.starts.push(this.offset);
        output.push(decode(this.buffer.subarray(0,RATE*2),this.map)); this.packets++;
        this.discard(RATE); this.locked = false;
      }
      return output;
    }
  }
  if (typeof module !== 'undefined') { module.exports = {mapping, decode, StreamDecoder, videoIdentity, audioCandidates, md5, wbiQuery, requestFailure, pageSnapshot}; return; }
  let decoder;
  self.onmessage = async ({data}) => {
    try {
      if (data.key !== undefined) { decoder = new StreamDecoder(await mapping(data.key)); self.postMessage({ready:true}); }
      else {
        decoder.feed(new Float32Array(data.pcm)).forEach((pcm,i) => self.postMessage({pcm:pcm.buffer, start:decoder.starts[i]},[pcm.buffer]));
        self.postMessage({ack:true, packets:decoder.packets, frontier:decoder.offset});
      }
    } catch (e) { self.postMessage({error:e.message}); }
  };
}

if (typeof module !== 'undefined' && module.exports) decoderWorker();
else (() => {
  let snapshot = pageSnapshot(typeof unsafeWindow === 'undefined' ? window : unsafeWindow, location.href);
  let popup;
  function open() {
    if (popup && !popup.closed) { popup.focus(); return; }
    popup = window.open('about:blank', '_blank', 'popup,width=640,height=560');
    if (!popup) { alert('请允许弹出窗口后重试。'); return; }
    const win = popup, doc = win.document;
    doc.title = 'Crypt Sound 独立解码';
    doc.body.innerHTML = `<main><h1>Crypt Sound 独立解码</h1><p>直接解析当前视频分 P 的音频链接，无需录音或共享标签页。</p><label>音轨密钥 <input id="key" type="password" autocomplete="off"></label><p><button id="start">解析音频并解码</button> <button id="stop" disabled>停止</button></p><label>恢复音量 <input id="volume" type="range" min="0" max="1" step="0.01" value="0.35"></label><p id="status" role="status">等待开始。请保持此窗口及原视频页面打开。</p><p>下载并转换音轨后，恢复首包即可在原页面播放，后续边解密边播放。跳到未解密位置会暂停等待。声音自动跟随暂停、跳转和倍速。支持 CS2；错误密钥也会产生声音。</p><p>当前支持普通视频及分 P，单 P 最长 15 分钟、音轨最大 96 MB。长音轨处理需要时间和较多内存。</p></main>`;
    Object.assign(doc.body.style,{background:'#10231f',color:'#dcf5ed',font:'16px/1.7 system-ui',padding:'24px'});
    const $ = id => doc.getElementById(id);
    let session = null;
    function stop(message = '已停止') {
      const s = session; session = null;
      if (s) {
        s.controller.abort(); s.worker?.terminate(); clearInterval(s.timer);
        s.listeners.forEach(([event, listener]) => s.video.removeEventListener(event,listener));
        for (const node of s.sources) { try { node.stop(); } catch {} }
        if (s.muted !== undefined) s.video.muted = s.muted;
        s.ctx?.close().catch(() => {});
        s.urls.forEach(url => URL.revokeObjectURL(url));
        s.input = s.output = null;
      }
      $('start').disabled = false; $('stop').disabled = true; $('status').textContent = message;
    }
    async function request(s, url, binary = false) {
      // Normal API fetch keeps the page's browser request context and cookie handling.
      // Only a network/CORS failure falls back to GM; HTTP rejection is not retried.
      if (!binary && typeof window.fetch === 'function') {
        const controller = new AbortController();
        const cancel = () => controller.abort();
        s.controller.signal.addEventListener('abort',cancel,{once:true});
        const timeout = setTimeout(cancel,30000);
        try {
          if (s.controller.signal.aborted) throw Error('已取消');
          const response = await window.fetch(url,{credentials:'include',signal:controller.signal,referrer:location.href});
          if (!response.ok) throw requestFailure(url,response.status);
          const payload = await response.json();
          if (!payload || typeof payload !== 'object') throw Error('B 站接口返回了无效数据');
          return payload;
        } catch (e) {
          if (s.controller.signal.aborted) throw Error('已取消');
          if (controller.signal.aborted) throw Error('B 站接口请求超时，请稍后重试');
          if (e.name !== 'TypeError') throw e;
        } finally {
          clearTimeout(timeout); s.controller.signal.removeEventListener('abort',cancel);
        }
      }
      return new Promise((resolve,reject) => {
        const signal = s.controller.signal;
        if (signal.aborted) { reject(Error('已取消')); return; }
        let handle, done = false;
        const finish = (error,value) => {
          if (done) return;
          done = true; signal.removeEventListener('abort',cancel);
          error ? reject(error) : resolve(value);
        };
        const cancel = () => { finish(Error('已取消')); handle?.abort(); };
        signal.addEventListener('abort',cancel,{once:true});
        try {
          handle = GM_xmlhttpRequest({method:'GET',url,responseType:binary ? 'arraybuffer' : 'json',timeout:120000,
            // Let the browser attach only cookies belonging to the destination domain.
            // anonymous:true forces fetch mode in Tampermonkey, which changes CDN request behavior.
            anonymous:false, headers:{Referer:location.href},
            onload:r => {
              if (r.status < 200 || r.status >= 300) { finish(requestFailure(url,r.status)); return; }
              if (binary && (!r.response?.byteLength || r.response.byteLength > MAX_AUDIO_BYTES)) { finish(Error('音轨为空或超过 96 MB')); return; }
              if (!binary && (!r.response || typeof r.response !== 'object')) { finish(Error('B 站接口返回了无效数据')); return; }
              finish(null,r.response);
            },
            onprogress:r => {
              if (!binary || done) return;
              if (r.loaded > MAX_AUDIO_BYTES || r.total > MAX_AUDIO_BYTES) { finish(Error('音轨超过 96 MB')); handle?.abort(); return; }
              if (session === s) $('status').textContent = `正在下载音轨：${(r.loaded/1048576).toFixed(1)} MB`;
            },
            onerror:() => finish(Error('网络请求失败，请检查网络和油猴跨域权限')),
            ontimeout:() => finish(Error('网络请求超时，请重试')),
            onabort:() => finish(Error('已取消'))});
        } catch (e) { finish(e); }
      });
    }
    function check(s) { if (session !== s) throw Error('已取消'); }
    function sync(s) {
      if (session !== s || !s.ready) return;
      for (const node of s.sources) { try { node.stop(); } catch {} }
      s.sources = []; s.anchor = null; s.scheduled = s.video.currentTime;
      pump(s);
    }
    function pump(s) {
      if (session !== s || !s.ready) return;
      const v = s.video;
      if (v.paused || v.ended || v.seeking || s.waiting) return;
      if (!s.done && v.currentTime + 0.1 >= s.frontier) {
        s.buffering = true; v.pause();
        for (const node of s.sources) { try { node.stop(); } catch {} }
        s.sources = []; s.anchor = null;
        $('status').textContent = '正在等待当前位置解密…';
        return;
      }
      if (v.readyState < 3 || v.currentTime >= s.output.duration) return;
      if (s.ctx.state !== 'running') {
        s.ctx.resume().then(() => { if (session === s && s.ctx.state === 'running') sync(s); }).catch(() => {});
        return;
      }
      if (!s.anchor) {
        s.anchor = {time:s.ctx.currentTime, video:v.currentTime, rate:v.playbackRate};
        s.scheduled = v.currentTime;
      }
      const end = Math.min(s.frontier, v.currentTime + 2, s.output.duration);
      const startSample = Math.round(s.scheduled*48000), endSample = Math.floor(end*48000);
      if (endSample <= startSample) return;
      // Playing AudioBuffers are immutable: schedule copies of completed PCM only.
      const buffer = s.ctx.createBuffer(2,endSample-startSample,48000);
      for (let c=0;c<2;c++) buffer.getChannelData(c).set(s.output.getChannelData(c).subarray(startSample,endSample));
      const node = s.ctx.createBufferSource(); node.buffer = buffer;
      node.playbackRate.value = v.playbackRate; node.connect(s.gain);
      node.onended = () => { s.sources = s.sources.filter(source => source !== node); };
      node.start(s.anchor.time+(startSample/48000-s.anchor.video)/s.anchor.rate,0);
      s.sources.push(node); s.scheduled = endSample/48000;
    }
    function progress(s) {
      if (s.buffering && (s.done || s.frontier >= s.video.currentTime + 0.5)) {
        s.buffering = false;
        s.video.play().catch(() => { if (session === s) $('status').textContent = '已缓冲，请在原页面点击播放'; });
      }
      pump(s);
    }
    $('stop').onclick = () => stop();
    win.addEventListener('pagehide', () => stop(), {once:true});
    window.addEventListener('pagehide', () => { stop('源页面已关闭或刷新，请重新打开解码窗口'); }, {once:true});
    $('volume').oninput = () => { if (session?.gain) session.gain.gain.value = Number($('volume').value); };
    $('start').onclick = async () => {
      const key = $('key').value;
      if (!key || [...key].length > 1024) { $('status').textContent = '请填写 1–1024 字符音轨密钥'; return; }
      const s = {urls:[], listeners:[], controller:new AbortController(), pos:0, sources:[], frontier:0}; session = s;
      $('start').disabled = true; $('stop').disabled = false;
      try {
        const identity = videoIdentity(location.href);
        s.video = document.querySelector('video');
        if (!s.video) throw Error('未找到视频播放器，请等待页面加载后重试');
        s.video.pause();
        s.muted = s.video.muted; s.video.muted = true;
        const mute = () => { if (session === s && !s.video.muted) s.video.muted = true; };
        s.video.addEventListener('volumechange',mute); s.listeners.push(['volumechange',mute]);
        s.ctx = new win.AudioContext({sampleRate:48000});
        await s.ctx.resume(); check(s);
        if (s.ctx.sampleRate !== 48000) throw Error('需要 48 kHz 音频上下文');
        s.timer = setInterval(() => {
          if (session !== s) return;
          try {
            const current = videoIdentity(location.href);
            if (current.id !== identity.id || current.part !== identity.part || document.querySelector('video') !== s.video) {
              snapshot = null;
              stop('视频或分 P 已切换，请重新解析'); return;
            }
            if (s.ready && !s.video.paused) {
              if (s.anchor && Math.abs(s.anchor.video+(s.ctx.currentTime-s.anchor.time)*s.anchor.rate-s.video.currentTime)>0.2) sync(s);
              else pump(s);
            }
          } catch { stop('视频页面已离开，请重新打开解码'); }
        },250);
        $('status').textContent = '正在解析当前视频及分 P…';
        const query = /^av/i.test(identity.id) ? `aid=${identity.id.slice(2)}` : `bvid=${encodeURIComponent(identity.id)}`;
        const cached = snapshot && snapshot.identity.id === identity.id && snapshot.identity.part === identity.part ? snapshot : null;
        snapshot = null; // Use embedded playback URLs only once, and never reuse expired URLs.
        const view = cached ? {code:0,data:cached.video} : await request(s,`https://api.bilibili.com/x/web-interface/view?${query}`); check(s);
        if (view.code !== 0) throw Error(`视频信息获取失败：${view.message || view.code}`);
        const page = view.data?.pages?.find(p => p.page === identity.part);
        if (!page?.cid) throw Error('当前分 P 不存在');
        if (!Number.isFinite(page.duration) || page.duration > MAX_AUDIO_SECONDS) throw Error('当前仅支持 15 分钟以内的分 P');
        const playParams = {bvid:view.data.bvid || identity.id, cid:page.cid, qn:80, fnval:4048, fnver:0, fourk:1, otype:'json'};
        if (/^av/i.test(playParams.bvid)) { delete playParams.bvid; playParams.avid = view.data.aid || identity.id.slice(2); }
        let candidates;
        if (cached && Date.now()-cached.captured < 120000) {
          try { candidates = audioCandidates(cached.play); } catch {}
        }
        if (!candidates) {
          const nav = await request(s,'https://api.bilibili.com/x/web-interface/nav'); check(s);
          const signed = wbiQuery(playParams,nav);
          const play = await request(s,`https://api.bilibili.com/x/player/wbi/playurl?${signed}`); check(s);
          candidates = audioCandidates(play);
        }
        let audio, lastError;
        for (const url of candidates) {
          try {
            const bytes = await request(s,url,true); check(s);
            $('status').textContent = '正在将音轨转换为 PCM…';
            audio = await s.ctx.decodeAudioData(bytes); check(s);
            break;
          } catch (e) { check(s); lastError = e; }
        }
        if (!audio) throw lastError || Error('所有音频地址均不可用，请重试以刷新链接');
        if (audio.duration > MAX_AUDIO_SECONDS+2) throw Error('音轨超过 15 分钟限制');
        s.input = audio;
        s.output = s.ctx.createBuffer(2,audio.length,48000);
        s.gain = s.ctx.createGain(); s.gain.gain.value = Number($('volume').value); s.gain.connect(s.ctx.destination);
        const workerUrl = URL.createObjectURL(new Blob([`(${decoderWorker.toString()})()`],{type:'text/javascript'}));
        s.urls.push(workerUrl); s.worker = new Worker(workerUrl);
        for (const event of ['play','playing','pause','seeking','seeked','ratechange','waiting','ended']) {
          const listener = () => {
            if (event === 'waiting') s.waiting = true;
            if (event === 'playing' || event === 'seeked') s.waiting = false;
            sync(s);
            if (event === 'seeked') progress(s);
          };
          s.video.addEventListener(event,listener); s.listeners.push([event,listener]);
        }
        const feed = () => {
          check(s);
          if (s.pos >= s.input.length) {
            if (!s.packets) throw Error('未找到 CS2 同步信号，请确认视频包含编码音轨');
            s.input = null; audio = null; s.worker.terminate();
            s.done = true; s.frontier = s.output.duration;
            $('status').textContent = `已恢复 ${s.packets} 秒。暂停、跳转、倍速将自动同步。`;
            progress(s); return;
          }
          const count = Math.min(48000,s.input.length-s.pos), pcm = new Float32Array(count*2);
          const left = s.input.getChannelData(0), right = s.input.getChannelData(Math.min(1,s.input.numberOfChannels-1));
          for (let i=0;i<count;i++) { pcm[i*2]=left[s.pos+i]; pcm[i*2+1]=right[s.pos+i]; }
          s.pos += count; s.worker.postMessage({pcm:pcm.buffer},[pcm.buffer]);
        };
        s.worker.onerror = () => { if (session === s) stop('解码 Worker 无法运行，可能被页面安全策略阻止'); };
        s.worker.onmessage = ({data}) => {
          if (session !== s) return;
          try {
            if (data.error) throw Error(data.error);
            if (data.ready) feed();
            else if (data.pcm) {
              const pcm = new Float32Array(data.pcm);
              for (let c=0;c<2;c++) {
                const out = s.output.getChannelData(c);
                for (let i=0;i<pcm.length/2 && data.start+i<out.length;i++) out[data.start+i]=Math.max(-0.95,Math.min(0.95,pcm[2*i+c]));
              }
            } else if (data.ack) {
              s.packets = data.packets;
              s.frontier = data.frontier/48000;
              s.ready = s.packets > 0;
              $('status').textContent = `正在解码：${Math.round(s.pos/s.input.length*100)}% · 已恢复 ${s.packets} 秒${s.ready ? '，可在原页面播放' : '，正在寻找 CS2 同步信号'}`;
              progress(s);
              feed();
            }
          } catch (e) { if (session === s) stop(e.message); }
        };
        s.worker.postMessage({key}); $('key').value = '';
        $('status').textContent = '正在计算密钥…';
      } catch (e) { if (session === s) stop(e.message); }
    };
  }
  GM_registerMenuCommand('打开 Crypt Sound 独立解码', open);
  const button = document.createElement('button'); button.textContent = '音轨解码'; button.title = '解析 B 站音频链接并在浏览器内解码';
  Object.assign(button.style,{position:'fixed',right:'20px',bottom:'100px',zIndex:'2147483647',padding:'10px 16px',background:'#14352e',color:'#a0f0d8',border:'1px solid #68bca6',borderRadius:'8px',cursor:'pointer'});
  button.addEventListener('click',open); document.body.appendChild(button);
})();

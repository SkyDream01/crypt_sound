// SPDX-License-Identifier: GPL-3.0-only
// This file is part of Crypt Sound. See LICENSE for terms; provided without warranty.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {videoIdentity, audioCandidates, md5, wbiQuery, requestFailure, pageSnapshot} = require('../userscript/crypt-sound.user.js');

test('identify BV / av videos and the selected part without unrelated query parameters', () => {
  assert.deepEqual(videoIdentity('https://www.bilibili.com/video/BV1abc123/?p=3&spm_id_from=1'), {id:'BV1abc123',part:3});
  assert.deepEqual(videoIdentity('https://www.bilibili.com/video/av123'), {id:'av123',part:1});
  for (const path of ['/bangumi/play/ep123', '/video/BV1abc?p=0', '/video/BV1abc?p=NaN', '/video/BV1abc?p=1.5']) {
    assert.throws(() => videoIdentity(`https://www.bilibili.com${path}`));
  }
});

test('prefer highest bandwidth audio and retain backups, support both API field spellings', () => {
  const primary = 'https://a.bilivideo.com/audio?token=secret';
  assert.deepEqual(audioCandidates({code:0,data:{dash:{audio:[
    {bandwidth:64000,base_url:'https://b.bilivideo.cn/low'},
    {bandwidth:192000,baseUrl:primary,backupUrl:[primary,'//c.bilivideo.com/backup']},
    {bandwidth:128000,base_url:'https://d.bilivideo.net/mid',backup_url:['https://e.bilivideo.com/mid']},
  ]}}}), [primary,'https://c.bilivideo.com/backup','https://d.bilivideo.net/mid','https://e.bilivideo.com/mid','https://b.bilivideo.cn/low']);
});

test('reject API errors, missing DASH and untrusted media URLs', () => {
  assert.throws(() => audioCandidates({code:-403,message:'denied'}), /denied/);
  assert.throws(() => audioCandidates({code:0,data:{durl:[{url:'video.mp4'}]}}), /DASH/);
  for (const baseUrl of ['http://a.bilivideo.com/a','https://bilivideo.com.evil.test/a','https://evilbilivideo.com/a','https://user:pass@a.bilivideo.com/a','javascript:alert(1)']) {
    assert.throws(() => audioCandidates({code:0,data:{dash:{audio:[{baseUrl}]}}}), /CDN/);
  }
});

test('released userscript uses direct requests and contains no recording API', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'../userscript/crypt-sound.user.js'),'utf8');
  assert.doesNotMatch(source, /getDisplayMedia|getUserMedia|createMediaStreamSource|AudioWorklet/);
  assert.match(source, /@grant\s+GM_xmlhttpRequest/);
  assert.match(source, /x\/player\/wbi\/playurl/);
});

function browserHarness({holdDownload = false, playError = null, nativeStatus = null, embedded = null, nativeCors = false, cdnStatus = null, manualWorker = false, seconds = 1} = {}) {
  const fs = require('node:fs'), vm = require('node:vm');
  const elements = Object.fromEntries(['key','start','stop','status','volume'].map(id => [id,{value:id==='key'?'test':id==='volume'?'0.35':'',style:{}}]));
  const events = new Map(), timers = [], requests = [], sources = [];
  const video = {muted:false,paused:false,currentTime:0,playbackRate:1,readyState:4,
    pause() { this.paused = true; },
    async play() { this.paused = false; emit("playing"); },
    addEventListener(name,fn) { if (!events.has(name)) events.set(name,new Set()); events.get(name).add(fn); },
    removeEventListener(name,fn) { events.get(name)?.delete(fn); }};
  const emit = name => { for (const fn of events.get(name) || []) fn(); };
  let worker, aborted = false;
  const input = {length:48000*seconds,duration:seconds,numberOfChannels:2,getChannelData:() => new Float32Array(48000*seconds)};
  class AudioContext {
    constructor() { this.sampleRate=48000; this.state='running'; this.currentTime=0; }
    async resume() {}
    async close() { this.state='closed'; }
    async decodeAudioData() { return input; }
    createBuffer(ch,n,rate) { const data=Array.from({length:ch},()=>new Float32Array(n)); return {duration:n/rate,getChannelData:c=>data[c]}; }
    createGain() { return {gain:{value:0},connect(){}}; }
    createBufferSource() { const node={playbackRate:{},connect(){},start(t,offset){this.when=t;this.offset=offset;},stop(){this.stopped=true;}}; sources.push(node); return node; }
  }
  class Worker {
    constructor() { worker=this; }
    postMessage(data) { if (manualWorker) return; queueMicrotask(() => {
      if (this.terminated) return;
      if (data.key) this.onmessage({data:{ready:true}});
      else { this.onmessage({data:{pcm:new Float32Array(96000).buffer,start:0}}); this.onmessage({data:{ack:true,packets:1,frontier:48000}}); }
    }); }
    terminate() { this.terminated=true; }
  }
  const doc={body:{style:{}},getElementById:id=>elements[id]};
  const popup={document:doc,AudioContext,addEventListener(){}};
  const location={href:'https://www.bilibili.com/video/BV123?p=2'};
  const context={URL,Blob,AbortController,Float32Array,TextEncoder,Worker,console,location,setTimeout,clearTimeout,unsafeWindow:embedded || {},
    window:{open:()=>popup,addEventListener(){}},
    document:{querySelector:()=>video,createElement:()=>({style:{},addEventListener(){}}),body:{appendChild(){}}},
    GM_registerMenuCommand:(name,fn)=>{ context.open=fn; },
    setInterval:fn=>{timers.push(fn);return timers.length;},clearInterval(){},
    GM_xmlhttpRequest:options=>{
      requests.push(options);
      const handle={abort(){aborted=true;options.onabort();}};
      if (holdDownload && options.responseType==='arraybuffer') return handle;
      queueMicrotask(()=>{
        if (options.url.endsWith('/nav')) options.onload({status:200,response:{code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}}});
        else if (options.url.includes('web-interface')) options.onload({status:200,response:{code:0,data:{pages:[{page:1,cid:10,duration:1},{page:2,cid:20,duration:1}]}}});
        else if (options.url.includes('playurl') && playError) options.onload({status:200,response:playError});
        else if (options.url.includes('playurl')) options.onload({status:200,response:{code:0,data:{dash:{audio:[{baseUrl:'https://a.bilivideo.com/main',backupUrl:['https://b.bilivideo.com/backup']}]}}}});
        else if (cdnStatus) options.onload({status:cdnStatus});
        else if (options.url.includes('/main')) options.onload({status:403});
        else options.onload({status:200,response:new ArrayBuffer(4)});
      }); return handle;
    }};
  const nativeRequests=[];
  if (nativeStatus !== null || nativeCors) context.window.fetch=async (url,options)=>{
    nativeRequests.push({url,options});
    if (nativeCors) throw new TypeError('CORS');
    if (nativeStatus === 200) {
      const payload=url.endsWith('/nav') ? {code:0,data:{wbi_img:{
        img_url:'https://i0.hdslb.com/7cd084941338484aae1ad9425b84077c.png',
        sub_url:'https://i0.hdslb.com/4932caff0ff746eab6f01bf08b70ac45.png',
      }}} : url.includes('/view?') ? {code:0,data:embeddedPage().__INITIAL_STATE__.videoData} : embeddedPage().__playinfo__;
      return {ok:true,status:200,json:async()=>payload};
    }
    return {ok:false,status:nativeStatus};
  };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../userscript/crypt-sound.user.js'),'utf8'),context);
  context.open();
  return {elements,video,emit,timers,requests,nativeRequests,sources,location,get worker(){return worker;},get aborted(){return aborted;}};
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('direct download uses selected CID and fallback, playback follows video and stop restores mute', async () => {
  const h=browserHarness();
  await h.elements.start.onclick(); await flush();
  assert.match(h.requests[2].url,/cid=20&/);
  assert.equal(h.requests.length,5);
  assert.equal(h.requests[3].anonymous,false);
  assert.match(h.elements.status.textContent,/已恢复 1 秒/);
  assert.equal(h.sources.length,0); // No playback before the user starts the paused video.
  assert.equal(h.video.muted,true);
  h.video.paused=false; h.video.currentTime=0.4; h.emit('playing');
  assert.equal(h.sources.at(-1).offset,0);
  assert.equal(h.sources.at(-1).buffer.duration,0.6);
  h.video.playbackRate=2; h.emit('ratechange');
  assert.equal(h.sources.at(-1).playbackRate.value,2);
  h.emit('waiting'); assert.equal(h.sources.at(-1).stopped,true);
  h.emit('playing'); assert.equal(h.sources.at(-1).stopped,undefined);
  h.video.paused=true; h.emit('pause'); assert.equal(h.sources.at(-1).stopped,true);
  h.elements.stop.onclick();
  assert.equal(h.video.muted,false);
  assert.equal(h.elements.start.disabled,false);
  assert.equal(h.worker.terminated,true);
});

test('cancel aborts a pending audio request and does not start a stale session', async () => {
  const h=browserHarness({holdDownload:true});
  const starting=h.elements.start.onclick(); await flush();
  assert.equal(h.requests.length,4);
  h.elements.stop.onclick(); await starting;
  assert.equal(h.aborted,true);
  assert.equal(h.video.muted,false);
  assert.equal(h.worker,undefined);
  assert.equal(h.elements.status.textContent,'已停止');
});

test('changing part ends the session and restores mute', async () => {
  const h=browserHarness(); await h.elements.start.onclick(); await flush();
  h.location.href='https://www.bilibili.com/video/BV123?p=3'; h.timers[0]();
  assert.equal(h.video.muted,false);
  assert.match(h.elements.status.textContent,/分 P 已切换/);
});

test('MD5 request hashing matches Node for empty, Unicode and multiple blocks', () => {
  const crypto = require('node:crypto');
  for (const value of ['', 'abc', '音轨🔑', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000)]) {
    assert.equal(md5(value),crypto.createHash('md5').update(value).digest('hex'));
  }
});

test('WBI uses current nav keys, sorted and sanitized parameters and a timestamp', () => {
  const nav={code:-101,data:{wbi_img:{
    img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',
    sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png',
  }}};
  const query=wbiQuery({foo:114,bar:514,baz:"1919810!'()*"},nav,1702204169);
  const canonical='bar=514&baz=1919810&foo=114&wts=1702204169';
  const hash=require('node:crypto').createHash('md5').update(canonical+'ea1db124af3c7062474693fa704f4ff8').digest('hex');
  assert.equal(query,canonical+'&w_rid='+hash);
  assert.throws(()=>wbiQuery({}, {code:-352,data:{}},1702204169), /code=-352/);
});

test('playback requests carry WBI signature, DASH options and the page Referer', async () => {
  const h=browserHarness(); await h.elements.start.onclick(); await flush();
  const request=h.requests.find(r=>r.url.includes('/wbi/playurl'));
  const url=new URL(request.url);
  assert.match(url.searchParams.get('w_rid'),/^[a-f0-9]{32}$/);
  assert.ok(Number(url.searchParams.get('wts'))>0);
  assert.equal(url.searchParams.get('fnval'),'4048');
  assert.equal(url.searchParams.get('qn'),'80');
  assert.equal(request.headers.Referer,h.location.href);
  assert.equal(request.anonymous,false);
  h.elements.stop.onclick();
});

test('API request errors preserve the numeric code and restore the player', async () => {
  const h=browserHarness({playError:{code:-400,message:'请求错误'}});
  await h.elements.start.onclick(); await flush();
  assert.match(h.elements.status.textContent,/code=-400.*请求错误/);
  assert.equal(h.video.muted,false);
  assert.equal(h.elements.start.disabled,false);
  assert.equal(h.worker,undefined);
});

const embeddedPage = () => ({
  __INITIAL_STATE__:{cid:20,videoData:{bvid:'BV123',aid:123,pages:[{page:2,cid:20,duration:1}]}},
  __playinfo__:{code:0,data:{cid:20,dash:{audio:[{baseUrl:'https://a.bilivideo.com/embedded?token=do-not-log'}]}}},
});

test('fresh matching page playback info avoids all API requests', async () => {
  const h=browserHarness({embedded:embeddedPage()});
  await h.elements.start.onclick(); await flush();
  assert.equal(h.requests.length,1);
  assert.match(h.requests[0].url,/\/embedded/);
  assert.match(h.elements.status.textContent,/已恢复 1 秒/);
  h.elements.stop.onclick();
});

test('page snapshot rejects mismatched video and CID, and copies rather than retaining page globals', () => {
  const page=embeddedPage();
  const snapshot=pageSnapshot(page,'https://www.bilibili.com/video/BV123?p=2');
  assert.ok(snapshot);
  page.__playinfo__.data.cid=99;
  assert.equal(snapshot.play.data.cid,20);
  assert.equal(pageSnapshot(page,'https://www.bilibili.com/video/BV123?p=2'),null);
  assert.equal(pageSnapshot(embeddedPage(),'https://www.bilibili.com/video/BV999?p=2'),null);
  assert.equal(pageSnapshot(embeddedPage(),'https://www.bilibili.com/video/BV123?p=1'),null);
});

test('native API HTTP 412 is labeled and never retried through GM', async () => {
  const h=browserHarness({nativeStatus:412});
  await h.elements.start.onclick(); await flush();
  assert.equal(h.nativeRequests.length,1);
  assert.equal(h.nativeRequests[0].options.credentials,'include');
  assert.equal(h.requests.length,0);
  assert.match(h.elements.status.textContent,/视频信息接口.*HTTP 412/);
  assert.equal(h.video.muted,false);
  assert.equal(h.elements.start.disabled,false);
});

test('CORS failure falls back to GM but does not discard cookies or Referer', async () => {
  const h=browserHarness({nativeCors:true});
  await h.elements.start.onclick(); await flush();
  assert.equal(h.nativeRequests.length,3);
  assert.equal(h.requests.length,5);
  assert.equal(h.requests[0].anonymous,false);
  assert.equal(h.requests[0].headers.Referer,h.location.href);
  assert.match(h.elements.status.textContent,/已恢复 1 秒/);
  h.elements.stop.onclick();
});

test('CDN 412 labels its host without exposing signed URLs, and cleans up', async () => {
  const h=browserHarness({embedded:embeddedPage(),cdnStatus:412});
  await h.elements.start.onclick(); await flush();
  assert.equal(h.requests.length,1);
  assert.match(h.elements.status.textContent,/音频 CDN.*HTTP 412.*a.bilivideo.com/);
  assert.doesNotMatch(h.elements.status.textContent,/do-not-log|token=/);
  assert.equal(h.video.muted,false);
});

test('HTTP diagnostics distinguish WBI and playback failures', () => {
  assert.match(requestFailure('https://api.bilibili.com/x/web-interface/nav',412).message,/WBI 参数接口/);
  assert.match(requestFailure('https://api.bilibili.com/x/player/wbi/playurl?w_rid=secret',412).message,/播放地址接口/);
  assert.doesNotMatch(requestFailure('https://api.bilibili.com/x/player/wbi/playurl?w_rid=secret',412).message,/secret/);
});

test('successful browser API requests use GM only for binary CDN download', async () => {
  const h=browserHarness({nativeStatus:200});
  await h.elements.start.onclick(); await flush();
  assert.equal(h.nativeRequests.length,3);
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].responseType,'arraybuffer');
  assert.match(h.elements.status.textContent,/已恢复 1 秒/);
  h.elements.stop.onclick();
});


test('plays completed PCM before worker finishes; seek waits then resumes; stop ignores stale packets', async () => {
  const h=browserHarness({manualWorker:true,seconds:4});
  await h.elements.start.onclick();
  const send=data=>h.worker.onmessage({data});
  send({ready:true});
  const packet=start=>send({pcm:new Float32Array(96000).fill(0.25).buffer,start});
  packet(0); send({ack:true,packets:1,frontier:48000});
  assert.equal(h.worker.terminated,undefined);
  h.video.paused=false; h.emit('playing');
  assert.equal(h.sources.length,1);
  assert.equal(h.sources[0].buffer.duration,1);
  assert.equal(h.sources[0].buffer.getChannelData(0)[0],0.25);
  packet(48000); send({ack:true,packets:2,frontier:96000});
  assert.equal(h.sources.length,2);
  assert.equal(h.sources[1].when,1);
  assert.equal(h.sources[0].stopped,undefined);
  h.video.currentTime=2.5; h.emit('seeking'); h.emit('seeked');
  assert.equal(h.video.paused,true);
  assert.ok(h.sources.every(n=>n.stopped));
  packet(96000); send({ack:true,packets:3,frontier:144000});
  assert.equal(h.video.paused,false);
  assert.equal(h.sources.at(-1).buffer.duration,0.5);
  h.elements.stop.onclick();
  send({ack:true,packets:4,frontier:192000});
  assert.equal(h.elements.status.textContent,'已停止');
  assert.equal(h.video.muted,false);
});


test('underrun pauses and resumes, completion schedules the tail, user pause stays paused', async () => {
  const h=browserHarness({manualWorker:true,seconds:3.25});
  await h.elements.start.onclick();
  const send=data=>h.worker.onmessage({data});
  const packet=start=>send({pcm:new Float32Array(96000).buffer,start});
  send({ready:true}); packet(0); send({ack:true,packets:1,frontier:48000});
  h.video.paused=false; h.emit('playing');
  h.video.currentTime=0.95; h.timers[0]();
  assert.equal(h.video.paused,true);
  assert.match(h.elements.status.textContent,/等待/);
  packet(48000); send({ack:true,packets:2,frontier:96000});
  assert.equal(h.video.paused,false);
  h.video.paused=true; h.emit('pause');
  packet(96000); send({ack:true,packets:3,frontier:144000});
  assert.equal(h.video.paused,true);
  send({ack:true,packets:3,frontier:144000});
  assert.equal(h.worker.terminated,true);
  assert.equal(h.video.paused,true);
  h.video.currentTime=3; h.video.paused=false; h.emit('playing');
  assert.equal(h.sources.at(-1).buffer.duration,0.25);
  h.elements.stop.onclick();
});

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
const { LOCAL_SECURITY_POLICY, clearInheritedCompanionCredentials, isAllowedLocalRequest } = require('./lib/companion-network');
const { createLocalServices } = require('./lib/local-services');
const { RUNTIME_POLICY, createConversationChannel } = require('./lib/conversation-channel');
const { DIALOGUE_STYLE_VERSION, buildCharacterPrompt, cleanSpokenReply } = require('./lib/character-dialogue');
const { createSpeechPrefetch, streamSpeechSegments } = require('./lib/speech-prefetch.cjs');

clearInheritedCompanionCredentials();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const WALLPAPER_DIR = path.join(ROOT, 'wallpaper');
const DATA_DIR = path.join(ROOT, 'data');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'config.example.json');
const HISTORY_PATH = path.join(DATA_DIR, 'conversation.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

if (!fs.existsSync(CONFIG_PATH)) {
  fs.copyFileSync(CONFIG_EXAMPLE_PATH, CONFIG_PATH);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const config = readJson(CONFIG_PATH, {});
const localServices = createLocalServices(config);
const localPolicy = localServices.policy;
const channels = createConversationChannel({ localChat: localServices.chat, cleanReply });
let history = readJson(HISTORY_PATH, []);
if (!Array.isArray(history)) history = [];

const speech = {
  sherpa: null,
  recognizer: null,
  tts: null,
  ready: false,
  error: null,
  loading: null,
};

const clients = new Set();
let workQueue = Promise.resolve();

function modelPaths() {
  const root = config.speech.modelRoot;
  const asr = path.join(root, 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17');
  const tts = path.join(root, config.speech.ttsModelDir || 'kokoro-multi-lang-v1_0');
  return {
    asrModel: path.join(asr, 'model.int8.onnx'),
    asrTokens: path.join(asr, 'tokens.txt'),
    vadModel: path.join(root, 'silero_vad.onnx'),
    ttsModel: path.join(tts, 'model.onnx'),
    ttsVoices: path.join(tts, 'voices.bin'),
    ttsTokens: path.join(tts, 'tokens.txt'),
    ttsData: path.join(tts, 'espeak-ng-data'),
    ttsLexicon: [path.join(tts, 'lexicon-us-en.txt'), path.join(tts, 'lexicon-zh.txt')].join(','),
  };
}

function requiredSpeechFiles() {
  const p = modelPaths();
  return [p.asrModel, p.asrTokens, p.vadModel, p.ttsModel, p.ttsVoices, p.ttsTokens, p.ttsData];
}

async function initSpeech() {
  if (speech.ready) return;
  if (speech.loading) return speech.loading;
  speech.loading = (async () => {
    try {
      const p = modelPaths();
      const missing = requiredSpeechFiles().filter((value) => !fs.existsSync(value));
      if (missing.length) throw new Error(`语音模型尚未安装：${missing[0]}`);

      speech.sherpa = require('sherpa-onnx-node');
      speech.recognizer = new speech.sherpa.OfflineRecognizer({
        featConfig: { sampleRate: config.speech.sampleRate, featureDim: 80 },
        modelConfig: {
          senseVoice: { model: p.asrModel, useInverseTextNormalization: 1 },
          tokens: p.asrTokens,
          numThreads: 4,
          provider: 'cpu',
          debug: 0,
        },
      });
      speech.tts = await speech.sherpa.OfflineTts.createAsync({
        model: {
          kokoro: {
            model: p.ttsModel,
            voices: p.ttsVoices,
            tokens: p.ttsTokens,
            dataDir: p.ttsData,
            lexicon: p.ttsLexicon,
          },
          debug: false,
          numThreads: 4,
          provider: 'cpu',
        },
        maxNumSentences: 1,
      });
      speech.ready = true;
      speech.error = null;
      broadcast({ type: 'speech-status', ready: true });
    } catch (error) {
      speech.ready = false;
      speech.error = error.message;
      broadcast({ type: 'speech-status', ready: false, error: speech.error });
      console.error('[speech]', error);
    }
  })();
  return speech.loading;
}

function createVadSession() {
  if (!speech.ready) return null;
  const sherpa = speech.sherpa;
  const p = modelPaths();
  const vad = new sherpa.Vad({
    sileroVad: {
      model: p.vadModel,
      threshold: config.speech.vadThreshold,
      minSpeechDuration: 0.25,
      minSilenceDuration: config.speech.minSilenceSeconds,
      windowSize: 512,
    },
    sampleRate: config.speech.sampleRate,
    debug: false,
    numThreads: 1,
  }, 60);
  return {
    vad,
    buffer: new sherpa.CircularBuffer(config.speech.sampleRate * 30),
    listening: false,
    segmentEmitted: false,
    receivedSamples: 0,
    peak: 0,
  };
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(payload) {
  for (const ws of clients) send(ws, payload);
}

function pauseChannelClients() {
  // Discard unfinished microphone input; never flush it into the new channel.
  for (const ws of clients) {
    ws.currentAbort?.abort();
    const session = ws.vadSession;
    if (session) {
      session.listening = false;
      session.rawCapture = null;
      session.vad.reset?.();
      session.buffer.reset();
      session.segmentEmitted = false;
      session.receivedSamples = 0;
      session.peak = 0;
    }
  }
}

function enqueue(task) {
  const revision = channels.status().revision;
  const run = () => { if (revision === channels.status().revision) return task(); };
  workQueue = workQueue.then(run, run).catch((error) => console.error('[queue]', error));
  return workQueue;
}

function cleanTranscript(text) {
  return String(text || '')
    .replace(/<\|[^|]+\|>/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function cleanReply(text, fallback = '') {
  return cleanSpokenReply(text, { name: config.character.name, fallback });
}

const LOCAL_TIME_ZONE = 'Asia/Shanghai';

function localClock() {
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: LOCAL_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value || '';
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    weekday: value('weekday'),
    hour: value('hour'),
    minute: value('minute'),
  };
}

function localClockReply(text) {
  const compact = String(text || '').replace(/[\s，。！？,.!?]/g, '');
  const asksDate = /^(今天)?(是)?(几号|几月几号|什么日期)$/.test(compact)
    || /(今天|现在).*(几号|几月几号|日期)/.test(compact);
  const asksWeekday = /(今天|现在).*(星期几|周几)/.test(compact);
  const asksTime = /(现在|当前|这会儿|这时候).*(几点|时间)|^几点了$/.test(compact);
  if (!asksDate && !asksWeekday && !asksTime) return null;
  const now = localClock();
  if (asksTime && (asksDate || asksWeekday)) {
    return `今天是${now.year}年${now.month}月${now.day}日，${now.weekday}，现在${now.hour}点${now.minute}分。`;
  }
  if (asksTime) return `现在是${now.hour}点${now.minute}分。`;
  return `今天是${now.year}年${now.month}月${now.day}日，${now.weekday}。`;
}

function systemPrompt() {
  return buildCharacterPrompt(config.character, localClock());
}

async function askLlm(ws, userText, signal, speechPrefetch) {
  const recent = history
    .filter(({ content }) => String(content || '').trim() && !/^([?.。，！!…])\1{2,}$/.test(String(content).trim()))
    .slice(-6)
    .map(({ role, content }) => ({ role, content }));
  const messages = [{ role: 'system', content: systemPrompt() }, ...recent, { role: 'user', content: userText }];
  send(ws, { type: 'state', value: 'thinking' });

  let announced = false;
  const reply = await channels.chat({
    system: messages[0].content, text: userText, localMessages: messages,
    signal,
    onDelta: text => {
      speechPrefetch?.push(text);
      if (!announced) { send(ws, { type: 'state', value: 'replying' }); announced = true; }
      send(ws, { type: 'assistant-delta', text });
    },
  });
  return reply;
}

function floatToWav(samples, sampleRate) {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36);
  out.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(sample < 0 ? sample * 32768 : sample * 32767, 44 + i * 2);
  }
  return out;
}

async function speak(ws, text, turnId, signal, prefetched = null) {
  signal.throwIfAborted();
  send(ws, { type: 'state', value: 'speaking' });
  if (localServices.hasVoice) {
    let naturalStreamOpened = false;
    try {
      const health = prefetched?.health || await localServices.voiceHealth();
      signal.throwIfAborted();
      if (health.ready && health.streaming) {
        const response = prefetched?.response || await localServices.synthesize(text, { stream: true, signal });
        if (!response.body) throw new Error('本地自然语音未返回音频流。');
        const sampleRate = Number(response.headers.get('x-sample-rate')) || Number(health.sampleRate) || 48000;
        const streamMetadata = {
          type: 'audio-stream-start',
          turnId,
          engine: response.headers.get('x-voice-engine') || health.engine || 'VoxCPM2-Ultimate-Clone',
          speaker: config.speech.naturalTtsSpeaker || health.voice || '爱弥斯 · 清冷明亮原创声线',
          sampleRate,
          format: 'pcm_s16le',
        };
        await streamSpeechSegments({
          response, remainder: prefetched?.remainder || '',
          synthesize: localServices.synthesize, signal, sampleRate,
          onChunk: value => {
            // Empty/failed synthesis must not leave the frontend in an open
            // playback state, especially when the fallback voice is unavailable.
            if (!naturalStreamOpened) {
              send(ws, streamMetadata);
              naturalStreamOpened = true;
            }
            if (ws.readyState === WebSocket.OPEN) ws.send(value, { binary: true });
          },
        });
        send(ws, { type: 'audio-stream-end', turnId });
        naturalStreamOpened = false;
        return;
      }
      const response = await localServices.synthesize(text, { signal });
      const wav = Buffer.from(await response.arrayBuffer());
      signal.throwIfAborted();
      send(ws, { type: 'audio-meta', turnId, engine: health.engine || 'qwen3-tts-fixed-clone', speaker: config.speech.naturalTtsSpeaker || health.voice || '爱弥斯 · 清冷明亮原创声线' });
      if (ws.readyState === WebSocket.OPEN) ws.send(wav, { binary: true });
      return;
    } catch (error) {
      if (naturalStreamOpened || error.audioStarted) {
        // Replaying the full reply with a fallback voice would duplicate audio.
        send(ws, { type: 'audio-stream-end', turnId });
        signal.throwIfAborted();
        throw error;
      }
      signal.throwIfAborted();
      console.warn(`[natural-voice] ${error.message}; falling back to Kokoro`);
    }
  }
  if (!speech.ready || !speech.tts) throw new Error('自然女声和备用女声均未就绪');
  const generationConfig = new speech.sherpa.GenerationConfig({
    sid: config.character.voiceSid,
    speed: config.character.voiceSpeed,
    silenceScale: 0.2,
  });
  const audio = await speech.tts.generateAsync({
    text,
    enableExternalBuffer: true,
    generationConfig,
    onProgress: () => signal.aborted ? 0 : 1,
  });
  signal.throwIfAborted();
  send(ws, { type: 'audio-meta', turnId, sampleRate: audio.sampleRate, engine: 'kokoro-fallback' });
  if (ws.readyState === WebSocket.OPEN) ws.send(floatToWav(audio.samples, audio.sampleRate), { binary: true });
}

async function persistHistory() {
  history = history.slice(-80);
  await fsp.writeFile(HISTORY_PATH, JSON.stringify(history, null, 2), 'utf8');
}

async function processTurn(ws, userText, source = 'text') {
  const text = cleanTranscript(userText);
  if (!text) return;
  const controller = new AbortController();
  ws.currentAbort?.abort();
  ws.currentAbort = controller;
  const signal = controller.signal;
  const turnId = Date.now().toString(36);
  const speechPrefetch = createSpeechPrefetch({
    enabled: localServices.hasVoice && channels.status().mode === 'local',
    signal, cleanReply,
    voiceHealth: localServices.voiceHealth, synthesize: localServices.synthesize,
  });
  try {
    send(ws, { type: 'user-text', text, source, turnId });
    let reply;
    const clockReply = localClockReply(text);
    if (clockReply) {
      reply = clockReply;
      send(ws, { type: 'state', value: 'replying' });
    } else {
      try {
        reply = await askLlm(ws, text, signal, speechPrefetch);
      } catch (error) {
        if (error.name === 'AbortError') return;
        send(ws, { type: 'error', message: `大脑连接失败：${error.message}` });
        send(ws, { type: 'state', value: 'idle' });
        return;
      }
    }
    history.push({ role: 'user', content: text }, { role: 'assistant', content: reply });
    await persistHistory();
    if (signal.aborted) return;
    send(ws, { type: 'assistant-final', text: reply, turnId });
    try {
      await speak(ws, reply, turnId, signal, await speechPrefetch.take(reply));
    } catch (error) {
      if (signal.aborted) return;
      send(ws, { type: 'error', message: `本地语音合成失败：${error.message}` });
    }
    send(ws, { type: 'state', value: 'idle' });
  } finally {
    speechPrefetch.dispose();
  }
}

async function transcribeAndReply(ws, samples, source = 'voice') {
  if (!samples?.length || !speech.ready) return;
  send(ws, { type: 'state', value: 'transcribing' });
  const stream = speech.recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: config.speech.sampleRate });
  speech.recognizer.decode(stream);
  const result = speech.recognizer.getResult(stream);
  const text = cleanTranscript(result.text);
  if (text) await processTurn(ws, text, source);
  else send(ws, { type: 'state', value: ws.vadSession?.listening ? 'listening' : 'idle' });
}

function acceptAudio(ws, data) {
  const session = ws.vadSession;
  if (!session?.listening || !speech.ready) return;
  const byteLength = data.byteLength - (data.byteLength % 4);
  const samples = new Float32Array(byteLength / 4);
  const copyBuffer = data.buffer.slice(data.byteOffset, data.byteOffset + byteLength);
  samples.set(new Float32Array(copyBuffer));
  session.receivedSamples += samples.length;
  for (let i = 0; i < samples.length; i += 32) session.peak = Math.max(session.peak, Math.abs(samples[i]));
  if (Array.isArray(session.rawCapture)) session.rawCapture.push(samples);
  session.buffer.push(samples);
  const windowSize = session.vad.config.sileroVad.windowSize;
  while (session.buffer.size() >= windowSize) {
    const frame = session.buffer.get(session.buffer.head(), windowSize);
    session.buffer.pop(windowSize);
    session.vad.acceptWaveform(frame);
  }
  while (!session.vad.isEmpty()) {
    const segment = session.vad.front();
    session.vad.pop();
    session.segmentEmitted = true;
    enqueue(() => transcribeAndReply(ws, segment.samples, 'voice'));
  }
}

async function warmLlm() {
  try {
    await localServices.warm([
      { role: 'system', content: systemPrompt() },
      { role: 'user', content: '在吗？' },
    ]);
    console.log('本地大脑预热完成');
  } catch (error) {
    console.warn(`本地大脑预热跳过：${error.message}`);
  }
}

function speechAvailability() {
  const missing = requiredSpeechFiles().filter((value) => !fs.existsSync(value));
  return { installed: missing.length === 0, missing: missing[0] || null };
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.bmp': 'image/bmp',
  '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.pmx': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  // Binding loopback is not enough: a third-party web page can otherwise open
  // this WebSocket/read history or submit commands to a local HTTP service.
  if (!isAllowedLocalRequest(req, localPolicy.port)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('仅允许本机伴侣页面访问。');
    return;
  }
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('cross-origin-resource-policy', 'same-origin');
  let url;
  try { url = new URL(req.url, `http://${req.headers.host}`); }
  catch { res.writeHead(400).end('Invalid URL'); return; }
  if (url.pathname === '/api/runtime' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify({ app: 'aemeath-local-companion', pid: process.pid,
      security: { policy: RUNTIME_POLICY, credentials: 'session-only', localTransport: LOCAL_SECURITY_POLICY },
      channel: channels.status().mode, dialogueStyle: DIALOGUE_STYLE_VERSION,
      speechPipeline: 'local-first-sentence-prefetch-v1' }));
    return;
  }
  if (url.pathname === '/api/channel') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'GET') { res.end(JSON.stringify(channels.status())); return; }
    // A settings write must originate in the actual companion page. No URL
    // parameters, env injection, cross-site forms or unauthenticated key export.
    if (req.method !== 'POST' || !isAllowedLocalRequest(req, localPolicy.port, { websocket: true })
      || !/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
      res.writeHead(403).end(JSON.stringify({ error: '请从本机伴侣页面操作对话通道。' })); return;
    }
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 16384) { res.writeHead(413).end(JSON.stringify({ error: '配置内容过大。' })); return; }
        chunks.push(chunk);
      }
      let payload;
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400).end(JSON.stringify({ error: '配置格式不正确。' })); return; }
      const previousRevision = channels.status().revision;
      let result;
      if (payload?.action === 'configure') result = channels.configure(payload);
      else if (payload?.action === 'mode') result = channels.setMode(payload.mode);
      else if (payload?.action === 'forget') result = channels.forget();
      else throw new Error('未知通道操作。');
      const paused = previousRevision !== result.revision;
      if (paused) pauseChannelClients();
      broadcast({ type: 'channel-status', channel: result, paused });
      if (paused) broadcast({ type: 'state', value: 'idle' });
      res.end(JSON.stringify(result));
    } catch (error) { res.writeHead(400).end(JSON.stringify({ error: error.message })); }
    return;
  }
  if (url.pathname === '/api/health') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    const [naturalVoice, llm] = await Promise.all([localServices.voiceHealth(), localServices.modelHealth()]);
    const channel = channels.status();
    res.end(JSON.stringify({
      channel,
      llm: channel.mode === 'api' ? { provider: 'api', configured: channel.api.configured, ready: null,
        expected: channel.api.model, status: 'not-probed' } : llm,
      localLlm: llm,
      speech: {
        ready: speech.ready,
        error: speech.error,
        engine: naturalVoice.ready ? (naturalVoice.engine || 'local-natural-tts') : 'kokoro-fallback',
        naturalVoice,
        ...speechAvailability(),
      },
    }));
    return;
  }
  if (url.pathname === '/api/demo' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let payload = {};
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const text = String(payload.text || '').trim();
    const client = [...clients].find(ws => ws.demoClient && ws.readyState === WebSocket.OPEN)
      || [...clients].find(ws => ws.readyState === WebSocket.OPEN);
    if (!text || !client) {
      res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: !text ? 'empty text' : 'no companion page connected' }));
      return;
    }
    enqueue(() => processTurn(client, text, 'demo'));
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url.pathname === '/api/history' && req.method === 'DELETE') {
    channels.clearContext();
    history = [];
    await persistHistory();
    res.writeHead(204).end();
    return;
  }
  if (url.pathname === '/api/test-tts' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json; charset=utf-8');
    if (localServices.hasVoice) {
      try {
        const started = Date.now();
        const response = await localServices.synthesize('晚上好，我终于可以用更自然的声音陪你说话了。');
        const wav = Buffer.from(await response.arrayBuffer());
        const testPath = path.join(DATA_DIR, 'natural-voice-test.wav');
        await fsp.writeFile(testPath, wav);
        res.end(JSON.stringify({ ok: true, engine: 'qwen3-tts', elapsedMs: Date.now() - started, bytes: wav.length, file: testPath }));
        return;
      } catch (error) {
        console.warn(`[natural-voice-test] ${error.message}; trying fallback`);
      }
    }
    if (!speech.ready || !speech.tts) {
      res.writeHead(503).end(JSON.stringify({ error: speech.error || 'speech not ready' }));
      return;
    }
    const started = Date.now();
    const generationConfig = new speech.sherpa.GenerationConfig({
      sid: config.character.voiceSid,
      speed: config.character.voiceSpeed,
      silenceScale: 0.2,
    });
    const audio = await speech.tts.generateAsync({
      text: '晚上好，我终于可以在你的电脑里陪你说话了。',
      enableExternalBuffer: true,
      generationConfig,
      onProgress: () => 1,
    });
    const wav = floatToWav(audio.samples, audio.sampleRate);
    const testPath = path.join(DATA_DIR, 'voice-test.wav');
    await fsp.writeFile(testPath, wav);
    res.end(JSON.stringify({
      ok: true,
      engine: 'kokoro-fallback',
      elapsedMs: Date.now() - started,
      durationSeconds: Number((audio.samples.length / audio.sampleRate).toFixed(2)),
      sampleRate: audio.sampleRate,
      bytes: wav.length,
      file: testPath,
    }));
    return;
  }
  if (url.pathname === '/api/test-asr' && req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const wav = Buffer.concat(chunks);
    if (wav.length < 48) {
      res.writeHead(400).end('empty audio');
      return;
    }
    const dataOffset = wav.indexOf(Buffer.from('data')) + 8;
    const sampleRate = wav.readUInt32LE(24);
    const samples = new Float32Array(Math.floor((wav.length - dataOffset) / 2));
    for (let i = 0; i < samples.length; i += 1) samples[i] = wav.readInt16LE(dataOffset + i * 2) / 32768;
    const started = Date.now();
    const stream = speech.recognizer.createStream();
    stream.acceptWaveform({ samples, sampleRate });
    speech.recognizer.decode(stream);
    const result = speech.recognizer.getResult(stream);
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ text: cleanTranscript(result.text), elapsedMs: Date.now() - started }));
    return;
  }
  const isStage = url.pathname === '/stage' || url.pathname.startsWith('/stage/');
  const staticRoot = isStage ? WALLPAPER_DIR : PUBLIC_DIR;
  let staticPath;
  try {
    // Decode stage paths too: PMX textures include Chinese names and spaces.
    staticPath = decodeURIComponent(isStage ? url.pathname.replace(/^\/stage\/?/, '') : url.pathname.replace(/^\//, '')) || 'index.html';
  } catch {
    res.writeHead(400).end('Invalid path');
    return;
  }
  let filePath = path.resolve(staticRoot, staticPath);
  const relative = path.relative(staticRoot, filePath);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || filePath.includes('\0')) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
    res.setHeader('content-type', mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.setHeader('cache-control', 'no-store, max-age=0');
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404).end('Not found');
  }
});

const wss = new WebSocketServer({ server, path: '/ws',
  verifyClient: ({ req }) => isAllowedLocalRequest(req, localPolicy.port, { websocket: true }),
});
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.vadSession = createVadSession();
  send(ws, {
    type: 'hello',
    character: config.character.name,
    channel: channels.status(),
    speech: { ready: speech.ready, error: speech.error, ...speechAvailability() },
    history: history.slice(-10),
  });
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      acceptAudio(ws, data);
      return;
    }
    try {
      const message = JSON.parse(data.toString('utf8'));
      if (message.type === 'demo-client') { ws.demoClient = true; return; }
      if (message.type === 'text') enqueue(() => processTurn(ws, message.text, 'text'));
      if (message.type === 'listen') {
        let queuedTurn = false;
        if (!ws.vadSession) ws.vadSession = createVadSession();
        if (ws.vadSession) {
          const enable = Boolean(message.enabled);
          if (enable && !ws.vadSession.listening) {
            ws.vadSession.vad.reset?.();
            ws.vadSession.buffer = new speech.sherpa.CircularBuffer(config.speech.sampleRate * 30);
            ws.vadSession.rawCapture = [];
            ws.vadSession.segmentEmitted = false;
            ws.vadSession.receivedSamples = 0;
            ws.vadSession.peak = 0;
          }
          if (!enable && ws.vadSession.listening) {
            ws.vadSession.vad.flush();
            let emitted = Boolean(ws.vadSession.segmentEmitted);
            while (!ws.vadSession.vad.isEmpty()) {
              const segment = ws.vadSession.vad.front();
              ws.vadSession.vad.pop();
              enqueue(() => transcribeAndReply(ws, segment.samples, 'voice'));
              emitted = true;
            }
            if (message.reason !== 'continuous-mode-off' && !emitted && !ws.vadSession.segmentEmitted && ws.vadSession.rawCapture?.length) {
              const parts = ws.vadSession.rawCapture;
              const size = parts.reduce((sum, part) => sum + part.length, 0);
              const samples = new Float32Array(size);
              let offset = 0;
              for (const part of parts) { samples.set(part, offset); offset += part.length; }
              enqueue(() => transcribeAndReply(ws, samples, 'voice'));
              emitted = true;
            }
            queuedTurn = emitted;
            if (!ws.vadSession.receivedSamples) {
              send(ws, { type: 'error', message: '没有收到麦克风音频，请检查浏览器麦克风权限与 Windows 输入设备。' });
            } else if (ws.vadSession.peak < 0.002) {
              send(ws, { type: 'error', message: '麦克风信号过低，请靠近一些再说。' });
            }
            ws.vadSession.rawCapture = null;
          }
          ws.vadSession.listening = enable;
        }
        if (message.enabled) send(ws, { type: 'state', value: 'listening' });
        else if (!queuedTurn) send(ws, { type: 'state', value: 'idle' });
      }
      if (message.type === 'interrupt') {
        ws.currentAbort?.abort();
        send(ws, { type: 'state', value: 'listening' });
      }
    } catch (error) {
      send(ws, { type: 'error', message: error.message });
    }
  });
  ws.on('close', () => {
    ws.currentAbort?.abort();
    clients.delete(ws);
  });
});

const host = localPolicy.host;
const port = localPolicy.port;
server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`\n爱弥斯 · 本地赛博伴侣已启动：${url}`);
  console.log(`大脑：本地 ${config.llm.baseUrl} / ${config.llm.model}`);
  initSpeech();
  warmLlm();
  if (config.app.openBrowser && process.argv.includes('--open')) {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});

process.on('SIGINT', () => server.close(() => process.exit(0)));

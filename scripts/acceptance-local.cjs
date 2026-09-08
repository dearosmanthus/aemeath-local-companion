'use strict';

// Explicit live acceptance. Default: status only. --chat adds ONE local test
// conversation to the app's normal history. Never opens microphone or a browser.
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createCompanionFetch, LOCAL_SECURITY_POLICY } = require('../lib/companion-network');
const { RUNTIME_POLICY } = require('../lib/conversation-channel');
const origin = 'http://127.0.0.1:17860';
const local = createCompanionFetch(globalThis.fetch, { allowedOrigins: [origin] });

async function readStatus(route) {
  const response = await local(origin + route, { signal: AbortSignal.timeout(15000) });
  assert.ok(response.ok, `${route} status ${response.status}`);
  return response.json();
}

async function completeTurn() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ws = new WebSocket('ws://127.0.0.1:17860/ws', { origin, handshakeTimeout: 5000 });
    const result = { firstTextMs: null, replyMs: null, firstAudioMs: null, totalMs: null,
      reply: '', engine: '', sampleRate: 0, audioBytes: 0, chunks: 0, audioComplete: false };
    let sampleCount = 0;
    let energy = 0;
    let peak = 0;
    let clipped = 0;
    let pendingByte = null;
    let done = false;
    let streamed = false;
    const timer = setTimeout(() => finish(new Error('Full local turn timed out after 180 seconds.')), 180000);
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (ws.readyState === WebSocket.OPEN) ws.close();
      else if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
      if (error) reject(error); else resolve(result);
    };
    const consumePcm = data => {
      let index = 0;
      const sample = value => {
        const normalized = value / 32768;
        sampleCount++; energy += normalized * normalized;
        peak = Math.max(peak, Math.abs(normalized));
        if (Math.abs(normalized) >= .999) clipped++;
      };
      if (pendingByte !== null && data.length) {
        const value = pendingByte | (data[index++] << 8);
        sample(value >= 32768 ? value - 65536 : value);
        pendingByte = null;
      }
      while (index + 1 < data.length) { sample(data.readInt16LE(index)); index += 2; }
      if (index < data.length) pendingByte = data[index];
    };
    ws.on('open', () => ws.send(JSON.stringify({
      type: 'text', text: '[本地验收测试] 请用一句中文问候我，不要写动作或解释。',
    })));
    ws.on('error', () => finish(new Error('Local companion WebSocket failed.')));
    ws.on('close', () => { if (!done) finish(new Error('Connection ended before the complete reply/audio/idle sequence.')); });
    ws.on('message', (data, binary) => {
      if (done) return;
      try {
        if (binary) {
          result.firstAudioMs ??= Date.now() - started;
          result.audioBytes += data.length;
          result.chunks++;
          if (streamed) consumePcm(data);
          else {
            assert.equal(data.toString('ascii', 0, 4), 'RIFF', 'WAV header missing');
            assert.equal(data.toString('ascii', 8, 12), 'WAVE', 'WAV header invalid');
            result.audioComplete = true;
          }
          assert.ok(result.audioBytes < 32 * 1024 * 1024, 'Unexpectedly large test audio');
          return;
        }
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'hello') return; // Do not inspect or log old history.
        if (message.type === 'assistant-delta') result.firstTextMs ??= Date.now() - started;
        if (message.type === 'assistant-final') {
          result.reply = String(message.text || ''); result.replyMs = Date.now() - started;
        }
        if (message.type === 'audio-stream-start' || message.type === 'audio-meta') {
          streamed = message.type === 'audio-stream-start';
          result.engine = message.engine; result.sampleRate = Number(message.sampleRate) || 0;
          if (streamed) assert.equal(message.format, 'pcm_s16le');
        }
        if (message.type === 'audio-stream-end') result.audioComplete = true;
        if (message.type === 'error') throw new Error(`Companion test error: ${String(message.message || '').slice(0, 180)}`);
        if (message.type === 'state' && message.value === 'idle' && result.reply) {
          result.totalMs = Date.now() - started;
          assert.ok(result.audioComplete && result.audioBytes > 0, 'Audio incomplete');
          assert.equal(result.engine, 'VoxCPM2-Ultimate-Clone', 'Unexpected voice fallback');
          if (streamed) {
            assert.equal(pendingByte, null, 'Incomplete PCM sample');
            assert.ok(result.sampleRate > 0);
            result.audioSeconds = Number((sampleCount / result.sampleRate).toFixed(2));
            result.rms = Number(Math.sqrt(energy / Math.max(1, sampleCount)).toFixed(5));
            result.peak = Number(peak.toFixed(5));
            result.clippedFraction = Number((clipped / Math.max(1, sampleCount)).toFixed(6));
            assert.ok(result.audioSeconds > .3 && result.rms > .001, 'Silent or incomplete test audio');
          }
          finish();
        }
      } catch (error) { finish(error); }
    });
  });
}

(async () => {
  const runtime = await readStatus('/api/runtime');
  assert.equal(runtime.app, 'aemeath-local-companion');
  assert.equal(runtime.security.policy, RUNTIME_POLICY);
  assert.equal(runtime.security.localTransport, LOCAL_SECURITY_POLICY);
  assert.equal(runtime.security.credentials, 'session-only');
  assert.equal(runtime.channel, 'local', 'Live local acceptance must not execute while API mode is selected');
  const health = await readStatus('/api/health');
  assert.equal(health.llm.provider, 'local');
  assert.equal(health.llm.ready, true);
  assert.equal(health.speech.ready, true);
  assert.equal(health.speech.naturalVoice.ready, true);
  console.log(JSON.stringify({ statusPassed: true, pid: runtime.pid, provider: health.llm.provider, voice: health.speech.engine }));
  if (process.argv.includes('--chat')) console.log(JSON.stringify({ fullTurnPassed: true, ...await completeTurn() }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });

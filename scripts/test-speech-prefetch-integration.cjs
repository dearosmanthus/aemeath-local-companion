'use strict';

// Run the real server turn with in-memory services/fs/ws. Never listen or load
// real config/history, model, microphone, voice or provider credentials.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const network = require('../lib/companion-network');
const channels = require('../lib/conversation-channel');
const prefetchModule = require('../lib/speech-prefetch.cjs');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const fullReply = '你好，我在这里。你可以慢慢说。';

async function run({ api = false, mismatch = false, failTail = false, badTailRate = false, firstFailure = '', fallbackReady = false, abortDuringAudio = false } = {}) {
  const events = [], calls = [], writes = [];
  let fallbackCalls = 0, cancelled = 0;
  const cfg = { app: { host: '127.0.0.1', port: 17860 },
    llm: { mode: 'local', baseUrl: 'http://127.0.0.1:1235/v1', model: 'fixture' },
    speech: { naturalTtsUrl: 'http://127.0.0.1:17861', sampleRate: 16000 }, character: {},
  };
  const local = {
    policy: network.validateLocalConfig(cfg), hasVoice: true,
    async chat(_messages, { onDelta }) {
      onDelta(mismatch ? '将被更正的第一句。后面' : '你好，我在这里。你');
      await tick();
      assert.equal(calls.length, 1, 'local synthesis starts while the LLM is still generating');
      assert.equal(events.some(event => event.type === 'audio-stream-start' || event.binary), false, 'no prefetch audio plays before final validation');
      onDelta('可以慢慢说。');
      return fullReply;
    },
    voiceHealth: async () => ({ ready: true, streaming: true, sampleRate: 48000 }),
    async synthesize(text) {
      calls.push(text);
      if (api) assert.ok(events.some(event => event.type === 'assistant-final'), 'API voice starts only after its complete final reply');
      if (mismatch && calls.length === 1) return new Response(new ReadableStream({ cancel() { cancelled++; } }));
      if (firstFailure && calls.length === 1) {
        return firstFailure === 'empty' ? new Response(new Uint8Array())
          : new Response(new ReadableStream({ start(controller) { controller.error(new Error('fixture stream failure')); } }));
      }
      if (failTail && calls.length === 2) throw new Error('fixture tail failure');
      return new Response(new Uint8Array([calls.length, 0]), { headers: { 'x-sample-rate': badTailRate && calls.length === 2 ? '44100' : '48000' } });
    },
  };
  const context = { URL, Buffer, AbortController, console, __dirname: root,
    process: { pid: 42, argv: [], on() {} },
    require(name) {
      if (name === 'http') return { createServer() { return { listen() {}, close() {}, on() {} }; } };
      if (name === 'path') return path;
      if (name === 'fs') return { existsSync: () => true, mkdirSync() {},
        readFileSync: file => path.basename(file) === 'config.json' ? JSON.stringify(cfg) : '[]',
        promises: { writeFile: async (_file, content) => writes.push(JSON.parse(content)) } };
      if (name === 'child_process') return { spawn() { assert.fail('no process launches'); } };
      if (name === 'ws') return { WebSocket: { OPEN: 1 }, WebSocketServer: class { on() {} } };
      if (name === './lib/companion-network') return { ...network, clearInheritedCompanionCredentials() {} };
      if (name === './lib/character-dialogue') return require('../lib/character-dialogue');
      if (name === './lib/speech-prefetch.cjs') return prefetchModule;
      if (name === './lib/local-services') return { createLocalServices: () => local };
      if (name === './lib/conversation-channel') return { ...channels, createConversationChannel: options => channels.createConversationChannel({ ...options,
        fetchImpl: async () => Response.json({ choices: [{ message: { content: fullReply } }] }),
      }) };
      assert.fail('unexpected dependency ' + name);
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.fixture = { processTurn, channels, speech };', context);
  const fixture = context.fixture;
  fixture.speech.ready = !firstFailure || fallbackReady;
  fixture.speech.sherpa = { GenerationConfig: class {} };
  fixture.speech.tts = { async generateAsync() { fallbackCalls++; return { samples: new Float32Array([0]), sampleRate: 48000 }; } };
  if (api) {
    fixture.channels.configure({ consent: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture' });
    fixture.channels.setMode('api');
  }
  const ws = { readyState: 1, send(value, options) {
    events.push(options?.binary ? { binary: Array.from(value) } : JSON.parse(value));
    if (options?.binary && abortDuringAudio) ws.currentAbort.abort();
  } };
  await fixture.processTurn(ws, '测试对话', 'text');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].at(-1).content, fullReply, 'persist complete final reply, never just the prefetched sentence');
  assert.equal(events.filter(event => event.type === 'assistant-final').length, 1);
  assert.equal(events.find(event => event.type === 'assistant-final').text, fullReply);
  if (firstFailure) {
    assert.equal(events.filter(event => event.type === 'audio-stream-start').length, 0, 'an empty/failed initial chunk never opens frontend playback');
    assert.equal(events.filter(event => event.type === 'audio-stream-end').length, 0, 'no early end can trigger continuous listening before fallback');
    assert.equal(fallbackCalls, fallbackReady ? 1 : 0);
    assert.equal(events.some(event => event.type === 'error'), !fallbackReady);
    assert.equal(events.at(-1).value, 'idle');
    if (fallbackReady) assert.equal(events.filter(event => event.binary).length, 1, 'the whole reply is emitted exactly once by the available fallback');
    return;
  }
  assert.equal(events.filter(event => event.type === 'audio-stream-start').length, 1);
  assert.equal(events.filter(event => event.type === 'audio-stream-end').length, 1);
  assert.equal(fallbackCalls, 0);
  if (abortDuringAudio) {
    assert.deepEqual(calls, ['你好，我在这里。'], 'cancel prevents suffix generation');
    assert.equal(events.filter(event => event.binary).length, 1);
    assert.equal(events.some(event => event.type === 'error'), false);
    return;
  }
  if (api) assert.deepEqual(calls, [fullReply]);
  else if (mismatch) { assert.deepEqual(calls, ['将被更正的第一句。', fullReply]); assert.equal(cancelled, 1); }
  else assert.deepEqual(calls, ['你好，我在这里。', '你可以慢慢说。']);
  assert.equal(events.some(event => event.type === 'error'), failTail || badTailRate);
  if (failTail || badTailRate) assert.equal(events.filter(event => event.binary).length, 2, 'tail failure sends first PCM + pause without fallback replay');
}

(async () => {
  await run();
  await run({ mismatch: true });
  await run({ failTail: true });
  await run({ badTailRate: true });
  await run({ abortDuringAudio: true });
  await run({ api: true });
  await run({ firstFailure: 'empty' });
  await run({ firstFailure: 'error' });
  await run({ firstFailure: 'empty', fallbackReady: true });
  console.log('Speech prefetch integration passed: real server turn, precompute without early playback, full history/final, one PCM stream, mismatch fallback, no replay after partial failure and API isolation. Fixtures only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

'use strict';

// Execute the actual server handler with in-memory HTTP/fs/service doubles.
// No listener, real configuration/history, microphone, model or external API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const network = require('../lib/companion-network');
const channelModule = require('../lib/conversation-channel');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const fixtureConfig = {
  app: { host: '127.0.0.1', port: 17860 },
  llm: { mode: 'local', baseUrl: 'http://127.0.0.1:1235/v1', model: 'fixture' },
  speech: { modelRoot: 'unused-fixture-model-directory', sampleRate: 16000 }, character: {},
};
let handler;
let externalCalls = 0;
let healthCalls = 0;
const context = {
  URL, Buffer, AbortController, console, __dirname: root,
  process: { pid: 42, argv: [], on() {} },
  require(name) {
    if (name === 'http') return { createServer(callback) { handler = callback; return { listen() {}, close() {} }; } };
    if (name === 'path') return path;
    if (name === 'fs') return { existsSync: () => true, mkdirSync() {},
      readFileSync: file => path.basename(file) === 'config.json' ? JSON.stringify(fixtureConfig) : '[]',
      promises: { writeFile: async () => {} } };
    if (name === 'child_process') return { spawn() { assert.fail('no spawned process'); } };
    if (name === 'ws') return { WebSocket: { OPEN: 1 }, WebSocketServer: class { on() {} } };
    if (name === './lib/companion-network') return { ...network, clearInheritedCompanionCredentials() {} };
    if (name === './lib/character-dialogue') return require('../lib/character-dialogue');
    if (name === './lib/speech-prefetch.cjs') return require('../lib/speech-prefetch.cjs');
    if (name === './lib/local-services') return { createLocalServices: () => ({ policy: network.validateLocalConfig(fixtureConfig),
      chat: async () => '本地测试。', voiceHealth: async () => { healthCalls++; return { ready: true }; },
      modelHealth: async () => { healthCalls++; return { ready: true, provider: 'local' }; } }) };
    if (name === './lib/conversation-channel') return { ...channelModule,
      createConversationChannel: options => channelModule.createConversationChannel({ ...options,
        fetchImpl: async () => { externalCalls++; assert.fail('settings/health must never probe API'); } }) };
    assert.fail('Unexpected dependency: ' + name);
  },
};
vm.createContext(context);
vm.runInContext(source + '\nglobalThis.fixture = { channels, clients, enqueue };', context);
const { fixture } = context;
const origin = 'http://127.0.0.1:17860';
async function request(method, url, payload, headers = {}) {
  const req = {
    method, url, socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:17860', origin, 'content-type': 'application/json', ...headers },
    async *[Symbol.asyncIterator]() { if (payload !== undefined) yield Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)); },
  };
  const res = { status: 200, headers: {}, body: '', setHeader(key, value) { this.headers[key] = value; },
    writeHead(status) { this.status = status; return this; }, end(value = '') { this.body = String(value); return this; } };
  await handler(req, res);
  return res;
}
const body = res => JSON.parse(res.body);

(async () => {
  assert.equal(body(await request('GET', '/api/channel')).mode, 'local');
  const config = { action: 'configure', consent: true, baseUrl: 'https://chat.example.invalid/v1', model: 'fixture', apiKey: 'fixture-key-not-real' };
  for (const headers of [{ origin: undefined }, { origin: 'https://page.example.invalid' }, { 'content-type': 'text/plain' }]) {
    assert.equal((await request('POST', '/api/channel', config, headers)).status, 403);
    assert.equal(fixture.channels.status().api.configured, false);
  }
  assert.equal((await request('POST', '/api/channel', '{invalid')).status, 400);
  assert.equal((await request('POST', '/api/channel', 'x'.repeat(17000))).status, 413);
  assert.equal((await request('POST', '/api/channel', { ...config, consent: false })).status, 400);

  const wsMessages = [];
  let vadResets = 0;
  let bufferResets = 0;
  const oldAbort = new AbortController();
  const client = { readyState: 1, send: value => wsMessages.push(JSON.parse(value)), currentAbort: oldAbort,
    vadSession: { listening: true, rawCapture: [new Float32Array([.2])], segmentEmitted: true, receivedSamples: 1, peak: .2,
      vad: { reset() { vadResets++; }, flush() { assert.fail('do not flush pre-switch audio'); } },
      buffer: { reset() { bufferResets++; } } } };
  fixture.clients.add(client);
  let releaseQueue;
  const started = new Promise(resolve => { releaseQueue = resolve; });
  fixture.enqueue(() => started);
  await Promise.resolve();
  let staleRan = false;
  fixture.enqueue(() => { staleRan = true; });
  const saved = await request('POST', '/api/channel', config);
  assert.equal(saved.status, 200);
  assert.equal(body(saved).mode, 'local');
  assert.equal(saved.body.includes(config.apiKey), false);
  assert.equal(oldAbort.signal.aborted, true);
  assert.equal(client.vadSession.listening, false);
  assert.equal(client.vadSession.rawCapture, null);
  assert.equal(vadResets, 1);
  assert.equal(bufferResets, 1);
  assert.equal(wsMessages.find(message => message.type === 'channel-status').paused, true);
  assert.equal(JSON.stringify(wsMessages).includes(config.apiKey), false);
  releaseQueue();
  await fixture.enqueue(() => {});
  assert.equal(staleRan, false, 'queued old-channel requests are discarded');
  assert.equal(externalCalls, 0);

  const switched = await request('POST', '/api/channel', { action: 'mode', mode: 'api' });
  assert.equal(body(switched).mode, 'api');
  assert.equal(externalCalls, 0);
  const health = body(await request('GET', '/api/health'));
  assert.equal(health.llm.status, 'not-probed');
  assert.equal(health.llm.ready, null);
  assert.equal(health.localLlm.ready, true);
  assert.equal(healthCalls, 2, 'health checks only call the two local adapters');
  const runtime = body(await request('GET', '/api/runtime'));
  assert.equal(runtime.security.policy, 'selectable-chat-v1');
  assert.equal(runtime.security.localTransport, 'loopback-only-v2');
  assert.equal(runtime.channel, 'api');
  assert.equal(externalCalls, 0);
  const resets = vadResets;
  await request('POST', '/api/channel', { action: 'mode', mode: 'api' });
  assert.equal(vadResets, resets, 'selecting the already active mode does not pause a call');
  const forgotten = body(await request('POST', '/api/channel', { action: 'forget' }));
  assert.equal(forgotten.mode, 'local');
  assert.equal(forgotten.api.hasKey, false);

  const apiSource = fs.readFileSync(path.join(root, 'lib/conversation-channel.js'), 'utf8');
  assert.equal(/process\.env|readFile|writeFile|require\(['"](?:node:)?(?:fs|http|https|net|tls|child_process)/.test(apiSource), false);
  const ui = fs.readFileSync(path.join(root, 'public/channel-controls.js'), 'utf8');
  assert.equal(/localStorage|sessionStorage|document\.cookie|console\./.test(ui), false, 'key UI has no persistence or logging');
  assert.equal(/fetch\(['"]https?:/.test(ui), false, 'browser never directly calls a provider');
  assert.ok(ui.includes('startedEpoch !== epoch'), 'late status reads cannot overwrite a newer action');
  assert.ok(ui.includes("key.value = ''"));
  assert.ok(!/name="consent"[^>]*checked/.test(ui), 'consent is not preselected');
  for (const relative of ['public/index.html', 'wallpaper/index.html']) {
    const html = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(html.includes('/channel-controls.js') && html.includes('/channel-controls.css'));
  }
  for (const relative of ['public/app.js', 'wallpaper/wallpaper.js']) {
    const clientSource = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.ok(clientSource.includes('if (message.paused)'));
    assert.ok(clientSource.includes("'companion-channel-status'"));
  }
  console.log('Channel integration passed: actual handlers in VM, Origin/JSON/size guards, key redaction, microphone discard, queue cancellation, no API health probe, UI wiring. No live I/O.');
})().catch(error => { console.error(error); process.exitCode = 1; });

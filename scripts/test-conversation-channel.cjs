'use strict';

// Pure in-memory fixtures: no real requests, files, credentials or listeners.
const assert = require('node:assert/strict');
const { createConversationChannel, validateApiSettings } = require('../lib/conversation-channel');
const settings = () => ({ consent: true, baseUrl: 'https://chat.example.invalid/v1/', model: 'fixture-model', apiKey: 'fixture-key-not-real' });
const chatInput = () => ({ system: '角色测试设定', text: '当前发言', localMessages: [{ role: 'user', content: '不可外发的旧本地消息' }] });
const jsonReply = () => Response.json({ choices: [{ message: { content: '你好。' } }] });
const event = content => 'data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\r\n\r\n';

(async () => {
  const calls = [];
  let localCalls = 0;
  const channel = createConversationChannel({
    localChat: async (messages, options) => { localCalls++; assert.deepEqual(messages, chatInput().localMessages); options.onDelta?.('本地。'); return '本地。'; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return jsonReply(); },
  });
  assert.equal(channel.status().mode, 'local');
  assert.equal(channel.status().api.configured, false);
  assert.throws(() => channel.setMode('api'), /先填写/);
  assert.equal(await channel.chat(chatInput()), '本地。');
  assert.equal(calls.length, 0);
  const invalid = [null, {}, { ...settings(), consent: false },
    ...['http://chat.example.invalid/v1', 'https://fixture-key-not-real@chat.example.invalid/v1',
      'https://chat.example.invalid/v1?key=fixture-key-not-real', 'https://chat.example.invalid/v1#key',
      'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1',
      'https://chat.example.invalid/v1/chat/completions', 'https://chat.example.invalid/v1/responses']
      .map(baseUrl => ({ ...settings(), baseUrl })),
    { ...settings(), apiKey: '' }, { ...settings(), apiKey: 'bad\nheader' }, { ...settings(), model: '' }];
  for (const input of invalid) {
    assert.throws(() => channel.configure(input), error => !error.message.includes('fixture-key-not-real'));
    assert.equal(channel.status().api.configured, false);
  }
  assert.equal(validateApiSettings(settings()).baseUrl, 'https://chat.example.invalid/v1');
  channel.configure(settings());
  assert.equal(channel.status().mode, 'local', 'saving does not opt in');
  assert.equal(calls.length, 0, 'save performs no health/models/chat request');
  channel.setMode('api');
  assert.equal(calls.length, 0, 'mode change alone performs no request');
  assert.equal(JSON.stringify(channel.status()).includes(settings().apiKey), false);
  assert.equal(await channel.chat(chatInput()), '你好。');
  assert.equal(calls.length, 1);
  assert.equal(localCalls, 1);
  const request = calls[0];
  assert.equal(request.url, 'https://chat.example.invalid/v1/chat/completions');
  assert.equal(request.options.headers.authorization, 'Bearer fixture-key-not-real');
  assert.equal(request.options.redirect, 'error');
  assert.equal(request.options.credentials, 'omit');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { model: 'fixture-model', stream: true,
    messages: [{ role: 'system', content: '角色测试设定' }, { role: 'user', content: '当前发言' }] });
  for (let index = 0; index < 5; index++) await channel.chat({ ...chatInput(), text: `新消息${index}` });
  for (const call of calls) {
    assert.ok(JSON.parse(call.options.body).messages.length <= 8);
    assert.equal(call.options.body.includes('不可外发'), false);
  }
  assert.equal(channel.status().api.historyMessages, 6);
  channel.setMode('local');
  assert.equal(channel.status().api.historyMessages, 0);
  channel.setMode('api');
  await channel.chat(chatInput());
  assert.equal(JSON.parse(calls.at(-1).options.body).messages.length, 2);
  channel.clearContext();
  assert.equal(channel.status().api.historyMessages, 0);
  channel.forget();
  assert.equal(channel.status().mode, 'local');
  assert.equal(channel.status().api.hasKey, false);
  assert.equal(channel.status().api.baseUrl, '');

  const streamText = event('<thi') + event('nk>隐藏推理') + event('</think>你') + event('好。') + 'data: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(streamText);
  const streamed = createConversationChannel({ localChat: async () => assert.fail('no fallback'), fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }) });
  streamed.configure(settings()); streamed.setMode('api');
  const deltas = [];
  assert.equal(await streamed.chat({ ...chatInput(), onDelta: delta => deltas.push(delta) }), '你好。');
  assert.equal(deltas.join(''), '你好。', 'UTF-8 and split thought tags handled');

  for (const fixture of [
    async () => new Response('fixture-key-not-real', { status: 401 }),
    async () => { throw new Error('fixture-key-not-real'); },
    async () => new Response('data: {broken\n\n'),
    async () => Response.json({ error: { message: 'fixture-key-not-real' } }),
    async () => ({ redirected: true, body: { cancel: async () => {} } }),
  ]) {
    let count = 0;
    const failing = createConversationChannel({ localChat: async () => assert.fail('must not fall back'),
      fetchImpl: async (...args) => { count++; return fixture(...args); } });
    failing.configure(settings()); failing.setMode('api');
    await assert.rejects(failing.chat(chatInput()), error => !error.message.includes('fixture-key-not-real'));
    assert.equal(count, 1, 'no automatic retry');
    assert.equal(failing.status().mode, 'api');
    assert.equal(failing.status().api.historyMessages, 0);
    assert.equal(failing.status().busy, false);
  }

  let inFlightSignal;
  const inFlight = createConversationChannel({ localChat: async () => '本地。', fetchImpl: async (_url, options) => {
    inFlightSignal = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  inFlight.configure(settings()); inFlight.setMode('api');
  const response = inFlight.chat(chatInput());
  assert.equal(inFlight.status().busy, true);
  inFlight.setMode('local');
  await assert.rejects(response, { name: 'AbortError' });
  assert.equal(inFlightSignal.aborted, true);
  assert.equal(inFlight.status().api.historyMessages, 0);
  assert.equal(inFlight.status().busy, false);

  let finishDelayed;
  const delayed = createConversationChannel({ localChat: async () => '本地。', fetchImpl: async () => new Promise(resolve => { finishDelayed = resolve; }) });
  delayed.configure(settings()); delayed.setMode('api');
  const delayedDeltas = [];
  const oldReply = delayed.chat({ ...chatInput(), onDelta: value => delayedDeltas.push(value) });
  delayed.forget(); finishDelayed(jsonReply());
  await assert.rejects(oldReply, { name: 'AbortError' });
  assert.deepEqual(delayedDeltas, [], 'a late response cannot emit or re-create forgotten history');
  assert.equal(delayed.status().api.historyMessages, 0);
  const restarted = createConversationChannel({ localChat: async () => '本地。', fetchImpl: async () => assert.fail('no startup request') });
  assert.equal(restarted.status().mode, 'local');
  assert.equal(restarted.status().api.hasKey, false);
  console.log('Conversation channel passed: explicit opt-in, exact destination, session-only key, isolated bounded history, stream/JSON, cancellation, no fallback/probes/retries. All requests were in-memory fixtures.');
})().catch(error => { console.error(error); process.exitCode = 1; });

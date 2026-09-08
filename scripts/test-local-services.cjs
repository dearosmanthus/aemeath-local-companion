'use strict';

// Entirely in-memory fixtures: no file/config/history reads, listeners or HTTP.
const assert = require('node:assert/strict');
const { createLocalServices } = require('../lib/local-services');
const config = () => ({
  app: { host: '127.0.0.1', port: 17860 },
  llm: { mode: 'local', baseUrl: 'http://localhost:1235/v1/', model: 'fixture-model', temperature: .7, topP: .9, maxTokens: 96 },
  speech: { naturalTtsUrl: 'http://127.0.0.1:17861/' },
});
const messages = [{ role: 'user', content: '测试台词' }];
const event = token => 'data: ' + JSON.stringify({ choices: [{ delta: { content: token } }] }) + '\r\n\r\n';
const streamResponse = (text, stride = 1) => {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += stride) controller.enqueue(bytes.slice(index, index + stride));
    controller.close();
  } }));
};
const clientWith = fetchImpl => createLocalServices(config(), { fetchImpl });

(async () => {
  const calls = [];
  const client = clientWith(async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'fixture-model' }] });
    if (url.endsWith('/health')) return Response.json({ ready: true, streaming: true, sampleRate: 48000 });
    if (url.endsWith('/chat/completions')) {
      if (!JSON.parse(options.body).stream) return Response.json({ choices: [] });
      return streamResponse(': keepalive\r\n\r\n' + event('<thi') + event('nk>测试推理') + event('</th') + event('ink>你好，') + event('我在。') + 'data: [DONE]\r\n\r\n');
    }
    return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'x-sample-rate': '48000' } });
  });
  assert.ok(Object.isFrozen(client));
  const deltas = [];
  assert.equal(await client.chat(messages, { onDelta: token => deltas.push(token) }), '你好，我在。');
  assert.equal(deltas.join(''), '你好，我在。', 'UTF-8 and thought tags can split across frames without appearing in subtitles');
  const requestBody = JSON.parse(calls[0].options.body);
  assert.deepEqual(requestBody.messages, messages);
  assert.equal(requestBody.model, 'fixture-model');
  assert.equal(requestBody.stream, true);
  assert.equal((await client.modelHealth()).ready, true);
  await client.warm(messages);
  const warmBody = JSON.parse(calls.at(-1).options.body);
  assert.equal(warmBody.stream, false);
  assert.equal(warmBody.max_tokens, 2);
  assert.equal((await client.voiceHealth()).sampleRate, 48000);
  const pcm = await client.synthesize('测试台词', { stream: true });
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:17861/tts-stream');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { text: '测试台词' });
  assert.equal((await pcm.arrayBuffer()).byteLength, 4);
  const wav = await client.synthesize('测试台词');
  assert.equal(calls.at(-1).url, 'http://127.0.0.1:17861/tts');
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { text: '测试台词', language: 'Chinese' });
  await wav.arrayBuffer();
  for (const { url, options } of calls) {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.headers.has('authorization'), false);
    assert.equal(options.headers.has('cookie'), false);
    assert.ok(options.signal instanceof AbortSignal);
  }

  const tail = clientWith(async () => streamResponse(event('第一句。') + event('最后一段。').trimEnd(), 7));
  assert.equal(await tail.chat(messages), '第一句。最后一段。', 'unterminated final SSE frame is consumed');
  const noThoughtEnd = clientWith(async () => streamResponse(event('<think>未完成的推理') + 'data: [DONE]\n\n'));
  await assert.rejects(noThoughtEnd.chat(messages), /没有返回可用台词/);
  const malformed = clientWith(async () => streamResponse('data: {broken\n\n'));
  await assert.rejects(malformed.chat(messages), /无效的流式数据/);
  const reportedError = clientWith(async () => streamResponse('data: {"error":{"message":"fixture"}}\n\n'));
  await assert.rejects(reportedError.chat(messages), /生成失败/);

  let cancelled = 0;
  const bounded = clientWith(async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event('完成。') + 'data: [DONE]\n\n')); },
    cancel() { cancelled++; },
  })));
  assert.equal(await bounded.chat(messages), '完成。');
  assert.equal(cancelled, 1, '[DONE] closes an otherwise-open response reader');

  let failedCalls = 0;
  const down = clientWith(async () => { failedCalls++; return new Response('fixture unavailable', { status: 503 }); });
  await assert.rejects(down.chat(messages), /503/);
  assert.equal(failedCalls, 1, 'generation failure has no secondary provider request');
  assert.equal((await down.modelHealth()).provider, 'local');
  const noVoiceConfig = config();
  delete noVoiceConfig.speech.naturalTtsUrl;
  const noVoice = createLocalServices(noVoiceConfig, { fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.equal(noVoice.hasVoice, false);
  assert.deepEqual(await noVoice.voiceHealth(), { ready: false, configured: false });
  await assert.rejects(noVoice.synthesize('测试'), /未配置/);

  let abortedCalls = 0;
  const abort = new AbortController();
  abort.abort();
  const preAborted = clientWith(async () => { abortedCalls++; throw new Error('must not be called'); });
  await assert.rejects(preAborted.chat(messages, { signal: abort.signal }), { name: 'AbortError' });
  assert.equal(abortedCalls, 0);
  const midAbort = new AbortController();
  let interruptedDeltas = 0;
  const interrupt = clientWith(async () => streamResponse(event('你好。') + event('后续台词') + 'data: [DONE]\n\n', 10000));
  await assert.rejects(interrupt.chat(messages, { signal: midAbort.signal, onDelta: () => { interruptedDeltas++; midAbort.abort(); } }), { name: 'AbortError' });
  assert.equal(interruptedDeltas, 1, 'abort must also stop frames already buffered in the same chunk');

  const mutableConfig = config();
  const pinnedCalls = [];
  const pinned = createLocalServices(mutableConfig, { fetchImpl: async url => { pinnedCalls.push(url); return Response.json({ data: [{ id: 'fixture-model' }] }); } });
  mutableConfig.llm.baseUrl = 'https://example.invalid/v1';
  mutableConfig.llm.model = 'changed-fixture';
  assert.equal((await pinned.modelHealth()).ready, true);
  assert.deepEqual(pinnedCalls, ['http://127.0.0.1:1235/v1/models'], 'settings are captured at validated startup');
  console.log('Local services passed: fixture-only chat/SSE, UTF-8, final frame, thought filtering, cancellation, errors, warmup, health and PCM/WAV contracts. No real requests made.');
})().catch(error => { console.error(error); process.exitCode = 1; });

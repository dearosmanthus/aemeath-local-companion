'use strict';

// In-memory only: no model/voice calls, credentials, network or user history.
const assert = require('node:assert/strict');
const { cleanSpokenReply } = require('../lib/character-dialogue');
const { createConversationChannel } = require('../lib/conversation-channel');
const { firstStableSentence, createSpeechPrefetch, pipePcmResponse, streamSpeechSegments } = require('../lib/speech-prefetch.cjs');
const cleanReply = value => cleanSpokenReply(value, { name: '爱弥斯' });
const tick = () => new Promise(resolve => setImmediate(resolve));
const pcm = (...values) => new Response(new Uint8Array(values), { headers: { 'x-sample-rate': '48000' } });
const ready = async () => ({ ready: true, streaming: true, sampleRate: 48000 });

function fixture({ enabled = true, synthesize, voiceHealth = ready } = {}) {
  const calls = [];
  const abort = new AbortController();
  const prefetch = createSpeechPrefetch({ enabled, signal: abort.signal, cleanReply, voiceHealth,
    synthesize: async (text, options) => {
      calls.push({ text, options });
      return synthesize ? synthesize(text, options) : pcm(1, 2);
    },
  });
  return { prefetch, calls, abort };
}

(async () => {
  assert.equal(firstStableSentence('你好。', cleanReply), null);
  assert.equal(firstStableSentence('你好！？', cleanReply), null);
  assert.equal(firstStableSentence('你好！？接着说。', cleanReply), '你好！？');
  assert.equal(firstStableSentence('“你好。”', cleanReply), null, 'a closing quote is not the next sentence');
  assert.equal(firstStableSentence('“你好。”接着说。', cleanReply), '“你好。”');
  assert.equal(firstStableSentence('（动作。未完成', cleanReply), null);
  assert.equal(firstStableSentence('爱弥斯：*轻声*（微笑）你好。继续。', cleanReply), '你好。');
  assert.equal(firstStableSentence('先看 3.14 再说。继续。', cleanReply), '先看 3.14 再说。');

  const f = fixture();
  for (const delta of ['<thi', 'nk>隐藏。不可读。', '</th', 'ink>爱弥', '斯：', '（微', '笑）你', '好', '！', '？']) f.prefetch.push(delta);
  await tick();
  assert.equal(f.calls.length, 0, 'split thoughts, annotations and terminal punctuation do not trigger early');
  f.prefetch.push('接着');
  await tick();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].text, '你好！？');
  f.prefetch.push('说。');
  const finalReply = '你好！？接着说。';
  const plan = await f.prefetch.take(finalReply);
  assert.equal(plan.head + plan.remainder, finalReply, 'complete final text stays intact');
  const heard = [];
  const tails = [];
  await streamSpeechSegments({ ...plan, sampleRate: 48000, onChunk: bytes => heard.push(bytes),
    synthesize: async text => { tails.push(text); return pcm(3, 4); },
  });
  assert.deepEqual(tails, ['接着说。']);
  assert.deepEqual(Array.from(heard[0]), [1, 2]);
  assert.equal(heard[1].byteLength, Math.round(48000 * .34) * 2, 'retain the existing sentence pause');
  assert.deepEqual(Array.from(heard[2]), [3, 4]);
  assert.equal(plan.response.body.locked, false);
  f.prefetch.dispose();

  let rejectedCancelled = 0;
  const mismatch = fixture({ synthesize: async () => new Response(new ReadableStream({ cancel() { rejectedCancelled++; } })) });
  mismatch.prefetch.push('你好。后面。');
  await tick();
  assert.equal(await mismatch.prefetch.take('更正后的完整台词。'), null);
  await tick();
  assert.equal(rejectedCancelled, 1, 'final cleaning/prefix mismatch cancels unplayed synthesis');
  assert.equal(mismatch.calls[0].options.signal.aborted, true);

  const unavailable = fixture({ voiceHealth: async () => ({ ready: false, streaming: false }) });
  unavailable.prefetch.push('你好。后面。');
  assert.equal(await unavailable.prefetch.take('你好。后面。'), null);
  assert.equal(unavailable.calls.length, 0);
  const failed = fixture({ synthesize: async () => { throw new Error('fixture unavailable'); } });
  failed.prefetch.push('你好。后面。');
  assert.equal(await failed.prefetch.take('你好。后面。'), null, 'failed prefetch leaves whole-reply fallback available');

  let finishFetch;
  let lateCancelled = 0;
  const pending = fixture({ synthesize: () => new Promise(resolve => { finishFetch = resolve; }) });
  pending.prefetch.push('你好。后面。');
  await tick();
  pending.abort.abort();
  pending.prefetch.dispose();
  finishFetch(new Response(new ReadableStream({ cancel() { lateCancelled++; } })));
  await tick();
  assert.equal(lateCancelled, 1, 'even an uncooperative delayed fetch has its unread response cancelled');

  const off = fixture({ enabled: false, voiceHealth: () => { throw new Error('must never probe API mode'); } });
  off.prefetch.push('你好。后面。');
  assert.equal(await off.prefetch.take('你好。后面。'), null);
  assert.equal(off.calls.length, 0);
  const channel = createConversationChannel({ localChat: () => { throw new Error('must not call local LLM'); }, cleanReply,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: 'API 完整第一句。第二句也保留。' } }] }),
  });
  channel.configure({ consent: true, baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture' });
  channel.setMode('api');
  const api = fixture({ enabled: channel.status().mode === 'local' });
  const apiReply = await channel.chat({ system: 'fixture', text: 'fixture', localMessages: [], onDelta: delta => api.prefetch.push(delta) });
  assert.equal(apiReply, 'API 完整第一句。第二句也保留。');
  assert.equal(await api.prefetch.take(apiReply), null);
  assert.equal(api.calls.length, 0, 'API output cannot start local prefetch');
  assert.equal(channel.status().api.historyMessages, 2, 'full dialogue context remains a complete turn');

  let cancelled = 0;
  const stalled = new Response(new ReadableStream({ cancel() { cancelled++; } }));
  const stop = new AbortController();
  const read = pipePcmResponse(stalled, { signal: stop.signal, sampleRate: 48000, onChunk: () => {} });
  stop.abort();
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.equal(stalled.body.locked, false, 'abort cancels the pending read and releases its reader');

  let sent = 0, suffixAttempts = 0;
  await assert.rejects(streamSpeechSegments({ response: pcm(1, 2), remainder: '后半句。', signal: new AbortController().signal,
    sampleRate: 48000, onChunk: () => { sent++; }, synthesize: async () => { suffixAttempts++; throw new Error('tail unavailable'); },
  }), error => error.audioStarted === true);
  assert.equal(sent, 2, 'first audio plus pause only; never replay first sentence after failure');
  assert.equal(suffixAttempts, 1);
  await assert.rejects(streamSpeechSegments({ response: new Response(null), signal: new AbortController().signal,
    sampleRate: 48000, onChunk: () => { throw new Error('must not write'); },
  }), error => error.audioStarted === false, 'failure before audio remains distinguishable for normal fallback');
  await assert.rejects(streamSpeechSegments({ response: pcm(), signal: new AbortController().signal,
    sampleRate: 48000, onChunk: () => { throw new Error('must not write'); },
  }), error => error.audioStarted === false, 'an empty successful response must not silently truncate the reply');
  await assert.rejects(streamSpeechSegments({ response: pcm(1), signal: new AbortController().signal,
    sampleRate: 48000, onChunk: () => {},
  }), error => error.audioStarted === true, 'incomplete PCM cannot contaminate the next sentence');

  console.log('Speech prefetch passed: local-only, stable punctuation/quotes, split thoughts/annotations, final-prefix validation, complete context, ordered PCM, cancellation/reader cleanup and no duplicate audio after failure. Fixtures only.');
})().catch(error => { console.error(error); process.exitCode = 1; });

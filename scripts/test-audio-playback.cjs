const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the production classic-script audio functions without booting its
// WebSocket, microphone, avatar, DOM, or calling any speech service.
const source = fs.readFileSync(path.join(__dirname, '../wallpaper/wallpaper.js'), 'utf8');
const names = ['createSpeechPlayback', 'releaseSpeechPlayback', 'scheduleSpeechBuffer',
  'flushPcmPlayback', 'queuePcmPlayback', 'startPcmStream', 'enqueuePcmChunk',
  'finishPcmStream', 'stopAssistantAudio', 'sampleSpeechPlayback', 'playWav'];
const functions = names.map(name => {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, `production function ${name} exists`);
  const tail = source.slice(start + 1);
  const next = tail.search(/^  (?:async )?function /m);
  assert.ok(next >= 0);
  return source.slice(start, start + 1 + next);
}).join('\n');

function harness() {
  let now = 0, timerId = 0, completed = 0;
  const timers = new Map();
  const nodes = [];
  const analyser = {
    fftSize: 2048, frequencyBinCount: 1024,
    connect() {}, disconnect() {},
    getFloatTimeDomainData(array) { array.forEach((_, i) => { array[i] = i % 2 ? .08 : -.08; }); },
    getFloatFrequencyData(array) { array.fill(-60); },
  };
  const context = {
    get currentTime() { return now; }, state: 'running', sampleRate: 48000,
    createAnalyser: () => ({ ...analyser }),
    resume: () => Promise.resolve(),
    createBuffer(channels, length, sampleRate) {
      assert.equal(channels, 1);
      return { duration: length / sampleRate, samples: null,
        copyToChannel(samples) { this.samples = [...samples]; } };
    },
    createBufferSource() {
      const node = { connect() {}, disconnect() {}, stop() { this.stopped = true; },
        addEventListener(event, callback) { assert.equal(event, 'ended'); this.onended = callback; },
        start(startAt) { this.startAt = startAt; this.endAt = startAt + this.buffer.duration; } };
      nodes.push(node);
      return node;
    },
  };
  const sandbox = vm.createContext({
    context,
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, at: now + delay / 1000 }); return id; },
    clearTimeout(id) { timers.delete(id); },
    completeAssistantAudio() { completed++; },
    setConversationState() {}, resetAvatarPcm() {}, flushAvatarPcm() {}, queueAvatarPcm() {},
    playbackFailed(error) { throw error; },
  });
  vm.runInContext(`
    let streamedAudio, fallbackAudio, incomingAudioKind = '', assistantSpeaking = false;
    let avatarAudioEpoch = 0, avatarAudioAbort, avatarAudioQueue;
    let speechFeatures = { speaking: false, energy: 0 };
    const scene = { dataset: {} };
    function getSpeechContext() { return context; }
    function publishSpeechFeatures(features) { speechFeatures = features || { speaking: false, energy: 0 }; }
    ${functions}
    globalThis.api = {
      start: startPcmStream, end: finishPcmStream, stop: stopAssistantAudio,
      bytes: enqueuePcmChunk, sample: sampleSpeechPlayback, wav: playWav,
      queue(seconds) { queuePcmPlayback(streamedAudio, { duration: seconds }); },
      current() { return streamedAudio || fallbackAudio; },
      features() { return speechFeatures; },
    };
  `, sandbox);
  function advance(seconds) {
    const target = now + seconds;
    for (let count = 0; count < 1000; count++) {
      const nextTimer = [...timers.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      const nextNode = nodes.filter(n => !n.finished && !n.stopped && n.endAt <= target).sort((a, b) => a.endAt - b.endAt)[0];
      if (!nextTimer && !nextNode) break;
      if (nextTimer && (!nextNode || nextTimer[1].at < nextNode.endAt)) {
        now = nextTimer[1].at;
        timers.delete(nextTimer[0]);
        nextTimer[1].callback();
      } else {
        now = nextNode.endAt;
        nextNode.finished = true;
        nextNode.onended();
      }
    }
    now = target;
  }
  return { api: sandbox.api, nodes, timers, context, advance, completed: () => completed };
}

// A completed short reply bypasses prefill, remains closed-mouthed until its
// audio starts, and completes only after the final sample has played.
{
  const h = harness();
  h.api.start(24000);
  h.api.queue(.06);
  assert.equal(h.nodes.length, 0);
  h.api.sample();
  assert.equal(h.api.features().speaking, false);
  h.api.end();
  assert.equal(h.nodes.length, 1);
  assert.equal(h.completed(), 0);
  h.advance(.03);
  h.api.sample();
  assert.equal(h.api.features().speaking, true);
  h.context.state = 'suspended';
  h.api.sample();
  assert.equal(h.api.features().speaking, false, 'suspended output never drives the mouth');
  h.context.state = 'running';
  h.advance(.07);
  h.api.sample();
  assert.equal(h.api.features().speaking, false);
  assert.equal(h.completed(), 1);
  assert.equal(h.timers.size, 0);
}

// Enough PCM starts immediately with a small scheduling guard; subsequent
// batches retain contiguous audio-clock timing and introduce no extra pauses.
{
  const h = harness();
  h.api.start(48000);
  for (let i = 0; i < 3; i++) h.api.queue(.1);
  assert.equal(h.nodes.length, 3);
  assert.equal(h.nodes[0].startAt, .025);
  h.advance(.05);
  h.api.queue(.2);
  h.api.end();
  for (let i = 1; i < h.nodes.length; i++) assert.equal(h.nodes[i].startAt, h.nodes[i - 1].endAt);
  h.advance(.5);
  assert.equal(h.completed(), 1);
}

// A lone tiny packet has a bounded startup wait, even if no end event arrives.
{
  const h = harness();
  h.api.start();
  h.api.queue(.05);
  h.advance(.44);
  assert.equal(h.nodes.length, 0);
  h.advance(.02);
  assert.equal(h.nodes.length, 1);
  assert.ok(h.nodes[0].startAt <= .476);
  h.api.end();
  h.advance(.1);
  assert.equal(h.completed(), 1);
}

// Arrival slower than playback depletes the queue. Rebuffering coalesces the
// fragments, grows within a cap, and keeps actual playback/mouth state honest.
{
  const h = harness();
  h.api.start();
  h.api.queue(.3);
  h.advance(.5);
  h.api.queue(.1);
  assert.equal(h.api.current().underruns, 1);
  assert.equal(h.api.current().bufferTarget, .45);
  h.api.sample();
  assert.equal(h.api.features().speaking, false);
  assert.equal(h.nodes.length, 1);
  h.advance(.3);
  h.api.queue(.1);
  h.advance(.31);
  assert.equal(h.nodes.length, 3, 'recovery deadline drains both fragments together');
  assert.equal(h.nodes[2].startAt, h.nodes[1].endAt);
  for (let i = 0; i < 4; i++) { h.advance(2); h.api.queue(.05); }
  assert.ok(h.api.current().bufferTarget <= .9);
  h.api.end();
  h.advance(2);
  assert.equal(h.completed(), 1);
}

// PCM samples and odd-byte chunk boundaries are preserved exactly.
{
  const h = harness();
  h.api.start(24000);
  h.api.bytes(Uint8Array.from([0, 64, 0]).buffer);
  h.api.bytes(Uint8Array.from([192, 255, 127, 0, 128]).buffer);
  h.api.end();
  assert.deepEqual(h.nodes.flatMap(node => node.buffer.samples), [.5, -.5, 32767 / 32768, -1]);
  assert.equal(h.nodes.reduce((sum, node) => sum + node.buffer.duration, 0), 4 / 24000);
}

// Stop/replacement clears pending deadlines, ignores old queue callbacks and
// prevents old source-ended callbacks from finishing the replacement turn.
{
  const h = harness();
  h.api.start();
  h.api.queue(.05);
  const abandoned = h.api.current();
  const lateTimer = [...h.timers.values()][0].callback;
  h.api.stop();
  h.api.start();
  const replacement = h.api.current();
  lateTimer();
  assert.equal(h.nodes.length, 0);
  assert.equal(abandoned.released, true);
  h.api.queue(.3);
  h.api.end();
  const oldNode = h.nodes[0];
  h.api.start();
  h.api.queue(.06);
  oldNode.onended();
  assert.notEqual(h.api.current(), replacement);
  assert.equal(h.completed(), 0);
  h.api.end();
  h.api.bytes(new ArrayBuffer(100));
  assert.equal(h.nodes.length, 2, 'late PCM after end cannot extend a completed turn');
  h.advance(1);
  assert.equal(h.completed(), 1);
}

async function checkWavPreview() {
  const h = harness();
  h.context.decodeAudioData = async () => ({ duration: .12 });
  await h.api.wav(new ArrayBuffer(44), true);
  assert.equal(h.api.current().preview, true);
  assert.equal(h.nodes[0].startAt, .025, 'WAV preview uses its original immediate scheduling');
  h.api.stop();
  h.advance(1);
  assert.equal(h.nodes[0].stopped, true);
  assert.equal(h.completed(), 0);

  const delayed = harness();
  let resolveDecode;
  delayed.context.decodeAudioData = () => new Promise(resolve => { resolveDecode = resolve; });
  const oldPreview = delayed.api.wav(new ArrayBuffer(44), true);
  delayed.api.stop();
  delayed.api.start();
  const replacement = delayed.api.current();
  resolveDecode({ duration: .12 });
  await oldPreview;
  assert.equal(delayed.nodes.length, 0, 'cancelled asynchronous WAV decode must not restart playback');
  assert.equal(delayed.api.current(), replacement);
}
checkWavPreview().then(() => console.log('Audio playback: prefill, bounded rebuffering, exact PCM, final drain, cancellation, mouth timing and WAV preview passed.'));

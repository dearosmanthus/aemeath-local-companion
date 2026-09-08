'use strict';

const { visibleReply } = require('./local-services');

// Only a sentence with a following character has a stable ending: punctuation
// and closing quotes can arrive in their own LLM chunks. Final text is always
// authoritative; this merely starts local synthesis and never plays anything.
function firstStableSentence(value, cleanReply) {
  if (!value || value.length > 1600) return null;
  const withoutAnnotations = value.replace(/\([^()]*\)|（[^（）]*）|\*[^*]*\*/g, '');
  if (/[()（）*<>]/.test(withoutAnnotations)) return null;
  const cleaned = cleanReply(withoutAnnotations);
  const match = /^([\s\S]*?[。！？!?]+[”’「」『』"]?)(?=[^。！？!?…”’「」『』"])/u.exec(cleaned);
  if (!match || match[1].length < 3 || match[1].length > 100) return null;
  return match[1];
}

function createSpeechPrefetch({ enabled, signal, cleanReply, voiceHealth, synthesize }) {
  const controller = new AbortController();
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let visible = '';
  let head = '';
  let pending = null;
  let response = null;
  let disposed = false;
  const filter = visibleReply(value => { visible += value; });
  const cancelBody = async () => {
    if (response?.body && !response.body.locked) {
      try { await response.body.cancel(); } catch {}
    }
  };
  return {
    push(delta) {
      if (!enabled || disposed || pending || requestSignal.aborted) return;
      filter.push(delta);
      head = firstStableSentence(visible, cleanReply) || '';
      if (!head) return;
      pending = (async () => {
        const health = await voiceHealth();
        requestSignal.throwIfAborted();
        if (!health.ready || !health.streaming) return null;
        response = await synthesize(head, { stream: true, signal: requestSignal });
        if (disposed || requestSignal.aborted) { await cancelBody(); return null; }
        if (!response.body) return null;
        return { response, health, head, signal: requestSignal };
      })().catch(async () => { await cancelBody(); return null; });
    },
    async take(finalText) {
      if (disposed || !pending || !String(finalText).startsWith(head)) {
        this.dispose();
        return null;
      }
      const result = await pending;
      if (!result || disposed || requestSignal.aborted) { this.dispose(); return null; }
      return { ...result, remainder: finalText.slice(head.length).trimStart() };
    },
    dispose() {
      disposed = true;
      controller.abort();
      void cancelBody();
    },
  };
}

// A read is cancelled even when an injected/custom stream ignores fetch's
// signal. Every reader is released. No retry here can replay already-sent PCM.
async function pipePcmResponse(response, { signal, sampleRate, onChunk }) {
  const rate = Number(response.headers.get('x-sample-rate')) || sampleRate;
  if (rate !== sampleRate || !response.body) {
    try { await response.body?.cancel(); } catch {}
    throw new Error('本地语音流的采样率或内容不一致。');
  }
  const reader = response.body.getReader();
  let receivedBytes = 0;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        if (!receivedBytes) throw new Error('本地语音流没有返回音频。');
        if (receivedBytes % 2) throw new Error('本地语音流的音频数据不完整。');
        return;
      }
      if (value?.byteLength) { onChunk(value); receivedBytes += value.byteLength; }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

async function streamSpeechSegments({ response, remainder = '', synthesize, signal, sampleRate, onChunk }) {
  let audioStarted = false;
  const write = chunk => { onChunk(chunk); audioStarted = true; };
  try {
    await pipePcmResponse(response, { signal, sampleRate, onChunk: write });
    if (remainder) {
      signal.throwIfAborted();
      // Match VoxCPM's existing full-stop pause when a full reply is split.
      write(new Uint8Array(Math.round(sampleRate * .34) * 2));
      const tail = await synthesize(remainder, { stream: true, signal });
      await pipePcmResponse(tail, { signal, sampleRate, onChunk: write });
    }
  } catch (cause) {
    const error = new Error(cause.message, { cause });
    error.name = cause.name;
    error.audioStarted = audioStarted;
    throw error;
  }
}

module.exports = { firstStableSentence, createSpeechPrefetch, pipePcmResponse, streamSpeechSegments };

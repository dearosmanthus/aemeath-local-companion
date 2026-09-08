'use strict';

const { validateLocalConfig, createCompanionFetch } = require('./companion-network');
const DONE = Symbol('stream done');

function parseFrame(frame) {
  const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).replace(/^ /, '')).join('\n');
  if (!data) return null;
  if (data.trim() === '[DONE]') return DONE;
  try { return JSON.parse(data); }
  catch { throw new Error('本地模型返回了无效的流式数据。'); }
}

async function* readChatStream(body, signal) {
  if (!body?.getReader) throw new Error('本地模型未返回回复流。');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        signal.throwIfAborted();
        const frame = parseFrame(buffer.slice(0, boundary.index));
        buffer = buffer.slice(boundary.index + boundary[0].length);
        if (frame === DONE) return;
        if (frame) yield frame;
      }
      if (buffer.length > 1024 * 1024) throw new Error('本地模型回复帧过大。');
      if (done) {
        const frame = parseFrame(buffer);
        if (frame && frame !== DONE) yield frame;
        return;
      }
    }
  } finally {
    // Cancel on [DONE], abort, parse error or consumer failure; always free reader.
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function visibleReply(onDelta) {
  let pending = '';
  let thinking = false;
  let text = '';
  const emit = value => {
    if (!value) return;
    text += value;
    onDelta?.(value);
  };
  return {
    push(value) {
      pending += value;
      while (pending) {
        const marker = thinking ? '</think>' : '<think>';
        const index = pending.indexOf(marker);
        if (index >= 0) {
          if (!thinking) emit(pending.slice(0, index));
          pending = pending.slice(index + marker.length);
          thinking = !thinking;
          continue;
        }
        // Tags and Chinese characters may be split across different SSE chunks.
        let keep = Math.min(marker.length - 1, pending.length);
        while (keep > 0 && !marker.startsWith(pending.slice(-keep))) keep--;
        if (!thinking) emit(pending.slice(0, pending.length - keep));
        pending = keep ? pending.slice(-keep) : '';
        break;
      }
    },
    finish() {
      if (!thinking) emit(pending);
      pending = '';
      if (!text.trim()) throw new Error('本地模型没有返回可用台词，请再试一次。');
      return text;
    },
  };
}

function createLocalServices(config, { fetchImpl = globalThis.fetch } = {}) {
  const policy = validateLocalConfig(config);
  const request = createCompanionFetch(fetchImpl, { allowedOrigins: policy.origins });
  // Snapshot non-secret settings once. This module knows neither user history
  // nor files/environment variables, and has no provider selection or fallback.
  const modelBase = config.llm.baseUrl.replace(/\/+$/, '');
  const voiceBase = config.speech?.naturalTtsUrl?.replace(/\/+$/, '') || '';
  const model = config.llm.model;
  const generation = { temperature: config.llm.temperature, top_p: config.llm.topP, max_tokens: config.llm.maxTokens };
  const timeout = (signal, ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
  const jsonPost = async (url, payload, signal, label) => {
    signal.throwIfAborted();
    const response = await request(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload), signal,
    });
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw new Error(`${label}返回 ${response.status}`);
    }
    return response;
  };

  return Object.freeze({
    policy,
    hasVoice: Boolean(voiceBase),

    async chat(messages, { signal, onDelta } = {}) {
      const requestSignal = timeout(signal, 120000);
      const response = await jsonPost(`${modelBase}/chat/completions`, {
        model, messages, ...generation, stream: true,
      }, requestSignal, '本地模型接口');
      const reply = visibleReply(onDelta);
      for await (const frame of readChatStream(response.body, requestSignal)) {
        requestSignal.throwIfAborted();
        if (frame.error) throw new Error('本地模型报告生成失败。');
        const token = frame.choices?.[0]?.delta?.content;
        if (typeof token === 'string') reply.push(token);
      }
      requestSignal.throwIfAborted();
      return reply.finish();
    },

    async modelHealth() {
      try {
        const response = await request(`${modelBase}/models`, { signal: timeout(null, 2500) });
        if (!response.ok) {
          try { await response.body?.cancel(); } catch {}
          return { ready: false, provider: 'local', status: response.status };
        }
        const payload = await response.json();
        const models = Array.isArray(payload.data) ? payload.data.map(item => item.id) : [];
        return { ready: models.includes(model), provider: 'local', status: response.status, models, expected: model };
      } catch (error) { return { ready: false, provider: 'local', error: error.message }; }
    },

    async warm(messages) {
      const response = await jsonPost(`${modelBase}/chat/completions`, {
        model, messages, temperature: .2, max_tokens: 2, stream: false,
      }, timeout(null, 120000), '本地模型预热接口');
      await response.arrayBuffer();
    },

    async voiceHealth() {
      if (!voiceBase) return { ready: false, configured: false };
      try {
        const response = await request(`${voiceBase}/health`, { signal: timeout(null, 1800) });
        const payload = await response.json();
        return { ...payload, configured: true, ready: response.ok && Boolean(payload.ready) };
      } catch (error) { return { ready: false, configured: true, error: error.message }; }
    },

    async synthesize(text, { stream = false, signal } = {}) {
      if (!voiceBase) throw new Error('未配置本地自然语音服务。');
      return jsonPost(`${voiceBase}/${stream ? 'tts-stream' : 'tts'}`, stream ? { text } : { text, language: 'Chinese' },
        timeout(signal, 120000), '本地自然语音接口');
    },
  });
}

// The parser is shared with the explicitly configured API channel. It performs
// no I/O itself; the local client above retains its loopback-only transport.
module.exports = { createLocalServices, readChatStream, visibleReply };

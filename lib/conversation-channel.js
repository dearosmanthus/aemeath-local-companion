'use strict';

const { readChatStream, visibleReply } = require('./local-services');
const RUNTIME_POLICY = 'selectable-chat-v1';

function validateApiSettings(input) {
  if (input?.consent !== true) throw new Error('请先确认发送内容与目标服务，再保存 API 配置。');
  let url;
  try {
    if (typeof input.baseUrl !== 'string' || input.baseUrl.length > 2048) throw new Error();
    url = new URL(input.baseUrl.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    if (!url.hostname.includes('.') || url.hostname.endsWith('.localhost') || url.hostname === 'localhost'
      || /^\[|^\d+(?:\.\d+){3}$/.test(url.hostname)) throw new Error();
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (/\/(?:chat\/completions|responses)$/i.test(url.pathname)) throw new Error();
  } catch { throw new Error('Base URL 应为服务商的 HTTPS 接口根地址（通常以 /v1 结尾），不含凭据、查询参数或具体接口名。'); }
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 160 || /[\r\n\x00-\x1f]/.test(input.model)) throw new Error('请填写有效模型名称。');
  if (typeof input.apiKey !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(input.apiKey.trim())) throw new Error('请填写专用于此伴侣的有效 API Key。');
  return Object.freeze({ baseUrl: url.href.replace(/\/+$/, ''), model: input.model.trim(), key: input.apiKey.trim() });
}

function createConversationChannel({ localChat, cleanReply = value => value, fetchImpl = globalThis.fetch }) {
  // Session memory only: no environment variables, credential stores or disk I/O.
  let mode = 'local';
  let settings = null;
  let apiHistory = [];
  let revision = 0;
  const active = new Set();
  function cancel() { for (const controller of active) controller.abort(); revision++; }
  const status = () => ({ mode, revision, busy: active.size > 0,
    api: { configured: Boolean(settings), baseUrl: settings?.baseUrl || '', model: settings?.model || '',
      hasKey: Boolean(settings), historyMessages: apiHistory.length } });

  return Object.freeze({
    status,
    configure(input) {
      const next = validateApiSettings(input);
      cancel(); settings = next; apiHistory = []; mode = 'local';
      return status();
    },
    setMode(next) {
      if (!['local', 'api'].includes(next)) throw new Error('未知对话通道。');
      if (next === 'api' && !settings) throw new Error('请先填写并确认本次 API 配置。');
      if (next !== mode) { cancel(); mode = next; apiHistory = []; }
      return status();
    },
    forget() { cancel(); mode = 'local'; settings = null; apiHistory = []; return status(); },
    clearContext() { cancel(); apiHistory = []; return status(); },

    async chat({ system, text, localMessages, signal, onDelta }) {
      const controller = new AbortController();
      const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
      const startedRevision = revision;
      const selectedMode = mode;
      const target = settings;
      active.add(controller);
      try {
        requestSignal.throwIfAborted();
        if (selectedMode === 'local') {
          const result = await localChat(localMessages, { signal: requestSignal, onDelta });
          requestSignal.throwIfAborted();
          return cleanReply(result);
        }
        if (!target) throw new Error('API 未配置。');
        // Deliberately ignore localMessages here: old local conversations never
        // become an API request, even immediately after switching channels.
        const messages = [{ role: 'system', content: String(system) },
          ...apiHistory.map(item => ({ ...item })), { role: 'user', content: String(text) }];
        const response = await fetchImpl(target.baseUrl + '/chat/completions', {
          method: 'POST', redirect: 'error', credentials: 'omit',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${target.key}` },
          body: JSON.stringify({ model: target.model, messages, stream: true }), signal: requestSignal,
        });
        if (response.redirected) { try { await response.body?.cancel(); } catch {} throw new Error('API 不允许重定向。'); }
        if (!response.ok) {
          try { await response.body?.cancel(); } catch {}
          const error = new Error(`API 请求失败（HTTP ${response.status}），未切换到其他通道。`);
          error.safeChannelError = true;
          throw error;
        }
        const output = visibleReply(onDelta);
        if (response.headers.get('content-type')?.includes('application/json')) {
          const payload = await response.json();
          const value = payload.choices?.[0]?.message?.content;
          if (typeof value !== 'string') throw new Error('Unsupported completion payload');
          requestSignal.throwIfAborted();
          output.push(value);
        } else {
          for await (const frame of readChatStream(response.body, requestSignal)) {
            requestSignal.throwIfAborted();
            if (frame.error) throw new Error('Upstream generation failed');
            const value = frame.choices?.[0]?.delta?.content;
            if (typeof value === 'string') output.push(value);
          }
        }
        requestSignal.throwIfAborted();
        const reply = cleanReply(output.finish());
        if (revision !== startedRevision) throw new DOMException('Channel changed', 'AbortError');
        apiHistory.push({ role: 'user', content: String(text) }, { role: 'assistant', content: reply });
        apiHistory = apiHistory.slice(-6);
        return reply;
      } catch (error) {
        if (requestSignal.aborted) throw requestSignal.reason;
        if (selectedMode === 'local' || error.safeChannelError) throw error;
        // Never echo upstream error bodies, addresses or fetch exceptions which
        // could include the key. No retries, health probes or provider fallback.
        throw new Error('API 请求未完成，请检查地址、模型与专用 Key；未自动切换通道。');
      } finally { active.delete(controller); }
    },
  });
}

module.exports = { RUNTIME_POLICY, createConversationChannel, validateApiSettings };

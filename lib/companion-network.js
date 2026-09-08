'use strict';

const LOCAL_SECURITY_POLICY = 'loopback-only-v2';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key', 'api-key']);

function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) throw new Error('non-local URL');
  // Resolve this alias without DNS/hosts-file lookup. Never pass a mutable URL
  // supplied by a caller through to the network implementation.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function isLoopbackHttp(value) {
  try { localUrl(value); return true; } catch { return false; }
}

function validateLocalConfig(config) {
  if (config?.llm?.mode !== 'local') throw new Error('伴侣仅支持本地模式：llm.mode 必须为 local。');
  if (!['127.0.0.1', '::1', 'localhost'].includes(config?.app?.host)) throw new Error('app.host 必须是本机回环地址。');
  if (!Number.isInteger(config.app.port) || config.app.port < 1 || config.app.port > 65535) throw new Error('app.port 无效。');
  if (Object.keys(config.llm).some(key => /^(cloud|api.?key|bearer|token)/i.test(key))) throw new Error('请移除 llm 中的旧云端或凭据字段；本地伴侣不会使用这些字段。');
  const origins = [];
  for (const [field, value, required] of [
    ['llm.baseUrl', config.llm.baseUrl, true],
    ['speech.naturalTtsUrl', config.speech?.naturalTtsUrl, false],
  ]) {
    if (!required && (value === undefined || value === '')) continue;
    try {
      const url = localUrl(value);
      if (url.search || url.hash) throw new Error('unexpected URL metadata');
      origins.push(url.origin);
    } catch {
      // Never echo a rejected URL: it might accidentally contain a credential.
      throw new Error(`${field} 必须是不含凭据、查询参数或片段的本机 HTTP 地址。`);
    }
  }
  return Object.freeze({
    host: config.app.host === 'localhost' ? '127.0.0.1' : config.app.host,
    port: config.app.port,
    origins: Object.freeze([...new Set(origins)]),
  });
}

function clearInheritedCompanionCredentials(env = process.env) {
  // Delete names only, without inspecting their values or other apps' stores.
  // This also covers `npm start` / `node server.js`, not only the PS wrapper.
  for (const name of ['CYBER_GIRLFRIEND_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'OPENAI_AUTH_TOKEN']) delete env[name];
}

function createCompanionFetch(fetchImpl = globalThis.fetch, { allowedOrigins } = {}) {
  const origins = allowedOrigins && new Set(allowedOrigins.map(value => localUrl(value).origin));
  return async function companionFetch(url, options = {}) {
    let target;
    try { target = localUrl(url); } catch { throw new Error('本地模式已阻止非本机接口请求；不会自动转到云端。'); }
    if (origins && !origins.has(target.origin)) throw new Error('本地模式已阻止未配置的接口地址。');
    const headers = new Headers(options.headers);
    for (const name of CREDENTIAL_HEADERS) {
      if (headers.has(name)) throw new Error('本地伴侣禁止发送认证凭据或 Cookie。');
    }
    // A loopback server must not redirect a conversation to an external host.
    return fetchImpl(target.href, { ...options, headers, credentials: 'omit', redirect: 'error' });
  };
}

function isAllowedLocalRequest(req, port, { websocket = false } = {}) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return false;
  const authorities = new Set([...LOOPBACK_HOSTS].map(host => `${host}${port === 80 ? '' : ':' + port}`));
  if (!authorities.has(String(req.headers.host || '').toLowerCase())) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return !websocket;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === 'http:' && authorities.has(url.host);
  } catch { return false; }
}

module.exports = { LOCAL_SECURITY_POLICY, isLoopbackHttp, validateLocalConfig, clearInheritedCompanionCredentials, createCompanionFetch, isAllowedLocalRequest };

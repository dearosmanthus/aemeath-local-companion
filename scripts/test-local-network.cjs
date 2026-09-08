'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { LOCAL_SECURITY_POLICY, createCompanionFetch, isLoopbackHttp, validateLocalConfig, clearInheritedCompanionCredentials, isAllowedLocalRequest } = require('../lib/companion-network');

(async () => {
  const calls = [];
  const fakeFetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  const localFetch = createCompanionFetch(fakeFetch);
  for (const url of ['http://127.0.0.1:1235/v1/models', 'http://localhost:17861/health', 'http://[::1]:1235/v1/models']) {
    assert.equal(isLoopbackHttp(url), true);
    await localFetch(url, { redirect: 'follow' });
    assert.equal(calls.at(-1).options.redirect, 'error');
    assert.equal(calls.at(-1).options.credentials, 'omit');
  }
  assert.equal(calls[1].url, 'http://127.0.0.1:17861/health', 'localhost must not use DNS');
  const localCallCount = calls.length;
  for (const url of ['https://example.invalid/v1/responses', 'http://192.168.1.2/models', 'http://localhost.example.invalid/', 'http://localhost@example.invalid/', 'http://user:pass@127.0.0.1/', 'file:///tmp/test', 'not a url']) {
    await assert.rejects(localFetch(url), /本地模式已阻止/);
  }
  assert.equal(calls.length, localCallCount, 'rejected URLs must never reach the network implementation');
  // Dummy test values only. No real environment variables or credential stores.
  const dummyEnv = { CYBER_GIRLFRIEND_API_KEY: 'test-placeholder', OPENAI_API_KEY: 'test-placeholder', KEEP: 'unchanged' };
  clearInheritedCompanionCredentials(dummyEnv);
  assert.deepEqual(dummyEnv, { KEEP: 'unchanged' });
  for (const headers of [
    { Authorization: 'test-placeholder' }, [['COOKIE', 'test-placeholder']],
    new Headers({ 'X-Api-Key': 'test-placeholder' }), { 'proxy-authorization': 'test-placeholder' },
  ]) await assert.rejects(localFetch('http://127.0.0.1:1235/v1/models', { headers }), /禁止发送认证/);
  assert.equal(calls.length, localCallCount, 'credential headers must not reach even a loopback service');
  const sampleConfig = { app: { host: '127.0.0.1', port: 17860 }, llm: { mode: 'local', baseUrl: 'http://127.0.0.1:1235/v1' }, speech: { naturalTtsUrl: 'http://localhost:17861' } };
  const policy = validateLocalConfig(sampleConfig);
  assert.deepEqual(policy.origins, ['http://127.0.0.1:1235', 'http://127.0.0.1:17861']);
  const scopedFetch = createCompanionFetch(fakeFetch, { allowedOrigins: policy.origins });
  await assert.rejects(scopedFetch('http://127.0.0.1:9999/'), /未配置/);
  let failureCalls = 0;
  const unavailableLocal = createCompanionFetch(async () => { failureCalls++; throw new Error('local fixture unavailable'); }, { allowedOrigins: policy.origins });
  await assert.rejects(unavailableLocal('http://127.0.0.1:1235/v1/models'), /local fixture unavailable/);
  assert.equal(failureCalls, 1, 'a failed local call must not trigger any fallback request');
  const brokenConfigs = [
    { ...sampleConfig, llm: { ...sampleConfig.llm, mode: 'cloud-preferred' } },
    { ...sampleConfig, app: { ...sampleConfig.app, host: '0.0.0.0' } },
    { ...sampleConfig, app: { ...sampleConfig.app, port: 0 } },
    { ...sampleConfig, llm: { ...sampleConfig.llm, cloudBaseUrl: 'https://example.invalid' } },
    { ...sampleConfig, llm: { ...sampleConfig.llm, baseUrl: 'https://example.invalid' } },
    { ...sampleConfig, speech: { naturalTtsUrl: 'https://example.invalid' } },
    { ...sampleConfig, llm: { ...sampleConfig.llm, baseUrl: 'http://127.0.0.1:1235/v1?secret=test-placeholder' } },
    { ...sampleConfig, llm: { ...sampleConfig.llm, baseUrl: 'http://test-placeholder@127.0.0.1:1235/v1' } },
  ];
  for (const config of brokenConfigs) {
    assert.throws(() => validateLocalConfig(config));
    try { validateLocalConfig(config); } catch (error) {
      assert.equal(error.message.includes('test-placeholder'), false, 'errors must not echo rejected secret-looking URLs');
    }
  }
  const request = (headers = {}, address = '127.0.0.1') => ({ socket: { remoteAddress: address }, headers: { host: '127.0.0.1:17860', ...headers } });
  assert.ok(isAllowedLocalRequest(request(), 17860), 'local CLI runtime check works');
  for (const origin of ['http://127.0.0.1:17860', 'http://localhost:17860', 'http://[::1]:17860']) {
    assert.ok(isAllowedLocalRequest(request({ origin }), 17860, { websocket: true }));
  }
  for (const headers of [
    { origin: 'https://example.invalid' }, { origin: 'null' }, { origin: 'http://localhost:1234' },
    { host: 'example.invalid:17860' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(isAllowedLocalRequest(request(headers), 17860), false);
  assert.equal(isAllowedLocalRequest(request({}, '192.168.1.2'), 17860), false);
  assert.equal(isAllowedLocalRequest(request(), 17860, { websocket: true }), false, 'WebSocket must declare companion page origin');
  const serverSource = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
  const localSource = fs.readFileSync(path.join(__dirname, '../lib/local-services.js'), 'utf8');
  for (const source of [serverSource, localSource]) {
    assert.equal(/\bfetch\s*\(/.test(source), false, 'HTTP calls must use the local-only wrapper');
    assert.equal(/askCloudLlm|cloudApiKey|authorization\s*:/i.test(source), false, 'remote chat and credential-bearing requests must be removed');
  }
  assert.equal(/process\.env|readFile|require\(['"](?:node:)?(?:fs|http|https|net|tls|child_process)/.test(localSource), false, 'local service layer must not discover credentials/files or bypass the request guard');
  const launcher = fs.readFileSync(path.join(__dirname, '../Start-Companion-Server.ps1'), 'utf8');
  assert.equal(/experimental_bearer_token|config\.toml|GetEnvironmentVariable/i.test(launcher), false, 'startup must not discover credentials');
  assert.ok(serverSource.indexOf('createLocalServices(config)') >= 0 && serverSource.indexOf('createLocalServices(config)') < serverSource.indexOf('readJson(HISTORY_PATH'), 'validate endpoints before reading conversation history');
  assert.ok(localSource.indexOf('validateLocalConfig(config)') >= 0 && localSource.indexOf('validateLocalConfig(config)') < localSource.indexOf('createCompanionFetch(fetchImpl'), 'local service construction validates before creating transport');
  assert.ok(serverSource.includes('clearInheritedCompanionCredentials();'), 'direct Node startup also clears inherited credentials');
  assert.ok(serverSource.includes('verifyClient:'), 'WebSocket guard is applied before sending hello/history');
  assert.ok(serverSource.includes("url.pathname === '/api/runtime'"));
  assert.equal(LOCAL_SECURITY_POLICY, 'loopback-only-v2');
  const entrypoint = fs.readFileSync(path.join(__dirname, '../Start-Cyber-Girlfriend.bat'), 'utf8');
  assert.ok(entrypoint.includes('Start-Desktop-Companion-Services.ps1'));
  assert.equal(entrypoint.includes('--use-fake-ui-for-media-stream'), false, 'normal browser microphone permission is required');
  const services = fs.readFileSync(path.join(__dirname, '../Start-Desktop-Companion-Services.ps1'), 'utf8');
  assert.ok(services.includes('$companionAlreadyRunning -and -not (Test-CompanionRuntime)'));
  assert.ok(services.indexOf('scripts/check-local-config.cjs') < services.indexOf('Start-Process'), 'validate local config before launching services');
  const detached = fs.readFileSync(path.join(__dirname, '../launch-detached.vbs'), 'utf8');
  assert.ok(detached.includes('1>>data\\server.log 2>>data\\server-error.log'), 'restarts must not truncate the existing audit logs');
  // CI validates the checked-in template only. Private runtime settings are
  // checked explicitly by scripts/check-local-config.cjs before service start.
  for (const name of ['config.example.json']) {
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', name), 'utf8'));
    assert.equal(config.llm.mode, 'local');
    assert.equal(Object.keys(config.llm).some(key => /^cloud/i.test(key)), false, 'no retained third-party connection settings');
    validateLocalConfig(config);
  }
  console.log('Local-only v2 passed: config fail-closed, fixed loopback destinations, no credential headers, redirect denial, direct-start sanitization, and HTTP/WebSocket origin guards. No real HTTP requests made.');
})().catch(error => { console.error(error); process.exitCode = 1; });

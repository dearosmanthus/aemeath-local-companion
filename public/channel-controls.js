(() => {
  'use strict';
  const mount = document.createElement('aside');
  mount.className = 'dialogue-channel';
  mount.innerHTML = `
    <button type="button" class="channel-toggle" aria-expanded="false" aria-controls="channel-panel">对话 · 检查中</button>
    <section id="channel-panel" class="channel-panel" aria-labelledby="channel-title" hidden>
      <div class="channel-heading"><h2 id="channel-title">对话通道</h2><button type="button" class="channel-close" aria-label="关闭通道设置">×</button></div>
      <p class="channel-current" role="status">正在读取本机设置…</p>
      <div class="channel-actions"><button type="button" data-mode="local" disabled>使用本地 · 离线</button><button type="button" data-mode="api" disabled>使用 API</button></div>
      <p class="channel-note">只切换对话大脑，声音、识别和人物仍在本机。切换会取消当前生成和排队请求、暂停麦克风；请再点光核继续。API 会话重新开始，不带入旧本地聊天，不自动回退。</p>
      <form class="channel-form" autocomplete="off">
        <label>HTTPS Base URL<input name="baseUrl" type="url" required maxlength="2048" placeholder="服务商提供的接口根地址，通常以 /v1 结尾" autocomplete="off" spellcheck="false"></label>
        <label>模型名<input name="model" required maxlength="160" placeholder="填写服务商支持的模型名" autocomplete="off" spellcheck="false"></label>
        <label>专用 API Key<input name="apiKey" type="password" required maxlength="4096" autocomplete="off" spellcheck="false"></label>
        <p class="channel-destination">请求目标：尚未填写</p>
        <label class="channel-consent"><input name="consent" type="checkbox" required><span>我同意将角色设定（含称呼与时间）、当前文字或语音转写，以及本次 API 会话最近最多 6 条消息发送给上方服务，可能产生费用。不发送音频、人物资源或以前的本地聊天记录。</span></label>
        <button class="channel-save" type="submit" disabled>保存本次配置（不联网）</button>
      </form>
      <button class="channel-forget" type="button" disabled>清除本次 API 配置</button>
      <p class="channel-note">Key 只保存在后台本次运行的内存中，不写文件、不存浏览器；重启后清空并回到本地。关闭面板会清空尚未提交的 Key。保存配置后仍是本地，需再点“使用 API”。只有之后主动说话/发消息才会请求服务商；不会自动试连。</p>
      <p class="channel-feedback" role="status" aria-live="polite"></p>
    </section>`;
  document.body.append(mount);
  const get = selector => mount.querySelector(selector);
  const toggle = get('.channel-toggle');
  const panel = get('.channel-panel');
  const form = get('form');
  const base = form.elements.baseUrl;
  const model = form.elements.model;
  const key = form.elements.apiKey;
  const consent = form.elements.consent;
  const localButton = get('[data-mode="local"]');
  const apiButton = get('[data-mode="api"]');
  const save = get('.channel-save');
  const forget = get('.channel-forget');
  let snapshot = null;
  let pending = false;
  let reading = false;
  let epoch = 0;

  function targetUrl() {
    try {
      const url = new URL(base.value.trim());
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
        || !url.hostname.includes('.') || url.hostname.endsWith('.localhost') || /^\[|^\d+(?:\.\d+){3}$/.test(url.hostname)) return '';
      const path = url.pathname.replace(/\/+$/, '');
      if (/\/(chat\/completions|responses)$/i.test(path)) return '';
      return url.origin + path + '/chat/completions';
    } catch { return ''; }
  }
  function refreshForm() {
    const target = targetUrl();
    get('.channel-destination').textContent = target ? '请求目标：' + target : '请求目标：请填写 HTTPS 接口根地址，不含 Key、查询参数或 /chat/completions';
    save.disabled = pending || !snapshot || !target || !model.value.trim() || !key.value.trim() || !consent.checked;
  }
  function render(status) {
    snapshot = status;
    const api = status.mode === 'api';
    document.body.dataset.dialogueChannel = status.mode;
    toggle.textContent = api ? '对话 · API' : '对话 · 本地';
    toggle.title = api ? status.api.baseUrl : '本地模型 · 离线对话';
    get('.channel-current').textContent = api
      ? `当前：API · ${status.api.model}\n${status.api.baseUrl}（未自动试连）`
      : '当前：本地模型 · 离线对话';
    localButton.disabled = pending || !api;
    apiButton.disabled = pending || !status.api.configured || api;
    forget.disabled = pending || !status.api.configured;
    localButton.setAttribute('aria-pressed', String(!api));
    apiButton.setAttribute('aria-pressed', String(api));
    const privacy = document.getElementById('privacy-channel');
    if (privacy) privacy.textContent = api ? `API 对话 → ${status.api.baseUrl} · 本地识别与声音` : 'LOCAL · 本地对话、识别与声音';
    window.dispatchEvent(new CustomEvent('companion-channel', { detail: status }));
    refreshForm();
  }
  async function refresh() {
    if (reading || pending) return;
    reading = true;
    const startedEpoch = epoch;
    try {
      const response = await fetch('/api/channel', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error('对话通道未就绪；如果刚更新代码，请重新启动伴侣后台。');
      const status = await response.json();
      if (startedEpoch !== epoch) return;
      if (!status.api || !['local', 'api'].includes(status.mode)) throw new Error('后台版本不匹配，请更新并重启伴侣。');
      render(status);
    } catch (error) {
      if (startedEpoch !== epoch) return;
      snapshot = null;
      toggle.textContent = '对话 · 未连接';
      localButton.disabled = apiButton.disabled = save.disabled = forget.disabled = true;
      get('.channel-feedback').textContent = error.name === 'TimeoutError' ? '后台连接超时。' : error.message;
    } finally { reading = false; }
  }
  async function action(payload) {
    if (pending) return;
    epoch++;
    pending = true;
    if (snapshot) render(snapshot);
    get('.channel-feedback').textContent = '正在更新本机设置…';
    try {
      const response = await fetch('/api/channel', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), cache: 'no-store',
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '设置未完成。');
      render(result);
      get('.channel-feedback').textContent = payload.action === 'configure' ? '已保存到本次内存；尚未联网。需要时再切换 API。'
        : payload.action === 'forget' ? 'API 配置已清除，已回到本地。'
        : result.mode === 'api' ? '已切到 API。再点光核或发送文字，才会请求指定服务。' : '已切回本地，旧 API 会话已清空；可再点光核继续。';
    } catch (error) { get('.channel-feedback').textContent = error.name === 'TimeoutError' ? '设置响应超时，请刷新面板确认当前状态。' : error.message; }
    finally {
      if (payload.action === 'configure') payload.apiKey = '';
      pending = false;
      if (snapshot) render(snapshot);
    }
  }
  function close() {
    key.value = ''; consent.checked = false; panel.hidden = true;
    toggle.setAttribute('aria-expanded', 'false'); refreshForm(); toggle.focus();
  }
  toggle.addEventListener('click', async () => {
    if (!panel.hidden) { close(); return; }
    panel.hidden = false; toggle.setAttribute('aria-expanded', 'true');
    await refresh();
    if (snapshot?.api.configured && !base.value) { base.value = snapshot.api.baseUrl; model.value = snapshot.api.model; }
    refreshForm(); base.focus();
  });
  get('.channel-close').addEventListener('click', close);
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.stopPropagation(); close(); } });
  for (const input of [base, model, key]) input.addEventListener('input', () => { consent.checked = false; refreshForm(); });
  consent.addEventListener('change', refreshForm);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (save.disabled || !form.reportValidity()) return;
    const payload = { action: 'configure', baseUrl: base.value.trim(), model: model.value.trim(), apiKey: key.value.trim(), consent: consent.checked };
    key.value = ''; consent.checked = false;
    void action(payload);
  });
  localButton.addEventListener('click', () => void action({ action: 'mode', mode: 'local' }));
  apiButton.addEventListener('click', () => void action({ action: 'mode', mode: 'api' }));
  forget.addEventListener('click', () => { form.reset(); refreshForm(); void action({ action: 'forget' }); });
  window.addEventListener('companion-channel-status', event => {
    const status = event.detail;
    if (!status?.api || !['local', 'api'].includes(status.mode)) return;
    epoch++;
    render(status);
  });
  void refresh();
  setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 8000);
})();

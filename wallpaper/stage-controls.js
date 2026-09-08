(() => {
  'use strict';

  const toggle = document.getElementById('characterToggle');
  const panel = document.getElementById('characterPanel');
  if (!toggle || !panel) return;

  const close = document.getElementById('characterClose');
  const status = document.getElementById('characterStatus');
  const performanceStatus = document.getElementById('characterPerformance');
  const wave = document.getElementById('characterWave');
  const waveSlow = document.getElementById('characterWaveSlow');
  const demo = document.getElementById('characterDemo');
  const sample = document.getElementById('characterSample');
  const stop = document.getElementById('characterStop');
  const caption = document.getElementById('caption');
  const sampleCaption = '你回来啦。嗯……今天，想先聊些什么？';
  let previousCaption = null;
  const framingButtons = [...panel.querySelectorAll('[data-avatar-framing]')];
  const qualityButtons = [...panel.querySelectorAll('[data-avatar-quality]')];
  const appearanceButtons = [...panel.querySelectorAll('[data-avatar-appearance]')];
  const readyButtons = [...framingButtons, ...qualityButtons, ...appearanceButtons, wave, waveSlow, demo];
  let timers = [];
  let previewRunning = false;
  let wasReady = false;
  let previewEpoch = 0;
  let sampleAbort = null;
  let sampleBuffer = null;

  function say(text) {
    status.textContent = text;
  }

  function avatarReady() {
    const avatar = window.AemeathAvatar;
    return Boolean(avatar?.ready && typeof avatar.preview === 'function'
      && typeof avatar.stopPreview === 'function'
      && typeof avatar.setFraming === 'function'
      && typeof avatar.setQuality === 'function');
  }

  function syncButtons() {
    const ready = avatarReady();
    for (const button of readyButtons) button.disabled = !ready;
    sample.disabled = !ready || typeof window.AemeathAudioDiagnostics?.playPreviewWav !== 'function';
    if (!ready) return;
    const avatar = window.AemeathAvatar;
    for (const button of framingButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.avatarFraming === (avatar.framing || 'portrait')));
    }
    for (const button of qualityButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.avatarQuality === (avatar.quality || 'balanced')));
    }
    for (const button of appearanceButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.avatarAppearance === (avatar.appearance || 'soft')));
    }
    if (!wasReady) {
      wasReady = true;
      say('可以试试招手，或看看她对话时的动作。');
    }
  }

  function clearPreviewTimers() {
    for (const timer of timers) window.clearTimeout(timer);
    timers = [];
  }

  function endPreview(message, releaseAvatar = true) {
    clearPreviewTimers();
    previewEpoch += 1;
    sampleAbort?.abort();
    sampleAbort = null;
    // Restore only our own local sample subtitle, never a newer chat reply.
    if (previousCaption !== null && caption?.textContent === sampleCaption) caption.textContent = previousCaption;
    previousCaption = null;
    const wasRunning = previewRunning;
    previewRunning = false;
    stop.hidden = true;
    wave.setAttribute('aria-pressed', 'false');
    waveSlow.setAttribute('aria-pressed', 'false');
    demo.setAttribute('aria-pressed', 'false');
    sample.setAttribute('aria-pressed', 'false');
    if (releaseAvatar && wasRunning) {
      window.AemeathAudioDiagnostics?.stopPreview?.();
      window.AemeathAvatar?.stopPreview?.();
    }
    if (message && wasRunning) say(message);
  }

  function openPanel(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      syncButtons();
      close.focus();
    } else {
      endPreview('演示已停止。');
    }
  }

  function previewState(state, label) {
    if (!avatarReady()) {
      endPreview();
      say('角色还在准备中，请稍等片刻再试。');
      return false;
    }
    try {
      if (window.AemeathAvatar.preview(state) === false) {
        endPreview(undefined, false);
        say('她正在与你对话，稍后再预览动作吧。');
        return false;
      }
      say(label);
      return true;
    } catch (error) {
      console.warn('Character preview unavailable:', error);
      endPreview();
      say('这次动作没有准备好，可以稍后再试。');
      return false;
    }
  }

  function beginPreview() {
    endPreview();
    previewRunning = true;
    stop.hidden = false;
  }

  toggle.addEventListener('click', () => openPanel(panel.hidden));
  close.addEventListener('click', () => {
    openPanel(false);
    toggle.focus();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault();
    openPanel(false);
    toggle.focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) openPanel(false);
  });
  // Keyboard activation must release only our sample before a real call starts.
  const talkControl = document.getElementById('talkControl');
  talkControl?.addEventListener('click', () => endPreview('试听已结束。'), { capture: true });
  talkControl?.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') endPreview('试听已结束。');
  }, { capture: true });

  for (const button of framingButtons) {
    button.addEventListener('click', () => {
      if (!avatarReady()) return;
      window.AemeathAvatar.setFraming(button.dataset.avatarFraming);
      syncButtons();
      say(button.dataset.avatarFraming === 'portrait' ? '靠近一些，陪你说话。' : '现在可以看到她的全身动作。');
    });
  }
  for (const button of qualityButtons) {
    button.addEventListener('click', () => {
      if (!avatarReady()) return;
      window.AemeathAvatar.setQuality(button.dataset.avatarQuality);
      syncButtons();
      say(button.dataset.avatarQuality === 'high' ? '已切换清晰画质。' : '已切换省电画质。');
    });
  }

  wave.addEventListener('click', () => {
    beginPreview();
    if (!previewState('wave', '她在向你招手。')) return;
    wave.setAttribute('aria-pressed', 'true');
    timers.push(window.setTimeout(() => endPreview('招手结束，可以开始和她说话了。'), 4000));
  });
  waveSlow.addEventListener('click', () => {
    beginPreview();
    if (!previewState('wave-slow', '慢动作检查：抬手、展开手指、轻摆手腕、自然收手。')) return;
    waveSlow.setAttribute('aria-pressed', 'true');
    timers.push(window.setTimeout(() => endPreview('慢动作结束。可以比较放松手型与招手手型。'), 8000));
  });
  for (const button of appearanceButtons) {
    button.addEventListener('click', () => {
      if (!avatarReady() || !window.AemeathAvatar.setAppearance) return;
      window.AemeathAvatar.setAppearance(button.dataset.avatarAppearance);
      syncButtons();
      say(button.dataset.avatarAppearance === 'soft' ? '游戏质感：保留星瞳与发尾原色，细分衣料、发丝和金属的光影。' : '已切换基础材质与原始光照，可以比较人物质感。');
    });
  }
  demo.addEventListener('click', () => {
    beginPreview();
    if (!previewState('idle', '动作预览 · 1 / 4 · 安静陪伴')) return;
    demo.setAttribute('aria-pressed', 'true');
    const sequence = [
      [3000, 'listening', '动作预览 · 2 / 4 · 认真倾听'],
      [6000, 'thinking', '动作预览 · 3 / 4 · 想一想'],
      [9000, 'speaking', '动作预览 · 4 / 4 · 说话与口型（无声）'],
    ];
    for (const [delay, state, label] of sequence) {
      timers.push(window.setTimeout(() => {
        if (previewRunning) previewState(state, label);
      }, delay));
    }
    timers.push(window.setTimeout(() => endPreview('演示结束。点击光核，就可以和她说话。'), 12000));
  });
  sample.addEventListener('click', async () => {
    beginPreview();
    if (!previewState('idle', '正在准备本地示例语音…')) return;
    const epoch = previewEpoch;
    const diagnostics = window.AemeathAudioDiagnostics;
    sample.setAttribute('aria-pressed', 'true');
    try {
      // Resume the shared output context on the actual click when supported.
      // Fetching this bundled sample never involves a voice/model API.
      const preparing = diagnostics.preparePreview?.();
      if (preparing?.catch) void preparing.catch(() => {});
      if (!sampleBuffer) {
        sampleAbort = new AbortController();
        const response = await fetch('assets/audio/aemeath-welcome.wav', { signal: sampleAbort.signal });
        if (!response.ok) throw new Error('本地示例语音暂时没有加载成功。');
        sampleBuffer = await response.arrayBuffer();
      }
      if (epoch !== previewEpoch || !previewRunning) return;
      sampleAbort = null;
      // The real audio analyser drives the mouth now; release the silent pose
      // first so its interruption event cannot mistake this sample for a call.
      window.AemeathAvatar.stopPreview('sample');
      await diagnostics.playPreviewWav(sampleBuffer);
      if (epoch !== previewEpoch || !previewRunning) return;
      if (caption) {
        previousCaption = caption.textContent;
        caption.textContent = sampleCaption;
      }
      say('本地示例语音 · 听她说一句，看看口型与表情。');
      const startedAt = performance.now();
      const watchSample = () => {
        if (epoch !== previewEpoch || !previewRunning) return;
        const snapshot = diagnostics.getSnapshot();
        if (!snapshot.preview) {
          // A real conversation may now own the audio. Only clear our UI.
          endPreview(snapshot.playing ? '试听已结束，她正在回应你。' : '试听结束。点击光核，就可以和她说话。', false);
          return;
        }
        if (performance.now() - startedAt > 20000) {
          endPreview('声音暂时没能播放，可以再点一次试听。');
          return;
        }
        timers.push(window.setTimeout(watchSample, 250));
      };
      timers.push(window.setTimeout(watchSample, 250));
    } catch (error) {
      if (epoch !== previewEpoch || error?.name === 'AbortError') return;
      endPreview();
      say(error?.message || '示例语音暂时无法播放，可以稍后再试。');
    }
  });
  stop.addEventListener('click', () => {
    endPreview('演示已停止。');
    demo.focus();
  });

  window.addEventListener('aemeath-preview-end', event => {
    const reason = event.detail?.reason;
    if (reason === 'conversation' || reason === 'audio' || reason === 'interrupted') {
      endPreview('动作预览已结束，她正在回应你。', false);
    }
  });
  window.addEventListener('aemeath-controls-change', syncButtons);
  window.addEventListener('aemeath-performance', event => {
    if (!performanceStatus) return;
    const { fps, mode } = event.detail || {};
    if (!Number.isFinite(fps)) return;
    const label = mode === 'conversation' ? '对话优先' : mode === 'adaptive' ? '自动减负' : mode === 'high' ? '清晰' : '省电';
    performanceStatus.textContent = `${Math.round(fps)} FPS · ${label} · 自动调节清晰度`;
  });
  window.addEventListener('aemeath-avatar-ready', syncButtons);
  window.addEventListener('aemeath-avatar-error', () => {
    endPreview('角色显示暂时中断，已停止演示。');
    syncButtons();
    say('暂时使用轻量角色，3D 画面恢复后可再次演示。');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) endPreview('演示已停止。');
  });
  window.addEventListener('pagehide', () => endPreview());

  syncButtons();
  const readyTimer = window.setInterval(() => {
    syncButtons();
    if (wasReady) window.clearInterval(readyTimer);
  }, 500);
  window.addEventListener('pagehide', () => window.clearInterval(readyTimer));
})();

(() => {
  const scene = document.getElementById('scene');
  const canvas = document.getElementById('particles');
  const context = canvas.getContext('2d', { alpha: true });
  const clockTime = document.getElementById('clockTime');
  const clockDate = document.getElementById('clockDate');
  const avatarStream = document.getElementById('avatarStream');
  const avatarCanvas = document.getElementById('avatarCanvas');
  const avatarContext = avatarCanvas.getContext('2d', { alpha: true });
  const petAvatar = document.getElementById('petAvatar');
  const presenceState = document.getElementById('presenceState');
  const caption = document.getElementById('caption');
  const talkControl = document.getElementById('talkControl');
  const conversationState = document.getElementById('conversationState');
  const micSettingsToggle = document.getElementById('micSettingsToggle');
  const micSettingsPanel = document.getElementById('micSettingsPanel');
  const micSelect = document.getElementById('micSelect');
  const micDeviceStatus = document.getElementById('micDeviceStatus');
  const root = document.documentElement;
  const stageMode = location.pathname === '/stage' || location.pathname.startsWith('/stage/');
  const lightweightMode = stageMode && new URLSearchParams(location.search).get('avatar') !== 'live';
  if (stageMode) scene.classList.add('stage-mode');
  if (lightweightMode) scene.classList.add('lightweight-mode');

  const settings = {
    audioReactive: true,
    effectStrength: 100,
    particleDensity: 34,
    showClock: true,
    dimAmount: 20,
    accentColor: '#52eaff'
  };

  let paused = false;
  let width = 0;
  let height = 0;
  let dpr = 1;
  let audioLevel = .06;
  let targetAudio = .06;
  let particles = [];
  let lastFrame = 0;
  let frameRequest = 0;
  let companionSocket;
  let companionRetry;
  let avatarPeer;
  let avatarRetry;
  let avatarFrameRequest;
  let avatarFrameSeen = false;
  let continuousMode = false;
  let listening = false;
  let turnInFlight = false;
  let pendingStop = false;
  let assistantSpeaking = false;
  let microphoneStream;
  let microphoneContext;
  let microphoneSource;
  let microphoneProcessor;
  let resumeListeningTimer;
  let silenceTimer;
  let speechStartedAt = 0;
  let lastSpeechAt = 0;
  let inputPeak = 0;
  let streamedAudio;
  let fallbackAudio;
  let speechContext;
  let incomingAudioKind = '';
  let dropIncomingAudio = false;
  let companionInterrupted = false;
  let latestTurnId = '';
  const cancelledTurnIds = new Set();
  let speechFeatures = { energy: 0, rms: 0, low: 0, mid: 0, high: 0, centroid: 0, speaking: false };
  let liveAvatarEnabled = !lightweightMode;
  let avatarAudioQueue = Promise.resolve();
  let avatarAudioEpoch = 0;
  let avatarAudioAbort;
  let avatarPcmChunks = [];
  let avatarPcmBytes = 0;
  let avatarPcmRate = 48000;

  const voiceActivity = {
    startThreshold: .0012,
    continueThreshold: .0007,
    endSilenceMs: 850,
    minSpeechMs: 260,
    noSignalMs: 10000,
  };
  const microphoneChoiceKey = 'aemeath.inputDeviceChoice.v2';
  const petRows = {
    idle: { row: 0, frames: 7, delay: 260 },
    connecting: { row: 7, frames: 6, delay: 160 },
    microphone: { row: 6, frames: 6, delay: 220 },
    listening: { row: 6, frames: 6, delay: 220 },
    transcribing: { row: 8, frames: 6, delay: 180 },
    thinking: { row: 8, frames: 6, delay: 180 },
    replying: { row: 7, frames: 6, delay: 160 },
    speaking: { row: 3, frames: 4, delay: 140 },
    error: { row: 5, frames: 8, delay: 165 },
  };
  let petAnimationTimer;
  let petFrame = 0;

  const conversationLabels = {
    idle: '点击光核，我就会陪着你',
    connecting: '正在连接本地服务…',
    microphone: '正在连接麦克风…',
    listening: '我在听，你直接说',
    transcribing: '嗯，我听到了…',
    thinking: '让我想想…',
    replying: '我想好了…',
    speaking: '听我慢慢说给你听',
    error: '暂时没听清，再点一次',
  };

  function setAvatarStatus(status) {
    if (status !== 'ready') {
      avatarFrameSeen = false;
      scene.classList.remove('avatar-live');
    }
    presenceState.textContent = status === 'ready' ? ' LIVE AVATAR' : ' CONNECTING AVATAR';
  }

  function resizeAvatarCanvas() {
    avatarCanvas.width = Math.max(1, Math.round(innerWidth));
    avatarCanvas.height = Math.max(1, Math.round(innerHeight));
  }

  function drawAvatarVideo() {
    avatarFrameRequest = requestAnimationFrame(drawAvatarVideo);
    if (paused || avatarStream.readyState < 2 || !avatarStream.videoWidth || !avatarStream.videoHeight) return;
    const scale = avatarCanvas.height / avatarStream.videoHeight * (stageMode ? 1.5 : 1);
    const drawWidth = avatarStream.videoWidth * scale;
    avatarContext.clearRect(0, 0, avatarCanvas.width, avatarCanvas.height);
    avatarContext.drawImage(
      avatarStream,
      avatarCanvas.width - drawWidth,
      stageMode ? -avatarCanvas.height * .035 : 0,
      drawWidth,
      avatarCanvas.height * (stageMode ? 1.5 : 1),
    );
    if (!avatarFrameSeen) {
      avatarFrameSeen = true;
      scene.classList.add('avatar-live');
      setAvatarStatus('ready');
    }
  }

  async function waitForIce(connection) {
    if (connection.iceGatheringState === 'complete') return;
    await new Promise(resolve => {
      const onChange = () => {
        if (connection.iceGatheringState !== 'complete') return;
        connection.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      connection.addEventListener('icegatheringstatechange', onChange);
    });
  }

  async function connectAvatar() {
    clearTimeout(avatarRetry);
    if (!liveAvatarEnabled) return;
    if (avatarPeer && ['new', 'connecting', 'connected'].includes(avatarPeer.connectionState)) return;
    avatarPeer?.close();
    setAvatarStatus('connecting');
    try {
      avatarPeer = new RTCPeerConnection({ sdpSemantics: 'unified-plan' });
      avatarPeer.addTransceiver('video', { direction: 'recvonly' });
      avatarPeer.addTransceiver('audio', { direction: 'recvonly' });
      avatarPeer.addEventListener('track', event => {
        avatarStream.srcObject = event.streams[0];
        avatarStream.muted = true;
        void avatarStream.play().catch(() => {});
      });
      avatarPeer.addEventListener('connectionstatechange', () => {
        if (!liveAvatarEnabled) return;
        if (['failed', 'closed', 'disconnected'].includes(avatarPeer?.connectionState)) {
          setAvatarStatus('connecting');
          avatarRetry = setTimeout(connectAvatar, 3000);
        }
      });
      const offer = await avatarPeer.createOffer();
      await avatarPeer.setLocalDescription(offer);
      await waitForIce(avatarPeer);
      const response = await fetch('http://127.0.0.1:9349/offer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(avatarPeer.localDescription),
      });
      if (!response.ok) throw new Error(await response.text());
      await avatarPeer.setRemoteDescription(await response.json());
    } catch (_) {
      if (!liveAvatarEnabled) return;
      setAvatarStatus('connecting');
      avatarPeer?.close();
      avatarPeer = null;
      avatarRetry = setTimeout(connectAvatar, 5000);
    }
  }

  function setConversationState(value, detail) {
    scene.dataset.conversation = value;
    window.AemeathAvatar?.setState(value);
    setPetAnimation(value);
    conversationState.textContent = detail || conversationLabels[value] || conversationLabels.idle;
    talkControl.setAttribute('aria-label', continuousMode ? '停止与爱弥斯连续对话' : '开始与爱弥斯连续对话');
  }

  function setPetAnimation(state) {
    const animation = petRows[state] || petRows.idle;
    clearInterval(petAnimationTimer);
    petFrame = 0;
    if (!petAvatar) return;
    petAvatar.style.setProperty('--pet-row', animation.row);
    petAvatar.style.setProperty('--pet-frame', petFrame);
    petAvatar.dataset.state = state;
    petAnimationTimer = setInterval(() => {
      petFrame = (petFrame + 1) % animation.frames;
      petAvatar.style.setProperty('--pet-frame', petFrame);
    }, animation.delay);
  }

  function sendCompanion(message) {
    if (companionSocket?.readyState !== WebSocket.OPEN) return false;
    companionSocket.send(JSON.stringify(message));
    return true;
  }

  function downsample(inputSamples, inputRate, outputRate = 16000) {
    if (inputRate === outputRate) return new Float32Array(inputSamples);
    const ratio = inputRate / outputRate;
    const length = Math.round(inputSamples.length / ratio);
    const result = new Float32Array(length);
    let inputOffset = 0;
    for (let i = 0; i < length; i += 1) {
      const nextOffset = Math.round((i + 1) * ratio);
      let total = 0;
      let count = 0;
      for (; inputOffset < nextOffset && inputOffset < inputSamples.length; inputOffset += 1) {
        total += inputSamples[inputOffset];
        count += 1;
      }
      result[i] = count ? total / count : 0;
    }
    return result;
  }

  async function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  function describeMicrophoneError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') {
      return '麦克风权限被关闭了，请允许此页面使用麦克风后再点一次。';
    }
    if (error?.name === 'NotReadableError' || error?.name === 'AbortError') {
      return '麦克风正被其他程序独占，请关闭占用它的程序后再试。';
    }
    if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') {
      return '没有找到可用输入设备。请检查 Windows 设置 > 系统 > 声音 > 输入，确认“麦克风阵列”已启用。';
    }
    if (error?.name === 'TypeError' || error?.name === 'NotSupportedError') {
      return '当前窗口不允许麦克风采集，请用桌面应用入口打开，或在地址栏给 127.0.0.1 授予麦克风权限。';
    }
    return error?.message || '麦克风连接失败，请再点一次。';
  }

  function findPreferredMicrophone(devices, selectedDeviceId = '') {
    const selected = devices.find(device => device.deviceId === selectedDeviceId);
    if (selected) return selected;
    const isVirtual = device => /Steam|网易|virtual|虚拟/i.test(device.label);
    return devices.find(device => /麦克风阵列|microphone array/i.test(device.label) && /Realtek/i.test(device.label))
      || devices.find(device => /Realtek/i.test(device.label) && !isVirtual(device))
      || devices.find(device => !isVirtual(device) && device.deviceId !== 'default' && device.deviceId !== 'communications');
  }

  async function startMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前桌面渲染器不支持麦克风采集');
    setConversationState('microphone');
    const savedDeviceId = localStorage.getItem(microphoneChoiceKey) || '';
    const makeConstraints = (deviceId, minimal = false) => ({
      audio: {
        ...(minimal ? {} : {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        }),
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      },
    });
    const attempts = [];
    if (savedDeviceId) attempts.push([savedDeviceId, false]);
    attempts.push(['', false], ['', true]);
    let lastError;
    for (const [deviceId, minimal] of attempts) {
      try {
        microphoneStream = await withTimeout(
          navigator.mediaDevices.getUserMedia(makeConstraints(deviceId, minimal)),
          15000,
          '麦克风授权超时，请允许使用麦克风后再点一次',
        );
        if (deviceId) localStorage.setItem(microphoneChoiceKey, deviceId);
        else if (savedDeviceId) localStorage.removeItem(microphoneChoiceKey);
        break;
      } catch (error) {
        lastError = error;
        if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') break;
      }
    }
    if (!microphoneStream) throw lastError || new Error('没有返回可用的麦克风');

    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    const activeDeviceId = microphoneStream.getAudioTracks()[0]?.getSettings?.().deviceId || '';
    const preferred = findPreferredMicrophone(devices, savedDeviceId);
    if (preferred?.deviceId && preferred.deviceId !== activeDeviceId) {
      try {
        const preferredStream = await withTimeout(
          navigator.mediaDevices.getUserMedia(makeConstraints(preferred.deviceId)),
          8000,
          '切换麦克风超时',
        );
        microphoneStream.getTracks().forEach(track => track.stop());
        microphoneStream = preferredStream;
        localStorage.setItem(microphoneChoiceKey, preferred.deviceId);
      } catch (error) {
        // Keep the working stream if a preferred endpoint rejects the request.
        micDeviceStatus.textContent = `已连接：${microphoneStream.getAudioTracks()[0]?.label || '系统默认麦克风'}（自动回退）`;
      }
    }
    const track = microphoneStream.getAudioTracks()[0];
    if (!track) throw new Error('Windows 没有返回可用的麦克风');
    micDeviceStatus.textContent = `当前：${track.label || 'Windows 默认麦克风'}`;
    await populateMicrophoneDevices(track.getSettings?.().deviceId || '');
    track.addEventListener('ended', () => {
      listening = false;
      continuousMode = false;
      setConversationState('error', '麦克风已断开');
    });

    microphoneContext = new AudioContext({ latencyHint: 'interactive' });
    if (microphoneContext.state === 'suspended') await microphoneContext.resume();
    microphoneSource = microphoneContext.createMediaStreamSource(microphoneStream);
    microphoneProcessor = microphoneContext.createScriptProcessor(2048, 1, 1);
    const silentGain = microphoneContext.createGain();
    silentGain.gain.value = 0;
    microphoneSource.connect(microphoneProcessor);
    microphoneProcessor.connect(silentGain);
    silentGain.connect(microphoneContext.destination);

    microphoneProcessor.onaudioprocess = event => {
      const inputData = event.inputBuffer.getChannelData(0);
      let sum = 0;
      for (let i = 0; i < inputData.length; i += 1) sum += inputData[i] * inputData[i];
      const rawRms = Math.sqrt(sum / inputData.length);
      root.style.setProperty('--mic-meter', Math.min(1, rawRms * 18).toFixed(3));
      inputPeak = Math.max(inputPeak * .985, rawRms);
      if (!listening || assistantSpeaking || companionSocket?.readyState !== WebSocket.OPEN) return;

      const pcm = downsample(inputData, microphoneContext.sampleRate, 16000);
      companionSocket.send(pcm.buffer);
      const now = performance.now();
      const threshold = speechStartedAt ? voiceActivity.continueThreshold : voiceActivity.startThreshold;
      if (rawRms >= threshold) {
        if (!speechStartedAt) {
          speechStartedAt = now;
          setConversationState('listening', '听见了，继续说');
        }
        lastSpeechAt = now;
      }
      if (speechStartedAt && now - speechStartedAt >= voiceActivity.minSpeechMs && now - lastSpeechAt >= voiceActivity.endSilenceMs) {
        finishUtterance();
      }
    };
  }

  function stopMicrophone() {
    try { microphoneProcessor?.disconnect(); } catch (_) {}
    try { microphoneSource?.disconnect(); } catch (_) {}
    microphoneStream?.getTracks().forEach(track => track.stop());
    microphoneContext?.close().catch(() => {});
    microphoneProcessor = null;
    microphoneSource = null;
    microphoneStream = null;
    microphoneContext = null;
    root.style.setProperty('--mic-meter', '0');
  }

  async function populateMicrophoneDevices(activeDeviceId = '') {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'audioinput');
    const saved = localStorage.getItem(microphoneChoiceKey) || activeDeviceId || '';
    micSelect.replaceChildren(new Option('Windows 默认麦克风', ''));
    devices.forEach((device, index) => {
      if (device.deviceId === 'default' || device.deviceId === 'communications') return;
      micSelect.add(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId));
    });
    if (!devices.length) {
      micSelect.replaceChildren(new Option('未检测到麦克风', ''));
      micDeviceStatus.textContent = 'Windows 没有向此窗口公开音频输入设备';
      return;
    }
    if ([...micSelect.options].some(option => option.value === saved)) micSelect.value = saved;
  }

  function scheduleListeningResume(delay = 350) {
    clearTimeout(resumeListeningTimer);
    if (!continuousMode) return;
    resumeListeningTimer = setTimeout(() => void beginListeningCycle(), delay);
  }

  async function beginListeningCycle() {
    if (!continuousMode || listening || assistantSpeaking || pendingStop) return;
    if (companionSocket?.readyState !== WebSocket.OPEN) {
      setConversationState('connecting');
      return;
    }
    try {
      if (!microphoneStream) await startMicrophone();
      if (!continuousMode) { stopMicrophone(); return; }
      if (microphoneContext?.state === 'suspended') await microphoneContext.resume();
      if (!continuousMode) { stopMicrophone(); return; }
      listening = true;
      turnInFlight = false;
      speechStartedAt = 0;
      lastSpeechAt = 0;
      inputPeak = 0;
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        if (continuousMode && listening && !speechStartedAt) setConversationState('listening', '我在听，你随时可以开口');
      }, voiceActivity.noSignalMs);
      sendCompanion({ type: 'listen', enabled: true });
      setConversationState('listening');
    } catch (error) {
      continuousMode = false;
      listening = false;
      stopMicrophone();
      setConversationState('error', '麦克风不可用');
      caption.textContent = describeMicrophoneError(error);
    }
  }

  async function toggleContinuousConversation() {
    if (!continuousMode) {
      // A local sample must release the output before opening a real call.
      if (fallbackAudio?.preview) stopAssistantAudio();
      companionInterrupted = false;
      // Create/resume on the user's gesture so later streamed speech can play.
      try { void getSpeechContext().resume().catch(() => {}); } catch (_) {}
      continuousMode = true;
      setConversationState('connecting');
      await beginListeningCycle();
      return;
    }
    continuousMode = false;
    companionInterrupted = true;
    if (latestTurnId) cancelledTurnIds.add(latestTurnId);
    if (cancelledTurnIds.size > 32) cancelledTurnIds.delete(cancelledTurnIds.values().next().value);
    listening = false;
    turnInFlight = false;
    clearTimeout(resumeListeningTimer);
    clearTimeout(silenceTimer);
    sendCompanion({ type: 'listen', enabled: false, reason: 'continuous-mode-off', peak: inputPeak });
    sendCompanion({ type: 'interrupt' });
    stopMicrophone();
    stopAssistantAudio();
    setConversationState('idle');
    caption.textContent = '连续对话已关闭。再点光核，我就回来。';
  }

  function finishUtterance() {
    if (!listening || pendingStop) return;
    pendingStop = true;
    clearTimeout(silenceTimer);
    listening = false;
    turnInFlight = true;
    try {
      sendCompanion({ type: 'listen', enabled: false, reason: 'utterance-end', peak: inputPeak });
      setConversationState('transcribing');
    } finally {
      pendingStop = false;
      speechStartedAt = 0;
      lastSpeechAt = 0;
    }
  }

  function resetAvatarPcm(sampleRate) {
    avatarPcmChunks = [];
    avatarPcmBytes = 0;
    avatarPcmRate = sampleRate || 48000;
  }

  function flushAvatarPcm() {
    if (!liveAvatarEnabled) {
      resetAvatarPcm(avatarPcmRate);
      return;
    }
    if (!avatarPcmBytes) return;
    const payload = new Uint8Array(avatarPcmBytes);
    let offset = 0;
    for (const chunk of avatarPcmChunks) {
      payload.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const sampleRate = avatarPcmRate;
    const epoch = avatarAudioEpoch;
    avatarPcmChunks = [];
    avatarPcmBytes = 0;
    avatarAudioQueue = avatarAudioQueue.then(async () => {
      if (!liveAvatarEnabled || epoch !== avatarAudioEpoch) return;
      avatarAudioAbort = new AbortController();
      const response = await fetch('http://127.0.0.1:9349/audio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Aria-Sample-Rate': String(sampleRate),
        },
        body: payload,
        signal: avatarAudioAbort.signal,
      });
      if (!response.ok) throw new Error('avatar audio rejected');
    }).catch(() => {});
  }

  function queueAvatarPcm(buffer) {
    if (!liveAvatarEnabled) return;
    const copy = new Uint8Array(buffer.slice(0));
    avatarPcmChunks.push(copy);
    avatarPcmBytes += copy.byteLength;
    if (avatarPcmBytes >= Math.round(avatarPcmRate * .7)) flushAvatarPcm();
  }

  function completeAssistantAudio() {
    assistantSpeaking = false;
    turnInFlight = false;
    publishSpeechFeatures();
    setConversationState('idle');
    if (continuousMode) scheduleListeningResume();
  }

  function getSpeechContext() {
    if (!speechContext || speechContext.state === 'closed') {
      speechContext = new AudioContext({ latencyHint: 'interactive' });
    }
    return speechContext;
  }

  function createSpeechPlayback(sampleRate) {
    const playbackContext = getSpeechContext();
    const analyser = playbackContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = .12;
    analyser.connect(playbackContext.destination);
    return {
      context: playbackContext,
      analyser,
      waveform: new Float32Array(analyser.fftSize),
      spectrum: new Float32Array(analyser.frequencyBinCount),
      sampleRate: sampleRate || playbackContext.sampleRate,
      nextAt: playbackContext.currentTime,
      sources: new Map(),
      ended: false,
      pendingByte: null,
      hasScheduled: false,
      pendingBuffers: [],
      pendingSeconds: 0,
      buffering: false,
      bufferTarget: .3,
      bufferTimer: null,
      underruns: 0,
      released: false,
      preview: false,
    };
  }

  function releaseSpeechPlayback(playback) {
    if (!playback) return;
    playback.released = true;
    clearTimeout(playback.bufferTimer);
    playback.bufferTimer = null;
    playback.pendingBuffers.length = 0;
    playback.pendingSeconds = 0;
    for (const sourceNode of playback.sources.keys()) {
      try { sourceNode.stop(); } catch (_) {}
      try { sourceNode.disconnect(); } catch (_) {}
    }
    playback.sources.clear();
    try { playback.analyser.disconnect(); } catch (_) {}
  }

  function publishSpeechFeatures(features) {
    speechFeatures = features || { energy: 0, rms: 0, low: 0, mid: 0, high: 0, centroid: 0, speaking: false };
    window.AemeathAvatar?.setAudioLevel(speechFeatures.energy);
    window.AemeathAvatar?.setSpeechFeatures?.(speechFeatures);
    if (petAvatar) petAvatar.style.setProperty('--pet-audio', speechFeatures.energy.toFixed(3));
  }

  function sampleSpeechPlayback() {
    const playback = streamedAudio || fallbackAudio;
    let playing = false;
    if (playback?.context.state === 'running') {
      const now = playback.context.currentTime;
      for (const timing of playback.sources.values()) {
        if (now >= timing.startAt && now < timing.endAt) { playing = true; break; }
      }
    }
    if (!playing) {
      publishSpeechFeatures();
      return;
    }
    // Only speech output enters this analyser: microphone and wallpaper audio
    // must never open her mouth. Network arrival time is not playback time.
    playback.analyser.getFloatTimeDomainData(playback.waveform);
    let squareSum = 0;
    let sum = 0;
    for (const value of playback.waveform) { sum += value; squareSum += value * value; }
    const mean = sum / playback.waveform.length;
    const rms = Math.sqrt(Math.max(0, squareSum / playback.waveform.length - mean * mean));
    const energy = rms <= .0018 ? 0 : Math.min(1, Math.pow((rms - .0018) / .115, .8));
    let low = 0, mid = 0, high = 0, weightedFrequency = 0;
    if (energy > 0) {
      playback.analyser.getFloatFrequencyData(playback.spectrum);
      const binHz = playback.context.sampleRate / playback.analyser.fftSize;
      for (let i = 1; i < playback.spectrum.length; i += 1) {
        const hz = i * binHz;
        if (hz > 6500) break;
        if (hz < 100) continue;
        const power = Math.pow(10, playback.spectrum[i] / 10);
        if (hz < 650) low += power;
        else if (hz < 2200) mid += power;
        else high += power;
        weightedFrequency += power * hz;
      }
    }
    const total = low + mid + high;
    publishSpeechFeatures({
      energy, rms,
      low: total ? low / total : 0,
      mid: total ? mid / total : 0,
      high: total ? high / total : 0,
      centroid: total ? Math.min(1, weightedFrequency / total / 4000) : 0,
      speaking: true,
    });
    if (scene.dataset.conversation !== 'speaking') setConversationState('speaking');
  }

  function stopAssistantAudio() {
    const pcm = streamedAudio;
    const wav = fallbackAudio;
    // Clear references before stopping nodes, so late ended/decode callbacks
    // cannot finish or restart a replacement utterance.
    streamedAudio = null;
    fallbackAudio = null;
    incomingAudioKind = '';
    releaseSpeechPlayback(pcm);
    releaseSpeechPlayback(wav);
    assistantSpeaking = false;
    publishSpeechFeatures();
    avatarAudioEpoch += 1;
    avatarAudioAbort?.abort();
    avatarAudioQueue = Promise.resolve();
    resetAvatarPcm(48000);
  }

  function playbackFailed(error) {
    stopAssistantAudio();
    turnInFlight = false;
    setConversationState('error', '声音没能播放，再点光核试试');
    caption.textContent = error?.name === 'NotAllowedError'
      ? '请先点一下光核，允许这个窗口播放声音。'
      : `声音播放失败：${error?.message || '音频设备暂时不可用'}`;
    if (continuousMode) scheduleListeningResume(700);
  }

  function scheduleSpeechBuffer(playback, audioBuffer, initialDelay = .025) {
    if (playback.released) return;
    const sourceNode = playback.context.createBufferSource();
    sourceNode.buffer = audioBuffer;
    sourceNode.connect(playback.analyser);
    const startAt = Math.max(playback.nextAt, playback.context.currentTime + initialDelay);
    const endAt = startAt + audioBuffer.duration;
    playback.sources.set(sourceNode, { startAt, endAt });
    playback.nextAt = endAt;
    playback.hasScheduled = true;
    sourceNode.addEventListener('ended', () => {
      playback.sources.delete(sourceNode);
      try { sourceNode.disconnect(); } catch (_) {}
      if (!playback.ended || playback.sources.size || playback.pendingBuffers.length) return;
      if (streamedAudio !== playback && fallbackAudio !== playback) return;
      if (streamedAudio === playback) streamedAudio = null;
      if (fallbackAudio === playback) fallbackAudio = null;
      releaseSpeechPlayback(playback);
      completeAssistantAudio();
    }, { once: true });
    sourceNode.start(startAt);
  }

  function flushPcmPlayback(stream, force = false) {
    if (streamedAudio !== stream || stream.released || !stream.pendingBuffers.length) return;
    if (!force && !stream.ended && stream.buffering && stream.pendingSeconds < stream.bufferTarget) return;
    clearTimeout(stream.bufferTimer);
    stream.bufferTimer = null;
    stream.buffering = false;
    const buffers = stream.pendingBuffers;
    stream.pendingBuffers = [];
    stream.pendingSeconds = 0;
    // Schedule the whole available batch on the audio clock. Once scheduled,
    // playback continues independently of the avatar's animation frame rate.
    buffers.forEach((buffer, index) => scheduleSpeechBuffer(stream, buffer, index ? 0 : .025));
  }

  function queuePcmPlayback(stream, audioBuffer) {
    if (streamedAudio !== stream || stream.released || stream.ended) return;
    if (stream.hasScheduled && !stream.buffering && stream.nextAt <= stream.context.currentTime + .025) {
      stream.underruns += 1;
      stream.buffering = true;
      // A depleted queue needs a larger reserve, rather than immediately
      // playing each late fragment. The cap keeps recovery responsive.
      stream.bufferTarget = Math.min(.9, Math.max(.45, stream.bufferTarget * 1.5));
    }
    stream.pendingBuffers.push(audioBuffer);
    stream.pendingSeconds += audioBuffer.duration;
    flushPcmPlayback(stream);
    if (stream.pendingBuffers.length && !stream.bufferTimer) {
      // Sparse or very short streams must not wait forever for the target.
      const maxWait = Math.min(.9, stream.bufferTarget + .15) * 1000;
      stream.bufferTimer = setTimeout(() => flushPcmPlayback(stream, true), maxWait);
    }
  }

  async function playWav(buffer, preview = false) {
    stopAssistantAudio();
    assistantSpeaking = true;
    setConversationState('replying');
    let playback;
    try {
      playback = createSpeechPlayback();
      playback.preview = preview;
      fallbackAudio = playback;
      const [audioBuffer] = await Promise.all([
        playback.context.decodeAudioData(buffer.slice(0)),
        playback.context.resume(),
      ]);
      if (fallbackAudio !== playback) return;
      playback.ended = true;
      scheduleSpeechBuffer(playback, audioBuffer);
    } catch (error) {
      if (playback && fallbackAudio !== playback) return;
      playbackFailed(error);
      if (preview) throw error;
    }
  }

  function startPcmStream(sampleRate) {
    stopAssistantAudio();
    assistantSpeaking = true;
    incomingAudioKind = 'pcm';
    setConversationState('replying');
    resetAvatarPcm(sampleRate);
    let playback;
    try { playback = createSpeechPlayback(sampleRate); }
    catch (error) { playbackFailed(error); return; }
    // Wait for an actual PCM reserve, not just a fixed delay after one chunk.
    // This does not change the voice, sample rate, or natural pauses in PCM.
    playback.buffering = true;
    streamedAudio = playback;
    playback.context.resume().catch(error => {
      if (streamedAudio === playback) playbackFailed(error);
    });
  }

  function enqueuePcmChunk(buffer) {
    const stream = streamedAudio;
    if (!stream || stream.ended || stream.released || !buffer.byteLength) return;
    queueAvatarPcm(buffer);
    let bytes = new Uint8Array(buffer);
    if (stream.pendingByte !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = stream.pendingByte;
      joined.set(bytes, 1);
      bytes = joined;
      stream.pendingByte = null;
    }
    if (bytes.length % 2) stream.pendingByte = bytes[bytes.length - 1];
    const evenBytes = bytes.length - bytes.length % 2;
    if (!evenBytes) return;
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, evenBytes / 2);
    const floatSamples = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i += 1) {
      floatSamples[i] = pcm[i] / 32768;
    }
    const audioBuffer = stream.context.createBuffer(1, floatSamples.length, stream.sampleRate);
    audioBuffer.copyToChannel(floatSamples, 0);
    queuePcmPlayback(stream, audioBuffer);
  }

  function finishPcmStream() {
    incomingAudioKind = '';
    flushAvatarPcm();
    const stream = streamedAudio;
    if (!stream) return;
    stream.ended = true;
    // A completed short reply starts immediately, even below the reserve.
    flushPcmPlayback(stream, true);
    if (stream.sources.size === 0) {
      streamedAudio = null;
      releaseSpeechPlayback(stream);
      completeAssistantAudio();
    }
  }

  function connectCompanion() {
    clearTimeout(companionRetry);
    try {
      companionSocket?.close();
      companionSocket = new WebSocket('ws://127.0.0.1:17860/ws');
      companionSocket.binaryType = 'arraybuffer';
      companionSocket.addEventListener('open', () => {
        if (stageMode) sendCompanion({ type: 'demo-client' });
        if (continuousMode) scheduleListeningResume(50);
        else setConversationState('idle');
      });
      companionSocket.addEventListener('message', async event => {
        try {
          if (event.data instanceof ArrayBuffer) {
            if (companionInterrupted || dropIncomingAudio) return;
            if (incomingAudioKind === 'pcm') enqueuePcmChunk(event.data);
            else if (incomingAudioKind === 'wav' || (event.data.byteLength >= 4 && new DataView(event.data).getUint32(0, false) === 0x52494646)) {
              incomingAudioKind = '';
              await playWav(event.data);
            }
            return;
          }
          const message = JSON.parse(event.data);
          if (message.type === 'channel-status' || message.type === 'hello') {
            if (message.channel) window.dispatchEvent(new CustomEvent('companion-channel-status', { detail: message.channel }));
            if (message.paused) {
              continuousMode = listening = turnInFlight = false;
              companionInterrupted = true;
              if (latestTurnId) cancelledTurnIds.add(latestTurnId);
              clearTimeout(resumeListeningTimer);
              clearTimeout(silenceTimer);
              stopMicrophone();
              stopAssistantAudio();
              setConversationState('idle');
              caption.textContent = '通道已更新。再点光核，我们继续。';
              return;
            }
          }
          if (message.type === 'hello') {
            const last = [...(message.history || [])].reverse().find(item => item.role === 'assistant');
            if (last?.content) caption.textContent = last.content;
          }
          if (message.type === 'user-text') {
            if (message.turnId && cancelledTurnIds.has(message.turnId)) return;
            latestTurnId = message.turnId || '';
            companionInterrupted = false;
            dropIncomingAudio = false;
          }
          if (message.type === 'audio-stream-start' || message.type === 'audio-meta') {
            dropIncomingAudio = companionInterrupted || Boolean(message.turnId && cancelledTurnIds.has(message.turnId));
            if (dropIncomingAudio) return;
            latestTurnId = message.turnId || latestTurnId;
          }
          if (companionInterrupted || dropIncomingAudio) return;
          if (message.type === 'state') {
            // Server states also drive text/demo conversations. Its "speaking"
            // means synthesis has started; only playback may open the mouth.
            if (conversationLabels[message.value]) {
              if (message.value === 'speaking') {
                if (!speechFeatures.speaking) setConversationState('replying');
              } else if (!(assistantSpeaking && ['idle', 'replying', 'listening'].includes(message.value))) {
                setConversationState(message.value);
              }
            }
            if (message.value === 'idle' && continuousMode && turnInFlight && !assistantSpeaking) {
              turnInFlight = false;
              scheduleListeningResume();
            }
          }
          if (message.type === 'user-text' && message.text) caption.textContent = `你：${message.text}`;
          if (message.type === 'assistant-delta' && message.text) caption.textContent = message.text;
          if (message.type === 'assistant-final' && message.text) caption.textContent = message.text;
          if (message.type === 'audio-stream-start') startPcmStream(message.sampleRate || 48000);
          if (message.type === 'audio-meta') {
            stopAssistantAudio();
            incomingAudioKind = 'wav';
          }
          if (message.type === 'audio-stream-end') finishPcmStream();
          if (message.type === 'error') {
            caption.textContent = message.message || '刚才没有听清，请再说一次。';
            if (!assistantSpeaking) setConversationState('error');
            if (continuousMode && !assistantSpeaking) scheduleListeningResume(700);
          }
        } catch (error) {
          if (event.data instanceof ArrayBuffer && scene.dataset.conversation !== 'error') playbackFailed(error);
        }
      });
      companionSocket.addEventListener('close', () => {
        listening = false;
        if (streamedAudio && !streamedAudio.ended) finishPcmStream();
        incomingAudioKind = '';
        if (continuousMode) setConversationState('connecting');
        companionRetry = setTimeout(connectCompanion, 2500);
      });
    } catch (_) {
      if (continuousMode) setConversationState('connecting');
      companionRetry = setTimeout(connectCompanion, 2500);
    }
  }

  function updateClock() {
    const now = new Date();
    clockTime.textContent = new Intl.DateTimeFormat('zh-CN', {
      hour: '2-digit', minute: '2-digit', hour12: false
    }).format(now);
    clockDate.textContent = new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit', day: '2-digit', weekday: 'short'
    }).format(now).replace('/', ' · ').toUpperCase();
  }

  function createParticle() {
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      radius: .35 + Math.random() * 1.4,
      speed: .08 + Math.random() * .22,
      drift: (Math.random() - .5) * .08,
      alpha: .08 + Math.random() * .3,
      tint: Math.random() > .88 ? '217,93,255' : '82,234,255'
    };
  }

  function resetParticles() {
    const scale = Math.max(.6, Math.min(1.5, (width * height) / (2560 * 1600)));
    const count = Math.round(settings.particleDensity * scale);
    particles = Array.from({ length: count }, createParticle);
  }

  function resize() {
    const bounds = canvas.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    resetParticles();
  }

  function draw(timestamp) {
    frameRequest = requestAnimationFrame(draw);
    if (paused || document.hidden || timestamp - lastFrame < 33) return;
    lastFrame = timestamp;

    sampleSpeechPlayback();
    audioLevel += (Math.max(targetAudio, speechFeatures.energy) - audioLevel) * .16;
    targetAudio += (.045 - targetAudio) * .016;
    root.style.setProperty('--audio', audioLevel.toFixed(3));
    context.clearRect(0, 0, width, height);

    const motion = 1 + audioLevel * settings.effectStrength / 78;
    for (const particle of particles) {
      particle.y -= particle.speed * motion;
      particle.x += particle.drift;
      if (particle.y < -4) {
        particle.y = height + 4;
        particle.x = Math.random() * width;
      }
      if (particle.x < -4) particle.x = width + 4;
      if (particle.x > width + 4) particle.x = -4;
      context.beginPath();
      context.fillStyle = `rgba(${particle.tint},${particle.alpha * (1 + audioLevel * .8)})`;
      context.shadowColor = `rgba(${particle.tint},.5)`;
      context.shadowBlur = 7;
      context.arc(particle.x, particle.y, particle.radius * (1 + audioLevel * .5), 0, Math.PI * 2);
      context.fill();
    }
    context.shadowBlur = 0;
  }

  function applySettings() {
    root.style.setProperty('--strength', (settings.effectStrength / 100).toFixed(2));
    root.style.setProperty('--dim', (settings.dimAmount / 100).toFixed(2));
    root.style.setProperty('--cyan', settings.accentColor);
    scene.classList.toggle('no-audio', !settings.audioReactive);
    scene.classList.toggle('hide-clock', !settings.showClock);
  }

  window.livelyAudioListener = audioArray => {
    if (!settings.audioReactive || paused || !Array.isArray(audioArray)) return;
    const bins = audioArray.slice(0, Math.min(28, audioArray.length));
    if (!bins.length) return;
    const mean = bins.reduce((sum, value) => sum + Math.min(1.25, Math.max(0, Number(value) || 0)), 0) / bins.length;
    targetAudio = Math.min(1, .045 + mean * 1.55 * settings.effectStrength / 100);
  };

  window.livelyWallpaperPlaybackChanged = data => {
    try {
      const state = typeof data === 'string' ? JSON.parse(data) : data;
      paused = Boolean(state && state.IsPaused);
      if (paused) publishSpeechFeatures();
      scene.classList.toggle('is-paused', paused);
    } catch (_) {}
  };

  window.livelyPropertyListener = (name, value) => {
    if (!(name in settings)) return;
    settings[name] = value;
    if (name === 'particleDensity') resetParticles();
    applySettings();
  };

  window.addEventListener('mousemove', event => {
    const x = (event.clientX / Math.max(1, innerWidth) - .5) * 12;
    const y = (event.clientY / Math.max(1, innerHeight) - .5) * 9;
    root.style.setProperty('--px', `${x.toFixed(2)}px`);
    root.style.setProperty('--py', `${y.toFixed(2)}px`);
  }, { passive: true });

  window.addEventListener('resize', () => {
    resize();
    resizeAvatarCanvas();
  }, { passive: true });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !frameRequest) frameRequest = requestAnimationFrame(draw);
  });

  talkControl.addEventListener('click', () => void toggleContinuousConversation());
  talkControl.addEventListener('keydown', event => {
    if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
      event.preventDefault();
      void toggleContinuousConversation();
    }
  });
  micSettingsToggle.addEventListener('click', event => {
    event.stopPropagation();
    micSettingsPanel.hidden = !micSettingsPanel.hidden;
    if (!micSettingsPanel.hidden) void populateMicrophoneDevices();
  });
  micSettingsPanel.addEventListener('click', event => event.stopPropagation());
  micSelect.addEventListener('change', () => {
    if (micSelect.value) localStorage.setItem(microphoneChoiceKey, micSelect.value);
    else localStorage.removeItem(microphoneChoiceKey);
    const label = micSelect.selectedOptions[0]?.textContent || 'Windows 默认麦克风';
    micDeviceStatus.textContent = `已选择：${label}`;
    if (!continuousMode) return;
    listening = false;
    sendCompanion({ type: 'listen', enabled: false, reason: 'device-switch', peak: inputPeak });
    stopMicrophone();
    setConversationState('microphone', '正在切换麦克风…');
    scheduleListeningResume(120);
  });
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void populateMicrophoneDevices());
  window.addEventListener('aemeath-avatar-ready', event => {
    presenceState.textContent = ['vrm', 'pmx'].includes(event.detail?.kind) ? ' 3D PRESENCE' : ' ANIMATED PET';
    liveAvatarEnabled = false;
    avatarAudioEpoch += 1;
    avatarAudioAbort?.abort();
    resetAvatarPcm(48000);
    avatarPeer?.close();
    clearTimeout(avatarRetry);
  });

  // Local preview uses the same output/analyser path as real replies, without
  // opening the microphone, sending a chat request, or touching live calls.
  window.AemeathAudioDiagnostics = Object.freeze({
    preparePreview() {
      if (continuousMode || listening || turnInFlight || assistantSpeaking) return Promise.reject(new Error('请先结束当前对话，再试听动作。'));
      return getSpeechContext().resume();
    },
    getSnapshot() {
      const playback = streamedAudio || fallbackAudio;
      return {
        ...speechFeatures,
        playing: speechFeatures.speaking,
        contextState: playback?.context.state || speechContext?.state || 'uninitialized',
        contextTime: playback?.context.currentTime || 0,
        queuedSources: playback?.sources.size || 0,
        queuedSeconds: playback ? Math.max(0, playback.nextAt - playback.context.currentTime) : 0,
        bufferedSeconds: playback?.pendingSeconds || 0,
        buffering: Boolean(playback?.buffering && playback?.pendingBuffers.length),
        bufferTargetSeconds: playback?.bufferTarget || 0,
        underruns: playback?.underruns || 0,
        receiving: incomingAudioKind,
        preview: Boolean(playback?.preview),
      };
    },
    async playPreviewWav(buffer) {
      if (continuousMode || listening || turnInFlight || assistantSpeaking) throw new Error('请先结束当前对话，再试听动作。');
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 44 || new DataView(buffer).getUint32(0, false) !== 0x52494646) {
        throw new Error('试听需要有效的本地 WAV 音频。');
      }
      await playWav(buffer, true);
    },
    stopPreview() {
      if (!fallbackAudio?.preview) return;
      stopAssistantAudio();
      setConversationState('idle');
    },
  });

  updateClock();
  setInterval(updateClock, 15000);
  resize();
  resizeAvatarCanvas();
  applySettings();
  setPetAnimation('connecting');
  if (lightweightMode) {
    presenceState.textContent = ' LIGHT PORTRAIT';
    scene.classList.remove('avatar-live');
  } else {
    setAvatarStatus('connecting');
    void connectAvatar();
  }
  setConversationState('connecting');
  connectCompanion();
  window.addEventListener('pagehide', () => {
    avatarPeer?.close();
    companionSocket?.close();
    stopMicrophone();
    stopAssistantAudio();
    speechContext?.close().catch(() => {});
  });
  avatarFrameRequest = requestAnimationFrame(drawAvatarVideo);
  frameRequest = requestAnimationFrame(draw);
})();

'use strict';

const scene = document.querySelector('.scene');
const listenButton = document.querySelector('#listen-button');
const stateTitle = document.querySelector('#state-title');
const stateDetail = document.querySelector('#state-detail');
const subtitle = document.querySelector('#subtitle');
const speakerLabel = document.querySelector('#speaker-label');
const brainPill = document.querySelector('#brain-pill');
const voicePill = document.querySelector('#voice-pill');
const micPill = document.querySelector('#mic-pill');
const microphoneSelect = document.querySelector('#microphone-select');
const form = document.querySelector('#text-form');
const input = document.querySelector('#text-input');
const toast = document.querySelector('#toast');
const clearButton = document.querySelector('#clear-button');

const stateCopy = {
  booting: ['稍等一下', '我正在把频道接好'],
  idle: ['等你开口', '点一下光核，我就会一直陪着你'],
  listening: ['我在听', '不用急，慢慢说，我不会打断你'],
  transcribing: ['嗯，我听到了', '让我把你的话再想一遍'],
  thinking: ['让我想想', '我在认真琢磨你刚才说的事'],
  replying: ['我想好了', '有些话，我想慢慢告诉你'],
  speaking: ['我在这里', '听我慢慢说给你听'],
};

let ws;
let audioContext;
let mediaStream;
let processor;
let source;
let listening = false;
let assistantSpeaking = false;
let activeAudio;
let partialReply = '';
let toastTimer;
let silenceTimer;
let listenStartedAt = 0;
let speechStartedAt = 0;
let lastSpeechAt = 0;
let inputPeak = 0;
let pendingStop = false;
let confirmedInputDeviceId = '';
let audioFrameCount = 0;
let lastLevelUpdateAt = 0;
let continuousMode = false;
let turnInFlight = false;
let resumeListeningTimer;
let streamedAudio = null;

const voiceActivity = {
  startThreshold: 0.0012,
  continueThreshold: 0.0007,
  endSilenceMs: 850,
  minSpeechMs: 260,
  noSignalMs: 10000,
};

function setState(value) {
  scene.dataset.state = value;
  const copy = stateCopy[value] || stateCopy.idle;
  stateTitle.textContent = copy[0];
  stateDetail.textContent = copy[1];
}

function setPill(element, ready, label) {
  element.classList.toggle('ready', Boolean(ready));
  element.classList.toggle('error', ready === false);
  if (label) element.lastChild.textContent = label;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 4200);
}

function sendJson(payload) {
  if (ws?.readyState !== WebSocket.OPEN) throw new Error('本地语音连接尚未就绪');
  ws.send(JSON.stringify(payload));
}

async function refreshHealth() {
  try {
    const health = await fetch('/api/health').then((response) => response.json());
    if (health.channel?.mode === 'api') setPill(brainPill, null, 'API 已配置 · 未自动试连');
    else setPill(brainPill, health.llm.ready, health.llm.ready ? '本地大脑在线' : '本地大脑未连接');
    const naturalReady = Boolean(health.speech.naturalVoice?.ready);
    const voiceReady = naturalReady || health.speech.ready;
    const voiceLabel = naturalReady ? (health.speech.naturalVoice.voice || '爱弥斯 · 清冷明亮原创声线') : (health.speech.ready ? 'Kokoro 备用女声' : (health.speech.installed ? '离线语音加载中' : '语音模型未完成'));
    setPill(voicePill, voiceReady, voiceLabel);
  } catch {
    setPill(brainPill, false, '服务未连接');
  }
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${protocol}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('open', () => {
    setState('idle');
    refreshHealth();
    if (continuousMode) scheduleListeningResume();
  });
  ws.addEventListener('close', () => {
    setPill(brainPill, false, '本地服务断开');
    setState('booting');
    setTimeout(connect, 1600);
  });
  ws.addEventListener('message', async (event) => {
    if (event.data instanceof ArrayBuffer) {
      if (streamedAudio) enqueuePcmChunk(event.data);
      else await playWav(event.data);
      return;
    }
    const message = JSON.parse(event.data);
    if (message.type === 'channel-status' || message.type === 'hello') {
      if (message.channel) window.dispatchEvent(new CustomEvent('companion-channel-status', { detail: message.channel }));
      if (message.paused) {
        continuousMode = listening = turnInFlight = false;
        clearTimeout(resumeListeningTimer);
        clearTimeout(silenceTimer);
        stopMicrophone();
        stopAssistantAudio();
        updateContinuousUi();
        setState('idle');
        showToast('通道已更新，请再点光核继续对话');
      }
    }
    if (message.type === 'hello') {
      const voiceLabel = message.speech.ready ? '本地女声已就绪' : (message.speech.installed ? '离线语音加载中' : '语音模型未完成');
      setPill(voicePill, message.speech.ready, voiceLabel);
      const last = [...(message.history || [])].reverse().find((item) => item.role === 'assistant');
      if (last) subtitle.textContent = last.content;
    }
    if (message.type === 'speech-status') {
      setPill(voicePill, message.ready, message.ready ? '本地女声已就绪' : '离线语音失败');
      if (message.error) showToast(message.error);
    }
    if (message.type === 'state') {
      setState(message.value);
      if (message.value === 'idle' && continuousMode && turnInFlight && !assistantSpeaking) {
        turnInFlight = false;
        scheduleListeningResume();
      }
    }
    if (message.type === 'user-text') {
      speakerLabel.textContent = '你';
      subtitle.textContent = message.text;
      partialReply = '';
    }
    if (message.type === 'assistant-delta') {
      speakerLabel.textContent = '爱弥斯';
      partialReply += message.text;
      subtitle.textContent = partialReply;
    }
    if (message.type === 'assistant-final') {
      speakerLabel.textContent = '爱弥斯';
      subtitle.textContent = message.text;
      partialReply = '';
    }
    if (message.type === 'audio-stream-start') startPcmStream(message.sampleRate || 48000);
    if (message.type === 'audio-stream-end') finishPcmStream();
    if (message.type === 'error') showToast(message.message);
  });
}

window.addEventListener('companion-channel', event => {
  if (event.detail?.mode === 'api') setPill(brainPill, null, 'API 已配置 · 未自动试连');
  else if (event.detail?.mode === 'local' && brainPill.textContent.includes('API')) void refreshHealth();
});

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

function withTimeout(promise, milliseconds, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function populateMicrophoneList(activeDeviceId) {
  const devices = (await navigator.mediaDevices.enumerateDevices())
    .filter((device) => device.kind === 'audioinput');
  const chosen = localStorage.getItem('ling.inputDeviceChoice') || '';
  microphoneSelect.replaceChildren(new Option('Windows 默认麦克风', ''));
  for (const [index, device] of devices.entries()) {
    if (device.deviceId === 'default' || device.deviceId === 'communications') continue;
    microphoneSelect.add(new Option(device.label || `麦克风 ${index + 1}`, device.deviceId));
  }
  if ([...microphoneSelect.options].some((option) => option.value === chosen)) {
    microphoneSelect.value = chosen;
  } else {
    microphoneSelect.value = '';
  }
  const active = devices.find((device) => device.deviceId === activeDeviceId);
  return active?.label || mediaStream?.getAudioTracks()[0]?.label || 'Windows 默认麦克风';
}

async function startMicrophone() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器不支持麦克风采集');
  const savedDeviceId = localStorage.getItem('ling.inputDeviceChoice') || '';
  const selectedDeviceId = savedDeviceId;
  const audioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
    ...(selectedDeviceId ? { deviceId: { exact: selectedDeviceId } } : {}),
  };
  setPill(micPill, null, '正在连接麦克风…');
  try {
    mediaStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: audioConstraints }),
      10000,
      '麦克风授权超时，请在窗口顶部允许麦克风后再点一次',
    );
  } catch (error) {
    if (!savedDeviceId) throw error;
    localStorage.removeItem('ling.inputDeviceChoice');
    mediaStream = await withTimeout(
      navigator.mediaDevices.getUserMedia({ audio: { ...audioConstraints, deviceId: undefined } }),
      10000,
      '麦克风授权超时，请在窗口顶部允许麦克风后再点一次',
    );
  }
  const activeTrack = mediaStream.getAudioTracks()[0];
  if (!activeTrack) throw new Error('Windows 没有返回可用的麦克风音轨');
  confirmedInputDeviceId = activeTrack.getSettings?.().deviceId || '';
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === 'audioinput');
  const activeLabel = activeTrack.label || '';
  const preferred = !savedDeviceId && devices.find((device) => /Realtek/i.test(device.label) && !/Steam|网易|virtual/i.test(device.label));
  if (preferred?.deviceId && preferred.label !== activeLabel) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { ...audioConstraints, deviceId: { exact: preferred.deviceId } } });
  }
  const microphoneName = await populateMicrophoneList(confirmedInputDeviceId);
  setPill(micPill, true, microphoneName);
  showToast(`正在使用：${microphoneName}`);
  activeTrack.addEventListener('ended', () => {
    setPill(micPill, false, '麦克风已断开');
    listening = false;
  });
  audioContext = audioContext || new AudioContext({ latencyHint: 'interactive' });
  if (audioContext.state === 'suspended') await audioContext.resume();
  source = audioContext.createMediaStreamSource(mediaStream);
  processor = audioContext.createScriptProcessor(2048, 1, 1);
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  source.connect(processor);
  processor.connect(silentGain);
  silentGain.connect(audioContext.destination);
  processor.onaudioprocess = (event) => {
    const inputData = event.inputBuffer.getChannelData(0);
    let sum = 0;
    for (let i = 0; i < inputData.length; i += 1) sum += inputData[i] * inputData[i];
    const rawRms = Math.sqrt(sum / inputData.length);
    const rms = Math.min(1, rawRms * 7);
    inputPeak = Math.max(inputPeak * .985, rawRms);
    audioFrameCount += 1;
    document.documentElement.style.setProperty('--level', rms.toFixed(3));
    if (!listening || assistantSpeaking || ws?.readyState !== WebSocket.OPEN) return;
    const pcm = downsample(inputData, audioContext.sampleRate, 16000);
    ws.send(pcm.buffer);

    const now = performance.now();
    if (now - lastLevelUpdateAt > 450) {
      const level = Math.min(100, Math.round(rawRms * 1600));
      stateDetail.textContent = level > 0 ? `麦克风已连接 · 当前电平 ${level}%` : '麦克风已连接，正在等待声音';
      lastLevelUpdateAt = now;
    }
    const threshold = speechStartedAt ? voiceActivity.continueThreshold : voiceActivity.startThreshold;
    if (rawRms >= threshold) {
      if (!speechStartedAt) {
        speechStartedAt = now;
        stateDetail.textContent = '听见了，继续说；停顿后我会自动接话';
      }
      lastSpeechAt = now;
    }
    if (speechStartedAt && now - speechStartedAt >= voiceActivity.minSpeechMs && now - lastSpeechAt >= voiceActivity.endSilenceMs) {
      finishUtterance();
    }
  };
}

function stopMicrophone() {
  processor?.disconnect();
  source?.disconnect();
  mediaStream?.getTracks().forEach((track) => track.stop());
  processor = null;
  source = null;
  mediaStream = null;
}

function updateContinuousUi() {
  scene.dataset.continuous = continuousMode ? 'true' : 'false';
  listenButton.setAttribute('aria-label', continuousMode ? '停止连续对话' : '开始连续对话');
}

function scheduleListeningResume(delay = 350) {
  clearTimeout(resumeListeningTimer);
  if (!continuousMode) return;
  resumeListeningTimer = setTimeout(() => beginListeningCycle(), delay);
}

async function beginListeningCycle() {
  if (!continuousMode || listening || assistantSpeaking || pendingStop || ws?.readyState !== WebSocket.OPEN) return;
  try {
    if (!mediaStream) {
      setState('booting');
      stateTitle.textContent = '正在连接麦克风';
      stateDetail.textContent = '会自动使用 Windows 默认输入设备';
      listenButton.disabled = true;
      await startMicrophone();
    }
    if (audioContext?.state === 'suspended') await audioContext.resume();
    if (!continuousMode) { stopMicrophone(); return; }
    listening = true;
    turnInFlight = false;
    listenStartedAt = performance.now();
    speechStartedAt = 0;
    lastSpeechAt = 0;
    inputPeak = 0;
    audioFrameCount = 0;
    lastLevelUpdateAt = 0;
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      if (continuousMode && listening && !speechStartedAt) {
        stateDetail.textContent = '连续聆听中，你随时可以开口';
      }
    }, voiceActivity.noSignalMs);
    updateContinuousUi();
    sendJson({ type: 'listen', enabled: true });
  } catch (error) {
    listening = false;
    continuousMode = false;
    stopMicrophone();
    setPill(micPill, false, '麦克风连接失败');
    setState('idle');
    updateContinuousUi();
    showToast(`无法使用麦克风：${error.message}`);
  } finally {
    listenButton.disabled = false;
  }
}

async function toggleContinuousConversation() {
  if (!continuousMode) {
    continuousMode = true;
    updateContinuousUi();
    showToast('连续对话已开启，说完后我会自动接话');
    await beginListeningCycle();
    return;
  }
  continuousMode = false;
  turnInFlight = false;
  clearTimeout(resumeListeningTimer);
  clearTimeout(silenceTimer);
  if (listening) {
    listening = false;
    sendJson({ type: 'listen', enabled: false, reason: 'continuous-mode-off', peak: inputPeak });
  }
  stopMicrophone();
  updateContinuousUi();
  setPill(micPill, null, '麦克风待命');
  setState('idle');
  showToast('连续对话已关闭');
}

async function finishUtterance() {
  if (!listening || pendingStop) return;
  pendingStop = true;
  clearTimeout(silenceTimer);
  listening = false;
  turnInFlight = true;
  updateContinuousUi();
  try {
    sendJson({ type: 'listen', enabled: false, reason: 'utterance-end', peak: inputPeak });
    setState('transcribing');
  } finally {
    pendingStop = false;
    speechStartedAt = 0;
    lastSpeechAt = 0;
  }
}

async function playWav(buffer) {
  assistantSpeaking = true;
  activeAudio?.pause();
  const blob = new Blob([buffer], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeAudio = audio;
  audio.addEventListener('ended', () => {
    URL.revokeObjectURL(url);
    assistantSpeaking = false;
    turnInFlight = false;
    if (continuousMode) {
      stateTitle.textContent = '马上继续听你说';
      stateDetail.textContent = '不需要再点光核';
      scheduleListeningResume();
    } else {
      setState('idle');
    }
  }, { once: true });
  audio.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    assistantSpeaking = false;
    showToast('语音播放失败');
    turnInFlight = false;
    scheduleListeningResume();
  }, { once: true });
  await audio.play();
}

function completeAssistantAudio() {
  assistantSpeaking = false;
  turnInFlight = false;
  document.documentElement.style.setProperty('--level', '0');
  if (continuousMode) {
    stateTitle.textContent = '马上继续听你说';
    stateDetail.textContent = '不需要再点光核';
    scheduleListeningResume();
  } else {
    setState('idle');
  }
}

function stopAssistantAudio() {
  activeAudio?.pause();
  if (streamedAudio) {
    for (const sourceNode of streamedAudio.sources) {
      try { sourceNode.stop(); } catch {}
    }
    streamedAudio.context.close().catch(() => {});
    streamedAudio = null;
  }
  assistantSpeaking = false;
  document.documentElement.style.setProperty('--level', '0');
}

function startPcmStream(sampleRate) {
  streamedAudio?.context.close().catch(() => {});
  activeAudio?.pause();
  assistantSpeaking = true;
  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  streamedAudio = {
    context,
    sampleRate,
    nextAt: context.currentTime + 0.08,
    sources: new Set(),
    ended: false,
    finalAt: 0,
  };
}

function enqueuePcmChunk(buffer) {
  const stream = streamedAudio;
  if (!stream || !buffer.byteLength) return;
  const pcm = new Int16Array(buffer);
  const floatSamples = new Float32Array(pcm.length);
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) {
    floatSamples[i] = pcm[i] / 32768;
    peak = Math.max(peak, Math.abs(floatSamples[i]));
  }
  const audioBuffer = stream.context.createBuffer(1, floatSamples.length, stream.sampleRate);
  audioBuffer.copyToChannel(floatSamples, 0);
  const sourceNode = stream.context.createBufferSource();
  sourceNode.buffer = audioBuffer;
  sourceNode.connect(stream.context.destination);
  const startAt = Math.max(stream.nextAt, stream.context.currentTime + 0.025);
  sourceNode.start(startAt);
  stream.nextAt = startAt + audioBuffer.duration;
  stream.finalAt = stream.nextAt;
  stream.sources.add(sourceNode);
  document.documentElement.style.setProperty('--level', Math.min(1, peak * 1.35).toFixed(3));
  sourceNode.addEventListener('ended', () => {
    stream.sources.delete(sourceNode);
    if (stream.ended && stream.sources.size === 0 && streamedAudio === stream) {
      stream.context.close().catch(() => {});
      streamedAudio = null;
      completeAssistantAudio();
    }
  }, { once: true });
}

function finishPcmStream() {
  const stream = streamedAudio;
  if (!stream) return;
  stream.ended = true;
  if (stream.sources.size === 0) {
    stream.context.close().catch(() => {});
    streamedAudio = null;
    completeAssistantAudio();
  }
}

listenButton.addEventListener('click', toggleContinuousConversation);
microphoneSelect.addEventListener('change', () => {
  localStorage.setItem('ling.inputDeviceChoice', microphoneSelect.value);
  stopMicrophone();
  continuousMode = false;
  turnInFlight = false;
  updateContinuousUi();
  setPill(micPill, null, microphoneSelect.value ? '设备已切换，点光核启用' : '将使用 Windows 默认麦克风');
  showToast('麦克风选择已保存，下次聆听时生效');
});
window.addEventListener('keydown', (event) => {
  if (event.ctrlKey && event.code === 'Space' && !event.repeat) {
    event.preventDefault();
    toggleContinuousConversation();
  }
});
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text || ws?.readyState !== WebSocket.OPEN) return;
  if (assistantSpeaking) {
    stopAssistantAudio();
    sendJson({ type: 'interrupt' });
  }
  sendJson({ type: 'text', text });
  input.value = '';
});
clearButton.addEventListener('click', async () => {
  if (!confirm('清除保存在这台电脑上的全部对话记忆？')) return;
  await fetch('/api/history', { method: 'DELETE' });
  subtitle.textContent = '记忆已经清空。我们重新认识一次吧。';
  showToast('本地对话记忆已清除');
});
window.addEventListener('beforeunload', stopMicrophone);

connect();
refreshHealth();
updateContinuousUi();

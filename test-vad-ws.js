'use strict';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const file = path.join(__dirname, 'data', 'voice-test.wav');
const wav = fs.readFileSync(file);
const dataMarker = wav.indexOf(Buffer.from('data'));
if (dataMarker < 0) throw new Error('Invalid WAV');
const dataOffset = dataMarker + 8;
const sampleRate = wav.readUInt32LE(24);
const source = new Float32Array(Math.floor((wav.length - dataOffset) / 2));
for (let i = 0; i < source.length; i += 1) source[i] = wav.readInt16LE(dataOffset + i * 2) / 32768;
const ratio = sampleRate / 16000;
const resampled = new Float32Array(Math.round(source.length / ratio));
let sourceOffset = 0;
for (let i = 0; i < resampled.length; i += 1) {
  const nextOffset = Math.round((i + 1) * ratio);
  let total = 0;
  let count = 0;
  for (; sourceOffset < nextOffset && sourceOffset < source.length; sourceOffset += 1) {
    total += source[sourceOffset];
    count += 1;
  }
  resampled[i] = count ? total / count : 0;
}
const pcm = new Float32Array(resampled.length + 16000);
pcm.set(resampled);

const ws = new WebSocket('ws://127.0.0.1:17860/ws', { origin: 'http://127.0.0.1:17860' });
const started = Date.now();
const timer = setTimeout(() => {
  console.error('VAD end-to-end test timed out');
  process.exit(1);
}, 120000);

ws.on('open', async () => {
  ws.send(JSON.stringify({ type: 'listen', enabled: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  const frameSize = 2048;
  for (let offset = 0; offset < pcm.length; offset += frameSize) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const frame = pcm.slice(offset, Math.min(offset + frameSize, pcm.length));
    ws.send(Buffer.from(frame.buffer));
    await new Promise((resolve) => setTimeout(resolve, 90));
  }
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'listen', enabled: false }));
});

ws.on('error', () => {
  clearTimeout(timer);
  console.error('Local companion WebSocket connection failed');
  process.exitCode = 1;
  ws.terminate();
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    console.log(JSON.stringify({ type: 'audio', bytes: data.length, elapsedMs: Date.now() - started }));
    clearTimeout(timer);
    ws.close();
    return;
  }
  const message = JSON.parse(data.toString('utf8'));
  if (!['hello', 'assistant-delta'].includes(message.type)) console.log(JSON.stringify({ type: message.type, elapsedMs: Date.now() - started }));
  if (message.type === 'error') {
    clearTimeout(timer);
    process.exit(1);
  }
});

'use strict';

const WebSocket = require('ws');

const prompt = process.argv.slice(2).join(' ') || '我终于忙完了，想听你安慰我一句。';
const startedAt = Date.now();
let receivedFinal = false;
const ws = new WebSocket('ws://127.0.0.1:17860/ws', { origin: 'http://127.0.0.1:17860' });
const timer = setTimeout(() => {
  console.error('timeout');
  process.exit(1);
}, 180000);

ws.on('open', () => ws.send(JSON.stringify({ type: 'text', text: prompt })));
ws.on('error', () => {
  clearTimeout(timer);
  console.error('Local companion WebSocket connection failed');
  process.exitCode = 1;
  ws.terminate();
});
ws.on('message', (data, isBinary) => {
  if (isBinary) {
    console.log(JSON.stringify({ type: 'audio', bytes: data.length, elapsedMs: Date.now() - startedAt }));
    clearTimeout(timer);
    ws.close();
    return;
  }
  const message = JSON.parse(data.toString('utf8'));
  if (['hello', 'assistant-delta'].includes(message.type)) return;
  console.log(JSON.stringify({ type: message.type, elapsedMs: Date.now() - startedAt }));
  if (message.type === 'assistant-final') receivedFinal = true;
  if (message.type === 'error') process.exitCode = 1;
  if (message.type === 'error' || (message.type === 'state' && message.value === 'idle' && receivedFinal)) {
    clearTimeout(timer);
    ws.close();
  }
});

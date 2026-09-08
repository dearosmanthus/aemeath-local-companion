// Keep fractional frame time across rAF callbacks (e.g. 60 FPS on 75/90 Hz).
// Discard missed deadlines after a real stall, never render a burst to catch up.
export class FramePacer {
  reset() { this.nextAt = null; }
  due(now, interval) {
    if (this.nextAt == null || now - this.nextAt > interval * 2) this.nextAt = now;
    if (now + .75 < this.nextAt) return false;
    this.nextAt += interval;
    return true;
  }
}

// Time real rendered frames, not clamped animation dt or GPU submission time.
// Short startup stalls are excluded; a sustained slow window lowers resolution.
export class RenderPerformance {
  constructor() {
    this.pressure = 0;
    this.reset();
  }

  reset() {
    this.started = 0;
    this.frames = 0;
    this.totalMs = 0;
    this.totalCpuMs = 0;
    this.slowWindows = 0;
    this.goodWindows = 0;
    this.lastChange = -Infinity;
  }

  sample({ now, frameMs, cpuMs, interval }) {
    if (![now, frameMs, cpuMs, interval].every(Number.isFinite) || frameMs <= 0 || interval <= 0) return null;
    if (!this.started) { this.started = now; return null; }
    this.frames++;
    this.totalMs += frameMs;
    this.totalCpuMs += Math.max(0, cpuMs);
    if (now - this.started < 2000) return null;
    const average = this.totalMs / this.frames;
    const cpu = this.totalCpuMs / this.frames;
    const slow = average > interval * 1.28 || cpu > interval * .72;
    const good = average < interval * 1.12 && cpu < interval * .42;
    this.slowWindows = slow ? this.slowWindows + 1 : 0;
    this.goodWindows = good ? this.goodWindows + 1 : 0;
    const previous = this.pressure;
    if (this.slowWindows >= 2 && now - this.lastChange >= 4000) {
      this.pressure = Math.min(3, this.pressure + 1);
      this.slowWindows = this.goodWindows = 0;
    } else if (this.goodWindows >= 6 && now - this.lastChange >= 16000) {
      this.pressure = Math.max(0, this.pressure - 1);
      this.slowWindows = this.goodWindows = 0;
    }
    if (previous !== this.pressure) this.lastChange = now;
    this.started = now;
    this.frames = this.totalMs = this.totalCpuMs = 0;
    return { fps: Math.round(10000 / average) / 10, frameMs: Math.round(average * 10) / 10,
      cpuFrameMs: Math.round(cpu * 100) / 100, pressure: this.pressure, changed: previous !== this.pressure };
  }
}

export function conversationBusy(state) {
  return ['listening', 'transcribing', 'thinking', 'replying', 'speaking'].includes(state);
}

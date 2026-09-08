import assert from 'node:assert/strict';
import { RenderPerformance, FramePacer, conversationBusy } from '../wallpaper/render-performance.mjs';

for (const hz of [60, 75, 90, 120, 144, 165]) {
  for (const fps of [24, 30, 60]) {
    const pacer = new FramePacer();
    const observer = new RenderPerformance();
    let count = 0, last = 0;
    for (let time = 1000; time < 31000; time += 1000 / hz) {
      if (!pacer.due(time, 1000 / fps)) continue;
      count++;
      if (last) observer.sample({ now: time, frameMs: time - last, cpuMs: 1, interval: 1000 / fps });
      last = time;
    }
    assert.ok(Math.abs(count / 30 - fps) < .1, `${fps} FPS retains fractional pacing on a ${hz} Hz display`);
    assert.equal(observer.pressure, 0, 'refresh-rate quantization is not mistaken for GPU pressure');
  }
}
const resumedPacer = new FramePacer();
assert.equal(resumedPacer.due(1000, 1000 / 30), true);
assert.equal(resumedPacer.due(61000, 1000 / 30), true);
assert.equal(resumedPacer.due(61001, 1000 / 30), false, 'long stall does not create a catch-up burst');

const monitor = new RenderPerformance();
let now = 1000;
function run(seconds, frameMs, cpuMs, interval) {
  const reports = [];
  for (let elapsed = 0; elapsed < seconds * 1000; elapsed += frameMs) {
    now += frameMs;
    const report = monitor.sample({ now, frameMs, cpuMs, interval });
    if (report) reports.push(report);
  }
  return reports;
}
run(3, 16.67, 4, 1000 / 60);
assert.equal(monitor.pressure, 0, 'healthy 60 FPS stays crisp');
run(2, 70, 5, 1000 / 60);
assert.equal(monitor.pressure, 0, 'one slow window does not flip quality');
const slowReports = run(6, 70, 5, 1000 / 60);
assert.ok(monitor.pressure >= 1, 'sustained missed frames reduce load even when CPU submission is short');
assert.ok(slowReports.some(report => report.frameMs === 70 && report.fps === 14.3), 'reports real frame gaps without the 50 ms animation clamp');
const reduced = monitor.pressure;
run(8, 33.34, 5, 1000 / 30);
assert.equal(monitor.pressure, reduced, 'recovery is conservative and cannot oscillate every few seconds');
run(12, 33.34, 5, 1000 / 30);
assert.ok(monitor.pressure < reduced, 'sustained spare capacity probes a higher tier');
monitor.pressure = 3;
run(30, 120, 80, 1000 / 24);
assert.equal(monitor.pressure, 3, 'minimum detail is bounded');
monitor.reset();
assert.equal(monitor.sample({ now: now + 60000, frameMs: 60000, cpuMs: 0, interval: 33 }), null, 'visibility reset excludes background gap');
assert.equal(monitor.sample({ now: NaN, frameMs: 16, cpuMs: 1, interval: 16 }), null);
assert.equal(conversationBusy('replying'), true);
assert.equal(conversationBusy('speaking'), true);
assert.equal(conversationBusy('listening'), true);
assert.equal(conversationBusy('idle'), false);
console.log('Render performance: actual FPS, sustained overload, hysteresis, recovery, background resume and conversation priority passed.');

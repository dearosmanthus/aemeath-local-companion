import assert from 'node:assert/strict';
import { VIEW_STORAGE_KEY, normalizeView, readView, saveView, framingTarget, settleView, renderBudget } from '../wallpaper/avatar-view.mjs';

assert.deepEqual(normalizeView(null), { framing: 'portrait', quality: 'balanced', appearance: 'soft' });
assert.deepEqual(normalizeView({ framing: 'invalid', quality: 'invalid' }), normalizeView(null));
const storage = { value: null, getItem(key) { assert.equal(key, VIEW_STORAGE_KEY); return this.value; }, setItem(key, value) { assert.equal(key, VIEW_STORAGE_KEY); this.value = value; } };
saveView(storage, { framing: 'full', quality: 'high', appearance: 'original', unrelated: 'must not persist' });
assert.deepEqual(readView(storage), { framing: 'full', quality: 'high', appearance: 'original' });
assert.equal(storage.value.includes('unrelated'), false);
storage.value = '{invalid';
assert.deepEqual(readView(storage), normalizeView(null));
const denied = { getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } };
assert.deepEqual(readView(denied), normalizeView(null));
assert.doesNotThrow(() => saveView(denied, {}));

const portrait = framingTarget(16 / 9, 'portrait');
const full = framingTarget(16 / 9, 'full');
assert.ok(full.viewHeight > portrait.viewHeight);
assert.ok(.5 - (1.72 - portrait.targetY) / portrait.viewHeight > .04, 'portrait retains crown clearance');
assert.ok(portrait.targetY - portrait.viewHeight / 2 > .7, 'portrait emphasizes face and upper body');
const feetScreenFraction = .5 + full.targetY / full.viewHeight;
assert.ok(feetScreenFraction < .86, 'full view keeps feet above the subtitle strip');
assert.ok(.5 - (1.72 - full.targetY) / full.viewHeight > 0, 'full view keeps the head inside the viewport');
assert.ok(framingTarget(.5, 'portrait').viewHeight * .5 >= 1.72 * .44, 'narrow portrait retains shoulder space');
assert.ok(framingTarget(.635, 'portrait').viewHeight < framingTarget(.635, 'full').viewHeight * .65, 'portrait still emphasizes the upper body in a narrow panel');
const moving = { ...portrait };
settleView(moving, full, 1 / 60);
assert.ok(moving.viewHeight > portrait.viewHeight && moving.viewHeight < full.viewHeight, 'switch eases instead of jumping');
for (let i = 0; i < 90; i++) settleView(moving, full, 1 / 60);
assert.ok(Math.abs(moving.viewHeight - full.viewHeight) < .001);
settleView(moving, portrait, 0, true);
assert.deepEqual(moving, portrait, 'reduced motion uses an immediate stable frame');
for (const aspect of [0, NaN, Infinity, -1]) assert.ok(Object.values(framingTarget(aspect, 'full')).every(Number.isFinite));
for (const quality of ['balanced', 'high']) {
  for (const [width, height, dpr] of [[1280, 720, 2], [3840, 2160, 3], [7680, 4320, 2]]) {
    const budget = renderBudget(width, height, dpr, quality);
    assert.ok(width * height * budget.pixelRatio ** 2 <= budget.maxPixels + 1, 'large displays respect the render-target budget');
    assert.ok(budget.pixelRatio > 0 && budget.pixelRatio <= (quality === 'high' ? 2 : 1));
  }
}
assert.equal(renderBudget(1280, 720, 2, 'high').pixelRatio, 1.5);
assert.equal(renderBudget(1280, 720, 1, 'high').pixelRatio, 1, 'standard-DPI screens do not spend GPU time on forced supersampling');
assert.equal(renderBudget(1280, 720, 2, 'balanced').pixelRatio, 1);
for (const quality of ['balanced', 'high']) {
  const normal = renderBudget(1920, 1080, 2, quality);
  const busy = renderBudget(1920, 1080, 2, quality, { busy: true });
  assert.ok(busy.pixelRatio <= normal.pixelRatio, 'conversation priority never raises GPU work');
  assert.ok(busy.frameInterval >= 1000 / 30);
  let previous = normal;
  for (const pressure of [1, 2, 3]) {
    const current = renderBudget(1920, 1080, 2, quality, { pressure });
    assert.ok(current.pixelRatio < previous.pixelRatio, 'each sustained-pressure tier reduces rendered pixels');
    assert.ok(current.frameInterval >= previous.frameInterval);
    previous = current;
  }
}
for (const invalid of [0, -1, NaN, Infinity]) assert.ok(Object.values(renderBudget(invalid, invalid, invalid, 'high')).every(Number.isFinite));
console.log('Avatar view: preferences, framing, transitions, reduced motion and high-DPI pixel budgets passed.');

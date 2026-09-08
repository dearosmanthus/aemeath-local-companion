// Display preferences and framing only. No model or conversation data is stored.
export const VIEW_STORAGE_KEY = 'aemeath-avatar-view-v1';

export function normalizeView(value) {
  return {
    framing: value?.framing === 'full' ? 'full' : 'portrait',
    quality: value?.quality === 'high' ? 'high' : 'balanced',
    appearance: value?.appearance === 'original' ? 'original' : 'soft',
  };
}

export function readView(storage) {
  try { return normalizeView(JSON.parse(storage.getItem(VIEW_STORAGE_KEY))); }
  catch { return normalizeView(null); }
}

export function saveView(storage, value) {
  try { storage.setItem(VIEW_STORAGE_KEY, JSON.stringify(normalizeView(value))); }
  catch { /* A denied/full local storage must not break the stage. */ }
}

export function framingTarget(aspect, framing, modelHeight = 1.72) {
  aspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const full = framing === 'full';
  const narrow = aspect < 1;
  // Full view reserves space for the subtitle strip below the feet.
  const viewHeight = Math.max(modelHeight * (full ? 1.28 : .62), narrow ? modelHeight * (full ? .75 : .44) / aspect : 0);
  return {
    viewHeight,
    targetY: modelHeight * (full ? .44 : .755),
    offsetX: viewHeight * aspect * (narrow ? .04 : .20),
  };
}

// Limit render-target size while retaining crisp faces on high-DPI displays.
// This controls raster resolution, not the size of model/voice GPU allocations.
export function renderBudget(width, height, deviceRatio, quality, { busy = false, pressure = 0 } = {}) {
  width = Number.isFinite(width) && width > 0 ? width : 1;
  height = Number.isFinite(height) && height > 0 ? height : 1;
  deviceRatio = Number.isFinite(deviceRatio) && deviceRatio > 0 ? deviceRatio : 1;
  const high = quality === 'high';
  const level = Math.max(0, Math.min(3, Math.floor(Number(pressure) || 0)));
  // Native resolution on standard-DPI screens: supersampling needlessly
  // competes with local speech synthesis. Preserve materials at every tier.
  const basePixels = high ? 2073600 : 1000000;
  const maxPixels = (busy ? Math.min(1200000, basePixels) : basePixels) * [1, .72, .52, .38][level];
  const preferredRatio = high && !busy ? Math.min(1.5, deviceRatio) : Math.min(1, deviceRatio);
  return {
    pixelRatio: Math.min(preferredRatio, Math.sqrt(maxPixels / (width * height))),
    frameInterval: 1000 / (level === 3 ? 24 : high && !busy && level === 0 ? 60 : 30),
    maxPixels,
  };
}

export function settleView(current, target, dt, snap = false) {
  const amount = snap ? 1 : 1 - Math.exp(-Math.max(0, Math.min(.1, Number(dt) || 0)) * 7);
  for (const key of ['viewHeight', 'targetY', 'offsetX']) {
    current[key] += (target[key] - current[key]) * amount;
    if (Math.abs(target[key] - current[key]) < .0001) current[key] = target[key];
  }
  return current;
}

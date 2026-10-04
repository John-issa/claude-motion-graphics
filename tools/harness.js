// Headless-friendly scene harness. scripts/snap.mjs and scripts/render.mjs
// drive these window functions through Playwright; they also work from the
// browser console when the dev server is running.

import scenes from '../src/scenes/index.js';
import { createReel } from '../src/engine/index.js';

const reel = createReel({ scenes, fps: 60 });
window.__reel = reel;
window.__ready = reel.init().then(() => {
  const view = document.getElementById('view');
  if (view) reel.render(view.getContext('2d'), 1);
  return { duration: reel.duration, fps: reel.fps, scenes: reel.meta.scenes, webgl: reel.gl.available };
});

const canvases = new Map();
function canvasOf(width) {
  const w = Math.round(width);
  const h = Math.round((w * 9) / 16);
  let c = canvases.get(w);
  if (!c) {
    c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    canvases.set(w, c);
  }
  return c;
}

function draw(canvas, { scene, t, reel: whole = false, motionBlur = 0 }) {
  const ctx = canvas.getContext('2d');
  if (whole || scene == null) reel.render(ctx, t, { motionBlur });
  else reel.renderScene(ctx, scene, t, { motionBlur });
}

/** Apply params / seed before rendering. */
window.__configure = ({ params, seed } = {}) => {
  if (params) reel.setParams(params);
  if (seed != null) reel.setSeed(seed);
  return { params: reel.params, seed: reel.seed };
};

/** One frame as a data URL. */
window.__frame = ({ scene, t = 0, width = 1280, reel: whole, motionBlur = 0, type = 'image/png', quality = 0.92 } = {}) => {
  const c = canvasOf(width);
  draw(c, { scene, t, reel: whole, motionBlur });
  return c.toDataURL(type, quality);
};

/** A labelled contact sheet of several instants as a PNG data URL. */
window.__sheet = ({ scene, times, width = 480, cols = 4, reel: whole = false, motionBlur = 0 } = {}) => {
  const frame = canvasOf(width);
  const h = frame.height;
  const pad = 10;
  const labelH = 24;
  const rows = Math.ceil(times.length / cols);
  const sheet = document.createElement('canvas');
  sheet.width = cols * (width + pad) + pad;
  sheet.height = rows * (h + labelH + pad) + pad;
  const sc = sheet.getContext('2d');
  sc.fillStyle = '#1b1c22';
  sc.fillRect(0, 0, sheet.width, sheet.height);
  times.forEach((t, i) => {
    draw(frame, { scene, t, reel: whole, motionBlur });
    const x = pad + (i % cols) * (width + pad);
    const y = pad + Math.floor(i / cols) * (h + labelH + pad);
    sc.drawImage(frame, x, y + labelH);
    sc.fillStyle = '#e8e6e0';
    sc.font = '600 13px "Martian Mono", monospace';
    sc.textBaseline = 'middle';
    const label = whole ? `${t.toFixed(2)}s  ${reel.sceneAt(t).scene.id}` : `${scene}  t=${t.toFixed(2)}s`;
    sc.fillText(label, x, y + labelH / 2);
  });
  return sheet.toDataURL('image/png');
};

/** Render timing, flushing the canvas each frame so raster cost is included. */
window.__bench = ({ scene, width = 1280, frames = 60, from = 0, to } = {}) => {
  const c = canvasOf(width);
  const ctx = c.getContext('2d', { willReadFrequently: false });
  const entry = scene == null ? null : reel.meta.scenes.find((s) => s.id === scene);
  const end = to ?? (entry ? entry.duration : reel.duration);
  const times = [];
  for (let i = 0; i < frames; i++) {
    const t = from + ((end - from) * i) / Math.max(1, frames - 1);
    const t0 = performance.now();
    draw(c, { scene, t, reel: scene == null });
    ctx.getImageData(0, 0, 1, 1);
    times.push(performance.now() - t0);
  }
  const sorted = [...times].sort((a, b) => a - b);
  const q = (x) => sorted[Math.min(sorted.length - 1, Math.floor(x * sorted.length))];
  return { width, frames, min: sorted[0], p25: q(0.25), median: q(0.5), p95: q(0.95), max: sorted[sorted.length - 1], mean: times.reduce((a, b) => a + b, 0) / times.length };
};

function frameHash(canvas) {
  const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let h = 0x811c9dc5;
  for (let i = 0; i < d.length; i += 3) {
    h ^= d[i];
    h = Math.imul(h, 0x01000193);
  }
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    sum += l;
    sumSq += l * l;
  }
  const n = d.length / 4;
  const mean = sum / n;
  return { hash: h >>> 0, mean, std: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

/**
 * Determinism and hygiene audit for one scene:
 * - pass 1 renders each sample time on a fresh canvas;
 * - pass 2 renders them in shuffled order, each on a canvas that has just
 *   drawn a different instant of the scene, and compares pixels exactly;
 * - counts Math.random / Date.now / performance.now calls made during render;
 * - flags near-blank frames.
 * Every canvas is an ordinary one, read back exactly once, as in the player
 * and the exporter. (Pinning a canvas to CPU raster with willReadFrequently,
 * or reading the same canvas repeatedly, lets Chrome switch raster paths
 * mid-run when scenes draw GPU-backed caches, which looks like
 * nondeterminism but isn't.)
 */
window.__audit = ({ scene, samples = 16, width = 640 } = {}) => {
  const entry = reel.meta.scenes.find((s) => s.id === scene);
  if (!entry) throw new Error(`No scene ${scene}`);
  const height = Math.round((width * 9) / 16);
  const fresh = () => {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  };
  const times = Array.from({ length: samples }, (_, i) => (entry.duration * i) / (samples - 1));

  const calls = { random: 0, dateNow: 0, perfNow: 0 };
  const orig = { random: Math.random, dateNow: Date.now, perfNow: performance.now.bind(performance) };
  const renderAt = (c, t) => {
    Math.random = () => {
      calls.random++;
      return orig.random();
    };
    Date.now = () => {
      calls.dateNow++;
      return orig.dateNow();
    };
    performance.now = () => {
      calls.perfNow++;
      return orig.perfNow();
    };
    try {
      reel.renderScene(c.getContext('2d'), scene, t);
    } finally {
      Math.random = orig.random;
      Date.now = orig.dateNow;
      performance.now = orig.perfNow;
    }
  };

  const first = times.map((t) => {
    const c = fresh();
    renderAt(c, t);
    return frameHash(c);
  });
  const order = times.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = (i * 7919 + 13) % (i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  const mismatches = [];
  for (const i of order) {
    const c = fresh();
    renderAt(c, times[(i + Math.floor(samples / 2)) % samples]);
    renderAt(c, times[i]);
    if (frameHash(c).hash !== first[i].hash) mismatches.push(Number(times[i].toFixed(3)));
  }
  mismatches.sort((a, b) => a - b);
  const blank = first.map((f, i) => ({ t: Number(times[i].toFixed(3)), std: f.std })).filter((f) => f.std < 2);
  return {
    scene,
    deterministic: mismatches.length === 0,
    mismatchedTimes: mismatches,
    forbiddenCalls: calls,
    nearBlankFrames: blank,
    brightness: first.map((f) => Math.round(f.mean)),
  };
};

// Canvas 2D drawing helpers. Browser-only functions touch the DOM lazily, so
// this module can still be imported in Node for tests.

import { parse } from './color.js';

/** A 2D-capable canvas of the given pixel size (DOM canvas when available). */
export function makeCanvas(w, h) {
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  }
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  throw new Error('makeCanvas needs a browser environment');
}

/** Rounded-rectangle path (call beginPath first, then fill or stroke). */
export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Fill the whole frame. */
export function fillFrame(ctx, color, W = 1920, H = 1080) {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, W, H);
}

export function linearGradient(ctx, x0, y0, x1, y1, stops) {
  const g = ctx.createLinearGradient(x0, y0, x1, y1);
  stops.forEach(([at, color]) => g.addColorStop(at, color));
  return g;
}

export function radialGradient(ctx, x, y, r0, r1, stops) {
  const g = ctx.createRadialGradient(x, y, r0, x, y, r1);
  stops.forEach(([at, color]) => g.addColorStop(at, color));
  return g;
}

const sprites = new Map();

/**
 * Cached soft glow sprite for particles: draw with
 * ctx.drawImage(sprite, x - r, y - r, 2r, 2r), ideally under 'lighter'.
 */
export function glowSprite(color, size = 64, { core = 0.12, falloff = 1.6 } = {}) {
  const key = `glow|${color}|${size}|${core}|${falloff}`;
  let s = sprites.get(key);
  if (s) return s;
  s = makeCanvas(size, size);
  const g = s.getContext('2d');
  const [r, gr, b] = parse(color);
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (let i = 0; i <= 8; i++) {
    const at = i / 8;
    const a = at <= core ? 1 : Math.pow(1 - (at - core) / (1 - core), falloff);
    grad.addColorStop(at, `rgba(${r},${gr},${b},${a})`);
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  sprites.set(key, s);
  return s;
}

/** Cached antialiased disc sprite; faster than arc() for thousands of dots. */
export function dotSprite(color, size = 32) {
  const key = `dot|${color}|${size}`;
  let s = sprites.get(key);
  if (s) return s;
  s = makeCanvas(size, size);
  const g = s.getContext('2d');
  g.fillStyle = color;
  g.beginPath();
  g.arc(size / 2, size / 2, size / 2 - 0.5, 0, Math.PI * 2);
  g.fill();
  sprites.set(key, s);
  return s;
}

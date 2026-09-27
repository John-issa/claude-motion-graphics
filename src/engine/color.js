// Colour helpers. Colours are hex strings ('#ff3b1f' or '#f31') or [r, g, b]
// arrays with 0-255 channels. Outputs are CSS strings ready for fillStyle.

import { clamp01, TAU } from './math.js';

const cache = new Map();

/** '#rrggbb' | '#rgb' | [r, g, b] → [r, g, b] */
export function parse(c) {
  if (Array.isArray(c)) return c;
  let v = cache.get(c);
  if (v) return v;
  let h = c.charAt(0) === '#' ? c.slice(1) : c;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  v = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  cache.set(c, v);
  return v;
}

export const rgb = (r, g, b) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;

/** Colour with alpha: rgba('#ff3b1f', 0.5) */
export function rgba(c, a = 1) {
  const [r, g, b] = parse(c);
  return `rgba(${r},${g},${b},${a})`;
}

/** Linear blend of two colours as [r, g, b]. */
export function mixRGB(c1, c2, t) {
  const a = parse(c1);
  const b = parse(c2);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Linear blend of two colours as a CSS string. */
export function mix(c1, c2, t, alpha = 1) {
  const [r, g, b] = mixRGB(c1, c2, t);
  return alpha >= 1 ? rgb(r, g, b) : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

/** Gradient through several stops: const heat = ramp(['#111', '#f31', '#fd4']); heat(0.4) */
export function ramp(stops) {
  const cols = stops.map(parse);
  const last = cols.length - 1;
  return (t, alpha = 1) => {
    const x = clamp01(t) * last;
    const i = Math.min(Math.floor(x), last - 1);
    const f = x - i;
    const a = cols[i];
    const b = cols[i + 1] ?? a;
    const r = a[0] + (b[0] - a[0]) * f;
    const g = a[1] + (b[1] - a[1]) * f;
    const bl = a[2] + (b[2] - a[2]) * f;
    return alpha >= 1
      ? rgb(r, g, bl)
      : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bl)},${alpha})`;
  };
}

export const hsl = (h, s, l, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;

/**
 * Cosine palette (Inigo Quilez): colour(t) = a + b·cos(2π(c·t + d)),
 * each argument an [r, g, b] triple in 0..1.
 */
export function cosine(t, a, b, c, d, alpha = 1) {
  const ch = (k) => 255 * clamp01(a[k] + b[k] * Math.cos(TAU * (c[k] * t + d[k])));
  const r = ch(0);
  const g = ch(1);
  const bl = ch(2);
  return alpha >= 1
    ? rgb(r, g, bl)
    : `rgba(${Math.round(r)},${Math.round(g)},${Math.round(bl)},${alpha})`;
}

export const toHex = (c) =>
  '#' + parse(c).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** WCAG relative luminance, 0..1. */
export function luminance(c) {
  const lin = parse(c).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

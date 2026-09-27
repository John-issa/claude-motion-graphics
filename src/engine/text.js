// Typography for canvas: font strings, kerning-aware per-glyph layout, fitting,
// and sampling text into point clouds for particle work.

import { fonts } from './theme.js';
import { createRandom } from './random.js';
import { makeCanvas } from './draw.js';

const FALLBACK = { display: 'sans-serif', serif: 'serif', mono: 'monospace', sans: 'sans-serif' };

/**
 * Canvas font shorthand. `family` is a key of theme.fonts ('display', 'serif',
 * 'mono', 'sans') or any CSS family list. Weights are continuous because
 * every bundled font is variable: font(160, 'display', 640).
 */
export function font(size, family = 'display', weight = 700, style = 'normal') {
  const fam = fonts[family] ? `"${fonts[family]}", ${FALLBACK[family]}` : family;
  const w = Math.max(1, Math.min(1000, Math.round(weight)));
  return `${style === 'italic' ? 'italic ' : ''}${w} ${Math.round(size * 100) / 100}px ${fam}`;
}

/** Resolve once the bundled fonts are ready to draw with. */
export async function loadFonts() {
  if (typeof document === 'undefined' || !document.fonts) return;
  const specs = [
    `400 40px "${fonts.display}"`,
    `900 40px "${fonts.display}"`,
    `400 40px "${fonts.serif}"`,
    `italic 400 40px "${fonts.serif}"`,
    `400 40px "${fonts.mono}"`,
    `400 40px "${fonts.sans}"`,
  ];
  await Promise.all(specs.map((s) => document.fonts.load(s).catch(() => null)));
  await document.fonts.ready;
}

const layouts = new Map();

/**
 * Lay out a single line glyph by glyph. Each glyph's x comes from measuring the
 * prefix up to it, so the font's kerning survives when glyphs are animated
 * individually. `tracking` adds extra space between glyphs (design px).
 *
 * Returns { glyphs: [{ ch, i, x, w }], width, ascent, descent }, with x
 * measured from the left edge of the line. Draw each glyph with
 * textAlign = 'left' at (left + g.x, baseline).
 */
export function layoutGlyphs(ctx, text, fontStr, tracking = 0) {
  const key = `${fontStr}|${tracking}|${text}`;
  let L = layouts.get(key);
  if (L) return L;
  ctx.save();
  ctx.font = fontStr;
  const chars = Array.from(text);
  const glyphs = [];
  let prev = 0;
  let acc = '';
  for (let i = 0; i < chars.length; i++) {
    acc += chars[i];
    const w = ctx.measureText(acc).width;
    glyphs.push({ ch: chars[i], i, x: prev + i * tracking, w: w - prev });
    prev = w;
  }
  const m = ctx.measureText(text || ' ');
  ctx.restore();
  L = {
    glyphs,
    width: prev + Math.max(0, chars.length - 1) * tracking,
    ascent: m.actualBoundingBoxAscent,
    descent: m.actualBoundingBoxDescent,
  };
  if (layouts.size > 800) layouts.clear();
  layouts.set(key, L);
  return L;
}

/** Width of a line of text in design px (cached). */
export const measure = (ctx, text, fontStr, tracking = 0) => layoutGlyphs(ctx, text, fontStr, tracking).width;

/**
 * Largest font size (≤ maxSize) at which `text` fits in maxWidth.
 * `tracking` is given as a fraction of the font size (e.g. 0.02).
 */
export function fitSize(ctx, text, maxWidth, { family = 'display', weight = 700, style = 'normal', maxSize = 400, tracking = 0 } = {}) {
  const probe = 100;
  const w = measure(ctx, text, font(probe, family, weight, style), tracking * probe);
  if (w <= 0) return maxSize;
  return Math.min(maxSize, (probe * maxWidth) / w);
}

/**
 * Split text into at most `maxLines` lines, breaking at spaces, so the longest
 * line is as short as possible. Handy for user-supplied titles.
 */
export function balanceLines(text, maxLines = 2) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1 || maxLines <= 1) return [words.join(' ')];
  let best = [words.join(' ')];
  let bestLen = best[0].length;
  const n = words.length;
  // Two-line split is the common case; try every break point.
  if (maxLines >= 2) {
    for (let k = 1; k < n; k++) {
      const a = words.slice(0, k).join(' ');
      const b = words.slice(k).join(' ');
      const len = Math.max(a.length, b.length);
      if (len < bestLen) {
        best = [a, b];
        bestLen = len;
      }
    }
  }
  if (maxLines >= 3 && n >= 3) {
    for (let i = 1; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const lines = [words.slice(0, i), words.slice(i, j), words.slice(j)].map((w) => w.join(' '));
        const len = Math.max(...lines.map((l) => l.length));
        if (len < bestLen) {
          best = lines;
          bestLen = len;
        }
      }
    }
  }
  return best;
}

const pointClouds = new Map();

/**
 * Sample `count` points inside rendered text, in design coordinates.
 * Returns a Float32Array [x0, y0, x1, y1, ...] in random (seeded) order.
 * `text` may contain '\n' for multiple lines, spaced by `leading` px.
 * Cached, so call it from setup() and reuse the result every frame.
 */
export function textPoints(text, {
  font: fontStr,
  count = 3000,
  x = 960,
  y = 540,
  align = 'center',
  leading = 0,
  seed = 1,
  width = 1920,
  height = 1080,
  resolution = 0.5,
} = {}) {
  const key = [text, fontStr, count, x, y, align, leading, seed, width, height, resolution].join('|');
  const hit = pointClouds.get(key);
  if (hit) return hit;
  const cw = Math.ceil(width * resolution);
  const ch = Math.ceil(height * resolution);
  const canvas = makeCanvas(cw, ch);
  const c = canvas.getContext('2d', { willReadFrequently: true });
  c.scale(resolution, resolution);
  c.font = fontStr;
  c.textAlign = align;
  c.textBaseline = 'middle';
  c.fillStyle = '#fff';
  const lines = String(text).split('\n');
  lines.forEach((ln, k) => c.fillText(ln, x, y + (k - (lines.length - 1) / 2) * leading));
  const data = c.getImageData(0, 0, cw, ch).data;
  const filled = [];
  for (let py = 0; py < ch; py++) {
    for (let px = 0; px < cw; px++) {
      if (data[(py * cw + px) * 4 + 3] > 127) filled.push(px, py);
    }
  }
  const rnd = createRandom(seed);
  const out = new Float32Array(count * 2);
  const n = filled.length / 2;
  if (n === 0) {
    for (let k = 0; k < count; k++) {
      out[k * 2] = x;
      out[k * 2 + 1] = y;
    }
  } else {
    const idx = new Uint32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd.next() * (i + 1));
      const tmp = idx[i];
      idx[i] = idx[j];
      idx[j] = tmp;
    }
    for (let k = 0; k < count; k++) {
      const p = idx[k % n];
      out[k * 2] = (filled[p * 2] + rnd.next()) / resolution;
      out[k * 2 + 1] = (filled[p * 2 + 1] + rnd.next()) / resolution;
    }
  }
  if (pointClouds.size > 32) pointClouds.clear();
  pointClouds.set(key, out);
  return out;
}

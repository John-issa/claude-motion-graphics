// Point-list geometry for vector motion: generating outlines, resampling them
// to equal point counts, morphing between them, and drawing partial strokes.
// Point lists are flat arrays [x0, y0, x1, y1, ...].

import { TAU } from './math.js';

export function polylineLength(pts, closed = true) {
  const m = pts.length / 2;
  let len = 0;
  const segs = closed ? m : m - 1;
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m;
    len += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  return len;
}

/** Resample a polyline to exactly n points spaced evenly along its length. */
export function resample(pts, n, closed = true) {
  const m = pts.length / 2;
  const segs = closed ? m : m - 1;
  const cum = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m;
    cum[i + 1] = cum[i] + Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  const total = cum[segs];
  const out = new Float32Array(n * 2);
  let s = 0;
  for (let k = 0; k < n; k++) {
    const d = closed ? (k / n) * total : (k / Math.max(1, n - 1)) * total;
    while (s < segs - 1 && cum[s + 1] < d) s++;
    const len = cum[s + 1] - cum[s];
    const f = len > 0 ? (d - cum[s]) / len : 0;
    const a = s;
    const b = (s + 1) % m;
    out[k * 2] = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * f;
    out[k * 2 + 1] = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * f;
  }
  return out;
}

/** n points around a circle, starting at `rot` (default: 12 o'clock). */
export function circle(n, cx, cy, r, rot = -Math.PI / 2) {
  const out = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const a = rot + (k / n) * TAU;
    out[k * 2] = cx + Math.cos(a) * r;
    out[k * 2 + 1] = cy + Math.sin(a) * r;
  }
  return out;
}

/** Regular polygon outline resampled to n points (vertex at 12 o'clock). */
export function polygon(sides, n, cx, cy, r, rot = -Math.PI / 2) {
  const v = [];
  for (let k = 0; k < sides; k++) {
    const a = rot + (k / sides) * TAU;
    v.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return resample(v, n, true);
}

/** Star outline with `tips` points, resampled to n points. */
export function star(tips, n, cx, cy, rOuter, rInner, rot = -Math.PI / 2) {
  const v = [];
  for (let k = 0; k < tips * 2; k++) {
    const a = rot + (k / (tips * 2)) * TAU;
    const r = k % 2 === 0 ? rOuter : rInner;
    v.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return resample(v, n, true);
}

/** Axis-aligned rectangle outline starting at top-centre, resampled to n. */
export function rect(n, cx, cy, w, h) {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  return resample([cx, y0, x1, y0, x1, y1, x0, y1, x0, y0], n, true);
}

/** Superellipse |x/a|^e + |y/b|^e = 1 (e=2 ellipse, e≈4 squircle). */
export function superellipse(n, cx, cy, a, b, e = 4, rot = -Math.PI / 2) {
  const out = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) {
    const t = rot + (k / n) * TAU;
    const c = Math.cos(t);
    const s = Math.sin(t);
    out[k * 2] = cx + a * Math.sign(c) * Math.pow(Math.abs(c), 2 / e);
    out[k * 2 + 1] = cy + b * Math.sign(s) * Math.pow(Math.abs(s), 2 / e);
  }
  return out;
}

/** Interpolate two equal-length point lists. */
export function lerpPoints(a, b, t, out = new Float32Array(a.length)) {
  for (let i = 0; i < a.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
  return out;
}

/**
 * Rotate the starting index of closed outline b to best match a, which stops
 * morphs from twisting. Returns a new list.
 */
export function alignStart(a, b) {
  const n = a.length / 2;
  const stride = Math.max(1, Math.floor(n / 64));
  let best = 0;
  let bestErr = Infinity;
  for (let shift = 0; shift < n; shift += stride) {
    let err = 0;
    for (let i = 0; i < n; i += stride) {
      const j = (i + shift) % n;
      const dx = a[i * 2] - b[j * 2];
      const dy = a[i * 2 + 1] - b[j * 2 + 1];
      err += dx * dx + dy * dy;
    }
    if (err < bestErr) {
      bestErr = err;
      best = shift;
    }
  }
  const out = new Float32Array(b.length);
  for (let i = 0; i < n; i++) {
    const j = (i + best) % n;
    out[i * 2] = b[j * 2];
    out[i * 2 + 1] = b[j * 2 + 1];
  }
  return out;
}

/** Add a polyline to the current path. */
export function tracePath(ctx, pts, closed = true) {
  const m = pts.length / 2;
  if (m === 0) return;
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 1; i < m; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
  if (closed) ctx.closePath();
}

const cumCache = new WeakMap();

function cumulative(pts, closed) {
  let entry = cumCache.get(pts);
  if (entry && entry.closed === closed) return entry;
  const m = pts.length / 2;
  const segs = closed ? m : m - 1;
  const cum = new Float64Array(segs + 1);
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % m;
    cum[i + 1] = cum[i] + Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
  }
  entry = { cum, segs, closed };
  cumCache.set(pts, entry);
  return entry;
}

function pointAtLength(pts, cum, segs, d, out) {
  let lo = 0;
  let hi = segs - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= d) lo = mid;
    else hi = mid - 1;
  }
  const m = pts.length / 2;
  const a = lo;
  const b = (lo + 1) % m;
  const len = cum[lo + 1] - cum[lo];
  const f = len > 0 ? (d - cum[lo]) / len : 0;
  out[0] = pts[a * 2] + (pts[b * 2] - pts[a * 2]) * f;
  out[1] = pts[a * 2 + 1] + (pts[b * 2 + 1] - pts[a * 2 + 1]) * f;
  return lo;
}

/**
 * Add the stretch of a polyline between arc-length fractions `from` and `to`
 * (0..1) to the current path: the "stroke draws itself on" effect.
 * Pass the same array every frame so its lengths stay cached.
 */
export function tracePartial(ctx, pts, from, to, closed = true) {
  if (to <= from) return;
  const { cum, segs } = cumulative(pts, closed);
  const total = cum[segs];
  const d0 = Math.max(0, from) * total;
  const d1 = Math.min(1, to) * total;
  const p = [0, 0];
  const m = pts.length / 2;
  const i0 = pointAtLength(pts, cum, segs, d0, p);
  ctx.moveTo(p[0], p[1]);
  let i = i0 + 1;
  while (i <= segs && cum[i] < d1) {
    const k = i % m;
    ctx.lineTo(pts[k * 2], pts[k * 2 + 1]);
    i++;
  }
  pointAtLength(pts, cum, segs, d1, p);
  ctx.lineTo(p[0], p[1]);
}

/** Point at arc-length fraction u (0..1) along a polyline. */
export function pointAt(pts, u, closed = true, out = [0, 0]) {
  const { cum, segs } = cumulative(pts, closed);
  pointAtLength(pts, cum, segs, Math.max(0, Math.min(1, u)) * cum[segs], out);
  return out;
}

/** Centroid of a point list. */
export function centroid(pts) {
  const m = pts.length / 2;
  let x = 0;
  let y = 0;
  for (let i = 0; i < m; i++) {
    x += pts[i * 2];
    y += pts[i * 2 + 1];
  }
  return [x / m, y / m];
}

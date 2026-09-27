// Time helpers for scenes. Scenes are pure functions of time, so animation is
// expressed as "where is this property at time t", never as per-frame updates.

import { clamp01, lerp } from './math.js';
import { resolveEase } from './easing.js';
import { hash } from './random.js';
import { noise1D } from './noise.js';

/** Progress of t through [start, end], clamped to 0..1. */
export const seg = (t, start, end) =>
  end <= start ? (t >= end ? 1 : 0) : clamp01((t - start) / (end - start));

/** Eased progress of t through [start, end]. */
export const eseg = (t, start, end, e = 'inOutCubic') => resolveEase(e)(seg(t, start, end));

/** Value moving from `from` to `to` across [start, end]. */
export const tween = (t, start, end, from, to, e = 'inOutCubic') =>
  lerp(from, to, resolveEase(e)(seg(t, start, end)));

/**
 * Keyframe interpolation. `keys` is a time-sorted list of [time, value, ease?]
 * where value is a number or an array of numbers, and the optional ease
 * shapes the segment that ARRIVES at that key. Holds before the first key and
 * after the last.
 *
 *   const x = kf(t, [[0, -200], [0.6, 960, 'outExpo'], [2.4, 960], [3, 2200, 'inBack']]);
 */
export function kf(t, keys, defaultEase = 'inOutCubic') {
  const n = keys.length;
  if (n === 0) return 0;
  if (t <= keys[0][0]) return keys[0][1];
  if (t >= keys[n - 1][0]) return keys[n - 1][1];
  let i = 1;
  while (i < n - 1 && keys[i][0] < t) i++;
  const [t0, v0] = keys[i - 1];
  const [t1, v1, e] = keys[i];
  const u = resolveEase(e ?? defaultEase)(t1 > t0 ? (t - t0) / (t1 - t0) : 1);
  if (typeof v0 === 'number') return v0 + (v1 - v0) * u;
  const out = new Array(v0.length);
  for (let k = 0; k < v0.length; k++) out[k] = v0[k] + (v1[k] - v0[k]) * u;
  return out;
}

/**
 * Start-time offset for item i of n. Give either `each` (seconds between
 * neighbours) or `total` (spread across all items). `from` picks where the
 * wave starts: 'start' | 'end' | 'center' | 'edges' | 'random' | an index.
 */
export function stagger(i, n, { each = 0.05, total, from = 'start', ease: e = 'linear', seed = 0 } = {}) {
  if (n <= 1) return 0;
  const last = n - 1;
  let d;
  if (from === 'start') d = i / last;
  else if (from === 'end') d = (last - i) / last;
  else if (from === 'center') d = Math.abs(i - last / 2) / (last / 2);
  else if (from === 'edges') d = 1 - Math.abs(i - last / 2) / (last / 2);
  else if (from === 'random') d = hash(i, seed);
  else d = Math.abs(i - from) / Math.max(from, last - from, 1);
  const span = total ?? each * last;
  return resolveEase(e)(clamp01(d)) * span;
}

/** Position within a repeating cycle, 0..1. */
export const cycle = (t, period, offset = 0) => {
  const x = (t - offset) / period;
  return x - Math.floor(x);
};

/**
 * Smooth deterministic jitter, like After Effects' wiggle(freq, amp).
 * Use a different `seed` per property so they don't move in lockstep.
 */
export function wiggle(t, { freq = 2, amp = 1, seed = 0, octaves = 1 } = {}) {
  let v = 0;
  let a = 1;
  let f = freq;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    v += a * noise1D(t * f, seed + o * 101);
    norm += a;
    a *= 0.5;
    f *= 2;
  }
  return (v / norm) * amp;
}

/** Envelope that rises over `attack` seconds at `at`, then decays exponentially. */
export function pulse(t, at, attack = 0.04, decay = 0.35) {
  if (t < at) return 0;
  const d = t - at;
  if (d < attack) return d / attack;
  return Math.exp(-(d - attack) / decay);
}

/** True while t is inside [start, end). */
export const during = (t, start, end) => t >= start && t < end;

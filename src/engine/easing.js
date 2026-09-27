// Easing functions: Penner's set, a CSS-compatible cubic-Bézier solver, and a
// closed-form damped spring. Every easing maps [0, 1] → [0, 1] with f(0) = 0
// and f(1) = 1 exactly; back, elastic and spring overshoot in between.

import { TAU } from './math.js';

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = TAU / 3;
const c5 = TAU / 4.5;

// Clamp the input so every easing is safe to call with raw progress values.
const def = (fn) => (x) => (x <= 0 ? 0 : x >= 1 ? 1 : fn(x));

function bounceOut(x) {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
}

export const linear = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x);

export const inQuad = def((x) => x * x);
export const outQuad = def((x) => 1 - (1 - x) * (1 - x));
export const inOutQuad = def((x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2));

export const inCubic = def((x) => x * x * x);
export const outCubic = def((x) => 1 - Math.pow(1 - x, 3));
export const inOutCubic = def((x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2));

export const inQuart = def((x) => x * x * x * x);
export const outQuart = def((x) => 1 - Math.pow(1 - x, 4));
export const inOutQuart = def((x) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2));

export const inQuint = def((x) => x * x * x * x * x);
export const outQuint = def((x) => 1 - Math.pow(1 - x, 5));
export const inOutQuint = def((x) => (x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2));

export const inSine = def((x) => 1 - Math.cos((x * Math.PI) / 2));
export const outSine = def((x) => Math.sin((x * Math.PI) / 2));
export const inOutSine = def((x) => -(Math.cos(Math.PI * x) - 1) / 2);

export const inExpo = def((x) => Math.pow(2, 10 * x - 10));
export const outExpo = def((x) => 1 - Math.pow(2, -10 * x));
export const inOutExpo = def((x) =>
  x < 0.5 ? Math.pow(2, 20 * x - 10) / 2 : (2 - Math.pow(2, -20 * x + 10)) / 2,
);

export const inCirc = def((x) => 1 - Math.sqrt(1 - x * x));
export const outCirc = def((x) => Math.sqrt(1 - Math.pow(x - 1, 2)));
export const inOutCirc = def((x) =>
  x < 0.5 ? (1 - Math.sqrt(1 - Math.pow(2 * x, 2))) / 2 : (Math.sqrt(1 - Math.pow(-2 * x + 2, 2)) + 1) / 2,
);

export const inBack = def((x) => c3 * x * x * x - c1 * x * x);
export const outBack = def((x) => 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2));
export const inOutBack = def((x) =>
  x < 0.5
    ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
    : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2,
);

export const inElastic = def((x) => -Math.pow(2, 10 * x - 10) * Math.sin((x * 10 - 10.75) * c4));
export const outElastic = def((x) => Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * c4) + 1);
export const inOutElastic = def((x) =>
  x < 0.5
    ? -(Math.pow(2, 20 * x - 10) * Math.sin((20 * x - 11.125) * c5)) / 2
    : (Math.pow(2, -20 * x + 10) * Math.sin((20 * x - 11.125) * c5)) / 2 + 1,
);

export const inBounce = def((x) => 1 - bounceOut(1 - x));
export const outBounce = def(bounceOut);
export const inOutBounce = def((x) => (x < 0.5 ? (1 - bounceOut(1 - 2 * x)) / 2 : (1 + bounceOut(2 * x - 1)) / 2));

/** Hold at 0, then jump in `n` equal steps (CSS `steps(n, end)`). */
export const steps = (n) => def((x) => Math.floor(x * n) / n);

/**
 * CSS-compatible cubic-bezier(x1, y1, x2, y2). Solves x(t) = x with
 * Newton-Raphson from a sampled initial guess, falling back to bisection
 * where the curve is too flat for Newton to converge.
 */
export function cubicBezier(x1, y1, x2, y2) {
  if (x1 === y1 && x2 === y2) return linear;
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;

  const N = 11;
  const step = 1 / (N - 1);
  const table = new Float64Array(N);
  for (let i = 0; i < N; i++) table[i] = sampleX(i * step);

  function solveT(x) {
    let i = 1;
    while (i < N - 1 && table[i] <= x) i++;
    i--;
    const span = table[i + 1] - table[i];
    let t = (i + (span > 0 ? (x - table[i]) / span : 0)) * step;
    const slope = slopeX(t);
    if (slope >= 0.001) {
      for (let k = 0; k < 8; k++) {
        const s = slopeX(t);
        if (s === 0) break;
        const err = sampleX(t) - x;
        if (Math.abs(err) < 1e-7) break;
        t -= err / s;
      }
      return t < 0 ? 0 : t > 1 ? 1 : t;
    }
    if (slope === 0) return t;
    let lo = i * step;
    let hi = lo + step;
    for (let k = 0; k < 24; k++) {
      t = (lo + hi) / 2;
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-7) break;
      if (err > 0) hi = t;
      else lo = t;
    }
    return t;
  }

  return (x) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveT(x)));
}

/** The CSS named timing functions, handy as references. */
export const css = {
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
  easeIn: cubicBezier(0.42, 0, 1, 1),
  easeOut: cubicBezier(0, 0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
};

/**
 * Damped harmonic oscillator moving from 0 to 1, solved in closed form so any
 * time can be sampled directly (no integration state, so scrubbing is exact).
 *
 * Returns f(seconds) → value. `f.duration` is the settle time (within 0.1%),
 * and `f.ease` is the same motion normalised to a [0, 1] easing.
 */
export function spring({ stiffness = 170, damping = 26, mass = 1, velocity = 0 } = {}) {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  let f;
  if (Math.abs(zeta - 1) < 1e-6) {
    const C2 = velocity - w0;
    f = (t) => 1 + (-1 + C2 * t) * Math.exp(-w0 * t);
  } else if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const C2 = (velocity - zeta * w0) / wd;
    f = (t) => 1 + Math.exp(-zeta * w0 * t) * (-Math.cos(wd * t) + C2 * Math.sin(wd * t));
  } else {
    const s = Math.sqrt(zeta * zeta - 1);
    const r1 = -w0 * (zeta - s);
    const r2 = -w0 * (zeta + s);
    const C1 = (velocity + r2) / (r1 - r2);
    const C2 = -1 - C1;
    f = (t) => 1 + C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t);
  }

  const dt = 1 / 240;
  let lastOut = 0;
  for (let t = 0; t < 20; t += dt) if (Math.abs(f(t) - 1) > 0.001) lastOut = t;
  const duration = Math.min(20, lastOut + dt);

  const fn = (t) => (t <= 0 ? 0 : f(t));
  fn.duration = duration;
  fn.ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : f(x * duration));
  return fn;
}

/** Spring motion normalised to an easing function over its settle time. */
export const springEase = (opts) => spring(opts).ease;

/** Named easings, addressable by string in keyframes: kf(t, keys, 'outExpo'). */
export const ease = {
  linear,
  inQuad, outQuad, inOutQuad,
  inCubic, outCubic, inOutCubic,
  inQuart, outQuart, inOutQuart,
  inQuint, outQuint, inOutQuint,
  inSine, outSine, inOutSine,
  inExpo, outExpo, inOutExpo,
  inCirc, outCirc, inOutCirc,
  inBack, outBack, inOutBack,
  inElastic, outElastic, inOutElastic,
  inBounce, outBounce, inOutBounce,
};

const resolved = new Map();

/**
 * Accepts an easing function, a name from `ease`, or a cubic-bezier array
 * [x1, y1, x2, y2]. Unknown names fall back to linear with a warning.
 */
export function resolveEase(e) {
  if (typeof e === 'function') return e;
  if (e == null) return linear;
  const key = Array.isArray(e) ? e.join(',') : e;
  let fn = resolved.get(key);
  if (fn) return fn;
  if (Array.isArray(e)) fn = cubicBezier(e[0], e[1], e[2], e[3]);
  else fn = ease[e];
  if (!fn) {
    console.warn(`Unknown easing "${e}", using linear`);
    fn = linear;
  }
  resolved.set(key, fn);
  return fn;
}

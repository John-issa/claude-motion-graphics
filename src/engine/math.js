// Scalar helpers. Everything here is pure and safe to import in Node.

export const TAU = Math.PI * 2;

export const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => (a === b ? 0 : (v - a) / (b - a));

/** Map v from [a, b] to [c, d]. Clamped unless `clampIt` is false. */
export const remap = (v, a, b, c, d, clampIt = true) => {
  const t = invLerp(a, b, v);
  return lerp(c, d, clampIt ? clamp01(t) : t);
};

export const smoothstep = (a, b, v) => {
  const t = clamp01(invLerp(a, b, v));
  return t * t * (3 - 2 * t);
};

export const fract = (x) => x - Math.floor(x);
export const mod = (a, n) => ((a % n) + n) % n;
export const deg = (d) => (d * Math.PI) / 180;
export const sign = (x) => (x < 0 ? -1 : 1);
export const dist = (x1, y1, x2, y2) => Math.hypot(x2 - x1, y2 - y1);

/** Shortest-path interpolation between two angles in radians. */
export const lerpAngle = (a, b, t) => {
  const d = mod(b - a + Math.PI, TAU) - Math.PI;
  return a + d * t;
};

/** Triangle wave 0 → 1 → 0 over one unit of x. */
export const pingpong = (x) => 1 - Math.abs(1 - 2 * fract(x));

/** Framerate-independent exponential approach, for UI only (not for scenes). */
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

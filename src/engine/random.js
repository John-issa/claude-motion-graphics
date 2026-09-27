// Seeded randomness. Scenes must never call Math.random(): every frame has to
// be a pure function of (time, params, seed) so scrubbing and export are exact.

/** 32-bit integer hash (lowbias32 by Chris Wellons). */
export function hash32(n) {
  n |= 0;
  n ^= n >>> 16;
  n = Math.imul(n, 0x7feb352d);
  n ^= n >>> 15;
  n = Math.imul(n, 0x846ca68b);
  n ^= n >>> 16;
  return n >>> 0;
}

/** Stable pseudo-random value in [0, 1) for an integer index and seed. */
export const hash = (i, seed = 0) => hash32(Math.imul(i | 0, 0x9e3779b1) ^ hash32(seed | 0)) / 4294967296;

/** Stable pseudo-random value in [0, 1) for an integer grid cell. */
export const hash2 = (x, y, seed = 0) =>
  hash32(Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ hash32(seed | 0)) / 4294967296;

/** FNV-1a hash of a string, for turning text into a seed. */
export function hashString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Fast seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded random source with the usual conveniences. */
export function createRandom(seed = 1) {
  const next = mulberry32(hash32(seed) ^ 0x5bd1e995);
  const rnd = {
    next,
    range: (a, b) => a + (b - a) * next(),
    int: (a, b) => a + Math.floor(next() * (b - a + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sign: () => (next() < 0.5 ? -1 : 1),
    chance: (p) => next() < p,
    /** Standard normal sample (Box-Muller). */
    gauss: () => {
      const u = 1 - next();
      const v = next();
      return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
    /** Fisher-Yates shuffle, in place. */
    shuffle: (arr) => {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
      }
      return arr;
    },
  };
  return rnd;
}

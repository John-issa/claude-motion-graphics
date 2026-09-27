// Wave Field: a 16 × 16 field of square columns driven by travelling ripples,
// seen through a hand-written perspective camera. Every frame the columns are
// back-face culled, sorted back to front (painter's algorithm) and flat shaded
// in three facets, over a ground of cast shadows and ambient occlusion.
//
// Beats: 0 flat grid rippling under the wipe · 0.5 columns rise from the centre
// · 1.5 the source slides aside · 2.05 a second source drops and the ripples
// interfere · 3.7 heights lock into a ziggurat, centre first · 5.0 collapse to
// flat as the camera cranes up to top-down, just ahead of the next iris.
//
// The field is rasterised in a CPU-backed buffer at output resolution (hundreds
// of small paths are far cheaper there than on an accelerated canvas) and lands
// in the frame as a few bands that hug its silhouette.

import {
  defineScene,
  kf,
  seg,
  eseg,
  ease,
  clamp01,
  lerp,
  smoothstep,
  mixRGB,
  makeCanvas,
  TAU,
} from '../engine/index.js';

// Field: cells are 1 unit apart, columns 0.8 wide.
const N = 16;
const COUNT = N * N;
const HALF = (N - 1) / 2;
const FOOT = 0.4; // half footprint

// Colour: tops follow the ramp by height, sides are the same colour dimmed.
const GROUND = '#E9E6DF';
const RAMP = ['#0B0C10', '#2446FF', '#2EE6A8'];
const LEVELS = 96; // quantised ramp steps, so colour strings are built once
const H_LO = 0.35; // heights at or below this are ink
const H_HI = 3.6; // heights at or above this are mint
const LIT = 0.78; // sides whose normal points screen-left
const SHADE = 0.58; // sides whose normal points screen-right
const EDGE = 'rgba(11,12,16,0.2)';

// Ground: floor plate, per-cell occlusion skirts and cast shadows.
const FLOOR = 0.5; // darkness of the ground inside the field once it has risen
const FLOOR_EDGE = HALF + 0.52; // floor plate half-size: a hair beyond the outer columns
const SKIRT = 0.6; // occlusion skirt half-size: covers the gaps on every side of a cell
const AO = Array.from({ length: 8 }, (_, i) => `rgba(11,12,16,${((i + 1) * 0.04).toFixed(2)})`);
const SHADOW = 'rgba(11,12,16,0.14)';
const SUN = [0.5, 0.18]; // shadow offset per unit height: screen-right, away
const BLUR = 4.5; // ground softness, design px: it is drawn this much smaller, then scaled up

// Ripples: h = A·sin(k·d − ω·t) per source.
const K = TAU / 6;
const OMEGA = TAU / 1.3;
const SRC = [2.8, -2.8]; // B's position; A slides from the centre to the mirror image
const A_SLIDE = [1.5, 2.6]; // A makes room for B
const T_B = 2.05; // the second source drops
const FRONT_V = 8; // how fast B's ripples spread, units per second
const FRONT_W = 2.5; // softness of B's leading edge
const SPLASH = 0.9; // extra amplitude on B's first ring…
const SPLASH_DECAY = 0.45; // …fading with this time constant (s)

// Heights, in cell units.
const H_FLAT = 0.16;
const A_FLAT = 0.14;
const H_BASE = 1.85;
const A_WAVE = 0.95;
const H_MIN = 0.3; // risen troughs bottom out here instead of reaching the floor
const SOFT = 0.35; // how gently troughs approach H_MIN
const STEP = 0.5; // ziggurat terrace height
const H_END = 0.12;

// Beats, in seconds: start, stagger spread, per-column duration.
const RISE = [0.5, 0.62, 0.7]; // outBack, centre outward
const FIG = [3.7, 0.5, 0.55]; // outBack, centre outward
const COLLAPSE = [5.0, 0.6, 0.5]; // inBack, centre outward

// Camera.
const FOCAL = 2700; // design px
const CX = 960;
const CY = 540;

// Compositing: rows are fitted to the field, then merged while that is cheaper.
const ROW = 16; // physical px
const CALL_PX = 6000; // one drawImage call costs about as much as this many pixels

/**
 * Ink → cobalt → mint, pre-shaded for the three facets. The upper half is
 * eased so crests commit to mint instead of lingering in the in-between teal.
 */
function colourTables() {
  const css = ([r, g, b], k) => `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  const top = [];
  const lit = [];
  const shade = [];
  for (let l = 0; l < LEVELS; l++) {
    const v = (l / (LEVELS - 1)) * 2;
    const c = v < 1 ? mixRGB(RAMP[0], RAMP[1], v) : mixRGB(RAMP[1], RAMP[2], smoothstep(0.15, 0.85, v - 1));
    top.push(css(c, 1));
    lit.push(css(c, LIT));
    shade.push(css(c, SHADE));
  }
  return { top, lit, shade };
}

/** Column heights at time t: rise, ripples and interference, figure, collapse. */
function heights(st, t) {
  const slide = eseg(t, A_SLIDE[0], A_SLIDE[1], 'inOutCubic');
  const ax = -SRC[0] * slide;
  const az = -SRC[1] * slide;
  const phB = t - T_B;
  for (let k = 0; k < COUNT; k++) {
    const r = ease.outBack(seg(t, RISE[0] + st.riseDelay[k], RISE[0] + st.riseDelay[k] + RISE[2]));
    let w = Math.sin(K * Math.hypot(st.x[k] - ax, st.z[k] - az) - OMEGA * t);
    if (phB > 0) {
      const dB = st.dB[k];
      const front = smoothstep(0, FRONT_W, FRONT_V * phB - dB);
      if (front > 0) {
        const age = Math.max(0, phB - dB / FRONT_V); // time since B's front arrived here
        // Starts with a dip: sin(k·d − ω·t) is negative just after the drop.
        w += Math.sin(K * dB - OMEGA * phB) * front * (1 + SPLASH * Math.exp(-age / SPLASH_DECAY));
      }
    }
    let y = lerp(H_FLAT, H_BASE, r) + lerp(A_FLAT, A_WAVE, r) * w;
    // Soft floor: below lo + soft, heights ease exponentially towards lo, so
    // deep troughs stay short dark columns rather than clipping flat.
    const risen = clamp01(r);
    const lo = H_MIN * risen;
    const soft = SOFT * risen;
    if (soft > 0 && y < lo + soft) y = lo + soft * Math.exp((y - lo - soft) / soft);
    const f = ease.outBack(seg(t, FIG[0] + st.figDelay[k], FIG[0] + st.figDelay[k] + FIG[2]));
    y = lerp(y, st.figH[k], f);
    const c = ease.inBack(seg(t, COLLAPSE[0] + st.colDelay[k], COLLAPSE[0] + st.colDelay[k] + COLLAPSE[2]));
    y = lerp(y, H_END, c);
    st.h[k] = Math.max(0.04, y);
  }
}

/** Orbiting camera: yaw drifts at a constant rate, then a crane up to top-down. */
function camera(t, dur) {
  const yaw = (lerp(22, 58, t / dur) * Math.PI) / 180;
  const pitch = (kf(t, [[0, 30], [4.9, 36, 'inOutSine'], [6.5, 88, 'inOutCubic']]) * Math.PI) / 180;
  const dist = kf(t, [[0, 56], [4.9, 54, 'inOutSine'], [6.5, 66, 'inOutCubic']]);
  // Crane the target so each beat sits centred: the flat grid, the tall field
  // (which grows upward), the pyramid (whose near corner reaches down).
  const ty = kf(t, [[0, -0.9], [1.6, 0.35, 'inOutSine'], [3.6, 0.35], [4.7, -1.1, 'inOutSine'], [6.3, 0, 'inOutCubic']]);
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  // Right, up and forward vectors built from the angles rather than lookAt,
  // so looking straight down stays well defined. Right has no y component.
  const cam = {
    rx: cosY,
    rz: -sinY,
    ux: -sinY * sinP,
    uy: cosP,
    uz: -cosY * sinP,
    fx: -sinY * cosP,
    fy: -sinP,
    fz: -cosY * cosP,
  };
  // The eye sits `dist` behind the target, which is craned to height ty.
  cam.ex = -cam.fx * dist;
  cam.ey = ty - cam.fy * dist;
  cam.ez = -cam.fz * dist;
  // Shadows fall screen-right and away, whichever way the camera faces.
  cam.vx = SUN[0] * cosY - SUN[1] * sinY;
  cam.vz = -SUN[0] * sinY - SUN[1] * cosY;
  return cam;
}

/**
 * Perspective-project every corner the frame needs, straight to physical
 * pixels: per column the footprint (0-3) and top (4-7) corners, the footprint
 * pushed along the shadow direction, and the AO skirt.
 */
function projectAll(st, c, px) {
  const f = FOCAL * px;
  const ox = CX * px;
  const oy = CY * px;
  const project = (out, o, X, Y, Z) => {
    const dx = X - c.ex;
    const dy = Y - c.ey;
    const dz = Z - c.ez;
    const inv = f / (dx * c.fx + dy * c.fy + dz * c.fz);
    out[o] = ox + (dx * c.rx + dz * c.rz) * inv;
    out[o + 1] = oy - (dx * c.ux + dy * c.uy + dz * c.uz) * inv;
  };
  const { pts, tips, skirt, h } = st;
  for (let k = 0; k < COUNT; k++) {
    const x = st.x[k];
    const z = st.z[k];
    const o = k * 16;
    project(pts, o, x - FOOT, 0, z - FOOT);
    project(pts, o + 2, x + FOOT, 0, z - FOOT);
    project(pts, o + 4, x + FOOT, 0, z + FOOT);
    project(pts, o + 6, x - FOOT, 0, z + FOOT);
    project(pts, o + 8, x - FOOT, h[k], z - FOOT);
    project(pts, o + 10, x + FOOT, h[k], z - FOOT);
    project(pts, o + 12, x + FOOT, h[k], z + FOOT);
    project(pts, o + 14, x - FOOT, h[k], z + FOOT);
    const sx = c.vx * h[k];
    const sz = c.vz * h[k];
    const p = k * 8;
    project(tips, p, x - FOOT + sx, 0, z - FOOT + sz);
    project(tips, p + 2, x + FOOT + sx, 0, z - FOOT + sz);
    project(tips, p + 4, x + FOOT + sx, 0, z + FOOT + sz);
    project(tips, p + 6, x - FOOT + sx, 0, z + FOOT + sz);
    project(skirt, p, x - SKIRT, 0, z - SKIRT);
    project(skirt, p + 2, x + SKIRT, 0, z - SKIRT);
    project(skirt, p + 4, x + SKIRT, 0, z + SKIRT);
    project(skirt, p + 6, x - SKIRT, 0, z + SKIRT);
  }
  const fp = st.floorPts;
  project(fp, 0, -FLOOR_EDGE, 0, -FLOOR_EDGE);
  project(fp, 2, FLOOR_EDGE, 0, -FLOOR_EDGE);
  project(fp, 4, FLOOR_EDGE, 0, FLOOR_EDGE);
  project(fp, 6, -FLOOR_EDGE, 0, FLOOR_EDGE);
}

/** Add a closed polygon through 4 (x, y) pairs of `a` starting at offset o. */
function quad4(b, a, o) {
  b.moveTo(a[o], a[o + 1]);
  b.lineTo(a[o + 2], a[o + 3]);
  b.lineTo(a[o + 4], a[o + 5]);
  b.lineTo(a[o + 6], a[o + 7]);
  b.closePath();
}

/**
 * The ground under the field: a floor plate that darkens as the field rises
 * (a dense field's floor sees little sky), per-cell ambient occlusion, and cast
 * shadows. Each layer is one path per tone, so overlaps never double up.
 */
function drawGround(b, st, c) {
  const { h, pts, tips, skirt, ao } = st;
  let mean = 0;
  for (let k = 0; k < COUNT; k++) mean += h[k];
  const floor = FLOOR * smoothstep(0.3, 1.6, mean / COUNT);
  if (floor > 0.005) {
    b.fillStyle = `rgba(11,12,16,${floor.toFixed(3)})`;
    b.beginPath();
    quad4(b, st.floorPts, 0);
    b.fill();
  }

  // Occlusion: how enclosed a cell is (its own height or its neighbours'
  // mean, whichever is taller), quantised so each level is a single fill.
  for (let k = 0; k < COUNT; k++) {
    const around = st.neighbours[k];
    let sum = 0;
    for (let n = 0; n < around.length; n++) sum += h[around[n]];
    ao[k] = Math.round(smoothstep(0.3, 3, Math.max(h[k], sum / around.length)) * AO.length);
  }
  for (let level = 1; level <= AO.length; level++) {
    b.fillStyle = AO[level - 1];
    b.beginPath();
    for (let k = 0; k < COUNT; k++) if (ao[k] === level) quad4(b, skirt, k * 8);
    b.fill();
  }

  // Shadow of a box under a directional light: the hull of its footprint and
  // the footprint shifted by h·v, a hexagon starting at the trailing corner.
  const tr = c.vx >= 0 ? (c.vz >= 0 ? 0 : 3) : c.vz >= 0 ? 1 : 2;
  const c0 = tr * 2;
  const c1 = ((tr + 1) & 3) * 2;
  const c2 = ((tr + 2) & 3) * 2;
  const c3 = ((tr + 3) & 3) * 2;
  b.fillStyle = SHADOW;
  b.beginPath();
  for (let k = 0; k < COUNT; k++) {
    if (h[k] < 0.05) continue;
    const o = k * 16;
    const p = k * 8;
    b.moveTo(pts[o + c0], pts[o + c0 + 1]);
    b.lineTo(pts[o + c1], pts[o + c1 + 1]);
    b.lineTo(tips[p + c1], tips[p + c1 + 1]);
    b.lineTo(tips[p + c2], tips[p + c2 + 1]);
    b.lineTo(tips[p + c3], tips[p + c3 + 1]);
    b.lineTo(pts[o + c3], pts[o + c3 + 1]);
    b.closePath();
  }
  b.fill();
}

/** The columns, far to near, each as up to two sides and a top plus hairlines. */
function drawColumns(b, st, c, px) {
  const { h, pts, order } = st;
  const { top, lit, shade } = st.colours;
  // A quad through four of a column's corners, given as offsets into pts.
  const face = (o, i0, i1, i2, i3) => {
    b.moveTo(pts[o + i0], pts[o + i0 + 1]);
    b.lineTo(pts[o + i1], pts[o + i1 + 1]);
    b.lineTo(pts[o + i2], pts[o + i2 + 1]);
    b.lineTo(pts[o + i3], pts[o + i3 + 1]);
    b.closePath();
  };
  const sideX = (o, s) => (s > 0 ? face(o, 2, 4, 12, 10) : face(o, 0, 6, 14, 8));
  const sideZ = (o, s) => (s > 0 ? face(o, 4, 6, 14, 12) : face(o, 0, 2, 10, 8));
  // A side is lit when its normal points screen-left (negative camera x).
  const xPosLit = c.rx < 0;
  const zPosLit = c.rz < 0;
  b.lineWidth = Math.max(0.9, 1.3 * px);
  b.strokeStyle = EDGE;
  for (let n = 0; n < COUNT; n++) {
    const k = order[n];
    const o = k * 16;
    const lvl = Math.round(clamp01((h[k] - H_LO) / (H_HI - H_LO)) * (LEVELS - 1));
    // Back-face culling for an axis-aligned box: a side is visible when the
    // eye is beyond its plane. Sides under half a pixel tall are skipped.
    const tall = Math.hypot(pts[o + 8] - pts[o], pts[o + 9] - pts[o + 1]) > 0.5;
    const sx = !tall ? 0 : c.ex > st.x[k] + FOOT ? 1 : c.ex < st.x[k] - FOOT ? -1 : 0;
    const sz = !tall ? 0 : c.ez > st.z[k] + FOOT ? 1 : c.ez < st.z[k] - FOOT ? -1 : 0;
    if (sx) {
      b.fillStyle = (sx > 0) === xPosLit ? lit[lvl] : shade[lvl];
      b.beginPath();
      sideX(o, sx);
      b.fill();
    }
    if (sz) {
      b.fillStyle = (sz > 0) === zPosLit ? lit[lvl] : shade[lvl];
      b.beginPath();
      sideZ(o, sz);
      b.fill();
    }
    b.fillStyle = top[lvl];
    b.beginPath();
    face(o, 8, 10, 12, 14);
    b.fill();
    if (lvl === 0) continue; // ink on ink: the hairlines would be invisible
    if (sx) sideX(o, sx);
    if (sz) sideZ(o, sz);
    b.stroke();
  }
}

/** A CPU-backed scratch canvas kept in state and (re)sized to w × h. */
function scratch(st, name, w, h) {
  let canvas = st[name];
  if (!canvas) {
    canvas = st[name] = makeCanvas(w, h);
    // willReadFrequently keeps it in CPU memory, where small paths are cheap.
    canvas.getContext('2d', { willReadFrequently: true });
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas;
}

/**
 * Draw the ground at 1/soften resolution and scale it back up with smoothing:
 * a cheap, deterministic blur that softens the shadows and occlusion.
 */
function softGround(b, st, c, px, pw, ph) {
  const soften = Math.max(1, BLUR * px);
  const gw = Math.ceil(pw / soften);
  const gh = Math.ceil(ph / soften);
  const low = scratch(st, 'ground', gw, gh);
  const g = low.getContext('2d');
  g.save();
  g.clearRect(0, 0, gw, gh);
  g.scale(1 / soften, 1 / soften);
  drawGround(g, st, c);
  g.restore();
  const [x0, y0, x1, y1] = groundBounds(st, soften, gw, gh);
  if (x1 > x0 && y1 > y0) {
    b.drawImage(low, x0, y0, x1 - x0, y1 - y0, x0 * soften, y0 * soften, (x1 - x0) * soften, (y1 - y0) * soften);
  }
}

/** Bounding box of the ground layers, in pixels of the buffer scaled by 1/soften. */
function groundBounds(st, soften, gw, gh) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const take = (a) => {
    for (let q = 0; q < a.length; q += 2) {
      if (a[q] < x0) x0 = a[q];
      if (a[q] > x1) x1 = a[q];
      if (a[q + 1] < y0) y0 = a[q + 1];
      if (a[q + 1] > y1) y1 = a[q + 1];
    }
  };
  take(st.skirt);
  take(st.tips);
  take(st.floorPts);
  const pad = 2;
  return [
    Math.max(0, Math.floor(x0 / soften) - pad),
    Math.max(0, Math.floor(y0 / soften) - pad),
    Math.min(gw, Math.ceil(x1 / soften) + pad),
    Math.min(gh, Math.ceil(y1 / soften) + pad),
  ];
}

/**
 * Rectangles (physical px) that cover everything the field draws: rows of
 * ROW px fitted to the columns, shadows and occlusion skirts, merged down the
 * frame whenever one taller rectangle wastes fewer pixels than a separate
 * drawImage costs. On an accelerated canvas, compositing costs scale with the
 * pixels covered, so a tight fit is worth more than a low call count.
 * Writes [x, y, w, h, ...] into st.rects and returns how many there are.
 */
function fitRects(st, pw, ph, pad) {
  const rows = Math.ceil(ph / ROW);
  if (!st.rowMin || st.rowMin.length < rows) {
    st.rowMin = new Float32Array(rows);
    st.rowMax = new Float32Array(rows);
    st.rects = new Float32Array(rows * 4);
  }
  const { rowMin, rowMax, rects } = st;
  rowMin.fill(Infinity, 0, rows);
  rowMax.fill(-Infinity, 0, rows);
  const extend = (a, from, to) => {
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let q = from; q < to; q += 2) {
      if (a[q] < x0) x0 = a[q];
      if (a[q] > x1) x1 = a[q];
      if (a[q + 1] < y0) y0 = a[q + 1];
      if (a[q + 1] > y1) y1 = a[q + 1];
    }
    const r0 = Math.max(0, Math.floor((y0 - pad) / ROW));
    const r1 = Math.min(rows - 1, Math.floor((y1 + pad) / ROW));
    for (let q = r0; q <= r1; q++) {
      if (x0 < rowMin[q]) rowMin[q] = x0;
      if (x1 > rowMax[q]) rowMax[q] = x1;
    }
  };
  for (let k = 0; k < COUNT; k++) {
    extend(st.pts, k * 16, k * 16 + 16);
    extend(st.tips, k * 8, k * 8 + 8);
    extend(st.skirt, k * 8, k * 8 + 8);
  }
  let n = 0;
  let open = false;
  let x0 = 0;
  let x1 = 0;
  let y0 = 0;
  let y1 = 0;
  const emit = () => {
    rects[n * 4] = x0;
    rects[n * 4 + 1] = y0;
    rects[n * 4 + 2] = x1 - x0;
    rects[n * 4 + 3] = y1 - y0;
    n++;
  };
  for (let q = 0; q < rows; q++) {
    if (!(rowMax[q] > rowMin[q])) {
      if (open) emit();
      open = false;
      continue;
    }
    const a = Math.max(0, Math.floor(rowMin[q] - pad));
    const b = Math.min(pw, Math.ceil(rowMax[q] + pad));
    const top = q * ROW;
    const bottom = Math.min(ph, top + ROW);
    if (open) {
      const mx0 = Math.min(x0, a);
      const mx1 = Math.max(x1, b);
      const merged = (mx1 - mx0) * (bottom - y0);
      const separate = (x1 - x0) * (y1 - y0) + (b - a) * (bottom - top) + CALL_PX;
      if (merged <= separate) {
        x0 = mx0;
        x1 = mx1;
        y1 = bottom;
        continue;
      }
      emit();
    }
    open = true;
    x0 = a;
    x1 = b;
    y0 = top;
    y1 = bottom;
  }
  if (open) emit();
  return n;
}

export default defineScene({
  id: 'geometry',
  title: 'Wave Field',
  duration: 6.5,
  color: '#2EE6A8',
  transition: { type: 'wipe', duration: 0.7, color: '#2EE6A8', angle: -14 },
  notes: [
    'Perspective projection from scratch',
    "Painter's-algorithm depth sort",
    'Flat shading, three light facets',
    'Two-source wave interference',
  ],
  slug: { color: '#0B0C10' },
  // The reel's overlay grain alone costs about the whole frame budget on an
  // accelerated canvas, so this bright, flat-shaded scene goes without.
  post: { grain: 0 },

  setup() {
    const x = new Float32Array(COUNT);
    const z = new Float32Array(COUNT);
    const dB = new Float32Array(COUNT);
    const riseDelay = new Float32Array(COUNT);
    const figDelay = new Float32Array(COUNT);
    const colDelay = new Float32Array(COUNT);
    const figH = new Float32Array(COUNT);
    const neighbours = [];
    const dMax = Math.hypot(HALF, HALF);
    for (let k = 0; k < COUNT; k++) {
      const i = k % N;
      const j = Math.floor(k / N);
      x[k] = i - HALF;
      z[k] = j - HALF;
      neighbours.push([i > 0 && k - 1, i < N - 1 && k + 1, j > 0 && k - N, j < N - 1 && k + N].filter((n) => n !== false));
      dB[k] = Math.hypot(x[k] - SRC[0], z[k] - SRC[1]);
      const dc = Math.hypot(x[k], z[k]) / dMax;
      const ring = Math.max(Math.abs(x[k]), Math.abs(z[k])) - 0.5; // 0 centre … 7 edge
      riseDelay[k] = dc * RISE[1];
      figDelay[k] = (ring / 7) * FIG[1];
      colDelay[k] = dc * COLLAPSE[1];
      figH[k] = STEP * (8 - ring);
    }
    return {
      x,
      z,
      dB,
      riseDelay,
      figDelay,
      colDelay,
      figH,
      neighbours,
      colours: colourTables(),
      // Per-frame scratch, fully rewritten every render.
      h: new Float32Array(COUNT),
      ao: new Uint8Array(COUNT),
      key: new Float32Array(COUNT),
      order: Array.from({ length: COUNT }, (_, k) => k),
      pts: new Float32Array(COUNT * 16),
      tips: new Float32Array(COUNT * 8),
      skirt: new Float32Array(COUNT * 8),
      floorPts: new Float32Array(8),
      rowMin: null,
      rowMax: null,
      rects: null,
      field: null, // CPU-backed canvases, created on first render
      ground: null,
    };
  },

  render(ctx, s) {
    const st = s.state;
    const { W, H, px } = s;

    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, W, H);

    heights(st, s.t);
    const c = camera(s.t, s.dur);
    projectAll(st, c, px);

    // Painter's order. Anything that can hide a column sits nearer the eye
    // along both ground axes, so sorting far to near by ground distance from
    // the eye is a valid back-to-front order for boxes on a grid.
    const { key, order } = st;
    for (let k = 0; k < COUNT; k++) {
      const gx = st.x[k] - c.ex;
      const gz = st.z[k] - c.ez;
      key[k] = gx * gx + gz * gz;
      order[k] = k; // fresh start, so ties never depend on the previous frame
    }
    order.sort((a, b) => key[b] - key[a]);

    // Hundreds of small path fills are cheap on a CPU-backed canvas and slow
    // on an accelerated one, so the field is rasterised off-screen at output
    // resolution, then composited.
    const pw = Math.round(W * px);
    const ph = Math.round(H * px);
    const field = scratch(st, 'field', pw, ph);
    const b = field.getContext('2d');
    // Only these rectangles reach the frame, so only they need clearing: every
    // pixel composited below is cleared and redrawn in this same frame.
    const n = fitRects(st, pw, ph, Math.ceil(BLUR * px) + 2);
    const r = st.rects;
    for (let i = 0; i < n * 4; i += 4) b.clearRect(r[i], r[i + 1], r[i + 2], r[i + 3]);
    softGround(b, st, c, px, pw, ph);
    drawColumns(b, st, c, px);
    for (let i = 0; i < n * 4; i += 4) {
      ctx.drawImage(field, r[i], r[i + 1], r[i + 2], r[i + 3], r[i] / px, r[i + 1] / px, r[i + 2] / px, r[i + 3] / px);
    }
  },
});

// Wave Field: a 16 × 16 field of square columns driven by travelling ripples,
// seen through a hand-written perspective camera. Every frame the columns are
// back-face culled, sorted back to front (painter's algorithm) and flat shaded
// in three facets, over a ground of cast shadows and ambient occlusion.
//
// Beats: 0 flat grid rippling under the wipe · 0.5 columns rise from the centre
// · 1.45 the source slides to the far side and the field quietens · 2.0 a second
// source lands in the foreground, spikes and throws a splash ring; the two
// systems interfere and cancel along a calm street through the centre · 4.0
// heights lock into a ziggurat, centre first, and breathe · 5.15 it winds up and
// collapses ring by ring as the camera cranes to top-down, into the next iris.
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
const INK = '#0B0C10';
const COBALT = '#2446FF';
const MINT = '#2EE6A8';
const LEVELS = 96; // quantised ramp steps, so colour strings are built once
const H_LO = 0.35; // heights at or below this are ink
const H_COBALT = 2.6; // ink → cobalt is complete here
const H_MINT = [2.95, 3.45]; // cobalt → mint, a short step so mint stays an event
const H_TOP = 3.6; // top of the table
const LIT = 0.78; // sides whose normal points screen-left
const SHADE = 0.58; // sides whose normal points screen-right
// Ink sides would vanish into ink tops, so dark sides bottom out at these.
const LIT_FLOOR = '#2A2C33';
const SHADE_FLOOR = '#1B1D23';
const EDGE = 'rgba(11,12,16,0.2)';

// Ground: floor plate, per-cell occlusion skirts and cast shadows.
const FLOOR = 0.5; // darkness of the ground inside the field once it has risen…
// …and while it is flat, so slivers of ground glimpsed between tiles don't sparkle
const FLOOR_FLAT = 0.3;
const FLOOR_EDGE = HALF + 0.52; // floor plate half-size: a hair beyond the outer columns
const SKIRT = 0.6; // occlusion skirt half-size: covers the gaps on every side of a cell
const AO = Array.from({ length: 8 }, (_, i) => `rgba(11,12,16,${((i + 1) * 0.04).toFixed(2)})`);
const SHADOW = 'rgba(11,12,16,0.14)';
const SUN = [0.5, 0.18]; // shadow offset per unit height: screen-right, away
const BLUR = 4.5; // ground softness, design px: it is drawn this much smaller, then scaled up

// Ripples: h = A·sin(k·d − ω·t) per source. The camera looks down the x = z
// diagonal, so the sources sit on it, A far and B near: their interference
// fringes then run across the frame instead of pointing at the lens.
const K = TAU / 6;
const OMEGA = TAU / 1.3;
const SRC_A = [-3.5, -3.5]; // A starts at the centre and slides here
const SRC_B = [3.5, 3.5]; // B lands on this cell
const A_SLIDE = [1.45, 2.45];
// A ducks while B lands, so B's first ring crosses a quiet field.
const DUCK = [[1.65, 1], [1.95, 0.5, 'inOutSine'], [2.45, 0.5], [2.85, 1, 'inOutSine']];
const T_B = 2.0; // B lands: its column spikes…
const T_RING = 2.12; // …then drops and throws a ring
const SPIKE = 4.3;
const RING_V = 9; // how fast B's ring and wave front spread, units per second
const RING_W = 1.0; // half-width of the splash ring
const SPLASH = 2.4; // splash ring amplitude, in wave amplitudes…
const SPLASH_DECAY = 0.9; // …fading with this time constant (s)
const FRONT_W = 1.2; // softness of B's wave front

// Heights, in cell units.
const H_FLAT = 0.16;
const A_FLAT = 0.14;
const H_BASE = 1.85;
const A_WAVE = 0.95;
const H_MIN = 0.3; // risen troughs bottom out here instead of reaching the floor
const SOFT = 0.35; // how gently troughs approach H_MIN
const STEP = 0.5; // ziggurat terrace height
const A_HOLD = 0.07; // the ziggurat breathes: a low ripple, ring by ring
const K_HOLD = TAU / 4;
const H_END = 0.12;
const A_END = 0.1; // the flat grid keeps a faint ripple, as it began

// Beats, in seconds: start, stagger spread, per-column duration.
const DURATION = 6.5;
const RISE = [0.5, 0.62, 0.7]; // outBack, centre outward
const FIG = [4.0, 0.4, 0.55]; // outBack, square rings outward
// Collapse, timed against the next scene's transition: the centre bottoms out
// as it starts, and the outer rings are still falling when it reaches them.
const NEXT_IN = 0.9; // the next scene's transition, if the reel has no scene after this one
const COLLAPSE_LEAD = 0.45; // ring 0 starts this long before that transition
const COLLAPSE_SPAN = 0.55; // ring 7 starts this much later…
const COLLAPSE_SHAPE = 0.75; // …with the front accelerating outward
const COLLAPSE_D = 0.45; // per ring
const WIND_UP = 2.6; // back-ease overshoot: the terraces lift ~20% before the slam

// Camera.
const FOCAL = 2500; // design px
const CX = 960;
const CY = 540;

const BAND = 48; // physical px per composite band

/**
 * Ink → cobalt → mint by height, pre-shaded for the three facets. Cobalt turns
 * to mint over a short step, so in-between teal is rare and mint marks only
 * constructive crests, the splash and the ziggurat's crown.
 */
function colourTables() {
  const css = ([r, g, b]) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
  const scale = (c, k) => c.map((v) => v * k);
  const top = [];
  const lit = [];
  const shade = [];
  for (let l = 0; l < LEVELS; l++) {
    const h = lerp(H_LO, H_TOP, l / (LEVELS - 1));
    const toCobalt = clamp01((h - H_LO) / (H_COBALT - H_LO));
    const c = mixRGB(mixRGB(INK, COBALT, toCobalt), MINT, smoothstep(H_MINT[0], H_MINT[1], h));
    // Below about half-way to cobalt the dimmed sides fade to the facet floor.
    const dark = 1 - smoothstep(0, 0.45, toCobalt);
    top.push(css(c));
    lit.push(css(mixRGB(scale(c, LIT), LIT_FLOOR, dark)));
    shade.push(css(mixRGB(scale(c, SHADE), SHADE_FLOOR, dark)));
  }
  return { top, lit, shade };
}

/** Back ease with a chosen overshoot: dips below 0 (the wind-up), then lands on 1. */
const windUp = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : (WIND_UP + 1) * x * x * x - WIND_UP * x * x);

/** Column heights at time t: rise, ripples and interference, figure, collapse. */
function heights(st, t) {
  const slide = eseg(t, A_SLIDE[0], A_SLIDE[1], 'inOutCubic');
  const ax = SRC_A[0] * slide;
  const az = SRC_A[1] * slide;
  const duck = kf(t, DUCK);
  const phase = OMEGA * t;
  const age = t - T_RING; // time since B released its ring
  const front = RING_V * age; // radius of B's ring and wave front
  const splash = age > 0 ? SPLASH * Math.exp(-age / SPLASH_DECAY) : 0;
  // B's own column: up fast with a little overshoot, held, then dropped as it lets go.
  const spike = ease.outBack(seg(t, T_B, T_B + 0.1)) * (1 - ease.inOutCubic(seg(t, T_RING, T_RING + 0.2)));
  for (let k = 0; k < COUNT; k++) {
    const r = ease.outBack(seg(t, RISE[0] + st.riseDelay[k], RISE[0] + st.riseDelay[k] + RISE[2]));
    let w = duck * Math.sin(K * Math.hypot(st.x[k] - ax, st.z[k] - az) - phase);
    if (age > 0) {
      const d = st.dB[k];
      // B runs in antiphase with A, so the two cancel wherever dA = dB: along
      // the perpendicular bisector, a calm street straight through the centre.
      const on = smoothstep(0, FRONT_W, front - d);
      if (on > 0) w -= Math.sin(K * d - phase) * on;
      const u = (d - front) / RING_W;
      if (splash > 0.01 && u > -3 && u < 3) w += splash * Math.exp(-u * u);
    }
    let y = lerp(H_FLAT, H_BASE, r) + lerp(A_FLAT, A_WAVE, r) * w;
    // Soft floor: below lo + soft, heights ease exponentially towards lo, so
    // deep troughs stay short dark columns rather than clipping flat.
    const risen = clamp01(r);
    const lo = H_MIN * risen;
    const soft = SOFT * risen;
    if (soft > 0 && y < lo + soft) y = lo + soft * Math.exp((y - lo - soft) / soft);
    if (k === st.kB && spike !== 0) y = lerp(y, SPIKE, spike);
    const f = ease.outBack(seg(t, FIG[0] + st.figDelay[k], FIG[0] + st.figDelay[k] + FIG[2]));
    if (f !== 0) y = lerp(y, st.figH[k] + A_HOLD * Math.sin(K_HOLD * st.ring[k] - phase), f);
    const c = windUp(seg(t, st.colStart[k], st.colStart[k] + COLLAPSE_D));
    if (c !== 0) y = lerp(y, H_END + A_END * Math.sin(K * st.dc[k] - phase), c);
    st.h[k] = Math.max(0.04, y);
  }
}

/**
 * Orbiting camera: yaw drifts at a constant rate while the pitch rises enough
 * to look down into the interference streets, then a crane up to top-down.
 */
function camera(t, dur) {
  const yaw = (lerp(22, 58, t / dur) * Math.PI) / 180;
  const pitch = (kf(t, [[0, 30], [3.4, 50, 'inOutSine'], [5.0, 51], [6.5, 88, 'inOutCubic']]) * Math.PI) / 180;
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
  const floor = lerp(FLOOR_FLAT, FLOOR, smoothstep(0.3, 1.6, mean / COUNT));
  b.fillStyle = `rgba(11,12,16,${floor.toFixed(3)})`;
  b.beginPath();
  quad4(b, st.floorPts, 0);
  b.fill();

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

/**
 * The columns, far to near: two sides and a top, then a hairline. Faces that
 * only meet edge to edge leave anti-aliased seams where the ground shows
 * through, so each face after the first is drawn a little larger than true
 * and overlaps the one before it; the hairline then traces the true edge.
 */
function drawColumns(b, st, c, px) {
  const { h, pts, order } = st;
  const { top, lit, shade } = st.colours;
  const q = new Float32Array(8);
  // A quad through four of a column's corners (offsets into pts), pushed
  // `grow` px out from its centre.
  const face = (o, i0, i1, i2, i3, grow = 0) => {
    q[0] = pts[o + i0];
    q[1] = pts[o + i0 + 1];
    q[2] = pts[o + i1];
    q[3] = pts[o + i1 + 1];
    q[4] = pts[o + i2];
    q[5] = pts[o + i2 + 1];
    q[6] = pts[o + i3];
    q[7] = pts[o + i3 + 1];
    if (grow > 0) {
      const mx = (q[0] + q[2] + q[4] + q[6]) / 4;
      const my = (q[1] + q[3] + q[5] + q[7]) / 4;
      for (let v = 0; v < 8; v += 2) {
        const dx = q[v] - mx;
        const dy = q[v + 1] - my;
        const push = grow / (Math.hypot(dx, dy) || 1);
        q[v] += dx * push;
        q[v + 1] += dy * push;
      }
    }
    b.moveTo(q[0], q[1]);
    b.lineTo(q[2], q[3]);
    b.lineTo(q[4], q[5]);
    b.lineTo(q[6], q[7]);
    b.closePath();
  };
  const sideX = (o, s, g) => (s > 0 ? face(o, 2, 4, 12, 10, g) : face(o, 0, 6, 14, 8, g));
  const sideZ = (o, s, g) => (s > 0 ? face(o, 4, 6, 14, 12, g) : face(o, 0, 2, 10, 8, g));
  const overlap = 0.6; // physical px
  // A side is lit when its normal points screen-left (negative camera x).
  const xPosLit = c.rx < 0;
  const zPosLit = c.rz < 0;
  b.lineWidth = Math.max(0.9, 1.3 * px);
  b.strokeStyle = EDGE;
  for (let n = 0; n < COUNT; n++) {
    const k = order[n];
    const o = k * 16;
    const lvl = Math.round(clamp01((h[k] - H_LO) / (H_TOP - H_LO)) * (LEVELS - 1));
    // Back-face culling for an axis-aligned box: a side is visible when the
    // eye is beyond its plane. Sides under half a pixel tall are skipped.
    const tall = Math.hypot(pts[o + 8] - pts[o], pts[o + 9] - pts[o + 1]) > 0.5;
    const sx = !tall ? 0 : c.ex > st.x[k] + FOOT ? 1 : c.ex < st.x[k] - FOOT ? -1 : 0;
    const sz = !tall ? 0 : c.ez > st.z[k] + FOOT ? 1 : c.ez < st.z[k] - FOOT ? -1 : 0;
    if (sx) {
      b.fillStyle = (sx > 0) === xPosLit ? lit[lvl] : shade[lvl];
      b.beginPath();
      sideX(o, sx, 0);
      b.fill();
    }
    if (sz) {
      b.fillStyle = (sz > 0) === zPosLit ? lit[lvl] : shade[lvl];
      b.beginPath();
      sideZ(o, sz, sx ? overlap : 0);
      b.fill();
    }
    b.fillStyle = top[lvl];
    b.beginPath();
    face(o, 8, 10, 12, 14, sx || sz ? overlap : 0);
    b.fill();
    // A hairline round the top; the sides already part by tone. Ink on ink
    // would not show at all.
    if (lvl === 0) continue;
    b.beginPath();
    face(o, 8, 10, 12, 14);
    b.stroke();
  }
}

/** A CPU-backed scratch canvas kept in state and (re)sized to w × h. */
function scratch(st, name, w, h, alpha = true) {
  let canvas = st[name];
  if (!canvas) {
    canvas = st[name] = makeCanvas(w, h);
    // willReadFrequently keeps it in CPU memory, where small paths are cheap.
    canvas.getContext('2d', { willReadFrequently: true, alpha });
  } else if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  return canvas;
}

/**
 * Draw the ground at 1/soften resolution and scale it back up with smoothing:
 * a cheap, deterministic blur that softens the shadows and occlusion. One
 * bilinear step of more than about 3x (1080p and up) leaves faceted steps
 * along soft edges, so larger factors go through a half-resolution buffer.
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
  if (!(x1 > x0 && y1 > y0)) return;
  const w = x1 - x0;
  const h = y1 - y0;
  if (soften <= 3.25) {
    b.drawImage(low, x0, y0, w, h, x0 * soften, y0 * soften, w * soften, h * soften);
    return;
  }
  const up = soften / 2; // low → half resolution
  const mid = scratch(st, 'groundMid', Math.ceil(pw / 2), Math.ceil(ph / 2));
  const m = mid.getContext('2d');
  m.clearRect(0, 0, mid.width, mid.height);
  m.drawImage(low, x0, y0, w, h, x0 * up, y0 * up, w * up, h * up);
  b.drawImage(mid, x0 * up, y0 * up, w * up, h * up, x0 * soften, y0 * soften, w * soften, h * soften);
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
 * Horizontal bands (physical px) that cover everything the field draws: the
 * columns, shadows and occlusion skirts, row by row. On an accelerated canvas
 * compositing costs scale with the pixels covered, plus a little per call;
 * bands of about 48 px balance the two for this silhouette.
 * Writes [x, y, w, h, ...] into st.rects and returns how many there are.
 */
function fitBands(st, pw, ph, pad) {
  const nb = Math.ceil(ph / BAND);
  if (!st.rects || st.rects.length < nb * 4) {
    st.bandMin = new Float32Array(nb);
    st.bandMax = new Float32Array(nb);
    st.rects = new Float32Array(nb * 4);
  }
  const { bandMin, bandMax, rects } = st;
  bandMin.fill(Infinity, 0, nb);
  bandMax.fill(-Infinity, 0, nb);
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
    const b0 = Math.max(0, Math.floor((y0 - pad) / BAND));
    const b1 = Math.min(nb - 1, Math.floor((y1 + pad) / BAND));
    for (let q = b0; q <= b1; q++) {
      if (x0 < bandMin[q]) bandMin[q] = x0;
      if (x1 > bandMax[q]) bandMax[q] = x1;
    }
  };
  for (let k = 0; k < COUNT; k++) {
    extend(st.pts, k * 16, k * 16 + 16);
    extend(st.tips, k * 8, k * 8 + 8);
    extend(st.skirt, k * 8, k * 8 + 8);
  }
  let n = 0;
  for (let q = 0; q < nb; q++) {
    if (!(bandMax[q] > bandMin[q])) continue;
    const x = Math.max(0, Math.floor(bandMin[q] - pad));
    const w = Math.min(pw, Math.ceil(bandMax[q] + pad)) - x;
    if (w <= 0) continue;
    rects[n * 4] = x;
    rects[n * 4 + 1] = q * BAND;
    rects[n * 4 + 2] = w;
    rects[n * 4 + 3] = Math.min(BAND, ph - q * BAND);
    n++;
  }
  return n;
}

export default defineScene({
  id: 'geometry',
  title: 'Wave Field',
  duration: DURATION,
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

  uses: [],
  /** Sound on the scene's beats (second source, splash, figure, sinkhole). */
  cues: () => [
    { t: 2.0, kind: 'hit', strength: 0.7 }, // the second source spikes
    { t: 2.12, kind: 'shimmer', strength: 0.6 }, // its splash ring releases
    { t: 4.0, kind: 'land', strength: 0.5 }, // the figure starts locking
    { t: 4.4, kind: 'land', strength: 0.6 }, // the centre settles
    { t: 4.95, kind: 'land', strength: 0.7 }, // the outer ring settles
    { t: 5.0, kind: 'swell', dur: 0.36, strength: 0.6 }, // wind-up
    { t: 5.6, kind: 'hit', strength: 0.8 }, // the sinkhole bottoms out under the iris
  ],
  setup({ reel }) {
    // The collapse is scheduled against the next scene's transition window.
    const at = reel.scenes.findIndex((e) => e.id === 'geometry');
    const next = at >= 0 ? reel.scenes[at + 1] : undefined;
    const out = next ? next.start - reel.scenes[at].start : DURATION - NEXT_IN;
    const x = new Float32Array(COUNT);
    const z = new Float32Array(COUNT);
    const dB = new Float32Array(COUNT);
    const dc = new Float32Array(COUNT);
    const ring = new Float32Array(COUNT);
    const riseDelay = new Float32Array(COUNT);
    const figDelay = new Float32Array(COUNT);
    const colStart = new Float32Array(COUNT);
    const figH = new Float32Array(COUNT);
    const neighbours = [];
    const dMax = Math.hypot(HALF, HALF);
    for (let k = 0; k < COUNT; k++) {
      const i = k % N;
      const j = Math.floor(k / N);
      x[k] = i - HALF;
      z[k] = j - HALF;
      neighbours.push([i > 0 && k - 1, i < N - 1 && k + 1, j > 0 && k - N, j < N - 1 && k + N].filter((n) => n !== false));
      dB[k] = Math.hypot(x[k] - SRC_B[0], z[k] - SRC_B[1]);
      dc[k] = Math.hypot(x[k], z[k]);
      // Square rings, 0 at the centre to 7 at the edge: the ziggurat's
      // terraces, and the order they lock and fall in.
      ring[k] = Math.max(Math.abs(x[k]), Math.abs(z[k])) - 0.5;
      riseDelay[k] = (dc[k] / dMax) * RISE[1];
      figDelay[k] = (ring[k] / 7) * FIG[1];
      const fall = out - COLLAPSE_LEAD + COLLAPSE_SPAN * Math.pow(ring[k] / 7, COLLAPSE_SHAPE);
      colStart[k] = Math.min(fall, DURATION - COLLAPSE_D); // every ring lands by the last frame
      figH[k] = STEP * (8 - ring[k]);
    }
    return {
      x,
      z,
      dB,
      dc,
      ring,
      kB: (SRC_B[1] + HALF) * N + SRC_B[0] + HALF,
      riseDelay,
      figDelay,
      colStart,
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
      bandMin: null,
      bandMax: null,
      rects: null,
      field: null, // CPU-backed canvases, created on first render
      ground: null,
      groundMid: null,
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
    // resolution, then composited as bands that hug its silhouette.
    const pw = Math.round(W * px);
    const ph = Math.round(H * px);
    const n = fitBands(st, pw, ph, Math.ceil(BLUR * px) + 2);
    const r = st.rects;
    let x0 = pw;
    let y0 = ph;
    let x1 = 0;
    let y1 = 0;
    for (let i = 0; i < n * 4; i += 4) {
      x0 = Math.min(x0, r[i]);
      y0 = Math.min(y0, r[i + 1]);
      x1 = Math.max(x1, r[i] + r[i + 2]);
      y1 = Math.max(y1, r[i + 1] + r[i + 3]);
    }
    if (x1 <= x0 || y1 <= y0) return;
    // The buffer spans only the bands (in 128 px steps, so it is rarely
    // resized): the whole buffer is uploaded each time it is drawn, so a
    // smaller one composites faster. It is opaque, and only the bands are
    // repainted, because only they reach the frame.
    const field = scratch(st, 'field', Math.ceil((x1 - x0) / 128) * 128, Math.ceil((y1 - y0) / 128) * 128, false);
    const b = field.getContext('2d');
    b.save();
    b.translate(-x0, -y0);
    b.fillStyle = GROUND;
    for (let i = 0; i < n * 4; i += 4) b.fillRect(r[i], r[i + 1], r[i + 2], r[i + 3]);
    softGround(b, st, c, px, pw, ph);
    drawColumns(b, st, c, px);
    b.restore();
    for (let i = 0; i < n * 4; i += 4) {
      ctx.drawImage(field, r[i] - x0, r[i + 1] - y0, r[i + 2], r[i + 3], r[i] / px, r[i + 1] / px, r[i + 2] / px, r[i + 3] / px);
    }
  },
});

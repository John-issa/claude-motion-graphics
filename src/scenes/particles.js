// Particle Typography: luminous particles whose every position is a
// closed-form function of t. A curl-noise swirl streams into the title, which
// holds under a light sweep, bursts in depth, gathers into a rotating 3D
// sphere, morphs into a torus, collapses into a vortex and leaves at warp speed.
//
// Rendering: particles are splatted additively (the 'lighter' look) into one
// RGBA buffer at output resolution, and only the rectangle that holds light is
// uploaded and composited. Here a sprite drawImage costs ~30 µs and full-frame
// composites are fill-rate bound, so thousands of glowSprite draws, or a
// per-frame bloom pass, would be far over budget; the buffer takes a few ms.

import {
  defineScene,
  createRandom,
  createNoise,
  hash2,
  textPoints,
  balanceLines,
  fitSize,
  font,
  makeCanvas,
  parse,
  palette,
  seg,
  ease,
  spring,
  smoothstep,
  pulse,
  TAU,
  DEFAULT_PARAMS,
} from '../engine/index.js';

// ---------------------------------------------------------------- constants

const N_TEXT = 6000; // particles that form the title
const N_DUST = 300; // dim motes for depth
const CX = 960;
const CY = 540;
const DT = 1 / 30; // streak shutter: a streak runs from p(t - DT) to p(t)

// Beats, in scene seconds.
const FORM = 0.8; // first departures from the swirl
const SWEEP = [2.42, 3.18]; // light sweep across the word's ink
const GLOW_IN = [2.12, 2.55]; // the word's light map fades up once it has formed...
const GLOW_OUT = [3.1, 3.36]; // ...and away during the inhale
const INHALE = [3.2, 3.44]; // anticipation before the burst
const BURST = 3.44;
const BURST_DUR = 0.8;
const BURST_SPAN = 1000; // design px: words wider than this burst from a base pulled in to it
const GATHER_DUR = 0.6;
const MORPH_DUR = 0.45;
const VORTEX_DUR = 0.34;
const WARP = 6.17;
const FLASH = WARP - 0.06; // the singularity flash starts as the vortex closes

// Swirl: a three-armed spiral disc, tilted and squashed, rotating differentially.
const DISC_SQUASH = 0.58;
const DISC_ROT = -0.2;
const ROT_C = Math.cos(DISC_ROT);
const ROT_S = Math.sin(DISC_ROT);
const TURB = 22; // curl-noise displacement, design px
const SWIRL_SHUTTER = 3.6; // longer streaks while swirling, so the flow reads in stills

// The word.
const SHIMMER = 1.6; // design px of jitter while the word holds
const SWEEP_SLANT = 0.42; // the sweep band leans like a glint: x shifts by this × (y - CY)

// 3D forms.
const SPHERE_R = 300;
const TORUS_R = 370;
const TORUS_TUBE = 84;
const FOCAL = 1500;
const TWIST = 2.2; // extra spin a particle picks up while it falls into the vortex
const GATHER_SWIRL = 0.7; // radians the gather paths orbit the form's axis
const FORM_GAIN = 0.62; // brightness of the 3D forms at the centre plane
const RISE = 52; // design px the camera rises so the tilted torus sits centred

// Look.
const INDIGO = '#3A2E9C';
const LIFT_RX = 600; // the indigo lift has compact support inside this ellipse,
const LIFT_RY = 290; // so the region beyond it never needs uploading
const MAX_STREAK = 48; // design px
const MAX_WARP_STREAK = 80; // warp lines may run longer
const RAMP = buildRamp([palette.cobalt, palette.violet, palette.pink], 256);
const lock = spring({ stiffness: 140, damping: 11 }); // the sphere's radius settles with a bounce

/** Smoothstep on [0, 1] progress: a cheap ease-in-out for per-particle hot paths. */
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

/** An envelope rescaled to reach 0 at `floor`, so it can stop being drawn without a pop. */
const above = (v, floor) => (v > floor ? (v - floor) / (1 - floor) : 0);

/** Flight ease: smooth departure, ~2% overshoot, settle. Cheap enough to call 12k times a frame. */
function flight(u) {
  if (u >= 1) return 1;
  const s = u * u * (3 - 2 * u) - 1;
  return 1 + 1.9 * s * s * s + 0.9 * s * s;
}

/** Colour ramp as a flat [r, g, b] lookup table; particles store offsets into it. */
function buildRamp(stops, n) {
  const cols = stops.map(parse);
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (cols.length - 1);
    const k = Math.min(cols.length - 2, Math.floor(x));
    const f = x - k;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = cols[k][c] + (cols[k + 1][c] - cols[k][c]) * f;
  }
  return out;
}

/** Ramp offset for a colour position u in 0..1. */
const rampAt = (u) => Math.round(255 * Math.min(1, Math.max(0, u))) * 3;

// ---------------------------------------------------------------- setup

/**
 * Curl noise sampled on an (x, y, t) grid, so particles read a smooth,
 * divergence-free flow with a cheap trilinear lookup instead of four noise3D
 * calls per particle per frame.
 */
function buildFlow(noise) {
  const F = { x0: -240, y0: -240, cell: 80, nx: 31, ny: 21, dt: 0.25, nt: 15 };
  F.v = new Float32Array(F.nx * F.ny * F.nt * 2);
  const c = [0, 0];
  let o = 0;
  for (let k = 0; k < F.nt; k++) {
    for (let j = 0; j < F.ny; j++) {
      for (let i = 0; i < F.nx; i++) {
        noise.curl2D((F.x0 + i * F.cell) / 320, (F.y0 + j * F.cell) / 320, k * F.dt * 0.32, c);
        F.v[o++] = c[0] * 0.5;
        F.v[o++] = c[1] * 0.5;
      }
    }
  }
  return F;
}

/** Trilinear lookup into the flow grid; writes [vx, vy] to out. */
function flowAt(F, x, y, t, out) {
  let gx = (x - F.x0) / F.cell;
  let gy = (y - F.y0) / F.cell;
  let gt = t / F.dt;
  gx = gx < 0 ? 0 : gx > F.nx - 1.001 ? F.nx - 1.001 : gx;
  gy = gy < 0 ? 0 : gy > F.ny - 1.001 ? F.ny - 1.001 : gy;
  gt = gt < 0 ? 0 : gt > F.nt - 1.001 ? F.nt - 1.001 : gt;
  const ix = gx | 0;
  const iy = gy | 0;
  const it = gt | 0;
  const fx = gx - ix;
  const fy = gy - iy;
  const ft = gt - it;
  const sy = F.nx * 2;
  const sz = F.nx * F.ny * 2;
  const v = F.v;
  let o = it * sz + iy * sy + ix * 2;
  for (let c = 0; c < 2; c++, o++) {
    const a = v[o] + (v[o + 2] - v[o]) * fx;
    const b = v[o + sy] + (v[o + sy + 2] - v[o + sy]) * fx;
    const p = v[o + sz] + (v[o + sz + 2] - v[o + sz]) * fx;
    const q = v[o + sz + sy] + (v[o + sz + sy + 2] - v[o + sz + sy]) * fx;
    const lo = a + (b - a) * fy;
    const hi = p + (q - p) * fy;
    out[c] = lo + (hi - lo) * ft;
  }
  return out;
}

/** The title as a point cloud: balanced onto 1-2 lines, fitted to ~76% width, centred on its ink. */
function titleCloud(title, seed) {
  const text = String(title ?? '').trim() || DEFAULT_PARAMS.title;
  const lines = balanceLines(text, 2);
  const probe = makeCanvas(4, 4).getContext('2d');
  const maxSize = lines.length > 1 ? 240 : 500;
  let size = maxSize;
  for (const ln of lines) size = Math.min(size, fitSize(probe, ln, 1460, { family: 'display', weight: 860, maxSize }));
  const pts = textPoints(lines.join('\n'), {
    font: font(size, 'display', 860),
    count: N_TEXT,
    leading: size * 1.1,
    seed: seed + 1,
  });
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  const ox = CX - (x0 + x1) / 2;
  const oy = CY - (y0 + y1) / 2;
  const xs = new Float32Array(N_TEXT);
  const ys = new Float32Array(N_TEXT);
  for (let i = 0; i < N_TEXT; i++) {
    xs[i] = pts[i * 2] + ox;
    ys[i] = pts[i * 2 + 1] + oy;
  }
  return { xs, ys, x0: x0 + ox, x1: x1 + ox, y0: y0 + oy, y1: y1 + oy, h: Math.max(40, y1 - y0) };
}

/**
 * A soft light map of the title: its point cloud splatted into an 8 px grid and
 * box-blurred three times (≈ Gaussian). Baked into the ground while the word
 * holds, it reads as bloom, which a per-frame blur could never afford. Also
 * measures the ink area, to normalise brightness across titles.
 */
function lightMap(T) {
  const C = 8;
  const gw = 1920 / C;
  const gh = 1080 / C;
  let a = new Float32Array(gw * gh);
  for (let i = 0; i < T.xs.length; i++) {
    const gx = T.xs[i] / C - 0.5;
    const gy = T.ys[i] / C - 0.5;
    const ix = Math.floor(gx);
    const iy = Math.floor(gy);
    if (ix < 0 || iy < 0 || ix >= gw - 1 || iy >= gh - 1) continue;
    const fx = gx - ix;
    const fy = gy - iy;
    const o = iy * gw + ix;
    a[o] += (1 - fx) * (1 - fy);
    a[o + 1] += fx * (1 - fy);
    a[o + gw] += (1 - fx) * fy;
    a[o + gw + 1] += fx * fy;
  }
  let ink = 0;
  for (let i = 0; i < a.length; i++) if (a[i] > 0.3) ink += C * C;
  let b = new Float32Array(gw * gh);
  for (let pass = 0; pass < 6; pass++) {
    const horizontal = pass % 2 === 0;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        let sum = 0;
        for (let k = -2; k <= 2; k++) {
          const xx = horizontal ? Math.min(gw - 1, Math.max(0, x + k)) : x;
          const yy = horizontal ? y : Math.min(gh - 1, Math.max(0, y + k));
          sum += a[yy * gw + xx];
        }
        b[y * gw + x] = sum / 5;
      }
    }
    [a, b] = [b, a];
  }
  let peak = 0;
  for (let i = 0; i < a.length; i++) peak = Math.max(peak, a[i]);
  for (let i = 0; i < a.length; i++) a[i] = Math.pow(a[i] / (peak || 1), 0.8); // lifts the soft edges
  const pad = 56;
  return { a, gw, gh, C, ink, x0: T.x0 - pad, x1: T.x1 + pad, y0: T.y0 - pad, y1: T.y1 + pad, tx0: T.x0, tx1: T.x1 };
}

/**
 * The light sweep's path. It crosses the ink, not the frame, so a short title
 * gets as long a pass as a long one; the band scales with the word and starts
 * and ends just clear of it, where its light has fallen below 1%.
 */
function sweepPath(T) {
  const band = Math.max(99, 0.09 * (T.x1 - T.x0)); // e-folding half-width, design px
  const reach = (SWEEP_SLANT * T.h) / 2 + 2.2 * band;
  return { x0: T.x0 - reach, x1: T.x1 + reach, k: 1 / (band * band) };
}

/** Indices sorted into vertical strips by x, then by y within each strip. */
function stripOrder(xs, ys, strips) {
  const n = xs.length;
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => xs[a] - xs[b]);
  const per = Math.ceil(n / strips);
  for (let s = 0; s < n; s += per) {
    const part = idx.slice(s, s + per).sort((a, b) => ys[a] - ys[b]);
    for (let k = 0; k < part.length; k++) idx[s + k] = part[k];
  }
  return idx;
}

/** Pair two equal point sets so neighbours map to neighbours (paths rarely cross). */
function pairUp(ax, ay, bx, by, strips) {
  const ia = stripOrder(ax, ay, strips);
  const ib = stripOrder(bx, by, strips);
  const map = new Int32Array(ax.length);
  for (let k = 0; k < ia.length; k++) map[ia[k]] = ib[k];
  return map;
}

/** Swirl homes: a bright bulge, three trailing log-spiral arms and a little inter-arm dust. */
function seedSwirl(st, rnd) {
  for (let i = 0; i < N_TEXT; i++) {
    const kind = rnd.next();
    let r;
    let a;
    if (kind < 0.11) {
      r = 5 + Math.abs(rnd.gauss()) * 52;
      a = rnd.next() * TAU;
    } else {
      const u = rnd.next();
      r = 45 + 500 * Math.pow(u, 1.3);
      if (kind < 0.86) {
        const arm = Math.floor(rnd.next() * 3) * (TAU / 3);
        a = arm - Math.log(r / 45) * 2.7 + rnd.gauss() * (0.1 + 0.05 * u);
        r += rnd.gauss() * (6 + 0.05 * r);
      } else {
        a = rnd.next() * TAU;
      }
    }
    st.gr[i] = r;
    st.ga[i] = a;
    st.gw[i] = 1.5 / (1 + r / 150); // inner rings turn faster, winding the arms
  }
}

/** Title targets and everything keyed to them: colour, timing, path bends, shimmer, burst, look, warp. */
function seedTitle(st, T, rnd, noise) {
  const sx = new Float32Array(N_TEXT);
  const sy = new Float32Array(N_TEXT);
  const tmp = [0, 0];
  for (let i = 0; i < N_TEXT; i++) {
    swirl(st, i, 1.1, tmp);
    sx[i] = tmp[0];
    sy[i] = tmp[1];
  }
  const toText = pairUp(sx, sy, T.xs, T.ys, 48);
  const span = Math.max(1, T.x1 - T.x0);
  // A wide word bursts from a base pulled toward the centre, so the cloud keeps
  // clear of the frame edges and the slug whatever the title's width.
  st.pull = Math.max(0, 1 - BURST_SPAN / span);
  for (let i = 0; i < N_TEXT; i++) {
    const j = toText[i];
    const tx = T.xs[j];
    const ty = T.ys[j];
    const xn = (tx - T.x0) / span;
    st.tx[i] = tx;
    st.ty[i] = ty;
    st.hue[i] = rampAt(0.03 + 0.94 * xn + rnd.gauss() * 0.04);
    // Staggered by target x so the word assembles left to right.
    st.dep[i] = FORM + 0.52 * xn + 0.08 * rnd.next();
    st.fl[i] = 0.78 + 0.2 * rnd.next();
    st.arr[i] = st.dep[i] + st.fl[i];
    // Curved path: bulge sideways in the direction the swirl was already turning.
    swirl(st, i, st.dep[i], tmp);
    const ddx = tx - tmp[0];
    const ddy = ty - tmp[1];
    const side = -ddy * -(tmp[1] - CY) + ddx * (tmp[0] - CX) >= 0 ? 1 : -1;
    const amt = side * (0.2 + 0.14 * noise.noise2D(tx / 260, ty / 260));
    st.cvx[i] = -ddy * amt;
    st.cvy[i] = ddx * amt;
    st.w1[i] = 5 + 6 * rnd.next();
    st.p1[i] = rnd.next() * TAU;
    st.w2[i] = 5 + 6 * rnd.next();
    st.p2[i] = rnd.next() * TAU;
    st.w3[i] = 3 + 6 * rnd.next();
    st.p3[i] = rnd.next() * TAU;
    // Burst: mostly up and down out of the letters, a little sideways (depth comes with the sphere).
    const bx = ((tx - CX) / (span / 2)) * 0.55;
    const by = (ty - CY) / (T.h / 2);
    const bl = Math.hypot(bx, by) || 1;
    const jit = rnd.gauss() * 0.3;
    const dist = (50 + 160 * Math.pow(rnd.next(), 0.9)) / bl;
    st.bvx[i] = (bx * Math.cos(jit) - by * Math.sin(jit)) * dist;
    st.bvy[i] = (bx * Math.sin(jit) + by * Math.cos(jit)) * dist;
    st.g0[i] = 3.52 + 0.18 * rnd.next();
    // Look: most particles are fine points, some carry a halo, a few a wide haze.
    // Cobalt reads darker than pink at equal energy, so the blue end gets a little more.
    st.lum[i] = (0.62 + 0.4 * Math.sqrt(rnd.next())) * (1.25 - 0.25 * xn);
    const tier = rnd.next();
    st.tier[i] = tier < 0.025 ? 2 : tier < 0.3 ? 1 : 0;
    st.trail[i] = st.tier[i] > 0 || (i & 7) === 0 ? 1 : 0; // draws a flow streak while swirling
    st.line[i] = st.trail[i] || rnd.next() < 0.3 ? 1 : 0; // draws motion streaks once it flies
    // Warp exit: a direction, a radius scale and when it passes the camera. A
    // few linger as the fading core, so its centre never goes hollow; they pass
    // late enough (T > 0.9 s) that none is still on screen when the scene ends.
    const wa = rnd.next() * TAU;
    st.wx[i] = Math.cos(wa);
    st.wy[i] = Math.sin(wa);
    const linger = rnd.next() < 0.07;
    st.ws[i] = linger ? 4 + 66 * rnd.next() : 70 * Math.exp(rnd.next() * Math.log(6));
    st.wT[i] = linger ? 0.9 + 0.6 * rnd.next() : 0.45 + 1.05 * rnd.next();
    st.wd[i] = 0.03 * rnd.next();
  }
}

/**
 * Fibonacci sphere targets (lightly jittered so the lattice doesn't read),
 * paired with where each particle is at the height of the burst, plus each
 * point's place on the torus and in the vortex.
 */
function seedForms(st, rnd) {
  const fx = new Float32Array(N_TEXT);
  const fy = new Float32Array(N_TEXT);
  const fz = new Float32Array(N_TEXT);
  const px = new Float32Array(N_TEXT);
  const py = new Float32Array(N_TEXT);
  const pz = new Float32Array(N_TEXT);
  const G = frameGlobals(4.0, {});
  const c = Math.cos(G.yaw);
  const s = Math.sin(G.yaw);
  for (let j = 0; j < N_TEXT; j++) {
    let y = 1 - (2 * (j + 0.5)) / N_TEXT;
    const r = Math.sqrt(1 - y * y);
    const th = j * 2.399963229728653; // golden angle
    const x = Math.cos(th) * r + rnd.gauss() * 0.012;
    const z = Math.sin(th) * r + rnd.gauss() * 0.012;
    y += rnd.gauss() * 0.012;
    const l = Math.hypot(x, y, z);
    fx[j] = x / l;
    fy[j] = y / l;
    fz[j] = z / l;
    // Where the point sits on screen, and in depth, as the gather lands.
    const xr = (fx[j] * c - fz[j] * s) * SPHERE_R;
    const zr = (fx[j] * s + fz[j] * c) * SPHERE_R;
    const y2 = fy[j] * SPHERE_R * G.ct - zr * G.st;
    const z2 = fy[j] * SPHERE_R * G.st + zr * G.ct;
    const k = FOCAL / (FOCAL + z2);
    px[j] = CX + xr * k;
    py[j] = G.cy + y2 * k;
    pz[j] = z2;
  }
  const bxs = new Float32Array(N_TEXT);
  const bys = new Float32Array(N_TEXT);
  const base = 1 - 0.97 * st.pull;
  for (let i = 0; i < N_TEXT; i++) {
    bxs[i] = CX + (st.tx[i] - CX) * base + st.bvx[i] * 0.97;
    bys[i] = CY + (st.ty[i] - CY) * base + st.bvy[i] * 0.97;
  }
  const toSphere = pairUp(bxs, bys, px, py, 40);
  for (let i = 0; i < N_TEXT; i++) {
    const j = toSphere[i];
    const r = Math.hypot(fx[j], fz[j]);
    st.sr[i] = r;
    st.sy[i] = fy[j];
    st.phi[i] = Math.atan2(fz[j], fx[j]);
    st.bvz[i] = 0.75 * pz[j] + rnd.gauss() * 40; // burst toward the depth it will land at
    // Sphere → torus: the poles fold through the middle to become the inner ring.
    const v = Math.PI - 2 * Math.acos(Math.max(-1, Math.min(1, -fy[j])));
    st.tr[i] = TORUS_R + TORUS_TUBE * Math.cos(v);
    st.ty3[i] = -TORUS_TUBE * Math.sin(v);
    // Tube shading, lit from above and outside: 0 where lit, up to 2 in shadow.
    st.shade[i] = 1 - Math.cos(v - 0.9);
    st.m0[i] = 4.72 + 0.2 * r; // poles open first
    // Vortex: staggered collapse, lightly modulated by azimuth so arms form as it winds up.
    st.c0[i] = 5.5 + 0.22 * rnd.next() + 0.1 * (0.5 + 0.5 * Math.sin(3 * st.phi[i]));
  }
}

/** Dust: a sparse, dim, slowly drifting depth layer, like motes in the central light. */
function seedDust(st, rnd) {
  for (let i = 0; i < N_DUST; i++) {
    const r = Math.sqrt(rnd.next());
    const a = rnd.next() * TAU;
    st.dx[i] = CX + 40 + r * Math.cos(a) * LIFT_RX;
    st.dy[i] = CY + 20 + r * Math.sin(a) * LIFT_RY;
    st.dz[i] = Math.pow(rnd.next(), 1.6);
    st.dh[i] = Math.floor(rnd.next() * 256) * 3;
    st.dp[i] = rnd.next() * TAU;
    st.dw[i] = 1.5 + 3 * rnd.next();
  }
}

/**
 * Renumber the particles in the word's strip order. Every pairing above keeps
 * neighbours together, so in each phase consecutive particles land near each
 * other and their splats share cache lines, which matters more than the maths.
 */
function renumber(st) {
  const order = stripOrder(st.tx, st.ty, 48);
  for (const key of Object.keys(st)) {
    const a = st[key];
    if (!ArrayBuffer.isView(a) || a.length !== N_TEXT) continue;
    const b = new a.constructor(N_TEXT);
    for (let k = 0; k < N_TEXT; k++) b[k] = a[order[k]];
    st[key] = b;
  }
}

/**
 * Draw a few frames covering every beat into a small private raster, so the
 * JIT has compiled the builders and the hot path before the first visible
 * frame: otherwise the iris opens on a stall of several dropped frames.
 */
function warmUp(st) {
  const R = makeRaster(0.2, null);
  for (const t of [0.5, 1.5, 2.8, 3.6, 4.0, 5.9, 6.3]) drawFrame(st, R, t);
}

function setup({ params, seed }) {
  const rnd = createRandom((seed >>> 0) * 7 + 11);
  const noise = createNoise((seed >>> 0) + 5);
  const f32 = () => new Float32Array(N_TEXT);
  const st = {
    flow: buildFlow(noise),
    light: null, // the title's light map
    sweep: null, // the light sweep's path across the ink
    dens: 1, // brightness scale for the word, from its ink area
    pull: 0, // how far the burst's base contracts toward the centre
    // swirl: polar home in the disc, angular speed
    gr: f32(), ga: f32(), gw: f32(),
    // title target, colour (ramp offset), departure and arrival, path bend
    tx: f32(), ty: f32(), hue: new Uint16Array(N_TEXT), dep: f32(), fl: f32(), arr: f32(), cvx: f32(), cvy: f32(),
    // shimmer oscillators
    w1: f32(), p1: f32(), w2: f32(), p2: f32(), w3: f32(), p3: f32(),
    // burst vector, gather start
    bvx: f32(), bvy: f32(), bvz: f32(), g0: f32(),
    // 3D: sphere (radial, height, azimuth), torus (radial, height, shading), morph and collapse starts
    sr: f32(), sy: f32(), phi: f32(), tr: f32(), ty3: f32(), shade: f32(), m0: f32(), c0: f32(),
    // warp: direction, radius scale, exit time, delay
    wx: f32(), wy: f32(), ws: f32(), wT: f32(), wd: f32(),
    // look
    lum: f32(), tier: new Uint8Array(N_TEXT), trail: new Uint8Array(N_TEXT), line: new Uint8Array(N_TEXT),
    // dust
    dx: new Float32Array(N_DUST), dy: new Float32Array(N_DUST), dz: new Float32Array(N_DUST),
    dh: new Uint16Array(N_DUST), dp: new Float32Array(N_DUST), dw: new Float32Array(N_DUST),
  };
  const T = titleCloud(params.title, seed >>> 0);
  st.light = lightMap(T);
  st.sweep = sweepPath(T);
  // Brightness follows the ink area each particle covers (the look was tuned at
  // 30.7 px² each): a short title packs them densely, so each glows less rather
  // than clipping; a big one spreads them, so each glows more.
  st.dens = Math.min(1.25, Math.max(0.45, Math.pow(st.light.ink / N_TEXT / 30.7, 0.6)));
  seedSwirl(st, rnd);
  seedTitle(st, T, rnd, noise);
  seedForms(st, rnd);
  seedDust(st, rnd);
  renumber(st);
  warmUp(st);
  return st;
}

// ---------------------------------------------------------------- motion

/** Values shared by every particle at time t. */
function frameGlobals(t, G) {
  G.t = t;
  G.scale = 1 - 0.045 * ease.inOutSine(seg(t, INHALE[0], INHALE[1])); // the inhale
  G.charge = 1 + 0.35 * ease.inQuad(seg(t, INHALE[0], BURST)) * (1 - seg(t, BURST, BURST + 0.3));
  G.shimmer = smoothstep(1.9, 2.5, t) * (1 - smoothstep(BURST, BURST + 0.2, t)) * SHIMMER;
  // The burst: its eased reach, and the curl turbulence's strength and clock.
  const ub = (t - BURST) / BURST_DUR;
  G.eb = ease.outExpo(ub);
  G.env = smoothstep(0, 0.3, ub) * 75;
  G.ft = 0.5 + 2.5 * (ub < 0 ? 0 : ub > 1 ? 1 : ub);
  const vx = t - 5.3;
  G.yaw = 1.1 * (t - 3.6) + (vx > 0 ? 1.7 * vx * vx : 0); // spins up into the vortex
  const tilt = 0.38 + 0.57 * ease.inOutCubic(seg(t, 4.8, 5.45)) + 0.25 * ease.inOutSine(seg(t, 5.5, 6.1));
  G.ct = Math.cos(tilt);
  G.st = Math.sin(tilt);
  G.rs = SPHERE_R * (0.86 + 0.14 * lock(t - 3.7));
  // Tilted, the torus's near side swells toward the camera; the camera rises
  // to keep it centred, then settles back onto the singularity as it collapses.
  G.cy = CY - RISE * ease.inOutSine(seg(t, 4.75, 5.4)) * (1 - ease.inOutSine(seg(t, 5.6, 6.12)));
  return G;
}

/** Screen position of the swirl for particle i at time t, curl turbulence included. */
function swirl(st, i, t, out) {
  const a = st.ga[i] + st.gw[i] * t;
  const dx = st.gr[i] * Math.cos(a);
  const dy = st.gr[i] * Math.sin(a) * DISC_SQUASH;
  const x = CX + dx * ROT_C - dy * ROT_S;
  const y = CY + dx * ROT_S + dy * ROT_C;
  flowAt(st.flow, x, y, t, out);
  out[0] = x + out[0] * TURB;
  out[1] = y + out[1] * TURB;
  return out;
}

/** Title position of particle i, with the shimmer and the pre-burst inhale. */
function textAt(st, i, G, out) {
  out[0] = CX + (st.tx[i] - CX) * G.scale;
  out[1] = CY + (st.ty[i] - CY) * G.scale;
  if (G.shimmer > 0) {
    out[0] += G.shimmer * Math.sin(G.t * st.w1[i] + st.p1[i]);
    out[1] += G.shimmer * Math.sin(G.t * st.w2[i] + st.p2[i]);
  }
}

/**
 * Camera-space position of particle i on its 3D form (sphere → torus →
 * vortex, spun about its axis and tilted toward the camera), written to W.
 * Returns a brightness factor: tube shading on the torus, a fade in the vortex.
 */
function form3(st, i, G, W) {
  const t = G.t;
  const em = smooth((t - st.m0[i]) / MORPH_DUR);
  const rs = G.rs * st.sr[i];
  const ys = G.rs * st.sy[i];
  let rho = rs + (st.tr[i] - rs) * em;
  let y = ys + (st.ty3[i] - ys) * em;
  let phi = st.phi[i] + G.yaw;
  let fade = 1 - 0.4 * em * st.shade[i];
  const uc = (t - st.c0[i]) / VORTEX_DUR;
  if (uc > 0) {
    // Falls faster as it nears the centre and spins up like water down a drain.
    const ec = uc >= 1 ? 1 : uc * uc;
    rho *= 1 - ec;
    y *= 1 - ec;
    phi += (TWIST * ec) / (1 - 0.7 * ec);
    // The shading melts away, and the crowd converging would otherwise saturate to white.
    fade = (fade + (1 - fade) * ec) * (1 - 0.45 * ec);
  }
  const x3 = rho * Math.cos(phi);
  const z3 = rho * Math.sin(phi);
  W[0] = x3;
  W[1] = y * G.ct - z3 * G.st;
  W[2] = y * G.st + z3 * G.ct;
  return fade;
}

/** Perspective projection of camera-space (x, y, z) about (CX, cy) into P: [x, y, depth brightness, scale]. */
function project(x, y, z, cy, P) {
  const k = FOCAL / (FOCAL + z);
  P[0] = CX + x * k;
  P[1] = cy + y * k;
  const dn = z / 320;
  P[2] = 1 - 0.62 * (dn < -1 ? -1 : dn > 1 ? 1 : dn); // nearer is brighter, the far side dim
  P[3] = k;
}

const W3 = [0, 0, 0];
const T2 = [0, 0];
const FL = [0, 0];

/** The 3D form of particle i, projected, then the warp exit. Writes P as in locate(). */
function formAt(st, i, G, P) {
  const tw = G.t - WARP - st.wd[i];
  if (tw > 0) {
    // Warp: flying at the camera, so the projected radius s·τ/(T − τ) starts
    // at the singularity, eases out, then accelerates and stretches into a line.
    const T = st.wT[i];
    const u = tw < T * 0.98 ? tw : T * 0.98;
    const r = (st.ws[i] * u) / (T - u);
    P[0] = CX + r * st.wx[i];
    P[1] = CY + r * st.wy[i];
    P[2] = 0.45 + 2 * tw; // dim while crowded at the core, brightening as it flies
    P[3] = 1;
    P[4] = 1;
    P[5] = 0;
    return;
  }
  const fade = form3(st, i, G, W3);
  project(W3[0], W3[1], W3[2], G.cy, P);
  P[2] *= FORM_GAIN * fade;
  P[4] = 0.55; // a shorter shutter keeps the spinning forms crisp
  P[5] = 1;
}

/**
 * Position of particle i at the time in G, as a closed-form function of t:
 * P = [x, y, brightness, perspective scale, streak shutter, weight on the 3D forms].
 */
function locate(st, i, G, P) {
  const t = G.t;
  P[4] = 1;
  P[5] = 0;
  if (t < st.arr[i]) {
    // Swirl, then a curved flight into the title.
    swirl(st, i, t, P);
    const u = (t - st.dep[i]) / st.fl[i];
    if (u > 0) {
      textAt(st, i, G, T2);
      const e = flight(u);
      const bump = 4 * u * (1 - u);
      P[0] += (T2[0] - P[0]) * e + st.cvx[i] * bump;
      P[1] += (T2[1] - P[1]) * e + st.cvy[i] * bump;
      P[2] = 0.85 + (st.dens - 0.85) * Math.min(1, e);
    } else P[2] = 0.85;
    P[3] = 1;
    P[4] = st.trail[i] ? 1 + (SWIRL_SHUTTER - 1) * (1 - smoothstep(0, 0.3, u)) : 1;
    return;
  }
  const ug = (t - st.g0[i]) / GATHER_DUR;
  if (ug >= 1) {
    formAt(st, i, G, P);
    return;
  }
  textAt(st, i, G, T2);
  if (t < BURST) {
    P[0] = T2[0];
    P[1] = T2[1];
    P[2] = (0.84 + 0.16 * Math.sin(t * st.w3[i] + st.p3[i])) * G.charge * st.dens;
    P[3] = 1;
    return;
  }
  // Burst outward in depth, stirred by the curl field like smoke...
  const eb = G.eb;
  const env = G.env;
  flowAt(st.flow, T2[0], T2[1], G.ft, FL);
  const base = 1 - st.pull * eb;
  let x = (T2[0] - CX) * base + st.bvx[i] * eb + FL[0] * env;
  let y = (T2[1] - CY) * base + st.bvy[i] * eb + FL[1] * env;
  let z = st.bvz[i] * eb;
  let gain = G.charge * (st.dens + (1 - st.dens) * eb);
  let e = 0;
  if (ug > 0) {
    // ...then gather into the 3D form, orbiting its axis on the way in.
    const fade = form3(st, i, G, W3);
    e = smooth(ug);
    x += (W3[0] - x) * e;
    y += (W3[1] - y) * e;
    z += (W3[2] - z) * e;
    const sw = GATHER_SWIRL * Math.sin(Math.PI * e);
    const c = Math.cos(sw);
    const s = Math.sin(sw);
    const xr = x * c - z * s;
    z = x * s + z * c;
    x = xr;
    gain += (FORM_GAIN * fade - gain) * e;
  }
  project(x, y, z, G.cy, P);
  P[2] *= gain;
  P[4] = 1 - 0.45 * e;
  P[5] = e;
}

// ---------------------------------------------------------------- raster

const rasters = new Map();

/**
 * Splat buffer, ground and kernels for physical scale px. With a canvas it can
 * present; without one it is a private scratch raster for warmUp.
 */
function makeRaster(px, canvas) {
  const pw = Math.round(1920 * px);
  const ph = Math.round(1080 * px);
  const c2 = canvas ? canvas.getContext('2d', { willReadFrequently: true }) : null;
  const img = c2 ? c2.createImageData(pw, ph) : null;
  const data = img ? img.data : new Uint8ClampedArray(pw * ph * 4);
  const bg = ground(pw, ph);
  return {
    pw, ph, px, canvas, c2, img, data,
    data32: new Uint32Array(data.buffer, data.byteOffset, pw * ph), // whole-pixel views
    bg,
    bg32: new Uint32Array(bg.buffer),
    core: kernel(2.2, px),
    halo: kernel(5, px),
    haze: kernel(12, px),
    dirty: { x0: 0, y0: 0, x1: pw, y1: ph }, // where the last frame drew: everything, at first
    glow: null, // the word's bloom, built for one title at a time
  };
}

/** The raster for an output size, cached (the last few sizes only). */
function raster(px) {
  const key = `${Math.round(1920 * px)}x${Math.round(1080 * px)}`;
  let R = rasters.get(key);
  if (R) return R;
  R = makeRaster(px, makeCanvas(Math.round(1920 * px), Math.round(1080 * px)));
  if (rasters.size >= 3) rasters.clear();
  rasters.set(key, R);
  return R;
}

/** How much of the indigo lift reaches design point (x, y): 1 at the centre, 0 at the ellipse rim. */
function liftAt(x, y) {
  const dx = (x - CX) / LIFT_RX;
  const dy = (y - CY) / LIFT_RY;
  const q = 1 - dx * dx - dy * dy;
  return q > 0 ? q * q : 0;
}

/** A 64×64 tile of triangular dither in -1..1, tiled across the ground. */
const DITHER = (() => {
  const d = new Float32Array(64 * 64);
  for (let i = 0; i < d.length; i++) d[i] = hash2(i & 63, i >> 6, 7) + hash2(i & 63, i >> 6, 8) - 1;
  return d;
})();

/** Night ground with a soft indigo lift toward the centre, dithered against banding. */
function ground(pw, ph) {
  const bg = new Uint8ClampedArray(pw * ph * 4);
  const n = parse(palette.night);
  const c = parse(INDIGO);
  const k = 1920 / pw;
  const row = pw * 4;
  // Plain dithered night: 64 rows, then copied down the frame (the dither tiles every 64 px).
  for (let y = 0; y < Math.min(64, ph); y++) {
    for (let x = 0; x < pw; x++) {
      const dither = DITHER[(y << 6) | (x & 63)];
      const o = y * row + x * 4;
      bg[o] = n[0] + dither;
      bg[o + 1] = n[1] + dither;
      bg[o + 2] = n[2] + dither;
      bg[o + 3] = 255;
    }
  }
  for (let y = 64; y < ph; y++) bg.copyWithin(y * row, (y & 63) * row, ((y & 63) + 1) * row);
  // The lift, only inside its ellipse's rectangle.
  const x0 = Math.max(0, Math.floor((CX - LIFT_RX) / k));
  const x1 = Math.min(pw, Math.ceil((CX + LIFT_RX) / k));
  const y0 = Math.max(0, Math.floor((CY - LIFT_RY) / k));
  const y1 = Math.min(ph, Math.ceil((CY + LIFT_RY) / k));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const lift = 0.2 * liftAt((x + 0.5) * k, (y + 0.5) * k);
      if (lift <= 0) continue;
      const o = y * row + x * 4;
      const dither = DITHER[((y & 63) << 6) | (x & 63)];
      bg[o] = n[0] + (c[0] - n[0]) * lift + dither;
      bg[o + 1] = n[1] + (c[1] - n[1]) * lift + dither;
      bg[o + 2] = n[2] + (c[2] - n[2]) * lift + dither;
    }
  }
  return bg;
}

/**
 * The word's bloom at this output size: its light map coloured along the ramp,
 * as light to add to the ground over the light map's rectangle, one 32-bit
 * pixel per entry. Each channel is limited to what the ground leaves below 255,
 * so it can be scaled and added without clamping (see lightWord). Kept on the
 * raster, so it is evicted with it.
 */
function wordGlow(st, R) {
  const M = st.light;
  if (R.glow && R.glow.M === M) return R.glow;
  const k = R.px;
  const x0 = Math.max(0, Math.floor(M.x0 * k));
  const y0 = Math.max(0, Math.floor(M.y0 * k));
  const w = Math.min(R.pw, Math.ceil(M.x1 * k)) - x0;
  const h = Math.min(R.ph, Math.ceil(M.y1 * k)) - y0;
  const data = new Uint8ClampedArray(w * h * 4);
  const span = Math.max(1, M.tx1 - M.tx0);
  const a = M.a;
  // Per-column lookups: grid cell, blend and ramp colour depend only on x.
  const cix = new Int32Array(w);
  const cfx = new Float32Array(w);
  const chq = new Int32Array(w);
  for (let x = 0; x < w; x++) {
    const X = (x0 + x + 0.5) / k;
    const gx = X / M.C - 0.5;
    cix[x] = Math.min(M.gw - 2, Math.max(0, Math.floor(gx)));
    cfx[x] = Math.min(1, Math.max(0, gx - cix[x]));
    chq[x] = rampAt(0.03 + (0.94 * (X - M.tx0)) / span);
  }
  for (let y = 0; y < h; y++) {
    const gy = (y0 + y + 0.5) / k / M.C - 0.5;
    const iy = Math.min(M.gh - 2, Math.max(0, Math.floor(gy)));
    const fy = Math.min(1, Math.max(0, gy - iy));
    for (let x = 0; x < w; x++) {
      const fx = cfx[x];
      const o = iy * M.gw + cix[x];
      const v = (a[o] * (1 - fx) + a[o + 1] * fx) * (1 - fy) + (a[o + M.gw] * (1 - fx) + a[o + M.gw + 1] * fx) * fy;
      const hq = chq[x];
      const e = 0.42 * v;
      const src = ((y0 + y) * R.pw + x0 + x) * 4;
      const dst = (y * w + x) * 4;
      data[dst] = Math.min(255 - R.bg[src], RAMP[hq] * e);
      data[dst + 1] = Math.min(255 - R.bg[src + 1], RAMP[hq + 1] * e);
      data[dst + 2] = Math.min(255 - R.bg[src + 2], RAMP[hq + 2] * e);
    }
  }
  R.glow = { M, x0, y0, w, h, light: new Uint32Array(data.buffer) };
  return R.glow;
}

/**
 * Splat kernels for a soft dot of radius `radius` design px: a compact
 * (1 - d²/ρ²)² falloff, one kernel per 4×4 sub-pixel phase so slow particles
 * glide instead of snapping to pixels. Each kernel sums to 1, and `energy`
 * converts a peak brightness into that sum at this resolution.
 */
function kernel(radius, px) {
  const rho = Math.max(1.05, radius * px); // never sharper than about a pixel
  const rad = Math.max(1, Math.floor(rho + 0.5));
  const K = 2 * rad + 1;
  const w = [];
  for (let py = 0; py < 4; py++) {
    for (let qx = 0; qx < 4; qx++) {
      const fx = (qx + 0.5) / 4;
      const fy = (py + 0.5) / 4;
      const a = new Float32Array(K * K);
      let sum = 0;
      for (let y = 0; y < K; y++) {
        for (let x = 0; x < K; x++) {
          const dx = x - rad + 0.5 - fx;
          const dy = y - rad + 0.5 - fy;
          const q = Math.max(0, 1 - (dx * dx + dy * dy) / (rho * rho));
          a[y * K + x] = q * q;
          sum += q * q;
        }
      }
      for (let k = 0; k < a.length; k++) a[k] /= sum;
      w.push(a);
    }
  }
  return { rad, K, w, energy: (Math.PI * rho * rho) / 3 };
}

/** Add kernel S centred at physical (x, y). r, g, b are colour × energy; the buffer clamps like 'lighter'. */
function splat(R, S, x, y, r, g, b) {
  const rad = S.rad;
  const K = S.K;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const x0 = ix - rad;
  const y0 = iy - rad;
  const pw = R.pw;
  if (x0 + K <= 0 || y0 + K <= 0 || x0 >= pw || y0 >= R.ph) return;
  const w = S.w[(((y - iy) * 4) | 0) * 4 + (((x - ix) * 4) | 0)];
  const d = R.data;
  if (x0 < 0 || y0 < 0 || x0 + K > pw || y0 + K > R.ph) {
    for (let yy = 0; yy < K; yy++) {
      const Y = y0 + yy;
      if (Y < 0 || Y >= R.ph) continue;
      for (let xx = 0; xx < K; xx++) {
        const X = x0 + xx;
        if (X < 0 || X >= pw) continue;
        const v = w[yy * K + xx];
        const o = (Y * pw + X) * 4;
        d[o] += r * v;
        d[o + 1] += g * v;
        d[o + 2] += b * v;
      }
    }
    return;
  }
  let o = (y0 * pw + x0) * 4;
  if (K === 3) {
    // The common case at preview sizes: a 3×3 core, unrolled.
    const row = pw * 4 - 12;
    for (let k = 0; k < 9; k += 3, o += row) {
      let v = w[k];
      d[o] += r * v;
      d[o + 1] += g * v;
      d[o + 2] += b * v;
      v = w[k + 1];
      d[o + 4] += r * v;
      d[o + 5] += g * v;
      d[o + 6] += b * v;
      v = w[k + 2];
      d[o + 8] += r * v;
      d[o + 9] += g * v;
      d[o + 10] += b * v;
      o += 12;
    }
    return;
  }
  const skip = (pw - K) * 4;
  let k = 0;
  for (let yy = 0; yy < K; yy++, o += skip) {
    for (let xx = 0; xx < K; xx++, o += 4, k++) {
      const v = w[k];
      if (v === 0) continue;
      d[o] += r * v;
      d[o + 1] += g * v;
      d[o + 2] += b * v;
    }
  }
}

/**
 * Additive anti-aliased line from tail (x0, y0) to head (x1, y1), brightening
 * toward the head: a motion streak. r, g, b are the per-pixel colour at the head.
 */
function streak(R, x0, y0, x1, y1, r, g, b) {
  const d = R.data;
  const pw = R.pw;
  const ph = R.ph;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const n = Math.ceil(Math.max(adx, ady));
  if (n < 1) return;
  if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 >= pw && x1 >= pw) || (y0 >= ph && y1 >= ph)) return;
  const sx = dx / n;
  const sy = dy / n;
  const inv = 1 / (n * n);
  if (adx >= ady) {
    // x-major: each step covers two rows, weighted by the sub-pixel y.
    let x = x0;
    let y = y0 - 0.5;
    for (let k = 1; k <= n; k++) {
      x += sx;
      y += sy;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (ix < 0 || ix >= pw || iy < 0 || iy >= ph - 1) continue;
      const a = k * k * inv;
      const w1 = a * (y - iy);
      const w0 = a - w1;
      let o = (iy * pw + ix) * 4;
      d[o] += r * w0;
      d[o + 1] += g * w0;
      d[o + 2] += b * w0;
      o += pw * 4;
      d[o] += r * w1;
      d[o + 1] += g * w1;
      d[o + 2] += b * w1;
    }
  } else {
    // y-major: each step covers two columns.
    let x = x0 - 0.5;
    let y = y0;
    for (let k = 1; k <= n; k++) {
      x += sx;
      y += sy;
      const ix = Math.floor(x);
      const iy = Math.floor(y);
      if (ix < 0 || ix >= pw - 1 || iy < 0 || iy >= ph) continue;
      const a = k * k * inv;
      const w1 = a * (x - ix);
      const w0 = a - w1;
      const o = (iy * pw + ix) * 4;
      d[o] += r * w0;
      d[o + 1] += g * w0;
      d[o + 2] += b * w0;
      d[o + 4] += r * w1;
      d[o + 5] += g * w1;
      d[o + 6] += b * w1;
    }
  }
}

// Singularity flash: radial falloffs tabulated over s = d²/radius², 0..1.
const FLASH_N = 2048;
const BLOOM_R = 280; // design px
const PIN_R = 64;
const LINE_R = 470; // half-length of the anamorphic streak
const falloff = (fn) => Float32Array.from({ length: FLASH_N }, (_, i) => fn(i / FLASH_N));
const BLOOM = falloff((s) => (1 - s) ** 2 * (0.3 * (1 - s) ** 2 + 0.7 / (1 + 80 * s))); // a peaked glow, soft skirt
const PIN = falloff((s) => (1 - s) ** 14); // the white-hot point

/** Additive bloom and pinpoint, centred on the frame, in one pass over the bloom's disc. */
function radialFlash(R, bloom, pin) {
  const k = R.px;
  const cx = CX * k;
  const cy = CY * k;
  const rb = BLOOM_R * k;
  const sb = FLASH_N / (rb * rb);
  const sp = sb * (BLOOM_R / PIN_R) ** 2;
  const vi = parse(palette.violet);
  const a = 0.85 * bloom;
  const cr = (vi[0] * 0.6 + 100) * a;
  const cg = (vi[1] * 0.6 + 100) * a;
  const cb = (vi[2] * 0.6 + 100) * a;
  const white = 380 * pin;
  const d = R.data;
  const y0 = Math.max(0, Math.floor(cy - rb));
  const y1 = Math.min(R.ph, Math.ceil(cy + rb));
  for (let y = y0; y < y1; y++) {
    const dy = y + 0.5 - cy;
    const half = Math.sqrt(Math.max(0, rb * rb - dy * dy));
    const x0 = Math.max(0, Math.floor(cx - half));
    const x1 = Math.min(R.pw, Math.ceil(cx + half));
    let o = (y * R.pw + x0) * 4;
    for (let x = x0; x < x1; x++, o += 4) {
      const dx = x + 0.5 - cx;
      const d2 = dx * dx + dy * dy;
      const ib = d2 * sb;
      if (ib >= FLASH_N) continue;
      const w = BLOOM[ib | 0];
      const ip = d2 * sp;
      const p = ip < FLASH_N ? white * PIN[ip | 0] : 0;
      d[o] += cr * w + p;
      d[o + 1] += cg * w + p;
      d[o + 2] += cb * w + p;
    }
  }
  grow(CX - BLOOM_R, CY - BLOOM_R);
  grow(CX + BLOOM_R, CY + BLOOM_R);
}

/** A thin horizontal anamorphic streak through the singularity, about two pixels tall at any size. */
function anamorphic(R, a) {
  const k = R.px;
  const cx = CX * k;
  const cy = CY * k;
  const half = LINE_R * k;
  const amp = 1.9 * a;
  const d = R.data;
  const x0 = Math.max(0, Math.floor(cx - half));
  const x1 = Math.min(R.pw, Math.ceil(cx + half));
  for (let y = Math.max(0, Math.floor(cy - 2)); y < Math.min(R.ph, Math.ceil(cy + 2)); y++) {
    const dy = Math.abs(y + 0.5 - cy) / 2.2;
    const wy = amp * (1 - dy) * (1 - dy);
    let o = (y * R.pw + x0) * 4;
    for (let x = x0; x < x1; x++, o += 4) {
      const q = 1 - Math.abs(x + 0.5 - cx) / half;
      if (q <= 0) continue;
      const w = wy * q * q * q;
      d[o] += 190 * w;
      d[o + 1] += 178 * w;
      d[o + 2] += 255 * w;
    }
  }
  grow(CX - LINE_R, CY - 3);
  grow(CX + LINE_R, CY + 3);
}

// ---------------------------------------------------------------- frame

const G1 = {};
const G0 = {};
const P1 = new Float64Array(6);
const P0 = new Float64Array(6);
const box = { x0: 0, y0: 0, x1: 0, y1: 0 }; // design-space bounds of everything lit this frame

function grow(x, y) {
  if (x < box.x0) box.x0 = x;
  if (x > box.x1) box.x1 = x;
  if (y < box.y0) box.y0 = y;
  if (y > box.y1) box.y1 = y;
}

/**
 * Reset the buffer to the ground. Only the last frame's dirty rectangle has
 * anything else in it, so only that is copied back.
 */
function clearBuffer(R) {
  const D = R.dirty;
  const row = R.pw * 4;
  if (D.x0 === 0 && D.x1 === R.pw) {
    R.data.set(R.bg.subarray(D.y0 * row, D.y1 * row), D.y0 * row);
  } else {
    for (let y = D.y0; y < D.y1; y++) R.data.set(R.bg.subarray(y * row + D.x0 * 4, y * row + D.x1 * 4), y * row + D.x0 * 4);
  }
  // Until present() records this frame's bounds, treat the whole buffer as dirty.
  D.x0 = 0;
  D.y0 = 0;
  D.x1 = R.pw;
  D.y1 = R.ph;
}

/**
 * Add the word's bloom into the buffer while it holds. The buffer is plain
 * ground here, so each pixel is ground + light × glow, computed on whole
 * 32-bit pixels: two channels per multiply, in 8.8 fixed point.
 */
function lightWord(st, R, t) {
  const L = wordGlow(st, R); // built on the first frame at this size, so the hold never hitches
  const glow = smooth((t - GLOW_IN[0]) / (GLOW_IN[1] - GLOW_IN[0])) * (1 - smooth((t - GLOW_OUT[0]) / (GLOW_OUT[1] - GLOW_OUT[0])));
  if (glow <= 0.004) return;
  const g = Math.round(glow * 256);
  const A = L.light;
  const B = R.bg32;
  const D = R.data32;
  for (let y = 0, j = 0; y < L.h; y++) {
    let o = (L.y0 + y) * R.pw + L.x0;
    for (let x = 0; x < L.w; x++, o++, j++) {
      const a = A[j];
      D[o] = B[o] + ((((a & 0xff00ff) * g) >>> 8) & 0xff00ff) + ((((a >>> 8) & 0xff00ff) * g) & 0xff00ff00);
    }
  }
  grow(L.x0 / R.px, L.y0 / R.px);
  grow((L.x0 + L.w) / R.px, (L.y0 + L.h) / R.px);
}

/** The title particles: a core for each, halos and haze for some, streaks for the fast ones. */
function drawParticles(st, R, t, dt) {
  const k = R.px;
  const coreE = R.core.energy;
  const haloE = R.halo.energy * 0.26;
  const hazeE = R.haze.energy * 0.07;
  const lineK = Math.min(1, k * 1.5); // streaks are ~1 px wide; thin them at small sizes
  const S = st.sweep;
  const us = seg(t, SWEEP[0], SWEEP[1]);
  const sweepOn = us > 0 && us < 1;
  const sweepX = S.x0 + (S.x1 - S.x0) * (0.5 * us + 0.5 * ease.inOutSine(us)); // near-even pace, soft ends
  const warp = t > WARP;
  for (let i = 0; i < N_TEXT; i++) {
    locate(st, i, G1, P1);
    const x = P1[0];
    const y = P1[1];
    grow(x, y);
    // Velocity (streaks and heat) only for the ~60% of particles that draw lines,
    // and never while resting: in the title, or on the sphere before it morphs,
    // where streaks would be under a pixel. Streaks overlap, so the rest are not missed.
    const flying = t < st.arr[i];
    let mx = 0;
    let my = 0;
    let move = 0;
    if (flying ? st.trail[i] || (t > st.dep[i] && st.line[i]) : t >= BURST && st.line[i] && (t < st.g0[i] + GATHER_DUR || t > st.m0[i])) {
      locate(st, i, G0, P0);
      mx = x - P0[0];
      my = y - P0[1];
      move = Math.hypot(mx, my);
    }
    // White-hot cores on the fastest particles, judged against each phase's own speeds.
    let heat = 0;
    if (move > 0) {
      const v = move / dt;
      if (flying) heat = 0.7 * smoothstep(520, 1400, v); // streaming into the word
      else if (t < st.g0[i]) heat = smoothstep(900, 2200, v); // the burst's release
      else heat = 0.7 * smoothstep(1800, 6000, v); // gather, vortex and warp
    }
    let I = st.lum[i] * P1[2] * P1[3] * P1[3];
    if (sweepOn) {
      const dd = x - sweepX + (y - CY) * SWEEP_SLANT;
      const boost = Math.exp(-dd * dd * S.k);
      I *= 1 + 1.2 * boost;
      heat += 0.6 * boost;
    }
    if (heat > 1) heat = 1;
    const h = st.hue[i];
    const r = RAMP[h];
    const g = RAMP[h + 1];
    const b = RAMP[h + 2];
    const hx = x * k;
    const hy = y * k;
    const e = I * coreE;
    splat(R, R.core, hx, hy, (r + (255 - r) * heat) * e, (g + (255 - g) * heat) * e, (b + (255 - b) * heat) * e);
    // Halos: a fixed few, except on the 3D forms, where they follow depth so
    // near points swell and the far side stays fine. Warp lines stay crisp.
    let hw = warp ? 0 : st.tier[i] > 0 ? 1 : 0;
    let zw = warp ? 0 : st.tier[i] === 2 ? 1 : 0;
    const f = P1[5];
    if (f > 0) {
      const near = smoothstep(1.06, 1.24, P1[3]);
      hw += (1.6 * near - hw) * f;
      zw *= 1 - f * (1 - near);
    }
    if (hw > 0.01) {
      const eh = I * haloE * hw;
      splat(R, R.halo, hx, hy, r * eh, g * eh, b * eh);
    }
    if (zw > 0.01) {
      const ez = I * hazeE * zw;
      splat(R, R.haze, hx, hy, r * ez, g * ez, b * ez);
    }
    // Motion streak from where the particle was a shutter ago, clipped to a maximum length.
    const len = move * P1[4];
    if (len > 6) {
      const a = smoothstep(6, 20, len) * I * (P1[4] < 1 ? 0.36 : warp ? 0.95 : 0.6) * lineK;
      const cut = Math.min(len, warp ? MAX_WARP_STREAK : MAX_STREAK) / move;
      const tx = x - mx * cut;
      const ty = y - my * cut;
      grow(tx, ty);
      const warm = heat * 0.6; // heads go white, tails keep their colour
      streak(R, tx * k, ty * k, hx, hy, (r + (255 - r) * warm) * a, (g + (255 - g) * warm) * a, (b + (255 - b) * warm) * a);
    }
  }
}

/** Dust: dim motes drifting in the central light; at the end they streak outward like stars at warp. */
function drawDust(st, R, t, dt) {
  const k = R.px;
  const coreE = R.core.energy;
  const lineK = Math.min(1, k * 1.5);
  const tw = t - WARP;
  for (let i = 0; i < N_DUST; i++) {
    const z = st.dz[i];
    const drift = 4 + 10 * z;
    let x = st.dx[i] - drift * t * 0.8;
    let y = st.dy[i] - drift * t * 0.35;
    const lit = liftAt(x, y);
    let x0 = x;
    let y0 = y;
    if (tw > 0) {
      const f = (0.8 + 2.2 * z) * 2.4; // nearer motes rush past faster
      const tp = Math.max(0, tw - dt);
      x0 = CX + (x - CX) * (1 + f * tp * tp);
      y0 = CY + (y - CY) * (1 + f * tp * tp);
      x = CX + (x - CX) * (1 + f * tw * tw);
      y = CY + (y - CY) * (1 + f * tw * tw);
      grow(x0, y0);
    } else if (lit <= 0) continue;
    grow(x, y);
    const I = (0.15 + 0.35 * z) * Math.sqrt(lit) * (0.75 + 0.25 * Math.sin(t * st.dw[i] + st.dp[i])) * (tw > 0 ? 1 + 2.5 * tw : 1);
    const h = st.dh[i];
    const e = I * coreE;
    const r = RAMP[h] * 0.7 + 70;
    const g = RAMP[h + 1] * 0.7 + 70;
    const b = RAMP[h + 2] * 0.7 + 70;
    splat(R, R.core, x * k, y * k, r * e, g * e, b * e);
    if (tw > 0) {
      const a = I * 0.8 * lineK;
      streak(R, x0 * k, y0 * k, x * k, y * k, r * a, g * a, b * a);
    }
  }
}

/**
 * Singularity flash as the vortex closes: a violet bloom with a white-hot
 * pinpoint and a thin anamorphic streak, each on its own quick decay.
 */
function drawFlash(R, t) {
  const bloom = above(pulse(t, FLASH, 0.08, 0.15), 0.06);
  const pin = above(pulse(t, FLASH + 0.02, 0.06, 0.08), 0.02);
  const line = above(pulse(t, FLASH + 0.02, 0.05, 0.12), 0.02);
  if (bloom > 0 || pin > 0) radialFlash(R, bloom, pin);
  if (line > 0) anamorphic(R, line);
}

/** Everything lit at time t, into the raster's buffer; box ends up bounding it. dt is the streak shutter. */
function drawFrame(st, R, t, dt = DT) {
  frameGlobals(t, G1);
  frameGlobals(t - dt, G0);
  clearBuffer(R);
  box.x0 = CX - LIFT_RX;
  box.x1 = CX + LIFT_RX;
  box.y0 = CY - LIFT_RY;
  box.y1 = CY + LIFT_RY;
  lightWord(st, R, t);
  drawParticles(st, R, t, dt);
  drawDust(st, R, t, dt);
  drawFlash(R, t);
}

/** Upload and composite only the lit rectangle, in whole pixels (1:1, so no resampling). */
function present(ctx, R) {
  const k = R.px;
  const pad = R.haze.rad + 2;
  const x0 = Math.max(0, Math.floor(box.x0 * k) - pad);
  const y0 = Math.max(0, Math.floor(box.y0 * k) - pad);
  const x1 = Math.min(R.pw, Math.ceil(box.x1 * k) + pad);
  const y1 = Math.min(R.ph, Math.ceil(box.y1 * k) + pad);
  if (x1 <= x0 || y1 <= y0) return;
  R.c2.putImageData(R.img, 0, 0, x0, y0, x1 - x0, y1 - y0);
  ctx.drawImage(R.canvas, x0, y0, x1 - x0, y1 - y0, x0 / k, y0 / k, (x1 - x0) / k, (y1 - y0) / k);
  const D = R.dirty;
  D.x0 = x0;
  D.y0 = y0;
  D.x1 = x1;
  D.y1 = y1;
}

export default defineScene({
  id: 'particles',
  title: 'Particle Typography',
  duration: 7.0,
  poster: 2.8,
  color: '#7B5CFF',
  transition: { type: 'iris', duration: 0.8, color: '#EFEBE3' },
  // Film grain is an 'overlay' pass that is invisible on a near-black ground
  // and costs a full-frame composite; the splat buffer carries its own dither.
  post: { grain: 0 },
  notes: [
    '6,300 particles in closed form',
    'Curl-noise flow field',
    'Text sampled into a point cloud',
    '3D sphere and torus in perspective',
    'Additive light, splatted in one pass',
  ],
  poster: 2.8, // the word held, the glint crossing it
  uses: ['title', 'seed'],
  uses: ['title', 'seed'],
  /** Sound on the scene's beats (stage starts are seeded within narrow windows). */
  cues: () => [
    { t: FORM, kind: 'whoosh', dur: 1.1, strength: 0.4 }, // streams leave the swirl
    { t: GLOW_IN[0], kind: 'land', strength: 0.7 }, // the word has formed
    { t: SWEEP[0], kind: 'shimmer', strength: 0.8 }, // light sweeps the ink
    { t: INHALE[0], kind: 'swell', dur: INHALE[1] - INHALE[0], strength: 0.6 }, // anticipation
    { t: BURST, kind: 'hit', strength: 0.9 },
    { t: 4.25, kind: 'land', strength: 0.6 }, // the sphere closes (gathers end 4.12-4.3 s)
    { t: 4.72, kind: 'whoosh', dur: MORPH_DUR, strength: 0.35 }, // the sphere opens into a ring
    { t: 5.5, kind: 'swell', dur: 0.6, strength: 0.6 }, // the vortex draws in
    { t: FLASH, kind: 'hit', strength: 1.0 }, // singularity flash, then warp
  ],
  setup,
  cues() {
    return [
      { t: 0.95, kind: 'whoosh', dur: 1.1, dir: 'up', strength: 0.3 }, // the galaxy unravels into streams
      // The word lands left to right: a pluck as each third of it settles.
      { t: 1.81, kind: 'land', strength: 0.45 },
      { t: 1.98, kind: 'land', strength: 0.5 },
      { t: 2.15, kind: 'land', strength: 0.6 },
      { t: 2.52, kind: 'shimmer', strength: 0.6 }, // the glint reaches the ink
      { t: 3.2, kind: 'swell', dur: 0.24, strength: 0.6 }, // the inhale...
      { t: BURST, kind: 'hit', strength: 0.8 }, // ...and the burst
      { t: 4.05, kind: 'land', strength: 0.55 }, // the sphere locks on its spring
      { t: 4.75, kind: 'whoosh', dur: 0.6, dir: 'up', strength: 0.25 }, // the poles open into the torus
      { t: 5.55, kind: 'swell', dur: 0.56, strength: 0.7 }, // the vortex winds up...
      { t: FLASH, kind: 'hit', strength: 0.9 }, // ...into the singularity
    ];
  },
  render(ctx, s) {
    const R = raster(s.px);
    // Flat night everywhere (a cheap clear); the buffer is uploaded only where
    // there is light: the lift, plus the bounds of everything splatted.
    ctx.fillStyle = palette.night;
    ctx.fillRect(0, 0, s.W, s.H);
    // Under the reel's motion blur the sub-frames already smear across half a
    // frame (its default shutter), so the streaks drawn here shorten by that much.
    drawFrame(s.state, R, s.t, s.motionBlur > 1 ? DT - 0.5 / s.fps : DT);
    present(ctx, R);
  },
});

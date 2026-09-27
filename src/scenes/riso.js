// Overprint: a risograph print come to life.
//
// Fluorescent pink, blue and yellow inks are laid on warm stock with
// 'multiply', so every overlap is a true overprint colour. Each plate is
// misregistered by a small jitter that changes on twos (12 steps a second)
// while the motion itself stays smooth. A dot springs into a form that morphs
// on the beat, trailed by a halftone copy, inside a spirograph drawn in one
// line, under the word OVERPRINT. At the end everything collapses back into
// the dot and a halftone wave floods the page blue, knocking the word out to
// bare paper.
//
// Rendering: on the reel's accelerated canvas, arbitrary paths and large
// uploads are slow, and text or small patterns can rasterise differently on
// first use. So everything with detail is composited in software, in opaque
// buffers at output resolution, and placed with pixel-aligned blits; the
// canvas itself only receives flat fills and cached texture tiles.

import {
  defineScene,
  makeCanvas,
  font,
  layoutGlyphs,
  fitSize,
  circle,
  rect,
  polygon,
  star,
  resample,
  alignStart,
  lerpPoints,
  tracePath,
  tracePartial,
  seg,
  kf,
  ease,
  spring,
  cubicBezier,
  clamp01,
  lerp,
  mod,
  smoothstep,
  TAU,
  hash,
  createRandom,
  createNoise,
  parse,
  rgb,
} from '../engine/index.js';

const W = 1920;
const H = 1080;

// Stock and inks. `reg` is each drum's fixed misregistration in design px.
const PAPER = '#F2EEE6';
const INK = {
  pink: { color: '#FF48B0', alpha: 0.95, reg: [-1.8, -0.9], seed: 11 },
  blue: { color: '#0078BF', alpha: 0.96, reg: [1.1, -2.0], seed: 23 },
  yellow: { color: '#FFE800', alpha: 0.94, reg: [2.3, 1.5], seed: 37 },
};

/** Colour of an ink printed on the stock ('multiply' at the ink's opacity). */
function onPaper(ink) {
  const p = parse(PAPER);
  const c = parse(ink.color);
  return rgb(...p.map((v, i) => v * (1 - ink.alpha + (ink.alpha * c[i]) / 255)));
}
const BLUE_ON_PAPER = onPaper(INK.blue);

// Form: a dot springs into a circle, then each beat snaps it to the next outline.
const N = 240; // points per outline
const CX = 960;
const CY = 505;
const DOT = 18; // radius of the dot the form starts and ends as
const INTRO = 0.15; // the dot pops as the blinds open over the centre
const BEATS = [1.1, 1.9, 2.7, 3.5, 4.25]; // morph starts: square, triangle, blob, star, dot
const MORPH = 0.45;
const COLLAPSE = 0.36;
const ROT = [0, 90, 0, 60, 0, 180].map((d) => (d * Math.PI) / 180); // orientation per outline

// The yellow halftone copy trails the pink original; `shade` is the direction its dots swell toward.
const YCOPY = { lag: 0.06, dx: 34, dy: 14, shade: (-15 * Math.PI) / 180 };

// The square around the form that is composited in software (design px).
const REGION = 780;

// Word.
const WORD = 'OVERPRINT';
const WORD_W = 1440;
const WORD_BASE = 835;
const WORD_IN = 0.45;
const WORD_BAND = [200, WORD_BASE - 200, 1720, WORD_BASE + 24]; // everything the letters can touch

// Spirograph line: draws on over the first beats, then implodes with the form.
const LINE_ON = [0.05, 3.4];

// Flood: a halftone wave from the collapsed dot that ends as a solid blue page.
const FLOOD = 4.8;
const FLOOD_SPEED = 3000; // design px per second
const FLOOD_RISE = 0.22; // seconds for one dot to grow to full coverage
const FLOOD_PITCH = 24; // design px between screen dots
const LEVELS = 16; // quantised tones of the screen
const FLOOD_FAR = Math.hypot(Math.max(CX, W - CX), Math.max(CY, H - CY)) + FLOOD_PITCH + 8;

const intro = spring({ stiffness: 150, damping: 13 });
const letterEase = cubicBezier(0.2, 1.22, 0.36, 1);

export default defineScene({
  id: 'riso',
  title: 'Overprint',
  duration: 6.0,
  color: '#FF48B0',
  transition: { type: 'blinds', duration: 0.8, color: '#FF48B0' },
  notes: ['Multiply overprint', 'Procedural halftone', 'Outline morphing with resampled polygons', 'Misregistration on twos'],
  post: { grain: 0 }, // the print carries its own paper and ink texture; film grain would read as a filter
  slug: { color: '#0B0C10' },

  setup({ seed }) {
    return {
      outlines: buildOutlines(seed),
      spiro: spirograph(),
      scratch: [new Float32Array(N * 2), new Float32Array(N * 2)],
      placed: new Float32Array(N * 2),
    };
  },

  render(ctx, s) {
    const kit = kitFor(ctx);
    ctx.fillStyle = PAPER;
    ctx.fillRect(0, 0, W, H);
    if (s.t < FLOOD) {
      drawWordEnds(ctx, s, kit);
      drawFormRegion(ctx, s, kit);
    } else {
      drawFlood(ctx, s, kit);
    }
    drawTexture(ctx, s, kit);
  },
});

// ---------------------------------------------------------------------------
// Form

function buildOutlines(seed) {
  const list = [
    circle(N, 0, 0, 252),
    rect(N, 0, 0, 446, 446),
    polygon(3, N, 0, 54, 312),
    blob(seed),
    star(5, N, 0, 16, 318, 140),
    circle(N, 0, 0, DOT),
  ];
  // Rotate each outline's start index to match its predecessor so morphs don't twist.
  for (let i = 1; i < list.length; i++) list[i] = alignStart(list[i - 1], list[i]);
  return list;
}

/** Seeded organic outline: a circle pushed in and out by noise sampled on a ring. */
function blob(seed) {
  const noise = createNoise((seed ^ 0xb10b) >>> 0);
  const raw = new Float32Array(N * 2);
  for (let k = 0; k < N; k++) {
    const a = -Math.PI / 2 + (k / N) * TAU;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const r = 246 * (1 + 0.22 * noise.noise2D(c * 0.75, sn * 0.75) + 0.07 * noise.noise2D(c * 1.9 + 7, sn * 1.9 + 7));
    raw[k * 2] = c * r;
    raw[k * 2 + 1] = sn * r;
  }
  return resample(raw, N);
}

/** Anticipation dip before a beat, overshoot as the new outline lands. */
const beatBump = (d) =>
  kf(d, [
    [-0.12, 0],
    [0, -0.035, 'inOutSine'],
    [0.34, 0.05, 'outCubic'],
    [0.8, 0, 'inOutSine'],
  ]);

/** Outline (local coordinates), rotation and scale of the form at time t. */
function formAt(st, t, out) {
  let i = -1;
  for (let k = 0; k < BEATS.length; k++) if (t >= BEATS[k]) i = k;
  let pts = st.outlines[0];
  let rot = ROT[0];
  if (i >= 0) {
    const last = i === BEATS.length - 1;
    const u = seg(t, BEATS[i], BEATS[i] + (last ? COLLAPSE : MORPH));
    const e = last ? ease.inBack(u) : ease.inOutExpo(u);
    pts = lerpPoints(st.outlines[i], st.outlines[i + 1], e, out);
    rot = lerp(ROT[i], ROT[i + 1], last ? ease.inCubic(u) : e);
  }
  let scale = lerp(DOT / 252, 1, intro(t - INTRO));
  for (let k = 0; k < BEATS.length - 1; k++) scale *= 1 + beatBump(t - BEATS[k]);
  return { pts, rot, scale };
}

/** Copies peel away from the original after the pop and rejoin it for the collapse. */
const copySpread = (t) =>
  ease.outCubic(seg(t, INTRO + 0.2, INTRO + 0.95)) * (1 - ease.inOutCubic(seg(t, BEATS[4], BEATS[4] + COLLAPSE)));

/** The halftone copy is solid while it is dot-sized, so the plates meet in one dot at both ends. */
const copySolid = (t, scale) =>
  Math.max(1 - smoothstep(DOT / 252, 0.3, scale), smoothstep(0.7, 0.98, seg(t, BEATS[4], BEATS[4] + COLLAPSE)));

/** Transform local outline points into page space. */
function place(src, cx, cy, rot, sc, out) {
  const c = Math.cos(rot) * sc;
  const sn = Math.sin(rot) * sc;
  for (let i = 0; i < src.length; i += 2) {
    const x = src[i];
    const y = src[i + 1];
    out[i] = cx + x * c - y * sn;
    out[i + 1] = cy + x * sn + y * c;
  }
  return out;
}

function bounds(pts) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    const x = pts[i];
    const y = pts[i + 1];
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

// ---------------------------------------------------------------------------
// Misregistration

/** A plate's offset in design px: the drum's fixed error plus a fresh nudge every 1/12 s. */
function plateOffset(ink, t, seed) {
  const k = Math.floor(t * 12);
  const sd = (ink.seed * 7919) ^ seed;
  const a = hash(k, sd) * TAU;
  const m = 1 + 2.2 * hash(k, sd + 1);
  return [ink.reg[0] + Math.cos(a) * m, ink.reg[1] + Math.sin(a) * m];
}

// ---------------------------------------------------------------------------
// Before the flood: the square around the form holds every overprint; the
// ends of the word, outside it, are plain blue on paper.

function drawFormRegion(ctx, s, kit) {
  const { px, form } = kit;
  const g = form.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, form.w, form.h);
  g.setTransform(px, 0, 0, px, -form.x, -form.y); // design space, in buffer pixels
  g.globalCompositeOperation = 'multiply';
  drawYellowCopy(g, s);
  drawPinkForm(g, s);
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalAlpha = INK.blue.alpha;
  g.drawImage(drawBlueLayer(s, kit), 0, 0);
  blit(ctx, kit, form);
}

/** Yellow: a trailing halftone copy whose dots swell toward its right-hand edge. */
function drawYellowCopy(g, s) {
  const { t, seed, state: st } = s;
  const f = formAt(st, t - YCOPY.lag, st.scratch[1]);
  if (f.scale <= 0.001) return;
  const spread = copySpread(t);
  const solid = copySolid(t - YCOPY.lag, f.scale);
  const [dx, dy] = plateOffset(INK.yellow, t, seed);
  const cx = CX + YCOPY.dx * spread + dx;
  const cy = CY + YCOPY.dy * spread + dy;
  const pts = place(f.pts, cx, cy, f.rot, f.scale, st.placed);
  const reach = 290 * Math.max(0.25, f.scale);
  const gx = Math.cos(YCOPY.shade) / reach;
  const gy = Math.sin(YCOPY.shade) / reach;
  g.save();
  g.globalAlpha = INK.yellow.alpha;
  g.fillStyle = INK.yellow.color;
  g.beginPath();
  tracePath(g, pts);
  g.clip();
  g.beginPath();
  halftone(g, bounds(pts), 17, Math.PI / 4, (x, y) =>
    Math.max(solid, smoothstep(-0.6, 1, (x - cx) * gx + (y - cy) * gy)),
  );
  g.fill();
  g.restore();
}

/** Pink: the solid original. */
function drawPinkForm(g, s) {
  const { t, seed, state: st } = s;
  const f = formAt(st, t, st.scratch[0]);
  if (f.scale <= 0.001) return;
  const [dx, dy] = plateOffset(INK.pink, t, seed);
  g.globalAlpha = INK.pink.alpha;
  g.fillStyle = INK.pink.color;
  g.beginPath();
  tracePath(g, place(f.pts, CX + dx, CY + dy, f.rot, f.scale, st.placed));
  g.fill();
}

/**
 * Blue, inside the region: the spirograph and the word drawn into one layer,
 * so where they cross, the single ink never double-prints.
 */
function drawBlueLayer(s, kit) {
  const { px, blue } = kit;
  const b = blue.g;
  b.setTransform(1, 0, 0, 1, 0, 0);
  b.globalCompositeOperation = 'source-over';
  b.globalAlpha = 1;
  b.clearRect(0, 0, blue.w, blue.h);
  const [bx, by] = plateOffset(INK.blue, s.t, s.seed);
  b.setTransform(px, 0, 0, px, bx * px - blue.x, by * px - blue.y);
  drawSpiro(b, s.state, s.t);
  b.setTransform(1, 0, 0, 1, 0, 0);
  drawWordGlyphs(b, s, kit, blue, () => INK.blue.color);
  return blue.c;
}

/** The two ends of the word outside the region, blue ink on bare paper. */
function drawWordEnds(ctx, s, kit) {
  if (s.t < WORD_IN) return;
  for (const buf of [kit.wordL, kit.wordR]) {
    buf.g.fillStyle = PAPER;
    buf.g.fillRect(0, 0, buf.w, buf.h);
    drawWordGlyphs(buf.g, s, kit, buf, () => BLUE_ON_PAPER);
    blit(ctx, kit, buf);
  }
}

/** Hypotrochoid: a circle of radius r rolling inside one of radius R, pen at distance d. */
function spirograph() {
  const R = 5;
  const r = 3;
  const d = 1.6;
  const n = 1200;
  const k = 372 / (R - r + d);
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU * r; // closes after r turns since gcd(R, r) = 1
    const x = (R - r) * Math.cos(a) + d * Math.cos(((R - r) / r) * a);
    const y = (R - r) * Math.sin(a) - d * Math.sin(((R - r) / r) * a);
    out[i * 2] = CX - x * k;
    out[i * 2 + 1] = CY - y * k;
  }
  return out;
}

/** The line draws itself on, then spins and shrinks into the dot with the form. */
function drawSpiro(b, st, t) {
  const to = ease.inOutSine(seg(t, LINE_ON[0], LINE_ON[1]));
  if (to <= 0) return;
  const e = ease.inBack(seg(t, BEATS[4], BEATS[4] + COLLAPSE));
  const k = 1 - e;
  if (k <= 0.01) return;
  b.save();
  b.translate(CX, CY);
  b.rotate(e * 0.9);
  b.scale(k, k);
  b.translate(-CX, -CY);
  b.strokeStyle = INK.blue.color;
  b.lineWidth = 4.5;
  b.lineCap = 'round';
  b.lineJoin = 'round';
  b.beginPath();
  tracePartial(b, st.spiro, 0, to, true);
  b.stroke();
  b.restore();
}

/**
 * Add a halftone screen to the current path: dots on a lattice of pitch `step`
 * rotated by `angle`, covering the box [x0, y0, x1, y1]. `tone(x, y)` is the
 * ink coverage at each dot; at 1 neighbouring dots just merge into solid.
 */
function halftone(g, box, step, angle, tone) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const rMax = step * Math.SQRT1_2;
  // Index range: project the box corners onto the lattice axes.
  let i0 = Infinity;
  let i1 = -Infinity;
  let j0 = Infinity;
  let j1 = -Infinity;
  for (let k = 0; k < 4; k++) {
    const x = k & 1 ? box[2] : box[0];
    const y = k & 2 ? box[3] : box[1];
    const u = (x * ca + y * sa) / step;
    const v = (-x * sa + y * ca) / step;
    if (u < i0) i0 = u;
    if (u > i1) i1 = u;
    if (v < j0) j0 = v;
    if (v > j1) j1 = v;
  }
  for (let j = Math.floor(j0); j <= Math.ceil(j1); j++) {
    for (let i = Math.floor(i0); i <= Math.ceil(i1); i++) {
      const x = (i * ca - j * sa) * step;
      const y = (i * sa + j * ca) * step;
      if (x < box[0] - rMax || x > box[2] + rMax || y < box[1] - rMax || y > box[3] + rMax) continue;
      const v = tone(x, y);
      if (v <= 0.003) continue;
      const r = rMax * Math.sqrt(Math.min(1.02, v)); // dot area follows the tone
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
  }
}

// ---------------------------------------------------------------------------
// Word

/** Word layout at the output pixel size (cached by the engine). */
function wordLayout(g, px) {
  const tracking = -0.02;
  const size = fitSize(g, WORD, WORD_W, { family: 'display', weight: 900, tracking, maxSize: 400 }) * px;
  const f = font(size, 'display', 900);
  const L = layoutGlyphs(g, WORD, f, tracking * size);
  return { f, L, left: (W * px - L.width) / 2, base: WORD_BASE * px };
}

/**
 * Draw the letters into buffer `buf` in its pixel space: each rises into a
 * mask at the baseline, staggered left to right, and moves with the blue
 * plate. `style(x, y)` picks the fill for the letter centred at page pixel (x, y).
 */
function drawWordGlyphs(g, s, kit, buf, style) {
  const t = s.t;
  if (t < WORD_IN) return;
  const { px } = kit;
  const { f, L, left, base } = wordLayout(g, px);
  const [bx, by] = plateOffset(INK.blue, t, s.seed);
  const x0 = left + bx * px;
  const y0 = base + by * px;
  const rise = L.ascent + 24 * px;
  g.save();
  g.translate(-buf.x, -buf.y);
  g.beginPath();
  g.rect(0, y0 - L.ascent - 80 * px, W * px, L.ascent + 94 * px);
  g.clip();
  g.font = f;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  for (const gl of L.glyphs) {
    const u = seg(t, WORD_IN + gl.i * 0.05, WORD_IN + gl.i * 0.05 + 0.7);
    if (u <= 0) continue;
    g.fillStyle = style(x0 + gl.x + gl.w / 2, y0 - L.ascent / 2);
    g.fillText(gl.ch, x0 + gl.x, y0 + (1 - letterEase(u)) * rise);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Flood: the wave, the word inverting as it passes, and the dot sinking into it.

/** The flood's centre in output pixels: the collapsed dot, moving with the blue plate. */
function floodCentre(s, kit) {
  const [bx, by] = plateOffset(INK.blue, s.t, s.seed);
  return [Math.round((CX + bx) * kit.px), Math.round((CY + by) * kit.px)];
}

/** Flood tone 0..1 at a point in output pixels. */
function floodTone(s, kit, x, y) {
  const [cx, cy] = floodCentre(s, kit);
  const d = Math.hypot(x - cx, y - cy) / kit.px;
  return ease.outQuad(clamp01((s.t - FLOOD - d / FLOOD_SPEED) / FLOOD_RISE));
}

/** Radius (design px) inside which the flood tone is at least `tone` (inverse of outQuad). */
const floodReach = (dt, tone) => FLOOD_SPEED * (dt - FLOOD_RISE * (1 - Math.sqrt(1 - tone)));

/**
 * While the wave front is on the page the whole page is printed in software;
 * once the page is solid blue only the band of the word is.
 */
function drawFlood(ctx, s, kit) {
  const solid = floodReach(s.t - FLOOD, 1) >= FLOOD_FAR;
  if (solid) {
    ctx.fillStyle = BLUE_ON_PAPER;
    ctx.fillRect(0, 0, W, H);
  }
  const buf = solid ? kit.word : (kit.page ??= buffer(kit.px, 0, 0, W, H));
  const g = buf.g;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = PAPER;
  g.fillRect(0, 0, buf.w, buf.h);
  paintFlood(g, s, kit, buf);
  // A letter the wave has reached inverts: paper dots grow inside the blue, on
  // the same screen as the flood around it, until the letter is bare paper.
  drawWordGlyphs(g, s, kit, buf, (x, y) => {
    const tone = floodTone(s, kit, x, y);
    if (tone <= 0) return BLUE_ON_PAPER;
    const level = Math.min(LEVELS, Math.floor(tone * LEVELS));
    return level >= LEVELS ? PAPER : knockPattern(g, kit, level, s);
  });
  if (!solid) drawDot(g, s, kit, buf);
  blit(ctx, kit, buf);
}

/**
 * Paint the flood into buffer `buf`: discs from the lowest tone to the
 * highest, each filled with that tone's screen, so every ring of the wave
 * front carries the right dot size.
 */
function paintFlood(g, s, kit, buf) {
  const { px, tile } = kit;
  const dt = s.t - FLOOD;
  const [fx, fy] = floodCentre(s, kit);
  const cx = fx - buf.x;
  const cy = fy - buf.y;
  const far = Math.hypot(Math.max(cx, buf.w - cx), Math.max(cy, buf.h - cy)) / px + FLOOD_PITCH;
  // Start from the highest tone whose disc already covers the whole buffer.
  let first = 1;
  for (let k = LEVELS; k >= 1; k--) {
    if (floodReach(dt, k / LEVELS) >= far) {
      first = k;
      break;
    }
  }
  // Shift the context by whole pixels so a lattice dot sits on the centre.
  const tx = mod(cx, tile);
  const ty = mod(cy, tile);
  g.save();
  g.translate(tx, ty);
  for (let k = first; k <= LEVELS; k++) {
    const r = floodReach(dt, k / LEVELS);
    if (r <= 0) break;
    g.fillStyle = k === LEVELS ? BLUE_ON_PAPER : patternOf(g, kit.flood[k]);
    g.beginPath();
    if (r >= far) g.rect(-tx, -ty, buf.w, buf.h);
    else g.arc(cx - tx, cy - ty, r * px, 0, TAU);
    g.fill();
  }
  g.restore();
}

/** The collapsed form: pink and yellow meet in one dot, which sinks into the flood. */
function drawDot(g, s, kit, buf) {
  const k = 1 - ease.inOutCubic(seg(s.t, FLOOD, FLOOD + 0.3));
  if (k <= 0) return;
  const { px } = kit;
  g.save();
  g.setTransform(px, 0, 0, px, -buf.x, -buf.y);
  g.globalCompositeOperation = 'multiply';
  for (const ink of [INK.yellow, INK.pink]) {
    const [dx, dy] = plateOffset(ink, s.t, s.seed);
    g.globalAlpha = ink.alpha;
    g.fillStyle = ink.color;
    g.beginPath();
    g.arc(CX + dx, CY + dy, DOT * k, 0, TAU);
    g.fill();
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Texture over the whole print: the stock's fibres stay put, while the ink's
// dropout is re-rolled on twos, as if every frame were a fresh pull.

function drawTexture(ctx, s, kit) {
  const { px, paper, dropout } = kit;
  const k = Math.floor(s.t * 12);
  const ox = Math.floor(hash(k, s.seed ^ 0x51) * dropout.width);
  const oy = Math.floor(hash(k, s.seed ^ 0x73) * dropout.height);
  ctx.save();
  ctx.scale(1 / px, 1 / px);
  ctx.fillStyle = patternOf(ctx, paper);
  ctx.fillRect(0, 0, W * px, H * px);
  ctx.translate(-ox, -oy);
  ctx.fillStyle = patternOf(ctx, dropout);
  ctx.fillRect(ox, oy, W * px, H * px);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Per-resolution kit: buffers and tiles generated once for each output size.

const kits = new Map();

function kitFor(ctx) {
  const w = ctx.canvas.width;
  let kit = kits.get(w);
  if (kit) return kit;
  const px = w / W;
  const tile = Math.max(8, Math.round(FLOOD_PITCH * px * Math.sqrt(17)));
  const rx = CX - REGION / 2;
  const ry = CY - REGION / 2;
  const [x0, y0, x1, y1] = WORD_BAND;
  kit = {
    px,
    tile,
    form: buffer(px, rx, ry, REGION, REGION),
    blue: buffer(px, rx, ry, REGION, REGION),
    wordL: buffer(px, x0, y0, rx + 8 - x0, y1 - y0),
    wordR: buffer(px, rx + REGION - 8, y0, x1 - rx - REGION + 8, y1 - y0),
    word: buffer(px, x0, y0, x1 - x0, y1 - y0),
    page: null, // whole-page buffer for the flood, made on first use
    paper: paperTile(px),
    dropout: dropoutTile(px),
    flood: [],
    knock: [],
  };
  for (let k = 0; k <= LEVELS; k++) {
    kit.flood.push(screenTile(tile, k / LEVELS, PAPER, BLUE_ON_PAPER));
    kit.knock.push(screenTile(tile, k / LEVELS, BLUE_ON_PAPER, PAPER));
  }
  if (kits.size >= 3) kits.clear(); // the player changes size with its quality setting
  kits.set(w, kit);
  return kit;
}

/**
 * A software canvas covering a design-space rect, snapped to whole output
 * pixels. willReadFrequently keeps it off the GPU, where text and thousands of
 * small paths rasterise quickly and identically every time.
 */
function buffer(px, x, y, w, h) {
  const bx = Math.floor(x * px);
  const by = Math.floor(y * px);
  const bw = Math.ceil((x + w) * px) - bx;
  const bh = Math.ceil((y + h) * px) - by;
  const c = makeCanvas(bw, bh);
  return { c, g: c.getContext('2d', { willReadFrequently: true }), x: bx, y: by, w: bw, h: bh };
}

/** Place a buffer on the reel's canvas at its pixel position, without resampling. */
function blit(ctx, kit, buf) {
  ctx.save();
  ctx.scale(1 / kit.px, 1 / kit.px);
  ctx.drawImage(buf.c, buf.x, buf.y);
  ctx.restore();
}

const patterns = new WeakMap();

/** A repeating pattern for `source`, cached per context. */
function patternOf(ctx, source) {
  let m = patterns.get(ctx);
  if (!m) patterns.set(ctx, (m = new Map()));
  let p = m.get(source);
  if (!p) m.set(source, (p = ctx.createPattern(source, 'repeat')));
  return p;
}

/**
 * Knockout screen at one tone, for filling in page-pixel space, locked to the
 * flood's lattice so a letter's paper dots line up with the blue dots around it.
 */
function knockPattern(g, kit, level, s) {
  const p = patternOf(g, kit.knock[level]);
  const [fx, fy] = floodCentre(s, kit);
  p.setTransform(new DOMMatrix([1, 0, 0, 1, mod(fx, kit.tile), mod(fy, kit.tile)]));
  return p;
}

/**
 * Opaque tile of a halftone screen at one tone: `ink` dots on `ground`. The
 * lattice is turned by atan(1/4), about 14 degrees, which still repeats on an
 * axis-aligned square of 17 lattice units, so it needs no rotated pattern.
 */
function screenTile(T, tone, ground, ink) {
  const c = makeCanvas(T, T);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = ground;
  g.fillRect(0, 0, T, T);
  if (tone <= 0) return c;
  const u = T / 17; // basis vectors (4, 1)u and (-1, 4)u
  const r = u * Math.sqrt(17) * Math.SQRT1_2 * Math.sqrt(tone);
  g.fillStyle = ink;
  g.beginPath();
  for (let m = -2; m <= 6; m++) {
    for (let n = -2; n <= 6; n++) {
      const x = (4 * m - n) * u;
      const y = (m + 4 * n) * u;
      if (x < -r || x > T + r || y < -r || y > T + r) continue;
      g.moveTo(x + r, y);
      g.arc(x, y, r, 0, TAU);
    }
  }
  g.fill();
  return c;
}

/** Transparent square tile at output resolution, plus a helper that draws marks wrapped across its edges. */
function textureTile(px, design, seed) {
  const T = Math.max(64, Math.round(design * px));
  const c = makeCanvas(T, T);
  const g = c.getContext('2d', { willReadFrequently: true });
  const wrap = (x, y, r, draw) => {
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const X = x + ox * T;
        const Y = y + oy * T;
        if (X + r < 0 || X - r > T || Y + r < 0 || Y - r > T) continue;
        draw(X, Y);
      }
    }
  };
  return { c, g, T, wrap, rnd: createRandom(seed).next };
}

/**
 * The stock: uneven absorbency (soft patches in the paper colour, which only
 * show where there is ink), short bent fibres and tiny inclusions in the pulp.
 */
function paperTile(px) {
  const { c, g, T, wrap, rnd } = textureTile(px, 768, 0x9a9e7);
  // The patches are soft, so they are painted at 1/8 scale and enlarged.
  const n = Math.max(8, Math.round(T / 8));
  const low = makeCanvas(n, n);
  const lg = low.getContext('2d', { willReadFrequently: true });
  const [r0, g0, b0] = parse(PAPER);
  for (let i = 0; i < 90; i++) {
    const x = rnd() * n;
    const y = rnd() * n;
    const r = ((50 + rnd() * 110) * px * n) / T;
    const a = 0.01 + rnd() * 0.016;
    for (let oy = -n; oy <= n; oy += n) {
      for (let ox = -n; ox <= n; ox += n) {
        const grad = lg.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        grad.addColorStop(0, `rgba(${r0},${g0},${b0},${a})`);
        grad.addColorStop(1, `rgba(${r0},${g0},${b0},0)`);
        lg.fillStyle = grad;
        lg.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
      }
    }
  }
  g.imageSmoothingQuality = 'high';
  g.drawImage(low, 0, 0, T, T);
  g.lineCap = 'round';
  for (let i = 0; i < 520; i++) {
    const x = rnd() * T;
    const y = rnd() * T;
    const a = rnd() * TAU;
    const len = (5 + rnd() * rnd() * 18) * px;
    const bend = (rnd() - 0.5) * len * 0.4;
    const dark = rnd() < 0.85;
    g.strokeStyle = dark ? `rgba(90,76,58,${0.04 + rnd() * 0.08})` : `rgba(255,253,248,${0.12 + rnd() * 0.18})`;
    g.lineWidth = Math.max(0.5, (0.6 + rnd() * 0.7) * px);
    wrap(x, y, len, (X, Y) => {
      const ex = X + Math.cos(a) * len;
      const ey = Y + Math.sin(a) * len;
      g.beginPath();
      g.moveTo(X, Y);
      g.quadraticCurveTo((X + ex) / 2 - Math.sin(a) * bend, (Y + ey) / 2 + Math.cos(a) * bend, ex, ey);
      g.stroke();
    });
  }
  g.fillStyle = 'rgb(70,58,44)';
  for (let i = 0; i < 290; i++) {
    const r = Math.max(0.4, (0.4 + rnd() * rnd() * 1.2) * px);
    g.globalAlpha = 0.1 + rnd() * 0.3;
    wrap(rnd() * T, rnd() * T, r, (X, Y) => {
      g.beginPath();
      g.arc(X, Y, r, 0, TAU);
      g.fill();
    });
  }
  return c;
}

/** Ink dropout, in the paper colour so it only shows on ink: specks where ink failed to transfer. */
function dropoutTile(px) {
  const { c, g, T, wrap, rnd } = textureTile(px, 640, 0xd20b);
  g.fillStyle = PAPER;
  for (let i = 0; i < 1000; i++) {
    const r = Math.max(0.35, (0.35 + rnd() * rnd() * 1.5) * px);
    g.globalAlpha = 0.3 + rnd() * 0.7;
    wrap(rnd() * T, rnd() * T, r, (X, Y) => {
      g.beginPath();
      g.arc(X, Y, r, 0, TAU);
      g.fill();
    });
  }
  return c;
}

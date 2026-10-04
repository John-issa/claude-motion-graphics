// Risograph: a print come to life.
//
// Fluorescent pink, blue and yellow inks are laid on warm stock with
// 'multiply', so every overlap is a true overprint colour. Each plate is
// misregistered by a small jitter that changes on twos (12 pulls a second)
// while the motion itself stays smooth. A dot springs into a form that morphs
// on the beat, trailed by a halftone copy; a spirograph line grows out of it,
// and the word OVERPRINT rises underneath. At the end everything collapses
// back into the dot and a halftone wave floods the page blue, knocking the
// word out to bare paper.
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
  pointAt,
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
const FORM_R = 252; // radius of the opening circle
const DOT = 18; // radius of the dot the form starts and ends as
const INTRO = 0.15; // the dot pops as the blinds open over the centre
const BEATS = [1.1, 1.9, 2.7, 3.5, 4.25]; // morph starts: square, triangle, blob, star, dot
const MORPH = 0.45;
const COLLAPSE = 0.36;
const ROT = [0, 90, 0, 60, 0, 180].map((d) => (d * Math.PI) / 180); // orientation per outline

// The yellow halftone copy trails the pink original; `shade` is the direction its dots swell toward.
const YCOPY = { lag: 0.06, dx: 34, dy: 14, shade: (-15 * Math.PI) / 180 };

// The square around the form that is composited in software (design px). Its
// half-width holds the spirograph at the collapse's 1.1x swell (409 px), plus
// half the stroke and the blue plate's largest offset.
const REGION = 840;

// Word. PAIRS opens or closes the space before a letter (em): the V's arm
// would otherwise touch the E, and the round O sits loose against the V.
const WORD = 'OVERPRINT';
const WORD_W = 1440;
const WORD_BASE = 835;
const WORD_IN = 0.45;
const WORD_BAND = [200, WORD_BASE - 200, 1720, WORD_BASE + 24]; // everything the letters can touch
const PAIRS = { OV: -0.04, VE: 0.09 };

// Spirograph line: grows out of the circle's edge behind a pen dot as the pop
// lands, closes just before the star, then implodes with the form.
const LINE_ON = [0.36, 3.4];
const LINE_W = 7;
const PEN = 6.5; // radius of the dot leading the line

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
  title: 'Risograph',
  duration: 6.0,
  color: '#FF48B0',
  transition: { type: 'blinds', duration: 0.8, color: '#FF48B0' },
  notes: ['Multiply overprint', 'Procedural halftone', 'Outline morphing with resampled polygons', 'Misregistration on twos'],
  post: { grain: 0 }, // the print carries its own paper and ink texture; film grain would read as a filter
  slug: { color: '#0B0C10' },
  uses: ['seed'], // setup reads the seed (the blob's outline), never the title

  uses: ['seed'],
  /** Sound on the print's beat: every morph lands like a press stroke. */
  cues: () => [
    { t: INTRO, kind: 'land', strength: 0.5 }, // the dot pops
    { t: WORD_IN - 0.2, kind: 'whoosh', dur: 0.25, strength: 0.35 }, // OVERPRINT enters
    ...BEATS.map((b) => ({ t: b + MORPH, kind: 'hit', strength: 0.5 })),
    { t: FLOOD, kind: 'swell', dur: 0.8, strength: 0.7 }, // the blue flood
  ],
  setup({ seed }) {
    return {
      outlines: buildOutlines(seed),
      spiro: spirograph(),
      stock: stockMarks(), // generated here, at reel init, so a new output size only rasterises
      scratch: [new Float32Array(N * 2), new Float32Array(N * 2)],
      placed: new Float32Array(N * 2),
      pen: [0, 0],
    };
  },

  render(ctx, s) {
    const kit = kitFor(ctx, s.state.stock);
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
    circle(N, 0, 0, FORM_R),
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
  let scale = lerp(DOT / FORM_R, 1, intro(t - INTRO));
  for (let k = 0; k < BEATS.length - 1; k++) scale *= 1 + beatBump(t - BEATS[k]);
  return { pts, rot, scale };
}

/** Copies peel away from the original after the pop and rejoin it for the collapse. */
const copySpread = (t) =>
  ease.outCubic(seg(t, INTRO + 0.2, INTRO + 0.95)) * (1 - ease.inOutCubic(seg(t, BEATS[4], BEATS[4] + COLLAPSE)));

/**
 * The copy's clock: it trails the original by YCOPY.lag, and the lag closes
 * during the collapse's swell so both plates snap into the dot together.
 */
const copyTime = (t) => t - YCOPY.lag * (1 - smoothstep(BEATS[4], BEATS[4] + 0.25, t));

/** The halftone copy is solid while it is dot-sized, so the plates meet in one dot at both ends. */
const copySolid = (t, scale) =>
  Math.max(1 - smoothstep(DOT / FORM_R, 0.3, scale), smoothstep(0.7, 0.98, seg(t, BEATS[4], BEATS[4] + COLLAPSE)));

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

/**
 * The current pull: 12 a second. It is counted from the frame number rather
 * than the time, so every motion-blur sub-sample of a frame prints from the
 * same pull instead of averaging two into a double image.
 */
const pullOf = (s) => Math.floor((s.frame * 12) / s.fps);

/** A plate's offset in design px: the drum's fixed error plus a fresh nudge every pull. */
function plateOffset(ink, s) {
  const k = pullOf(s);
  const sd = (ink.seed * 7919) ^ s.seed;
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
  const { t, state: st } = s;
  const ty = copyTime(t);
  const f = formAt(st, ty, st.scratch[1]);
  if (f.scale <= 0.001) return;
  const spread = copySpread(t);
  const solid = copySolid(ty, f.scale);
  const [dx, dy] = plateOffset(INK.yellow, s);
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
  const { t, state: st } = s;
  const f = formAt(st, t, st.scratch[0]);
  if (f.scale <= 0.001) return;
  const [dx, dy] = plateOffset(INK.pink, s);
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
  const [bx, by] = plateOffset(INK.blue, s);
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

/**
 * Hypotrochoid: a circle of radius r rolling inside one of radius R, pen at
 * distance d. The pen's distance from the centre follows cos(a R / r), so the
 * start can be solved exactly: where the line crosses the opening circle's
 * edge on its way out to the upper-right loop, so it grows out of the form.
 */
function spirograph() {
  const R = 5;
  const r = 3;
  const d = 1.6;
  const n = 1200;
  const k = 372 / (R - r + d); // the loops reach 372 px from the centre
  const c = ((FORM_R / k) ** 2 - (R - r) ** 2 - d * d) / (2 * (R - r) * d);
  const a0 = (r / R) * (4 * TAU - Math.acos(c));
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU * r; // closes after r turns since gcd(R, r) = 1
    const x = (R - r) * Math.cos(a) + d * Math.cos(((R - r) / r) * a);
    const y = (R - r) * Math.sin(a) - d * Math.sin(((R - r) / r) * a);
    out[i * 2] = CX - x * k;
    out[i * 2 + 1] = CY - y * k;
  }
  return out;
}

/**
 * The line shoots out of the form as the pop lands and slows as it closes,
 * led by a pen dot; then it spins and shrinks into the dot with the form.
 */
function drawSpiro(b, st, t) {
  const to = ease.outSine(seg(t, LINE_ON[0], LINE_ON[1]));
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
  b.lineWidth = LINE_W;
  b.lineCap = 'round';
  b.lineJoin = 'round';
  b.beginPath();
  tracePartial(b, st.spiro, 0, to, true);
  b.stroke();
  // The pen dot swells as the line sets off and shrinks back into it as the loop closes.
  const grow = ease.outBack(seg(t, LINE_ON[0], LINE_ON[0] + 0.24));
  const shrink = ease.inOutSine(seg(t, LINE_ON[1] - 0.4, LINE_ON[1]));
  const pen = PEN * grow * (1 - shrink);
  if (pen > LINE_W / 2) {
    const [x, y] = pointAt(st.spiro, to, true, st.pen);
    b.fillStyle = INK.blue.color;
    b.beginPath();
    b.arc(x, y, pen, 0, TAU);
    b.fill();
  }
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

/**
 * The word laid out in output pixels, kerned by PAIRS. The pair adjustments
 * widen the line, so the size shrinks to keep it WORD_W wide.
 */
function wordLayout(g, px) {
  const tracking = -0.02;
  const kern = [0]; // each glyph's accumulated pair adjustment, in em
  for (let i = 1; i < WORD.length; i++) kern.push(kern[i - 1] + (PAIRS[WORD.slice(i - 1, i + 1)] ?? 0));
  const extra = kern[WORD.length - 1];
  const fit = fitSize(g, WORD, WORD_W, { family: 'display', weight: 900, tracking, maxSize: 400 });
  const size = ((fit * WORD_W) / (WORD_W + extra * fit)) * px;
  const f = font(size, 'display', 900);
  const L = layoutGlyphs(g, WORD, f, tracking * size);
  return {
    f,
    ascent: L.ascent,
    glyphs: L.glyphs.map((gl) => ({ ch: gl.ch, i: gl.i, x: gl.x + kern[gl.i] * size, w: gl.w })),
    left: (W * px - L.width - extra * size) / 2,
    base: WORD_BASE * px,
  };
}

/**
 * Draw the letters into buffer `buf` in its pixel space: each rises into a
 * mask at the baseline, staggered left to right, and moves with the blue
 * plate. `style(x, y)` picks the fill for the letter centred at page pixel (x, y).
 */
function drawWordGlyphs(g, s, kit, buf, style) {
  const t = s.t;
  if (t < WORD_IN) return;
  const { px, word } = kit;
  const [bx, by] = plateOffset(INK.blue, s);
  const x0 = word.left + bx * px;
  const y0 = word.base + by * px;
  const rise = word.ascent + 24 * px;
  g.save();
  g.translate(-buf.x, -buf.y);
  g.beginPath();
  g.rect(0, y0 - word.ascent - 80 * px, W * px, word.ascent + 94 * px);
  g.clip();
  g.font = word.f;
  g.textAlign = 'left';
  g.textBaseline = 'alphabetic';
  for (const gl of word.glyphs) {
    const u = seg(t, WORD_IN + gl.i * 0.05, WORD_IN + gl.i * 0.05 + 0.7);
    if (u <= 0) continue;
    g.fillStyle = style(x0 + gl.x + gl.w / 2, y0 - word.ascent / 2);
    g.fillText(gl.ch, x0 + gl.x, y0 + (1 - letterEase(u)) * rise);
  }
  g.restore();
}

// ---------------------------------------------------------------------------
// Flood: the wave, the word inverting as it passes, and the dot sinking into it.

/** The flood's centre in output pixels: the collapsed dot, moving with the blue plate. */
function floodCentre(s, kit) {
  const [bx, by] = plateOffset(INK.blue, s);
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
  const buf = solid ? kit.band : (kit.page ??= buffer(kit.px, 0, 0, W, H));
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
    g.fillStyle = k === LEVELS ? BLUE_ON_PAPER : patternOf(kit, g, kit.flood[k]);
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
    const [dx, dy] = plateOffset(ink, s);
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
// dropout belongs to the blue plate and shifts with it on every pull.

function drawTexture(ctx, s, kit) {
  const { px, paper, dropout } = kit;
  const [bx, by] = plateOffset(INK.blue, s);
  const ox = Math.round(bx * px);
  const oy = Math.round(by * px);
  ctx.save();
  ctx.scale(1 / px, 1 / px);
  ctx.fillStyle = patternOf(kit, ctx, paper);
  ctx.fillRect(0, 0, W * px, H * px);
  ctx.translate(ox, oy);
  ctx.fillStyle = patternOf(kit, ctx, dropout);
  ctx.fillRect(-ox, -oy, W * px, H * px);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Per-resolution kit: buffers and tiles generated once for each output size.

const kits = new Map();

function kitFor(ctx, stock) {
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
    word: wordLayout(ctx, px),
    form: buffer(px, rx, ry, REGION, REGION),
    blue: buffer(px, rx, ry, REGION, REGION),
    wordL: buffer(px, x0, y0, rx + 8 - x0, y1 - y0),
    wordR: buffer(px, rx + REGION - 8, y0, x1 - rx - REGION + 8, y1 - y0),
    band: buffer(px, x0, y0, x1 - x0, y1 - y0), // the word's band once the page is solid
    page: null, // whole-page buffer for the flood, made on first use
    paper: paperTile(px, stock),
    dropout: dropoutTile(px, stock),
    flood: [],
    knock: [],
    patterns: new WeakMap(), // context → tile → pattern, so they go when the kit does
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

/** A repeating pattern of one of the kit's tiles for drawing into `ctx`, cached on the kit. */
function patternOf(kit, ctx, source) {
  let m = kit.patterns.get(ctx);
  if (!m) kit.patterns.set(ctx, (m = new Map()));
  let p = m.get(source);
  if (!p) m.set(source, (p = ctx.createPattern(source, 'repeat')));
  return p;
}

/**
 * Knockout screen at one tone, for filling in page-pixel space, locked to the
 * flood's lattice so a letter's paper dots line up with the blue dots around it.
 */
function knockPattern(g, kit, level, s) {
  const p = patternOf(kit, g, kit.knock[level]);
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

// ---------------------------------------------------------------------------
// Stock: the paper's marks are generated once, in tile units (0..1), and each
// output size only rasterises them, a few batched paths per tile.

const PAPER_TILE = 768; // design px
const DROPOUT_TILE = 640;
const ABSORB = 96; // texels across the absorbency map, 8 design px each
const STEPS = 6; // opacity steps that marks are batched into

let stockCache = null; // the marks are seed-independent, so one set serves every setup

/**
 * The stock: uneven absorbency (soft patches in the paper colour, which only
 * show where there is ink), short bent fibres, tiny inclusions in the pulp,
 * and the ink's dropout, specks where it failed to transfer.
 */
function stockMarks() {
  if (stockCache) return stockCache;
  let rnd = createRandom(0x9a9e7).next;
  // Absorbency: soft patches accumulated as 'source-over' would, wrapped so the tile repeats.
  const n = ABSORB;
  const keep = new Float32Array(n * n).fill(1); // product of (1 - patch alpha)
  for (let i = 0; i < 90; i++) {
    const cx = rnd() * n;
    const cy = rnd() * n;
    const r = ((50 + rnd() * 110) / PAPER_TILE) * n;
    const a = 0.01 + rnd() * 0.016;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d = Math.sqrt(dx * dx + dy * dy) / r;
        if (d < 1) keep[mod(y, n) * n + mod(x, n)] *= 1 - a * (1 - d);
      }
    }
  }
  const absorb = new Uint8ClampedArray(n * n * 4);
  const [pr, pg, pb] = parse(PAPER);
  for (let k = 0; k < n * n; k++) {
    absorb[k * 4] = pr;
    absorb[k * 4 + 1] = pg;
    absorb[k * 4 + 2] = pb;
    absorb[k * 4 + 3] = Math.round((1 - keep[k]) * 255);
  }

  const fibres = [];
  for (let i = 0; i < 520; i++) {
    const u = rnd();
    const v = rnd();
    const a = rnd() * TAU;
    const len = 5 + rnd() * rnd() * 18; // design px
    const bend = (rnd() - 0.5) * len * 0.4;
    const dark = rnd() < 0.85;
    const style = dark ? `rgba(90,76,58,${step(rnd(), 0.04, 0.12)})` : `rgba(255,253,248,${step(rnd(), 0.12, 0.3)})`;
    fibres.push({ u, v, a, len, bend, style, w: step(rnd(), 0.6, 1.3, 3) });
  }
  const specks = [];
  for (let i = 0; i < 290; i++) {
    const r = 0.4 + rnd() * rnd() * 1.2;
    const style = `rgba(70,58,44,${step(rnd(), 0.1, 0.4)})`;
    specks.push({ r, style, u: rnd(), v: rnd() });
  }
  rnd = createRandom(0xd20b).next;
  const dropout = [];
  for (let i = 0; i < 1000; i++) {
    const r = 0.35 + rnd() * rnd() * 1.5;
    const style = `rgba(${pr},${pg},${pb},${step(rnd(), 0.3, 1)})`;
    dropout.push({ r, style, u: rnd(), v: rnd() });
  }
  stockCache = { absorb, fibres: batches(fibres), specks: batches(specks), dropout: batches(dropout) };
  return stockCache;
}

/** The middle of the step that u (0..1) falls in, between lo and hi: marks share a few styles. */
function step(u, lo, hi, n = STEPS) {
  const k = Math.min(n - 1, Math.floor(u * n));
  return Math.round((lo + ((k + 0.5) / n) * (hi - lo)) * 1000) / 1000;
}

/** Group marks by style (and stroke width), so each group draws as one path. */
function batches(marks) {
  const map = new Map();
  for (const m of marks) {
    const key = `${m.style}|${m.w}`;
    let b = map.get(key);
    if (!b) map.set(key, (b = { style: m.style, w: m.w, marks: [] }));
    b.marks.push(m);
  }
  return [...map.values()];
}

/** Transparent square tile at output resolution, plus a helper that draws marks wrapped across its edges. */
function textureTile(px, design) {
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
  return { c, g, T, wrap };
}

/** Fill each batch of round marks as one path; radii are in design px, never below `min` output px. */
function fillDots(tile, px, list, min) {
  const { g, T, wrap } = tile;
  for (const b of list) {
    g.fillStyle = b.style;
    g.beginPath();
    for (const m of b.marks) {
      const r = Math.max(min, m.r * px);
      wrap(m.u * T, m.v * T, r, (X, Y) => {
        g.moveTo(X + r, Y);
        g.arc(X, Y, r, 0, TAU);
      });
    }
    g.fill();
  }
}

function paperTile(px, stock) {
  const tile = textureTile(px, PAPER_TILE);
  const { c, g, T, wrap } = tile;
  // The absorbency map is soft, so it is enlarged from its few texels;
  // bilinear is within 2 levels of bicubic here, at a fifth of the cost.
  const low = makeCanvas(ABSORB, ABSORB);
  low.getContext('2d', { willReadFrequently: true }).putImageData(new ImageData(stock.absorb, ABSORB, ABSORB), 0, 0);
  g.imageSmoothingQuality = 'low';
  g.drawImage(low, 0, 0, T, T);
  g.lineCap = 'round';
  for (const b of stock.fibres) {
    g.strokeStyle = b.style;
    g.lineWidth = Math.max(0.5, b.w * px);
    g.beginPath();
    for (const f of b.marks) {
      const len = f.len * px;
      const bend = f.bend * px;
      const ca = Math.cos(f.a);
      const sa = Math.sin(f.a);
      wrap(f.u * T, f.v * T, len, (X, Y) => {
        g.moveTo(X, Y);
        g.quadraticCurveTo(X + (ca * len) / 2 - sa * bend, Y + (sa * len) / 2 + ca * bend, X + ca * len, Y + sa * len);
      });
    }
    g.stroke();
  }
  fillDots(tile, px, stock.specks, 0.4);
  return c;
}

function dropoutTile(px, stock) {
  const tile = textureTile(px, DROPOUT_TILE);
  fillDots(tile, px, stock.dropout, 0.35);
  return tile.c;
}

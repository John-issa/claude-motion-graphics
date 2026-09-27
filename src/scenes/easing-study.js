// Easing Study: a technical-drawing sheet of eight timing curves on one clock.
// Each card plots its easing, rides a dot along the curve and slides a square
// by the eased value; the ticks the square leaves on its track form an
// animator's spacing chart. At the end every card leaves on its own curve.

import {
  defineScene,
  ease,
  spring,
  seg,
  clamp01,
  lerp,
  font,
  measure,
  layoutGlyphs,
  makeCanvas,
  palette,
  rgba,
  TAU,
} from '../engine/index.js';

const INK = palette.ink;
const CARD = '#F8F6F1'; // card stock, a shade lighter than the bone ground
const GRID = '#707C92'; // cool grey against the warm ground
const AMBER = '#CF8A06'; // palette.sun darkened to hold a line on bone
const MINT = '#17A878'; // palette.mint darkened for the same reason

const SPRING = spring({ stiffness: 170, damping: 12 });

// Top row: the symmetric in-out family; bottom row: decelerations. Each row
// escalates left to right and ends on a curve that overshoots. `def` marks
// superscripts as ^{…}, since the bundled fonts have no ⁵ or ⁻ glyphs.
const CURVES = [
  { name: 'linear', def: 'x', color: INK, fn: ease.linear },
  { name: 'inOutSine', def: 'sin^{2}(90°·x)', color: palette.cobalt, fn: ease.inOutSine },
  { name: 'inOutQuint', def: '16x^{5}, mirrored at ½', color: MINT, fn: ease.inOutQuint },
  { name: 'inOutBack', def: 'overshoot 1.70158', color: palette.violet, fn: ease.inOutBack },
  { name: 'outCubic', def: '1 − (1 − x)^{3}', color: MINT, fn: ease.outCubic },
  { name: 'outExpo', def: '1 − 2^{−10x}', color: palette.pink, fn: ease.outExpo },
  { name: 'outElastic', def: 'period 0.3', color: AMBER, fn: ease.outElastic },
  { name: 'spring', def: 'k 170, c 12', color: palette.signal, fn: SPRING.ease },
];

// Beats, in local seconds.
const CARDS_IN = 0.6; // first card starts to pop in
const BUILD = 0.56; // each card's build-in (pop, labels, axes, track) lasts this long
const CLOCK_IN = 1.4; // the shared clock starts...
const CLOCK_DUR = 2.5; // ...and runs this long for every card
const CLOCK_OUT = CLOCK_IN + CLOCK_DUR;
const EXIT = 4.72; // header lifts first, the bottom row drops, then the top row follows the header up
const EXIT_DUR = 0.72;
const EXIT_DIST = 640;

// Sheet layout: 4 × 2 cards inside title-safe. The 400 × 360 pitch is a
// multiple of the 40 px grid, so a grid line runs down every gutter.
const LEFT = 192;
const TOP = 272;
const CW = 336;
const CH = 296;
const PITCH_X = 400;
const PITCH_Y = 360;
const RIGHT = LEFT + 3 * PITCH_X + CW;
const GRID_STEP = 40;

// Card-local plot geometry. O is (time 0, value 0) and the unit box is UW × UH.
// The track shares the box's x scale, so the linear square sits exactly under
// the playhead and every other curve visibly leads or lags it.
const OX = 48;
const OY = 228;
const UW = 184;
const UH = 120;
const TRACK_Y = OY + 40;
const X_END = OX + 1.32 * UW; // x-axis arrow tip
const Y_END = OY - 1.42 * UH; // y-axis arrow tip
const PLAYHEAD_TOP = Y_END + 4;
const DIM_X = OX + 1.12 * UW; // column for the overshoot dimension lines

const SAMPLES = 240;
const TICKS = 16; // spacing-chart intervals: a tick every CLOCK_DUR / TICKS seconds
const TICK_POP = 0.2; // seconds a new tick takes to grow in

const HEAD_X = LEFT;
const HEAD_BASE = 212;
const RULE_Y = 240;

const F_HEAD = font(84, 'serif', 400, 'italic');
const F_CAPTION = font(16, 'mono', 400);
const F_CLOCK = font(16, 'mono', 500);
const F_NAME = font(15, 'mono', 600);
const F_VALUE = font(15, 'mono', 400);
const F_DEF = font(12, 'mono', 400);
const F_SUP = font(8.5, 'mono', 400);
const F_TICK = font(11, 'mono', 400);
const F_AXIS = font(10, 'mono', 400);

/** Round a design coordinate to the nearest device pixel. */
const snap = (v, px) => Math.round(v * px) / px;

/** Hairline width: one device pixel, never thinner than one design unit. */
const hairline = (px) => Math.max(1, 1 / px);

/**
 * Alpha for a hairline of opacity `a`: below 1080p a one-device-pixel line is
 * wider than one design unit, so it is faded by the same ratio, which is what
 * antialiasing would do to a thinner line, only crisp.
 */
const hairAlpha = (a, px) => a * Math.min(1, px);

/** "1 − 2^{−10x}" → [{ text: '1 − 2', sup: false }, { text: '−10x', sup: true }] */
function parseRuns(src) {
  const runs = [];
  const re = /\^\{([^}]*)\}/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) runs.push({ text: src.slice(last, m.index), sup: false });
    runs.push({ text: m[1], sup: true });
    last = re.lastIndex;
  }
  if (last < src.length) runs.push({ text: src.slice(last), sup: false });
  return runs;
}

/** Draw typeset runs from (x, y) on the baseline, superscripts raised. */
function drawRuns(ctx, runs, x, y) {
  for (const r of runs) {
    const f = r.sup ? F_SUP : F_DEF;
    ctx.font = f;
    ctx.fillText(r.text, x, r.sup ? y - 5 : y);
    x += measure(ctx, r.text, f);
  }
}

/** Filled arrowhead with its tip at (x, y), pointing along the unit (dx, dy). */
function arrowhead(ctx, x, y, dx, dy, size = 7) {
  const w = size * 0.42;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - dx * size - dy * w, y - dy * size + dx * w);
  ctx.lineTo(x - dx * size + dy * w, y - dy * size - dx * w);
  ctx.closePath();
  ctx.fill();
}

function line(ctx, x0, y0, x1, y1) {
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
}

/**
 * Polygons (unit space, flat [x, y, ...]) of the stretches where a sampled
 * curve leaves the 0-1 box, each closed along the edge it crossed. Slivers
 * shallower than 1% are skipped.
 */
function outsideRegions(samples) {
  const regions = [];
  const n = samples.length - 1;
  for (const [edge, side] of [[1, 1], [0, -1]]) {
    let run = null;
    let depth = 0;
    const crossX = (i) => {
      const a = samples[i - 1];
      const b = samples[i];
      return (i - 1 + (edge - a) / (b - a)) / n;
    };
    for (let i = 0; i <= n; i++) {
      const out = (samples[i] - edge) * side > 1e-9;
      if (out && !run) {
        run = [i > 0 ? crossX(i) : 0, edge];
        depth = 0;
      }
      if (out) {
        run.push(i / n, samples[i]);
        depth = Math.max(depth, Math.abs(samples[i] - edge));
      } else if (run) {
        run.push(crossX(i), edge);
        if (depth > 0.01) regions.push(run);
        run = null;
      }
    }
    if (run && depth > 0.01) regions.push(run);
  }
  return regions;
}

// ---------------------------------------------------------------------------
// Bitmap atlas
//
// Everything cached here is time-independent, so it is drawn once per output
// resolution, all into one canvas: a single texture to upload and bind. Each
// card gets its plate (the finished static drawing, which doubles as a sprite
// sheet for the build-in), its curve (stroked once, then revealed up to the
// playhead with a source-rect drawImage), its emphasis marks, a spacing-chart
// strip per tick count and its dot. Per frame that leaves only cheap
// primitives: blits, rects, text and simple segments. Dashed, round-capped or
// multi-part strokes are far slower on GPU-backed canvases.
// ---------------------------------------------------------------------------

const atlases = new Map();
const sheets = new Map();
const PAD = 2; // device px between regions, so filtering never bleeds across

// Region boxes in card-local design px: [x, y, w, h].
const CURVE_BOX = [OX - 10, OY - 1.5 * UH, UW + 20, 1.72 * UH];
const MARKS_BOX = [OX - 10, OY - 1.5 * UH, CW - 6 - OX, 1.72 * UH];
const STRIP_BOX = [16, TRACK_Y - 6, CW - 32, 12];
const DOT_BOX = [-7.5, -7.5, 15, 15];

/** A region of the atlas at (ox, oy) device px, with its origin on a device pixel. */
function region(px, [x, y, w, h], ox, oy) {
  const x0 = Math.floor(x * px) / px;
  const y0 = Math.floor(y * px) / px;
  return { x: x0, y: y0, ox, oy, w: Math.ceil((w + x - x0) * px) + 1, h: Math.ceil((h + y - y0) * px) + 1 };
}

/** Per card { plate, curve, marks, strips, dot }, built together on first use. */
function atlasAt(px, cards) {
  let A = atlases.get(px);
  if (A) return A;

  // One column per card, regions stacked down it.
  let x = PAD;
  let height = 0;
  A = cards.map((c) => {
    let y = PAD;
    let width = 0;
    const take = (box) => {
      const r = region(px, box, x, y);
      y += r.h + PAD;
      width = Math.max(width, r.w);
      return r;
    };
    const entry = {
      plate: take([0, 0, snap(CW, px), snap(CH, px)]),
      curve: take(CURVE_BOX),
      marks: c.peak > 1.001 ? take(MARKS_BOX) : null,
      strips: Array.from({ length: TICKS + 1 }, () => take(STRIP_BOX)), // strips[k]: ticks 0..k
      dot: take(DOT_BOX),
    };
    x += width + PAD;
    height = Math.max(height, y);
    return entry;
  });

  const canvas = makeCanvas(x, height);
  const g = canvas.getContext('2d');
  const paint = (r, draw) => {
    r.canvas = canvas;
    g.save();
    g.beginPath();
    g.rect(r.ox, r.oy, r.w, r.h);
    g.clip();
    g.translate(r.ox, r.oy);
    g.scale(px, px);
    g.translate(-r.x, -r.y);
    draw(g);
    g.restore();
  };
  cards.forEach((c, i) => {
    const e = A[i];
    paint(e.plate, (g) => drawCardBody(g, c, px));
    paint(e.curve, (g) => {
      g.strokeStyle = c.color;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.beginPath();
      for (let k = 0; k <= SAMPLES; k++) g.lineTo(OX + (k / SAMPLES) * UW, OY - c.samples[k] * UH);
      g.stroke();
    });
    if (e.marks) {
      paint(e.marks, (g) => {
        drawHatch(g, c);
        drawDimension(g, c);
      });
    }
    e.strips.forEach((r, n) =>
      paint(r, (g) => {
        g.fillStyle = c.color;
        for (let k = 0; k <= n; k++) g.fillRect(OX + c.ticks[k] * UW - 0.625, TRACK_Y - 5, 1.25, 10);
      }),
    );
    paint(e.dot, (g) => {
      g.fillStyle = CARD;
      g.beginPath();
      g.arc(0, 0, 7.5, 0, TAU);
      g.fill();
      g.fillStyle = c.color;
      g.beginPath();
      g.arc(0, 0, 5.5, 0, TAU);
      g.fill();
    });
  });

  if (atlases.size >= 3) atlases.clear();
  atlases.set(px, A);
  return A;
}

/** Draw the part of an atlas region inside card-local design rect [x0, x1] × [y0, y1]. */
function blit(ctx, r, px, x0, y0, x1, y1) {
  const sx = Math.max(0, (x0 - r.x) * px);
  const sy = Math.max(0, (y0 - r.y) * px);
  const sw = Math.min(r.w - sx, (x1 - r.x) * px - sx);
  const sh = Math.min(r.h - sy, (y1 - r.y) * px - sy);
  if (sw <= 0 || sh <= 0) return;
  ctx.drawImage(r.canvas, r.ox + sx, r.oy + sy, sw, sh, r.x + sx / px, r.y + sy / px, sw / px, sh / px);
}

/** Draw an atlas region revealed from its left edge up to design x `xTo`. */
const reveal = (ctx, r, px, xTo) => blit(ctx, r, px, r.x, r.y, xTo, r.y + r.h / px);

// ---------------------------------------------------------------------------
// Sheet and header
// ---------------------------------------------------------------------------

/** Bone ground with a faint cool-grey drafting grid, crisp at any size. */
function drawGround(ctx, W, H, px) {
  ctx.fillStyle = palette.bone;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = rgba(GRID, hairAlpha(0.26, px));
  const hair = hairline(px);
  for (let x = GRID_STEP; x < W; x += GRID_STEP) ctx.fillRect(snap(x, px), 0, hair, H);
  for (let y = GRID_STEP; y < H; y += GRID_STEP) ctx.fillRect(0, snap(y, px), W, hair);
}

/** Text that slides through a mask band; unmasked (and cheaper) at rest. */
function slidingText(ctx, text, x, y, offset) {
  if (offset === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y - 17, 1920, 23);
  ctx.clip();
  ctx.fillText(text, x, y + offset);
  ctx.restore();
}

const slideY = (t, tIn, tOut) =>
  (1 - ease.outCubic(seg(t, tIn, tIn + 0.5))) * 24 - ease.inBack(seg(t, tOut, tOut + 0.35)) * 24;

/** Where the rule under the heading starts and ends at time t (it draws on and off). */
const ruleSpan = (t) => [
  lerp(LEFT, RIGHT, ease.inOutCubic(seg(t, EXIT, EXIT + 0.5))),
  lerp(LEFT, RIGHT, ease.inOutCubic(seg(t, 0.05, 0.85))),
];

/** The parts of the header that do not tick with the clock. */
function drawHeaderStatic(ctx, t) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = F_HEAD;
  ctx.fillStyle = INK;
  const L = layoutGlyphs(ctx, 'Easing', F_HEAD);

  // The heading is already on the sheet under the wipe; on the way out its
  // glyphs lift out of a mask one after another. It is always set glyph by
  // glyph, so it rasterizes identically before and after the exit starts.
  const leaving = t >= EXIT;
  if (leaving) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEAD_BASE - 96, 1920, 132);
    ctx.clip();
  }
  for (const g of L.glyphs) {
    const k = leaving ? ease.inBack(seg(t, EXIT + g.i * 0.025, EXIT + 0.3 + g.i * 0.025)) : 0;
    if (k < 1) ctx.fillText(g.ch, HEAD_X + g.x, HEAD_BASE - k * 124);
  }
  if (leaving) ctx.restore();
  ctx.font = F_CAPTION;
  ctx.fillStyle = rgba(INK, 0.62);
  slidingText(ctx, 'eight ways to get from 0 to 1', HEAD_X + L.width + 30, HEAD_BASE, slideY(t, 0.2, EXIT + 0.04));

  const [x0, x1] = ruleSpan(t);
  if (x1 > x0) {
    ctx.fillStyle = rgba(INK, 0.3);
    ctx.fillRect(x0, RULE_Y, x1 - x0, 1);
  }
}

/** The shared clock: its readout, and the rule filling like a master timeline. */
function drawHeaderLive(ctx, t, u) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'right';
  ctx.font = F_CLOCK;
  ctx.fillStyle = INK;
  slidingText(ctx, `t = ${(u * CLOCK_DUR).toFixed(2)} s`, RIGHT, HEAD_BASE, slideY(t, 0.32, EXIT + 0.08));
  const [x0, x1] = ruleSpan(t);
  const xc = Math.min(lerp(LEFT, RIGHT, u), x1);
  if (xc > x0) {
    ctx.fillStyle = INK;
    ctx.fillRect(x0, RULE_Y - 0.5, xc - x0, 2);
  }
}

/**
 * Between the last card settling and the exit, the ground, grid, header and
 * all eight plates are static, so they are baked into one full-frame bitmap
 * and each frame draws only what moves on top of it.
 */
function sheetAt(px, cards, A) {
  let sheet = sheets.get(px);
  if (!sheet) {
    sheet = makeCanvas(1920 * px, 1080 * px);
    const g = sheet.getContext('2d');
    g.scale(px, px);
    drawGround(g, 1920, 1080, px);
    drawHeaderStatic(g, CLOCK_IN);
    for (const c of cards) {
      g.save();
      g.translate(snap(c.x, px), snap(c.y, px));
      blit(g, A[c.i].plate, px, 0, 0, CW + 1, CH + 1);
      g.restore();
    }
    if (sheets.size >= 2) sheets.clear();
    sheets.set(px, sheet);
  }
  return sheet;
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

/**
 * One study card: built in from its plate, then the plate (unless the baked
 * sheet already holds it) plus the parts that move with the clock.
 */
function drawCard(ctx, c, t, u, px, A, onSheet) {
  const tau = t - c.tIn;
  if (tau <= 0) return;
  // The card leaves on its own easing: the meta touch.
  const dy = c.fn(seg(t, c.tOut, c.tOut + EXIT_DUR)) * EXIT_DIST * c.dir;
  if (c.y + dy > 1080 || c.y + CH + dy < 0) return;
  // Settled cards sit on device pixels, so plates and layers stay crisp.
  const x = snap(c.x, px);
  const y = snap(c.y, px) + dy;
  const { plate } = A[c.i];

  ctx.save();
  if (tau < BUILD) {
    const pop = seg(tau, 0, 0.45);
    const sc = lerp(0.8, 1, ease.outBack(pop));
    ctx.translate(x + CW / 2, y + CH / 2 + (1 - ease.outCubic(pop)) * 18);
    ctx.scale(sc, sc);
    ctx.translate(-CW / 2, -CH / 2);
    ctx.globalAlpha = ease.outQuad(seg(tau, 0, 0.1));
    drawBuildIn(ctx, c, tau, px, plate);
  } else {
    ctx.translate(x, y);
    if (!onSheet) blit(ctx, plate, px, 0, 0, CW + 1, CH + 1);
  }
  drawReadout(ctx, c, tau, u);
  drawPlay(ctx, c, t, u, tau, px, A[c.i]);
  ctx.restore();
}

/** The card stock with its hairline frame. */
function drawStock(ctx, px) {
  const w = snap(CW, px);
  const h = snap(CH, px);
  const hair = hairline(px);
  ctx.fillStyle = CARD;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = rgba(INK, hairAlpha(0.22, px));
  ctx.fillRect(0, 0, w, hair);
  ctx.fillRect(0, h - hair, w, hair);
  ctx.fillRect(0, hair, hair, h - 2 * hair);
  ctx.fillRect(w - hair, hair, hair, h - 2 * hair);
}

/** The finished static drawing of a card, rendered once into its plate. */
function drawCardBody(ctx, c, px) {
  drawStock(ctx, px);

  // Label: colour key, name and definition.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = c.color;
  ctx.fillRect(20, 19, 9, 9);
  ctx.font = F_NAME;
  ctx.fillStyle = INK;
  ctx.fillText(c.name, 38, 29);
  ctx.fillStyle = rgba(INK, 0.55);
  drawRuns(ctx, c.runs, 20, 49);

  // Axes with arrowheads, and time ticks at equal steps of the clock: the
  // reference for the spacing chart below.
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  ctx.lineWidth = 1.5;
  line(ctx, OX - 4, OY, X_END, OY);
  line(ctx, OX, OY + 4, OX, Y_END);
  arrowhead(ctx, X_END + 2, OY, 1, 0);
  arrowhead(ctx, OX, Y_END - 2, 0, -1);
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= TICKS; i++) {
    const x = OX + (i / TICKS) * UW;
    ctx.moveTo(x, OY);
    ctx.lineTo(x, OY + (i === 0 || i === TICKS ? 6 : i % 4 === 0 ? 4 : 2.5));
  }
  ctx.stroke();

  // The 0-1 box, dashed at value 1 and time 1.
  ctx.strokeStyle = rgba(INK, 0.32);
  ctx.setLineDash([3, 4]);
  line(ctx, OX, OY - UH + 0.5, OX + UW, OY - UH + 0.5);
  line(ctx, OX + UW + 0.5, OY, OX + UW + 0.5, OY - UH);
  ctx.setLineDash([]);

  ctx.fillStyle = rgba(INK, 0.55);
  drawAxisText(ctx);

  // Track: dotted over its full reach, solid from 0 to 1, with end stops.
  ctx.lineWidth = 1;
  ctx.strokeStyle = rgba(INK, 0.28);
  ctx.setLineDash([2, 3]);
  line(ctx, 20, TRACK_Y, CW - 20, TRACK_Y);
  ctx.setLineDash([]);
  ctx.strokeStyle = rgba(INK, 0.7);
  line(ctx, OX, TRACK_Y, OX + UW, TRACK_Y);
  ctx.lineWidth = 1.5;
  line(ctx, OX, TRACK_Y - 7, OX, TRACK_Y + 7);
  line(ctx, OX + UW, TRACK_Y - 7, OX + UW, TRACK_Y + 7);
}

/** Tick labels and axis titles (the caller sets fillStyle and alpha). */
function drawAxisText(ctx) {
  ctx.font = F_TICK;
  ctx.textAlign = 'right';
  ctx.fillText('0', OX - 7, OY + 15);
  ctx.fillText('1', OX - 7, OY - UH + 4);
  ctx.textAlign = 'center';
  ctx.fillText('1', OX + UW, OY + 20);
  ctx.font = F_AXIS;
  ctx.textAlign = 'right';
  ctx.fillText('time', X_END, OY - 8);
  ctx.save();
  ctx.translate(28, OY - UH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText('value', 0, 0);
  ctx.restore();
}

/**
 * The build-in, composed from the finished plate: linework draws on by
 * revealing its own final pixels, while labels slide and fade as live text.
 */
function drawBuildIn(ctx, c, tau, px, plate) {
  drawStock(ctx, px);

  const kAxes = ease.outCubic(seg(tau, 0.12, 0.5));
  if (kAxes > 0) {
    blit(ctx, plate, px, OX - 6, OY - 5, lerp(OX - 6, X_END + 4, kAxes), OY + 7);
    blit(ctx, plate, px, OX - 5, lerp(OY + 5, Y_END - 4, kAxes), OX + 5, OY + 5);
  }
  const kBox = ease.inOutCubic(seg(tau, 0.22, 0.55));
  if (kBox > 0) {
    blit(ctx, plate, px, OX + 5, OY - UH - 1.5, lerp(OX + 5, OX + UW - 1, kBox), OY - UH + 2);
    blit(ctx, plate, px, OX + UW - 1, lerp(OY - 5, OY - UH - 1.5, kBox), OX + UW + 2, OY - 5);
  }
  const kTrack = ease.outCubic(seg(tau, 0.18, 0.52));
  if (kTrack > 0) blit(ctx, plate, px, 18, TRACK_Y - 8, lerp(18, CW - 18, kTrack), TRACK_Y + 8);

  const a = ctx.globalAlpha;
  const kText = ease.outCubic(seg(tau, 0.3, 0.55));
  if (kText > 0) {
    ctx.globalAlpha = a * kText;
    ctx.fillStyle = rgba(INK, 0.55);
    drawAxisText(ctx);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const kKey = ease.outBack(seg(tau, 0.1, 0.4));
  if (kKey > 0) {
    ctx.globalAlpha = a;
    ctx.fillStyle = c.color;
    ctx.fillRect(24.5 - 4.5 * kKey, 23.5 - 4.5 * kKey, 9 * kKey, 9 * kKey);
  }
  const kName = ease.outCubic(seg(tau, 0.1, 0.42));
  ctx.globalAlpha = a * kName;
  ctx.font = F_NAME;
  ctx.fillStyle = INK;
  ctx.fillText(c.name, 38 - (1 - kName) * 10, 29);
  const kDef = ease.outCubic(seg(tau, 0.16, 0.48));
  ctx.globalAlpha = a * kDef;
  ctx.fillStyle = rgba(INK, 0.55);
  drawRuns(ctx, c.runs, 20 - (1 - kDef) * 10, 49);
  ctx.globalAlpha = a;
}

/** Live readout of the eased value: the number the square is animating. */
function drawReadout(ctx, c, tau, u) {
  const k = ease.outCubic(seg(tau, 0.1, 0.42));
  if (k <= 0) return;
  const v = c.fn(u);
  const a = ctx.globalAlpha;
  ctx.globalAlpha = a * k;
  ctx.font = F_VALUE;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = u > 0 && u < 1 ? INK : rgba(INK, 0.45);
  ctx.fillText(`${v < -0.005 ? '−' : ''}${Math.abs(v).toFixed(2)}`, CW - 20 + (1 - k) * 10, 29);
  ctx.globalAlpha = a;
}

/** Curve, playhead, dot, square and spacing ticks: all read the one clock u. */
function drawPlay(ctx, c, t, u, tau, px, layers) {
  const kObj = ease.outBack(seg(tau, 0.3, 0.52));
  if (kObj <= 0) return;
  const v = c.fn(u);
  const head = OX + u * UW;

  // Playhead, in sync on every card.
  const kHead = seg(t, CLOCK_IN - 0.2, CLOCK_IN) * (1 - seg(t, CLOCK_OUT, CLOCK_OUT + 0.25));
  if (kHead > 0) {
    const w = hairline(px);
    ctx.fillStyle = rgba(INK, hairAlpha(0.45, px) * kHead);
    ctx.fillRect(head - w / 2, PLAYHEAD_TOP, w, TRACK_Y + 10 - PLAYHEAD_TOP);
  }

  // Spacing chart: a tick wherever the square was at each equal step of time.
  // Settled ticks come from a cached strip; only the newest still grow live.
  if (u > 0) {
    const age = (i) => (u - i / TICKS) * CLOCK_DUR;
    let settled = 0;
    while (settled <= TICKS && age(settled) >= TICK_POP) settled++;
    if (settled > 0) reveal(ctx, layers.strips[settled - 1], px, CW);
    ctx.fillStyle = c.color;
    for (let i = settled; i <= TICKS && age(i) >= 0; i++) {
      const h = 5 * ease.outBack(age(i) / TICK_POP);
      ctx.fillRect(OX + c.ticks[i] * UW - 0.625, TRACK_Y - h, 1.25, 2 * h);
    }
  }

  // Emphasis beat: hatching and a dimension sweep in where the curve left the box.
  if (layers.marks) {
    const start = CLOCK_OUT + 0.05 + c.calloutOrder * 0.08;
    const k = ease.inOutCubic(seg(t, start, start + 0.6));
    if (k > 0) reveal(ctx, layers.marks, px, lerp(OX - 2, CW - 16, k));
  }

  // The curve draws itself up to the playhead. Where the curve is steep, the
  // cached stroke's width would spill ahead of the dot, so the reveal stops
  // 2 px short and the last sliver is a live segment.
  if (u > 0) {
    const lay = layers.curve;
    const slope = Math.abs(c.fn(u + 0.002) - c.fn(u - 0.002)) * 250 * (UH / UW);
    if (u >= 1 || slope < 4) reveal(ctx, lay, px, u >= 1 ? OX + UW + 10 : head);
    else {
      reveal(ctx, lay, px, head - 2);
      const x0 = Math.max(OX, head - 2.5);
      ctx.strokeStyle = c.color;
      ctx.lineWidth = 3;
      line(ctx, x0, OY - c.fn((x0 - OX) / UW) * UH, head, OY - v * UH);
    }
  }

  // Dot riding the curve, with one soft pulse when the clock stops.
  const dotY = OY - v * UH;
  const ring = seg(t, CLOCK_OUT, CLOCK_OUT + 0.5);
  if (ring > 0 && ring < 1) {
    ctx.fillStyle = rgba(c.color, 0.22 * (1 - ring));
    ctx.beginPath();
    ctx.arc(head, dotY, 7 + 15 * ease.outCubic(ring), 0, TAU);
    ctx.fill();
  }
  const { dot } = layers;
  ctx.drawImage(dot.canvas, dot.ox, dot.oy, dot.w, dot.h, head + dot.x * kObj, dotY + dot.y * kObj, (dot.w / px) * kObj, (dot.h / px) * kObj);

  // Square on the track, stretched along its velocity (squash and stretch).
  const dt = 1 / 120;
  const vel = (c.fn(clamp01((t + dt - CLOCK_IN) / CLOCK_DUR)) - c.fn(clamp01((t - dt - CLOCK_IN) / CLOCK_DUR))) / (2 * dt);
  const stretch = 1 + Math.min(0.45, Math.abs(vel) * UW * 0.0006);
  const sw = 12 * stretch * kObj;
  const sh = (12 / stretch) * kObj;
  ctx.fillStyle = c.color;
  ctx.fillRect(OX + v * UW - sw / 2, TRACK_Y - sh / 2, sw, sh);
}

/** Section-cut hatching over the stretches where the curve leaves the box. */
function drawHatch(ctx, c) {
  ctx.save();
  ctx.beginPath();
  for (const r of c.regions) {
    ctx.moveTo(OX + r[0] * UW, OY - r[1] * UH);
    for (let i = 2; i < r.length; i += 2) ctx.lineTo(OX + r[i] * UW, OY - r[i + 1] * UH);
    ctx.closePath();
  }
  ctx.fillStyle = rgba(c.color, 0.1);
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = rgba(c.color, 0.75);
  ctx.lineWidth = 1;
  ctx.beginPath();
  const top = OY - 1.45 * UH;
  const bottom = OY + 0.15 * UH;
  for (let x = OX - (bottom - top); x < OX + UW; x += 5) {
    ctx.moveTo(x, bottom);
    ctx.lineTo(x + (bottom - top), top);
  }
  ctx.stroke();
  ctx.restore();
}

/** Dimension the peak overshoot in drafting style: extension lines, arrows, label. */
function drawDimension(ctx, c) {
  const yPeak = OY - c.peak * UH;
  const yOne = OY - UH;
  ctx.strokeStyle = rgba(INK, 0.5);
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 3]);
  line(ctx, OX + c.peakX * UW, yPeak + 0.5, DIM_X + 6, yPeak + 0.5);
  line(ctx, OX + UW, yOne + 0.5, DIM_X + 6, yOne + 0.5);
  ctx.setLineDash([]);
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  if (yOne - yPeak > 20) {
    line(ctx, DIM_X, yOne, DIM_X, yPeak);
    arrowhead(ctx, DIM_X, yOne, 0, 1, 5);
    arrowhead(ctx, DIM_X, yPeak, 0, -1, 5);
  } else {
    // Too short for arrows inside: drafting convention puts them outside.
    line(ctx, DIM_X, yOne + 10, DIM_X, yPeak - 10);
    arrowhead(ctx, DIM_X, yOne, 0, -1, 5);
    arrowhead(ctx, DIM_X, yPeak, 0, 1, 5);
  }
  ctx.font = F_TICK;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(`+${Math.round((c.peak - 1) * 100)}%`, DIM_X + 7, (yOne + yPeak) / 2);
}

export default defineScene({
  id: 'easing-study',
  title: 'Easing Study',
  duration: 6.5,
  color: '#FFD23F',
  transition: { type: 'wipe', duration: 0.7, color: '#FFD23F' },
  slug: { color: '#0B0C10' },
  // Crisp vector linework; the reel's film grain would read as noise on paper.
  post: { grain: 0 },
  notes: [
    'Penner easing family',
    'Damped spring in closed form',
    'One clock drives every panel',
    'Spacing charts from eased values',
    'Each card exits on its own curve',
  ],
  setup() {
    let order = 0;
    const cards = CURVES.map((c, i) => {
      const col = i % 4;
      const row = Math.floor(i / 4);
      const samples = new Float32Array(SAMPLES + 1);
      for (let k = 0; k <= SAMPLES; k++) samples[k] = c.fn(k / SAMPLES);
      const ticks = new Float32Array(TICKS + 1);
      for (let k = 0; k <= TICKS; k++) ticks[k] = c.fn(k / TICKS);
      // Peak found on a fine grid so the dimension lands on the true maximum.
      let peak = 1;
      let peakX = 1;
      for (let k = 0; k <= 4000; k++) {
        const val = c.fn(k / 4000);
        if (val > peak) {
          peak = val;
          peakX = k / 4000;
        }
      }
      return {
        ...c,
        i,
        x: LEFT + col * PITCH_X,
        y: TOP + row * PITCH_Y,
        tIn: CARDS_IN + col * 0.05 + row * 0.08,
        tOut: row === 0 ? EXIT + 0.33 + col * 0.06 : EXIT + 0.13 + col * 0.07,
        dir: row === 0 ? -1 : 1,
        runs: parseRuns(c.def),
        samples,
        ticks,
        peak,
        peakX,
        regions: outsideRegions(samples),
        calloutOrder: peak > 1.001 ? order++ : 0,
      };
    });
    // From here until the exit nothing static changes, so the baked sheet applies.
    const settled = Math.max(...cards.map((c) => c.tIn)) + BUILD;
    return { cards, settled };
  },
  render(ctx, s) {
    const { t, px } = s;
    const u = clamp01((t - CLOCK_IN) / CLOCK_DUR);
    const { cards, settled } = s.state;
    const A = atlasAt(px, cards);
    const onSheet = t >= settled && t < EXIT;
    if (onSheet) ctx.drawImage(sheetAt(px, cards, A), 0, 0, s.W, s.H);
    else {
      drawGround(ctx, s.W, s.H, px);
      drawHeaderStatic(ctx, t);
    }
    drawHeaderLive(ctx, t, u);
    for (const c of cards) drawCard(ctx, c, t, u, px, A, onSheet);
  },
});

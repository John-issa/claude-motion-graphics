// Data Story: the reel reports on itself. An odometer rolls up the frame
// count, a bar chart compares scene lengths and a Gantt strip lays every scene
// on one timeline under a live playhead. Every figure is read from s.reel, so
// the graphics stay true whenever the reel is re-cut.

import {
  defineScene,
  kf,
  seg,
  eseg,
  font,
  palette,
  rgba,
  mix,
  mixRGB,
  toHex,
  clamp01,
  lerp,
  smoothstep,
  makeCanvas,
  linearGradient,
} from '../engine/index.js';

// Navy ground and bone type. Sun marks this scene, mint marks transitions and
// signal is kept for the playhead alone.
const NAVY = '#0E1A3A';
const BONE = palette.bone;
const SUN = palette.sun;
const MINT = palette.mint;
const SIGNAL = palette.signal;
const MUTED = toHex(mixRGB(NAVY, BONE, 0.3));
const RULE = rgba(BONE, 0.36);
const GRID = rgba(BONE, 0.08);

const F = {
  hero: font(250, 'serif', 300),
  stat: font(84, 'serif', 350),
  label: font(15, 'mono', 500),
  small: font(13, 'mono', 500),
};
const TRACK = 2; // mono tracking, design px
// Martian Mono caps are 0.8 em tall; used to centre labels on bars and clips.
const LABEL_CAP = 12;
const SMALL_CAP = 10.4;
const CAPTION = 'frames, each computed on demand, none stored';

// Grid in design px. Title-safe is x 192-1728, y 108-972; the chapter slug
// owns the top-left corner, so every module starts below y 200.
const HERO = { x0: 192, x1: 848, rule: 204, base: 480, statsRule: 612, statsBase: 733 };
const BARS = { x0: 968, x1: 1728, rule: 204, top: 270, bottom: 700, h: 16 };
const GANTT = { x0: 192, x1: 1728, rule: 792, lane0: 848, lane1: 876, laneH: 20, axis: 910 };
const HEAD = 34; // module rule to label baseline

// Beats, in local seconds.
const T = { rules: 0.12, roll: 0.8, stats: 1.45, caption: 1.8, bars: 1.6, gantt: 3.2, playhead: 3.95, sweep: 4.7, exit: 6.05 };

// Motion vocabulary.
const DRAW = [0.45, 0, 0.15, 1]; // rules and axes: soft start, long glide
const GROW = [0.16, 0.84, 0.3, 1]; // bars: fast out, long settle
const ROLL = [0.35, 0.05, 0.25, 1]; // odometer: spin up, glide into the detent
const SETTLE_IN = [0.3, 0, 0.2, 1]; // content drifting into place behind the push
const OVERSHOOT = 0.07; // cells past the target digit before settling back
const SETTLE = 0.22; // seconds to drop back into the detent
const RISE = 0.42; // seconds for a column's zero to rise into the window
const SHUTTER = 0.5; // frames of motion blurred into a moving digit column

const DIGITS = '0123456789';

/** 2766 → "2,766" */
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * When an element at (x, y) starts to leave: a diagonal wave from the top-left
 * that runs just ahead of the next scene's slanted left-to-right wipe.
 */
const outAt = (x, y) => T.exit + clamp01((x - 192 + (y - 200) * 0.3) / 1800) * 0.5;

/** Smooth 0 → 1 → 0 bump across [a, a + d]. */
const bump = (t, a, d) => Math.sin(Math.PI * seg(t, a, a + d)) ** 2;

/**
 * The hold's highlight sweep is a recap: the scenes before this one light up
 * in turn, in both charts at once, and the wave lands on this scene as a
 * glint. `recap` is scene i's brightening; `glintAt` the glint's phase.
 */
const recapStep = (me) => Math.min(0.17, 0.8 / Math.max(1, me));
const recap = (t, i, me) => (i < me ? bump(t, T.sweep + i * recapStep(me), 0.5) : 0);
const glintAt = (t, me) => seg(t, T.sweep + me * recapStep(me) + 0.05, T.sweep + me * recapStep(me) + 0.75);

/** A soft band of light crossing the rect (x0, y, x1 - x0, h) at phase u. */
function glint(ctx, x0, y, x1, h, u) {
  if (u <= 0 || u >= 1 || x1 - x0 < 1) return;
  const w = 90;
  const gx = lerp(x0 - w, x1 + w, eseg(u, 0, 1, 'inOutSine'));
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y, x1 - x0, h);
  ctx.clip();
  ctx.globalAlpha = 1;
  ctx.fillStyle = linearGradient(ctx, gx - w, 0, gx + w, 0, [
    [0, 'rgba(255,255,255,0)'],
    [0.5, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
  ctx.fillRect(gx - w, y, 2 * w, h);
  ctx.restore();
}

/**
 * Tabular layout for a figure such as "2,766": each digit is centred in a cell
 * as wide as the widest digit, so a rolling column never nudges its
 * neighbours. Separators keep their own advance. `ink` and `inkRight` locate
 * the settled figure's ink, used to hang it optically on the margin.
 */
function figure(c, text, fontStr) {
  c.font = fontStr;
  c.letterSpacing = '0px';
  c.textAlign = 'center';
  let cell = 0;
  let desc = 0;
  for (const d of DIGITS) {
    const m = c.measureText(d);
    cell = Math.max(cell, m.width);
    desc = Math.max(desc, m.actualBoundingBoxDescent);
  }
  const cells = [];
  let x = 0;
  let cols = 0;
  for (const ch of text) {
    const digit = DIGITS.indexOf(ch);
    const w = digit >= 0 ? cell : c.measureText(ch).width;
    cells.push({ ch, digit, col: digit >= 0 ? cols++ : -1, cx: x + w / 2 });
    x += w;
  }
  const last = cells[cells.length - 1];
  const capH = c.measureText('0').actualBoundingBoxAscent;
  return {
    font: fontStr,
    cells,
    cols,
    cell,
    width: x,
    ink: cells[0].cx - c.measureText(text[0]).actualBoundingBoxLeft,
    inkRight: last.cx + c.measureText(last.ch).actualBoundingBoxRight,
    capH,
    desc: Math.max(0, desc),
    pitch: capH * 1.5, // distance between digits on a strip
    fade: capH * 0.26, // soft edges of the odometer window
  };
}

/** How far (in cells) a column has rolled on past its digit to exit, after a small anticipating dip. */
const exitRoll = (t, c) => kf(t, [[c.tOut, 0], [c.tOut + 0.42, 1, 'inBack']]);

/**
 * Where a digit column's strip sits at time t. Strip index k shows digit k for
 * 0 ≤ k ≤ digit and is blank elsewhere. The column rises from blank (index
 * -1) to 0, waits a beat, scrolls up to its digit, overshoots slightly and
 * settles, then rolls on into blank to exit.
 */
function stripPos(t, digit, c) {
  const count = kf(t, [
    [c.tRise, -1],
    [c.tRise + RISE, 0, 'outCubic'],
    [c.tIn, 0],
    [c.tLand, digit + OVERSHOOT, ROLL],
    [c.tLand + SETTLE, digit, 'inOutSine'],
  ]);
  return count + exitRoll(t, c);
}

/**
 * Vertical extent of a digit column's window around baseline y: clear a
 * little beyond a settled digit, then fading out over `fade`.
 */
const windowOf = (fig, y) => ({
  top: y - fig.capH * 1.04 - fig.fade,
  bottom: y + fig.desc + fig.capH * 0.02 + fig.fade,
});

/** Stops for a smoothstep ramp from `color` (opaque) to transparent. */
function rampStops(color) {
  const stops = [];
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    stops.push([u, rgba(color, 1 - u * u * (3 - 2 * u))]);
  }
  return stops;
}
const GROUND_RAMP = rampStops(NAVY);

/**
 * The digits of one strip around position `pos`, centred on cx. Digits whose
 * offset from the baseline (in cells) falls outside [lo, hi] would land
 * wholly outside the window, so they are skipped rather than clipped.
 */
function drawDigits(g, cx, y, pos, digit, pitch, lo = -1, hi = 1) {
  const k0 = Math.floor(pos);
  for (let k = k0; k <= k0 + 1; k++) {
    const o = k - pos;
    if (k >= 0 && k <= digit && o > lo && o < hi) g.fillText(DIGITS[k], cx, y + o * pitch);
  }
}

/**
 * Draw a figure as an odometer. `timing(col)` gives each digit column its
 * { tRise, tIn, tLand, tOut }.
 *
 * While anything moves, digits are clipped to the window and its top and
 * bottom edges are softened by ground-coloured ramps drawn over them, so
 * digits dissolve as they roll through (much cheaper than gradient-filled
 * glyphs). A column's smear is its strip travel across a half-frame shutter
 * centred on t: still columns draw one crisp glyph, moving ones add copies
 * spread along the smear, which reads as vertical motion blur.
 *
 * Separators ride their column's rise and exit (not its count), fading with
 * distance. They draw above the ramps, so a comma's tail is never masked.
 */
function drawFigure(ctx, s, fig, x, y, color, timing) {
  const half = SHUTTER / 120;
  const cols = [];
  const seps = [];
  let off = 0;
  let moving = false;
  for (const cell of fig.cells) {
    if (cell.digit < 0) {
      seps.push({ cell, off });
      continue;
    }
    const c = timing(cell.col);
    const d = cell.digit;
    const pos = stripPos(s.t, d, c);
    const ex = exitRoll(s.t, c);
    off = Math.min(0, pos - ex) + ex; // rise below the baseline, or exit above it
    const col = { cell, d, pos, p0: stripPos(s.t - half, d, c), p1: stripPos(s.t + half, d, c) };
    moving ||= col.pos !== d || col.p0 !== d || col.p1 !== d;
    cols.push(col);
  }
  const win = windowOf(fig, y);
  const left = x - fig.cell;
  const width = fig.width + 2 * fig.cell;
  // Offsets (in cells) beyond which a digit is wholly outside the window.
  const lo = (win.top - y - fig.desc) / fig.pitch;
  const hi = (win.bottom - y + fig.capH) / fig.pitch;
  ctx.save();
  ctx.font = fig.font;
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  if (moving) {
    ctx.beginPath();
    ctx.rect(left, win.top, width, win.bottom - win.top);
    ctx.clip();
  }
  for (const it of cols) {
    const cx = x + it.cell.cx;
    const smear = Math.abs(it.p1 - it.p0) * fig.pitch;
    const m = smoothstep(2, 8, smear);
    if (m < 1) {
      ctx.globalAlpha = 1 - m;
      drawDigits(ctx, cx, y, it.pos, it.d, fig.pitch, lo, hi);
    }
    if (m > 0) {
      const n = Math.min(6, Math.max(2, Math.ceil((smear * s.px) / 2.5)));
      ctx.globalAlpha = m * Math.min(1, 1.4 / n);
      for (let j = 0; j < n; j++) drawDigits(ctx, cx, y, lerp(it.p0, it.p1, (j + 0.5) / n), it.d, fig.pitch, lo, hi);
    }
  }
  ctx.restore();
  ctx.save();
  if (moving) {
    // Drawn outside the clip and overlapping its edges by a few pixels (the
    // gradient holds solid beyond them), so the clip's anti-aliased boundary
    // row is covered too.
    const lip = 3;
    ctx.fillStyle = linearGradient(ctx, 0, win.top, 0, win.top + fig.fade, GROUND_RAMP);
    ctx.fillRect(left, win.top - lip, width, fig.fade + lip);
    ctx.fillStyle = linearGradient(ctx, 0, win.bottom, 0, win.bottom - fig.fade, GROUND_RAMP);
    ctx.fillRect(left, win.bottom - fig.fade, width, fig.fade + lip);
  }
  ctx.font = fig.font;
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  for (const { cell, off: o } of seps) {
    const a = (1 - Math.min(1, Math.abs(o) * 1.6)) ** 2;
    if (a <= 0.004) continue;
    ctx.globalAlpha = a;
    ctx.fillText(cell.ch, x + cell.cx, y - o * fig.pitch);
  }
  ctx.restore();
}

/** Horizontal rule drawn on to fraction `pIn`, then retracted to the right by `pOut`. */
function hline(ctx, x0, x1, y, pIn, pOut, color, w = 1.5) {
  if (pIn <= pOut) return;
  const a = lerp(x0, x1, pOut);
  const b = lerp(x0, x1, pIn);
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.fillRect(a, y - w / 2, b - a, w);
}

/** A line of tracked text. Right and centre alignment compensate for the trailing tracking. */
function label(ctx, str, x, y, { f = F.label, color = BONE, alpha = 1, align = 'left', track = TRACK } = {}) {
  if (alpha <= 0.004) return;
  ctx.font = f;
  ctx.letterSpacing = `${track}px`;
  ctx.textAlign = align;
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillText(str, x + (align === 'right' ? track : align === 'center' ? track / 2 : 0), y);
}

/** In/out envelope for a label: fade and rise in, fade and drift right out. */
function envelope(t, tIn, tOut, dIn = 0.55, dOut = 0.32) {
  const k = eseg(t, tIn, tIn + dIn, 'outCubic');
  const o = eseg(t, tOut, tOut + dOut, 'inCubic');
  return { a: k * (1 - o), dy: (1 - k) * 10, dx: o * 18 };
}

/** Measure everything that depends on the reel once, so render only draws. */
function buildLayout(reel) {
  const c = makeCanvas(8, 8).getContext('2d');
  const measure = (text, f, track = TRACK) => {
    c.font = f;
    c.letterSpacing = `${track}px`;
    return c.measureText(text).width - track;
  };
  const n = reel.scenes.length;

  // Hero and secondary stats. The caption is sized to span the figure's ink.
  const hero = figure(c, group(reel.frames), F.hero);
  const heroInk = hero.inkRight - hero.ink;
  const captionSize = Math.min(30, (30 * heroInk) / measure(CAPTION, font(30, 'sans', 400), 0));
  const stats = [
    { value: String(n).padStart(2, '0'), name: 'SCENES' },
    { value: String(reel.fps), name: 'FPS' },
    { value: reel.duration.toFixed(1), name: 'SECONDS' },
  ].map((st) => ({ ...st, fig: figure(c, st.value, F.stat) }));

  // Bar chart. The label column is as wide as the longest measured title and
  // the plot leaves room for the widest value label, so nothing can collide.
  // Titles share one size, shrunk (to no less than 12 px) if the longest
  // would squeeze the plot; one still too long is cut with an ellipsis.
  const maxTitleW = (BARS.x1 - BARS.x0) * 0.4;
  let titles = reel.scenes.map((sc) => sc.title.toUpperCase());
  let titleSize = 15;
  const widest = Math.max(...titles.map((tt) => measure(tt, F.label)));
  if (widest > maxTitleW) titleSize = Math.max(12, (15 * maxTitleW) / widest);
  const titleFont = font(titleSize, 'mono', 500);
  titles = titles.map((tt) => {
    if (measure(tt, titleFont) <= maxTitleW) return tt;
    while (tt.length > 1 && measure(`${tt}…`, titleFont) > maxTitleW) tt = tt.slice(0, -1).trimEnd();
    return `${tt}…`;
  });
  const tx = BARS.x0 + measure('00', titleFont) + 18;
  const ax = tx + Math.max(...titles.map((tt) => measure(tt, titleFont))) + 32;
  const valueW = measure('00.0', F.label, 0.5);
  const maxDur = Math.max(...reel.scenes.map((sc) => sc.duration));
  const axisMax = Math.ceil(maxDur + 0.4);
  const k = (BARS.x1 - valueW - 16 - ax) / axisMax;
  const pitch = (BARS.bottom - BARS.top) / n;
  // A labelled gridline every 2 s (every second on a short axis).
  const step = axisMax > 6 ? 2 : 1;
  const ticks = [];
  for (let v = 0; v <= axisMax; v += step) ticks.push({ v, text: String(v) });
  const rows = reel.scenes.map((sc, i) => ({
    i,
    num: String(i + 1).padStart(2, '0'),
    title: titles[i],
    dur: sc.duration,
    y: BARS.top + pitch * (i + 0.5),
  }));

  // Gantt strip: scenes alternate between two lanes so that transitions show
  // as true overlaps in time. A clip's label sits clear of its incoming
  // transition.
  const gk = (GANTT.x1 - GANTT.x0) / reel.duration;
  const clips = reel.scenes.map((sc, i) => ({
    i,
    num: String(i + 1).padStart(2, '0'),
    start: sc.start,
    end: sc.end,
    head: i > 0 ? Math.max(sc.start, reel.scenes[i - 1].end) : sc.start,
    lane: i % 2,
  }));
  const overlaps = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = reel.scenes[i + 1].start;
    const b = reel.scenes[i].end;
    if (b > a) overlaps.push({ i, a, b });
  }
  const endLabel = `${reel.duration.toFixed(1)} S`;
  const endW = measure(endLabel, F.small);
  const gTicks = [];
  for (let v = 0; v < reel.duration - 1e-6; v += 10) {
    const x = GANTT.x0 + v * gk;
    // Drop a tick label that would crowd the end-of-reel label.
    const fits = x + measure(String(v), F.small) / 2 < GANTT.x1 - endW - 24;
    gTicks.push({ v, x, text: fits ? String(v) : '' });
  }

  // Legend, set right to left from the margin: swatch, gap, text.
  const legend = [
    { text: 'THIS SCENE', color: SUN },
    { text: 'TRANSITION', color: MINT },
  ];
  let lx = GANTT.x1;
  for (let i = legend.length - 1; i >= 0; i--) {
    const it = legend[i];
    it.x = lx - measure(it.text, F.small);
    it.sx = it.x - 20;
    lx = it.sx - 32;
  }
  // The playhead's frame label stays between the module label and the legend.
  const flagW = measure('FRAME 0,000,000', F.small);
  const flagMin = GANTT.x0 + measure('REEL TIMELINE', F.label) + 32 + flagW / 2;
  const flagMax = Math.max(flagMin, legend[0].sx - 32 - flagW / 2);

  return {
    hero,
    caption: font(captionSize, 'sans', 400),
    stats,
    bars: { rows, tx, ax, k, ticks, titleFont, titleCap: titleSize * 0.8 },
    gantt: { gk, clips, overlaps, ticks: gTicks, endLabel, legend, flagMin, flagMax },
  };
}

/** One opaque fill: a full-frame solid is nearly free, a gradient is not. */
function drawGround(ctx, s) {
  ctx.globalAlpha = 1;
  ctx.fillStyle = NAVY;
  ctx.fillRect(0, 0, s.W, s.H);
}

function drawHero(ctx, s, L) {
  const t = s.t;
  const fig = L.hero;
  const out = outAt(HERO.x0, HERO.rule);
  hline(ctx, HERO.x0, HERO.x1, HERO.rule, eseg(t, T.rules, T.rules + 1.1, DRAW), eseg(t, out, out + 0.45, DRAW), RULE);
  const e = envelope(t, 0.4, out);
  label(ctx, 'TOTAL FRAMES', HERO.x0 + e.dx, HERO.rule + HEAD + e.dy, { alpha: 0.72 * e.a });

  // The odometer counts up column by column and lands left to right, each
  // digit scrolling from 0 to its value and settling into its detent.
  drawFigure(ctx, s, fig, HERO.x0 - fig.ink, HERO.base, BONE, (col) => ({
    tRise: 0.3 + col * 0.06,
    tIn: T.roll + col * 0.07,
    tLand: T.roll + 1.05 + col * 0.18,
    tOut: outAt(HERO.x0 + col * 150, HERO.base) - 0.06,
  }));

  // Caption rises out of a mask under the figure.
  const cy = HERO.base + 62;
  const k = eseg(t, T.caption, T.caption + 0.7, 'outCubic');
  const co = outAt(HERO.x0 + 200, cy);
  const o = eseg(t, co, co + 0.35, 'inCubic');
  if (k > 0 && o < 1) {
    ctx.save();
    if (k < 1) {
      ctx.beginPath();
      ctx.rect(HERO.x0 - 8, cy - 34, HERO.x1 - HERO.x0 + 60, 46);
      ctx.clip();
    }
    ctx.font = L.caption;
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.74 * (1 - o);
    ctx.fillStyle = BONE;
    ctx.fillText(CAPTION, HERO.x0 + o * 18, cy + (1 - k) * 44);
    ctx.restore();
  }
}

function drawStats(ctx, s, L) {
  const t = s.t;
  const out = outAt(HERO.x0, HERO.statsRule);
  hline(ctx, HERO.x0, HERO.x1, HERO.statsRule, eseg(t, 1.0, 2.0, DRAW), eseg(t, out, out + 0.45, DRAW), RULE);
  const cellW = (HERO.x1 - HERO.x0) / L.stats.length;
  L.stats.forEach((st, j) => {
    const x = HERO.x0 + j * cellW;
    const t0 = T.stats + j * 0.14;
    const o = outAt(x, HERO.statsRule);
    const e = envelope(t, t0 - 0.1, o);
    label(ctx, st.name, x + e.dx, HERO.statsRule + HEAD + e.dy, { alpha: 0.72 * e.a });
    drawFigure(ctx, s, st.fig, x - st.fig.ink, HERO.statsBase, BONE, (col) => ({
      tRise: t0 - 0.45 + col * 0.05,
      tIn: t0 + col * 0.06,
      tLand: t0 + 0.8 + col * 0.12,
      tOut: o + col * 0.04,
    }));
  });
}

function drawBars(ctx, s, L) {
  const t = s.t;
  const me = s.index;
  const B = L.bars;
  const out = outAt(BARS.x0, BARS.rule);
  hline(ctx, BARS.x0, BARS.x1, BARS.rule, eseg(t, T.rules + 0.12, T.rules + 1.22, DRAW), eseg(t, out, out + 0.45, DRAW), RULE);
  const e = envelope(t, 0.5, out);
  label(ctx, 'SCENE DURATION', BARS.x0 + e.dx, BARS.rule + HEAD + e.dy, { alpha: 0.72 * e.a });
  const e2 = envelope(t, 0.6, outAt(BARS.x1, BARS.rule));
  label(ctx, 'SECONDS', BARS.x1 + e2.dx, BARS.rule + HEAD + e2.dy, { alpha: 0.45 * e2.a, align: 'right' });

  // Gridlines grow down from the top; the zero line is the axis.
  for (const tk of B.ticks) {
    const gx = B.ax + tk.v * B.k;
    const d = eseg(t, 0.55 + tk.v * 0.06, 1.35 + tk.v * 0.06, DRAW);
    const o = outAt(gx, BARS.top);
    const fade = 1 - eseg(t, o, o + 0.35, 'inCubic');
    if (d > 0 && fade > 0) {
      ctx.globalAlpha = fade;
      ctx.fillStyle = tk.v === 0 ? RULE : GRID;
      const w = tk.v === 0 ? 1.5 : 1;
      ctx.fillRect(gx - w / 2, BARS.top - 8, w, (BARS.bottom - BARS.top + 16) * d);
    }
    const te = envelope(t, 1.0 + tk.v * 0.05, o);
    label(ctx, tk.text, gx + te.dx, BARS.bottom + 33 + te.dy, { f: F.small, align: 'center', alpha: 0.5 * te.a });
  }

  for (const r of B.rows) {
    const mine = r.i === me;
    const t0 = T.bars + r.i * 0.12;
    const g = eseg(t, t0, t0 + 1.0, GROW);
    const o = outAt(B.ax, r.y);
    const gone = eseg(t, o, o + 0.4, 'inCubic');
    const h = recap(t, r.i, me);
    const e = envelope(t, t0 - 0.22, o);
    const base = r.y + LABEL_CAP / 2;
    const ty = r.y + B.titleCap / 2 + e.dy * 0.6;
    label(ctx, r.num, BARS.x0 + e.dx, ty, { f: B.titleFont, color: mine ? SUN : BONE, alpha: (mine ? 1 : 0.38 + 0.3 * h) * e.a });
    label(ctx, r.title, B.tx + e.dx, ty, { f: B.titleFont, alpha: (mine ? 1 : 0.62 + 0.38 * h) * e.a });

    if (g <= 0) continue;
    const len = r.dur * B.k * g;
    const x1 = B.ax + len;
    const x0 = B.ax + len * gone; // exits by collapsing toward its end
    if (x1 - x0 > 0.2) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = mine ? SUN : mix(MUTED, BONE, 0.42 * h);
      ctx.fillRect(x0, r.y - BARS.h / 2, x1 - x0, BARS.h);
      if (mine) glint(ctx, x0, r.y - BARS.h / 2, x1, BARS.h, glintAt(t, me));
    }
    // The value rides the bar end and counts up with it.
    const va = clamp01(g * 5) * (1 - eseg(t, o + 0.1, o + 0.4, 'inCubic'));
    label(ctx, (r.dur * g).toFixed(1), x1 + 14 + gone * 18, base, {
      color: mine ? SUN : BONE,
      alpha: (mine ? 1 : 0.62 + 0.38 * h) * va,
      track: 0.5,
    });
  }
}

function drawGantt(ctx, s, L) {
  const t = s.t;
  const G = L.gantt;
  const X = (v) => GANTT.x0 + v * G.gk;
  const me = s.index;
  const now = s.reel.scenes[me].start + t; // this instant's true global time
  const bottom = GANTT.lane1 + GANTT.laneH;

  const out = outAt(GANTT.x0, GANTT.rule);
  hline(ctx, GANTT.x0, GANTT.x1, GANTT.rule, eseg(t, T.rules + 0.25, T.rules + 1.4, DRAW), eseg(t, out, out + 0.5, DRAW), RULE);
  const e = envelope(t, 0.65, out);
  label(ctx, 'REEL TIMELINE', GANTT.x0 + e.dx, GANTT.rule + HEAD + e.dy, { alpha: 0.72 * e.a });

  // Time axis: a labelled tick every 10 s and the reel's end called out.
  const axOut = outAt(GANTT.x0, GANTT.axis);
  const axGone = eseg(t, axOut, axOut + 0.5, DRAW);
  hline(ctx, GANTT.x0, GANTT.x1, GANTT.axis, eseg(t, 0.55, 1.65, DRAW), axGone, RULE, 1);
  const axEnd = lerp(GANTT.x0, GANTT.x1, axGone); // left end of the retracting axis
  for (const tk of G.ticks) {
    // Ticks grow down from the axis and leave with it as it retracts past them.
    const d = eseg(t, 0.9 + tk.v * 0.012, 1.3 + tk.v * 0.012, 'outCubic') * clamp01((tk.x - axEnd + 12) / 12);
    const o = outAt(tk.x, GANTT.axis);
    if (d > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = RULE;
      ctx.fillRect(tk.x - 0.5, GANTT.axis, 1, 9 * d);
    }
    if (tk.text) {
      const te = envelope(t, 1.05 + tk.v * 0.012, o);
      label(ctx, tk.text, tk.x + te.dx, GANTT.axis + 32 + te.dy, { f: F.small, align: tk.v === 0 ? 'left' : 'center', alpha: 0.5 * te.a });
    }
  }
  const ee = envelope(t, 1.5, outAt(GANTT.x1, GANTT.axis));
  label(ctx, G.endLabel, GANTT.x1 + ee.dx, GANTT.axis + 32 + ee.dy, { f: F.small, align: 'right', alpha: 0.8 * ee.a });

  for (const it of G.legend) {
    const le = envelope(t, T.gantt + 0.3, outAt(it.sx, GANTT.rule));
    if (le.a <= 0) continue;
    ctx.globalAlpha = le.a;
    ctx.fillStyle = it.color;
    ctx.fillRect(it.sx + le.dx, GANTT.rule + HEAD - SMALL_CAP + le.dy, 10, 10);
    label(ctx, it.text, it.x + le.dx, GANTT.rule + HEAD + le.dy, { f: F.small, alpha: 0.72 * le.a });
  }

  // Clips are revealed by a front that sweeps the timeline from start to end.
  const front = s.reel.duration * eseg(t, T.gantt, T.gantt + 1.1, 'inOutCubic');
  for (const cl of G.clips) {
    const shown = Math.min(cl.end, front);
    if (shown <= cl.start) continue;
    const y = cl.lane ? GANTT.lane1 : GANTT.lane0;
    const xa = X(cl.start);
    const xb = X(shown);
    const o = outAt(xa, y);
    const gone = eseg(t, o, o + 0.4, 'inCubic');
    const x0 = lerp(xa, xb, gone); // exits by collapsing toward its end
    const mine = cl.i === me;
    ctx.globalAlpha = 1;
    if (mine) {
      // This scene: solid sun until the playhead lands, which splits it into
      // the part already played and an outline of the part still to come.
      const xp = Math.min(Math.max(X(now), x0), xb);
      ctx.fillStyle = SUN;
      ctx.fillRect(x0, y, xp - x0, GANTT.laneH);
      glint(ctx, x0, y, xp, GANTT.laneH, glintAt(t - 0.12, me));
      if (xb - xp > 0.2) {
        // The unplayed fill drains toward the clip's end (overlapping the
        // played part by a pixel, so no seam shows between the two).
        const xf = lerp(xp, xb, eseg(t, T.playhead + 0.1, T.playhead + 0.6, 'inOutCubic'));
        if (xb - xf > 0.2) ctx.fillRect(xf - 1, y, xb - xf + 1, GANTT.laneH);
        // The outline is built from fills: a stroked path can force a slow
        // stencil pass on GPU canvases.
        const lw = 1.5;
        ctx.fillRect(xp, y, xb - xp, lw);
        ctx.fillRect(xp, y + GANTT.laneH - lw, xb - xp, lw);
        ctx.fillRect(Math.max(xp, xb - lw), y, Math.min(lw, xb - xp), GANTT.laneH);
      }
    } else {
      ctx.fillStyle = mix(MUTED, BONE, 0.42 * recap(t, cl.i, me));
      ctx.fillRect(x0, y, xb - x0, GANTT.laneH);
    }
    // The label leaves before its clip has collapsed onto it.
    const lx = X(cl.head) + 8;
    const la = clamp01((xb - lx - 20) / 24) * clamp01(1 - gone * 2.5);
    label(ctx, cl.num, Math.max(lx, x0 + 8), y + GANTT.laneH / 2 + SMALL_CAP / 2, { f: F.small, color: mine ? NAVY : BONE, alpha: 0.85 * la, track: 1 });
  }

  // Transitions: a mint bridge between the lanes wherever two clips overlap.
  // It draws on with the front and leaves like the clips, toward its end.
  ctx.globalAlpha = 1;
  ctx.fillStyle = MINT;
  for (const ov of G.overlaps) {
    const p = clamp01((front - ov.a) / Math.max(0.001, ov.b - ov.a));
    const xa = X(ov.a);
    const xb = lerp(xa, X(ov.b), p);
    const o = outAt(xa, GANTT.lane0);
    const x0 = lerp(xa, xb, eseg(t, o, o + 0.4, 'inCubic'));
    if (xb - x0 > 0.2) ctx.fillRect(x0, GANTT.lane0 + GANTT.laneH, xb - x0, GANTT.lane1 - GANTT.lane0 - GANTT.laneH);
  }

  // Playhead at the true global time, with the live frame number.
  const px = X(now);
  const pOut = outAt(px, GANTT.lane0);
  const pa = eseg(t, T.playhead, T.playhead + 0.3, 'outCubic') * (1 - eseg(t, pOut, pOut + 0.3, 'inCubic'));
  if (pa > 0) {
    const drop = (1 - eseg(t, T.playhead, T.playhead + 0.55, 'outBack')) * -16;
    const top = GANTT.lane0 - 8 + drop;
    ctx.globalAlpha = pa;
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(px - 1, top, 2, bottom + 12 - top);
    // The head is the lower half of a diamond: a rotated square clipped by a
    // rect, which stays on the fast path where a triangle path would not.
    ctx.save();
    ctx.beginPath();
    ctx.rect(px - 8, top - 8, 16, 8);
    ctx.clip();
    ctx.translate(px, top - 8);
    ctx.rotate(Math.PI / 4);
    ctx.fillRect(-5.66, -5.66, 11.31, 11.31);
    ctx.restore();
    const fx = Math.min(Math.max(px, G.flagMin), G.flagMax);
    label(ctx, `FRAME ${group(s.frame)}`, fx, GANTT.rule + HEAD + drop, { f: F.small, color: SIGNAL, align: 'center', alpha: pa });
  }
}

/** Modules by row, top to bottom. */
const ROWS = [[drawHero, drawBars], [drawStats], [drawGantt]];

export default defineScene({
  id: 'data',
  title: 'Data Story',
  duration: 7.0,
  color: '#2446FF',
  transition: { type: 'push', duration: 0.7, dir: 'up' },
  notes: [
    "Every number read from the reel's own timeline",
    'Odometer digits in fixed-width cells',
    'Staggered bar growth with measured labels',
    'Live playhead at the true global time',
  ],
  // Crisp hairlines and small type: film grain would read as noise here.
  post: { grain: 0 },
  setup({ reel }) {
    return buildLayout(reel);
  },
  render(ctx, s) {
    drawGround(ctx, s);
    // Content trails the push a little and settles after it lands, lower rows
    // later: overlapping action between the transition and the layout.
    ROWS.forEach((row, i) => {
      ctx.save();
      ctx.translate(0, (70 + 25 * i) * (1 - eseg(s.t, 0, 1.2 + 0.1 * i, SETTLE_IN)));
      for (const draw of row) draw(ctx, s, s.state);
      ctx.restore();
    });
  },
});

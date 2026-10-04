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
  clamp,
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

// One mono size carries every label, tick and legend; the playhead's readout
// is the only larger mono line. The hero is fitted to its column in setup.
const HERO_SIZE = 250;
const F = {
  stat: font(84, 'serif', 350),
  label: font(16, 'mono', 500),
  flag: font(18, 'mono', 500),
};
const TRACK = 2; // mono tracking, design px
const CAPTION = 'frames, each computed on demand, none stored';

// Grid in design px. Title-safe is x 192-1728, y 108-972; the chapter slug
// owns the top-left corner, so every module starts below y 200. The hero
// hangs from `cap`, the line its tallest digit reaches.
const HERO = { x0: 192, x1: 848, rule: 204, cap: 303, statsRule: 612, statsBase: 733 };
const BARS = { x0: 968, x1: 1728, rule: 204, top: 270, bottom: 700, h: 16 };
const GANTT = { x0: 192, x1: 1728, rule: 792, lane0: 850, lane1: 882, laneH: 24, axis: 918 };
const HEAD = 34; // module rule to label baseline

// Beats, in local seconds. The scaffold (rules and labels) is already drawing
// on as the push reveals it; the data follows it.
const T = { rise: 0.1, roll: 0.8, stats: 1.45, caption: 1.8, bars: 1.6, gantt: 3.2, playhead: 3.95, sweep: 4.7, exit: 6.05 };

// Motion vocabulary.
const ARRIVE = 'outCubic'; // scaffold entering with the push: fast out, settled as it lands
const DRAW = [0.45, 0, 0.15, 1]; // axes, and every retraction: soft start, long glide
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

/** The playhead's readout, padded so a mono line never changes length. */
const flagText = (now, frame, tw, fw) => `${now.toFixed(1).padStart(tw)} S · FRAME ${group(frame).padStart(fw)}`;

/** A tick step of 1, 2 or 5 × 10^k that cuts [0, max] into about `target` intervals. */
function niceStep(max, target) {
  const p = 10 ** Math.floor(Math.log10(max / target));
  let best = p;
  for (const k of [2, 5, 10]) if (Math.abs(max / (k * p) - target) < Math.abs(max / best - target)) best = k * p;
  return best;
}

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
 *
 * The odometer window is cut just outside the tallest digit (`top` above the
 * baseline, `bot` below) and softened by a short fade beyond that, so nothing
 * at rest is ever faded. The strip's pitch is a third longer than the window:
 * a column shows one digit at rest and two partial ones mid-roll, never more.
 */
function figure(c, text, fontStr) {
  c.font = fontStr;
  c.letterSpacing = '0px';
  c.textAlign = 'center';
  let cell = 0;
  let top = 0;
  let bot = 0;
  for (const d of DIGITS) {
    const m = c.measureText(d);
    cell = Math.max(cell, m.width);
    top = Math.max(top, m.actualBoundingBoxAscent);
    bot = Math.max(bot, m.actualBoundingBoxDescent);
  }
  const cells = [];
  let x = 0;
  let cols = 0;
  let sepBot = 0;
  for (const ch of text) {
    const digit = DIGITS.indexOf(ch);
    const m = c.measureText(ch);
    if (digit < 0) sepBot = Math.max(sepBot, m.actualBoundingBoxDescent);
    const w = digit >= 0 ? cell : m.width;
    cells.push({ ch, digit, col: digit >= 0 ? cols++ : -1, cx: x + w / 2 });
    x += w;
  }
  // An extra turn for a column that would otherwise travel no further than
  // the one to its left, so the low-order columns whir as in a count-up. One
  // turn at most: more would pass half a digit per frame at the peak, where
  // a strip seen at 60 fps starts to wheel backwards.
  const turns = [];
  let prev = -1;
  for (const cl of cells) {
    if (cl.digit < 0) continue;
    const k = cl.digit <= prev ? 1 : 0;
    turns.push(k);
    prev = cl.digit + 10 * k;
  }
  const last = cells[cells.length - 1];
  const fade = Math.max(8, top * 0.1);
  const clear = top * 0.01;
  const winTop = top + clear + fade;
  const winBot = Math.max(0, bot) + clear + fade;
  return {
    font: fontStr,
    cells,
    cols,
    turns,
    cell,
    width: x,
    ink: cells[0].cx - c.measureText(text[0]).actualBoundingBoxLeft,
    inkRight: last.cx + c.measureText(last.ch).actualBoundingBoxRight,
    top,
    bot: Math.max(0, bot),
    sepBot,
    fade,
    winTop,
    winBot,
    pitch: 1.35 * (winTop + winBot), // distance between digits on a strip
  };
}

/** How far (in cells) a column has rolled on past its digit to exit: straight up, accelerating. */
const exitRoll = (t, c) => eseg(t, c.tOut, c.tOut + 0.36, 'inCubic');

/**
 * Where a digit column's strip sits at time t. Strip index k shows digit
 * k mod 10 for 0 ≤ k ≤ target and is blank elsewhere, so a column given extra
 * turns spins through whole revolutions before landing. The column rises from
 * blank (index -1) to 0, waits a beat, scrolls up to its target, overshoots
 * slightly and settles, then rolls on into blank to exit.
 */
function stripPos(t, target, c) {
  const count = kf(t, [
    [c.tRise, -1],
    [c.tRise + RISE, 0, 'outCubic'],
    [c.tIn, 0],
    [c.tLand, target + (target > 0 ? OVERSHOOT : 0), ROLL],
    [c.tLand + SETTLE, target, 'inOutSine'],
  ]);
  return count + exitRoll(t, c);
}

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
 * Returns whether anything was drawn.
 */
function drawDigits(g, cx, y, pos, target, pitch, lo, hi) {
  const k0 = Math.floor(pos);
  let drawn = false;
  for (let k = k0; k <= k0 + 1; k++) {
    const o = k - pos;
    if (k >= 0 && k <= target && o > lo && o < hi) {
      g.fillText(DIGITS[k % 10], cx, y + o * pitch);
      drawn = true;
    }
  }
  return drawn;
}

/**
 * Draw a figure as an odometer. `timing(cell)` gives each digit column its
 * { tRise, tIn, tLand, tOut, turns }.
 *
 * While anything moves, digits are clipped to the window and its top and
 * bottom edges are softened by ground-coloured ramps drawn over the columns
 * that reach them, so digits dissolve as they roll through (much cheaper than
 * gradient-filled glyphs). A column's smear is its strip travel across a
 * half-frame shutter centred on t: a still column draws one crisp glyph, a
 * moving one adds copies spread along the smear, 2.5 physical px apart up to
 * a cap tied to the output size, which reads as vertical motion blur rather
 * than ghosts. A spinning column also dims a little, as a real smear spreads
 * its ink.
 *
 * Separators ride their column's rise and exit (not its count), fading with
 * distance. They draw above the ramps, so a comma's tail is never masked.
 */
function drawFigure(ctx, s, fig, x, y, color, timing) {
  const half = SHUTTER / (2 * s.fps);
  const maxCopies = s.px > 0.75 ? 20 : 16;
  const cols = [];
  const seps = [];
  let off = 0;
  let still = true;
  for (const cell of fig.cells) {
    if (cell.digit < 0) {
      seps.push({ cell, off });
      continue;
    }
    const c = timing(cell);
    const target = cell.digit + 10 * (c.turns || 0);
    const pos = stripPos(s.t, target, c);
    const ex = exitRoll(s.t, c);
    off = Math.min(0, pos - ex) + ex; // rise below the baseline, or exit above it
    const p0 = stripPos(s.t - half, target, c);
    const p1 = stripPos(s.t + half, target, c);
    const rest = pos === target && p0 === target && p1 === target;
    still &&= rest;
    // A column dissolves as it rolls out, so no half-digit lingers at the edge.
    cols.push({ cell, target, pos, p0, p1, rest, a: 1 - smoothstep(0.15, 0.55, ex) });
  }
  const top = y - fig.winTop;
  const bottom = y + fig.winBot;
  // Offsets (in cells) beyond which a digit is wholly outside the window.
  const lo = -(fig.winTop + fig.bot) / fig.pitch;
  const hi = (fig.winBot + fig.top) / fig.pitch;
  ctx.save();
  ctx.font = fig.font;
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  if (!still) {
    ctx.beginPath();
    ctx.rect(x - fig.cell, top, fig.width + 2 * fig.cell, bottom - top);
    ctx.clip();
  }
  // The span of columns whose digits may reach the window's soft edges.
  let r0 = Infinity;
  let r1 = -Infinity;
  for (const it of cols) {
    const cx = x + it.cell.cx;
    ctx.fillStyle = color;
    if (it.rest) {
      ctx.globalAlpha = 1;
      ctx.fillText(DIGITS[it.target % 10], cx, y);
      continue;
    }
    const travel = Math.abs(it.p1 - it.p0); // cells per shutter
    const smear = travel * fig.pitch * s.px; // physical px
    const m = smoothstep(1.5, 4.5, smear);
    let drawn = false;
    if (m < 1) {
      ctx.globalAlpha = (1 - m) * it.a;
      drawn = drawDigits(ctx, cx, y, it.pos, it.target, fig.pitch, lo, hi);
    }
    if (m > 0) {
      // Per-copy alpha stays at 0.08 or above: dozens of fainter draws pile
      // up 8-bit rounding into a visible colour cast on both raster paths.
      // The dimming goes into the colour for the same reason.
      const n = Math.min(maxCopies, Math.max(2, Math.ceil(smear / 2.5)));
      ctx.globalAlpha = m * Math.min(1, 1.6 / n) * it.a;
      ctx.fillStyle = mix(color, NAVY, 0.3 * smoothstep(0.04, 0.2, travel));
      for (let j = 0; j < n; j++) {
        drawn = drawDigits(ctx, cx, y, lerp(it.p0, it.p1, (j + 0.5) / n), it.target, fig.pitch, lo, hi) || drawn;
      }
    }
    if (drawn) {
      r0 = Math.min(r0, cx - fig.cell / 2);
      r1 = Math.max(r1, cx + fig.cell / 2);
    }
  }
  ctx.restore();
  ctx.save();
  if (r1 > r0) {
    // Drawn outside the clip and overlapping its edges by a few pixels (the
    // gradient holds solid beyond them), so the clip's anti-aliased boundary
    // row is covered too.
    const lip = 3;
    const pad = fig.cell * 0.1;
    ctx.fillStyle = linearGradient(ctx, 0, top, 0, top + fig.fade, GROUND_RAMP);
    ctx.fillRect(r0 - pad, top - lip, r1 - r0 + 2 * pad, fig.fade + lip);
    ctx.fillStyle = linearGradient(ctx, 0, bottom, 0, bottom - fig.fade, GROUND_RAMP);
    ctx.fillRect(r0 - pad, bottom - fig.fade, r1 - r0 + 2 * pad, fig.fade + lip);
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
  c.font = F.label;
  c.letterSpacing = '0px';
  const labelCap = c.measureText('H').actualBoundingBoxAscent; // centres labels on bars and clips
  const n = reel.scenes.length;

  // Hero: the largest size up to HERO_SIZE whose ink fits its column (a long
  // reel's five-digit total shrinks rather than crossing the gutter).
  const span = HERO.x1 - HERO.x0;
  const total = group(reel.frames);
  let heroSize = HERO_SIZE;
  let hero = figure(c, total, font(heroSize, 'serif', 300));
  for (let i = 0; i < 3 && hero.inkRight - hero.ink > span; i++) {
    heroSize *= (0.995 * span) / (hero.inkRight - hero.ink);
    hero = figure(c, total, font(heroSize, 'serif', 300));
  }
  const heroBase = HERO.cap + hero.top;

  // The caption spans the figure's ink and sits a clear gap below its lowest
  // descender (the comma's tail), so figure and caption never touch.
  const heroInk = hero.inkRight - hero.ink;
  const capSize = clamp((30 * heroInk) / measure(CAPTION, font(30, 'sans', 400), 0), 20, 30);
  const capFont = font(capSize, 'sans', 400);
  c.font = capFont;
  c.letterSpacing = '0px';
  const cm = c.measureText(CAPTION);
  const capY = heroBase + Math.max(hero.bot, hero.sepBot) + capSize * 0.75 + cm.actualBoundingBoxAscent;
  const caption = {
    font: capFont,
    y: capY,
    top: capY - cm.actualBoundingBoxAscent - capSize * 0.2,
    bottom: capY + cm.actualBoundingBoxDescent + capSize * 0.2,
    rise: capSize * 1.5,
  };

  const stats = [
    { value: String(n).padStart(2, '0'), name: 'SCENES' },
    { value: String(reel.fps), name: 'FPS' },
    { value: reel.duration.toFixed(1), name: 'SECONDS' },
  ].map((st) => ({ ...st, fig: figure(c, st.value, F.stat) }));

  // Bar chart. The label column is as wide as the longest measured title and
  // the plot leaves room for the widest value label, so nothing can collide.
  // Titles share one size, shrunk (to no less than 13 px) if the longest
  // would squeeze the plot; one still too long is cut with an ellipsis.
  const maxTitleW = (BARS.x1 - BARS.x0) * 0.4;
  let titles = reel.scenes.map((sc) => sc.title.toUpperCase());
  let titleSize = 16;
  const widest = Math.max(...titles.map((tt) => measure(tt, F.label)));
  if (widest > maxTitleW) titleSize = Math.max(13, (16 * maxTitleW) / widest);
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
  // About four labelled gridlines, on a round step, whatever the durations.
  const step = niceStep(maxDur + 0.4, 4);
  const axisMax = Math.ceil((maxDur + 0.4) / step) * step;
  const k = (BARS.x1 - valueW - 16 - ax) / axisMax;
  const pitch = (BARS.bottom - BARS.top) / n;
  const ticks = [];
  for (let v = 0; v <= axisMax + 1e-9; v += step) ticks.push({ v, u: v / axisMax, text: String(+v.toFixed(2)) });
  // Bars stagger across a fixed span, so a long reel doesn't run into the timeline beat.
  const each = Math.min(0.12, 0.84 / Math.max(1, n - 1));
  const rows = reel.scenes.map((sc, i) => ({
    i,
    num: String(i + 1).padStart(2, '0'),
    title: titles[i],
    dur: sc.duration,
    y: BARS.top + pitch * (i + 0.5),
    delay: i * each,
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
  const endW = measure(endLabel, F.label);
  const gStep = niceStep(reel.duration, 5);
  const gTicks = [];
  for (let v = 0; v < reel.duration - 1e-6; v += gStep) {
    const x = GANTT.x0 + v * gk;
    const text = String(+v.toFixed(2));
    // Drop a tick label that would crowd the end-of-reel label.
    const fits = x + measure(text, F.label) / 2 < GANTT.x1 - endW - 24;
    gTicks.push({ v, u: v / reel.duration, x, text: fits ? text : '' });
  }

  // Legend, set right to left from the margin: swatch, gap, text.
  const swatch = Math.round(labelCap) - 1;
  const legend = [
    { text: 'THIS SCENE', color: SUN },
    { text: 'TRANSITION', color: MINT },
  ];
  let lx = GANTT.x1;
  for (let i = legend.length - 1; i >= 0; i--) {
    const it = legend[i];
    it.x = lx - measure(it.text, F.label);
    it.sx = it.x - swatch - 10;
    lx = it.sx - 32;
  }
  // The playhead's readout stays between the module label and the legend.
  const tw = reel.duration.toFixed(1).length;
  const fw = group(reel.frames).length;
  const flagW = measure(flagText(reel.duration, reel.frames, tw, fw), F.flag);
  const flagMin = GANTT.x0 + measure('REEL TIMELINE', F.label) + 32 + flagW / 2;
  const flagMax = Math.max(flagMin, legend[0].sx - 32 - flagW / 2);

  return {
    labelCap,
    hero,
    heroBase,
    caption,
    stats,
    bars: { rows, tx, ax, k, ticks, titleFont, titleCap: (labelCap * titleSize) / 16 },
    gantt: { gk, clips, overlaps, ticks: gTicks, endLabel, legend, swatch, tw, fw, flagMin, flagMax },
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
  hline(ctx, HERO.x0, HERO.x1, HERO.rule, eseg(t, -0.1, 0.9, ARRIVE), eseg(t, out, out + 0.45, DRAW), RULE);
  const e = envelope(t, 0.12, out);
  label(ctx, 'TOTAL FRAMES', HERO.x0 + e.dx, HERO.rule + HEAD + e.dy, { alpha: 0.72 * e.a });

  // The odometer counts up: the columns spin up together, the low-order
  // ones whirring through an extra turn, and land left to right, each
  // settling into its detent.
  const x = HERO.x0 - fig.ink;
  drawFigure(ctx, s, fig, x, L.heroBase, BONE, (cell) => ({
    tRise: T.rise + cell.col * 0.06,
    tIn: T.roll + cell.col * 0.02,
    tLand: T.roll + 1.05 + cell.col * 0.18,
    tOut: outAt(x + cell.cx, L.heroBase) - 0.06,
    turns: fig.turns[cell.col],
  }));

  // Caption rises out of a slot under the figure, and is the first to leave.
  const C = L.caption;
  const k = eseg(t, T.caption, T.caption + 0.7, 'outCubic');
  const o = eseg(t, T.exit - 0.1, T.exit + 0.25, 'inCubic');
  if (k > 0 && o < 1) {
    ctx.save();
    if (k < 1) {
      ctx.beginPath();
      ctx.rect(HERO.x0 - 8, C.top, HERO.x1 - HERO.x0 + 60, C.bottom - C.top);
      ctx.clip();
    }
    ctx.font = C.font;
    ctx.letterSpacing = '0px';
    ctx.textAlign = 'left';
    ctx.globalAlpha = 0.74 * (1 - o);
    ctx.fillStyle = BONE;
    ctx.fillText(CAPTION, HERO.x0 + o * 18, C.y + (1 - k) * C.rise);
    ctx.restore();
  }
}

function drawStats(ctx, s, L) {
  const t = s.t;
  const out = outAt(HERO.x0, HERO.statsRule);
  hline(ctx, HERO.x0, HERO.x1, HERO.statsRule, eseg(t, 0.12, 1.12, ARRIVE), eseg(t, out, out + 0.45, DRAW), RULE);
  const cellW = (HERO.x1 - HERO.x0) / L.stats.length;
  L.stats.forEach((st, j) => {
    const x = HERO.x0 + j * cellW;
    const t0 = T.stats + j * 0.14;
    const o = outAt(x, HERO.statsRule);
    // Labels arrive with the rule; the figures rise under them later.
    const e = envelope(t, 0.3 + j * 0.07, o);
    label(ctx, st.name, x + e.dx, HERO.statsRule + HEAD + e.dy, { alpha: 0.72 * e.a });
    drawFigure(ctx, s, st.fig, x - st.fig.ink, HERO.statsBase, BONE, (cell) => ({
      tRise: t0 - 0.45 + cell.col * 0.05,
      tIn: t0 + cell.col * 0.06,
      tLand: t0 + 0.8 + cell.col * 0.12,
      tOut: o + cell.col * 0.04,
    }));
  });
}

function drawBars(ctx, s, L) {
  const t = s.t;
  const me = s.index;
  const B = L.bars;
  const out = outAt(BARS.x0, BARS.rule);
  hline(ctx, BARS.x0, BARS.x1, BARS.rule, eseg(t, -0.05, 0.95, ARRIVE), eseg(t, out, out + 0.45, DRAW), RULE);
  const e = envelope(t, 0.17, out);
  label(ctx, 'SCENE DURATION', BARS.x0 + e.dx, BARS.rule + HEAD + e.dy, { alpha: 0.72 * e.a });
  const e2 = envelope(t, 0.22, outAt(BARS.x1, BARS.rule));
  label(ctx, 'SECONDS', BARS.x1 + e2.dx, BARS.rule + HEAD + e2.dy, { alpha: 0.5 * e2.a, align: 'right' });

  // Gridlines grow down from the top, left to right across the axis; the
  // zero line is the axis itself.
  for (const tk of B.ticks) {
    const gx = B.ax + tk.v * B.k;
    const d = eseg(t, 0.55 + tk.u * 0.48, 1.35 + tk.u * 0.48, DRAW);
    const o = outAt(gx, BARS.top);
    const fade = 1 - eseg(t, o, o + 0.35, 'inCubic');
    if (d > 0 && fade > 0) {
      ctx.globalAlpha = fade;
      ctx.fillStyle = tk.v === 0 ? RULE : GRID;
      const w = tk.v === 0 ? 1.5 : 1;
      ctx.fillRect(gx - w / 2, BARS.top - 8, w, (BARS.bottom - BARS.top + 16) * d);
    }
    const te = envelope(t, 1.0 + tk.u * 0.4, o);
    label(ctx, tk.text, gx + te.dx, BARS.bottom + 33 + te.dy, { align: 'center', alpha: 0.6 * te.a });
  }

  for (const r of B.rows) {
    const mine = r.i === me;
    const t0 = T.bars + r.delay;
    const g = eseg(t, t0, t0 + 1.0, GROW);
    const o = outAt(B.ax, r.y);
    const gone = eseg(t, o, o + 0.4, 'inCubic');
    const h = recap(t, r.i, me);
    const e = envelope(t, t0 - 0.22, o);
    const ty = r.y + B.titleCap / 2 + e.dy * 0.6;
    label(ctx, r.num, BARS.x0 + e.dx, ty, { f: B.titleFont, color: mine ? SUN : BONE, alpha: (mine ? 1 : 0.5 + 0.3 * h) * e.a });
    label(ctx, r.title, B.tx + e.dx, ty, { f: B.titleFont, alpha: (mine ? 1 : 0.66 + 0.34 * h) * e.a });

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
    label(ctx, (r.dur * g).toFixed(1), x1 + 14 + gone * 18, r.y + L.labelCap / 2, {
      color: mine ? SUN : BONE,
      alpha: (mine ? 1 : 0.66 + 0.34 * h) * va,
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
  hline(ctx, GANTT.x0, GANTT.x1, GANTT.rule, eseg(t, 0.2, 1.2, ARRIVE), eseg(t, out, out + 0.5, DRAW), RULE);
  const e = envelope(t, 0.4, out);
  label(ctx, 'REEL TIMELINE', GANTT.x0 + e.dx, GANTT.rule + HEAD + e.dy, { alpha: 0.72 * e.a });

  // Time axis: about five labelled ticks on a round step, and the reel's end
  // called out.
  const axOut = outAt(GANTT.x0, GANTT.axis);
  const axGone = eseg(t, axOut, axOut + 0.5, DRAW);
  hline(ctx, GANTT.x0, GANTT.x1, GANTT.axis, eseg(t, 0.45, 1.55, DRAW), axGone, RULE, 1);
  const axEnd = lerp(GANTT.x0, GANTT.x1, axGone); // left end of the retracting axis
  for (const tk of G.ticks) {
    // Ticks grow down from the axis and leave with it as it retracts past them.
    const d = eseg(t, 0.9 + tk.u * 0.5, 1.3 + tk.u * 0.5, 'outCubic') * clamp01((tk.x - axEnd + 12) / 12);
    const o = outAt(tk.x, GANTT.axis);
    if (d > 0) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = RULE;
      ctx.fillRect(tk.x - 0.5, GANTT.axis, 1, 9 * d);
    }
    if (tk.text) {
      const te = envelope(t, 1.05 + tk.u * 0.5, o);
      label(ctx, tk.text, tk.x + te.dx, GANTT.axis + 30 + te.dy, { align: tk.v === 0 ? 'left' : 'center', alpha: 0.6 * te.a });
    }
  }
  const ee = envelope(t, 1.5, outAt(GANTT.x1, GANTT.axis));
  label(ctx, G.endLabel, GANTT.x1 + ee.dx, GANTT.axis + 30 + ee.dy, { align: 'right', alpha: 0.8 * ee.a });

  for (const it of G.legend) {
    const le = envelope(t, T.gantt + 0.3, outAt(it.sx, GANTT.rule));
    if (le.a <= 0) continue;
    ctx.globalAlpha = le.a;
    ctx.fillStyle = it.color;
    ctx.fillRect(it.sx + le.dx, GANTT.rule + HEAD - (L.labelCap + G.swatch) / 2 + le.dy, G.swatch, G.swatch);
    label(ctx, it.text, it.x + le.dx, GANTT.rule + HEAD + le.dy, { alpha: 0.72 * le.a });
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
    const la = clamp01((xb - lx - 24) / 24) * clamp01(1 - gone * 2.5);
    label(ctx, cl.num, Math.max(lx, x0 + 8), y + (GANTT.laneH + L.labelCap) / 2, { color: mine ? NAVY : BONE, alpha: 0.9 * la, track: 1 });
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

  // Playhead at the true global time, with a live readout of that time and
  // the frame number.
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
    const fx = clamp(px, G.flagMin, G.flagMax);
    label(ctx, flagText(now, s.frame, G.tw, G.fw), fx, GANTT.rule + HEAD + drop, { f: F.flag, color: SIGNAL, align: 'center', alpha: pa });
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
  uses: [], // setup reads only the reel timeline, never the title or seed
  setup({ reel }) {
    return buildLayout(reel);
  },
  render(ctx, s) {
    drawGround(ctx, s);
    // Content trails the push a little and settles after it lands, lower rows
    // later: overlapping action between the transition and the layout.
    ROWS.forEach((row, i) => {
      ctx.save();
      ctx.translate(0, (30 + 15 * i) * (1 - eseg(s.t, 0, 1.2 + 0.1 * i, SETTLE_IN)));
      for (const draw of row) draw(ctx, s, s.state);
      ctx.restore();
    });
  },
});

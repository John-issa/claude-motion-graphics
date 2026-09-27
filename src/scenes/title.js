// TITLE: the opening card. A broadcast slate frames the shot, a hairline draws
// out from the centre and becomes a mask edge, and the title rises through it
// glyph by glyph on closed-form springs, each glyph's variable weight going
// from light to black as it lands. A signal-red block then slides in behind
// the word and takes over the frame, ready for the next scene's iris.
//
// Beats: 0.12 rule draws out · 0.55 glyphs rise · 2.0 red block · 2.3 subtitle
// types on · 2.45 grid · 2.55 weight wave · 3.6 push-in · 4.34 subtitle out ·
// 4.62 glyphs fall · 4.84 red floods the frame · 5.2 next scene's iris opens.

import {
  defineScene,
  palette,
  font,
  layoutGlyphs,
  fitSize,
  balanceLines,
  makeCanvas,
  spring,
  seg,
  eseg,
  kf,
  ease,
  lerp,
  clamp01,
  rgba,
  hash,
} from '../engine/index.js';

const { ink: INK, bone: BONE, signal: SIGNAL } = palette;
const W = 1920;
const H = 1080;

// Rule under the last title line. The outro ends on a point at (960, AXIS_Y),
// so the loop back into this scene reads as a match cut.
const AXIS_Y = 600;

const SUBTITLE = 'motion graphics, rendered live in your browser';

const LIGHT = 250;
const BLACK = 900;

// Closed-form springs, sampled directly at any t (no integration state).
const RISE = spring({ stiffness: 190, damping: 17 }); // ~8 % overshoot, settles in 0.75 s
const TILT = spring({ stiffness: 120, damping: 11 }); // looser, so rotation lags position

const DROP = 0.38; // seconds each glyph takes to fall out

/**
 * Set the title lines at one size: each line sits on its own rule, stacked
 * upward from the axis, centred on its ink. Returns the rows and the red
 * block's horizontal extent (never narrower than the subtitle).
 */
function setLines(c, lines, size, subW) {
  // Slots come from the black weight: every glyph lands there, so a slot never
  // moves while its glyph's weight animates (lighter glyphs centre in it).
  const F = font(size, 'display', BLACK);
  c.font = F;
  const capH = c.measureText('H').actualBoundingBoxAscent;
  const gap = Math.max(20, Math.round(size * (lines.length > 1 ? 0.16 : 0.12)));
  const rows = [];
  let rule = AXIS_Y;
  for (let li = lines.length - 1; li >= 0; li--) {
    const text = lines[li];
    c.font = F;
    const m = c.measureText(text);
    const base = rule - Math.max(gap, m.actualBoundingBoxDescent + size * 0.05);
    const x = W / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const lay = layoutGlyphs(c, text, F);
    const inkL = x - m.actualBoundingBoxLeft;
    const inkR = x + m.actualBoundingBoxRight;
    // Far enough below the rule to start (and end) fully hidden, tilt included.
    const hide = rule - base + capH + size * 0.14;
    rows[li] = { text, base, rule, x, inkL, inkR, hide, lay, glyphs: [] };
    rule = base - capH - gap;
  }
  const padX = Math.round(size * 0.18);
  let x0 = Math.min(...rows.map((r) => r.inkL)) - padX;
  let x1 = Math.max(...rows.map((r) => r.inkR)) + padX;
  if (x1 - x0 < subW) {
    const mid = (x0 + x1) / 2;
    x0 = mid - subW / 2;
    x1 = mid + subW / 2;
  }
  return { F, rows, x0, x1, y0: rows[0].base - capH - gap };
}

/** Time-independent layout for one title string, built once in setup(). */
function buildLayout(rawTitle, fps) {
  const c = makeCanvas(8, 8).getContext('2d');
  const title = String(rawTitle || 'MOTION').toUpperCase().trim().slice(0, 24) || 'MOTION';
  const lines = balanceLines(title, 2);
  const subFont = font(22, 'mono', 400);
  c.font = subFont;
  const subW = c.measureText(SUBTITLE).width;

  // Fit the word to ~77 % of the frame, then shrink until the red block (and
  // the subtitle aligned to its edge) fits title-safe width and stays clear of
  // the top row of the grid.
  let size = 300;
  for (const ln of lines) size = Math.min(size, fitSize(c, ln, 1480, { weight: BLACK, maxSize: 300 }));
  let set = setLines(c, lines, size, subW);
  for (let pass = 0; pass < 3; pass++) {
    const k = Math.min(1536 / (set.x1 - set.x0), (AXIS_Y - 250) / (AXIS_Y - set.y0));
    if (k >= 0.999) break;
    size *= k;
    set = setLines(c, lines, size, subW);
  }
  const { F, rows, x0, x1, y0 } = set;
  const block = { x0, x1, y0, y1: AXIS_Y };

  // Glyphs: slot centre from the kerned layout, plus per-glyph timing.
  const all = [];
  for (const row of rows) {
    const n = row.lay.glyphs.length;
    for (const g of row.lay.glyphs) {
      if (g.ch === ' ') continue;
      const adv = layoutGlyphs(c, g.ch, F).width;
      const glyph = { ch: g.ch, cx: row.x + g.x + adv / 2, slot: g.i - (n - 1) / 2 };
      row.glyphs.push(glyph);
      all.push(glyph);
    }
  }
  const n = all.length;
  const each = Math.min(0.045, 0.62 / Math.max(1, n - 1));
  const drop = Math.min(0.03, 0.3 / Math.max(1, n - 1));
  all.forEach((g, k) => {
    g.t0 = 0.55 + k * each; // rise
    g.tw = 2.55 + ((g.cx - x0) / (x1 - x0)) * 0.6; // weight wave, swept left to right
    g.t1 = 4.62 + k * drop; // fall
    g.tilt = ((4 + 3 * hash(k, 17)) * Math.PI) / 180;
  });

  // Slate labels, set like the reel's chapter slug (fps is the reel's, i.e. the
  // s.fps every render receives; the timecode is formatted live per frame).
  const slateFont = font(18, 'mono', 500);
  const tcTemplate = layoutGlyphs(c, '00:00:00:00', slateFont, 2);
  const labels = [
    { text: 'CLAUDE MOTION REEL', x: 96, y: 86, align: 'left', at: 0.2 },
    { text: 'N°01', x: 1824, y: 86, align: 'right', at: 0.3 },
    { live: true, x: 96, y: 994, align: 'left', at: 0.26 },
    { text: `1920 × 1080 · ${fps} FPS`, x: 1824, y: 994, align: 'right', at: 0.34 },
  ].map((l) => ({ ...l, lay: l.live ? tcTemplate : layoutGlyphs(c, l.text, slateFont, 2) }));

  const crosses = [];
  [216, 864].forEach((y, r) =>
    [192, 576, 960, 1344, 1728].forEach((x, i) => {
      crosses.push({ x, y, at: 2.45 + Math.abs(i - 2) * 0.07 + r * 0.05 });
    }),
  );

  return {
    size,
    rows,
    block,
    widest: Math.max(...rows.map((r) => r.lay.glyphs.length)),
    cx: W / 2,
    cy: (block.y0 + AXIS_Y + 54) / 2,
    sub: { font: subFont, x: x0, y: AXIS_Y + 54, cell: subW / SUBTITLE.length },
    slate: { font: slateFont, labels },
    crosses,
  };
}

/** SMPTE timecode HH:MM:SS:FF from the reel's frame counter. */
function timecode(frame, fps) {
  const f = Math.max(0, Math.round(frame));
  const r = Math.round(fps);
  const secs = Math.floor(f / r);
  const two = (v) => String(v).padStart(2, '0');
  return `${two(Math.floor(secs / 3600))}:${two(Math.floor(secs / 60) % 60)}:${two(secs % 60)}:${two(f % r)}`;
}

/** Smooth cos² bump centred on `at`, `width` seconds wide. */
function bump(t, at, width) {
  const x = (t - at) / width;
  return Math.abs(x) >= 0.5 ? 0 : Math.cos(Math.PI * x) ** 2;
}

/** Push-in of the lockup: an eased move, then a slow drift that runs out the scene. */
const push = (t) => 1 + 0.06 * eseg(t, 3.6, 4.8, 'inOutSine') + 0.03 * ease.inQuad(seg(t, 4.4, 6));

/** Extra tracking per glyph slot as the push-in opens the word up. */
const spread = (t, L) => L.size * 0.03 * eseg(t, 3.6, 4.8, 'inOutSine');

/** The red block in screen space (null before it arrives). */
function redRect(L, t) {
  const wipe = ease.outExpo(seg(t, 2.0, 2.65));
  if (wipe <= 0) return null;
  const b = L.block;
  const grow = 18 * eseg(t, 3.6, 4.8, 'inOutSine') + (spread(t, L) * (L.widest - 1)) / 2;
  let x0 = b.x0 - grow;
  let x1 = lerp(b.x0, b.x1 + grow, wipe);
  let y0 = b.y0 - grow;
  let y1 = b.y1;
  const k = push(t);
  x0 = L.cx + (x0 - L.cx) * k;
  x1 = L.cx + (x1 - L.cx) * k;
  y0 = L.cy + (y0 - L.cy) * k;
  y1 = L.cy + (y1 - L.cy) * k;
  // Takeover: a short inhale (negative progress shrinks the block), then the
  // block floods the frame.
  const q = kf(t, [[4.66, 0], [4.84, -0.04, 'outSine'], [5.26, 1, 'inOutQuart']]);
  if (q !== 0) {
    x0 = lerp(x0, -4, q);
    y0 = lerp(y0, -4, q);
    x1 = lerp(x1, W + 4, q);
    y1 = lerp(y1, H + 4, Math.max(0, q)); // the block keeps sitting on its rule
  }
  return { x0, y0, x1, y1 };
}

/**
 * Registration crosses. Drawn as filled rects, not strokes: on GPU canvases a
 * stroked path can force a stencil pass that makes the grain's overlay blend
 * several times slower for the whole frame.
 */
function drawCrosses(ctx, L, t, color, alpha) {
  const k = 1 + 0.06 * ease.inSine(seg(t, 3.6, 6));
  ctx.fillStyle = rgba(color, alpha);
  for (const c of L.crosses) {
    const a = ease.outBack(seg(t, c.at, c.at + 0.5));
    if (a <= 0) continue;
    // Scale up from nothing while turning from × to +.
    const r = 11 * a;
    ctx.save();
    ctx.translate(W / 2 + (c.x - W / 2) * k, H / 2 + (c.y - H / 2) * k);
    ctx.rotate((1 - a) * (Math.PI / 4));
    ctx.fillRect(-r, -0.75, r * 2, 1.5);
    ctx.fillRect(-0.75, -r, 1.5, r * 2);
    ctx.restore();
  }
}

/** Corner labels typed on at a steady rate, with a block cursor at the head. */
function drawSlate(ctx, L, s, color, alpha) {
  const { font: F, labels } = L.slate;
  ctx.font = F;
  ctx.fillStyle = rgba(color, alpha);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const tc = timecode(s.frame, s.fps);
  for (const lab of labels) {
    const { glyphs, width } = lab.lay;
    const n = Math.min(glyphs.length, Math.floor(Math.max(0, s.t - lab.at) * 64));
    if (n <= 0) continue;
    const x = lab.align === 'right' ? lab.x - width : lab.x;
    for (let i = 0; i < n; i++) ctx.fillText(lab.live ? tc[i] : glyphs[i].ch, x + glyphs[i].x, lab.y);
    if (n < glyphs.length) ctx.fillRect(x + glyphs[n].x, lab.y - 8, 11, 16);
  }
}

/** Baseline rules: draw out from the centre, retract to it on the way out. */
function drawRules(ctx, L, t) {
  const half = (L.block.x1 - L.block.x0) / 2;
  const out = ease.inExpo(seg(t, 4.98, 5.36));
  ctx.fillStyle = BONE;
  L.rows.forEach((row, i) => {
    const late = (L.rows.length - 1 - i) * 0.08; // upper rules follow the axis rule
    const k = ease.outExpo(seg(t, 0.12 + late, 0.85 + late)) * (1 - out);
    if (k <= 0) return;
    ctx.fillRect(L.cx - half * k, row.rule - 1, half * k * 2, 2);
  });
}

/** Where one glyph is at time t: rise on a spring, weight wave, inBack fall. */
function pose(g, t, hide) {
  const dt = t - g.t0;
  const out = seg(t, g.t1, g.t1 + DROP);
  if (dt <= 0 || out >= 1) return null;
  const y = (1 - RISE(dt) + ease.inBack(out)) * hide;
  const rot = (1 - TILT(dt)) * -g.tilt + ease.inQuad(out) * g.tilt * 1.5;
  const land = ease.inOutCubic(seg(dt, 0.04, 0.34));
  const weight = LIGHT + (BLACK - LIGHT) * land - 330 * bump(t, g.tw, 0.6);
  return { y, rot, weight: Math.round(weight / 10) * 10 };
}

function drawGlyphs(ctx, L, t) {
  const sp = spread(t, L);
  ctx.fillStyle = BONE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const row of L.rows) {
    // The row's rule is the mask edge: glyphs only exist above it.
    ctx.save();
    ctx.beginPath();
    ctx.rect(-W, -H, W * 3, row.rule + H);
    ctx.clip();
    for (const g of row.glyphs) {
      const p = pose(g, t, row.hide);
      if (!p) continue;
      ctx.save();
      ctx.translate(g.cx + sp * g.slot, row.base + p.y);
      ctx.rotate(p.rot);
      ctx.font = font(L.size, 'display', p.weight);
      ctx.fillText(g.ch, 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}

/** Mono subtitle typed on under the rule, then backspaced away. */
function drawSubtitle(ctx, L, t) {
  const n = SUBTITLE.length;
  const typed = Math.floor(clamp01((t - 2.3) / 0.95) * n);
  const erased = Math.floor(clamp01((t - 4.34) / 0.34) * n);
  const vis = typed - erased;
  const { font: F, x, y, cell } = L.sub;
  if (vis > 0) {
    ctx.font = F;
    ctx.fillStyle = rgba(BONE, 0.72);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(SUBTITLE.slice(0, vis), x, y);
  }
  // Signal cursor: solid while typing, blinking at rest, gone with the text.
  const busy = (typed > 0 && typed < n) || (erased > 0 && erased < n);
  const resting = typed === n && erased === 0 && (t - 3.25) % 0.5 < 0.28;
  if (t > 2.24 && t < 4.68 && (busy || resting || typed === 0)) {
    ctx.fillStyle = SIGNAL;
    ctx.fillRect(x + vis * cell + 2, y - 17, cell - 3, 21);
  }
}

export default defineScene({
  id: 'title',
  title: 'Title Sequence',
  duration: 6.0,
  color: '#FF3B1F',
  slug: false,
  notes: [
    'Per-glyph layout that keeps kerning',
    'Closed-form spring physics',
    'Variable font weight animation',
    'Mask reveals',
    'SMPTE timecode from the frame counter',
  ],
  setup({ params, reel }) {
    return buildLayout(params.title, reel.fps);
  },
  render(ctx, s) {
    const L = s.state;
    const t = s.t;
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);

    // Grid and slate frame the shot; where the red field covers them they
    // knock out to ink. The red is opaque, so the bone pass can sit under it
    // and only the ink pass needs a (rectangular, cheap) clip.
    const red = redRect(L, t);
    drawCrosses(ctx, L, t, BONE, 0.3);
    drawSlate(ctx, L, s, BONE, 0.5);
    if (red) {
      ctx.fillStyle = SIGNAL;
      ctx.fillRect(red.x0, red.y0, red.x1 - red.x0, red.y1 - red.y0);
      ctx.save();
      ctx.beginPath();
      ctx.rect(red.x0, red.y0, red.x1 - red.x0, red.y1 - red.y0);
      ctx.clip();
      drawCrosses(ctx, L, t, INK, 0.4);
      drawSlate(ctx, L, s, INK, 0.72);
      ctx.restore();
    }

    // The lockup, pushed in about its own centre.
    const k = push(t);
    ctx.save();
    ctx.translate(L.cx, L.cy);
    ctx.scale(k, k);
    ctx.translate(-L.cx, -L.cy);
    drawRules(ctx, L, t);
    drawGlyphs(ctx, L, t);
    drawSubtitle(ctx, L, t);
    ctx.restore();
  },
});

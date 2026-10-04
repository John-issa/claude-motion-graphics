// TITLE: the opening card. A broadcast slate frames the shot, a hairline draws
// out from the centre and becomes a mask edge, and the title rises through it
// glyph by glyph on closed-form springs, each glyph's variable weight going
// from light to black as it lands. A signal-red block then slides in behind
// the word and takes over the frame, and the rules collapse into the point
// where the next scene's iris opens.
//
// Beats: 0.03 rule draws out · 0.55 glyphs rise · the red block follows the
// last landing (by 2.0 at the latest), then subtitle, grid and weight wave ·
// push-in as the wave ends (by 3.4) · 4.34 subtitle out · 4.62 glyphs fall ·
// 4.84 red floods the frame · 5.24 rules gone into the frame centre as the
// next scene irises open.

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
  DEFAULT_PARAMS,
} from '../engine/index.js';

const { ink: INK, bone: BONE, signal: SIGNAL } = palette;
const W = 1920;
const H = 1080;

// Rule under the last title line. The outro ends on a point at (960, AXIS_Y),
// so the loop back into this scene reads as a match cut.
const AXIS_Y = 600;

// The next scene irises open from the frame centre: the rules collapse into it.
const IRIS_Y = H / 2;

const SUBTITLE = 'motion graphics, rendered live in your browser';

const LIGHT = 250;
const BLACK = 900;

// Closed-form springs, sampled directly at any t (no integration state).
const RISE = spring({ stiffness: 190, damping: 17 }); // ~8 % overshoot, settles in 0.75 s
const TILT = spring({ stiffness: 120, damping: 11 }); // looser, so rotation lags position

const DROP = 0.36; // seconds each glyph takes to fall out

// Push-in: the lockup scales up by PUSH while the tracking opens by SPREAD
// (a fraction of the font size per glyph slot). HEADROOM is the most the hero
// ink grows on screen while it is visible (push, drift and the fall's tilt),
// reserved at layout time so the pushed word stays inside title-safe.
const PUSH = 0.06;
const SPREAD = 0.03;
const HEADROOM = 1.08;
const SAFE_W = 1536; // title-safe width (x 192-1728)

/**
 * Set the title lines at one size: each line sits on its own rule, stacked
 * upward from the axis, centred on its ink. Returns the rows and the red
 * block's extent (never narrower than the subtitle).
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
    // Stack by real ink, so accented capitals (É, Å) stay inside the block.
    const asc = Math.max(capH, m.actualBoundingBoxAscent);
    const base = rule - Math.max(gap, m.actualBoundingBoxDescent + size * 0.05);
    const x = W / 2 - (m.actualBoundingBoxRight - m.actualBoundingBoxLeft) / 2;
    const lay = layoutGlyphs(c, text, F);
    const inkL = x - m.actualBoundingBoxLeft;
    const inkR = x + m.actualBoundingBoxRight;
    // Far enough below the rule to start (and end) fully hidden, tilt included.
    const hide = rule - base + asc + size * 0.14;
    rows[li] = { text, base, rule, x, inkL, inkR, hide, lay, glyphs: [] };
    rule = base - asc - gap;
  }
  const padX = Math.round(size * 0.18);
  let x0 = Math.min(...rows.map((r) => r.inkL)) - padX;
  let x1 = Math.max(...rows.map((r) => r.inkR)) + padX;
  if (x1 - x0 < subW) {
    const mid = (x0 + x1) / 2;
    x0 = mid - subW / 2;
    x1 = mid + subW / 2;
  }
  // The block's top sits one gap above the top line's ink.
  return { F, rows, x0, x1, y0: rule };
}

/** Time-independent layout for one title string, built once in setup(). */
function buildLayout(rawTitle, fps) {
  const c = makeCanvas(8, 8).getContext('2d');
  const title = String(rawTitle || DEFAULT_PARAMS.title).toUpperCase().trim().slice(0, 24) || DEFAULT_PARAMS.title;
  const lines = balanceLines(title, 2);
  const subFont = font(22, 'mono', 400);
  c.font = subFont;
  const subW = c.measureText(SUBTITLE).width;

  // Fit the word to ~77 % of the frame, then shrink until the red block (and
  // the subtitle aligned to its edge) fits title-safe width, the block's top
  // stays below y 250, and the word still fits title-safe at the height of the
  // push-in, opened tracking included.
  const widest = Math.max(...lines.map((ln) => Array.from(ln).length));
  let size = 300;
  for (const ln of lines) size = Math.min(size, fitSize(c, ln, 1480, { weight: BLACK, maxSize: 300 }));
  let set = setLines(c, lines, size, subW);
  for (let pass = 0; pass < 3; pass++) {
    const inkW = Math.max(...set.rows.map((r) => r.inkR - r.inkL));
    const pushed = (inkW + SPREAD * size * (widest - 1)) * HEADROOM;
    const k = Math.min(SAFE_W / (set.x1 - set.x0), (AXIS_Y - 250) / (AXIS_Y - set.y0), SAFE_W / pushed);
    if (k >= 0.999) break;
    size *= k;
    set = setLines(c, lines, size, subW);
  }
  const { F, rows, x0, x1, y0 } = set;
  const block = { x0, x1, y0, y1: AXIS_Y };
  const subY = AXIS_Y + 54; // subtitle baseline
  const cy = (y0 + subY) / 2; // centre of the lockup: block, rule and subtitle

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
  const drop = Math.min(0.03, 0.2 / Math.max(1, n - 1));
  // The secondary beat follows the last landing, and the push-in starts as the
  // weight wave ends, so short titles never sit idle.
  const beat = Math.min(2.0, 0.55 + (n - 1) * each + 0.85);
  const p0 = beat + 1.4;
  all.forEach((g, k) => {
    g.t0 = 0.55 + k * each; // rise
    g.tw = beat + 0.55 + ((g.cx - x0) / (x1 - x0)) * 0.6; // weight wave, swept left to right
    g.t1 = 4.62 + k * drop; // fall
    g.tilt = ((4 + 3 * hash(k, 17)) * Math.PI) / 180;
  });

  // Slate labels, set like the reel's chapter slug (fps is the reel's, i.e. the
  // s.fps every render receives; the timecode is formatted live per frame).
  const slateFont = font(18, 'mono', 500);
  const tcTemplate = layoutGlyphs(c, '00:00:00:00', slateFont, 2);
  const labels = [
    { text: 'CLAUDE MOTION REEL', x: 96, y: 86, align: 'left', at: 0.11 },
    { text: 'N°01', x: 1824, y: 86, align: 'right', at: 0.21 },
    { live: true, x: 96, y: 994, align: 'left', at: 0.17 },
    { text: `1920 × 1080 · ${fps} FPS`, x: 1824, y: 994, align: 'right', at: 0.25 },
  ].map((l) => ({ ...l, lay: l.live ? tcTemplate : layoutGlyphs(c, l.text, slateFont, 2) }));

  // Registration crosses: two sparse rows centred on the lockup rather than
  // the frame (so the block has even air above and below), kept inside
  // title-safe.
  const crosses = [];
  [cy - 300, cy + 300].forEach((y, r) =>
    [192, 576, 960, 1344, 1728].forEach((x, i) => {
      crosses.push({ x, y: Math.min(960, Math.max(120, y)), at: beat + 0.45 + Math.abs(i - 2) * 0.07 + r * 0.05 });
    }),
  );

  return {
    size,
    rows,
    block,
    beat,
    p0,
    widest,
    cx: W / 2,
    cy,
    sub: { font: subFont, x: x0, y: subY, cell: subW / SUBTITLE.length },
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

/** Progress of the push-in, which starts as the secondary beat winds down. */
const pushIn = (t, L) => eseg(t, L.p0, 4.8, 'inOutSine');

/** Push-in of the lockup: an eased move, then a slow drift that runs out the scene. */
const push = (t, L) => 1 + PUSH * pushIn(t, L) + 0.03 * ease.inQuad(seg(t, 4.4, 6));

/** Extra tracking per glyph slot as the push-in opens the word up. */
const spread = (t, L) => L.size * SPREAD * pushIn(t, L);

/**
 * How far the red block has grown past its resting edges (design px, before
 * the push): enough to keep the outer glyphs inside as the tracking opens.
 * The rules and the subtitle follow the same edge.
 */
const blockGrow = (t, L) => 18 * pushIn(t, L) + (spread(t, L) * (L.widest - 1)) / 2;

/** Takeover progress: a short inhale (negative shrinks the block), then the flood. */
const takeover = (t) => kf(t, [[4.66, 0], [4.84, -0.04, 'outSine'], [5.26, 1, 'inOutQuart']]);

/**
 * The red block in screen space at takeover progress q, ignoring the wipe.
 * The block is centred on the frame, so the push (a scale about the lockup
 * centre) keeps it centred too.
 */
function blockRect(L, t, q) {
  const k = push(t, L);
  const g = blockGrow(t, L);
  const half = ((L.block.x1 - L.block.x0) / 2 + g) * k;
  let x0 = L.cx - half;
  let x1 = L.cx + half;
  let y0 = L.cy + (L.block.y0 - g - L.cy) * k;
  let y1 = L.cy + (L.block.y1 - L.cy) * k;
  if (q !== 0) {
    x0 = lerp(x0, -4, q);
    y0 = lerp(y0, -4, q);
    x1 = lerp(x1, W + 4, q);
    y1 = lerp(y1, H + 4, Math.max(0, q)); // the block keeps sitting on its rule
  }
  return { x0, y0, x1, y1 };
}

/** The red block as drawn: wiped in from the left edge (null before it arrives). */
function redRect(L, t) {
  const wipe = ease.outExpo(seg(t, L.beat, L.beat + 0.65));
  if (wipe <= 0) return null;
  const r = blockRect(L, t, takeover(t));
  r.x1 = lerp(r.x0, r.x1, wipe);
  return r;
}

/**
 * Registration crosses: two thin filled rects each, scaling up while turning
 * from × to +, then drifting out from the lockup a little slower than the
 * push (a touch of parallax).
 */
function drawCrosses(ctx, L, t, color, alpha) {
  const k = 1 + 0.06 * ease.inSine(seg(t, L.p0, 6));
  ctx.fillStyle = rgba(color, alpha);
  for (const c of L.crosses) {
    const a = ease.outBack(seg(t, c.at, c.at + 0.5));
    if (a <= 0) continue;
    const r = 11 * a;
    ctx.save();
    ctx.translate(L.cx + (c.x - L.cx) * k, L.cy + (c.y - L.cy) * k);
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

/** Final collapse of the rules into the frame centre. */
const collapse = (t) => ease.inQuart(seg(t, 4.98, 5.24));

/** Screen y of a row's rule: on its line through the push, then gliding into the iris origin. */
const ruleY = (L, row, t) => lerp(L.cy + (row.rule - L.cy) * push(t, L), IRIS_Y, collapse(t));

/**
 * Baseline rules, in screen space: they draw out from the centre, hold the
 * red block's edges through the push and the inhale (but not the flood), and
 * finally collapse into the frame centre, where the next scene's iris opens.
 */
function drawRules(ctx, L, t) {
  const b = blockRect(L, t, Math.min(0, takeover(t)));
  const half = ((b.x1 - b.x0) / 2) * (1 - collapse(t));
  ctx.fillStyle = BONE;
  L.rows.forEach((row, i) => {
    const late = (L.rows.length - 1 - i) * 0.08; // upper rules follow the axis rule
    const w = half * ease.outExpo(seg(t, 0.03 + late, 0.76 + late));
    if (w > 0) ctx.fillRect(L.cx - w, ruleY(L, row, t) - 1, w * 2, 2);
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
  return { y, rot, weight: Math.round(weight / 10) * 10 }; // rounded so font instances get reused
}

/** The glyphs, drawn inside the push transform. */
function drawGlyphs(ctx, L, t) {
  const sp = spread(t, L);
  const k = push(t, L);
  ctx.fillStyle = BONE;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const row of L.rows) {
    // The row's rule is the mask edge: glyphs only exist above it. The edge
    // follows the rule when it lifts into the centre at the end, never down.
    const edge = Math.min(row.rule, L.cy + (ruleY(L, row, t) - L.cy) / k);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-W, -H, W * 3, edge + H);
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

/** Mono subtitle typed on under the rule, flush with the block's left edge, then backspaced away. */
function drawSubtitle(ctx, L, t) {
  const n = SUBTITLE.length;
  const at = L.beat + 0.3;
  const typed = Math.floor(clamp01((t - at) / 0.95) * n);
  const erased = Math.floor(clamp01((t - 4.34) / 0.34) * n);
  const vis = typed - erased;
  const { font: F, y, cell } = L.sub;
  const x = L.sub.x - blockGrow(t, L);
  if (vis > 0) {
    ctx.font = F;
    ctx.fillStyle = rgba(BONE, 0.72);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(SUBTITLE.slice(0, vis), x, y);
  }
  // Signal cursor: solid while typing, blinking at rest, gone with the text.
  const busy = (typed > 0 && typed < n) || (erased > 0 && erased < n);
  const resting = typed === n && erased === 0 && (t - at - 0.95) % 0.5 < 0.28;
  if (t > at - 0.06 && t < 4.68 && (busy || resting || typed === 0)) {
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
  uses: ['title'], // the layout reads the title, never the seed
  // Flat ink and signal fields with hairlines: the overlay grain moves them by
  // a level or two and would cost more than the whole scene.
  post: { grain: 0 },
  notes: [
    'Per-glyph layout that keeps kerning',
    'Closed-form spring physics',
    'Variable font weight animation',
    'Mask reveals',
    'SMPTE timecode from the frame counter',
  ],
  uses: ['title'],
  /** Sound: glyphs landing (at most eight, spread across the word), the red block, the drop. */
  cues({ state: L }) {
    if (!L) return [];
    const glyphs = L.rows.flatMap((r) => r.glyphs);
    const n = glyphs.length;
    const picks = n <= 8 ? glyphs : Array.from({ length: 8 }, (_, i) => glyphs[Math.round((i * (n - 1)) / 7)]);
    return [
      // The rise spring first reaches the baseline about 0.2 s after a glyph starts.
      ...picks.map((g, i) => ({ t: g.t0 + 0.2, kind: 'land', strength: 0.5 + 0.05 * i })),
      { t: L.beat + 0.04, kind: 'hit', strength: 0.75 }, // the red block slams in
      { t: 4.6, kind: 'whoosh', dur: 0.3, dir: 'down', strength: 0.45 }, // glyphs drop out
      { t: 4.84, kind: 'swell', dur: 0.42, strength: 0.7 }, // red floods the frame
    ];
  },
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

    drawRules(ctx, L, t);

    // The lockup, pushed in about its own centre.
    const k = push(t, L);
    ctx.save();
    ctx.translate(L.cx, L.cy);
    ctx.scale(k, k);
    ctx.translate(-L.cx, -L.cy);
    drawGlyphs(ctx, L, t);
    drawSubtitle(ctx, L, t);
    ctx.restore();
  },
});

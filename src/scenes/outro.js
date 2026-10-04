// OUTRO: the end card. Four keyframe diamonds fly in along motion paths drawn
// the way an animation tool shows them (dashed Bézier, tangent handles, a tick
// every two frames), snap onto a keyframe track with a spring settle, and the
// lockup reveals out of the track. A playhead crosses it; when it reaches the
// last keyframe the lockup folds away in order (credits and tagline, then the
// title) and the diamonds merge into one that shrinks to a point, exactly
// where the title's hairline starts when the reel loops.
//
// Beats: 0-0.68 paths draw during the fade in · 0.92 outer pair launches ·
// 1.04 inner pair · 1.66 track · 1.95 title rises · 2.2-4.4 playhead · 4.38
// credits and tagline out · 4.6 title sinks · 4.8 diamonds merge · 5.25 gone,
// solid ink to the end.
//
// Everything is drawn with fills: dashes, handles and outlines are thin
// rotated rects, and dots are arcs batched into a single fill.

import {
  defineScene,
  palette,
  font,
  fitSize,
  balanceLines,
  layoutGlyphs,
  makeCanvas,
  spring,
  seg,
  eseg,
  kf,
  ease,
  lerp,
  clamp01,
  rgba,
  pulse,
  pointAt,
  TAU,
  DEFAULT_PARAMS,
} from '../engine/index.js';

const { ink: INK, bone: BONE } = palette;
const W = 1920;
const H = 1080;

// The keyframe track sits on the same axis as the title's hairline, and the
// final point lands at (960, AXIS_Y): the loop is a match cut.
const AXIS_Y = 600;

const COLORS = [palette.signal, palette.sun, palette.cobalt, palette.bone];
const TAGLINE = 'a motion reel, drawn live';

// Flight along the path, and the quarter turn that settles with it.
const FLY = spring({ stiffness: 130, damping: 18 }); // ~1.8 % overshoot, within 1 px by 0.7 s
const SPIN = spring({ stiffness: 45, damping: 7.5 });
const WINDUP = 0.18; // seconds a diamond backs up before it launches
const DRAW = 0.6; // seconds a motion path takes to draw on
const HEAD = [2.2, 4.4]; // the playhead crosses from the first keyframe to the last

const R = 17; // diamond half-diagonal
const DASH = 10;
const GAP = 8;
const SQRT2 = Math.SQRT2;

/** Sample a cubic Bézier into a dense polyline (flat array). */
function bezier(p0, p1, p2, p3, n = 160) {
  const out = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const v = 1 - u;
    const a = v * v * v;
    const b = 3 * v * v * u;
    const c = 3 * v * u * u;
    const d = u * u * u;
    out[i * 2] = a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0];
    out[i * 2 + 1] = a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1];
  }
  return out;
}

const unit = (from, to) => {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
};

/** Progress along a path at time t: wind-up, then the spring flight. */
function progress(P, t) {
  if (t < P.launch) return -P.back * ease.inOutSine(seg(t, P.launch - WINDUP, P.launch));
  return lerp(-P.back, 1, FLY(t - P.launch));
}

/** One motion path: geometry, dashes and frame ticks, all time-independent. */
function buildPath(i, S, P1, P2, T, launch, drawAt) {
  const pts = bezier(S, P1, P2, T);
  let len = 0;
  for (let k = 1; k < pts.length / 2; k++) {
    len += Math.hypot(pts[k * 2] - pts[k * 2 - 2], pts[k * 2 + 1] - pts[k * 2 - 1]);
  }

  // Dashes anchored to arc length, so erasing the path never makes them crawl.
  const dashes = [];
  const a = [0, 0];
  const b = [0, 0];
  for (let s = 0; s < len; s += DASH + GAP) {
    const e = Math.min(len, s + DASH);
    pointAt(pts, s / len, false, a);
    pointAt(pts, e / len, false, b);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    dashes.push({ s: s / len, e: e / len, x: a[0], y: a[1], ang, len: e - s });
  }

  // First arrival, and one tick every two frames up to it: tick spacing shows
  // the speed, exactly like a motion-path view.
  const back = 14 / len;
  let arrive = 0;
  while (arrive < 3 && FLY(arrive) < 1) arrive += 1 / 240;
  const ticks = [];
  for (let k = 1; k / 30 < arrive; k++) {
    const u = lerp(-back, 1, FLY(k / 30));
    if (u > 0.01 && u < 0.985) ticks.push({ u, p: pointAt(pts, u, false, [0, 0]) });
  }

  return {
    i,
    color: COLORS[i],
    S,
    T,
    pts,
    len,
    dashes,
    ticks,
    back,
    launch,
    arrive: launch + arrive,
    drawAt,
    outDir: unit(S, P1),
    inDir: unit(P2, T),
    hOut: [S[0] + (P1[0] - S[0]) * 0.5, S[1] + (P1[1] - S[1]) * 0.5],
    hIn: [T[0] + (P2[0] - T[0]) * 0.5, T[1] + (P2[1] - T[1]) * 0.5],
    hOutLen: Math.hypot(P1[0] - S[0], P1[1] - S[1]) * 0.5,
  };
}

function buildLayout(params, reel) {
  const c = makeCanvas(8, 8).getContext('2d');
  const title = String(params.title || DEFAULT_PARAMS.title).toUpperCase().trim().slice(0, 24) || DEFAULT_PARAMS.title;
  const lines = balanceLines(title, 2);

  // Title: fitted and balanced like the opening card, calmer and smaller.
  const WEIGHT = 700;
  let size = lines.length > 1 ? 136 : 176;
  for (const ln of lines) size = Math.min(size, fitSize(c, ln, 940, { weight: WEIGHT, maxSize: size, tracking: 0.02 }));
  const F = font(size, 'display', WEIGHT);
  const track = size * 0.02;
  c.font = F;
  // Real ink extents, so accented capitals (É, Å) start hidden below the track
  // and never meet the descenders of the line above.
  const capH = c.measureText('H').actualBoundingBoxAscent;
  const ink = lines.map((ln) => c.measureText(ln));
  const asc = ink.map((m) => Math.max(capH, m.actualBoundingBoxAscent));
  const lead = lines.length > 1 ? Math.max(size * 1.02, ink[0].actualBoundingBoxDescent + asc[1] + size * 0.12) : 0;
  const rows = lines.map((text, k) => {
    const lay = layoutGlyphs(c, text, F, track);
    return { lay, x: W / 2 - lay.width / 2, base: AXIS_Y - 58 - (lines.length - 1 - k) * lead };
  });
  const left = Math.min(...rows.map((r) => r.x));
  const right = Math.max(...rows.map((r) => r.x + r.lay.width));
  const titleTop = rows[0].base - asc[0];

  // The rise runs across the rows, top row first: every upper glyph leads
  // every lower one, so while the rows share the track's mask the gap between
  // them can only open. The lag is capped so long titles still land together.
  const glyphs = [];
  for (const row of rows) {
    for (const g of row.lay.glyphs) if (g.ch !== ' ') glyphs.push({ ch: g.ch, x: row.x + g.x, base: row.base });
  }
  const lag = Math.min(0.018, 0.4 / Math.max(1, glyphs.length - 1));
  glyphs.forEach((g, k) => (g.at = 1.95 + k * lag));

  // Keyframe track: as wide as the title, never narrower than 720 px.
  const half = Math.max(360, (right - left) / 2 + 6);
  const x0 = W / 2 - half;
  const x1 = W / 2 + half;
  const tx = [0, 1, 2, 3].map((k) => lerp(x0, x1, k / 3));

  // Paths: mirror-symmetric quarter arcs; outer pair rise from the bottom
  // corners, inner pair drop from the top. The finished diagram holds for a
  // beat after the fade in, then the outer pair launches first.
  const y = AXIS_Y;
  const paths = [
    buildPath(0, [tx[0] - 250, y + 300], [tx[0] - 80, y + 300], [tx[0], y + 190], [tx[0], y], 0.92, 0),
    buildPath(1, [tx[1] - 300, y - 420], [tx[1] - 130, y - 420], [tx[1], y - 190], [tx[1], y], 1.04, 0.08),
    buildPath(2, [tx[2] + 300, y - 420], [tx[2] + 130, y - 420], [tx[2], y - 190], [tx[2], y], 1.04, 0.08),
    buildPath(3, [tx[3] + 250, y + 300], [tx[3] + 80, y + 300], [tx[3], y + 190], [tx[3], y], 0.92, 0),
  ];

  // Tagline and credits: the credits are the reel's own numbers (reel.fps is
  // the s.fps every render receives).
  const tagFont = font(44, 'serif', 360, 'italic');
  c.font = tagFont;
  const tagW = c.measureText(TAGLINE).width;
  const creditFont = font(20, 'mono', 400);
  const frames = reel.frames;
  const digits = String(frames).length;
  const creditParts = [`${reel.scenes.length} scenes · `, ` frames at ${reel.fps} fps · 0 video files`];
  const creditText = creditParts[0] + frames.toLocaleString('en-US') + creditParts[1];
  const credit = layoutGlyphs(c, creditText, creditFont, 1.5);

  return {
    size,
    font: F,
    glyphs,
    riseTitle: AXIS_Y - titleTop + 12,
    paths,
    tx,
    track: { x0, x1 },
    tag: { font: tagFont, x: W / 2 - tagW / 2, y: AXIS_Y + 78 },
    credit: {
      font: creditFont,
      lay: credit,
      x: W / 2 - credit.width / 2,
      y: AXIS_Y + 134,
      parts: creditParts,
      frames,
      digits,
    },
    dropBelow: 150,
    hits: tx.map((x) => lerp(HEAD[0], HEAD[1], (x - tx[0]) / (tx[3] - tx[0]))),
  };
}

/** Filled diamond (a square turned 45°), optionally spun by `rot`. */
function diamond(ctx, x, y, r, rot = 0) {
  if (r <= 0) return;
  const h = r / SQRT2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4 + rot);
  ctx.fillRect(-h, -h, h * 2, h * 2);
  ctx.restore();
}

/** Diamond outline from four thin rects (no stroke). */
function diamondOutline(ctx, x, y, r, lw) {
  if (r <= 0) return;
  const h = r / SQRT2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.PI / 4);
  ctx.fillRect(-h, -h, h * 2, lw);
  ctx.fillRect(-h, h - lw, h * 2, lw);
  ctx.fillRect(-h, -h + lw, lw, h * 2 - lw * 2);
  ctx.fillRect(h - lw, -h + lw, lw, h * 2 - lw * 2);
  ctx.restore();
}

/** A 1.5 px segment between two points, as a rotated rect. */
function segment(ctx, ax, ay, bx, by, lw = 1.5) {
  const len = Math.hypot(bx - ax, by - ay);
  ctx.save();
  ctx.translate(ax, ay);
  ctx.rotate(Math.atan2(by - ay, bx - ax));
  ctx.fillRect(0, -lw / 2, len, lw);
  ctx.restore();
}

/** Add a disc to the current path, so many dots can share one fill. */
function disc(ctx, x, y, r) {
  ctx.moveTo(x + r, y);
  ctx.arc(x, y, r, 0, TAU);
}

/**
 * A keyframe marker: its outline at K and its tangent handle toward Hd,
 * scaled by k. The first `eaten` fraction of the handle, from the keyframe
 * out, is erased.
 */
function marker(ctx, P, K, Hd, k, eaten, alpha) {
  if (k <= 0 || alpha <= 0) return;
  ctx.fillStyle = rgba(P.color, 0.9 * alpha);
  const hx = K[0] + (Hd[0] - K[0]) * k;
  const hy = K[1] + (Hd[1] - K[1]) * k;
  if (eaten < 1) {
    segment(ctx, lerp(K[0], hx, eaten), lerp(K[1], hy, eaten), hx, hy);
    ctx.beginPath();
    disc(ctx, hx, hy, 3.5 * k);
    ctx.fill();
  }
  diamondOutline(ctx, K[0], K[1], 8 * k, 1.5);
}

/** Where a diamond is along its path at progress u (extrapolated past the ends). */
function along(P, u, out) {
  if (u < 0) {
    out[0] = P.S[0] + P.outDir[0] * u * P.len;
    out[1] = P.S[1] + P.outDir[1] * u * P.len;
  } else if (u > 1) {
    out[0] = P.T[0] + P.inDir[0] * (u - 1) * P.len;
    out[1] = P.T[1] + P.inDir[1] * (u - 1) * P.len;
  } else pointAt(P.pts, u, false, out);
  return out;
}

/** Motion-path view: dashed path, frame ticks, keyframe markers and handles. */
function drawPath(ctx, P, t) {
  const drawn = ease.inOutCubic(seg(t, P.drawAt, P.drawAt + DRAW));
  // Erased behind the diamond; once it has arrived the path is gone for good,
  // even while the spring swings back through the end.
  const gone = t >= P.arrive ? 1 : clamp01(progress(P, t));
  if (drawn <= 0 || gone >= 1) return;
  ctx.fillStyle = rgba(P.color, 0.8);

  for (const d of P.dashes) {
    const a = Math.max(d.s, gone);
    const b = Math.min(d.e, drawn);
    if (b <= a) continue;
    const k = d.len / (d.e - d.s); // px per unit of u within this dash
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.rotate(d.ang);
    ctx.fillRect((a - d.s) * k, -1, (b - a) * k, 2);
    ctx.restore();
  }

  ctx.fillStyle = P.color;
  ctx.beginPath();
  for (const tk of P.ticks) if (tk.u > gone && tk.u <= drawn) disc(ctx, tk.p[0], tk.p[1], 2.5);
  ctx.fill();

  // Keyframe markers with their tangent handles, popping in as the path
  // draws. The start set leaves with the path: its handle is erased from the
  // keyframe out at the path's pace, and its outline fades once the diamond
  // has gone. The end set retracts into its keyframe as the diamond arrives.
  const pop = ease.outBack(seg(t, P.drawAt, P.drawAt + 0.35));
  const eaten = clamp01((gone * P.len) / P.hOutLen);
  marker(ctx, P, P.S, P.hOut, pop, eaten, 1 - ease.outQuad(seg(t, P.launch, P.launch + 0.2)));
  const endK = ease.outBack(seg(drawn, 0.85, 1)) * (1 - eseg(gone, 0.8, 0.98, 'inCubic'));
  marker(ctx, P, P.T, P.hIn, endK, 0, 1);
}

/** Title rises out of the track, masked so it only exists above it; it sinks back with a small lift first. */
function drawTitle(ctx, L, t) {
  const out = ease.inBack(seg(t, 4.6, 4.84));
  if (t <= 1.95 || t >= 4.84) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, AXIS_Y - 3);
  ctx.clip();
  ctx.font = L.font;
  ctx.fillStyle = BONE;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  for (const g of L.glyphs) {
    // A slight per-glyph lag keeps the rise from reading as a slab.
    const up = ease.outExpo(seg(t, g.at, g.at + 0.8));
    ctx.fillText(g.ch, g.x, g.base + (1 - up + out) * L.riseTitle);
  }
  ctx.restore();
}

/**
 * Tagline and credits drop out of the track, masked so they only exist below
 * it. They are the first to leave at the close: the credits shut back into
 * the centre, and the tagline lifts toward the track, fading before it
 * reaches the diamonds.
 */
function drawBelow(ctx, L, t) {
  const inB = ease.outExpo(seg(t, 2.15, 2.9));
  if (inB <= 0 || t >= 4.64) return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, AXIS_Y + 3, W, H);
  ctx.clip();
  const dy = -(1 - inB) * L.dropBelow;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const tagOut = ease.inOutSine(seg(t, 4.46, 4.64));
  ctx.font = L.tag.font;
  ctx.fillStyle = rgba(BONE, 0.86 * (1 - tagOut));
  ctx.fillText(TAGLINE, L.tag.x, L.tag.y + dy - 22 * tagOut);

  // Credits open from the centre while the frame count runs up to the real
  // total (zero-padded, so the monospaced line never shifts).
  const cr = L.credit;
  const crOut = seg(t, 4.38, 4.58);
  const open = ease.outExpo(seg(t, 2.45, 3.2)) * (1 - ease.inQuart(crOut));
  if (open > 0) {
    const count = Math.round(cr.frames * ease.outQuart(seg(t, 2.45, 3.0)));
    const text = cr.parts[0] + count.toLocaleString('en-US', { minimumIntegerDigits: cr.digits }) + cr.parts[1];
    const half = (cr.lay.width / 2 + 8) * open;
    ctx.beginPath();
    ctx.rect(W / 2 - half, AXIS_Y + 3, half * 2, H);
    ctx.clip();
    ctx.font = cr.font;
    ctx.fillStyle = rgba(BONE, 0.62 * (1 - ease.inQuad(crOut)));
    const gl = cr.lay.glyphs;
    for (let i = 0; i < gl.length; i++) ctx.fillText(text[i], cr.x + gl[i].x, cr.y + dy * 0.6);
  }
  ctx.restore();
}

export default defineScene({
  id: 'outro',
  title: 'End Card',
  duration: 5.5,
  poster: 3.0,
  color: '#EFEBE3',
  transition: { type: 'fade', duration: 0.8 },
  slug: false,
  uses: ['title'], // the layout reads the title and the reel timeline, never the seed
  // Hairlines on near-black: the overlay grain is all but invisible here and
  // would cost more than the whole scene.
  post: { grain: 0 },
  notes: [
    'Motion paths with Bézier handles',
    'Spring-settled lockup',
    'Credits computed from the reel timeline',
    'Seamless loop into the title',
  ],
  uses: ['title'],
  /** Sound: the keyframes snapping onto the track, then the final merge. */
  cues({ state: L }) {
    if (!L) return [];
    return [
      { t: 0.86, kind: 'whoosh', dur: 0.3, strength: 0.3 }, // the outer pair launches
      ...L.paths.map((p) => ({ t: p.arrive, kind: 'land', strength: 0.7 })),
      // Last cue is short so nothing rings past the loop seam.
      { t: 4.8, kind: 'land', strength: 0.45 }, // the diamonds merge
    ];
  },
  setup({ params, reel }) {
    return buildLayout(params, reel);
  },
  render(ctx, s) {
    const L = s.state;
    const t = s.t;
    ctx.fillStyle = INK;
    ctx.fillRect(0, 0, W, H);

    for (const P of L.paths) drawPath(ctx, P, t);

    // Collapse: everything slides into the centre of the track.
    const merge = ease.inOutQuart(seg(t, 4.8, 5.05));
    const cx = W / 2;

    // Keyframe track, drawn out from the centre once the diamonds have settled.
    const open = ease.outExpo(seg(t, 1.66, 2.06));
    if (open > 0 && merge < 1) {
      const left = lerp(lerp(cx, L.track.x0, open), cx, merge);
      const right = lerp(lerp(cx, L.track.x1, open), cx, merge);
      const head = lerp(L.tx[0], L.tx[3], seg(t, HEAD[0], HEAD[1])); // constant speed: it is time
      ctx.fillStyle = rgba(BONE, 0.22);
      ctx.fillRect(left, AXIS_Y - 1, right - left, 2);
      if (t > HEAD[0]) {
        ctx.fillStyle = rgba(BONE, 0.85);
        ctx.fillRect(left, AXIS_Y - 1, Math.min(head, right) - left, 2);
      }
      // Playhead.
      const ph = ease.outExpo(seg(t, 2.05, 2.35)) * (1 - ease.inCubic(seg(t, HEAD[1], HEAD[1] + 0.14)));
      if (ph > 0) {
        ctx.fillStyle = BONE;
        ctx.fillRect(head - 1, AXIS_Y - 30 * ph, 2, 60 * ph);
      }
    }

    // Text, revealed out of the track through masks on either side of it.
    drawTitle(ctx, L, t);
    drawBelow(ctx, L, t);

    // Diamonds.
    const pos = [0, 0];
    L.paths.forEach((P, i) => {
      const appear = ease.outBack(seg(t, P.drawAt + 0.25, P.drawAt + 0.5));
      if (appear <= 0) return;
      if (merge >= 1 && i !== 3) return; // merged into the last one
      const dt = Math.max(0, t - P.launch);
      along(P, progress(P, t), pos);
      const x = lerp(pos[0], cx, merge);
      const breathe = 1 + 0.035 * Math.sin((TAU * (t - 2)) / 1.6 + i * 0.8) * eseg(t, 2, 2.6, 'inOutSine') * (1 - merge);
      const hit = 1 + 0.3 * pulse(t, L.hits[i], 0.05, 0.22);
      let r = R * appear * breathe * hit;
      let rot = (1 - SPIN(dt)) * (i < 2 ? -1 : 1) * (Math.PI / 2); // mirrored quarter turns
      if (i === 3) {
        // The survivor: a last breath in, then a turn down to a point that
        // holds to the last frame, where the title's hairline starts (match cut).
        r *= kf(t, [[5.03, 1], [5.11, 1.4, 'outCubic'], [5.25, 0.15, 'inCubic']]);
        rot += ease.inCubic(seg(t, 5.05, 5.25)) * (Math.PI / 2);
      }
      ctx.fillStyle = P.color;
      diamond(ctx, x, pos[1], r, rot);
      // A ring on landing, centred on the keyframe: it is set, and the
      // diamond settles into it.
      const ring = seg(t, P.arrive, P.arrive + 0.5);
      if (ring > 0 && ring < 1) {
        ctx.fillStyle = rgba(P.color, 0.6 * (1 - ring) ** 2);
        diamondOutline(ctx, P.T[0], P.T[1], R * (1.2 + 1.6 * ease.outCubic(ring)), 1.5);
      }
    });
  },
});

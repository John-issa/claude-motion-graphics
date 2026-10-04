// The reel: lays scenes out on one timeline, composites transitions between
// them, and renders any instant on demand. Rendering is a pure function of
// (time, params, seed), which is what makes scrubbing, frame stepping,
// motion blur and frame-exact export possible.

import { clamp, clamp01, lerp, TAU } from './math.js';
import { resolveEase } from './easing.js';
import { createGL } from './gl.js';
import { grain, vignette } from './post.js';
import { makeCanvas } from './draw.js';
import { loadFonts, font, layoutGlyphs } from './text.js';
import { buildScore } from './score.js';

/** Design resolution. Scenes always draw in this 1920×1080 space. */
export const W = 1920;
export const H = 1080;

export const TRANSITIONS = ['cut', 'fade', 'wipe', 'iris', 'blinds', 'push', 'shutter'];

export const DEFAULT_PARAMS = { title: 'NUP' };

const DEFAULT_TRANSITION = { type: 'fade', duration: 0.5, ease: 'inOutCubic', color: null };
const DEFAULT_GRAIN = 0.05;

const normalizeTransition = (tr) => {
  const out = { ...DEFAULT_TRANSITION, ...(tr || {}) };
  if (out.type === 'cut') out.duration = 0;
  return out;
};

/** Returns a list of problems with a scene definition (empty when valid). */
export function validateScene(scene) {
  const problems = [];
  if (!scene || typeof scene !== 'object') return ['scene must be an object'];
  if (typeof scene.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(scene.id)) problems.push('id must be kebab-case');
  if (typeof scene.title !== 'string' || !scene.title.trim()) problems.push('title is required');
  if (!(typeof scene.duration === 'number' && scene.duration > 0 && scene.duration <= 30)) problems.push('duration must be 0-30 s');
  if (typeof scene.render !== 'function') problems.push('render(ctx, s) is required');
  if (scene.setup !== undefined && typeof scene.setup !== 'function') problems.push('setup must be a function');
  if (scene.cues !== undefined && typeof scene.cues !== 'function') problems.push('cues must be a function');
  if (scene.poster !== undefined && !(typeof scene.poster === 'number' && scene.poster >= 0 && scene.poster <= (scene.duration ?? 0))) problems.push('poster must be a time within the scene');
  if (scene.uses !== undefined && !(Array.isArray(scene.uses) && scene.uses.every((u) => typeof u === 'string'))) problems.push("uses must list input names, e.g. ['title', 'seed']");
  if (scene.color !== undefined && !/^#[0-9a-f]{6}$/i.test(scene.color)) problems.push('color must be #rrggbb');
  if (scene.notes !== undefined && !(Array.isArray(scene.notes) && scene.notes.every((n) => typeof n === 'string'))) problems.push('notes must be strings');
  if (scene.transition !== undefined) {
    const tr = scene.transition;
    if (!tr || typeof tr !== 'object') problems.push('transition must be an object like { type, duration }');
    else {
      if (!TRANSITIONS.includes(tr.type)) problems.push(`transition.type must be one of ${TRANSITIONS.join(', ')}`);
      if (tr.duration !== undefined && !(tr.duration >= 0 && tr.duration <= (scene.duration ?? 0) / 2)) problems.push('transition.duration must be 0 to half the scene');
    }
  }
  return problems;
}

/** Validate and normalise a scene definition. See SCENES.md for the contract. */
export function defineScene(scene) {
  const problems = validateScene(scene);
  if (problems.length) throw new Error(`Scene "${scene?.id ?? '?'}": ${problems.join('; ')}`);
  return { notes: [], post: {}, color: '#888888', ...scene, transition: normalizeTransition(scene.transition) };
}

function resetState(ctx) {
  // The current path is not part of the state save()/restore() preserves, so
  // a path left open by the previous frame would otherwise leak into the next
  // fill, stroke or clip and make the frame depend on render history.
  ctx.beginPath();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if ('filter' in ctx) ctx.filter = 'none';
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  ctx.setLineDash([]);
  ctx.shadowBlur = 0;
  ctx.shadowColor = 'rgba(0,0,0,0)';
  ctx.textAlign = 'start';
  ctx.textBaseline = 'alphabetic';
  ctx.imageSmoothingEnabled = true;
  ctx.fillStyle = '#000';
  ctx.strokeStyle = '#000';
}

function drawErrorCard(ctx, scene, err) {
  ctx.fillStyle = '#1a0d0d';
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ff6b5a';
  ctx.font = font(44, 'mono', 600);
  ctx.textBaseline = 'top';
  ctx.fillText(`${scene.id}: render error`, 120, 120);
  ctx.fillStyle = '#f0d0cc';
  ctx.font = font(28, 'mono', 400);
  String(err && err.message ? err.message : err)
    .split('\n')
    .slice(0, 12)
    .forEach((line, i) => ctx.fillText(line.slice(0, 90), 120, 200 + i * 42));
}

/**
 * Chapter slug ("02/08 —— PARTICLE TYPOGRAPHY") drawn in the top-left corner of
 * every scene for a consistent system across the reel. Scenes opt out with
 * `slug: false` or recolour it with `slug: { color, opacity }`.
 */
function drawSlug(ctx, s, scene, total) {
  const cfg = scene.slug;
  if (cfg === false) return;
  const k = resolveEase('outExpo')(clamp01((s.t - 0.3) / 0.8));
  if (k <= 0) return;
  const x = 96;
  const y = 86;
  const bold = font(18, 'mono', 700);
  const light = font(18, 'mono', 400);
  const num = `${String(s.index + 1).padStart(2, '0')}/${String(total).padStart(2, '0')}`;
  const L1 = layoutGlyphs(ctx, num, bold, 2.5);
  const L2 = layoutGlyphs(ctx, scene.title.toUpperCase(), light, 2.5);
  const gap = 18;
  const rule = 40;
  const width = L1.width + gap * 2 + rule + L2.width;
  ctx.save();
  ctx.globalAlpha = cfg?.opacity ?? 0.78;
  ctx.fillStyle = cfg?.color ?? '#EFEBE3';
  ctx.beginPath();
  ctx.rect(x - 4, y - 24, (width + 8) * k, 48);
  ctx.clip();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = bold;
  for (const g of L1.glyphs) ctx.fillText(g.ch, x + g.x, y);
  ctx.fillRect(x + L1.width + gap, y - 1, rule, 2);
  ctx.font = light;
  const x2 = x + L1.width + gap * 2 + rule;
  for (const g of L2.glyphs) ctx.fillText(g.ch, x2 + g.x, y);
  ctx.restore();
}

/**
 * createReel({ scenes, params, seed, fps }) → reel
 *
 * reel.render(ctx, t, { motionBlur, shutter }) draws global time t into ctx
 * (any 16:9 canvas; the reel scales design units to its pixel size).
 * reel.renderScene(ctx, id, t) draws one scene at its local time t, without
 * transitions (used by the snapshot tools).
 */
export function createReel({ scenes, params = {}, seed = 1, fps = 60 } = {}) {
  let currentParams = { ...DEFAULT_PARAMS, ...params };
  let currentSeed = seed;
  let grainOn = true;
  const gl = createGL();

  const entries = [];
  let cursor = 0;
  scenes.forEach((scene, index) => {
    const transition = index === 0 ? normalizeTransition({ type: 'cut' }) : normalizeTransition(scene.transition);
    const start = Math.max(0, cursor - transition.duration);
    entries.push({ scene, index, start, end: start + scene.duration, transition, state: undefined, error: null });
    cursor = start + scene.duration;
  });
  const duration = cursor;

  const meta = {
    duration,
    fps,
    frames: Math.round(duration * fps),
    W,
    H,
    scenes: entries.map((e) => ({
      id: e.scene.id,
      title: e.scene.title,
      color: e.scene.color,
      notes: e.scene.notes,
      index: e.index,
      start: e.start,
      end: e.end,
      duration: e.scene.duration,
      transition: e.transition.type,
      // The full incoming transition, so a scene can sync to its neighbour's
      // reveal (e.g. size an iris to it): { type, duration, ease, color, ... }.
      transitionIn: { ...e.transition },
      // A representative moment (local seconds) for stills, thumbnails and previews.
      poster: e.scene.poster ?? e.scene.duration / 2,
      usesWebGL: !!e.scene.usesWebGL,
    })),
  };

  function runSetup(e) {
    e.error = null;
    if (typeof e.scene.setup !== 'function') {
      e.state = undefined;
      return;
    }
    try {
      e.state = e.scene.setup({ params: currentParams, seed: currentSeed, W, H, gl, reel: meta });
    } catch (err) {
      e.state = undefined;
      e.error = err;
      console.error(`[${e.scene.id}] setup failed`, err);
    }
  }
  let score = null;
  /**
   * Re-run setup for scenes affected by the changed inputs. A scene that
   * declares `uses` (e.g. ['title', 'seed']) is only set up again when one of
   * those changes; a scene that doesn't declare it is always set up again.
   */
  const setupAll = (changed = null) => {
    for (const e of entries) {
      const uses = e.scene.uses;
      if (!changed || !uses || uses.some((u) => changed.includes(u))) runSetup(e);
    }
    score = null;
  };
  let blurSamples = 0;

  /** Each scene's optional sound cues, mapped to global reel time. */
  function collectCues() {
    const out = [];
    for (const e of entries) {
      if (typeof e.scene.cues !== 'function') continue;
      try {
        const list = e.scene.cues({ params: currentParams, seed: currentSeed, state: e.state, dur: e.scene.duration, reel: meta }) || [];
        for (const c of list) {
          if (c && c.t >= 0 && c.t <= e.scene.duration) out.push({ ...c, t: e.start + c.t, scene: e.scene.id });
        }
      } catch (err) {
        console.error(`[${e.scene.id}] cues failed`, err);
      }
    }
    return out.sort((a, b) => a.t - b.t);
  }

  const buffers = new Map();
  function buffer(name, w, h) {
    let c = buffers.get(name);
    if (!c) {
      c = makeCanvas(w, h);
      buffers.set(name, c);
    }
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  const reported = new Set();

  /** Draw one scene at global time t, optionally clipped and offset. */
  function drawScene(ctx, e, globalT, clip = null, ox = 0, oy = 0, localT = globalT - e.start) {
    const px = ctx.canvas.width / W;
    const lt = clamp(localT, 0, e.scene.duration);
    const frame = Math.round(globalT * fps);
    ctx.save();
    ctx.setTransform(px, 0, 0, px, 0, 0);
    resetState(ctx);
    if (clip) {
      ctx.beginPath();
      clip(ctx);
      ctx.clip();
    }
    if (ox || oy) ctx.translate(ox, oy);
    const s = {
      t: lt,
      p: lt / e.scene.duration,
      dur: e.scene.duration,
      W,
      H,
      px,
      fps,
      frame,
      state: e.state,
      params: currentParams,
      seed: currentSeed,
      gl,
      reel: meta,
      index: e.index,
      motionBlur: blurSamples,
    };
    // Count the saves made while the scene draws, so a scene that throws
    // part-way is unwound exactly. Otherwise its unbalanced save()s, and any
    // clip they hold, would leak into every later frame on this context.
    let depth = 0;
    const nativeSave = ctx.save;
    const nativeRestore = ctx.restore;
    ctx.save = function save() {
      depth++;
      return nativeSave.call(this);
    };
    ctx.restore = function restore() {
      if (depth > 0) depth--;
      return nativeRestore.call(this);
    };
    try {
      if (e.error) throw e.error;
      ctx.save();
      e.scene.render(ctx, s);
      ctx.restore();
      // Vignette under the slug, so the chapter slug reads at the same
      // brightness in every scene; grain goes over everything.
      const post = e.scene.post || {};
      if (post.vignette) vignette(ctx, post.vignette, W, H);
      drawSlug(ctx, s, e.scene, entries.length);
      const g = post.grain ?? DEFAULT_GRAIN;
      if (grainOn && g > 0) grain(ctx, frame, g, W, H);
    } catch (err) {
      if (!reported.has(e.scene.id)) {
        reported.add(e.scene.id);
        console.error(`[${e.scene.id}] render failed`, err);
      }
      while (depth > 0) ctx.restore();
      ctx.save();
      ctx.setTransform(px, 0, 0, px, 0, 0);
      resetState(ctx);
      drawErrorCard(ctx, e.scene, err);
      ctx.restore();
    } finally {
      delete ctx.save;
      delete ctx.restore;
    }
    ctx.restore();
  }

  function withDesign(ctx, fn) {
    const px = ctx.canvas.width / W;
    ctx.save();
    ctx.setTransform(px, 0, 0, px, 0, 0);
    resetState(ctx);
    fn(ctx);
    ctx.restore();
  }

  const transitions = {
    cut(ctx, a, b, t) {
      drawScene(ctx, b, t);
    },
    fade(ctx, a, b, t, p, e) {
      drawScene(ctx, a, t);
      if (e <= 0) return;
      const buf = buffer('fade', ctx.canvas.width, ctx.canvas.height);
      drawScene(buf.getContext('2d'), b, t);
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = e;
      ctx.drawImage(buf, 0, 0);
      ctx.restore();
    },
    wipe(ctx, a, b, t, p, e, tr) {
      const slant = H * Math.tan(((tr.angle ?? 14) * Math.PI) / 180);
      const band = tr.color ? tr.band ?? 110 : 0;
      const x = lerp(-band, W + slant, e);
      drawScene(ctx, a, t);
      if (e <= 0) return;
      drawScene(ctx, b, t, (c) => {
        c.moveTo(-10, -10);
        c.lineTo(x + slant * (10 / H), -10);
        c.lineTo(x - slant * (1 + 10 / H), H + 10);
        c.lineTo(-10, H + 10);
        c.closePath();
      });
      if (band > 0 && e < 1) {
        withDesign(ctx, (c) => {
          c.fillStyle = tr.color;
          c.beginPath();
          c.moveTo(x, 0);
          c.lineTo(x + band, 0);
          c.lineTo(x + band - slant, H);
          c.lineTo(x - slant, H);
          c.closePath();
          c.fill();
        });
      }
    },
    iris(ctx, a, b, t, p, e, tr) {
      const cx = (tr.x ?? 0.5) * W;
      const cy = (tr.y ?? 0.5) * H;
      const maxR = Math.hypot(Math.max(cx, W - cx), Math.max(cy, H - cy));
      const r = e * maxR;
      drawScene(ctx, a, t);
      if (r <= 0.5) return;
      drawScene(ctx, b, t, (c) => c.arc(cx, cy, r, 0, TAU));
      if (tr.color && e < 1) {
        withDesign(ctx, (c) => {
          const lw = 6 + 60 * (1 - e);
          c.strokeStyle = tr.color;
          c.lineWidth = lw;
          c.beginPath();
          c.arc(cx, cy, r + lw / 2, 0, TAU);
          c.stroke();
        });
      }
    },
    blinds(ctx, a, b, t, p, e, tr) {
      const n = tr.count ?? 8;
      const horizontal = tr.dir === 'y';
      const size = (horizontal ? H : W) / n;
      const easeFn = resolveEase(tr.ease);
      drawScene(ctx, a, t);
      if (p <= 0) return;
      drawScene(ctx, b, t, (c) => {
        for (let i = 0; i < n; i++) {
          const d = (i / Math.max(1, n - 1)) * 0.45;
          const q = easeFn(clamp01((p - d) / 0.55));
          if (q <= 0) continue;
          if (horizontal) c.rect(0, i * size, W, size * q + 0.75);
          else c.rect(i * size, 0, size * q + 0.75, H);
        }
      });
      if (tr.color) {
        withDesign(ctx, (c) => {
          c.fillStyle = tr.color;
          for (let i = 0; i < n; i++) {
            const d = (i / Math.max(1, n - 1)) * 0.45;
            const q = easeFn(clamp01((p - d) / 0.55));
            if (q <= 0 || q >= 1) continue;
            const edge = i * size + size * q;
            const w = (tr.band ?? 14) * (1 - q) + 2;
            if (horizontal) c.fillRect(0, edge, W, w);
            else c.fillRect(edge, 0, w, H);
          }
        });
      }
    },
    push(ctx, a, b, t, p, e, tr) {
      const dir = tr.dir ?? 'left';
      const dx = dir === 'left' ? -W : dir === 'right' ? W : 0;
      const dy = dir === 'up' ? -H : dir === 'down' ? H : 0;
      drawScene(ctx, a, t, null, dx * e, dy * e);
      drawScene(ctx, b, t, null, -dx * (1 - e), -dy * (1 - e));
    },
    shutter(ctx, a, b, t, p, e, tr) {
      const closing = p < 0.5;
      const q = closing ? resolveEase('inCubic')(p * 2) : 1 - resolveEase('outCubic')((p - 0.5) * 2);
      drawScene(ctx, closing ? a : b, t);
      withDesign(ctx, (c) => {
        const h = (q * H) / 2 + 1;
        c.fillStyle = tr.color ?? '#000';
        c.fillRect(0, 0, W, h);
        c.fillRect(0, H - h, W, h);
      });
    },
  };

  function renderFrame(ctx, t) {
    const tt = clamp(t, 0, duration);
    let a = null;
    let b = null;
    for (const e of entries) {
      if (tt >= e.start && tt < e.end) {
        a = b;
        b = e;
      }
    }
    if (!b) b = tt >= duration ? entries[entries.length - 1] : entries[0];
    if (!a) return drawScene(ctx, b, tt);
    const tr = b.transition;
    const p = tr.duration > 0 ? clamp01((tt - b.start) / tr.duration) : 1;
    const e = resolveEase(tr.ease)(p);
    (transitions[tr.type] || transitions.fade)(ctx, a, b, tt, p, e, tr);
  }

  /** Temporal supersampling: average `samples` sub-frames across the shutter. */
  function renderBlurred(ctx, t, samples, shutter, draw) {
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;
    const acc = buffer('accum', w, h);
    const tmp = buffer('sub', w, h);
    const actx = acc.getContext('2d');
    const tctx = tmp.getContext('2d');
    blurSamples = samples;
    try {
      for (let k = 0; k < samples; k++) {
        const offset = ((k + 0.5) / samples - 0.5) * shutter * (1 / fps);
        draw(tctx, t + offset);
        actx.globalAlpha = 1 / (k + 1);
        actx.drawImage(tmp, 0, 0);
      }
    } finally {
      blurSamples = 0;
    }
    actx.globalAlpha = 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(acc, 0, 0);
    ctx.restore();
  }

  function findEntry(idOrIndex) {
    const e = typeof idOrIndex === 'number' ? entries[idOrIndex] : entries.find((x) => x.scene.id === idOrIndex);
    if (!e) throw new Error(`No scene "${idOrIndex}"`);
    return e;
  }

  return {
    W,
    H,
    fps,
    duration,
    entries,
    meta,
    gl,
    get params() {
      return currentParams;
    },
    get seed() {
      return currentSeed;
    },
    /** Load fonts and run every scene's setup. Await before the first render. */
    async init() {
      await loadFonts();
      setupAll();
    },
    setParams(p) {
      const changed = Object.keys(p).filter((k) => p[k] !== currentParams[k]);
      currentParams = { ...currentParams, ...p };
      if (changed.length) setupAll(changed);
    },
    setSeed(s) {
      if (s >>> 0 === currentSeed) return;
      currentSeed = s >>> 0;
      setupAll(['seed']);
    },
    setGrain(on) {
      grainOn = !!on;
    },
    /** The procedural soundtrack for the current params and seed (cached). */
    score() {
      if (!score) score = buildScore(meta, { seed: currentSeed, cues: collectCues() });
      return score;
    },
    /** The scene that owns time t (the incoming one during a transition). */
    sceneAt(t) {
      let found = entries[0];
      for (const e of entries) if (t >= e.start) found = e;
      return found;
    },
    render(ctx, t, { motionBlur = 0, shutter = 0.5 } = {}) {
      if (motionBlur > 1) renderBlurred(ctx, t, motionBlur, shutter, (c, tt) => renderFrame(c, clamp(tt, 0, duration)));
      else renderFrame(ctx, t);
    },
    renderScene(ctx, idOrIndex, t, { motionBlur = 0, shutter = 0.5 } = {}) {
      const e = findEntry(idOrIndex);
      const draw = (c, tt) => drawScene(c, e, e.start + tt, null, 0, 0, tt);
      if (motionBlur > 1) renderBlurred(ctx, t, motionBlur, shutter, draw);
      else draw(ctx, t);
    },
  };
}

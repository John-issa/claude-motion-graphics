// The player: playback state, the render loop and all the chrome around the
// stage. Reel rendering is deterministic, so play, scrub, step and jump all
// reduce to "set t, draw t".

import { frameAt, timecode, secs, mmss, pad, short } from './format.js';
import { createTimeline, transitionName } from './timeline.js';
import { savePrefs } from './storage.js';
import { recordingSupport, startRecording, saveBlob } from './recorder.js';

const DEFAULT_TITLE = 'MOTION';
const TITLE_MAX = 24;
const TITLE_DEBOUNCE_MS = 200;
const BLUR_SAMPLES = 6;
const MAX_BACKING_W = 1920;
const AUTO_SCALES = [1, 0.75, 0.5];
const REC_W = 1280;
const REC_H = 720;
const FILE_BASE = 'claude-motion-reel';
const REDUCED_MOTION_T = 2.6;
const QUALITIES = ['auto', 'full', 'draft'];

const isTypingTarget = (node) => {
  if (!node || !(node instanceof Element)) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag !== 'INPUT') return false;
  const type = (node.getAttribute('type') || 'text').toLowerCase();
  return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
};

/** Rolling window of recent samples; the median shrugs off one-off spikes. */
function createWindow(size) {
  const buf = new Float64Array(size);
  let n = 0;
  let i = 0;
  return {
    push(v) {
      buf[i] = v;
      i = (i + 1) % size;
      n = Math.min(size, n + 1);
    },
    median() {
      if (!n) return 0;
      const sorted = Array.from(buf.subarray(0, n)).sort((a, b) => a - b);
      return sorted[n >> 1];
    },
    get count() {
      return n;
    },
    clear() {
      n = 0;
      i = 0;
    },
  };
}

/**
 * createPlayer({ reel, target, prefs }) → { start(), fail(err), api }
 * Call it before reel.init() so the chrome is filled in while fonts load,
 * then start() once init resolves.
 */
export function createPlayer({ reel, target = 'dev', prefs = {} }) {
  const $ = (id) => document.getElementById(id);
  const app = $('app');
  const el = {
    stage: $('stage'),
    frame: $('frame'),
    canvas: $('canvas'),
    guides: $('guides'),
    stageMsg: $('stage-msg'),
    stagePlay: $('stage-play'),
    recBadge: $('rec-badge'),
    recBadgeTime: $('rec-badge-time'),
    transport: document.querySelector('.transport'),
    play: $('btn-play'),
    prev: $('btn-prev'),
    back: $('btn-back'),
    fwd: $('btn-fwd'),
    next: $('btn-next'),
    loop: $('btn-loop'),
    blur: $('btn-blur'),
    guidesBtn: $('btn-guides'),
    fs: $('btn-fs'),
    tc: $('tc'),
    frameNo: $('frame-no'),
    timeline: $('timeline'),
    nowPanel: $('now'),
    nowIndex: $('now-index'),
    nowTitle: $('now-title'),
    nowTime: $('now-time'),
    nowTransition: $('now-transition'),
    nowMeter: $('now-meter'),
    nowNotes: $('now-notes'),
    notesLabel: document.querySelector('.notes-label'),
    upNext: $('up-next'),
    upNextTitle: $('up-next-title'),
    upNextIn: $('up-next-in'),
    titleInput: $('title-input'),
    titleReset: $('title-reset'),
    seedOut: $('seed-out'),
    seedShuffle: $('seed-shuffle'),
    grain: $('grain-toggle'),
    grainText: document.querySelector('#grain-toggle .switch-text'),
    perf: $('perf'),
    exportRow: $('export-row'),
    exportNote: $('export-note'),
    rec: $('rec-btn'),
    recText: $('rec-btn-text'),
    recStatus: $('rec-status'),
    recProgress: $('rec-progress'),
    recBar: $('rec-progress-bar'),
    lede: $('lede'),
    specs: $('specs'),
    keys: $('keys'),
    keyLast: $('key-last-scene'),
  };
  const speedInputs = [...document.querySelectorAll('input[name="speed"]')];
  const qualityInputs = [...document.querySelectorAll('input[name="quality"]')];

  const ctx = el.canvas.getContext('2d', { alpha: false });
  const fps = reel.fps;
  const meta = reel.meta;
  const scenes = meta.scenes;
  const duration = meta.duration;
  const frames = Math.max(1, meta.frames);
  const lastT = (frames - 1) / fps;
  // A scene's "head" is the first frame after its incoming transition, where
  // it owns the whole frame. Scene jumps land there.
  const heads = scenes.map((s, i) => (i === 0 ? 0 : Math.min(lastT, Math.ceil(scenes[i - 1].end * fps - 1e-6) / fps)));

  const state = {
    t: 0,
    playing: false,
    speed: 1,
    loop: true,
    blur: false,
    guides: false,
    quality: QUALITIES.includes(prefs.quality) ? prefs.quality : 'auto',
    grain: prefs.grain !== false,
    ready: false,
    inspecting: false,
    scrubbing: false,
  };
  let rec = null;
  let dirty = true;
  let raf = 0;
  let lastNow = 0;
  let autoLevel = 0; // index into AUTO_SCALES
  let autoCap = 0; // Auto never climbs above this level (set when fill rate, not draw time, was the limit)
  let cssW = el.frame.clientWidth || 960;
  let resumeAfterScrub = false;
  let resumeOnShow = false;
  const perf = { renders: createWindow(30), intervals: createWindow(30), count: 0, since: 0, lastAdapt: 0, lastCheck: 0, text: '' };
  const resetStats = () => {
    perf.renders.clear();
    perf.intervals.clear();
  };
  const ui = { frame: -1, scene: -1, local: '', ariaSec: -1, recSec: -1, upNext: '', upNextKey: '' };

  // ---------- Static chrome ----------

  function fillStatic() {
    const n = scenes.length;
    el.lede.textContent = `A ${Math.round(duration)}-second showreel drawn frame by frame in your browser by a small motion engine, with no video files and no animation libraries.`;
    const parts = [`${n} scenes`, `${short(duration)} s`, `${fps} fps`, `${meta.W} × ${meta.H}`];
    el.specs.replaceChildren(
      ...parts.flatMap((text, i) => {
        const span = document.createElement('span');
        span.textContent = text;
        if (i === 0) return [span];
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.setAttribute('aria-hidden', 'true');
        sep.textContent = '·';
        return [sep, span];
      }),
    );
    const lastKey = Math.min(9, n);
    el.keyLast.textContent = String(lastKey);
    el.prev.title = `Previous scene (1 to ${lastKey} jump to a scene)`;
    el.next.title = `Next scene (1 to ${lastKey} jump to a scene)`;
    el.timeline.setAttribute('aria-valuemax', duration.toFixed(2));
    el.titleInput.value = reel.params.title || DEFAULT_TITLE;
    showSeed();
    for (const input of qualityInputs) input.checked = input.value === state.quality;
    reel.setGrain(state.grain);
    reflectGrain();
    if (window.matchMedia && window.matchMedia('(min-width: 760px) and (hover: hover)').matches) el.keys.open = true;
  }

  // ---------- Canvas size ----------

  const qualityScale = () => (state.quality === 'full' ? 1 : state.quality === 'draft' ? 0.5 : AUTO_SCALES[autoLevel]);

  /** Backing store = CSS size × devicePixelRatio × quality, capped at 1920 wide. */
  function fitCanvas() {
    let w;
    let h;
    if (rec) {
      w = REC_W;
      h = REC_H;
    } else {
      const dpr = window.devicePixelRatio || 1;
      const full = Math.min(cssW * dpr, MAX_BACKING_W);
      w = Math.max(64, Math.round((full * qualityScale()) / 16) * 16);
      h = (w / 16) * 9;
    }
    if (el.canvas.width !== w || el.canvas.height !== h) {
      el.canvas.width = w;
      el.canvas.height = h;
      dirty = true;
      resetStats();
    }
  }

  if (typeof ResizeObserver === 'function') {
    new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      const box = entry.contentBoxSize && entry.contentBoxSize[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      if (Math.abs(width - cssW) > 1) autoCap = 0;
      cssW = width;
      fitCanvas();
      // Draw now rather than next frame, so a resize never shows an empty canvas.
      if (dirty && state.ready) draw();
    }).observe(el.frame);
  }
  window.addEventListener('resize', () => {
    cssW = el.frame.clientWidth || cssW;
    fitCanvas();
    if (dirty) request();
  });

  // ---------- Render loop ----------

  function request() {
    if (!raf) raf = requestAnimationFrame(loop);
  }

  function loop(now) {
    raf = 0;
    if (state.playing) {
      // Cap the step so a stall doesn't lurch the picture forward. A recording
      // must follow the wall clock (MediaRecorder timestamps are real time),
      // so it only guards against long stalls.
      const dt = lastNow ? Math.min(rec ? 1 : 0.25, (now - lastNow) / 1000) : 0;
      lastNow = now;
      if (dt > 0) {
        perf.intervals.push(dt);
        advance(dt * (rec ? 1 : state.speed));
      }
      perf.count++;
      dirty = true;
      adaptQuality(now);
    }
    const drew = dirty;
    if (dirty) draw();
    // Paused draws are rare, so report them at once; playing ones twice a second.
    updatePerf(now, drew && !state.playing);
    if (state.playing) request();
  }

  function advance(dt) {
    const t = state.t + dt;
    if (t < duration) {
      state.t = t;
      return;
    }
    if (rec) {
      state.t = lastT;
      finishRecording();
    } else if (state.loop) {
      state.t = (t - duration) % duration;
    } else {
      state.t = lastT;
      pause();
    }
  }

  function draw() {
    dirty = false;
    if (!state.ready) return;
    const t0 = performance.now();
    reel.render(ctx, state.t, { motionBlur: state.blur ? BLUR_SAMPLES : 0 });
    perf.renders.push(performance.now() - t0);
    syncUI();
  }

  /**
   * Auto quality: drop the render scale when frames run slow, raise it again
   * when there is headroom. Decisions use medians over the last 30 frames, so
   * a one-off spike (first frame of a scene, a GC pause) changes nothing.
   */
  function adaptQuality(now) {
    if (state.quality !== 'auto' || rec || state.scrubbing) return;
    if (!perf.lastAdapt) {
      perf.lastAdapt = now;
      return;
    }
    const since = now - perf.lastAdapt;
    if (since < 1500 || perf.renders.count < 20 || now - perf.lastCheck < 500) return;
    perf.lastCheck = now;
    const ms = perf.renders.median();
    const interval = perf.intervals.median();
    const slow = interval > 1 / 45;
    // Under 25 fps the page is struggling whatever the cause; a 30 Hz display
    // (33 ms) stays clear of this, and cheap draw calls with slow frames mean
    // the GPU is filling too many pixels.
    const struggling = interval > 1 / 25;
    if (autoLevel < AUTO_SCALES.length - 1 && (ms > 12 || (slow && ms > 5) || struggling)) {
      autoLevel++;
      if (ms <= 5) autoCap = autoLevel;
    } else if (since > 5000 && autoLevel > autoCap && !slow) {
      const gain = AUTO_SCALES[autoLevel - 1] / AUTO_SCALES[autoLevel];
      if (ms * gain * gain > 7) return;
      autoLevel--;
    } else {
      return;
    }
    perf.lastAdapt = now;
    fitCanvas();
  }

  function updatePerf(now, force = false) {
    const elapsed = now - perf.since;
    if (!force && elapsed < 500) return;
    const rate = state.playing && perf.since && elapsed > 0 ? `${Math.round((perf.count * 1000) / elapsed)} fps` : 'Paused';
    perf.since = now;
    perf.count = 0;
    const ms = perf.renders.median();
    const parts = [rate, ms ? `${ms.toFixed(1)} ms/frame` : '– ms/frame', `${el.canvas.width}×${el.canvas.height}`];
    if (state.quality === 'auto' && autoLevel > 0 && !rec) parts.push(`${Math.round(AUTO_SCALES[autoLevel] * 100)}% scale`);
    // Non-breaking inside each part, so a narrow panel wraps only after a dot.
    const text = parts.map((p) => p.replace(/ /g, '\u00A0')).join('\u00A0· ');
    if (text !== perf.text) {
      perf.text = text;
      el.perf.textContent = text;
    }
  }

  // ---------- Chrome sync ----------

  function syncUI() {
    const t = state.t;
    const f = frameAt(t, fps, frames);
    if (f !== ui.frame) {
      ui.frame = f;
      el.tc.textContent = timecode(f, fps);
      el.frameNo.textContent = String(f);
    }
    timeline.setTime(t);
    const i = reel.sceneAt(t).index;
    if (i !== ui.scene) {
      ui.scene = i;
      showScene(i);
      timeline.setActive(i);
    }
    const s = scenes[i];
    const local = Math.min(s.duration, Math.max(0, t - s.start));
    const localText = `${secs(local)} / ${secs(s.duration)} s`;
    if (localText !== ui.local) {
      ui.local = localText;
      el.nowTime.textContent = localText;
    }
    el.nowMeter.style.setProperty('--p', (local / s.duration).toFixed(4));
    updateUpNext(i, t);
    // While playing, refresh the slider's spoken value once a second only.
    const sec = Math.floor(t);
    if (!state.playing || sec !== ui.ariaSec) {
      ui.ariaSec = sec;
      timeline.setValue(t, `${timecode(f, fps)}, scene ${i + 1} of ${scenes.length}, ${s.title}`);
    }
    if (rec) {
      el.recBar.style.setProperty('--p', Math.min(1, t / duration).toFixed(4));
      if (sec !== ui.recSec) {
        ui.recSec = sec;
        el.recBadgeTime.textContent = `${mmss(t)} / ${mmss(duration)}`;
      }
    }
  }

  function showScene(i) {
    const s = scenes[i];
    const n = scenes.length;
    el.nowIndex.textContent = `Scene ${pad(i + 1)} of ${pad(n)}`;
    el.nowTitle.textContent = s.title;
    el.nowPanel.style.setProperty('--c', s.color);
    const overlap = i > 0 ? Math.max(0, scenes[i - 1].end - s.start) : 0;
    el.nowTransition.textContent =
      i === 0 ? 'Opens the reel' : overlap > 0 ? `${transitionName(s.transition)} in, ${short(overlap, 2)} s` : 'Hard cut in';
    const notes = Array.isArray(s.notes) ? s.notes : [];
    el.nowNotes.replaceChildren(
      ...notes.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }),
    );
    el.notesLabel.hidden = notes.length === 0;
    el.canvas.setAttribute('aria-label', `Claude Motion Reel, scene ${i + 1} of ${n}: ${s.title}`);
  }

  /** The Up next row: the following scene and a countdown to its entrance. */
  function updateUpNext(i, t) {
    const last = i === scenes.length - 1;
    const ends = last && !state.loop;
    const nx = last ? 0 : i + 1;
    const key = `${nx}|${ends}`;
    if (key !== ui.upNextKey) {
      ui.upNextKey = key;
      el.upNext.disabled = ends;
      el.upNext.style.setProperty('--n', ends ? 'var(--line-2)' : scenes[nx].color);
      el.upNextTitle.textContent = ends ? 'End of the reel' : `${pad(nx + 1)} ${scenes[nx].title}`;
      el.upNext.title = ends ? '' : last ? 'Back to the start' : `Skip to ${scenes[nx].title}`;
    }
    const until = last ? duration - t : scenes[nx].start - t;
    const text = ends ? '' : `${last ? 'loops in' : 'in'} ${Math.max(0, until).toFixed(1)} s`;
    if (text !== ui.upNext) {
      ui.upNext = text;
      el.upNextIn.textContent = text;
    }
  }

  function reflect() {
    app.dataset.playing = String(state.playing);
    const label = state.playing ? 'Pause' : 'Play';
    el.play.setAttribute('aria-label', label);
    el.play.title = `${label} (Space or K)`;
    el.stagePlay.hidden = !state.ready || state.playing || state.inspecting || state.scrubbing || !!rec;
    el.loop.setAttribute('aria-pressed', String(state.loop));
    el.blur.setAttribute('aria-pressed', String(state.blur));
    el.guidesBtn.setAttribute('aria-pressed', String(state.guides));
    el.guides.hidden = !state.guides;
    for (const input of speedInputs) input.checked = Number(input.value) === state.speed;
  }

  function reflectGrain() {
    el.grain.setAttribute('aria-checked', String(state.grain));
    el.grainText.textContent = state.grain ? 'On' : 'Off';
  }

  // ---------- Transport ----------

  function play() {
    if (!state.ready || state.playing) return;
    if (!rec && state.t >= lastT - 1e-6) state.t = 0;
    state.playing = true;
    state.inspecting = false;
    lastNow = 0;
    perf.since = performance.now();
    perf.count = 0;
    perf.lastAdapt = 0;
    reflect();
    request();
  }

  function pause({ inspect = false } = {}) {
    if (!state.playing) {
      if (inspect && !state.inspecting) {
        state.inspecting = true;
        reflect();
      }
      return;
    }
    state.playing = false;
    state.inspecting = inspect;
    // Settle on the frame being shown so the timecode matches the picture.
    state.t = frameAt(state.t, fps, frames) / fps;
    dirty = true;
    reflect();
    request();
    updatePerf(performance.now(), true);
  }

  const toggle = () => (state.playing ? pause() : play());

  /** Move to time t. Paused seeks snap to the nearest frame. */
  function seek(t) {
    if (!state.ready) return;
    let v = Math.max(0, Math.min(lastT, t));
    if (!state.playing) {
      v = Math.min(lastT, Math.round(v * fps) / fps);
      state.inspecting = true;
    }
    state.t = v;
    dirty = true;
    reflect();
    request();
  }

  const seekBy = (dt) => seek(state.t + dt);

  function stepFrames(n) {
    if (!state.ready) return;
    pause({ inspect: true });
    const f = Math.max(0, Math.min(frames - 1, frameAt(state.t, fps, frames) + n));
    state.t = f / fps;
    dirty = true;
    reflect();
    request();
  }

  const jumpToScene = (i) => {
    if (i >= 0 && i < scenes.length) seek(heads[i]);
  };

  function prevScene() {
    const i = reel.sceneAt(state.t).index;
    jumpToScene(state.t - heads[i] > 0.5 ? i : Math.max(0, i - 1));
  }

  function nextScene() {
    const i = reel.sceneAt(state.t).index;
    if (state.t < heads[i] - 1e-6) jumpToScene(i);
    else if (i + 1 < scenes.length) jumpToScene(i + 1);
    else seek(lastT);
  }

  function setLoop(on) {
    state.loop = !!on;
    reflect();
    updateUpNext(reel.sceneAt(state.t).index, state.t);
  }

  function setBlur(on) {
    state.blur = !!on;
    resetStats();
    dirty = true;
    reflect();
    request();
  }

  function setGuides(on) {
    state.guides = !!on;
    reflect();
  }

  function setSpeed(v) {
    if (Number.isFinite(v) && v > 0) state.speed = v;
    reflect();
  }

  // ---------- Fullscreen ----------

  const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
  // Trust the standard flag when it exists (a sandboxed frame sets it false
  // while Chromium still reports the prefixed one); fall back for old Safari.
  const fsEnabled = 'fullscreenEnabled' in document ? !!document.fullscreenEnabled : !!document.webkitFullscreenEnabled;
  if (!fsEnabled) el.fs.hidden = true;

  async function toggleFullscreen() {
    if (el.fs.hidden) return;
    try {
      if (fsElement()) {
        await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      } else if (el.stage.requestFullscreen) {
        await el.stage.requestFullscreen({ navigationUI: 'hide' });
      } else if (el.stage.webkitRequestFullscreen) {
        await el.stage.webkitRequestFullscreen();
      } else {
        throw new Error('Fullscreen is not available');
      }
    } catch {
      // The page or its frame refused fullscreen: stop offering it.
      el.fs.hidden = true;
    }
  }

  const onFullscreenChange = () => {
    const on = fsElement() === el.stage;
    app.dataset.fullscreen = String(on);
    el.fs.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    el.fs.title = on ? 'Exit fullscreen (F)' : 'Fullscreen (F)';
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  // ---------- Make it yours ----------

  let titleTimer = 0;
  const cleanTitle = (v) => v.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX);

  function applyTitle() {
    clearTimeout(titleTimer);
    const typed = cleanTitle(el.titleInput.value);
    const title = typed || DEFAULT_TITLE;
    if (title !== reel.params.title) {
      reel.setParams({ title });
      dirty = true;
      request();
    }
    savePrefs({ title: typed });
  }

  el.titleInput.addEventListener('input', () => {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(applyTitle, TITLE_DEBOUNCE_MS);
  });
  el.titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyTitle();
    else if (e.key === 'Escape') el.titleInput.blur();
  });
  el.titleInput.addEventListener('blur', applyTitle);
  el.titleReset.addEventListener('click', () => {
    el.titleInput.value = DEFAULT_TITLE;
    applyTitle();
  });

  function showSeed() {
    el.seedOut.textContent = pad(reel.seed, 5);
  }

  el.seedShuffle.addEventListener('click', () => {
    let seed = reel.seed;
    while (seed === reel.seed) seed = 1 + Math.floor(Math.random() * 99999);
    reel.setSeed(seed);
    showSeed();
    savePrefs({ seed });
    dirty = true;
    request();
  });

  for (const input of qualityInputs) {
    input.addEventListener('change', () => {
      if (!input.checked) return;
      state.quality = input.value;
      autoLevel = 0;
      autoCap = 0;
      resetStats();
      perf.lastAdapt = 0;
      fitCanvas();
      request();
      savePrefs({ quality: state.quality });
      updatePerf(performance.now(), true);
    });
  }

  el.grain.addEventListener('click', () => {
    state.grain = !state.grain;
    reel.setGrain(state.grain);
    reflectGrain();
    savePrefs({ grain: state.grain });
    dirty = true;
    request();
  });

  // ---------- Export ----------

  const support = target === 'artifact' ? null : recordingSupport(el.canvas);
  const recLabel = support ? `Record ${support.ext === 'mp4' ? 'MP4' : 'WebM'}` : 'Record WebM';
  const fileName = `${FILE_BASE}.${support ? support.ext : 'webm'}`;
  const nowrap = (text) => {
    const span = document.createElement('span');
    span.className = 'nowrap';
    span.textContent = text;
    return span;
  };
  const setRecStatus = (...parts) => el.recStatus.replaceChildren(...parts);

  if (target === 'artifact') {
    el.exportRow.hidden = true;
    el.exportNote.hidden = false;
  } else {
    el.recText.textContent = recLabel;
    if (support) setRecStatus('Plays the reel once from the start at 1× and saves ', nowrap(fileName), '.');
    else
      setRecStatus(
        'This browser cannot record a canvas to video. Try a recent Chrome, Edge or Firefox, or clone the repo and run ',
        nowrap('npm run render'),
        ' for an MP4.',
      );
  }

  const lockable = () => [
    el.play,
    el.prev,
    el.back,
    el.fwd,
    el.next,
    el.loop,
    el.blur,
    el.titleInput,
    el.titleReset,
    el.seedShuffle,
    el.grain,
    el.upNext,
    ...speedInputs,
    ...qualityInputs,
  ];

  function setLocked(locked) {
    for (const control of lockable()) control.disabled = locked;
    timeline.setEnabled(!locked && state.ready);
    if (!locked) {
      ui.upNextKey = '';
      updateUpNext(reel.sceneAt(state.t).index, state.t);
    }
  }

  function startRecordingRun() {
    if (rec || !support || !state.ready) return;
    const saved = { loop: state.loop, speed: state.speed };
    pause();
    rec = { saved, session: null, cancelled: false, finishing: false };
    app.dataset.recording = 'true';
    setLocked(true);
    fitCanvas();
    state.t = 0;
    draw();
    try {
      rec.session = startRecording(el.canvas, { mime: support.mime, fps });
    } catch (err) {
      endRecording();
      setRecStatus(`Recording could not start: ${err && err.message ? err.message : err}.`);
      return;
    }
    const run = rec;
    run.session.done.then(
      (blob) => onRecorded(run, blob),
      (err) => {
        endRecording();
        setRecStatus(`Recording failed: ${err && err.message ? err.message : err}.`);
      },
    );
    ui.recSec = -1;
    el.rec.disabled = false;
    el.recText.textContent = 'Cancel recording';
    el.recProgress.hidden = false;
    el.recBadge.hidden = false;
    setRecStatus(`Recording ${REC_W} × ${REC_H} in real time. Keep this tab visible until it finishes.`);
    play();
  }

  function finishRecording() {
    if (!rec || rec.finishing) return;
    rec.finishing = true;
    state.playing = false;
    dirty = true;
    reflect();
    const run = rec;
    // Give the encoder a moment to take the final frame before stopping.
    setTimeout(() => run.session && run.session.stop(), 300);
  }

  function cancelRecording() {
    if (!rec) return;
    rec.cancelled = true;
    rec.finishing = true;
    state.playing = false;
    reflect();
    if (rec.session) rec.session.stop();
    else endRecording();
  }

  function onRecorded(run, blob) {
    endRecording();
    if (run.cancelled) {
      setRecStatus('Recording cancelled. Nothing was saved.');
      return;
    }
    try {
      saveBlob(blob, fileName);
      setRecStatus('Saved ', nowrap(fileName), `, ${(blob.size / 1048576).toFixed(1)} MB.`);
    } catch {
      setRecStatus('The browser blocked the download. Clone the repo and run ', nowrap('npm run render'), ' instead.');
    }
  }

  function endRecording() {
    const run = rec;
    rec = null;
    app.dataset.recording = 'false';
    el.recText.textContent = recLabel;
    el.recProgress.hidden = true;
    el.recBadge.hidden = true;
    if (run) {
      state.loop = run.saved.loop;
      state.speed = run.saved.speed;
    }
    setLocked(false);
    fitCanvas();
    dirty = true;
    reflect();
    request();
  }

  el.rec.addEventListener('click', () => (rec ? cancelRecording() : startRecordingRun()));

  // ---------- Timeline ----------

  const timeline = createTimeline(el.timeline, {
    meta,
    fps,
    onScrubStart() {
      if (!state.ready || rec) return false;
      resumeAfterScrub = state.playing;
      pause({ inspect: true });
      state.scrubbing = true;
      reflect();
      return true;
    },
    onScrub(t) {
      seek(t);
    },
    onScrubEnd() {
      state.scrubbing = false;
      if (resumeAfterScrub) {
        resumeAfterScrub = false;
        play();
      } else {
        reflect();
      }
    },
    onKey(kind, dir) {
      if (rec || !state.ready) return;
      if (kind === 'frame') stepFrames(dir);
      else if (dir > 0) nextScene();
      else prevScene();
    },
  });

  // ---------- Wiring ----------

  el.play.addEventListener('click', toggle);
  el.prev.addEventListener('click', prevScene);
  el.next.addEventListener('click', nextScene);
  el.back.addEventListener('click', () => stepFrames(-1));
  el.fwd.addEventListener('click', () => stepFrames(1));
  el.loop.addEventListener('click', () => setLoop(!state.loop));
  el.blur.addEventListener('click', () => setBlur(!state.blur));
  el.guidesBtn.addEventListener('click', () => setGuides(!state.guides));
  el.fs.addEventListener('click', toggleFullscreen);
  el.upNext.addEventListener('click', () => {
    if (!state.ready || rec) return;
    const i = reel.sceneAt(state.t).index;
    jumpToScene(i + 1 < scenes.length ? i + 1 : 0);
  });
  for (const input of speedInputs) {
    input.addEventListener('change', () => {
      if (input.checked) setSpeed(Number(input.value));
    });
  }

  // Clicking a button or a segmented option should not leave focus on it,
  // so Space keeps meaning play/pause. Keyboard focus is unaffected.
  for (const node of document.querySelectorAll('.page button, .seg label, .keys summary')) {
    node.addEventListener('mousedown', (e) => {
      if (e.button === 0) e.preventDefault();
    });
  }

  el.frame.addEventListener('click', () => {
    if (state.ready && !rec) toggle();
  });
  el.stagePlay.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!rec) play();
  });
  // Moving the mouse over a paused stage brings back the play button that
  // frame stepping and scrubbing hide.
  el.frame.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse' && state.inspecting && !state.playing && !state.scrubbing) {
      state.inspecting = false;
      reflect();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const node = e.target instanceof Element ? e.target : null;
    if (isTypingTarget(node)) return;
    const key = e.key;
    if ((key === ' ' || key === 'Enter') && node && node.closest('button, summary, a[href], [role="button"], [role="switch"]')) return;
    if (node && node.matches('input[type="radio"]') && (key.startsWith('Arrow') || key === ' ')) return;
    if (rec) {
      if (key === 'Escape') cancelRecording();
      else if (key === 'g' || key === 'G') setGuides(!state.guides);
      else return;
      e.preventDefault();
      return;
    }
    if (!state.ready) return;
    switch (key) {
      case ' ':
      case 'k':
      case 'K':
        toggle();
        break;
      case 'j':
      case 'J':
        seekBy(-1);
        break;
      case 'l':
      case 'L':
        seekBy(1);
        break;
      case 'ArrowLeft':
        if (e.shiftKey) seekBy(-1);
        else stepFrames(-1);
        break;
      case 'ArrowRight':
        if (e.shiftKey) seekBy(1);
        else stepFrames(1);
        break;
      case 'Home':
        seek(0);
        break;
      case 'End':
        seek(lastT);
        break;
      case 'g':
      case 'G':
        setGuides(!state.guides);
        break;
      case 'b':
      case 'B':
        setBlur(!state.blur);
        break;
      case 'f':
      case 'F':
        toggleFullscreen();
        break;
      default:
        if (/^[1-9]$/.test(key) && Number(key) <= scenes.length) {
          jumpToScene(Number(key) - 1);
          break;
        }
        return;
    }
    e.preventDefault();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (rec && rec.session) rec.session.pause();
      if (state.playing) {
        resumeOnShow = true;
        pause();
      }
    } else {
      if (rec && rec.session) rec.session.resume();
      if (resumeOnShow) {
        resumeOnShow = false;
        play();
      }
    }
  });

  // ---------- Lifecycle ----------

  function start() {
    state.ready = true;
    app.dataset.ready = 'true';
    el.stageMsg.hidden = true;
    setLocked(false);
    el.rec.disabled = !support;
    fitCanvas();
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) {
      // Start paused on a representative frame, with the play button showing.
      state.t = Math.min(lastT, Math.round(REDUCED_MOTION_T * fps) / fps);
      dirty = true;
      reflect();
      request();
    } else {
      state.t = 0;
      dirty = true;
      play();
    }
    updatePerf(performance.now(), true);
  }

  function fail(err) {
    el.stageMsg.hidden = false;
    el.stageMsg.classList.add('is-error');
    el.stageMsg.textContent = `The reel could not start: ${err && err.message ? err.message : err}`;
  }

  fillStatic();
  fitCanvas();
  syncUI();
  reflect();

  const api = {
    reel,
    get t() {
      return state.t;
    },
    get frame() {
      return frameAt(state.t, fps, frames);
    },
    get playing() {
      return state.playing;
    },
    get recording() {
      return !!rec;
    },
    get state() {
      return {
        ...state,
        frame: frameAt(state.t, fps, frames),
        recording: !!rec,
        canvas: [el.canvas.width, el.canvas.height],
        autoScale: AUTO_SCALES[autoLevel],
      };
    },
    play,
    pause,
    toggle,
    seek,
    stepFrames,
    jumpToScene,
    setSpeed,
    setLoop,
    setBlur,
    setGuides,
  };
  return { start, fail, api };
}

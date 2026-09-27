// The timeline: a seconds ruler, one clip per scene, hatched transition
// overlaps and the playhead. The element is an ARIA slider; pointer scrubbing
// uses pointer capture so a drag keeps working outside the element.

import { pad, rulerLabel, timecode, frameAt, short } from './format.js';

const TRANSITION_NAMES = {
  cut: 'Cut',
  fade: 'Fade',
  wipe: 'Wipe',
  iris: 'Iris',
  blinds: 'Blinds',
  push: 'Push',
  shutter: 'Shutter',
};

export function transitionName(type) {
  if (TRANSITION_NAMES[type]) return TRANSITION_NAMES[type];
  const s = String(type || 'cut');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * createTimeline(el, { meta, fps, onScrubStart, onScrub, onScrubEnd, onKey })
 *
 * onScrubStart() may return false to refuse a scrub (while loading or recording).
 * onKey(kind, dir) handles the slider-only keys: 'frame' (Up/Down) and
 * 'scene' (Page Up/Page Down). Left/Right/Home/End bubble to the page handler.
 */
export function createTimeline(el, { meta, fps, onScrubStart, onScrub, onScrubEnd, onKey }) {
  const ruler = el.querySelector('.ruler');
  const track = el.querySelector('.track');
  const playhead = el.querySelector('.playhead');
  const ghost = el.querySelector('.ghost');
  const ghostLabel = el.querySelector('.ghost-label');
  const dur = meta.duration;
  const frames = Math.max(1, meta.frames);
  const pct = (t) => `${((t / dur) * 100).toFixed(4)}%`;

  // Ruler: a tick every second, a label every 5 s (every 10 s when narrow).
  const ticks = document.createDocumentFragment();
  for (let s = 0; s <= Math.floor(dur + 1e-9); s++) {
    const tick = document.createElement('span');
    tick.className = s % 5 === 0 ? 'tick major' : 'tick';
    tick.style.left = pct(s);
    ticks.append(tick);
    if (s % 5 === 0 && (dur - s) / dur > 0.045) {
      const label = document.createElement('span');
      label.className = s % 10 === 0 ? 'tick-label ten' : 'tick-label';
      label.style.left = pct(s);
      label.textContent = rulerLabel(s);
      ticks.append(label);
    }
  }
  ruler.replaceChildren(ticks);

  // Clips and transition overlaps.
  const clips = meta.scenes.map((s, i) => {
    const prev = meta.scenes[i - 1];
    const overlap = prev ? Math.max(0, prev.end - s.start) : 0;
    const clip = document.createElement('div');
    clip.className = 'clip';
    clip.style.left = pct(s.start);
    clip.style.width = pct(s.end - s.start);
    clip.style.setProperty('--c', s.color);
    clip.style.setProperty('--in', (overlap / dur).toFixed(5));
    clip.title = `${pad(i + 1)} ${s.title}, ${short(s.start, 2)} to ${short(s.end, 2)} s`;
    const num = document.createElement('span');
    num.className = 'clip-num';
    num.textContent = pad(i + 1);
    const name = document.createElement('span');
    name.className = 'clip-name';
    name.textContent = s.title;
    clip.append(num, name);
    return clip;
  });
  const overlaps = [];
  meta.scenes.forEach((s, i) => {
    const prev = meta.scenes[i - 1];
    if (!prev) return;
    const overlap = prev.end - s.start;
    if (overlap <= 1e-6) return;
    const x = document.createElement('div');
    x.className = 'xfade';
    x.style.left = pct(s.start);
    x.style.width = pct(overlap);
    x.style.setProperty('--ca', prev.color);
    x.style.setProperty('--cb', s.color);
    x.title = `${transitionName(s.transition)} transition, ${short(overlap, 2)} s: ${prev.title} into ${s.title}`;
    overlaps.push(x);
  });
  track.replaceChildren(...clips, ...overlaps);

  // Playhead and hover line are positioned in px from a cached width, so a
  // playing reel only changes a transform per frame.
  let width = el.clientWidth || 1;
  let current = 0;
  const place = (node, t) => {
    node.style.transform = `translateX(${((Math.max(0, Math.min(dur, t)) / dur) * width).toFixed(2)}px)`;
  };
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      width = el.clientWidth || 1;
      place(playhead, current);
    }).observe(el);
  } else {
    window.addEventListener('resize', () => {
      width = el.clientWidth || 1;
      place(playhead, current);
    });
  }

  const timeAt = (clientX) => {
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1))) * dur;
  };

  function showGhost(t) {
    ghost.hidden = false;
    place(ghost, t);
    ghostLabel.textContent = timecode(frameAt(t, fps, frames), fps).slice(3);
    const frac = t / dur;
    ghost.dataset.edge = frac < 0.05 ? 'start' : frac > 0.95 ? 'end' : '';
  }
  const hideGhost = () => {
    ghost.hidden = true;
  };

  let enabled = false;
  let pointer = null;

  el.addEventListener('pointerdown', (e) => {
    if (!enabled || pointer !== null) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (onScrubStart() === false) return;
    pointer = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic pointers; scrubbing still works inside.
    }
    el.classList.add('is-scrubbing');
    hideGhost();
    el.focus({ preventScroll: true });
    onScrub(timeAt(e.clientX));
    e.preventDefault();
  });

  el.addEventListener('pointermove', (e) => {
    if (pointer === e.pointerId) onScrub(timeAt(e.clientX));
    else if (pointer === null && enabled && e.pointerType === 'mouse') showGhost(timeAt(e.clientX));
  });

  const finish = (e) => {
    if (pointer === null || (e && e.pointerId !== pointer)) return;
    pointer = null;
    el.classList.remove('is-scrubbing');
    onScrubEnd();
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);
  el.addEventListener('lostpointercapture', finish);
  el.addEventListener('pointerleave', () => {
    if (pointer === null) hideGhost();
  });

  const KEYS = { ArrowUp: ['frame', 1], ArrowDown: ['frame', -1], PageUp: ['scene', 1], PageDown: ['scene', -1] };
  el.addEventListener('keydown', (e) => {
    if (!enabled || e.altKey || e.ctrlKey || e.metaKey) return;
    const action = KEYS[e.key];
    if (!action) return;
    e.preventDefault();
    onKey(action[0], action[1]);
  });

  let active = -1;
  return {
    setTime(t) {
      current = t;
      place(playhead, t);
    },
    setActive(i) {
      if (i === active) return;
      if (clips[active]) clips[active].classList.remove('is-active');
      if (clips[i]) clips[i].classList.add('is-active');
      active = i;
    },
    setValue(t, text) {
      el.setAttribute('aria-valuenow', t.toFixed(2));
      el.setAttribute('aria-valuetext', text);
    },
    setEnabled(on) {
      enabled = !!on;
      el.setAttribute('aria-disabled', String(!enabled));
      if (!enabled) hideGhost();
    },
  };
}

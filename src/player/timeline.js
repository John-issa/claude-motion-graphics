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

// A touch has to travel this far (CSS px) before it counts as a drag.
const TOUCH_SLOP = 6;
// Horizontal padding inside a clip, either side of its label (matches player.css).
const CLIP_PAD = 8;

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
  const scenes = meta.scenes;
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

  // Each clip's visible stretch runs from the end of its incoming overlap to
  // the start of the next scene, which covers its tail.
  const spans = scenes.map((s, i) => {
    const prev = scenes[i - 1];
    const next = scenes[i + 1];
    const inT = prev ? Math.max(0, prev.end - s.start) : 0;
    const outT = next ? Math.max(0, s.end - next.start) : 0;
    return { inT, outT, visible: Math.max(0, s.end - s.start - inT - outT) };
  });

  const clips = scenes.map((s, i) => {
    const clip = document.createElement('div');
    clip.className = 'clip';
    clip.style.left = pct(s.start);
    clip.style.width = pct(s.end - s.start);
    clip.style.setProperty('--c', s.color);
    clip.style.setProperty('--in', (spans[i].inT / dur).toFixed(5));
    clip.style.setProperty('--out', (spans[i].outT / dur).toFixed(5));
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
  scenes.forEach((s, i) => {
    const prev = scenes[i - 1];
    if (!prev || spans[i].inT <= 1e-6) return;
    const x = document.createElement('div');
    x.className = 'xfade';
    x.style.left = pct(s.start);
    x.style.width = pct(spans[i].inT);
    x.style.setProperty('--ca', prev.color);
    x.style.setProperty('--cb', s.color);
    x.title = `${transitionName(s.transition)} transition, ${short(spans[i].inT, 2)} s: ${prev.title} into ${s.title}`;
    overlaps.push(x);
  });
  track.replaceChildren(...clips, ...overlaps);

  // A clip shows its whole title or, when that doesn't fit, just its number:
  // never a truncated stub. Titles are measured once fonts are ready.
  let nameWidths = null;
  function measureNames() {
    const probe = clips[0] && clips[0].querySelector('.clip-name');
    if (!probe) return;
    const cs = getComputedStyle(probe);
    const ctx = document.createElement('canvas').getContext('2d');
    if (!ctx) return;
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    nameWidths = scenes.map((s) => ctx.measureText(s.title).width);
  }

  // Playhead and hover line are positioned in px from a cached width, so a
  // playing reel only changes a transform per frame.
  let width = el.clientWidth || 1;
  let current = 0;
  const place = (node, t) => {
    node.style.transform = `translateX(${((Math.max(0, Math.min(dur, t)) / dur) * width).toFixed(2)}px)`;
  };

  function fitLabels() {
    if (!nameWidths) measureNames();
    if (!nameWidths) return;
    const w = track.clientWidth || width;
    clips.forEach((clip, i) => {
      const room = (spans[i].visible / dur) * w - CLIP_PAD * 2;
      clip.classList.toggle('is-compact', nameWidths[i] > room - 1);
    });
  }

  const relayout = () => {
    width = el.clientWidth || 1;
    place(playhead, current);
    fitLabels();
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(relayout).observe(el);
  else window.addEventListener('resize', relayout);

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
  let pointer = null; // the pointer that is scrubbing
  let pending = null; // a touch or pen contact that hasn't shown its intent yet

  function begin(e) {
    if (onScrubStart() === false) return false;
    pointer = e.pointerId;
    try {
      // Touch pointers are already captured implicitly; capturing again would
      // fire lostpointercapture and end the scrub straight away.
      if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
    } catch {
      // Capture can fail for synthetic pointers; scrubbing still works inside.
    }
    el.classList.add('is-scrubbing');
    hideGhost();
    onScrub(timeAt(e.clientX));
    return true;
  }

  // Mouse scrubs at once. A finger could be starting a page scroll, so it
  // only scrubs once it moves sideways, and a tap without movement seeks.
  // Clicking doesn't move focus here (see player.js), so no focus ring
  // appears; keyboard users reach the slider with Tab.
  el.addEventListener('pointerdown', (e) => {
    if (!enabled || pointer !== null || pending) return;
    if (e.pointerType === 'mouse') {
      if (e.button === 0) begin(e);
      return;
    }
    pending = { id: e.pointerId, x: e.clientX, y: e.clientY };
  });

  el.addEventListener('pointermove', (e) => {
    if (pointer === e.pointerId) {
      onScrub(timeAt(e.clientX));
      return;
    }
    if (pending && pending.id === e.pointerId) {
      const dx = Math.abs(e.clientX - pending.x);
      const dy = Math.abs(e.clientY - pending.y);
      if (dx > TOUCH_SLOP && dx > dy) {
        pending = null;
        begin(e);
      } else if (dy > TOUCH_SLOP) {
        // A vertical pan: the page scrolls and the reel stays where it is.
        pending = null;
      }
      return;
    }
    if (pointer === null && enabled && e.pointerType === 'mouse') showGhost(timeAt(e.clientX));
  });

  const finish = (e) => {
    if (pointer === null || (e && e.pointerId !== pointer)) return;
    pointer = null;
    el.classList.remove('is-scrubbing');
    onScrubEnd();
  };
  el.addEventListener('pointerup', (e) => {
    if (pending && pending.id === e.pointerId) {
      pending = null;
      if (enabled && onScrubStart() !== false) {
        onScrub(timeAt(e.clientX));
        onScrubEnd();
      }
      return;
    }
    finish(e);
  });
  el.addEventListener('pointercancel', (e) => {
    // The browser took the gesture (a scroll or a pinch): change nothing.
    if (pending && pending.id === e.pointerId) {
      pending = null;
      return;
    }
    finish(e);
  });
  // Only the timeline's own capture counts: a touch starts out captured by
  // the clip under the finger, and moving capture here fires (and bubbles)
  // lostpointercapture from that clip.
  el.addEventListener('lostpointercapture', (e) => {
    if (e.target === el) finish(e);
  });
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
      if (!enabled) {
        hideGhost();
        pending = null;
      }
    },
    /** Re-measure clip titles, for example once the web fonts have loaded. */
    refit() {
      nameWidths = null;
      fitLabels();
    },
  };
}

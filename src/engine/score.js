// The soundtrack, composed from the reel's own timeline. Every scene gets a
// chord pad (crossfading through its transition), transitions get a whoosh
// that lands on a soft impact at the cut, and each scene adds a texture that
// suits it. Scenes can also export cues ({ t, kind, strength }) so hits land
// exactly on their own visual beats. Pure and deterministic: the same reel,
// seed and cues always produce the same score.

import { createRandom } from './random.js';

/** Chord voicings as MIDI notes, bass first: a D-centred, cinematic palette. */
export const CHORDS = {
  title: [38, 50, 57, 60, 64, 65], // Dm9
  particles: [34, 53, 57, 62, 65], // Bbmaj7
  'easing-study': [41, 57, 60, 62, 67], // F6/9
  riso: [36, 55, 60, 62, 64], // Cadd9
  data: [43, 58, 62, 65, 69], // Gm9
  geometry: [45, 57, 60, 64, 67], // Am7
  shader: [34, 62, 65, 69, 72], // Bbmaj9
  outro: [38, 50, 57, 62, 64, 69], // Dsus2(add9)
};

// D minor pentatonic across two octaves, for sparkle that can't clash.
const PENTA = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84];

const chordFor = (id, i) => CHORDS[id] ?? Object.values(CHORDS)[i % 8];

/**
 * buildScore(meta, { seed, cues }) → { duration, events }
 * meta: reel.meta. cues: [{ t (global seconds), kind, strength, scene }].
 * Event kinds understood in cues: 'hit', 'land', 'tick', 'whoosh', 'swell',
 * 'shimmer', 'beat'.
 */
export function buildScore(meta, { seed = 1, cues = [] } = {}) {
  const rnd = createRandom(seed ^ 0x51ab);
  const events = [];
  const add = (ev) => {
    if (ev.t >= 0 && ev.t < meta.duration) events.push(ev);
  };
  const scenes = meta.scenes;

  scenes.forEach((sc, i) => {
    const prev = scenes[i - 1];
    const next = scenes[i + 1];
    const overlapIn = prev ? Math.max(0, prev.end - sc.start) : 0;
    const overlapOut = next ? Math.max(0, sc.end - next.start) : 0;
    const chord = chordFor(sc.id, i);
    const last = !next;

    // Pad: fades in across the incoming transition and releases into the next
    // scene's. The last pad finishes before the reel ends, so the loop seam is
    // silent on both sides.
    const attack = i === 0 ? 1.4 : Math.max(0.6, overlapIn + 0.2);
    const release = last ? 1.4 : 1.6;
    const padEnd = last ? meta.duration - release - 0.15 : sc.end - overlapOut * 0.5;
    add({ t: i === 0 ? 0.25 : sc.start, type: 'pad', notes: chord.slice(1), dur: Math.max(0.5, padEnd - (i === 0 ? 0.25 : sc.start)), attack, release, gain: 0.07, cutoff: 560 + 60 * i, send: 0.5 });
    add({ t: i === 0 ? 0.25 : sc.start, type: 'sub', note: chord[0], dur: Math.max(0.5, padEnd - (i === 0 ? 0.25 : sc.start)), attack: attack + 0.4, release, gain: 0.08 });

    // Transition: a whoosh that lands on the cut, with a soft impact under
    // every transition except the final fade.
    if (prev) {
      const cut = sc.start + overlapIn * 0.5;
      const lead = Math.max(0.35, overlapIn * 0.5 + 0.25);
      add({ t: cut - lead, type: 'whoosh', dur: lead, f0: 260, f1: 5200, gain: 0.2, pan: i % 2 ? 0.35 : -0.35, send: 0.3 });
      if (sc.transition !== 'fade') add({ t: cut, type: 'impact', gain: 0.32, send: 0.25 });
    }

    // Per-scene texture.
    const t0 = sc.start + overlapIn;
    const t1 = sc.end - overlapOut;
    switch (sc.id) {
      case 'title':
        add({ t: 0.05, type: 'whoosh', dur: 0.6, f0: 2400, f1: 9000, gain: 0.08, send: 0.4 });
        break;
      case 'particles':
        for (let t = t0 + 0.2; t < t1 - 0.3; t += 0.22 + rnd.next() * 0.3) {
          add({ t, type: 'bell', note: rnd.pick(PENTA) + 12, gain: 0.05 + rnd.next() * 0.03, decay: 2.2, pan: rnd.range(-0.7, 0.7), send: 0.6 });
        }
        break;
      case 'data': {
        // Odometer ratchet: fast at first, slowing like the digits.
        let t = t0 + 0.1;
        let gap = 0.035;
        while (t < Math.min(t1, t0 + 2.2)) {
          add({ t, type: 'tick', gain: 0.05, freq: 5200, pan: -0.25 });
          t += gap;
          gap *= 1.08;
        }
        for (let b = t0; b < t1 - 0.3; b += 0.5) add({ t: b, type: 'kick', gain: 0.16 });
        break;
      }
      case 'geometry':
        for (let b = t0; b < t1 - 0.3; b += 0.5) add({ t: b, type: 'kick', gain: 0.2 });
        break;
      case 'shader':
        add({ t: t0, type: 'sub', note: chord[0] - 12, dur: Math.max(1, t1 - t0 - 1), attack: 1.6, release: 1.4, gain: 0.07 });
        for (let t = t0 + 0.4; t < t1 - 0.4; t += 0.9 + rnd.next() * 0.6) {
          add({ t, type: 'bell', note: rnd.pick(chord.slice(2)) + 12, gain: 0.06, decay: 3, ratio: 2.01, pan: rnd.range(-0.5, 0.5), send: 0.7 });
        }
        break;
      case 'outro':
        chord.slice(2).forEach((n, k) => add({ t: t0 + 1.1 + k * 0.09, type: 'bell', note: n + 12, gain: 0.05, decay: 3.2, pan: -0.4 + k * 0.2, send: 0.6 }));
        break;
      default:
        break;
    }
  });

  // Scene cues: hits that land on each scene's own visual beats.
  let landStep = 0;
  for (const cue of cues) {
    const s = Math.max(0, Math.min(1.5, cue.strength ?? 1));
    const sc = scenes.find((x) => x.id === cue.scene) ?? scenes[0];
    const chord = chordFor(sc.id, sc.index ?? 0);
    switch (cue.kind) {
      case 'hit':
        add({ t: cue.t, type: 'impact', gain: 0.34 * s, send: 0.25 });
        break;
      case 'land': {
        const note = chord[1 + (landStep++ % (chord.length - 1))] + 12;
        add({ t: cue.t, type: 'pluck', note, gain: 0.16 * s, decay: 0.6, pan: cue.pan ?? 0, send: 0.3 });
        break;
      }
      case 'tick':
        add({ t: cue.t, type: 'tick', gain: 0.08 * s, pan: cue.pan ?? 0 });
        break;
      case 'whoosh':
        add({ t: cue.t, type: 'whoosh', dur: cue.dur ?? 0.5, f0: cue.dir === 'down' ? 5000 : 300, f1: cue.dir === 'down' ? 300 : 5000, gain: 0.16 * s, pan: cue.pan ?? 0, send: 0.3 });
        break;
      case 'swell':
        add({ t: cue.t, type: 'sub', note: chord[0], dur: cue.dur ?? 1, attack: (cue.dur ?? 1) * 0.6, release: 0.8, gain: 0.14 * s });
        break;
      case 'shimmer':
        add({ t: cue.t, type: 'bell', note: chord[2 + (landStep++ % (chord.length - 2))] + 24, gain: 0.06 * s, decay: 2.4, pan: cue.pan ?? 0, send: 0.6 });
        break;
      case 'beat':
        add({ t: cue.t, type: 'kick', gain: 0.22 * s });
        break;
      default:
        break;
    }
  }

  events.sort((a, b) => a.t - b.t || (a.type < b.type ? -1 : 1));
  return { duration: meta.duration, events };
}

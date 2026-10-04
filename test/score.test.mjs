import test from 'node:test';
import assert from 'node:assert/strict';
import scenes from '../src/scenes/index.js';
import { createReel, buildScore, eventLength, midiToHz, encodeWav } from '../src/engine/index.js';

const reel = createReel({ scenes });

test('the score is deterministic for a given reel and seed', () => {
  const a = JSON.stringify(buildScore(reel.meta, { seed: 3 }));
  assert.equal(a, JSON.stringify(buildScore(reel.meta, { seed: 3 })));
  assert.notEqual(a, JSON.stringify(buildScore(reel.meta, { seed: 4 })));
});

test('every event is well-formed, in range and time-sorted', () => {
  const { events, duration } = reel.score();
  const types = new Set(['pad', 'sub', 'pluck', 'bell', 'kick', 'tick', 'whoosh', 'impact']);
  let prev = -1;
  for (const ev of events) {
    assert.ok(types.has(ev.type), ev.type);
    assert.ok(ev.t >= 0 && ev.t < duration, `t=${ev.t}`);
    assert.ok(ev.t >= prev, 'sorted');
    prev = ev.t;
    for (const [k, v] of Object.entries(ev)) {
      if (typeof v === 'number') assert.ok(Number.isFinite(v), `${ev.type}.${k}`);
    }
    assert.ok(ev.gain > 0 && ev.gain <= 0.5, `${ev.type} gain ${ev.gain}`);
  }
});

test('every scene has a pad, and the loop seam is silent', () => {
  const { events, duration } = reel.score();
  const pads = events.filter((e) => e.type === 'pad');
  assert.equal(pads.length, reel.meta.scenes.length);
  const lastSound = Math.max(...events.map((e) => e.t + eventLength(e)));
  assert.ok(lastSound <= duration, `sound runs to ${lastSound.toFixed(2)} s of ${duration.toFixed(2)}`);
  assert.ok(events[0].t >= 0.05, 'nothing sounds on the very first frame');
});

test('audio helpers', () => {
  assert.equal(midiToHz(69), 440);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-9);
  const fake = { numberOfChannels: 2, length: 4, sampleRate: 48000, getChannelData: () => new Float32Array([0, 0.5, -0.5, 1]) };
  const wav = new DataView(encodeWav(fake));
  assert.equal(wav.byteLength, 44 + 4 * 2 * 2);
  assert.equal(String.fromCharCode(wav.getUint8(0), wav.getUint8(1), wav.getUint8(2), wav.getUint8(3)), 'RIFF');
  assert.equal(wav.getInt16(44 + 3 * 2 * 2, true), 0x7fff); // frame 3, left channel: 1.0
});

import test from 'node:test';
import assert from 'node:assert/strict';
import scenes from '../src/scenes/index.js';
import { validateScene, createReel } from '../src/engine/index.js';

test('every scene satisfies the scene contract', () => {
  const ids = new Set();
  for (const scene of scenes) {
    assert.deepEqual(validateScene(scene), [], scene.id);
    assert.ok(!ids.has(scene.id), `duplicate id ${scene.id}`);
    ids.add(scene.id);
    assert.ok(scene.notes.length >= 1 && scene.notes.length <= 6, `${scene.id} has 1-6 notes`);
  }
});

test('the reel is a sensible length', () => {
  const reel = createReel({ scenes });
  assert.ok(reel.duration > 30 && reel.duration < 75, `duration ${reel.duration}`);
  for (const s of reel.meta.scenes) assert.ok(s.end > s.start);
});

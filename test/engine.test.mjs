import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ease,
  cubicBezier,
  css,
  spring,
  resolveEase,
  kf,
  seg,
  stagger,
  wiggle,
  createRandom,
  hash,
  createNoise,
  noise1D,
  resample,
  polylineLength,
  circle,
  rect,
  alignStart,
  mix,
  ramp,
  parse,
  balanceLines,
  createReel,
  defineScene,
  validateScene,
} from '../src/engine/index.js';

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

test('every named easing starts at 0 and ends at 1', () => {
  for (const [name, fn] of Object.entries(ease)) {
    assert.equal(fn(0), 0, `${name}(0)`);
    assert.equal(fn(1), 1, `${name}(1)`);
    assert.equal(fn(-0.5), 0, `${name} clamps below`);
    assert.equal(fn(1.5), 1, `${name} clamps above`);
  }
});

test('non-overshooting easings are monotonic', () => {
  const monotonic = Object.keys(ease).filter((n) => !/Back|Elastic|Bounce/.test(n));
  for (const name of monotonic) {
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = ease[name](i / 200);
      assert.ok(v >= prev - 1e-12, `${name} decreases at ${i / 200}`);
      prev = v;
    }
  }
});

test('cubic-bezier matches reference values for CSS "ease"', () => {
  // Reference values from the WebKit UnitBezier solver.
  assert.ok(close(css.ease(0.25), 0.4094, 1e-3));
  assert.ok(close(css.ease(0.5), 0.8024, 1e-3));
  assert.ok(close(css.ease(0.75), 0.9604, 1e-3));
  const lin = cubicBezier(0.3, 0.3, 0.7, 0.7);
  assert.ok(close(lin(0.42), 0.42));
});

test('cubic-bezier inverts x(t) accurately, including flat regions', () => {
  const f = cubicBezier(0.9, 0, 0.1, 1);
  for (let i = 1; i < 100; i++) {
    const x = i / 100;
    const y = f(x);
    assert.ok(y >= 0 && y <= 1, `in range at ${x}`);
  }
  assert.ok(f(0.5) > 0.45 && f(0.5) < 0.55);
});

test('spring settles on 1 and satisfies its differential equation', () => {
  const k = 170;
  const c = 12;
  const f = spring({ stiffness: k, damping: c });
  assert.equal(f(0), 0);
  assert.ok(Math.abs(f(f.duration + 0.5) - 1) < 0.001);
  assert.ok(Math.max(...Array.from({ length: 100 }, (_, i) => f(i / 100))) > 1.05, 'underdamped overshoots');
  // x'' + (c/m) x' + (k/m)(x - 1) = 0, checked with central differences
  const h = 1e-4;
  for (const t of [0.05, 0.2, 0.4, 0.8]) {
    const d1 = (f(t + h) - f(t - h)) / (2 * h);
    const d2 = (f(t + h) - 2 * f(t) + f(t - h)) / (h * h);
    assert.ok(Math.abs(d2 + c * d1 + k * (f(t) - 1)) < 0.05, `ODE residual at ${t}`);
  }
  for (const damping of [26.07, 40, 80]) {
    const g = spring({ stiffness: k, damping });
    assert.ok(Math.abs(g(5) - 1) < 1e-3, `damping ${damping} settles`);
    assert.equal(g.ease(1), 1);
  }
});

test('resolveEase accepts names, functions and bezier arrays', () => {
  assert.equal(resolveEase('outExpo'), ease.outExpo);
  const fn = (x) => x;
  assert.equal(resolveEase(fn), fn);
  assert.ok(close(resolveEase([0.25, 0.1, 0.25, 1])(0.5), css.ease(0.5)));
});

test('keyframes hold, interpolate and ease per segment', () => {
  const keys = [[1, 0], [2, 100, 'linear'], [3, 50, 'linear']];
  assert.equal(kf(0, keys), 0);
  assert.equal(kf(1.5, keys), 50);
  assert.equal(kf(2.5, keys), 75);
  assert.equal(kf(9, keys), 50);
  assert.deepEqual(kf(1.5, [[1, [0, 10]], [2, [10, 20], 'linear']]), [5, 15]);
  assert.equal(seg(5, 2, 4), 1);
  assert.equal(seg(3, 2, 4), 0.5);
});

test('stagger spreads offsets from the requested origin', () => {
  assert.equal(stagger(0, 5, { each: 0.1 }), 0);
  assert.ok(close(stagger(4, 5, { each: 0.1 }), 0.4));
  assert.ok(close(stagger(2, 5, { total: 1, from: 'center' }), 0));
  assert.ok(close(stagger(0, 5, { total: 1, from: 'center' }), 1));
});

test('seeded randomness is repeatable and seed-sensitive', () => {
  const a = createRandom(42);
  const b = createRandom(42);
  const c = createRandom(43);
  const sa = Array.from({ length: 5 }, a.next);
  assert.deepEqual(sa, Array.from({ length: 5 }, b.next));
  assert.notDeepEqual(sa, Array.from({ length: 5 }, c.next));
  let sum = 0;
  for (let i = 0; i < 10000; i++) sum += hash(i, 7);
  assert.ok(Math.abs(sum / 10000 - 0.5) < 0.02, 'hash is roughly uniform');
});

test('noise is deterministic, bounded and continuous', () => {
  const n1 = createNoise(3);
  const n2 = createNoise(3);
  for (let i = 0; i < 200; i++) {
    const x = i * 0.137;
    const y = i * 0.071;
    const v = n1.noise3D(x, y, 0.5);
    assert.equal(v, n2.noise3D(x, y, 0.5));
    assert.ok(v >= -1.01 && v <= 1.01);
    assert.ok(Math.abs(n1.noise2D(x, y) - n1.noise2D(x + 1e-4, y)) < 0.01);
  }
  assert.notEqual(createNoise(4).noise2D(0.3, 0.7), n1.noise2D(0.3, 0.7));
  const v = [0, 0];
  n1.curl2D(0.2, 0.4, 1.0, v);
  assert.ok(Number.isFinite(v[0]) && Number.isFinite(v[1]));
  assert.ok(Math.abs(noise1D(3.25, 1) - noise1D(3.2501, 1)) < 0.01);
  assert.equal(wiggle(1.3, { seed: 5 }), wiggle(1.3, { seed: 5 }));
});

test('resampling keeps perimeter and spacing', () => {
  const sq = rect(64, 0, 0, 100, 100);
  assert.equal(sq.length, 128);
  assert.ok(Math.abs(polylineLength(sq) - 400) < 1);
  const circ = circle(32, 0, 0, 50);
  const again = resample(circ, 90);
  assert.equal(again.length, 180);
  const aligned = alignStart(circ, resample(circle(32, 0, 0, 50, 1.2), 32));
  assert.ok(Math.hypot(aligned[0] - circ[0], aligned[1] - circ[1]) < 12);
});

test('colour helpers blend and ramp', () => {
  assert.deepEqual(parse('#f31'), [255, 51, 17]);
  assert.equal(mix('#000000', '#ffffff', 0.5), 'rgb(128,128,128)');
  assert.equal(ramp(['#000000', '#ff0000', '#ffffff'])(0.5), 'rgb(255,0,0)');
});

test('balanceLines splits titles evenly', () => {
  assert.deepEqual(balanceLines('MOTION'), ['MOTION']);
  assert.deepEqual(balanceLines('CLAUDE MOTION REEL'), ['CLAUDE', 'MOTION REEL']);
});

test('reel overlaps scenes by their transition durations', () => {
  const mk = (id, duration, transition) => defineScene({ id, title: id, duration, transition, render() {} });
  const reel = createReel({
    scenes: [mk('a', 5), mk('b', 4, { type: 'wipe', duration: 1 }), mk('c', 3, { type: 'cut' })],
  });
  assert.equal(reel.duration, 5 + 4 - 1 + 3);
  assert.deepEqual(reel.meta.scenes.map((s) => s.start), [0, 4, 8]);
  assert.equal(reel.sceneAt(4.5).scene.id, 'b');
  assert.equal(reel.sceneAt(3.9).scene.id, 'a');
  assert.equal(reel.meta.frames, 11 * 60);
});

test('scene validation catches broken definitions', () => {
  assert.deepEqual(validateScene({ id: 'ok', title: 'OK', duration: 3, render() {} }), []);
  assert.ok(validateScene({ id: 'Bad Id', title: '', duration: 0 }).length >= 3);
  assert.ok(validateScene({ id: 'x', title: 'X', duration: 2, render() {}, transition: { type: 'spin' } }).length === 1);
});

test('setup re-runs only for scenes that use the changed input', () => {
  const calls = { a: 0, b: 0, c: 0 };
  const mk = (id, uses) => defineScene({ id, title: id, duration: 2, uses, setup() { calls[id]++; return {}; }, render() {} });
  const reel = createReel({ scenes: [mk('a', ['title']), mk('b', []), mk('c', undefined)] });
  reel.setParams({ title: 'X' }); // setup runs lazily in init(); count from here
  assert.deepEqual(calls, { a: 1, b: 0, c: 1 });
  reel.setSeed(9);
  assert.deepEqual(calls, { a: 1, b: 0, c: 2 });
  reel.setParams({ title: 'X' }); // unchanged: nothing re-runs
  assert.deepEqual(calls, { a: 1, b: 0, c: 2 });
});

test('a null or non-object transition gets a readable validation error', () => {
  for (const transition of [null, 'fade']) {
    const problems = validateScene({ id: 'x', title: 'X', duration: 2, render() {}, transition });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /transition must be an object/);
  }
});

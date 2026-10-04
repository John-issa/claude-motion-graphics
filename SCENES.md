# Writing a scene

A scene is one ES module in `src/scenes/` whose default export is `defineScene({...})`.
The reel (`src/engine/reel.js`) places scenes on one timeline, overlaps them for
transitions, and asks each scene to draw itself at any instant.

```js
import { defineScene, kf, seg, ease, font, palette } from '../engine/index.js';

export default defineScene({
  id: 'my-scene',            // kebab-case, unique
  title: 'My Scene',         // shown in the player and in the chapter slug
  duration: 6,               // seconds
  color: '#2446FF',          // timeline swatch in the player
  notes: ['Spring physics'], // 3-5 short technique notes shown while the scene plays
  transition: { type: 'wipe', duration: 0.7, color: '#FFD23F' }, // how this scene ENTERS
  post: { grain: 0.05, vignette: 0.25 },  // optional finishing (grain default 0.05)
  slug: { color: '#EFEBE3' },             // chapter slug colour, or false to hide it
  uses: ['title'],           // inputs setup() reads; omit to re-run setup on any change
  setup({ params, seed, W, H, gl, reel }) {
    return { /* precomputed, deterministic data */ };
  },
  cues({ params, seed, state, dur, reel }) { // optional: sound cues on this scene's beats
    return [{ t: 1.2, kind: 'hit' }, { t: 2.0, kind: 'land', strength: 0.6 }];
  },
  render(ctx, s) {
    ctx.fillStyle = palette.ink;
    ctx.fillRect(0, 0, s.W, s.H);
    // ...
  },
});
```

## The render call

`render(ctx, s)` draws the frame at local time `s.t`. The context is already
scaled so you draw in a **1920 × 1080 design space**, whatever the canvas size.

| field | meaning |
| --- | --- |
| `s.t` | local time in seconds, `0 … s.dur` |
| `s.p` | local progress, `0 … 1` |
| `s.dur` | this scene's duration |
| `s.W`, `s.H` | 1920, 1080 |
| `s.px` | physical pixels per design unit (0.33 for a 640 px preview, 1 for 1080p) |
| `s.fps`, `s.frame` | reel frame rate and the global frame number |
| `s.state` | whatever `setup()` returned |
| `s.params` | user parameters: `s.params.title` is the user's title text (1-24 chars) |
| `s.seed` | user seed (unsigned int) for generative variation |
| `s.gl` | shared WebGL layer (see below) |
| `s.reel` | timeline metadata: `{ duration, fps, frames, scenes: [{ id, title, start, end, duration, color, notes, transition }] }` |
| `s.index` | this scene's position in the reel (0-based) |
| `s.motionBlur` | sub-frames per frame while the reel supersamples for motion blur (0 otherwise); skip any blur you draw yourself when it's above 1 |

`s.reel.scenes[i].transitionIn` has the full incoming transition of every
scene (`{ type, duration, ease, color, ... }`), so a scene can line its exit
up with the next scene's reveal.

## Rules

1. **Deterministic.** A frame is a pure function of `(s.t, s.params, s.seed)`.
   Never call `Math.random`, `Date.now` or `performance.now`; use `hash`,
   `createRandom(seed)` and `createNoise(seed)`. Never carry state from one frame
   to the next: the player scrubs backwards, jumps, and renders sub-frames for
   motion blur. Anything expensive but time-independent goes in `setup()`.
2. **Opaque.** Paint the whole frame, background first, every render.
3. **Leave the transform alone.** Use `save/translate/scale/rotate/restore`; never
   `setTransform` or `resetTransform` (they would break the design-space scaling).
4. **No DOM at import time.** Modules must import cleanly in Node (the tests do).
   Create canvases lazily (in `setup` or on first render) with `makeCanvas`.
5. **Mind the overlaps.** Your first `transition.duration` seconds are revealed
   progressively over the previous scene, and the next scene's transition covers
   your last ~0.7-0.9 s. Keep key information out of those windows, and make sure
   something is already moving when the reveal starts.
6. **Title-safe layout.** Keep text inside the central 80 % (x 192-1728, y 108-972).
   The chapter slug occupies the top-left corner (x 96-700, y 60-110).
7. **Faint layers drift.** Canvases are 8-bit, so dozens of draws at very low
   alpha (below ~0.05) accumulate rounding error and shift colour visibly.
   Prefer fewer, stronger layers, or fold fading into the fill colour.
8. **Budget.** 2D scenes should render a 1280 × 720 frame in under ~14 ms median
   (`--bench`). Prefer sprites over `shadowBlur`, avoid `ctx.filter`, never call
   `getImageData` per frame, and don't create gradients per particle.

## Inputs and setup

`setup()` runs once at start and again when the viewer changes the title or
the seed. Declare what it reads with `uses` (`['title']`, `['seed']`, both, or
`[]`) so unrelated changes don't re-run it; without `uses`, it re-runs on
every change.

## Sound cues

The reel has a procedural soundtrack (`src/engine/score.js`): a chord pad per
scene, a whoosh and a soft impact on every transition, and a texture per scene.
`cues()` adds hits on your own visual beats. Return `{ t, kind, strength }`
items in local seconds; `strength` defaults to 1 (0-1.5):

| kind | sound | use it for |
| --- | --- | --- |
| `hit` | low impact | a slam, a big arrival |
| `land` | plucked chord tone (rises through the chord on repeats) | an element settling into place |
| `tick` | short high click | counters, clocks, small steps |
| `whoosh` | filtered noise sweep (`dur`, `dir: 'up' \| 'down'`) | fast moves, wipes |
| `swell` | low swell (`dur`) | a build toward a moment |
| `shimmer` | high bell | sparkle, a reveal |
| `beat` | soft kick | a pulse |

Keep cues sparse: a few per second at most, on beats a viewer can see. Check
the result with `__spectrogram()` in the harness (see the README).

## WebGL

`s.gl.render(fragSource, { width, height, uniforms })` runs a full-screen GLSL ES
1.00 fragment shader and returns a canvas to composite:

```js
const img = s.gl.render(FRAG, {
  width: s.W * s.px * 0.6, height: s.H * s.px * 0.6,   // render below output size, upscale
  uniforms: { uTime: s.t, uBalls: { v3: flatArray } },
});
ctx.drawImage(img, 0, 0, s.W, s.H);
```

To compile a shader ahead of the first frame, call `s.gl.program(FRAG)` from
`setup()` (wrapped in try/catch, falling back to 2D if it throws).

Shaders receive `varying vec2 vUv` (0-1, y up) and `uniform vec2 uResolution`.
Uniform values: number → float, 2-4 element arrays → vecN, `{ v2|v3|v4|f: flat }`
→ arrays, `{ int }`, `{ tex: canvas }`. Check `s.gl.available` and draw a 2D
fallback when WebGL is missing.

## Engine at a glance (`src/engine/index.js`)

- **Time** — `seg(t, a, b)` progress, `eseg` eased progress, `tween`, `kf(t, [[time, value, ease], ...])`
  keyframes (numbers or arrays), `stagger(i, n, { each | total, from })`,
  `wiggle(t, { freq, amp, seed })`, `pulse(t, at, attack, decay)`, `cycle(t, period)`.
- **Easing** — `ease.outExpo` etc. (full Penner set), `cubicBezier(x1, y1, x2, y2)`,
  `spring({ stiffness, damping, mass, velocity })` → `f(seconds)` with `.duration` and `.ease`,
  `css.easeInOut`, `steps(n)`. Anywhere an ease is accepted you can pass a name or a bezier array.
- **Random / noise** — `hash(i, seed)`, `hash2(x, y, seed)`, `createRandom(seed)`,
  `createNoise(seed)` → `{ noise2D, noise3D, curl2D, fbm2D, fbm3D }`, `noise1D(x, seed)`.
- **Colour** — `palette`, `rgba(hex, a)`, `mix(a, b, t)`, `ramp([...])(t)`, `cosine(...)`, `hsl`.
- **Type** — `font(size, 'display' | 'serif' | 'mono' | 'sans', weight, style)` (all
  variable, so any weight works), `layoutGlyphs(ctx, text, fontStr, tracking)` for
  per-letter animation that keeps kerning, `fitSize`, `balanceLines(text, maxLines)`,
  `textPoints(text, { font, count, ... })` for particle targets.
- **Shapes** — `circle`, `polygon`, `star`, `rect`, `superellipse`, `resample`,
  `alignStart`, `lerpPoints`, `tracePath`, `tracePartial` (stroke draw-on), `pointAt`.
- **Drawing** — `makeCanvas`, `roundRect`, `glowSprite`, `dotSprite`, `linearGradient`,
  `radialGradient`, `fillFrame`.
- **Math** — `lerp`, `clamp`, `clamp01`, `remap`, `smoothstep`, `fract`, `TAU`, `lerpAngle`, `pingpong`.

## Checking your work

```bash
node scripts/snap.mjs --scene my-scene                              # 12-frame contact sheet
node scripts/snap.mjs --scene my-scene --from 1 --to 2 --step 0.1   # dense look at one beat
node scripts/snap.mjs --scene my-scene --frame 3.2 --width 1920     # one full-size frame
node scripts/snap.mjs --reel --from 10 --to 14 --step 0.25          # transitions in context
node scripts/snap.mjs --scene my-scene --params '{"title":"HI"}'    # other user input
node scripts/snap.mjs --scene my-scene --audit                      # determinism + forbidden calls
node scripts/snap.mjs --scene my-scene --bench                      # ms per frame
```

Images land in `.snaps/` unless you pass `--out`.

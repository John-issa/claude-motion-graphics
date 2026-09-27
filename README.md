# Claude Motion Reel

A motion graphics showreel that renders live in the browser, frame by frame, from
a small motion engine written for it. There are no video files and no animation
libraries: every frame is computed on demand from the current time, so you can
scrub, step frame by frame, type your own title into it, and export it to video.

<!-- MEDIA -->

## Try it

```bash
npm install
npm run dev          # then open http://127.0.0.1:5173
```

Or build the single-file version and open it straight from disk:

```bash
npm run build        # writes dist/index.html (fonts, CSS and JS all inlined)
open dist/index.html
```

| Key | Action |
| --- | --- |
| Space / K | Play or pause |
| J / L | Back / forward one second |
| ← / → | One frame (Shift: one second) |
| Home / End | Start / end |
| 1 – 8 | Jump to a scene |
| G | Safe-area guides |
| B | Motion blur |
| F | Fullscreen |

Type into **Title** to put your own words into the title card, the particle scene
and the end card. **Shuffle** changes the seed behind every generative element.

<!-- SCENES -->

## How it works

**Every frame is a pure function of time.** A scene is a module with a
`render(ctx, s)` function that draws the instant `s.t` into a 1920 × 1080 design
space. Scenes never keep state between frames and never call `Math.random`, so
the player can jump anywhere, play backwards or render the same instant twice
and get the same pixels. That one rule is what makes everything else here work:

- **Scrubbing and frame stepping** are just rendering a different `t`.
- **Motion blur** is real temporal supersampling: the reel renders several
  sub-frames across a 180° shutter and averages them.
- **Export** is exact: `npm run render` steps through every frame in headless
  Chromium and pipes them to ffmpeg, with no dropped or duplicated frames.

The engine (`src/engine/`) is small and dependency-free:

| Module | What it does |
| --- | --- |
| `easing.js` | The full Penner set, a CSS-compatible cubic-Bézier solver (Newton–Raphson with a bisection fallback), and damped springs solved in closed form |
| `anim.js` | Keyframes, eased segments, staggering, a deterministic `wiggle()` |
| `noise.js`, `random.js` | Seeded simplex noise, curl noise, fractal noise, hashing and PRNGs |
| `text.js` | Canvas typography: per-glyph layout that keeps kerning, fitting, line balancing, sampling text into point clouds |
| `shapes.js` | Outline generation, resampling, morphing and partial-stroke drawing |
| `gl.js` | A shared WebGL layer for full-screen fragment shaders, composited into the 2D frame |
| `reel.js` | The timeline: places scenes, overlaps them, composites seven transition types, adds grain, vignette, chapter slugs and motion blur |

Scenes live in `src/scenes/`, one module each. [SCENES.md](SCENES.md) is the
contract for writing a new one.

## Rendering video

Needs ffmpeg on your `PATH` (or `FFMPEG_PATH`), plus Playwright's Chromium
(`npx playwright install chromium`).

```bash
npm run render                                   # media/claude-motion-reel.mp4, 1920×1080 at 60 fps
npm run render -- --width 1280 --fps 30          # smaller and faster
npm run render -- --motion-blur 8                # 8 sub-frames per frame
npm run render -- --params '{"title":"HELLO"}'   # your own title
npm run render -- --gif media/preview.gif        # also write a GIF
```

## Checking the work

```bash
npm test                                          # engine unit tests and the scene contract
node scripts/snap.mjs --scene particles           # contact sheet of one scene
node scripts/snap.mjs --scene particles --audit   # determinism check: renders out of order and compares pixels
node scripts/snap.mjs --scene particles --bench   # milliseconds per frame
```

## Layout

```
index.html            player page (development entry)
src/main.js           boots the reel and the player
src/player/           player UI: transport, timeline, controls
src/engine/           the motion engine
src/scenes/           one module per scene
src/fonts/            Unbounded, Fraunces, Martian Mono, Instrument Sans (SIL OFL)
scripts/              dev server, build, render, snapshot and screenshot tools
tools/harness.*       headless page the scripts drive
test/                 node:test suites
```

## Credits

Built by Claude in Claude Code. Fonts are licensed under the SIL Open Font
License 1.1; see [src/fonts/LICENSES.md](src/fonts/LICENSES.md).

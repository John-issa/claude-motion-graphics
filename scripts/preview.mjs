// Build the README media from a rendered reel:
//   - a highlights GIF: one short clip per scene around its poster moment
//   - a contact sheet: every scene's poster frame in a 4 × 2 grid
//
//   npm run render -- --width 1280 --fps 30 --out media/claude-motion-reel.mp4
//   node scripts/preview.mjs [--in media/claude-motion-reel.mp4] [--clip 1.4] [--width 560]
//
// Needs ffmpeg on PATH or FFMPEG_PATH.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import scenes from '../src/scenes/index.js';
import { createReel } from '../src/engine/index.js';
import { ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const input = path.resolve(ROOT, arg('in', 'media/claude-motion-reel.mp4'));
const gifOut = path.resolve(ROOT, arg('gif', 'media/preview.gif'));
const sheetOut = path.resolve(ROOT, arg('sheet', 'media/reel-sheet.jpg'));
const clip = Number(arg('clip', 1.4));
const width = Number(arg('width', 560));
const fps = Number(arg('fps', 15));

if (!fs.existsSync(input)) {
  console.error(`No video at ${path.relative(ROOT, input)}. Render one first with npm run render.`);
  process.exit(1);
}

const reel = createReel({ scenes });
// Poster moments in reel time, kept clear of the transitions on either side.
const moments = reel.meta.scenes.map((s) => {
  const t = s.start + s.poster;
  return Math.max(s.start + 0.9, Math.min(s.end - 0.9 - clip, t - clip / 2));
});

function run(args) {
  const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${args.join(' ')}`);
}

// Highlights GIF: trim each clip, concatenate, then one shared palette.
const trims = moments.map((t, i) => `[0:v]trim=start=${t.toFixed(3)}:duration=${clip},setpts=PTS-STARTPTS[v${i}]`);
const chain = `${moments.map((_, i) => `[v${i}]`).join('')}concat=n=${moments.length}:v=1:a=0[cat]`;
const look = `[cat]fps=${fps},scale=${width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
run(['-i', input, '-filter_complex', [...trims, chain, look].join(';'), gifOut]);
console.log(`Wrote ${path.relative(ROOT, gifOut)} (${(fs.statSync(gifOut).size / 1e6).toFixed(1)} MB, ${moments.length} clips of ${clip} s)`);

// Contact sheet: each scene's poster frame, 4 × 2.
const posters = reel.meta.scenes.map((s) => s.start + s.poster);
const inputs = posters.flatMap((t) => ['-ss', t.toFixed(3), '-i', input]);
const tiles = posters.map((_, i) => `[${i}:v]trim=end_frame=1,scale=640:-1[t${i}]`);
const grid = `${posters.map((_, i) => `[t${i}]`).join('')}xstack=inputs=${posters.length}:layout=0_0|w0_0|w0+w1_0|w0+w1+w2_0|0_h0|w0_h0|w0+w1_h0|w0+w1+w2_h0[out]`;
run([...inputs, '-filter_complex', [...tiles, grid].join(';'), '-map', '[out]', '-frames:v', '1', '-q:v', '3', sheetOut]);
console.log(`Wrote ${path.relative(ROOT, sheetOut)} (${(fs.statSync(sheetOut).size / 1e6).toFixed(1)} MB)`);

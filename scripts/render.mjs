// Render the reel to video, frame by frame, in headless Chromium.
// Because every frame is a pure function of time, the output is exact:
// no dropped frames, and optional motion blur from real sub-frame sampling.
//
//   npm run render                                   media/claude-motion-reel.mp4, 1920×1080 @ 60 fps
//   npm run render -- --width 1280 --fps 30          smaller and faster
//   npm run render -- --motion-blur 8                8 sub-frames per frame (180° shutter)
//   npm run render -- --from 12 --to 18 --out clip.mp4
//   npm run render -- --params '{"title":"HELLO"}' --seed 7
//   npm run render -- --gif media/preview.gif        also write a GIF (from the MP4)
//   npm run render -- --frames-dir out/frames        write a PNG sequence instead (no ffmpeg needed)
//
// Needs ffmpeg on PATH, or FFMPEG_PATH pointing at a binary.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import { startServer, ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const width = Number(arg('width', 1920));
const height = Math.round((width * 9) / 16 / 2) * 2;
const fps = Number(arg('fps', 60));
const motionBlur = Number(arg('motion-blur', 0));
const crf = String(arg('crf', 18));
const out = path.resolve(ROOT, arg('out', 'media/claude-motion-reel.mp4'));
const framesDir = arg('frames-dir') ? path.resolve(ROOT, arg('frames-dir')) : null;
const gif = arg('gif') ? path.resolve(ROOT, arg('gif') === true ? 'media/preview.gif' : arg('gif')) : null;
const workers = Math.max(1, Math.min(Number(arg('workers', Math.min(4, os.cpus().length))), 8));
const params = arg('params') ? JSON.parse(arg('params')) : null;
const seed = arg('seed') !== undefined ? Number(arg('seed')) : null;

function findFfmpeg() {
  const candidates = [process.env.FFMPEG_PATH, 'ffmpeg'].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ['-version'], { stdio: 'ignore' });
    if (r.status === 0) return bin;
  }
  return null;
}

async function openPage(browser, url) {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
  page.on('pageerror', (err) => console.error(`[page exception] ${err.message}`));
  page.on('console', (m) => m.type() === 'error' && console.error(`[page error] ${m.text()}`));
  await page.goto(`${url}/tools/harness.html`);
  const info = await page.evaluate(() => window.__ready);
  if (params || seed !== null) await page.evaluate((cfg) => window.__configure(cfg), { params, seed });
  return { page, info };
}

async function main() {
  const ffmpeg = framesDir ? null : findFfmpeg();
  if (!framesDir && !ffmpeg) {
    console.error('ffmpeg not found. Install it (or set FFMPEG_PATH), or pass --frames-dir <dir> to write PNG frames.');
    process.exit(1);
  }

  const server = await startServer({ port: 0 });
  const browser = await chromium.launch({
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
  });
  const pages = [];
  for (let i = 0; i < workers; i++) pages.push(await openPage(browser, server.url));
  const { info } = pages[0];

  const from = Number(arg('from', 0));
  const to = Math.min(Number(arg('to', info.duration)), info.duration);
  const total = Math.max(1, Math.round((to - from) * fps));
  const type = framesDir ? 'image/png' : 'image/jpeg';
  console.log(`Rendering ${total} frames (${(to - from).toFixed(2)} s) at ${width}×${height}, ${fps} fps` +
    `${motionBlur > 1 ? `, motion blur ×${motionBlur}` : ''}, ${workers} worker(s)`);
  if (!info.webgl) console.warn('Warning: WebGL unavailable; WebGL scenes will use their 2D fallback.');

  let encoder = null;
  let encoderDone = null;
  if (framesDir) fs.mkdirSync(framesDir, { recursive: true });
  else {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    encoder = spawn(ffmpeg, [
      '-y', '-loglevel', 'error',
      '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', String(fps), '-i', '-',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart', out,
    ], { stdio: ['pipe', 'inherit', 'inherit'] });
    encoderDone = new Promise((resolve, reject) => {
      encoder.on('error', reject);
      encoder.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with ${code}`))));
    });
  }

  const renderFrame = (page, i) =>
    page.evaluate((o) => window.__frame(o), {
      t: from + i / fps,
      width,
      reel: true,
      motionBlur,
      type,
      quality: 0.97,
    });

  // Workers render ahead in parallel; frames are written strictly in order.
  const pending = new Map();
  let nextToRender = 0;
  const started = Date.now();
  const claim = () => (nextToRender < total ? nextToRender++ : -1);
  const loops = pages.map(async ({ page }) => {
    for (let i = claim(); i >= 0; i = claim()) {
      while (pending.size > workers * 4) await new Promise((r) => setTimeout(r, 5));
      pending.set(i, await renderFrame(page, i));
    }
  });

  for (let i = 0; i < total; i++) {
    while (!pending.has(i)) await new Promise((r) => setTimeout(r, 2));
    const buf = Buffer.from(pending.get(i).split(',')[1], 'base64');
    pending.delete(i);
    if (framesDir) fs.writeFileSync(path.join(framesDir, `frame-${String(i).padStart(5, '0')}.png`), buf);
    else if (!encoder.stdin.write(buf)) await new Promise((r) => encoder.stdin.once('drain', r));
    if ((i + 1) % fps === 0 || i === total - 1) {
      const elapsed = (Date.now() - started) / 1000;
      const eta = (elapsed / (i + 1)) * (total - i - 1);
      process.stdout.write(`\r  frame ${i + 1}/${total}  ${elapsed.toFixed(0)} s elapsed, ~${eta.toFixed(0)} s left   `);
    }
  }
  await Promise.all(loops);
  process.stdout.write('\n');

  if (encoder) {
    encoder.stdin.end();
    await encoderDone;
    console.log(`Wrote ${path.relative(ROOT, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
    if (gif) {
      const gifWidth = Number(arg('gif-width', 640));
      const gifFps = Number(arg('gif-fps', 15));
      const filter = `fps=${gifFps},scale=${gifWidth}:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff:max_colors=200[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
      const r = spawnSync(ffmpeg, ['-y', '-loglevel', 'error', '-i', out, '-vf', filter, gif], { stdio: 'inherit' });
      if (r.status !== 0) throw new Error('GIF conversion failed');
      console.log(`Wrote ${path.relative(ROOT, gif)} (${(fs.statSync(gif).size / 1e6).toFixed(1)} MB)`);
    }
  } else {
    console.log(`Wrote ${total} PNG frames to ${path.relative(ROOT, framesDir)}`);
  }

  await browser.close();
  await server.close();
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

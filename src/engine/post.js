// Finishing passes applied over a scene: film grain and vignette.

import { mulberry32, hash } from './random.js';
import { makeCanvas } from './draw.js';

let tiles = null;

function grainTiles() {
  if (tiles) return tiles;
  tiles = [];
  const rnd = mulberry32(0x6a09e667);
  for (let k = 0; k < 4; k++) {
    const c = makeCanvas(256, 256);
    const g = c.getContext('2d');
    const img = g.createImageData(256, 256);
    for (let i = 0; i < 256 * 256; i++) {
      // Two uniforms summed: a softer, roughly bell-shaped grain.
      const v = ((rnd() + rnd()) / 2) * 255;
      img.data[i * 4] = v;
      img.data[i * 4 + 1] = v;
      img.data[i * 4 + 2] = v;
      img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    tiles.push(c);
  }
  return tiles;
}

/** Animated film grain; `amount` around 0.04-0.12 reads as texture, not noise. */
export function grain(ctx, frame, amount, W, H) {
  if (!(amount > 0)) return;
  const all = grainTiles();
  const tile = all[frame % all.length];
  const ox = Math.floor(hash(frame, 11) * 256);
  const oy = Math.floor(hash(frame, 23) * 256);
  ctx.save();
  ctx.globalAlpha = amount;
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = ctx.createPattern(tile, 'repeat');
  ctx.translate(-ox, -oy);
  ctx.fillRect(ox, oy, W, H);
  ctx.restore();
}

/** Darken the frame edges. `amount` is the corner opacity (0..1). */
export function vignette(ctx, amount, W, H, color = '0,0,0') {
  if (!(amount > 0)) return;
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, Math.hypot(W, H) / 2);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(1, `rgba(${color},${amount})`);
  ctx.save();
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

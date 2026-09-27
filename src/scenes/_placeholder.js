// Temporary stand-in used until a scene is built out.
import { font, seg, ease } from '../engine/index.js';

export function placeholder(ctx, s, title, color) {
  ctx.fillStyle = '#101218';
  ctx.fillRect(0, 0, s.W, s.H);
  ctx.fillStyle = color;
  ctx.fillRect(0, s.H - 24, s.W * s.p, 24);
  const k = ease.outBack(seg(s.t, 0.1, 0.8));
  ctx.save();
  ctx.translate(s.W / 2, s.H / 2);
  ctx.scale(k, k);
  ctx.fillStyle = '#EFEBE3';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font(110, 'display', 800);
  ctx.fillText(title, 0, -30);
  ctx.font = font(34, 'mono', 400);
  ctx.fillStyle = color;
  ctx.fillText(`placeholder · t = ${s.t.toFixed(2)} s`, 0, 90);
  ctx.restore();
}

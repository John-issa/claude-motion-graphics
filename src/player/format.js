// Formatting helpers for timecode and readouts. Pure functions, no DOM.

/** Zero-padded integer (floors first): pad(7) → "07", pad(42, 5) → "00042". */
export const pad = (n, width = 2) => String(Math.max(0, Math.floor(n))).padStart(width, '0');

/**
 * The frame number for time t, clamped to the reel's last frame. Rounds like
 * the engine does for `s.frame`, so the chrome agrees with any timecode a
 * scene draws into the picture.
 */
export function frameAt(t, fps, frames) {
  const f = Math.round(t * fps);
  return Math.max(0, Math.min(frames - 1, f));
}

/** SMPTE non-drop timecode HH:MM:SS:FF for a frame number. */
export function timecode(frame, fps) {
  const f = Math.max(0, Math.floor(frame));
  const total = Math.floor(f / fps);
  return `${pad(total / 3600)}:${pad((total % 3600) / 60)}:${pad(total % 60)}:${pad(f % fps)}`;
}

/** Seconds with fixed decimals and a two-digit integer part: 2.345 → "02.35". */
export function secs(t, digits = 2) {
  const [whole, frac] = Math.max(0, t).toFixed(digits).split('.');
  return frac ? `${whole.padStart(2, '0')}.${frac}` : whole.padStart(2, '0');
}

/** Minutes and seconds: 75.4 → "01:15". */
export function mmss(t) {
  const s = Math.max(0, Math.floor(t));
  return `${pad(s / 60)}:${pad(s % 60)}`;
}

/** Ruler label for a whole second: 5 → "0:05", 70 → "1:10". */
export function rulerLabel(s) {
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** Short decimal without trailing zeros: 0.8 → "0.8", 47 → "47", 46.1 → "46.1". */
export function short(x, digits = 1) {
  return String(Number(x.toFixed(digits)));
}

// Per-viewer preferences (title, seed, quality) in localStorage.
// Storage can be missing or throw (private windows, sandboxed frames), so every
// access is guarded and the player works the same without it.

const KEY = 'claude-motion-reel';

export function loadPrefs() {
  try {
    const raw = window.localStorage.getItem(KEY);
    const value = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function savePrefs(patch) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    // Storage unavailable: preferences simply won't persist.
  }
}

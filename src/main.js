// Entry point for the player page (index.html).
// scripts/build.mjs bundles this to an IIFE, so there is no top-level await:
// startup lives in main(). window.__BUILD__ = { target: 'artifact' | 'standalone' }
// is set by the build; in development it is undefined and the target is 'dev'.

import scenes from './scenes/index.js';
import { createReel } from './engine/index.js';
import { createPlayer, cleanTitle } from './player/player.js';
import { loadPrefs } from './player/storage.js';

/**
 * A title from the link's #anchor, e.g. …#HELLO_WORLD → "HELLO WORLD". Artifact
 * links pass only plain anchors (letters, digits, . _ ~ -), so underscores
 * stand in for spaces. Returns '' when there is no usable anchor.
 */
function titleFromHash() {
  let raw = '';
  try {
    raw = decodeURIComponent((window.location.hash || '').slice(1));
  } catch {
    return '';
  }
  if (!/^[A-Za-z0-9._~-]{1,24}$/.test(raw)) return '';
  return cleanTitle(raw.replace(/_/g, ' '));
}

function buildTarget() {
  const build = typeof window !== 'undefined' ? window.__BUILD__ : undefined;
  const target = build && build.target;
  return target === 'artifact' || target === 'standalone' ? target : 'dev';
}

async function main() {
  const target = buildTarget();
  document.documentElement.dataset.target = target;

  // Restore the viewer's title and seed before setup runs, so scenes only set up once.
  const prefs = loadPrefs();
  // A title in the link wins over the one this viewer last typed.
  const title = titleFromHash() || (typeof prefs.title === 'string' ? cleanTitle(prefs.title) : '');
  const seed = Number.isInteger(prefs.seed) && prefs.seed > 0 ? prefs.seed >>> 0 : undefined;

  const reel = createReel({ scenes, fps: 60, params: title ? { title } : {}, seed });
  const player = createPlayer({ reel, target, prefs });
  window.__player = player.api;

  try {
    await reel.init();
  } catch (err) {
    player.fail(err);
    throw err;
  }
  player.start();
}

function boot() {
  main().catch((err) => console.error('[player] startup failed', err));
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

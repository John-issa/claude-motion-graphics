// Entry point for the player page (index.html).
// scripts/build.mjs bundles this to an IIFE, so there is no top-level await:
// startup lives in main(). window.__BUILD__ = { target: 'artifact' | 'standalone' }
// is set by the build; in development it is undefined and the target is 'dev'.

import scenes from './scenes/index.js';
import { createReel } from './engine/index.js';
import { createPlayer } from './player/player.js';
import { loadPrefs } from './player/storage.js';

const TITLE_MAX = 24;

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
  const title = typeof prefs.title === 'string' ? prefs.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX) : '';
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

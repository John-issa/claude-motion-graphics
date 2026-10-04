// Quality gate for every scene in one browser session:
//   - determinism: frames rendered out of order must match pixel for pixel
//   - hygiene: no Math.random / Date.now / performance.now during render
//   - errors: no exceptions or console errors
//   - cost: ms per 1280×720 frame (min / median), as a rough guide
//
//   npm run check
//   npm run check -- --scene particles --samples 24
//
// Exits non-zero when any scene fails the determinism, hygiene or error checks.

import os from 'node:os';
import { openHarness } from './snap.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? def : argv[i + 1];
};

const h = await openHarness({ quiet: true });
const only = arg('scene');
const samples = Number(arg('samples', 12));
const scenes = h.info.scenes.filter((s) => !only || s.id === only);
const rows = [];
let failed = false;

for (const s of scenes) {
  const before = h.errors.length;
  const audit = await h.page.evaluate((o) => window.__audit(o), { scene: s.id, samples });
  const bench = await h.page.evaluate((o) => window.__bench(o), { scene: s.id, width: 1280, frames: 30 });
  const forbidden = audit.forbiddenCalls.random + audit.forbiddenCalls.dateNow + audit.forbiddenCalls.perfNow;
  const errors = h.errors.length - before;
  const ok = audit.deterministic && forbidden === 0 && errors === 0;
  if (!ok) failed = true;
  rows.push({
    scene: s.id,
    seconds: s.duration.toFixed(1),
    deterministic: audit.deterministic ? 'yes' : `NO (${audit.mismatchedTimes.join(', ')})`,
    forbidden: forbidden === 0 ? 'none' : JSON.stringify(audit.forbiddenCalls),
    errors,
    'ms min': bench.min.toFixed(1),
    'ms median': bench.median.toFixed(1),
    status: ok ? 'pass' : 'FAIL',
  });
}

console.table(rows);
const load = os.loadavg()[0];
if (load > os.cpus().length * 0.5) console.log(`Note: machine load ${load.toFixed(1)}; frame times read high.`);
console.log(`WebGL: ${h.info.webgl ? 'available' : 'unavailable (2D fallbacks used)'}`);
await h.close();
if (failed) {
  console.error('Some scenes failed the checks.');
  process.exitCode = 1;
}

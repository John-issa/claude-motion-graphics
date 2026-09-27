// Screenshot a page from this repo in headless Chromium.
//   node scripts/shot.mjs --path / --width 1440 --height 900 --out .snaps/page.png [--wait 1200] [--full]
//   node scripts/shot.mjs --file dist/index.html --width 390 --height 844 --out .snaps/phone.png
// --eval "<js>" runs in the page before the screenshot (after --wait).
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { startServer, ROOT } from './serve.mjs';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? true : v;
};

const server = arg('file') ? null : await startServer({ port: 0 });
const url = arg('file') ? pathToFileURL(path.resolve(ROOT, arg('file'))).href : `${server.url}${arg('path', '/')}`;
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({
  viewport: { width: Number(arg('width', 1440)), height: Number(arg('height', 900)) },
  deviceScaleFactor: Number(arg('dpr', 1)),
  reducedMotion: arg('reduced-motion') ? 'reduce' : 'no-preference',
});
let errors = 0;
page.on('console', (m) => {
  if (m.type() === 'error') errors++;
  if (m.type() === 'error' || m.type() === 'warning') console.error(`[page ${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => {
  errors++;
  console.error(`[page exception] ${e.message}`);
});
await page.goto(url);
await page.waitForTimeout(Number(arg('wait', 1200)));
if (arg('eval')) console.log(JSON.stringify(await page.evaluate(arg('eval'))));
const out = arg('out', path.join(ROOT, '.snaps', 'page.png'));
await page.screenshot({ path: out, fullPage: !!arg('full') });
console.log(out);
await browser.close();
if (server) await server.close();
if (errors) process.exitCode = 1;

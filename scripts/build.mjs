// Build the player into self-contained HTML files (no network requests at all):
//   dist/index.html     a complete standalone page; open it straight from disk
//   dist/artifact.html  the same page as a body fragment for claude.ai Artifacts
//                       (the host supplies <!doctype>, <head> and <body>)
// Fonts are inlined as data URIs, CSS is inlined, and src/main.js is bundled
// with esbuild into one classic script.

import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { ROOT } from './serve.mjs';

const DIST = path.join(ROOT, 'dist');
const FONT_TYPES = { '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };

/** Read a stylesheet and inline its url(...) references as data URIs. */
function inlineCss(file) {
  const dir = path.dirname(file);
  return fs.readFileSync(file, 'utf8').replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (match, _q, ref) => {
    if (/^(data:|https?:|#)/.test(ref)) return match;
    const abs = path.resolve(dir, ref);
    const type = FONT_TYPES[path.extname(abs).toLowerCase()];
    if (!type || !fs.existsSync(abs)) return match;
    return `url("data:${type};base64,${fs.readFileSync(abs).toString('base64')}")`;
  });
}

// Keep inlined code from closing its own tag early.
const safeScript = (js) => js.replace(/<\/(script)/gi, '<\\/$1');
const safeStyle = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

async function bundle(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    target: ['chrome100', 'firefox100', 'safari15.4'],
    legalComments: 'none',
    logLevel: 'warning',
  });
  return result.outputFiles[0].text;
}

async function main() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

  const styles = [];
  const withoutLinks = html.replace(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi, (tag) => {
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href || /^https?:/.test(href)) throw new Error(`External stylesheet not allowed: ${tag}`);
    styles.push(safeStyle(inlineCss(path.resolve(ROOT, href))));
    return '';
  });

  const scriptTag = /<script\b[^>]*type=["']module["'][^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/i;
  const entry = scriptTag.exec(withoutLinks)?.[1];
  if (!entry) throw new Error('index.html needs <script type="module" src="..."></script>');
  const js = safeScript(await bundle(path.resolve(ROOT, entry)));

  const styleBlock = `<style>\n${styles.join('\n')}\n</style>`;
  const scriptBlock = (target) => `<script>window.__BUILD__ = { target: ${JSON.stringify(target)} };</script>\n<script>${js}</script>`;

  // Standalone page: the original document with everything inlined.
  const standalone = withoutLinks
    .replace(/<\/head>/i, () => `${styleBlock}\n</head>`)
    .replace(scriptTag, () => scriptBlock('standalone'));

  // Artifact fragment: title first (the host scans the first 8 KB for it),
  // then styles, the body's markup, and the script.
  const title = /<title>[\s\S]*?<\/title>/i.exec(html)?.[0] ?? '<title>Claude Motion Reel</title>';
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(withoutLinks)?.[1] ?? '';
  const artifact = [title, styleBlock, body.replace(scriptTag, '').trim(), scriptBlock('artifact')].join('\n');

  fs.mkdirSync(DIST, { recursive: true });
  fs.writeFileSync(path.join(DIST, 'index.html'), standalone);
  fs.writeFileSync(path.join(DIST, 'artifact.html'), artifact);

  const kb = (s) => `${(Buffer.byteLength(s) / 1024).toFixed(0)} KB`;
  console.log(`dist/index.html     ${kb(standalone)}  (JS ${kb(js)}, CSS ${kb(styleBlock)})`);
  console.log(`dist/artifact.html  ${kb(artifact)}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

#!/usr/bin/env node
'use strict';
/*
 * Assemble the single-file deliverable mdviewer.html from src/ + vendor/.
 * Dev-time only: the produced mdviewer.html needs no build to be USED — just
 * open it in a Chromium browser. Run: node tools/build.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const r = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const parts = {
  'hljs-css': r('vendor/highlight-github-dark.css'),
  'app-css': r('src/app.css'),
  marked: r('vendor/marked.min.js'),
  purify: r('vendor/purify.min.js'),
  hljs: r('vendor/highlight.min.js'),
  core: r('src/mdcore.js'),
  ui: r('src/mdapp.js'),
};

let html = r('src/template.html');
for (const [key, val] of Object.entries(parts)) {
  if (/<\/script\s*>/i.test(val) && key !== 'app-css' && key !== 'hljs-css') {
    throw new Error(`Refusing to inline ${key}: contains a literal </script>`);
  }
  const marker = `/*BUILD:${key}*/`;
  if (!html.includes(marker)) throw new Error(`Template missing placeholder ${marker}`);
  // Use a function replacer so $-sequences in minified libs are not treated
  // as replacement patterns.
  html = html.replace(marker, () => val);
}

const out = path.join(ROOT, 'mdviewer.html');
fs.writeFileSync(out, html);
const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`Wrote mdviewer.html (${kb} KB)`);

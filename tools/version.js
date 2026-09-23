#!/usr/bin/env node
'use strict';
/*
 * Derive the app version from git, so every build names the commit it came
 * from. The nearest tag of the form v<major>.<minor>.<patch> supplies the
 * first two numbers; the tag's patch plus the number of commits since the tag
 * is the third. The short commit hash is the build number, suffixed "-dirty"
 * when the working tree has uncommitted changes.
 *
 *   v1.0.0 tag, 9 commits later, at 56a2db3  ->  version 1.0.9, build 56a2db3
 *
 * Usage: node tools/version.js            prints the version   (1.0.9)
 *        node tools/version.js --build    prints the build     (56a2db3)
 *        node tools/version.js --label    prints both          (1.0.9 (56a2db3))
 *        node tools/version.js --json     prints all fields
 * Outside a git checkout the version falls back to electron/package.json and
 * the build to "unknown".
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DESCRIBE_RE = /^v(\d+)\.(\d+)\.(\d+)-(\d+)-g([0-9a-f]+)(-dirty)?$/;

// Turn one `git describe --tags --long --dirty` line into the version fields.
function parseDescribe(text) {
  const m = String(text).trim().match(DESCRIBE_RE);
  if (!m) throw new Error('unexpected git describe output: ' + JSON.stringify(text));
  const patch = parseInt(m[3], 10) + parseInt(m[4], 10);
  const version = m[1] + '.' + m[2] + '.' + patch;
  const build = m[5] + (m[6] ? '-dirty' : '');
  return { version: version, build: build, dirty: !!m[6], label: version + ' (' + build + ')' };
}

function fallback() {
  let version = '0.0.0';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8')).version; }
  catch (e) { /* keep 0.0.0 */ }
  return { version: version, build: 'unknown', dirty: false, label: version + ' (unknown)' };
}

function describeVersion() {
  let out;
  try {
    out = execSync('git describe --tags --long --dirty --match "v[0-9]*"',
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return fallback();
  }
  return parseDescribe(out);
}

module.exports = { describeVersion, parseDescribe };

if (require.main === module) {
  const v = describeVersion();
  const arg = process.argv[2] || '';
  if (arg === '--json') console.log(JSON.stringify(v));
  else if (arg === '--build') console.log(v.build);
  else if (arg === '--label') console.log(v.label);
  else console.log(v.version);
}

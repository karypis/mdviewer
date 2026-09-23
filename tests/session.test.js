'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeWindow, readSession, writeSession, pruneMissing } = require('../electron/session');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mdviewer-session-')), 'session.json');
}

test('normalizeWindow keeps absolute paths, floors scroll offsets, and clamps active', () => {
  assert.deepEqual(normalizeWindow({ tabs: ['/a.md', { path: '/b.md', scrollTop: 12.7 }, { path: 'rel.md' }, null], active: 9 }),
    { tabs: [{ path: '/a.md', scrollTop: 0 }, { path: '/b.md', scrollTop: 12 }], active: 1 });
  assert.equal(normalizeWindow({ tabs: [{ path: '/a.md', scrollTop: -5 }], active: -1 }).active, 0);
  assert.equal(normalizeWindow({ tabs: [] }), null);
  assert.equal(normalizeWindow({ tabs: ['nope'] }), null);
  assert.equal(normalizeWindow(null), null);
});

test('readSession returns [] for a missing or malformed file', () => {
  const file = tmpFile();
  assert.deepEqual(readSession(file), []);
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(readSession(file), []);
  fs.writeFileSync(file, JSON.stringify({ version: 1, windows: 'x' }));
  assert.deepEqual(readSession(file), []);
});

test('writeSession round-trips windows and leaves no temp file behind', () => {
  const file = tmpFile();
  const written = writeSession(file, [
    { tabs: [{ path: '/docs/a.md', scrollTop: 300 }, { path: '/docs/b.md', scrollTop: 0 }], active: 1 },
    { tabs: [] },
    { tabs: [{ path: '/docs/c.md' }], active: 0 },
  ]);
  assert.equal(written.length, 2);
  assert.deepEqual(readSession(file), written);
  assert.equal(readSession(file)[0].active, 1);
  assert.ok(!fs.existsSync(file + '.tmp'));
  writeSession(file, []);
  assert.deepEqual(readSession(file), []);
});

test('pruneMissing drops vanished files, follows the active tab, and drops empty windows', () => {
  const windows = [
    { tabs: [{ path: '/gone.md', scrollTop: 0 }, { path: '/keep.md', scrollTop: 40 }, { path: '/also.md', scrollTop: 0 }], active: 1 },
    { tabs: [{ path: '/a.md', scrollTop: 0 }, { path: '/gone2.md', scrollTop: 0 }], active: 1 },
    { tabs: [{ path: '/gone3.md', scrollTop: 0 }], active: 0 },
  ];
  const exists = (p) => !/gone/.test(p);
  assert.deepEqual(pruneMissing(windows, exists), [
    { tabs: [{ path: '/keep.md', scrollTop: 40 }, { path: '/also.md', scrollTop: 0 }], active: 0 },
    { tabs: [{ path: '/a.md', scrollTop: 0 }], active: 0 },
  ]);
});

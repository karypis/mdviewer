'use strict';

// Session persistence for the desktop app. The renderer reports the tabs open in
// each window; main writes them to <userData>/session.json after every change,
// so a killed process (crash, force quit, kill -9) restores its windows and tabs
// on the next launch. The file holds absolute paths only; documents are re-read
// from disk on restore, never cached here.
//
// File shape: { version: 1, windows: [ { tabs: [ { path, scrollTop } ], active } ] }

const fs = require('node:fs');
const path = require('node:path');

// Coerce one window entry into { tabs, active } or null when nothing usable
// remains. Accepts bare path strings for tabs. `active` is clamped into range.
function normalizeWindow(entry) {
  if (!entry || !Array.isArray(entry.tabs)) return null;
  const tabs = [];
  for (const t of entry.tabs) {
    const tab = typeof t === 'string' ? { path: t, scrollTop: 0 } : t;
    if (!tab || typeof tab.path !== 'string' || !path.isAbsolute(tab.path)) continue;
    const top = Number(tab.scrollTop);
    tabs.push({ path: tab.path, scrollTop: Number.isFinite(top) && top > 0 ? Math.floor(top) : 0 });
  }
  if (!tabs.length) return null;
  let active = Number.isInteger(entry.active) ? entry.active : 0;
  if (active < 0 || active >= tabs.length) active = tabs.length - 1;
  return { tabs, active };
}

// Read the saved windows. A missing, unreadable, or malformed file yields [].
function readSession(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return []; }
  const list = parsed && Array.isArray(parsed.windows) ? parsed.windows : [];
  return list.map(normalizeWindow).filter(Boolean);
}

// Write the windows atomically (temp file plus rename) so a kill mid-write
// never leaves a truncated session behind. Returns the normalized list.
function writeSession(file, windows) {
  const list = (Array.isArray(windows) ? windows : []).map(normalizeWindow).filter(Boolean);
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, windows: list }, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return list;
}

// Drop tabs whose files no longer exist, keeping the active tab's identity when
// it survives. Windows left with no tabs are dropped.
function pruneMissing(windows, exists) {
  const out = [];
  for (const w of windows) {
    const activePath = w.tabs[w.active] ? w.tabs[w.active].path : null;
    const tabs = w.tabs.filter((t) => exists(t.path));
    if (!tabs.length) continue;
    let active = tabs.findIndex((t) => t.path === activePath);
    if (active < 0) active = Math.min(w.active, tabs.length - 1);
    out.push({ tabs, active });
  }
  return out;
}

module.exports = { normalizeWindow, readSession, writeSession, pruneMissing };

'use strict';

// Kill-and-relaunch test for session restore. Runs the desktop app twice with a
// temporary user-data directory. The first run opens three documents, scrolls
// the first one, and is killed with SIGKILL. The second run must bring the tabs
// back (minus one file deleted between runs) at the same scroll offset and with
// the same active tab; closing a tab must then update session.json. The
// renderer is driven over the DevTools protocol, so the same test runs against
// the source tree and against a packaged bundle:
//
//   node tools/electron-sessiontest.js
//   MDVIEWER_APP=/Applications/mdviewer.app/Contents/MacOS/mdviewer node tools/electron-sessiontest.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');

const electronDir = path.join(__dirname, '..', 'electron');
const packaged = process.env.MDVIEWER_APP || '';
const bin = packaged || path.join(electronDir, 'node_modules', '.bin', 'electron');
const baseArgs = packaged ? [] : [electronDir];

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdviewer-sessiontest-'));
const userData = path.join(root, 'user-data');
const sessionFile = path.join(userData, 'session.json');
const docs = ['a.md', 'b.md', 'c.md'].map((n) => path.join(root, n));
fs.writeFileSync(docs[0], '# Alpha\n\n' + Array.from({ length: 80 }, (_, i) => 'Paragraph ' + i + '.\n\n').join(''));
fs.writeFileSync(docs[1], '# Beta\n');
fs.writeFileSync(docs[2], '# Gamma\n');

let count = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log('PASS ' + name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function launch() {
  const child = spawn(bin, [...baseArgs, '--remote-debugging-port=0'], {
    env: { ...process.env, MDVIEWER_SESSIONTEST: userData },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const port = new Promise((resolve, reject) => {
    let buf = '';
    child.stderr.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error('app exited early (' + code + ')\n' + buf)));
  });
  return { child, port };
}

async function connect(port) {
  let targets = [];
  for (let i = 0; i < 200 && !targets.length; i++) {
    try { targets = (await (await fetch('http://127.0.0.1:' + port + '/json')).json()).filter((t) => t.type === 'page'); }
    catch (_) { await sleep(50); }
  }
  if (!targets.length) throw new Error('no page target on port ' + port);
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } };
  const send = (method, params) => new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const waitFor = async (expr) => {
    for (let i = 0; i < 200; i++) { if (await evaluate(expr)) return true; await sleep(50); }
    throw new Error('Timed out waiting for: ' + expr);
  };
  return { evaluate, waitFor, close: () => ws.close() };
}

async function waitForSession(predicate) {
  for (let i = 0; i < 200; i++) {
    try { const s = JSON.parse(fs.readFileSync(sessionFile, 'utf8')); if (predicate(s)) return s; } catch (_) { /* not yet */ }
    await sleep(50);
  }
  throw new Error('session.json never matched; last: ' + (fs.existsSync(sessionFile) ? fs.readFileSync(sessionFile, 'utf8') : '(missing)'));
}

async function kill(child) {
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGKILL');
  await exited;
}

async function main() {
  // Run 1: open three files, make the first active and scrolled, then die.
  let run = launch();
  let page = await connect(await run.port);
  await page.waitFor('!!window.__mdv && window.__mdv.app.tabs.length === 0');
  for (const d of docs) await page.evaluate('window.__mdv.openElectronPath(' + JSON.stringify(d) + ')');
  await page.waitFor('window.__mdv.app.tabs.length === 3');
  await page.evaluate('window.__mdv.activateTab(0)');
  await page.evaluate('window.__mdv.docwrap().scrollTop = 250; window.__mdv.docwrap().dispatchEvent(new Event("scroll"))');
  const saved = await waitForSession((s) => s.windows.length === 1 && s.windows[0].tabs.length === 3 &&
    s.windows[0].active === 0 && s.windows[0].tabs[0].scrollTop === 250);
  check('session.json records the open tabs, the active tab, and its scroll offset',
    saved.windows[0].tabs.map((t) => t.path).join(',') === docs.join(','));
  page.close();
  await kill(run.child);
  check('the app was killed without a chance to save', !fs.existsSync(sessionFile + '.tmp'));

  // Run 2: one file vanished in between; the rest must come back.
  fs.unlinkSync(docs[2]);
  run = launch();
  page = await connect(await run.port);
  await page.waitFor('!!window.__mdv && window.__mdv.app.tabs.length === 2');
  check('restored tabs keep their order, skipping the deleted file',
    await page.evaluate('window.__mdv.app.tabs.map(t => t.fileName).join(",")') === 'a.md,b.md');
  check('the previously active tab is active again', await page.evaluate('window.__mdv.app.active === 0 && window.__mdv.state.fileName === "a.md"'));
  await page.waitFor('window.__mdv.docwrap().scrollTop >= 200');
  check('the active tab is back at its saved scroll offset', await page.evaluate('window.__mdv.docwrap().scrollTop === 250'));
  check('the restored document rendered from disk', await page.evaluate('document.querySelector("#doc h1").textContent === "Alpha"'));
  await page.evaluate('window.__mdv.closeTab(1)');
  await waitForSession((s) => s.windows.length === 1 && s.windows[0].tabs.length === 1);
  check('closing a tab rewrites session.json', true);
  check('only one window was created for the restore', (await (await fetch('http://127.0.0.1:' + await run.port + '/json')).json()).filter((t) => t.type === 'page').length === 1);
  page.close();
  await kill(run.child);
  console.log('SESSIONTEST OK (' + count + ' checks)');
  fs.rmSync(root, { recursive: true, force: true });
}

main().catch((e) => { console.error('SESSIONTEST FAIL:', e); console.error('Fixtures:', root); process.exit(1); });

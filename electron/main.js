// mdviewer Electron main process.
// Loads the single-file web app (mdviewer.html), wires Finder "Open With" and a
// File menu, and routes file I/O through the preload fs bridge. Also contains
// two headless test runners (selftest / e2e) used to verify the bundle.
const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PDFDocument, rgb } = require('pdf-lib');
const { resolveLink } = require('./links');
const { readSession, writeSession, pruneMissing } = require('./session');

// Stamp an opaque white rectangle UNDER every page so the page margins are
// white in every PDF renderer (printToPDF leaves them transparent, which some
// viewers — e.g. Acrobat / dark mode — show as dark). Keeps text selectable
// (the original page is embedded as a vector form, not rasterized).
async function withWhiteBackground(pdfBytes) {
  const src = await PDFDocument.load(pdfBytes);
  const out = await PDFDocument.create();
  const embedded = await out.embedPages(src.getPages());
  for (const emb of embedded) {
    const { width, height } = emb;
    const page = out.addPage([width, height]);
    page.drawRectangle({ x: 0, y: 0, width, height, color: rgb(1, 1, 1) });
    page.drawPage(emb, { x: 0, y: 0, width, height });
  }
  return Buffer.from(await out.save());
}

const HTML = path.join(__dirname, 'mdviewer.html');
// Page margins come from the CSS @page rule (app.css: 0.5in). printToPDF honors
// @page when no margins option is given. The window backgroundColor must be
// white (below) or it shows through the @page margin area.
const PDF_OPTS = { printBackground: true, pageSize: 'Letter' };
// SELFTEST / E2E / LIFECYCLE run hidden; VERIFY and PDFTEST show a real window
// (printToPDF margins/layout match the real visible app only when shown).
const HEADLESS = !!(process.env.MDVIEWER_SELFTEST || process.env.MDVIEWER_E2E ||
  process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST || process.env.MDVIEWER_LINKTEST ||
  process.env.MDVIEWER_SESSIONTEST);
// Session persistence (see session.js) is off under every test runner, so a
// test run never rewrites the user's saved windows. MDVIEWER_SESSIONTEST=<dir>
// is the exception: it turns persistence on with that directory as userData.
const TESTING = HEADLESS || !!(process.env.MDVIEWER_VERIFY || process.env.MDVIEWER_PDFTEST);
const SESSION_DIR = process.env.MDVIEWER_SESSIONTEST || '';
const SESSIONS_ON = !TESTING || !!SESSION_DIR;
if (SESSION_DIR) app.setPath('userData', path.resolve(SESSION_DIR));

// `win` is the most-recently created/focused window: the test runners and the
// cold-start path use it. `windows` tracks every open window for multi-window
// support (tab tear-off). Per-window readiness and a queued path live on the
// BrowserWindow instance as _ready / _pendingPath.
let win = null;
const windows = new Set();
let pendingPath = null;      // cold-start path (argv/env/Finder-before-ready), consumed once
let lifecycleStarted = false;
let quitting = false;        // set by before-quit so closing windows keep their session

// ---- session persistence ----------------------------------------------
// Each live window's latest tab report, in creation order. Written (debounced)
// to session.json after every change; read back once at cold start.
const sessions = new Map();
let sessionWriteTimer = null;
function sessionFile() { return path.join(app.getPath('userData'), 'session.json'); }
function writeSessionNow() {
  clearTimeout(sessionWriteTimer); sessionWriteTimer = null;
  if (!SESSIONS_ON) return;
  try { writeSession(sessionFile(), Array.from(sessions.values())); }
  catch (e) { console.error('session write failed: ' + e.message); }
}
function scheduleSessionWrite() {
  if (!SESSIONS_ON) return;
  clearTimeout(sessionWriteTimer);
  sessionWriteTimer = setTimeout(writeSessionNow, 150);
}
app.on('before-quit', () => { quitting = true; writeSessionNow(); });

function windowAlive(w) { w = w || win; return w && !w.isDestroyed(); }
function targetWindow() { return BrowserWindow.getFocusedWindow() || win; }

// Finder "Open With" on macOS arrives as an open-file event (can fire before
// the app is ready, or later while it is already running). While running, the
// file opens as a new tab in the focused window.
app.on('open-file', (e, p) => {
  e.preventDefault();
  const rp = path.resolve(p);
  if (!app.isReady()) { pendingPath = rp; return; }
  const w = targetWindow();
  if (windowAlive(w)) {
    if (w._ready) w.webContents.send('open-path', rp); else w._pendingPath = rp;
    if (w.isMinimized()) w.restore();
    w.focus();
  } else {
    createWindow(rp);
  }
});

// A markdown path passed on the command line (cold start) or via the e2e env.
// `testFile` is the stable env-derived path for the test runners; `pendingPath`
// is the mutable delivery slot the renderer-ready handler consumes.
let testFile = null;
(function seedPendingPath() {
  const envFile = process.env.MDVIEWER_E2E || process.env.MDVIEWER_VERIFY ||
    process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST || process.env.MDVIEWER_LINKTEST;
  if (envFile && fs.existsSync(envFile)) { pendingPath = path.resolve(envFile); testFile = pendingPath; return; }
  for (const a of process.argv.slice(1)) {
    if (/\.(md|markdown|txt)$/i.test(a) && fs.existsSync(a)) { pendingPath = path.resolve(a); break; }
  }
})();

// Route the cold-start pending path to a live window, or open a new one. Used by
// the lifecycle test's open-after-close case. Never touches a destroyed window.
function deliverPendingPath() {
  if (!pendingPath) return;
  if (windowAlive()) {
    if (win._ready) win.webContents.send('open-path', pendingPath);
    else win._pendingPath = pendingPath;
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    const p = pendingPath; pendingPath = null;
    createWindow(p); // the new window opens exactly this file
  }
}

// A window announces it is wired. Deliver its queued path, or the one-time
// cold-start path (consumed by the first window to become ready).
ipcMain.on('renderer-ready', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender) || win;
  if (!w) return;
  w._ready = true;
  // A restored window gets its saved tabs first; a file handed in at launch
  // then opens on top of them (the renderer serializes the two).
  const s = w._pendingSession; w._pendingSession = null;
  if (s) w.webContents.send('restore-session', s);
  let p = w._pendingPath; w._pendingPath = null;
  if (!p && pendingPath) { p = pendingPath; pendingPath = null; }
  if (p) w.webContents.send('open-path', p);
});

// Tab tear-off: open a file in a brand-new window.
ipcMain.on('open-in-new-window', (_e, p) => { createWindow(path.resolve(p)); });

// The renderer reports its open tabs after every tab change and scroll.
ipcMain.on('session-changed', (e, entry) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !SESSIONS_ON) return;
  if (entry && Array.isArray(entry.tabs) && entry.tabs.length) sessions.set(w, entry);
  else sessions.delete(w);
  scheduleSessionWrite();
});

// Native file I/O on behalf of the (sandboxed) renderer.
ipcMain.handle('read-file', (_e, p) => fs.promises.readFile(p, 'utf8'));
ipcMain.handle('write-file', (_e, p, data) => fs.promises.writeFile(p, data, 'utf8'));

ipcMain.handle('open-link', async (_e, href, documentPath) => {
  const target = resolveLink(href, documentPath);
  if (target.kind === 'external') await shell.openExternal(target.url);
  if (target.kind === 'file') {
    const error = await shell.openPath(target.path);
    if (error) throw new Error(error);
  }
  return target;
});

// Render the current page to a PDF and save it (the @media print stylesheet
// makes it a clean, light, chrome-free document).
ipcMain.handle('export-pdf', async (e, suggestedName) => {
  const w = BrowserWindow.fromWebContents(e.sender) || win;
  if (!windowAlive(w)) return { error: 'no window' };
  try {
    const data = await withWhiteBackground(await w.webContents.printToPDF(PDF_OPTS));
    const r = await dialog.showSaveDialog(w, {
      title: 'Export PDF',
      defaultPath: suggestedName || 'document.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    await fs.promises.writeFile(r.filePath, data);
    return { filePath: r.filePath };
  } catch (e) { return { error: String(e) }; }
});

function buildMenu() {
  const send = (a) => () => { const w = targetWindow(); if (windowAlive(w)) w.webContents.send('menu', a); };
  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
      { type: 'separator' },
      { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: send('open-file') },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: send('open-folder') },
      { type: 'separator' },
      { label: 'Reload from Disk', accelerator: 'CmdOrCtrl+R', click: send('reload-file') },
      { label: 'Move Tab to New Window', accelerator: 'CmdOrCtrl+Shift+N', click: send('move-tab-new-window') },
      { type: 'separator' },
      { label: 'Export as PDF…', accelerator: 'CmdOrCtrl+P', click: send('export-pdf') },
      { type: 'separator' },
      { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
      process.platform === 'darwin'
        ? { label: 'Close Window', accelerator: 'CmdOrCtrl+Shift+W', role: 'close' }
        : { role: 'quit' },
    ],
  };
  const viewMenu = {
    label: 'View',
    submenu: [
      { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+B', click: send('toggle-sidebar') },
      { type: 'separator' },
      { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      { type: 'separator' }, { role: 'togglefullscreen' },
    ],
  };
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push(fileMenu, { role: 'editMenu' }, viewMenu, { role: 'windowMenu' });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function queryFromEnv() {
  if (process.env.MDVIEWER_SELFTEST) return { selftest: '1' };
  if (process.env.MDVIEWER_E2E || process.env.MDVIEWER_VERIFY ||
      process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST || process.env.MDVIEWER_LINKTEST ||
      process.env.MDVIEWER_SESSIONTEST) return { e2e: '1' };
  return {};
}

function createWindow(openPath) {
  // #ffffff leaves the @page margin transparent; the PDF post-process
  // (withWhiteBackground) then stamps an opaque white rectangle under every page
  // so the margin is white in EVERY renderer (Preview, Acrobat, Chrome, ...).
  // Shown on ready-to-show so the dark UI is already painted (no white flash).
  const w = new BrowserWindow({
    width: 1280, height: 860, show: false, backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  w._ready = false;
  w._pendingPath = openPath || null; // a tear-off window opens exactly this file
  win = w;
  windows.add(w);
  // Document links use the bridge. A raw popup would bypass Markdown loading.
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (e) => e.preventDefault());
  w.on('closed', () => {
    windows.delete(w);
    if (win === w) win = windows.values().next().value || null;
    // A window the user closed is gone for good; one closing because the app
    // is quitting (or being killed) must come back next launch.
    if (!quitting) { sessions.delete(w); scheduleSessionWrite(); }
  });
  if (!HEADLESS) w.once('ready-to-show', () => w.show());
  buildMenu();
  w.loadFile(HTML, { query: queryFromEnv() });
  if (process.env.MDVIEWER_SELFTEST) w.webContents.once('did-finish-load', runSelftest);
  if (process.env.MDVIEWER_E2E) w.webContents.once('did-finish-load', runE2E);
  if (process.env.MDVIEWER_VERIFY) w.webContents.once('did-finish-load', runVerify);
  if (process.env.MDVIEWER_LIFECYCLE && !lifecycleStarted) {
    lifecycleStarted = true;
    w.webContents.once('did-finish-load', runLifecycleTest);
  }
  if (process.env.MDVIEWER_PDFTEST) w.webContents.once('did-finish-load', runPdfTest);
  return w;
}

// Render the open file to a PDF (no dialog) and check it is a real, non-trivial
// PDF. Exercises printToPDF on the actual document with the print stylesheet.
async function runPdfTest() {
  const loaded = await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  if (!loaded) { console.log('PDFTEST FAIL: file did not load'); return app.exit(1); }
  try {
    const data = await withWhiteBackground(await win.webContents.printToPDF(PDF_OPTS));
    const out = process.env.MDVIEWER_PDFOUT || path.join(os.tmpdir(), 'mdv_pdftest.pdf');
    fs.writeFileSync(out, data);
    const head = data.slice(0, 5).toString('latin1');
    const ok = head === '%PDF-' && data.length > 2000;
    console.log('PDFTEST ' + (ok ? 'PASS' : 'FAIL') +
      ' (header=' + head + ', bytes=' + data.length + ', path=' + out + ')');
    app.exit(ok ? 0 : 1);
  } catch (e) { console.log('PDFTEST FAIL: ' + e); app.exit(1); }
}

// Reproduce the "open a file after the window was closed" crash: load a file,
// destroy the window (app stays alive on macOS), then deliver another open —
// which must spin up a fresh window instead of touching the destroyed one.
async function runLifecycleTest() {
  const file = testFile;
  await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  win.destroy(); // 'closed' handler removes it from the window set and nulls win
  let threw = null;
  try { pendingPath = file; deliverPendingPath(); }
  catch (e) { threw = e; }
  if (threw) { console.log('LIFECYCLE FAIL: open-after-close threw: ' + threw.message); return app.exit(1); }
  const reopened = await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  const ok = windowAlive() && !!reopened;
  console.log('LIFECYCLE ' + (ok ? 'PASS' : 'FAIL') +
    ' (no crash; reopened in a fresh window, file loaded=' + !!reopened + ')');
  app.exit(ok ? 0 : 1);
}

// Open a real file in a real visible window and report what the renderer
// actually produced (read-only; does not modify the file).
async function runVerify() {
  const loaded = await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  if (!loaded) { console.log('VERIFY FAIL: file did not load'); return app.exit(1); }
  const stats = await win.webContents.executeJavaScript(`(() => ({
    filename: window.__mdv.state.fileName,
    blocksRendered: document.querySelectorAll('#doc .block').length,
    commentCards: document.querySelectorAll('.comment-card').length,
    parsedComments: window.__mdv.state.comments.length,
    headingsRendered: document.querySelectorAll('#doc h1,#doc h2,#doc h3').length,
    tableRendered: !!document.querySelector('#doc table'),
    codeHighlighted: !!document.querySelector('#doc pre code.hljs'),
    highlightActive: (typeof Highlight!=='undefined' && CSS.highlights && CSS.highlights.has('gk-span')),
    firstCardText: (document.querySelector('.comment-card .body')||{}).textContent || '',
    windowVisible: true,
  }))()`).catch((e) => ({ error: String(e) }));
  console.log('VERIFY ' + JSON.stringify(stats));
  app.exit(0);
}

// ---- test runners -----------------------------------------------------
async function poll(expr, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (windowAlive()) {
      const v = await win.webContents.executeJavaScript(expr).catch(() => null);
      if (v) return v;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function runSelftest() {
  const out = await poll('(document.getElementById("selftest-out")||{}).textContent', 20000);
  console.log(out || 'NO SELFTEST OUTPUT');
  app.exit(out && /SELFTEST OK/.test(out) ? 0 : 1);
}

// Open a real file (handed in via env), append a marker, autosave through the
// fs bridge, and confirm the bytes hit disk.
async function runE2E() {
  const file = testFile;
  const haveApi = await poll('window.electronAPI ? "1" : ""', 5000);
  if (!haveApi) { console.log('E2E FAIL: bridge missing'); return app.exit(1); }
  if (windowAlive() && file) win.webContents.send('open-path', file); // dedup makes a second open safe
  const loaded = await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  if (!loaded) { console.log('E2E FAIL: file did not load'); return app.exit(1); }
  await win.webContents.executeJavaScript(`(async () => {
    window.__mdv.state.source = window.__mdv.getSource() + "\\nE2E_MARKER_APPENDED\\n";
    await window.__mdv.writeFile();
    return true;
  })()`).catch((e) => console.log('E2E exec error: ' + e));
  await new Promise((r) => setTimeout(r, 400));
  let ok = false, openedName = '';
  try {
    ok = fs.readFileSync(file, 'utf8').includes('E2E_MARKER_APPENDED');
    openedName = await win.webContents.executeJavaScript('window.__mdv.state.fileName');
  } catch (e) { console.log('E2E read error: ' + e); }
  console.log('E2E ' + (ok ? 'PASS' : 'FAIL') +
    ' (opened "' + openedName + '", autosave wrote marker to disk via fs bridge=' + ok + ')');
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => {
  // Cold start: bring back every window saved by the previous run (files that
  // vanished are skipped), else create one empty window. renderer-ready then
  // delivers any pendingPath (a file the app was launched with) to the first
  // window that reports in. A later open-file reuses a live window.
  const saved = SESSIONS_ON ? pruneMissing(readSession(sessionFile()), fs.existsSync) : [];
  if (!saved.length) { createWindow(); return; }
  for (const entry of saved) createWindow()._pendingSession = entry;
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!windowAlive()) createWindow(); });

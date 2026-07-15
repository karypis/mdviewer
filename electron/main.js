// mdviewer Electron main process.
// Loads the single-file web app (mdviewer.html), wires Finder "Open With" and a
// File menu, and routes file I/O through the preload fs bridge. Also contains
// two headless test runners (selftest / e2e) used to verify the bundle.
const { app, BrowserWindow, ipcMain, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { PDFDocument, rgb } = require('pdf-lib');

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
  process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST);

let win = null;
let rendererReady = false;
let pendingPath = null;
let lifecycleStarted = false;

// Finder "Open With" on macOS arrives as an open-file event (can fire before
// the app is ready, or later while it is already running).
app.on('open-file', (e, p) => {
  e.preventDefault();
  pendingPath = path.resolve(p);
  if (app.isReady()) deliverPendingPath();
});

// A markdown path passed on the command line (cold start) or via the e2e env.
(function seedPendingPath() {
  const envFile = process.env.MDVIEWER_E2E || process.env.MDVIEWER_VERIFY ||
    process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST;
  if (envFile && fs.existsSync(envFile)) { pendingPath = path.resolve(envFile); return; }
  for (const a of process.argv.slice(1)) {
    if (/\.(md|markdown|txt)$/i.test(a) && fs.existsSync(a)) { pendingPath = path.resolve(a); break; }
  }
})();

function windowAlive() { return win && !win.isDestroyed(); }

// Route a pending path to a live window (reusing it), or open a new one. Never
// touches a destroyed window.
function deliverPendingPath() {
  if (!pendingPath) return;
  if (windowAlive()) {
    if (rendererReady) win.webContents.send('open-path', pendingPath);
    if (win.isMinimized()) win.restore();
    win.focus();
  } else {
    rendererReady = false;
    createWindow();
  }
}

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  if (pendingPath && windowAlive()) win.webContents.send('open-path', pendingPath);
});

// Native file I/O on behalf of the (sandboxed) renderer.
ipcMain.handle('read-file', (_e, p) => fs.promises.readFile(p, 'utf8'));
ipcMain.handle('write-file', (_e, p, data) => fs.promises.writeFile(p, data, 'utf8'));

// Render the current page to a PDF and save it (the @media print stylesheet
// makes it a clean, light, chrome-free document).
ipcMain.handle('export-pdf', async (_e, suggestedName) => {
  if (!windowAlive()) return { error: 'no window' };
  try {
    const data = await withWhiteBackground(await win.webContents.printToPDF(PDF_OPTS));
    const r = await dialog.showSaveDialog(win, {
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
  const send = (a) => () => windowAlive() && win.webContents.send('menu', a);
  const fileMenu = {
    label: 'File',
    submenu: [
      { label: 'Open File…', accelerator: 'CmdOrCtrl+O', click: send('open-file') },
      { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: send('open-folder') },
      { type: 'separator' },
      { label: 'Reload from Disk', accelerator: 'CmdOrCtrl+R', click: send('reload-file') },
      { type: 'separator' },
      { label: 'Export as PDF…', accelerator: 'CmdOrCtrl+P', click: send('export-pdf') },
      { type: 'separator' },
      process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
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
      process.env.MDVIEWER_LIFECYCLE || process.env.MDVIEWER_PDFTEST) return { e2e: '1' };
  return {};
}

function createWindow() {
  // #ffffff leaves the @page margin transparent; the PDF post-process
  // (withWhiteBackground) then stamps an opaque white rectangle under every page
  // so the margin is white in EVERY renderer (Preview, Acrobat, Chrome, ...).
  // Shown on ready-to-show so the dark UI is already painted (no white flash).
  win = new BrowserWindow({
    width: 1280, height: 860, show: false, backgroundColor: '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.on('closed', () => { win = null; rendererReady = false; });
  if (!HEADLESS) win.once('ready-to-show', () => win.show());
  buildMenu();
  win.loadFile(HTML, { query: queryFromEnv() });
  if (process.env.MDVIEWER_SELFTEST) win.webContents.once('did-finish-load', runSelftest);
  if (process.env.MDVIEWER_E2E) win.webContents.once('did-finish-load', runE2E);
  if (process.env.MDVIEWER_VERIFY) win.webContents.once('did-finish-load', runVerify);
  if (process.env.MDVIEWER_LIFECYCLE && !lifecycleStarted) {
    lifecycleStarted = true;
    win.webContents.once('did-finish-load', runLifecycleTest);
  }
  if (process.env.MDVIEWER_PDFTEST) win.webContents.once('did-finish-load', runPdfTest);
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
  const file = pendingPath;
  await poll('window.__mdv && window.__mdv.getSource() ? "1" : ""', 8000);
  win.destroy(); // 'closed' handler nulls win + rendererReady
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
    filename: document.getElementById('filename').textContent,
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
    const v = await win.webContents.executeJavaScript(expr).catch(() => null);
    if (v) return v;
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
  const file = pendingPath;
  const haveApi = await poll('window.electronAPI ? "1" : ""', 5000);
  if (!haveApi) { console.log('E2E FAIL: bridge missing'); return app.exit(1); }
  if (pendingPath) win.webContents.send('open-path', pendingPath);
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
    openedName = await win.webContents.executeJavaScript('document.getElementById("filename").textContent');
  } catch (e) { console.log('E2E read error: ' + e); }
  console.log('E2E ' + (ok ? 'PASS' : 'FAIL') +
    ' (opened "' + openedName + '", autosave wrote marker to disk via fs bridge=' + ok + ')');
  app.exit(ok ? 0 : 1);
}

app.whenReady().then(() => {
  // Cold start: create the window; renderer-ready will deliver any pendingPath
  // (a file the app was launched with). A later open-file reuses this window.
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!windowAlive()) createWindow(); });

'use strict';

// Drive the actual desktop app and preload bridge using temporary documents.
// Only the OS browser/file launchers are stubbed to avoid opening external apps.
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mdviewer-linktest-'));
const source = path.join(root, 'index', 'README.md');
const target = path.join(root, 'reports', 'linked report.md');
const encodedTarget = path.join(root, 'reports', 'résumé 50% #1.md');
fs.mkdirSync(path.dirname(source));
fs.mkdirSync(path.dirname(target));
const original = '# Index\n\n' +
  '[Report](../reports/linked%20report.md#details)\n\n' +
  '[Missing](missing.md)\n\n' +
  '[Web](https://example.com/report.md)\n\n' +
  '[PDF](../reports/report.pdf)\n\n' +
  '[Encoded](' + pathToFileURL(encodedTarget).href + ')\n';
fs.writeFileSync(source, original);
fs.writeFileSync(target, '# Linked report\n\n[Top](#linked-report)\n\n' +
  Array.from({ length: 35 }, (_, i) => 'Paragraph ' + i + '.\n\n').join('') +
  '## Details\n\nTarget content.\n\n[Again](#details-1)\n\n## Details\n\nSecond section.\n\n' +
  Array.from({ length: 25 }, (_, i) => 'Following paragraph ' + i + '.\n\n').join(''));
fs.writeFileSync(encodedTarget, '# Encoded filename\n');
const external = [], attachments = [];
shell.openExternal = async (url) => { external.push(url); };
shell.openPath = async (p) => { attachments.push(p); return ''; };
process.env.MDVIEWER_LINKTEST = source;
app.setPath('userData', path.join(root, 'user-data'));

let count = 0, created = 0;
const timeout = setTimeout(() => { console.error('LINKTEST FAIL: timeout'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, w) => {
  created++;
  if (created !== 1) return;
  w.webContents.once('did-finish-load', async () => {
    const exec = (code) => w.webContents.executeJavaScript(code, true);
    const waitFor = async (code) => {
      for (let i = 0; i < 100; i++) {
        if (await exec(code)) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('Timed out waiting for: ' + code);
    };
    const check = (name, ok) => { assert.ok(ok, name); count++; console.log('PASS ' + name); };
    const click = (label, modifiers = { metaKey: true }) => exec(`(() => {
      const a = Array.from(document.querySelectorAll('#doc a')).find(a => a.textContent === ${JSON.stringify(label)});
      if (!a) throw new Error('Link missing');
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...${JSON.stringify(modifiers)} });
      a.dispatchEvent(event);
      return event.defaultPrevented;
    })()`);
    try {
      await waitFor('window.__mdv && window.__mdv.state.fileName === "README.md"');
      const initialURL = w.webContents.getURL();
      check('plain click cancels navigation', await click('Report', {}));
      check('plain click edits the containing block', await exec('window.__mdv.state.editing !== null'));
      await exec('document.querySelector("#doc textarea").dispatchEvent(new KeyboardEvent("keydown", {key: "Escape", bubbles: true}))');
      check('Cmd-click cancels native anchor navigation', await click('Report'));
      await waitFor('window.__mdv.state.fileName === "linked report.md"');
      check('relative Markdown renders in a second tab', await exec('window.__mdv.app.tabs.length === 2 && document.querySelector("#doc h1").textContent === "Linked report"'));
      await waitFor('window.__mdv.docwrap().scrollTop > 100');
      check('cross-document fragment scrolls to its heading', await exec('Math.abs(document.getElementById("details").getBoundingClientRect().top - window.__mdv.docwrap().getBoundingClientRect().top) < 200'));
      await click('Top');
      await waitFor('window.__mdv.docwrap().scrollTop < 30');
      check('same-document fragment scrolls without another tab', await exec('window.__mdv.app.tabs.length === 2'));
      check('duplicate headings have distinct fragment IDs', await exec('!!document.getElementById("details-1")'));
      await exec('window.__mdv.activateTab(0)');
      await click('Report', { ctrlKey: true });
      await waitFor('window.__mdv.app.active === 1');
      check('Ctrl-click reuses the existing document tab', await exec('window.__mdv.app.tabs.length === 2'));
      await exec('window.__mdv.activateTab(0)');
      await click('Missing');
      await waitFor('document.getElementById("toast").textContent.includes("Open link failed")');
      check('missing link keeps the source and removes the failed tab', await exec('window.__mdv.app.tabs.length === 2 && window.__mdv.state.fileName === "README.md"'));
      await click('Web');
      await waitFor('window.__mdv.state.fileName === "README.md"');
      for (let i = 0; i < 100 && !external.length; i++) await new Promise(r => setTimeout(r, 10));
      check('web links use the system browser exactly once', external.length === 1 && external[0] === 'https://example.com/report.md');
      await click('PDF');
      for (let i = 0; i < 100 && !attachments.length; i++) await new Promise(r => setTimeout(r, 10));
      check('attachments resolve relative to the document', attachments.length === 1 && attachments[0] === path.join(root, 'reports', 'report.pdf'));
      await click('Encoded');
      await waitFor('window.__mdv.state.fileName === "résumé 50% #1.md"');
      check('encoded file URLs open the correct file', await exec('document.querySelector("#doc h1").textContent === "Encoded filename"'));
      await exec('window.open("about:blank", "_blank") === null');
      await new Promise(r => setTimeout(r, 100));
      check('no blank child windows are created', created === 1 && BrowserWindow.getAllWindows().length === 1);
      check('the viewer page remains loaded', w.webContents.getURL() === initialURL);
      check('reading links leaves the source file unchanged', fs.readFileSync(source, 'utf8') === original);
      check('native File paths are available through preload', await exec('window.electronAPI.getFilePath(new File(["test"], "test.md")) === ""'));
      clearTimeout(timeout);
      console.log('LINKTEST OK (' + count + ' checks)');
      app.exit(0);
    } catch (error) {
      clearTimeout(timeout);
      console.error('LINKTEST FAIL:', error);
      console.error('Fixtures:', root);
      app.exit(1);
    }
  });
});

require('../electron/main');

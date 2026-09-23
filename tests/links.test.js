'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { resolveLink } = require('../electron/links');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = path.resolve('/tmp/mdviewer links/index/README.md');

test('relative Markdown links resolve from the source document directory', () => {
  assert.deepEqual(resolveLink('../reports/summary.md#results', source), {
    kind: 'markdown', path: path.resolve('/tmp/mdviewer links/reports/summary.md'), hash: '#results',
  });
});

test('file URLs preserve encoded spaces, Unicode, percent signs, and hashes', () => {
  const dest = path.resolve('/tmp/mdviewer links/résumé 50% #1.MARKDOWN');
  assert.deepEqual(resolveLink(pathToFileURL(dest).href + '#details', source), {
    kind: 'markdown', path: dest, hash: '#details',
  });
});

test('absolute paths and text files open as documents', () => {
  const dest = path.resolve('/tmp/note.txt');
  assert.equal(resolveLink(dest, source).path, dest);
  assert.equal(resolveLink(dest, source).kind, 'markdown');
});

test('web links stay external even when their paths end in .md', () => {
  for (const url of ['https://example.com/report.md#results', 'http://example.com/', 'mailto:a@example.com', 'tel:+15555550100']) {
    assert.deepEqual(resolveLink(url, source), { kind: 'external', url });
  }
  assert.deepEqual(resolveLink('//example.com/report.md', source), {
    kind: 'external', url: 'https://example.com/report.md',
  });
});

test('local attachments go to the system file opener', () => {
  assert.deepEqual(resolveLink('report.pdf', source), {
    kind: 'file', path: path.resolve('/tmp/mdviewer links/index/report.pdf'), hash: '',
  });
});

test('same-document fragments do not require a file path', () => {
  assert.deepEqual(resolveLink('#results'), { kind: 'anchor', hash: '#results' });
});

test('relative links fail explicitly when the document path is unavailable', () => {
  assert.throws(() => resolveLink('report.md'), /Markdown file path/);
  assert.throws(() => resolveLink('report.md', 'README.md'), /Markdown file path/);
});

test('empty destinations and unsupported schemes are rejected', () => {
  for (const href of ['', '   ', null, 123]) assert.throws(() => resolveLink(href, source), /no destination/);
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', 'about:blank']) {
    assert.throws(() => resolveLink(href, source), /Unsupported link protocol/);
  }
});

function desktopHarness() {
  const handlers = new Map(), external = [], files = [];
  const app = new EventEmitter();
  app.whenReady = () => ({ then() {} });
  class Window extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (handler) => { this.popupHandler = handler; };
    }
    loadFile() {}
  }
  const electron = {
    app, BrowserWindow: Window,
    ipcMain: Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) }),
    Menu: { buildFromTemplate: (template) => template, setApplicationMenu() {} },
    shell: {
      openExternal: async (url) => { external.push(url); },
      openPath: async (p) => { files.push(p); return ''; },
    },
  };
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : name === 'pdf-lib' ? {} :
      name === './links' ? { resolveLink } : name === './session' ? require('../electron/session') : require(name),
    __dirname: path.resolve(__dirname, '../electron'),
    process: { env: {}, argv: [], platform: 'darwin' }, console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8'), context);
  return { context, electron, external, files, open: handlers.get('open-link') };
}

test('desktop bridge returns Markdown paths and routes web links and attachments to the OS', async () => {
  const h = desktopHarness();
  assert.equal((await h.open({}, '../report.md', source)).kind, 'markdown');
  assert.deepEqual(h.external, []);
  assert.deepEqual(h.files, []);
  await h.open({}, 'https://example.com/report.md', source);
  assert.deepEqual(h.external, ['https://example.com/report.md']);
  await h.open({}, 'report.pdf', source);
  assert.deepEqual(h.files, [path.resolve('/tmp/mdviewer links/index/report.pdf')]);
});

test('desktop bridge propagates file opener failures and rejects unsupported protocols', async () => {
  const h = desktopHarness();
  h.electron.shell.openPath = async () => 'File does not exist';
  await assert.rejects(h.open({}, 'missing.pdf', source), /File does not exist/);
  await assert.rejects(h.open({}, 'javascript:alert(1)', source), /Unsupported link protocol/);
  assert.deepEqual(h.external, []);
});

test('desktop windows prevent raw popups and page navigation', () => {
  const h = desktopHarness();
  const w = vm.runInContext('createWindow()', h.context);
  assert.equal(w.popupHandler({ url: 'about:blank' }).action, 'deny');
  let prevented = false;
  w.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } });
  assert.ok(prevented);
});

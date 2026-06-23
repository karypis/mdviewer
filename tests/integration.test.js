'use strict';
// Integration: prove the SHIPPED single-file mdviewer.html is internally
// consistent and that its inlined marked + core actually run.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'mdviewer.html'), 'utf8');

function extractScript(marker) {
  const re = new RegExp('<!--' + marker + '--><script>([\\s\\S]*?)</script>');
  const m = HTML.match(re);
  assert.ok(m, 'missing inlined script for ' + marker);
  return m[1];
}

test('no unfilled BUILD placeholders remain', () => {
  assert.ok(!/\/\*BUILD:[a-z-]+\*\//.test(HTML), 'all placeholders must be inlined');
});

test('required UI anchors are present', () => {
  for (const id of ['toolbar', 'sidebar', 'doc', 'margin', 'composer', 'commentBtn', 'saveState']) {
    assert.ok(HTML.includes('id="' + id + '"'), 'missing #' + id);
  }
});

test('inlined core matches src/mdcore.js (no drift)', () => {
  const core = extractScript('app:core');
  const srcCore = fs.readFileSync(path.join(__dirname, '..', 'src', 'mdcore.js'), 'utf8');
  assert.strictEqual(core, srcCore, 'inlined core must equal source (rebuild needed?)');
});

test('shipped marked + core run end-to-end (offset invariant holds)', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  sandbox.console = console;
  // load the inlined marked exactly as the browser would: its UMD attaches to
  // globalThis.marked (which, in this vm context, is the sandbox itself).
  vm.runInContext(extractScript('lib:marked'), sandbox);
  const markedObj = sandbox.marked;
  assert.ok(markedObj && typeof markedObj.lexer === 'function', 'inlined marked exposes lexer');
  // the inlined core reads globalThis.marked (already set) and exports via module
  sandbox.module = { exports: {} };
  vm.runInContext(extractScript('app:core'), sandbox);
  const MDCore = sandbox.module.exports;
  assert.ok(MDCore && typeof MDCore.lexBlocks === 'function', 'inlined core exposes lexBlocks');

  const src = '# Hi\n\nA para with <!-- GK: note --> inline.\n\n- a\n- b\n';
  const blocks = MDCore.lexBlocks(src);
  assert.strictEqual(blocks.map((b) => b.raw).join(''), src, 'shipped core: raws rebuild source');
  const comments = MDCore.parseComments(src);
  assert.strictEqual(comments.length, 1);
  assert.strictEqual(comments[0].body, 'note');
});

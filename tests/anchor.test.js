'use strict';
// Comment-anchoring tests. The DOM hands us the RENDERED text of a selection;
// locateInsertOffset must place the comment right after that selection's first
// word in the SOURCE, even when the selection touches inline markup. Run:
//   node --test tests/
const { test } = require('node:test');
const assert = require('node:assert');
const MDCore = require('../src/mdcore.js');

// Helper: simulate the app's capture. `sel` is the rendered selection text and
// `prefix` is the rendered text from block start to the selection end.
function insert(blockRaw, sel, prefix) {
  const off = MDCore.locateInsertOffset(blockRaw, 0, prefix, sel);
  assert.notStrictEqual(off, null, 'should locate an offset, not fall back');
  return blockRaw.slice(0, off) + '<!--C-->' + blockRaw.slice(off);
}

test('projectPlain strips inline markup and maps back to source', () => {
  const raw = 'a **bold** and `code` and [lnk](http://x) end';
  const { plain, map } = MDCore.projectPlain(raw);
  assert.strictEqual(plain, 'a bold and code and lnk end');
  // every plain char maps to its exact source character
  for (let i = 0; i < plain.length; i++) {
    assert.strictEqual(raw[map[i]], plain[i], `plain[${i}]='${plain[i]}' maps to source`);
  }
});

test('selection inside bold anchors after the first word, not paragraph end', () => {
  const raw = 'The work produced **three pieces**. The forward converter maps it.\n';
  // user selects the rendered "three pieces"
  const out = insert(raw, 'three pieces', 'The work produced three pieces');
  assert.strictEqual(out, 'The work produced **three<!--C--> pieces**. The forward converter maps it.\n');
});

test('selection starting at an inline-code token anchors correctly', () => {
  const raw = 'nsrunner reads a `.nsr.knowledge` document of declarative criteria.\n';
  const out = insert(raw, '.nsr.knowledge document', 'nsrunner reads a .nsr.knowledge document');
  // comment lands right after the first word (inside the code span is fine)
  assert.ok(out.indexOf('<!--C-->') !== -1);
  assert.ok(/`\.nsr\.knowledge`<!--C--> document/.test(out), 'after the code-span word:\n' + out);
});

test('the bug: markup-bearing selection no longer falls to the last word', () => {
  const raw = 'The **reverse converter** is what makes the forward converter testable.\n';
  const out = insert(raw, 'reverse converter', 'The reverse converter');
  // old behavior put the comment at the very end (after "testable.")
  assert.ok(!/testable\.<!--C-->/.test(out), 'must NOT anchor to the last word');
  assert.ok(/\*\*reverse<!--C--> converter\*\*/.test(out), 'anchors after the first word:\n' + out);
});

test('selection in a heading (block marker present) anchors correctly', () => {
  const raw = '## What was built\n\n';
  const out = insert(raw, 'was built', 'What was built');
  assert.ok(/## What was<!--C--> built/.test(out), out);
});

test('duplicate plain text is disambiguated by the rendered prefix', () => {
  const raw = 'set the **value** here; later reset the value there.\n';
  // select the SECOND "value"
  const out = insert(raw, 'value', 'set the value here; later reset the value');
  assert.ok(/reset the value<!--C--> there/.test(out), 'second occurrence chosen:\n' + out);
});

test('links: selecting the link label anchors after its first word', () => {
  const raw = 'see the [METIS partitioner](http://x) for graphs.\n';
  const out = insert(raw, 'METIS partitioner', 'see the METIS partitioner');
  assert.ok(/\[METIS<!--C--> partitioner\]/.test(out), out);
});

test('falls back to first word when full selection spans markup oddly', () => {
  // selection rendered text "a and b" where source interleaves emphasis
  const raw = 'x _a_ and **b** y\n';
  const off = MDCore.locateInsertOffset(raw, 0, 'x a and b', 'a and b');
  assert.notStrictEqual(off, null);
});

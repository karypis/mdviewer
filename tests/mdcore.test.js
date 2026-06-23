'use strict';
// Core logic tests. Run: node --test tests/
// These exercise src/mdcore.js directly (it is inlined verbatim into the
// shipped mdviewer.html, so testing the source = testing what ships).

const { test } = require('node:test');
const assert = require('node:assert');
const MDCore = require('../src/mdcore.js');

// A corpus that exercises every top-level block type plus GK comments.
const CORPUS = [
  '# Heading one\n\nA plain paragraph.\n',
  '# Title\n\nPara with **bold**, _em_, `code`, and a [link](http://x).\n\n' +
    '- item one\n- item two\n  - nested\n\n' +
    '1. first\n2. second\n\n' +
    '> a blockquote\n> second line\n\n' +
    '| a | b |\n| - | - |\n| 1 | 2 |\n\n' +
    '```js\nconst x = 1;\n```\n\n' +
    '---\n\nFinal paragraph with a <!-- GK: note --> inline comment.\n',
  'Para before.\n\n<!-- GK: a standalone block comment -->\n\nPara after.\n',
  'No trailing newline paragraph',
  '## h2\ntext immediately under\n\n### h3\n\n- a\n- b\n',
];

test('lexBlocks: block raws concatenate exactly to the source', () => {
  for (const src of CORPUS) {
    const blocks = MDCore.lexBlocks(src);
    let rebuilt = '';
    for (const b of blocks) {
      assert.strictEqual(
        src.slice(b.start, b.end),
        b.raw,
        `slice must equal raw for ${b.type} in:\n${src}`
      );
      rebuilt += b.raw;
    }
    assert.strictEqual(rebuilt, src, `concatenation must equal source:\n${src}`);
  }
});

test('lexBlocks: offsets are contiguous and non-overlapping', () => {
  for (const src of CORPUS) {
    const blocks = MDCore.lexBlocks(src);
    let prevEnd = 0;
    for (const b of blocks) {
      assert.strictEqual(b.start, prevEnd, 'each block starts where prior ended');
      assert.ok(b.end >= b.start, 'end >= start');
      prevEnd = b.end;
    }
  }
});

test('blockIndexAt: maps positions to the containing block', () => {
  const src = CORPUS[1];
  const blocks = MDCore.lexBlocks(src);
  // A position in the middle of each block maps back to that block.
  for (let i = 0; i < blocks.length; i++) {
    const mid = Math.floor((blocks[i].start + blocks[i].end) / 2);
    if (mid === blocks[i].start) continue; // skip zero-width edge
    assert.strictEqual(
      MDCore.blockIndexAt(blocks, mid),
      i,
      `mid of block ${i} (${blocks[i].type}) should map to ${i}`
    );
  }
});

test('spliceSource: basic replacement', () => {
  assert.strictEqual(MDCore.spliceSource('hello world', 6, 11, 'there'), 'hello there');
  assert.strictEqual(MDCore.spliceSource('abc', 1, 1, 'X'), 'aXbc'); // insert
  assert.strictEqual(MDCore.spliceSource('abc', 0, 3, ''), ''); // delete all
});

test('replaceRange with identical raw is a no-op (byte-identical)', () => {
  for (const src of CORPUS) {
    const blocks = MDCore.lexBlocks(src);
    for (const b of blocks) {
      const out = MDCore.replaceRange(src, b.start, b.end, b.raw);
      assert.strictEqual(out, src, 'replacing a block with itself must not change bytes');
    }
  }
});

test('editing one block leaves every other block byte-identical', () => {
  const src = CORPUS[1];
  const blocks = MDCore.lexBlocks(src);
  // Find the first paragraph and rewrite its text.
  const pIdx = blocks.findIndex((b) => b.type === 'paragraph');
  assert.ok(pIdx >= 0, 'corpus has a paragraph');
  const target = blocks[pIdx];
  const newRaw = 'Completely different paragraph text.\n\n';
  const out = MDCore.replaceRange(src, target.start, target.end, newRaw);

  // Re-lex and confirm all OTHER blocks survived verbatim.
  const before = blocks.slice(0, pIdx).map((b) => b.raw).join('');
  const afterOriginal = blocks.slice(pIdx + 1).map((b) => b.raw).join('');
  assert.strictEqual(out.slice(0, target.start), before, 'prefix unchanged');
  assert.strictEqual(out.slice(target.start + newRaw.length), afterOriginal, 'suffix unchanged');
});

test('full open -> lex -> rebuild cycle is byte-identical (fidelity)', () => {
  for (const src of CORPUS) {
    const blocks = MDCore.lexBlocks(src);
    const rebuilt = blocks.map((b) => b.raw).join('');
    assert.strictEqual(rebuilt, src);
  }
});

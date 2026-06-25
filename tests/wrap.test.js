'use strict';
// Line-length re-wrapping tests (hard-wrap on save). Run: node --test tests/
// Exercises src/mdcore.js, which is inlined verbatim into mdviewer.html.

const { test } = require('node:test');
const assert = require('node:assert');
const MDCore = require('../src/mdcore.js');

test('wrapText: greedy-packs words to the column width', () => {
  const text = 'one two three four five six seven eight nine ten';
  const out = MDCore.wrapText(text, 12);
  for (const line of out.split('\n')) assert.ok(line.length <= 12, `line "${line}" within 12`);
  // joining the wrapped lines back with spaces recovers the words exactly
  assert.strictEqual(out.replace(/\n/g, ' '), text);
});

test('wrapText: width 0 (and negative) returns the text unchanged', () => {
  const text = 'a\nb\nc that is rather long indeed';
  assert.strictEqual(MDCore.wrapText(text, 0), text);
  assert.strictEqual(MDCore.wrapText(text, -5), text);
});

test('wrapText: re-flows soft-wrapped lines (joins then re-wraps)', () => {
  const src = 'a short line\nbroken oddly into\npieces';
  const out = MDCore.wrapText(src, 40);
  assert.strictEqual(out, 'a short line broken oddly into pieces');
});

test('wrapText: an HTML comment is one atomic token, never split', () => {
  const text = 'word <!-- GK: a multi word note here --> after the comment ends';
  const out = MDCore.wrapText(text, 20);
  // the comment must appear intact on a single line
  assert.ok(/<!-- GK: a multi word note here -->/.test(out), 'comment intact');
  out.split('\n').forEach((line) => {
    if (line.indexOf('<!--') !== -1) {
      assert.ok(/<!--[\s\S]*-->/.test(line), 'comment open+close on same line');
    }
  });
});

test('wrapText: comment glued to a word stays glued (computes<!--...-->)', () => {
  const text = 'computes<!-- GK-Q: which? --> an initial partition of the graph here';
  const out = MDCore.wrapText(text, 24);
  assert.ok(out.indexOf('computes<!-- GK-Q: which? -->') !== -1, 'glued token preserved');
});

test('wrapText: refuses to reflow paragraphs with markdown hard breaks', () => {
  const hard = 'Roses are red  \nviolets are blue and this line is quite long indeed';
  assert.strictEqual(MDCore.wrapText(hard, 20), hard);
  const bs = 'first line\\\nsecond line that keeps going on and on past the width';
  assert.strictEqual(MDCore.wrapText(bs, 20), bs);
});

test('wrapBlockRaw: preserves the block trailing newlines exactly', () => {
  const raw = 'some words that should wrap to a narrow column nicely\n\n';
  const out = MDCore.wrapBlockRaw(raw, 20);
  assert.ok(out.endsWith('\n\n'), 'trailing blank line preserved');
  assert.ok(!out.slice(0, -2).endsWith('\n'), 'no extra trailing newline in content');
});

test('detectWrapWidth: learns the column from greedy-wrapped prose', () => {
  // A paragraph greedy-wrapped at 30 columns, then a code block (ignored).
  const para = MDCore.wrapText(
    'the quick brown fox jumps over the lazy dog and then keeps running for a while', 30);
  const src = para + '\n\n```\nsuper_long_unbreakable_token_way_past_thirty_columns()\n```\n';
  const w = MDCore.detectWrapWidth(src);
  assert.ok(w > 0 && w <= 30, `detected ${w} should be in (0,30]`);
  // and re-wrapping at the detected width reproduces the file's wrapping
  assert.strictEqual(MDCore.wrapText(para.replace(/\n/g, ' '), w), para);
});

test('detectWrapWidth: round-trips a fixed-width paragraph (stable)', () => {
  const flowing = 'nsrunner is the neuro-symbolic runner it turns a multi-step skill ' +
    'into a fixed machine-checkable procedure run by any frontier model and verified ' +
    'by other models and by deterministic validators that never tire of the work';
  const wrapped = MDCore.wrapText(flowing, 80);
  const w = MDCore.detectWrapWidth(wrapped + '\n');
  assert.strictEqual(MDCore.wrapText(wrapped.replace(/\n/g, ' '), w), wrapped,
    're-wrapping at the detected width is a no-op');
});

test('detectWrapWidth: 0 when there is no multi-line prose to learn from', () => {
  assert.strictEqual(MDCore.detectWrapWidth('# Heading\n\nshort one-liner.\n'), 0);
});

test('rewrapAt: re-wraps only the paragraph that contains the offset', () => {
  const src = '## H\n\n' +
    'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi\n\n' +
    '```\nx\n```\n';
  const blocks = MDCore.lexBlocks(src);
  const para = blocks.find((b) => b.type === 'paragraph');
  const out = MDCore.rewrapAt(src, para.start + 5, 24);
  out.split('\n').forEach((line) => {
    if (line && line.indexOf('`') === -1 && line.indexOf('#') === -1) {
      assert.ok(line.length <= 24, `prose line "${line}" within 24`);
    }
  });
  // the code block and heading are untouched
  assert.ok(out.indexOf('## H\n\n') === 0, 'heading intact');
  assert.ok(out.indexOf('```\nx\n```\n') !== -1, 'code block intact');
});

test('rewrapAt: leaves non-paragraph blocks (code) unchanged', () => {
  const src = '```\na very long single line of code that exceeds the wrap width by a lot\n```\n';
  const blocks = MDCore.lexBlocks(src);
  const code = blocks.find((b) => b.type === 'code');
  assert.strictEqual(MDCore.rewrapAt(src, code.start + 4, 20), src);
});

test('rewrapAt: width 0 is a no-op', () => {
  const src = 'a b c d e f g h i j k l m n o p q r s t u v w x y z one two three four five\n';
  assert.strictEqual(MDCore.rewrapAt(src, 3, 0), src);
});

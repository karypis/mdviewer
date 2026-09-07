'use strict';
// Comment parsing / serialization / insertion / round-trip fidelity tests.
const { test } = require('node:test');
const assert = require('node:assert');
const MDCore = require('../src/mdcore.js');

test('parseComments: detects GK variants and their kinds', () => {
  const src =
    'Intro <!-- GK: plain note --> text.\n\n' +
    '<!-- GK-FIX: fix this -->\n\n' +
    'More <!-- GK-Q: really? --> and <!-- GK-NIT: spacing -->.\n';
  const cs = MDCore.parseComments(src);
  assert.strictEqual(cs.length, 4);
  assert.deepStrictEqual(cs.map((c) => c.tag), ['GK', 'GK-FIX', 'GK-Q', 'GK-NIT']);
  assert.deepStrictEqual(cs.map((c) => c.variant), ['gk', 'gk-fix', 'gk-q', 'gk-nit']);
  for (const c of cs) assert.strictEqual(src.slice(c.start, c.end), c.raw);
});

test('parseComments: any initials-style tag is recognized (multi-author files)', () => {
  const src = 'a <!-- GK: from george --> b <!-- AB: from alice --> c <!-- AB-FIX: alice fix -->\n';
  const cs = MDCore.parseComments(src);
  assert.strictEqual(cs.length, 3);
  assert.deepStrictEqual(cs.map((c) => c.tag), ['GK', 'AB', 'AB-FIX']);
  // kind colour is prefix-independent: AB-FIX is amber like GK-FIX
  assert.strictEqual(cs[2].variant, 'gk-fix');
});

test('parseComments: ignores lowercase tooling comments and colon-less tags', () => {
  const src = 'x <!-- prettier-ignore --> y <!-- TOC --> z <!-- some note -->\n';
  assert.strictEqual(MDCore.parseComments(src).length, 0);
});

test('parseComments: audit-trail split, default and custom responder', () => {
  const src = 'x <!-- GK: original / CLAUDE: addressed by Y --> z\n';
  const cs = MDCore.parseComments(src);
  assert.strictEqual(cs[0].body, 'original');
  assert.strictEqual(cs[0].claude, 'addressed by Y');
  // custom responder name
  const src2 = 'x <!-- AB: note / ME: did it --> z\n';
  const cs2 = MDCore.parseComments(src2, 'ME');
  assert.strictEqual(cs2[0].body, 'note');
  assert.strictEqual(cs2[0].claude, 'did it');
  // wrong responder -> no split (whole thing is the body)
  const cs3 = MDCore.parseComments(src2, 'CLAUDE');
  assert.strictEqual(cs3[0].claude, null);
  assert.match(cs3[0].body, /note \/ ME: did it/);
});

test('parseComments: multiline comment body', () => {
  const src = 'p\n\n<!-- GK: line one\nline two -->\n\nq\n';
  const cs = MDCore.parseComments(src);
  assert.strictEqual(cs.length, 1);
  assert.match(cs[0].body, /line one\nline two/);
});

test('serializeComment: produces the canonical pure format', () => {
  assert.strictEqual(MDCore.serializeComment('GK', 'hello'), '<!-- GK: hello -->');
  assert.strictEqual(MDCore.serializeComment('GK-FIX', '  trim me  '), '<!-- GK-FIX: trim me -->');
  assert.strictEqual(MDCore.serializeComment(null, 'd'), '<!-- GK: d -->');
});

test('insert comment via splice: byte-exact, surrounding text intact', () => {
  const src = 'The quick brown fox jumps.\n';
  const pos = src.indexOf('fox') + 3; // right after "fox"
  const comment = MDCore.serializeComment('GK', 'which fox?');
  const out = MDCore.spliceSource(src, pos, pos, comment);
  assert.strictEqual(out, 'The quick brown fox<!-- GK: which fox? --> jumps.\n');
  // everything except the inserted run is unchanged
  assert.strictEqual(out.slice(0, pos), src.slice(0, pos));
  assert.strictEqual(out.slice(pos + comment.length), src.slice(pos));
});

test('round-trip: insert then delete a comment yields the original bytes', () => {
  const src = 'Alpha beta gamma delta.\n';
  const pos = src.indexOf('beta') + 4;
  const comment = MDCore.serializeComment('GK', 'note');
  const withC = MDCore.spliceSource(src, pos, pos, comment);
  const cs = MDCore.parseComments(withC);
  assert.strictEqual(cs.length, 1);
  const removed = MDCore.spliceSource(withC, cs[0].start, cs[0].end, '');
  assert.strictEqual(removed, src, 'delete restores original bytes exactly');
});

test('edit comment body: only the comment bytes change', () => {
  const src = 'Before <!-- GK: old --> after.\n';
  const c = MDCore.parseComments(src)[0];
  const replacement = MDCore.serializeComment(c.tag, 'new and longer');
  const out = MDCore.spliceSource(src, c.start, c.end, replacement);
  assert.strictEqual(out, 'Before <!-- GK: new and longer --> after.\n');
  assert.strictEqual(out.slice(0, c.start), src.slice(0, c.start));
});

test('locateInsertOffset: attaches to the FIRST word of the selection', () => {
  const raw = 'The multilevel scheme coarsens the graph, computes an initial partition, done.';
  const off = MDCore.locateInsertOffset(raw, 100, '', 'computes an initial partition');
  // offset points right after the first word "computes", not the whole phrase
  const expected = 100 + raw.indexOf('computes an initial partition') + 'computes'.length;
  assert.strictEqual(off, expected);
  assert.strictEqual(raw.slice(off - 100 - 1, off - 100), 's'); // char before offset is end of "computes"
});

test('locateInsertOffset: repeated selection disambiguated, anchored to first word', () => {
  const raw = 'set the value, then set the value again.';
  // Want the SECOND "set the value"; prefix is everything rendered before it.
  const prefix = 'set the value, then set the value';
  const off = MDCore.locateInsertOffset(raw, 0, prefix, 'set the value');
  const second = raw.indexOf('set the value', 1);
  assert.strictEqual(off, second + 'set'.length); // after first word "set"
});

test('locateInsertOffset: not found returns null', () => {
  assert.strictEqual(MDCore.locateInsertOffset('hello world', 0, '', 'zzz'), null);
});

test('removeAllComments: strips every GK comment, preserves prose bytes', () => {
  const clean = 'Alpha beta gamma.\n\nA second paragraph here.\n';
  // inline + standalone comments interspersed
  const withC =
    'Alpha beta<!-- GK: one --> gamma.\n\n' +
    '<!-- GK-Q: two -->\n\n' +
    'A second paragraph<!-- GK-NIT: three --> here.\n';
  // build the "clean" expectation: inline removals leave text; the standalone
  // line + its trailing newline are dropped.
  const out = MDCore.removeAllComments(withC);
  assert.ok(out.indexOf('<!-- GK') === -1, 'no GK comments remain');
  assert.strictEqual(out, 'Alpha beta gamma.\n\nA second paragraph here.\n');
});

test('removeAllComments: leaves non-review (lowercase/tooling) comments untouched', () => {
  const src = 'x <!-- GK: drop --> y <!-- prettier-ignore --> z\n';
  const out = MDCore.removeAllComments(src);
  assert.strictEqual(out, 'x  y <!-- prettier-ignore --> z\n');
});

test('removeAllComments: no-op when there are no comments', () => {
  const src = '# Title\n\nJust prose, nothing to strip.\n';
  assert.strictEqual(MDCore.removeAllComments(src), src);
});

test('lastWordRange: isolates the single trailing word (never the whole run)', () => {
  // The highlight rule: only the word immediately before the comment marker.
  const text = 'The 406 processes look like 406 products, but they are not. They are computes';
  const wb = MDCore.lastWordRange(text);
  assert.deepStrictEqual(wb, { start: text.length - 'computes'.length, end: text.length });
  assert.strictEqual(text.slice(wb.start, wb.end), 'computes');
  // explicitly: it must NOT span the whole text
  assert.notStrictEqual(wb.start, 0);
});

test('lastWordRange: a single word maps to the whole word', () => {
  assert.deepStrictEqual(MDCore.lastWordRange('existing'), { start: 0, end: 8 });
});

test('lastWordRange: ignores trailing whitespace', () => {
  const wb = MDCore.lastWordRange('hello world   ');
  assert.deepStrictEqual(wb, { start: 6, end: 11 });
  assert.strictEqual('hello world   '.slice(wb.start, wb.end), 'world');
});

test('lastWordRange: punctuation-attached word kept whole', () => {
  const wb = MDCore.lastWordRange('a phrase line');
  assert.strictEqual('a phrase line'.slice(wb.start, wb.end), 'line');
});

test('lastWordRange: empty / whitespace-only returns null', () => {
  assert.strictEqual(MDCore.lastWordRange(''), null);
  assert.strictEqual(MDCore.lastWordRange('   \n  '), null);
});

test('commentsByBlock: assigns comments to their containing block', () => {
  const src = '# Head\n\nFirst para with <!-- GK: a --> note.\n\nSecond para <!-- GK: b -->.\n';
  const blocks = MDCore.lexBlocks(src);
  const comments = MDCore.parseComments(src);
  const map = MDCore.commentsByBlock(blocks, comments);
  // two distinct blocks each own one comment
  const owners = Object.keys(map);
  assert.strictEqual(comments.length, 2);
  let total = 0;
  for (const k of owners) total += map[k].length;
  assert.strictEqual(total, 2);
});

test('parseComments: trailing SPAN:N field sets span and is stripped from the body', () => {
  const src = 'the quick <!-- GK: three words SPAN:3 --> brown fox\n';
  const cs = MDCore.parseComments(src);
  assert.strictEqual(cs.length, 1);
  assert.strictEqual(cs[0].body, 'three words');
  assert.strictEqual(cs[0].span, 3);
});

test('parseComments: span defaults to 1 without the field', () => {
  const cs = MDCore.parseComments('a <!-- GK: note --> b\n');
  assert.strictEqual(cs[0].span, 1);
  assert.strictEqual(cs[0].body, 'note');
});

test('parseComments: SPAN sits before the audit-trail response', () => {
  const cs = MDCore.parseComments('a <!-- GK: original SPAN:2 / CLAUDE: addressed --> b\n');
  assert.strictEqual(cs[0].body, 'original');
  assert.strictEqual(cs[0].span, 2);
  assert.strictEqual(cs[0].claude, 'addressed');
});

test('parseComments: SPAN mentioned mid-body is left alone', () => {
  const cs = MDCore.parseComments('a <!-- GK: the SPAN:2 idea is wrong --> b\n');
  assert.strictEqual(cs[0].body, 'the SPAN:2 idea is wrong');
  assert.strictEqual(cs[0].span, 1);
});

test('serializeComment: writes SPAN:N only when N > 1', () => {
  assert.strictEqual(MDCore.serializeComment('GK', 'note'), '<!-- GK: note -->');
  assert.strictEqual(MDCore.serializeComment('GK', 'note', 1), '<!-- GK: note -->');
  assert.strictEqual(MDCore.serializeComment('GK', 'note', 0), '<!-- GK: note -->');
  assert.strictEqual(MDCore.serializeComment('GK-Q', 'note', 4), '<!-- GK-Q: note SPAN:4 -->');
});

test('serializeComment/parseComments: SPAN round-trips', () => {
  const bytes = MDCore.serializeComment('GK', 'why?', 5);
  const cs = MDCore.parseComments('x ' + bytes + ' y');
  assert.strictEqual(cs[0].body, 'why?');
  assert.strictEqual(cs[0].span, 5);
  assert.strictEqual(MDCore.serializeComment(cs[0].tag, cs[0].body, cs[0].span), bytes);
});

test('countWords: whitespace-delimited, newline-tolerant', () => {
  assert.strictEqual(MDCore.countWords(''), 0);
  assert.strictEqual(MDCore.countWords('  computes  '), 1);
  assert.strictEqual(MDCore.countWords('computes an\ninitial partition'), 4);
});

test('spanRange: n=1 is the single word before the marker', () => {
  const text = 'The algorithm computes an initial partition.';
  const pos = text.indexOf('computes') + 'computes'.length;
  const r = MDCore.spanRange(text, pos, 1);
  assert.strictEqual(text.slice(r.start, r.end), 'computes');
});

test('spanRange: n words = anchor word plus the next n-1 after the marker', () => {
  const text = 'The algorithm computes an initial partition here.';
  const pos = text.indexOf('computes') + 'computes'.length;
  const r = MDCore.spanRange(text, pos, 4);
  assert.strictEqual(text.slice(r.start, r.end), 'computes an initial partition');
});

test('spanRange: clamps to the end of the block text', () => {
  const text = 'ends with computes an';
  const pos = text.indexOf('computes') + 'computes'.length;
  const r = MDCore.spanRange(text, pos, 9);
  assert.strictEqual(text.slice(r.start, r.end), 'computes an');
});

test('spanRange: spans a line break in the rendered text', () => {
  const text = 'a computes\nan initial';
  const pos = text.indexOf('computes') + 'computes'.length;
  const r = MDCore.spanRange(text, pos, 3);
  assert.strictEqual(text.slice(r.start, r.end), 'computes\nan initial');
});

test('spanRange: no word before the marker returns null', () => {
  assert.strictEqual(MDCore.spanRange('  \nafter words', 3, 2), null);
  assert.strictEqual(MDCore.spanRange('after words', 0, 2), null);
});

test('markerToken: private-use characters only, decodes back to the id', () => {
  for (const id of [0, 1, 7, 12, 305]) {
    const tok = MDCore.markerToken(id);
    assert.ok(/^[\uE000-\uE0FF]+$/.test(tok), 'no ASCII in token: ' + JSON.stringify(tok));
    const m = MDCore.markerTokenRe().exec(tok);
    assert.ok(m && m[0] === tok);
    assert.strictEqual(MDCore.markerTokenId(m[1]), id);
  }
});

test('markerToken survives rendering inside a fenced code block', () => {
  const tok = MDCore.markerToken(1);
  const html = MDCore.mdToHtml('```sh\nnpx' + tok + ' tsx src/cli.ts\n```\n');
  assert.ok(html.indexOf('npx' + tok + ' tsx') !== -1, html);
  assert.ok(html.indexOf('gkmark') === -1, 'no literal span text in code');
});

test('markerToken survives rendering inside an inline code span and bold', () => {
  const tok = MDCore.markerToken(2);
  const html = MDCore.mdToHtml('use `.nsr' + tok + '.knowledge` and **three' + tok + ' pieces**\n');
  assert.ok(/<code>\.nsr\uE000[\uE010-\uE019]*\uE001\.knowledge<\/code>/.test(html), html);
  assert.ok(/<strong>three\uE000[\uE010-\uE019]*\uE001 pieces<\/strong>/.test(html), html);
});

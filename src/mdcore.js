/*
 * mdcore — pure, DOM-free logic for mdviewer.
 *
 * Everything here is testable in Node (no document/window at load time) and is
 * inlined verbatim into the single-file mdviewer.html by tools/build.js.
 *
 * Depends only on `marked` (the GFM lexer/parser). In Node it is required from
 * ../vendor; in the browser it reads the inlined global.
 */
(function (root, factory) {
  var marked =
    (typeof require !== 'undefined' && typeof module !== 'undefined')
      ? require('../vendor/marked.min.js')
      : root.marked;
  var api = factory(marked);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MDCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (marked) {
  'use strict';

  // Faithful GFM. No smartypants/typographer so rendered text stays close to
  // source (matters for inline offset mapping). breaks:false = standard MD.
  if (marked && marked.setOptions) {
    marked.setOptions({ gfm: true, breaks: false, pedantic: false });
  }

  // ---- block source map -------------------------------------------------

  // Lex `source` into ordered top-level blocks, each carrying its exact byte
  // range [start, end) such that source.slice(start, end) === block.raw.
  // marked guarantees the concatenation of top-level token raws equals source.
  function lexBlocks(source) {
    var tokens = marked.lexer(source);
    var blocks = [];
    var off = 0;
    for (var i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      var start = off;
      var end = off + t.raw.length;
      blocks.push({ type: t.type, raw: t.raw, start: start, end: end });
      off = end;
    }
    return blocks;
  }

  // Find the index of the block whose range contains source offset `pos`.
  // A position exactly on a boundary belongs to the block that ends there
  // (so the trailing edge of a block, where comments land, maps to it).
  function blockIndexAt(blocks, pos) {
    for (var i = 0; i < blocks.length; i++) {
      if (pos > blocks[i].start && pos <= blocks[i].end) return i;
    }
    if (blocks.length && pos <= blocks[0].start) return 0;
    return blocks.length ? blocks.length - 1 : -1;
  }

  // ---- editing primitives ----------------------------------------------

  function spliceSource(source, start, end, text) {
    return source.slice(0, start) + text + source.slice(end);
  }

  // Replace block at [start,end) with newRaw. Returns the new full source.
  // Pure string op; callers re-lex afterward to rebuild the map.
  function replaceRange(source, start, end, newRaw) {
    return spliceSource(source, start, end, newRaw);
  }

  // ---- markdown rendering (string only) --------------------------------

  function mdToHtml(md) {
    return marked.parse(md);
  }

  // ---- GK comments ------------------------------------------------------

  // Matches any "initials-style" review tag: an uppercase-led token (the
  // commenter's initials, e.g. GK or AB) optionally followed by kind suffixes
  // (e.g. -FIX), then a colon. So <!-- GK: ... -->, <!-- AB-FIX: ... -->, etc.
  // all render, which lets multiple people share a file. Lowercase tooling
  // comments (<!-- prettier-ignore -->) and tags with no colon never match.
  var COMMENT_RE = /<!--\s*([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*)\s*:\s*([\s\S]*?)\s*-->/g;

  function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  // The variant (colour) is determined by the KIND suffix, independent of the
  // initials prefix: GK-FIX and AB-FIX both render amber.
  function variantClass(tag) {
    var t = String(tag).toLowerCase();
    if (/(^|-)fix$/.test(t)) return 'gk-fix';
    if (/(^|-)q$/.test(t)) return 'gk-q';
    if (/(^|-)nit$/.test(t)) return 'gk-nit';
    return 'gk';
  }

  // Parse every review comment in `source`. Each result has the tag, the human
  // body, an optional audit-trail response (split on `/ <responder>:`, default
  // responder "CLAUDE"), the variant css class, and the exact [start,end) byte
  // range of the whole `<!-- ... -->` token.
  function parseComments(source, responder) {
    var respRe = new RegExp('\\s*/\\s*' + escapeRegExp(responder || 'CLAUDE') + '\\s*:\\s*');
    var out = [];
    COMMENT_RE.lastIndex = 0;
    var m;
    while ((m = COMMENT_RE.exec(source)) !== null) {
      var tag = m[1];
      var inner = m[2];
      var body = inner;
      var claude = null;
      var parts = inner.split(respRe);
      if (parts.length === 2) {
        body = parts[0].trim();
        claude = parts[1].trim();
      }
      out.push({
        tag: tag,
        variant: variantClass(tag),
        body: body,
        claude: claude,
        start: m.index,
        end: m.index + m[0].length,
        raw: m[0],
      });
    }
    return out;
  }

  // Remove a single comment's bytes. If it occupies its own line, also drop the
  // line's trailing newline, and collapse any blank-line pileup the removal
  // creates (so a standalone comment between two paragraphs leaves exactly one
  // blank line, not two). Inline comments are removed verbatim.
  function removeCommentBytes(source, start, end) {
    var ownLine = (start === 0 || source.charAt(start - 1) === '\n') && source.charAt(end) === '\n';
    if (ownLine) end += 1;
    var head = source.slice(0, start);
    var tail = source.slice(end);
    if (ownLine && /\n\n$/.test(head) && /^\n/.test(tail)) {
      tail = tail.replace(/^\n/, '');
    }
    return head + tail;
  }

  // Strip every GK comment from the source (byte-precise). Removes from the end
  // backwards so offsets stay valid.
  function removeAllComments(source) {
    var comments = parseComments(source);
    var s = source;
    for (var i = comments.length - 1; i >= 0; i--) {
      s = removeCommentBytes(s, comments[i].start, comments[i].end);
    }
    return s;
  }

  // Build the exact bytes of a GK comment from a tag and body.
  function serializeComment(tag, body) {
    var t = (tag || 'GK').trim();
    var b = String(body == null ? '' : body).trim();
    return '<!-- ' + t + ': ' + b + ' -->';
  }

  // Group parsed comments by the block (from lexBlocks) that contains them,
  // preserving document order. A comment belongs to the block whose range
  // contains its start offset.
  function commentsByBlock(blocks, comments) {
    var map = {};
    for (var i = 0; i < comments.length; i++) {
      var c = comments[i];
      var bi = blockIndexAt(blocks, c.start + 1);
      (map[bi] || (map[bi] = [])).push(c);
    }
    return map;
  }

  // Decide where to insert a new comment in the source so it attaches to the
  // FIRST WORD of the user's selection (the comment lands right after that
  // word). `prefix` is the rendered text of the block from its start up to the
  // selection end (used only to disambiguate when the selected text occurs more
  // than once). Returns an absolute source offset, or null if the selection
  // text cannot be located (caller falls back to the end of the block).
  function firstWordLen(selected) {
    var m = selected.match(/^\s*\S+/); // optional leading ws + first word
    return m ? m[0].length : selected.length;
  }

  // [start, end) of the last whitespace-delimited word in `text` (ignoring any
  // trailing whitespace), or null if there is no word. This is the rule used to
  // highlight ONLY the single word a comment anchors to (the word immediately
  // before the comment marker), never the whole preceding run.
  function lastWordRange(text) {
    var trimmed = (text || '').replace(/\s+$/, '');
    if (!trimmed) return null;
    var m = trimmed.match(/\S+$/);
    if (!m) return null;
    return { start: trimmed.length - m[0].length, end: trimmed.length };
  }

  function locateInsertOffset(blockRaw, blockStart, prefix, selected) {
    if (!selected) return null;
    var cands = [];
    var from = 0, idx;
    while ((idx = blockRaw.indexOf(selected, from)) !== -1) {
      cands.push(idx);
      from = idx + 1;
    }
    if (cands.length === 0) return null;
    if (cands.length === 1) return blockStart + cands[0] + firstWordLen(selected);
    // The prefix is the rendered text up to the selection END, so it ends with
    // the selection itself; strip that to get the text just BEFORE it.
    var beforeSel = prefix || '';
    if (beforeSel.slice(-selected.length) === selected) {
      beforeSel = beforeSel.slice(0, beforeSel.length - selected.length);
    }
    var tail = beforeSel.slice(-32);
    var best = cands[0], bestScore = -1;
    for (var k = 0; k < cands.length; k++) {
      var c = cands[k];
      var before = blockRaw.slice(Math.max(0, c - tail.length), c);
      var score = 0;
      for (var j = 1; j <= Math.min(before.length, tail.length); j++) {
        if (before.charAt(before.length - j) === tail.charAt(tail.length - j)) score++;
        else break;
      }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return blockStart + best + firstWordLen(selected);
  }

  return {
    lexBlocks: lexBlocks,
    blockIndexAt: blockIndexAt,
    spliceSource: spliceSource,
    replaceRange: replaceRange,
    mdToHtml: mdToHtml,
    parseComments: parseComments,
    serializeComment: serializeComment,
    removeCommentBytes: removeCommentBytes,
    removeAllComments: removeAllComments,
    variantClass: variantClass,
    commentsByBlock: commentsByBlock,
    locateInsertOffset: locateInsertOffset,
    lastWordRange: lastWordRange,
  };
});

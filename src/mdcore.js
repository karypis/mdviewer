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

  // ---- line-length re-wrapping (hard-wrap on save) ---------------------
  // George's source files are hard-wrapped to a fixed column width. The viewer
  // reflows them to the window on screen (markdown joins soft-wrapped lines),
  // but when it WRITES a block back it must re-hard-wrap so the file on disk
  // keeps its line-length constraint. We only ever re-wrap PARAGRAPH blocks
  // (prose); code, tables, headings, lists, and blockquotes are left verbatim.

  // True if a line carries an intentional markdown hard break (trailing two+
  // spaces, or a backslash), which must be preserved, so we refuse to reflow.
  function hasHardBreak(lines) {
    for (var i = 0; i < lines.length; i++) {
      if (/(?:[ \t]{2,}|\\)$/.test(lines[i])) return true;
    }
    return false;
  }

  // Reflow prose `text` to `width` columns by greedy word packing. HTML
  // comments (<!-- GK: ... -->) are atomic tokens that are never split, even
  // when they contain spaces, so a comment never gets broken across lines.
  // Returns `text` unchanged when width<=0 or the text has hard breaks.
  function wrapText(text, width) {
    text = String(text == null ? '' : text);
    if (!width || width <= 0) return text;
    var lines = text.split('\n');
    if (hasHardBreak(lines)) return text;
    var joined = lines.join(' ');
    var tokens = joined.match(/(?:<!--[\s\S]*?-->|\S)+/g);
    if (!tokens) return text; // blank / whitespace only
    var out = [];
    var cur = '';
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      if (cur === '') cur = tok;
      else if (cur.length + 1 + tok.length <= width) cur += ' ' + tok;
      else { out.push(cur); cur = tok; }
    }
    if (cur !== '') out.push(cur);
    return out.join('\n');
  }

  // Re-wrap a block's raw to `width`, preserving its exact trailing newlines so
  // the surrounding block structure (blank-line separators) is untouched.
  function wrapBlockRaw(raw, width) {
    var trailer = raw.match(/\n*$/)[0];
    var content = raw.slice(0, raw.length - trailer.length);
    return wrapText(content, width) + trailer;
  }

  // Infer the file's hard-wrap column from its existing paragraphs. With greedy
  // wrapping at a fixed width W, every non-final line of a multi-line paragraph
  // has length <= W, and W < (that line + its next word), so the longest such
  // line reproduces the file's wrapping exactly. Lines holding a comment are
  // skipped (an unbreakable comment token can overrun W). Returns 0 if there is
  // no multi-line prose to learn from.
  function detectWrapWidth(source) {
    var blocks = lexBlocks(source);
    var max = 0;
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i].type !== 'paragraph') continue;
      var raw = blocks[i].raw;
      var content = raw.slice(0, raw.length - raw.match(/\n*$/)[0].length);
      var lines = content.split('\n');
      if (lines.length < 2 || hasHardBreak(lines)) continue;
      for (var k = 0; k < lines.length - 1; k++) {
        if (lines[k].indexOf('<!--') !== -1) continue;
        var len = lines[k].replace(/\s+$/, '').length;
        if (len > max) max = len;
      }
    }
    return max;
  }

  // Re-wrap the paragraph block that contains source offset `pos` to `width`,
  // returning the new full source (unchanged if width<=0 or the block is not a
  // paragraph). Used after a comment is spliced into prose so the host line
  // does not exceed the constraint.
  function rewrapAt(source, pos, width) {
    if (!width || width <= 0) return source;
    var blocks = lexBlocks(source);
    if (!blocks.length) return source;
    var i = blockIndexAt(blocks, pos);
    if (i < 0) return source;
    var b = blocks[i];
    if (b.type !== 'paragraph') return source;
    var nr = wrapBlockRaw(b.raw, width);
    if (nr === b.raw) return source;
    return spliceSource(source, b.start, b.end, nr);
  }

  // Project markdown `raw` to the plain text a browser would render, returning
  // { plain, map } where map[i] is the source index of plain character i. This
  // lets us locate a DOM-selected (already-rendered) string inside the source
  // even when the selection touches inline markup. We strip the inline syntax
  // that produces no visible characters: emphasis/strong (* _), strikethrough
  // (~), code-span backticks, link/image wrappers ([text](url), ![alt](url),
  // [text][ref]), backslash escapes, and HTML comments. Everything else
  // (including whitespace and newlines, which the DOM preserves in text nodes)
  // is emitted verbatim. Block-level markers (#, -, >, |) are left in place;
  // they only shift positions, which the map accounts for.
  function projectPlain(raw) {
    var plain = [];
    var map = [];
    var i = 0, n = raw.length;
    function emit(ch, src) { plain.push(ch); map.push(src); }
    while (i < n) {
      if (raw.charAt(i) === '<' && raw.substr(i, 4) === '<!--') {
        var ce = raw.indexOf('-->', i + 4);
        i = ce === -1 ? n : ce + 3;
        continue;
      }
      var c = raw.charAt(i);
      if (c === '\\' && i + 1 < n) { emit(raw.charAt(i + 1), i + 1); i += 2; continue; }
      if (c === '`') {
        var j = i; while (j < n && raw.charAt(j) === '`') j++;
        var ticks = raw.slice(i, j);
        var close = raw.indexOf(ticks, j);
        if (close === -1) { emit(c, i); i++; continue; }
        for (var k = j; k < close; k++) emit(raw.charAt(k), k);
        i = close + ticks.length;
        continue;
      }
      if (c === '*' || c === '_' || c === '~') {
        var p = i; while (p < n && raw.charAt(p) === c) p++;
        i = p; continue;
      }
      if (c === '!' && raw.charAt(i + 1) === '[') { i++; continue; }
      if (c === '[') {
        var depth = 1, q = i + 1;
        while (q < n && depth > 0) {
          var qc = raw.charAt(q);
          if (qc === '[') depth++;
          else if (qc === ']') { depth--; if (depth === 0) break; }
          q++;
        }
        if (q < n && raw.charAt(q) === ']') {
          var sub = projectPlain(raw.slice(i + 1, q));
          for (var s = 0; s < sub.plain.length; s++) emit(sub.plain.charAt(s), i + 1 + sub.map[s]);
          var after = q + 1;
          if (raw.charAt(after) === '(') {
            var d2 = 1, r = after + 1;
            while (r < n && d2 > 0) { var rc = raw.charAt(r); if (rc === '(') d2++; else if (rc === ')') d2--; r++; }
            i = r;
          } else if (raw.charAt(after) === '[') {
            var r2 = raw.indexOf(']', after + 1);
            i = r2 === -1 ? after : r2 + 1;
          } else {
            i = after;
          }
          continue;
        }
        emit(c, i); i++; continue;
      }
      emit(c, i); i++;
    }
    return { plain: plain.join(''), map: map };
  }

  function locateInsertOffset(blockRaw, blockStart, prefix, selected) {
    if (!selected) return null;
    var proj = projectPlain(blockRaw);
    var hay = proj.plain;

    function find(needle) {
      var out = [], from = 0, idx;
      if (!needle) return out;
      while ((idx = hay.indexOf(needle, from)) !== -1) { out.push(idx); from = idx + 1; }
      return out;
    }

    // Prefer the full selection; if rendering differences keep it from matching
    // exactly, fall back to just its first word (the anchor we actually need).
    var cands = find(selected);
    var firstWord = (selected.match(/^\s*\S+/) || [''])[0];
    if (cands.length === 0) cands = find(firstWord);
    if (cands.length === 0) return null;

    var chosen;
    if (cands.length === 1) {
      chosen = cands[0];
    } else {
      // Disambiguate using the rendered prefix (text from block start to the
      // selection end), comparing the run just before each candidate.
      var beforeSel = prefix || '';
      if (selected && beforeSel.slice(-selected.length) === selected) {
        beforeSel = beforeSel.slice(0, beforeSel.length - selected.length);
      }
      var tail = beforeSel.slice(-32);
      var best = cands[0], bestScore = -1;
      for (var ci = 0; ci < cands.length; ci++) {
        var c0 = cands[ci];
        var before = hay.slice(Math.max(0, c0 - tail.length), c0);
        var score = 0;
        for (var t = 1; t <= Math.min(before.length, tail.length); t++) {
          if (before.charAt(before.length - t) === tail.charAt(tail.length - t)) score++;
          else break;
        }
        if (score > bestScore) { bestScore = score; best = c0; }
      }
      chosen = best;
    }

    // Insert right after the first word of the selection. Map that plain offset
    // back to a source offset via the projection map.
    var endPlain = chosen + firstWordLen(selected);
    if (endPlain > proj.map.length) endPlain = proj.map.length;
    var srcOff = endPlain < proj.map.length
      ? proj.map[endPlain]
      : (proj.map.length ? proj.map[proj.map.length - 1] + 1 : 0);
    return blockStart + srcOff;
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
    projectPlain: projectPlain,
    lastWordRange: lastWordRange,
    wrapText: wrapText,
    wrapBlockRaw: wrapBlockRaw,
    detectWrapWidth: detectWrapWidth,
    rewrapAt: rewrapAt,
  };
});

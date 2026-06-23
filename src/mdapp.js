/* mdviewer UI. Browser-only (uses DOM / File System Access API / IndexedDB).
 * Depends on globals: MDCore, marked, DOMPurify, hljs. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var docEl, docwrap, marginEl, sidebar, composer, commentBtn, toastEl;

  var KINDS = ['', '-FIX', '-Q', '-NIT']; // suffixes appended to the prefix
  var DEFAULT_SETTINGS = { prefix: 'GK', responder: 'CLAUDE' };

  var state = {
    fileHandle: null,
    dirHandle: null,
    startDir: null,       // directory handle used as the picker's startIn
    settings: { prefix: 'GK', responder: 'CLAUDE' }, // comment style (customizable)
    source: '',
    blocks: [],
    comments: [],
    fileName: '',
    editing: null,        // index of block being edited, or null
    escaping: false,      // set while cancelling an edit
    saveTimer: null,
    activeComment: null,  // id of focused comment
    composerMode: null,   // {type:'new', pos} or {type:'edit', comment}
  };

  // ---- save state indicator --------------------------------------------
  function setSaveState(s, msg) {
    var el = $('saveState');
    el.className = s;
    var labels = { saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved', error: msg || 'Save error' };
    el.querySelector('.label').textContent = labels[s] || '';
  }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 4000);
  }

  // ---- file access ------------------------------------------------------
  // The picker's starting directory: the last folder opened (persisted), else
  // the OS Documents folder. Browsers do not allow an arbitrary absolute path,
  // so the default becomes ~/agents once you open it once.
  function pickerStart() { return state.startDir || 'documents'; }

  // Run a picker with startIn = pickerStart(), retrying from a safe default if
  // a persisted handle has gone stale. Returns null if the user cancels.
  async function runPicker(fn, extra) {
    var opts = Object.assign({ startIn: pickerStart() }, extra || {});
    try {
      return await fn(opts);
    } catch (e1) {
      if (e1.name === 'AbortError') return null;
      opts.startIn = 'documents';
      return await fn(opts);
    }
  }

  async function openFile() {
    try {
      var picked = await runPicker(window.showOpenFilePicker.bind(window), {
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'], 'text/plain': ['.txt'] } }],
      });
      if (!picked) return;
      var h = picked[0];
      state.fileHandle = h;
      state.dirHandle = null;
      await loadHandle(h);
      await persistLast(h, null);
    } catch (e) { if (e.name !== 'AbortError') toast('Open failed: ' + e.message); }
  }

  async function openFolder() {
    try {
      var dir = await runPicker(window.showDirectoryPicker.bind(window));
      if (!dir) return;
      state.dirHandle = dir;
      setStartDir(dir);
      await persistLast(null, dir);
      await buildTree(dir);
    } catch (e) { if (e.name !== 'AbortError') toast('Open folder failed: ' + e.message); }
  }

  function setStartDir(dirH) {
    state.startDir = dirH;
    persistStartDir(dirH);
  }

  // ---- Electron file bridge --------------------------------------------
  // A path opened from Finder/the menu is wrapped in an object that mimics the
  // FileSystemFileHandle interface (name / getFile / createWritable) so the rest
  // of the app (loadHandle, writeFile autosave) works unchanged, but reads and
  // writes go through the native fs bridge in preload.js.
  function basename(p) {
    var i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  }
  function electronFileHandle(path) {
    return {
      name: basename(path),
      kind: 'file',
      _electronPath: path,
      getFile: function () {
        return window.electronAPI.readFile(path).then(function (text) {
          return { name: basename(path), text: function () { return Promise.resolve(text); } };
        });
      },
      createWritable: function () {
        return Promise.resolve({
          write: function (data) { return window.electronAPI.writeFile(path, data); },
          close: function () { return Promise.resolve(); },
        });
      },
    };
  }
  async function openElectronPath(path) {
    try {
      state.fileHandle = electronFileHandle(path);
      state.dirHandle = null;
      await loadHandle(state.fileHandle);
    } catch (e) { toast('Open failed: ' + e.message); }
  }

  async function loadHandle(h) {
    var file = await h.getFile();
    state.fileName = h.name;
    var text = await file.text();
    setSource(text);
    $('filename').textContent = h.name;
    setSaveState('saved');
    if (!state.dirHandle) renderSidebarOutline();
  }

  async function writeFile() {
    if (!state.fileHandle) return;
    try {
      setSaveState('saving');
      var w = await state.fileHandle.createWritable();
      await w.write(state.source);
      await w.close();
      setSaveState('saved');
    } catch (e) {
      setSaveState('error', 'Save failed');
      toast('Save failed: ' + e.message);
    }
  }

  function scheduleSave(immediate) {
    setSaveState('dirty');
    clearTimeout(state.saveTimer);
    if (immediate) { writeFile(); return; }
    state.saveTimer = setTimeout(writeFile, 500);
  }

  // ---- reopen-last via IndexedDB ---------------------------------------
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('mdviewer', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('h'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function persistLast(fileH, dirH) {
    try {
      var db = await idb();
      var tx = db.transaction('h', 'readwrite');
      tx.objectStore('h').put({ fileH: fileH, dirH: dirH, name: (fileH || dirH).name }, 'last');
    } catch (e) { /* non-fatal */ }
  }
  async function getLast() {
    try {
      var db = await idb();
      return await new Promise(function (res) {
        var g = db.transaction('h').objectStore('h').get('last');
        g.onsuccess = function () { res(g.result || null); };
        g.onerror = function () { res(null); };
      });
    } catch (e) { return null; }
  }
  async function persistStartDir(dirH) {
    try {
      var db = await idb();
      db.transaction('h', 'readwrite').objectStore('h').put(dirH, 'startDir');
    } catch (e) { /* non-fatal */ }
  }
  async function getStartDir() {
    try {
      var db = await idb();
      return await new Promise(function (res) {
        var g = db.transaction('h').objectStore('h').get('startDir');
        g.onsuccess = function () { res(g.result || null); };
        g.onerror = function () { res(null); };
      });
    } catch (e) { return null; }
  }
  async function reopenLast() {
    var last = await getLast();
    if (!last) return;
    var h = last.fileH || last.dirH;
    if (!h) return;
    if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
    }
    if (last.fileH) {
      state.fileHandle = last.fileH; state.dirHandle = null;
      await loadHandle(last.fileH);
    } else {
      state.dirHandle = last.dirH;
      setStartDir(last.dirH);
      await buildTree(last.dirH);
    }
  }

  // ---- collapsible, lazy file tree (folder mode) -----------------------
  async function buildTree(dir) {
    sidebar.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'sb-title';
    title.textContent = dir.name + '/';
    sidebar.appendChild(title);
    await renderDirInto(dir, sidebar, 0);
  }

  async function renderDirInto(dir, container, depth) {
    var entries = [];
    for await (var entry of dir.values()) entries.push(entry);
    entries.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (entry.kind === 'directory') addFolderNode(entry, container, depth);
      else if (/\.(md|markdown|txt)$/i.test(entry.name)) addFileNode(entry, container, depth);
    }
  }

  // A folder is a collapsible row; its children are loaded on first expand.
  function addFolderNode(entry, container, depth) {
    var row = document.createElement('div');
    row.className = 'tree-item dir';
    row.style.paddingLeft = (8 + depth * 14) + 'px';
    var caret = document.createElement('span');
    caret.className = 'caret';
    caret.textContent = '▸';
    var label = document.createElement('span');
    label.textContent = entry.name;
    row.appendChild(caret);
    row.appendChild(label);
    var childBox = document.createElement('div');
    childBox.style.display = 'none';
    var loaded = false;
    row.addEventListener('click', async function () {
      if (childBox.style.display !== 'none') {
        childBox.style.display = 'none';
        caret.textContent = '▸';
      } else {
        caret.textContent = '▾';
        if (!loaded) { loaded = true; await renderDirInto(entry, childBox, depth + 1); }
        childBox.style.display = 'block';
      }
    });
    container.appendChild(row);
    container.appendChild(childBox);
  }

  function addFileNode(entry, container, depth) {
    var f = document.createElement('div');
    f.className = 'tree-item';
    f.style.paddingLeft = (24 + depth * 14) + 'px';
    f.textContent = entry.name;
    f.addEventListener('click', async function () {
      var prev = sidebar.querySelector('.tree-item.active');
      if (prev) prev.classList.remove('active');
      f.classList.add('active');
      state.fileHandle = entry;
      await loadHandle(entry);
    });
    container.appendChild(f);
  }

  function toggleSidebar() { sidebar.classList.toggle('hidden'); }

  // ---- outline (single-file mode) --------------------------------------
  function renderSidebarOutline() {
    sidebar.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'sb-title';
    title.textContent = 'Outline';
    sidebar.appendChild(title);
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      if (b.type !== 'heading') continue;
      var mm = b.raw.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/m);
      if (!mm) continue;
      var level = mm[1].length;
      var text = mm[2];
      var item = document.createElement('div');
      item.className = 'outline-item h' + level;
      item.textContent = text;
      (function (idx) {
        item.addEventListener('click', function () {
          var el = docEl.querySelector('.block[data-idx="' + idx + '"]');
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      })(i);
      sidebar.appendChild(item);
    }
  }

  // ---- core render ------------------------------------------------------
  function setSource(text) {
    state.source = text;
    relex();
    renderAll();
  }
  function relex() {
    state.blocks = MDCore.lexBlocks(state.source);
    state.comments = MDCore.parseComments(state.source, state.settings.responder);
    for (var i = 0; i < state.comments.length; i++) state.comments[i].id = i;
  }

  function renderAll() {
    $('empty').style.display = state.source ? 'none' : 'flex';
    docEl.style.display = state.source ? 'block' : 'none';
    if (!state.source) { marginEl.innerHTML = ''; return; }
    var scroll = docwrap.scrollTop; // preserve scroll across full re-render
    renderDocument();
    renderComments();
    if (!state.dirHandle) renderSidebarOutline();
    $('clearComments').style.display = state.comments.length ? 'inline-block' : 'none';
    $('exportPdf').style.display = state.source ? 'inline-block' : 'none';
    docwrap.scrollTop = scroll;
    marginEl.scrollTop = scroll;
  }

  function sanitize(html) {
    return DOMPurify.sanitize(html, { ADD_ATTR: ['data-gk', 'class'], ADD_TAGS: ['span'] });
  }

  function renderDocument() {
    var byBlock = MDCore.commentsByBlock(state.blocks, state.comments);
    var html = '';
    for (var i = 0; i < state.blocks.length; i++) {
      var b = state.blocks[i];
      if (b.type === 'space') continue;
      html += '<div class="block" data-idx="' + i + '">' + renderBlockInner(b, byBlock[i] || []) + '</div>';
    }
    docEl.innerHTML = html;
    // syntax highlight
    var codes = docEl.querySelectorAll('pre code');
    for (var c = 0; c < codes.length; c++) {
      try { window.hljs.highlightElement(codes[c]); } catch (e) {}
    }
  }

  // Render one block to sanitized HTML, replacing each GK comment with an
  // empty marker span so we can anchor highlights/cards to its position.
  function renderBlockInner(block, comments) {
    var raw = block.raw;
    var sorted = comments.slice().sort(function (a, b) { return b.start - a.start; });
    for (var i = 0; i < sorted.length; i++) {
      var c = sorted[i];
      var ls = c.start - block.start;
      var le = c.end - block.start;
      raw = raw.slice(0, ls) + '<span class="gkmark" data-gk="' + c.id + '"></span>' + raw.slice(le);
    }
    return sanitize(MDCore.mdToHtml(raw));
  }

  // ---- comments: margin cards + anchored highlights --------------------
  function renderComments() {
    marginEl.innerHTML = '';
    if (!state.comments.length) {
      var em = document.createElement('div');
      em.className = 'margin-empty';
      em.textContent = 'No comments. Select text in the document to add one.';
      marginEl.appendChild(em);
      CSS.highlights && CSS.highlights.delete('gk-span');
      return;
    }
    var inner = document.createElement('div');
    inner.id = 'marginInner';
    marginEl.appendChild(inner);
    var spanHL = (typeof Highlight !== 'undefined') ? new Highlight() : null;
    state._ranges = {};
    var cards = [];
    for (var i = 0; i < state.comments.length; i++) {
      var c = state.comments[i];
      var marker = docEl.querySelector('.gkmark[data-gk="' + c.id + '"]');
      if (marker) {
        var range = anchorWordRange(marker.closest('.block'), marker);
        if (range && spanHL && !range.collapsed) spanHL.add(range);
        state._ranges[c.id] = range;
      }
      var card = buildCard(c, marker);
      cards.push({ card: card, marker: marker });
      inner.appendChild(card);
    }
    if (spanHL && CSS.highlights) CSS.highlights.set('gk-span', spanHL);
    layoutCards(cards, inner);
  }

  // Map a global character offset (within the concatenated text of `nodes`) to
  // a (textNode, offset) DOM position.
  function charToNodeOffset(nodes, pos) {
    for (var i = 0; i < nodes.length; i++) {
      if (pos <= nodes[i].start + nodes[i].len) {
        return { node: nodes[i].node, offset: pos - nodes[i].start };
      }
    }
    var last = nodes[nodes.length - 1];
    return { node: last.node, offset: last.len };
  }

  // A Range covering only the single word immediately preceding `marker` (the
  // word the comment attaches to). Returns null if there is no preceding word
  // (e.g. a standalone comment), in which case nothing is highlighted.
  function anchorWordRange(blockEl, marker) {
    if (!blockEl) return null;
    var walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var total = 0;
    var n;
    while ((n = walker.nextNode())) {
      // only text that comes BEFORE the marker in document order
      if (marker.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      nodes.push({ node: n, start: total, len: n.nodeValue.length });
      total += n.nodeValue.length;
    }
    if (!total) return null;
    var text = nodes.map(function (x) { return x.node.nodeValue; }).join('');
    var wb = MDCore.lastWordRange(text); // single word before the marker (tested rule)
    if (!wb) return null;
    var s = charToNodeOffset(nodes, wb.start);
    var e = charToNodeOffset(nodes, wb.end);
    var range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  }

  function buildCard(c, marker) {
    var card = document.createElement('div');
    card.className = 'comment-card ' + c.variant;
    card.dataset.id = c.id;
    var tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = c.tag;
    var body = document.createElement('div');
    body.className = 'body';
    body.textContent = c.body;
    card.appendChild(tag);
    card.appendChild(body);
    if (c.claude) {
      var cl = document.createElement('div');
      cl.className = 'claude';
      var ct = document.createElement('span'); ct.className = 'tag'; ct.textContent = state.settings.responder;
      var cb = document.createElement('div'); cb.className = 'body'; cb.textContent = c.claude;
      cl.appendChild(ct); cl.appendChild(cb); card.appendChild(cl);
    }
    var actions = document.createElement('div');
    actions.className = 'actions';
    var edit = document.createElement('a'); edit.textContent = 'edit';
    var del = document.createElement('a'); del.className = 'del'; del.textContent = 'delete';
    edit.addEventListener('click', function (e) { e.stopPropagation(); editComment(c); });
    del.addEventListener('click', function (e) { e.stopPropagation(); deleteComment(c); });
    actions.appendChild(edit); actions.appendChild(del);
    card.appendChild(actions);
    card.addEventListener('click', function () { focusComment(c.id); });
    return card;
  }

  // Position cards next to their anchor, pushing down to avoid overlap. Cards
  // live in `inner`, a spacer the full height of the document, so #margin scrolls
  // (kept in sync with the document) instead of overflowing the viewport.
  function layoutCards(cards, inner) {
    var docRect = docEl.getBoundingClientRect();
    var prevBottom = 8;
    var measured = cards.map(function (item) {
      var top = 8;
      if (item.marker) {
        var r = item.marker.getBoundingClientRect();
        top = (r.top - docRect.top);
      }
      return { card: item.card, top: top };
    });
    measured.sort(function (a, b) { return a.top - b.top; });
    for (var i = 0; i < measured.length; i++) {
      var t = Math.max(measured[i].top, prevBottom);
      measured[i].card.style.top = t + 'px';
      prevBottom = t + measured[i].card.offsetHeight + 8;
    }
    inner.style.height = docEl.scrollHeight + 'px';
  }

  function focusComment(id) {
    state.activeComment = id;
    var cards = marginEl.querySelectorAll('.comment-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.toggle('active', cards[i].dataset.id == id);
    var range = state._ranges && state._ranges[id];
    if (range && typeof Highlight !== 'undefined' && CSS.highlights && !range.collapsed) {
      var hl = new Highlight(); hl.add(range); CSS.highlights.set('gk-span-active', hl);
    }
    var marker = docEl.querySelector('.gkmark[data-gk="' + id + '"]');
    if (marker) marker.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---- comment write path ----------------------------------------------
  function nodeBlock(node) {
    if (!node) return null;
    var el = node.nodeType === 1 ? node : node.parentElement;
    return el ? el.closest('.block') : null;
  }

  // Snapshot the live selection into everything we need (text, the rendered
  // prefix for disambiguation, the block index, and a viewport rect). Captured
  // eagerly because clicking the comment button can clear the live selection.
  function captureSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return null;
    var anchorBlock = nodeBlock(sel.anchorNode);
    var focusBlock = nodeBlock(sel.focusNode);
    if (!anchorBlock || anchorBlock !== focusBlock) return null;
    var r0 = sel.getRangeAt(0);
    var endRange = document.createRange();
    endRange.selectNodeContents(anchorBlock);
    endRange.setEnd(r0.endContainer, r0.endOffset);
    return {
      text: sel.toString(),
      prefix: endRange.toString(),
      blockIdx: parseInt(anchorBlock.dataset.idx, 10),
      rect: r0.getBoundingClientRect(),
    };
  }

  function onDocMouseUp(e) {
    if (state.editing != null) return;
    setTimeout(function () {
      var ps = captureSelection();
      state.pendingSel = ps;
      if (!ps) { commentBtn.classList.remove('open'); return; }
      var wrapRect = docwrap.getBoundingClientRect();
      commentBtn.style.left = (ps.rect.right - wrapRect.left + docwrap.scrollLeft + 4) + 'px';
      commentBtn.style.top = (ps.rect.top - wrapRect.top + docwrap.scrollTop - 4) + 'px';
      commentBtn.classList.add('open');
    }, 0);
  }

  function beginNewComment() {
    var ps = state.pendingSel || captureSelection();
    if (!ps) return;
    var block = state.blocks[ps.blockIdx];
    var pos = MDCore.locateInsertOffset(block.raw, block.start, ps.prefix, ps.text);
    if (pos == null) pos = block.end - (block.raw.match(/\n*$/)[0].length); // fallback: end of content
    commentBtn.classList.remove('open');
    openComposer({ type: 'new', pos: pos }, '', 'GK', ps.rect);
  }

  function editComment(c) {
    var marker = docEl.querySelector('.gkmark[data-gk="' + c.id + '"]');
    var rect = marker ? marker.getBoundingClientRect() : null;
    openComposer({ type: 'edit', comment: c }, c.body, c.tag, rect);
  }

  function deleteComment(c) {
    state.source = MDCore.removeCommentBytes(state.source, c.start, c.end);
    relex(); renderAll(); scheduleSave(true);
  }

  function clearAllComments() {
    if (!state.comments.length) return;
    state.source = MDCore.removeAllComments(state.source);
    relex(); renderAll(); scheduleSave(true);
  }

  function onClearComments() {
    if (!state.comments.length) return;
    if (window.confirm('Delete all ' + state.comments.length + ' comment(s) from this file?')) {
      clearAllComments();
    }
  }

  // Export the rendered document as a PDF. In Electron this writes a real file
  // (printToPDF in main + save dialog); in the browser it opens the print
  // dialog where the user can choose "Save as PDF". Both use the @media print
  // stylesheet for a clean, light, chrome-free document.
  function exportPDF() {
    if (!state.source) return;
    var base = (state.fileName || 'document').replace(/\.(md|markdown|txt)$/i, '') + '.pdf';
    if (window.electronAPI && window.electronAPI.exportPDF) {
      window.electronAPI.exportPDF(base).then(function (res) {
        if (res && res.filePath) toast('Exported PDF: ' + res.filePath);
        else if (res && res.error) toast('PDF export failed: ' + res.error);
      });
    } else {
      window.print();
    }
  }

  // ---- comment-style settings (customizable tag + responder) -----------
  function loadSettings() {
    try {
      var raw = localStorage.getItem('mdviewer.settings');
      if (raw) {
        var s = JSON.parse(raw);
        if (s.prefix) state.settings.prefix = s.prefix;
        if (s.responder) state.settings.responder = s.responder;
      }
    } catch (e) { /* defaults */ }
  }
  function persistSettings() {
    try { localStorage.setItem('mdviewer.settings', JSON.stringify(state.settings)); }
    catch (e) { /* non-fatal */ }
  }
  // Tags are uppercase letters/digits; responder allows letters/digits/-.
  function cleanPrefix(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
  function cleanResponder(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16); }

  // Build the composer's variant dropdown from the configured prefix.
  function populateVariants() {
    var sel = composer.querySelector('select');
    sel.innerHTML = '';
    for (var i = 0; i < KINDS.length; i++) {
      var tag = state.settings.prefix + KINDS[i];
      var opt = document.createElement('option');
      opt.value = tag; opt.textContent = tag;
      sel.appendChild(opt);
    }
  }

  function openSettings() {
    $('setPrefix').value = state.settings.prefix;
    $('setResponder').value = state.settings.responder;
    $('prefixPreview').textContent = state.settings.prefix;
    $('respPreview').textContent = state.settings.responder;
    showModal('settings');
    $('setPrefix').focus();
  }
  function saveSettings() {
    var prefix = cleanPrefix($('setPrefix').value) || DEFAULT_SETTINGS.prefix;
    var responder = cleanResponder($('setResponder').value) || DEFAULT_SETTINGS.responder;
    state.settings.prefix = prefix;
    state.settings.responder = responder;
    persistSettings();
    populateVariants();
    closeModal();
    if (state.source) { relex(); renderAll(); } // re-split audit trails, recolor
  }

  // ---- modals -----------------------------------------------------------
  function showModal(id) {
    $('modalBackdrop').classList.remove('hidden');
    $(id).classList.remove('hidden');
  }
  function closeModal() {
    $('modalBackdrop').classList.add('hidden');
    $('settings').classList.add('hidden');
    $('help').classList.add('hidden');
  }

  function openComposer(mode, body, tag, anchorRect) {
    state.composerMode = mode;
    var sel = composer.querySelector('select');
    // Editing a comment with a foreign prefix (e.g. a collaborator's "AB-FIX"):
    // make sure its exact tag is selectable so saving preserves it.
    var want = tag || state.settings.prefix;
    if (want && !Array.prototype.some.call(sel.options, function (o) { return o.value === want; })) {
      var opt = document.createElement('option');
      opt.value = want; opt.textContent = want; sel.insertBefore(opt, sel.firstChild);
    }
    sel.value = want;
    var ta = composer.querySelector('textarea');
    ta.value = body || '';
    var wrapRect = docwrap.getBoundingClientRect();
    var rect = anchorRect;
    // Ignore an empty/zero rect (e.g. a display:none element) and fall back.
    if (!rect || (rect.width === 0 && rect.height === 0 && rect.left === 0 && rect.top === 0)) {
      rect = { left: wrapRect.left + 40, bottom: wrapRect.top + 40 };
    }
    var left = rect.left - wrapRect.left + docwrap.scrollLeft;
    left = Math.max(8, Math.min(left, docwrap.clientWidth - 304));
    var top = rect.bottom - wrapRect.top + docwrap.scrollTop + 6;
    composer.style.left = left + 'px';
    composer.style.top = top + 'px';
    composer.classList.add('open');
    ta.focus();
  }

  function closeComposer() { composer.classList.remove('open'); state.composerMode = null; }

  function submitComposer() {
    var mode = state.composerMode;
    if (!mode) return;
    var tag = composer.querySelector('select').value;
    var body = composer.querySelector('textarea').value.trim();
    if (!body) { closeComposer(); return; }
    var text = MDCore.serializeComment(tag, body);
    if (mode.type === 'new') {
      state.source = MDCore.spliceSource(state.source, mode.pos, mode.pos, text);
    } else {
      state.source = MDCore.spliceSource(state.source, mode.comment.start, mode.comment.end, text);
    }
    closeComposer();
    relex(); renderAll(); scheduleSave(true);
  }

  // ---- block editing ----------------------------------------------------
  function autosize(ta) { ta.style.height = 'auto'; ta.style.height = (ta.scrollHeight + 2) + 'px'; }

  function enterEdit(idx) {
    var block = state.blocks[idx];
    if (!block || block.type === 'space') return;
    state.editing = idx;
    commentBtn.classList.remove('open');
    var blockEl = docEl.querySelector('.block[data-idx="' + idx + '"]');
    var trailer = block.raw.match(/\n*$/)[0];
    var editText = block.raw.slice(0, block.raw.length - trailer.length);
    blockEl.classList.add('editing');
    blockEl.innerHTML = '';
    var ta = document.createElement('textarea');
    ta.className = 'block-editor';
    ta.value = editText;
    blockEl.appendChild(ta);
    var hint = document.createElement('div');
    hint.className = 'edit-hint';
    hint.textContent = '⌘↵ or click away to save · esc to cancel';
    blockEl.appendChild(hint);
    autosize(ta);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = editText.length;
    ta._trailer = trailer; ta._block = block;
    ta.addEventListener('input', function () { autosize(ta); });
    ta.addEventListener('keydown', onEditKey);
    ta.addEventListener('blur', function () { commitEdit(idx); });
  }

  function onEditKey(e) {
    var ta = e.target;
    if (e.key === 'Escape') {
      e.preventDefault();
      state.escaping = true;
      state.editing = null;
      renderAll();
      state.escaping = false;
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      ta.blur();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      var s = ta.selectionStart, en = ta.selectionEnd;
      ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + 2;
      autosize(ta);
    }
  }

  function commitEdit(idx) {
    if (state.editing !== idx || state.escaping) return;
    var blockEl = docEl.querySelector('.block[data-idx="' + idx + '"]');
    if (!blockEl) { state.editing = null; return; }
    var ta = blockEl.querySelector('textarea');
    if (!ta) { state.editing = null; return; }
    var block = ta._block;
    var newRaw = ta.value + ta._trailer;
    state.editing = null;
    if (newRaw === block.raw) { renderAll(); return; }
    state.source = MDCore.replaceRange(state.source, block.start, block.end, newRaw);
    relex(); renderAll(); scheduleSave();
  }

  // ---- global events ----------------------------------------------------
  function onDocClick(e) {
    if (state.editing != null) return;
    if (e.target.closest('.gkmark')) return;
    var a = e.target.closest('a');
    if (a && (e.metaKey || e.ctrlKey)) { window.open(a.href, '_blank'); return; }
    if (a) e.preventDefault();
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // selection -> comment flow
    var blockEl = e.target.closest('.block');
    if (blockEl) enterEdit(parseInt(blockEl.dataset.idx, 10));
  }

  function init() {
    docEl = $('doc'); docwrap = $('docwrap'); marginEl = $('margin');
    sidebar = $('sidebar'); composer = $('composer'); commentBtn = $('commentBtn');
    toastEl = $('toast');

    loadSettings();
    populateVariants();

    $('openFile').addEventListener('click', openFile);
    $('openFolder').addEventListener('click', openFolder);
    $('emptyOpen').addEventListener('click', openFile);
    $('clearComments').addEventListener('click', onClearComments);
    $('exportPdf').addEventListener('click', exportPDF);
    $('toggleSidebar').addEventListener('click', toggleSidebar);
    $('settingsBtn').addEventListener('click', openSettings);
    $('helpBtn').addEventListener('click', function () { showModal('help'); });
    $('helpClose').addEventListener('click', closeModal);
    $('helpOk').addEventListener('click', closeModal);
    $('setSave').addEventListener('click', saveSettings);
    $('setCancel').addEventListener('click', closeModal);
    $('modalBackdrop').addEventListener('click', closeModal);
    $('setPrefix').addEventListener('input', function () {
      $('prefixPreview').textContent = cleanPrefix(this.value) || DEFAULT_SETTINGS.prefix;
    });
    $('setResponder').addEventListener('input', function () {
      $('respPreview').textContent = cleanResponder(this.value) || DEFAULT_SETTINGS.responder;
    });
    docEl.addEventListener('click', onDocClick);
    docEl.addEventListener('mouseup', onDocMouseUp);
    commentBtn.addEventListener('click', beginNewComment);
    composer.querySelector('.primary').addEventListener('click', submitComposer);
    composer.querySelector('.cancel').addEventListener('click', closeComposer);
    composer.querySelector('textarea').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitComposer(); }
      if (e.key === 'Escape') { e.preventDefault(); closeComposer(); }
    });
    docwrap.addEventListener('scroll', function () { marginEl.scrollTop = docwrap.scrollTop; });
    window.addEventListener('resize', function () { if (state.source) renderComments(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('modalBackdrop').classList.contains('hidden')) { closeModal(); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); writeFile(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    });

    // Remember the folder to start pickers in (set once you open a folder).
    getStartDir().then(function (d) { if (d) state.startDir = d; });

    // Offer reopen-last if available.
    getLast().then(function (last) {
      if (last) {
        var btn = $('reopenLast');
        btn.style.display = 'inline-block';
        btn.textContent = 'Reopen ' + (last.name || 'last');
        btn.addEventListener('click', reopenLast);
      }
    });

    if (!window.showOpenFilePicker) {
      toast('This browser lacks the File System Access API. Use Chrome, Edge, or Brave.');
    }

    if (location.search.indexOf('selftest') !== -1 || location.search.indexOf('e2e') !== -1) {
      window.__mdv = {
        setSource: setSource, getSource: function () { return state.source; },
        state: state, beginNewComment: beginNewComment, submitComposer: submitComposer,
        composer: composer, enterEdit: enterEdit, commitEdit: commitEdit,
        deleteComment: deleteComment, writeFile: writeFile,
        clearAllComments: clearAllComments,
        pickerStart: pickerStart, setStartDir: setStartDir,
        toggleSidebar: toggleSidebar, buildTree: buildTree, exportPDF: exportPDF,
        sidebar: function () { return sidebar; },
        openSettings: openSettings, saveSettings: saveSettings, showModal: showModal,
        closeModal: closeModal, populateVariants: populateVariants,
      };
    }
    if (location.search.indexOf('selftest') !== -1) setTimeout(runSelfTest, 50);

    // Electron: open files handed in by Finder / the app menu, routing I/O
    // through the native fs bridge exposed by preload.js.
    if (window.electronAPI) {
      window.electronAPI.onOpenPath(function (p) { openElectronPath(p); });
      if (window.electronAPI.onMenuAction) {
        window.electronAPI.onMenuAction(function (a) {
          if (a === 'open-file') openFile();
          else if (a === 'open-folder') openFolder();
          else if (a === 'export-pdf') exportPDF();
          else if (a === 'toggle-sidebar') toggleSidebar();
        });
      }
      window.electronAPI.ready();
    }
  }

  // Browser smoke test for the parts Node cannot cover: the real render
  // pipeline (marked+DOMPurify+hljs), CSS Custom Highlight ranges, card
  // layout, and DOM-selection -> source-offset comment insertion.
  async function runSelfTest() {
    var results = [];
    function check(name, cond) { results.push((cond ? 'PASS' : 'FAIL') + ' ' + name); }
    try {
      var sample =
        '# Heading\n\n' +
        'A paragraph with **bold**, `code`, a [link](http://x), and a phrase ' +
        'computes an initial partition here.\n\n' +
        'Second para with an existing <!-- GK: inline note --> comment.\n\n' +
        '<!-- GK-FIX: a standalone fix -->\n\n' +
        'Audit line <!-- GK: do X / CLAUDE: did X --> end.\n\n' +
        '- list item one\n- list item two\n\n' +
        '| a | b |\n| - | - |\n| 1 | 2 |\n\n' +
        '```js\nconst x = 1;\n```\n';
      setSource(sample);

      check('blocks rendered', docEl.querySelectorAll('.block').length >= 7);
      check('h1 rendered', !!docEl.querySelector('h1'));
      check('table rendered', !!docEl.querySelector('table'));
      check('list rendered', !!docEl.querySelector('ul li'));
      check('bold rendered', !!docEl.querySelector('strong'));
      check('code highlighted (hljs)', !!docEl.querySelector('pre code.hljs'));
      check('comment markers present', docEl.querySelectorAll('.gkmark').length === 3);
      check('margin cards present', marginEl.querySelectorAll('.comment-card').length === 3);
      check('audit-trail CLAUDE shown', !!marginEl.querySelector('.comment-card .claude'));
      check('variant class applied', !!marginEl.querySelector('.comment-card.gk-fix'));
      check('CSS custom highlight registered',
        typeof Highlight !== 'undefined' && CSS.highlights && CSS.highlights.has('gk-span'));
      var firstCard = marginEl.querySelector('.comment-card');
      check('card positioned absolutely', firstCard && firstCard.style.top !== '');

      // Strong content assertions on WHAT is highlighted (the bug the weak
      // ".has('gk-span')" check missed): each comment highlights exactly its
      // one anchor word, a standalone comment highlights nothing.
      var cBody = function (b) { return state.comments.filter(function (c) { return c.body === b; })[0]; };
      var rtext = function (id) { var r = state._ranges[id]; return r ? r.toString() : null; };
      var ic = cBody('inline note'), sc = cBody('a standalone fix'), ac = cBody('do X');
      check('inline comment highlights exactly "existing"', ic && rtext(ic.id) === 'existing');
      check('audit comment highlights exactly "line"', ac && rtext(ac.id) === 'line');
      check('standalone comment highlights nothing',
        sc && (state._ranges[sc.id] == null || state._ranges[sc.id].collapsed));
      var hlset = CSS.highlights.get('gk-span');
      check('one highlight range per anchored word (not the whole run)', hlset && hlset.size === 2);

      // --- write path: select a phrase and insert a comment via real DOM ---
      var para = docEl.querySelectorAll('.block')[1];
      var tn = null;
      var walker = document.createTreeWalker(para, NodeFilter.SHOW_TEXT, null);
      var node;
      while ((node = walker.nextNode())) {
        if (node.nodeValue.indexOf('computes an initial partition') !== -1) { tn = node; break; }
      }
      check('found target text node', !!tn);
      if (tn) {
        var s = tn.nodeValue.indexOf('computes an initial partition');
        var range = document.createRange();
        range.setStart(tn, s);
        range.setEnd(tn, s + 'computes an initial partition'.length);
        var sel = window.getSelection();
        sel.removeAllRanges(); sel.addRange(range);
        // capture the selection's position BEFORE opening the composer (which
        // focuses its textarea and clears the document selection)
        var selLeftInDoc = sel.getRangeAt(0).getBoundingClientRect().left
          - docwrap.getBoundingClientRect().left + docwrap.scrollLeft;
        beginNewComment();
        var cleft = parseFloat(composer.style.left);
        var ctop = parseFloat(composer.style.top);
        check('composer opens within doc bounds (not behind sidebar)',
          cleft >= 0 && cleft <= docwrap.clientWidth && ctop >= 0);
        check('composer anchored near the selection', Math.abs(cleft - selLeftInDoc) < 320);
        composer.querySelector('textarea').value = 'which algorithm?';
        composer.querySelector('select').value = 'GK-Q';
        submitComposer();
        var src = state.source;
        check('comment attached to first word of selection',
          src.indexOf('computes<!-- GK-Q: which algorithm? --> an initial partition') !== -1);
        check('comment count grew to 4', state.comments.length === 4);
        // card vertical alignment: card top tracks its marker's line
        var nc = state.comments.filter(function (c) { return c.body === 'which algorithm?'; })[0];
        var ncCard = marginEl.querySelector('.comment-card[data-id="' + nc.id + '"]');
        var ncMark = docEl.querySelector('.gkmark[data-gk="' + nc.id + '"]');
        var cardTop = parseFloat(ncCard.style.top);
        var markTop = ncMark.getBoundingClientRect().top - docEl.getBoundingClientRect().top;
        check('card aligned to its anchor line', Math.abs(cardTop - markTop) < 24);
        // highlight covers only the single anchored word, not the whole run
        var rng = state._ranges[nc.id];
        check('highlight is the single anchored word', rng && rng.toString() === 'computes');
      }

      // --- block editing: edit the heading block, only it should change ---
      var beforeEdit = state.source;
      var headingIdx = -1;
      for (var bi = 0; bi < state.blocks.length; bi++) {
        if (state.blocks[bi].type === 'heading') { headingIdx = bi; break; }
      }
      enterEdit(headingIdx);
      var ed = docEl.querySelector('.block[data-idx="' + headingIdx + '"] textarea');
      check('block editor opened', !!ed);
      if (ed) {
        ed.value = '# Renamed Heading';
        commitEdit(headingIdx);
        check('edited heading text in source', state.source.indexOf('# Renamed Heading') !== -1);
        check('heading re-rendered', docEl.querySelector('h1').textContent.indexOf('Renamed Heading') !== -1);
        // every byte except the heading line is unchanged
        var tailBefore = beforeEdit.slice(beforeEdit.indexOf('\n\n'));
        var tailAfter = state.source.slice(state.source.indexOf('\n\n'));
        check('only heading block changed', tailBefore === tailAfter);
      }

      // --- delete a comment: removed from source + re-rendered ------------
      var cBefore = state.comments.length;
      var someComment = state.comments[0];
      deleteComment(someComment);
      check('comment removed from source', state.source.indexOf(someComment.raw) === -1);
      check('comment count decreased', state.comments.length === cBefore - 1);

      // --- autosave path: writeFile() must stream the FULL source to the
      // handle via createWritable/write/close and flip the indicator to Saved.
      // (Uses a recording mock handle; the actual byte-to-disk step is the
      // browser's File System Access implementation.)
      var written = null, closed = false;
      state.fileHandle = {
        createWritable: function () {
          return Promise.resolve({
            write: function (data) { written = data; return Promise.resolve(); },
            close: function () { closed = true; return Promise.resolve(); },
          });
        },
      };
      var edited = state.source + '\n\nAppended by autosave test.\n';
      state.source = edited;
      await writeFile();
      check('autosave streams exact source bytes', written === edited);
      check('autosave closes the writable', closed === true);
      check('save indicator returned to Saved', $('saveState').className === 'saved');

      // --- picker start-folder selection ---------------------------------
      var savedStart = state.startDir;
      state.startDir = null;
      check('picker defaults to Documents when no folder remembered', pickerStart() === 'documents');
      var fakeDir = { name: 'agents' };
      setStartDir(fakeDir);
      check('picker starts in the remembered folder', pickerStart() === fakeDir);
      check('remembered folder kept in state', state.startDir === fakeDir);
      state.startDir = savedStart;

      // --- long-doc margin scrolling (the "can't see comments" bug) -------
      var longDoc = '# Long\n\n';
      for (var li = 1; li <= 12; li++) {
        longDoc += '## Section ' + li + '\n\nParagraph ' + li + ' with enough words to fill a line and a bit more.\n\n';
        if (li % 2 === 1) longDoc += '<!-- GK: standalone note ' + li + ' -->\n\n';
      }
      setSource(longDoc);
      check('margin is a viewport-height scroll container (not document-tall)',
        marginEl.getBoundingClientRect().height <= window.innerHeight + 2);
      var lc = state.comments[state.comments.length - 1];
      var lm = docEl.querySelector('.gkmark[data-gk="' + lc.id + '"]');
      var off = lm.getBoundingClientRect().top - docEl.getBoundingClientRect().top;
      docwrap.scrollTop = off - 100;
      marginEl.scrollTop = docwrap.scrollTop;
      var lcard = marginEl.querySelector('.comment-card[data-id="' + lc.id + '"]');
      var crect = lcard.getBoundingClientRect();
      var mrect = lm.getBoundingClientRect();
      check('deep comment card scrolls into view with the document',
        crect.height > 0 && crect.top >= 0 && crect.top <= window.innerHeight);
      check('deep comment card stays aligned to its anchor line',
        Math.abs(crect.top - mrect.top) < 40);
      docwrap.scrollTop = 0;
      marginEl.scrollTop = 0;

      // --- clear all comments --------------------------------------------
      check('comments exist before clear', state.comments.length > 0);
      clearAllComments();
      check('clear removed every comment', state.comments.length === 0);
      check('no GK comment bytes remain', state.source.indexOf('<!-- GK') === -1);
      check('clear button hidden when no comments', $('clearComments').style.display === 'none');

      // --- PDF export button + collapsible sidebar -----------------------
      check('PDF export button present and visible', $('exportPdf') && $('exportPdf').style.display !== 'none');
      check('sidebar starts expanded', !sidebar.classList.contains('hidden'));
      toggleSidebar();
      check('sidebar collapses on toggle', sidebar.classList.contains('hidden'));
      toggleSidebar();
      check('sidebar expands on toggle', !sidebar.classList.contains('hidden'));

      // --- collapsible, lazy file tree (fake directory handle) -----------
      var mkFile = function (name) {
        return { kind: 'file', name: name, getFile: function () {
          return Promise.resolve({ name: name, text: function () { return Promise.resolve('# ' + name); } });
        } };
      };
      var mkDir = function (name, kids) {
        return { kind: 'directory', name: name, values: function () {
          return (function () {
            var i = 0;
            return { next: function () {
              return Promise.resolve(i < kids.length ? { value: kids[i++], done: false } : { value: undefined, done: true });
            }, [Symbol.asyncIterator]: function () { return this; } };
          })();
        } };
      };
      var fakeRoot = mkDir('root', [mkDir('sub', [mkFile('inner.md')]), mkFile('top.md')]);
      state.dirHandle = fakeRoot;
      await buildTree(fakeRoot);
      var dirRows = sidebar.querySelectorAll('.tree-item.dir');
      check('tree renders folder nodes', dirRows.length === 1);
      var childBox = dirRows[0].nextElementSibling;
      check('folder collapsed by default', childBox.style.display === 'none');
      check('children not loaded until expand', childBox.querySelectorAll('.tree-item').length === 0);
      dirRows[0].click();
      await new Promise(function (r) { setTimeout(r, 60); });
      check('folder expands and lazy-loads children',
        childBox.style.display === 'block' && childBox.querySelectorAll('.tree-item').length >= 1);
      dirRows[0].click();
      check('folder collapses again', childBox.style.display === 'none');
      state.dirHandle = null;

      // --- customizable comment style + help ----------------------------
      var savedSettings = { prefix: state.settings.prefix, responder: state.settings.responder };
      populateVariants();
      var optVals = Array.prototype.map.call(composer.querySelectorAll('select option'), function (o) { return o.value; });
      check('composer variants from prefix (GK default)',
        optVals.join(',') === 'GK,GK-FIX,GK-Q,GK-NIT');
      // change the tag prefix + responder via the settings form
      $('setPrefix').value = 'ab!'; $('setResponder').value = 'me';
      saveSettings();
      check('prefix cleaned + uppercased', state.settings.prefix === 'AB');
      check('responder cleaned + uppercased', state.settings.responder === 'ME');
      var optVals2 = Array.prototype.map.call(composer.querySelectorAll('select option'), function (o) { return o.value; });
      check('composer variants update to new prefix', optVals2.join(',') === 'AB,AB-FIX,AB-Q,AB-NIT');
      check('settings persisted to localStorage',
        JSON.parse(localStorage.getItem('mdviewer.settings')).prefix === 'AB');
      // a multi-author doc renders everyone's initials-style comments
      setSource('Para with <!-- GK: from george --> and <!-- AB-FIX: alice fix --> notes, plus an audit <!-- AB: did x / ME: done -->.\n');
      check('renders comments from multiple prefixes', state.comments.length === 3);
      var fix = state.comments.filter(function (c) { return c.tag === 'AB-FIX'; })[0];
      check('AB-FIX colored as a fix (amber)', fix && fix.variant === 'gk-fix');
      var audit = state.comments.filter(function (c) { return c.claude; })[0];
      check('custom responder ME splits audit trail', audit && audit.claude === 'done');
      var card = marginEl.querySelector('.comment-card .claude .tag');
      check('audit card shows the custom responder label', card && card.textContent === 'ME');
      // restore default settings
      state.settings = savedSettings; persistSettings(); populateVariants();

      // help overlay
      showModal('help');
      check('help overlay opens', !$('help').classList.contains('hidden') && !$('modalBackdrop').classList.contains('hidden'));
      check('help explains commenting', $('help').textContent.indexOf('Comment') !== -1);
      closeModal();
      check('help overlay closes', $('help').classList.contains('hidden'));
    } catch (e) {
      results.push('FAIL exception: ' + (e && e.stack ? e.stack : e));
    } finally {
      var pass = results.filter(function (r) { return r.indexOf('PASS') === 0; }).length;
      var fail = results.filter(function (r) { return r.indexOf('FAIL') === 0; }).length;
      var skip = results.filter(function (r) { return r.indexOf('SKIP') === 0; }).length;
      var out = document.createElement('pre');
      out.id = 'selftest-out';
      out.textContent = 'SELFTEST ' + (fail === 0 ? 'OK' : 'FAILED') +
        ' (' + pass + ' pass, ' + fail + ' fail, ' + skip + ' skip)\n' + results.join('\n');
      document.body.appendChild(out);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

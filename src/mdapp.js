/* mdviewer UI. Browser-only (uses DOM / File System Access API / IndexedDB).
 * Depends on globals: MDCore, marked, DOMPurify, hljs. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var docEl, docwrap, marginEl, sidebar, composer, commentBtn, toastEl;

  var KINDS = ['', '-FIX', '-Q', '-NIT']; // suffixes appended to the prefix
  // Named document-font stacks offered in Settings -> Appearance.
  var FONTS = {
    system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    sans: "'Helvetica Neue', Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', Times, serif",
    charter: "'Charter', 'New York', 'Iowan Old Style', Palatino, Georgia, serif",
    mono: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  };
  var DEFAULT_SETTINGS = { prefix: 'GK', responder: 'CLAUDE', wrap: 'auto', font: 'system', size: 15 };

  // Window-level state: shared across every open tab in this window.
  var app = {
    dirHandle: null,      // the open folder (its tree fills the sidebar), or null
    startDir: null,       // directory handle used as the picker's startIn
    settings: { prefix: 'GK', responder: 'CLAUDE', wrap: 'auto', font: 'system', size: 15 }, // comment style + wrap + appearance
    tabs: [],             // one document per open file
    active: -1,           // index into tabs of the visible document, or -1 (none)
  };

  // A fresh per-tab document. Everything that belongs to one open file lives
  // here, so tabs never bleed into one another: source, disk baseline, parsed
  // blocks/comments, the open editor, the pending autosave, find state, and the
  // scroll position to restore when this tab is shown again.
  function newDoc() {
    return {
      fileHandle: null,
      detectedWidth: 0,   // hard-wrap column inferred from the loaded file
      source: '',
      diskSource: '',     // bytes last read from / written to disk (the clean baseline)
      blocks: [],
      comments: [],
      fileName: '',
      saveState: 'saved', // saved | saving | dirty | error, restored on tab switch
      saveMsg: '',
      editing: null,      // index of block being edited, or null
      escaping: false,    // set while cancelling an edit
      saveTimer: null,
      activeComment: null,// id of focused comment
      composerMode: null, // {type:'new', pos} or {type:'edit', comment}
      pendingSel: null,
      scrollTop: 0,       // document scroll to restore when this tab is shown
      search: { open: false, query: '', matches: [], current: -1 },
      _ranges: {},
    };
  }

  // `state` always points at the active tab's document. Reassigned by
  // activateTab, so every existing `state.foo` reference reads/writes the
  // visible file. A placeholder until the first file opens.
  var state = newDoc();

  // The effective hard-wrap width: 'auto' uses the width detected from the
  // file; a number forces it; 0 (or unset) disables re-wrapping on save.
  function effectiveWrap() {
    var w = app.settings.wrap;
    if (w == null || w === 'auto') return state.detectedWidth || 0;
    var n = parseInt(w, 10);
    return isFinite(n) && n > 0 ? n : 0;
  }

  // ---- save state indicator --------------------------------------------
  // Record the save state on `doc`, paint the toolbar when it is the visible
  // tab, and refresh every tab's unsaved dot. Restored when a tab is reshown.
  function setDocSaveState(doc, s, msg) {
    doc.saveState = s;
    doc.saveMsg = msg || '';
    if (doc === state) paintSaveState(s, msg);
    refreshTabsDirty();
  }
  function paintSaveState(s, msg) {
    var el = $('saveState');
    el.className = s;
    var labels = { saved: 'Saved', saving: 'Saving…', dirty: 'Unsaved', error: msg || 'Save error' };
    el.querySelector('.label').textContent = labels[s] || '';
  }
  function setSaveState(s, msg) { setDocSaveState(state, s, msg); }

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    setTimeout(function () { toastEl.classList.remove('show'); }, 4000);
  }

  // ---- tabs -------------------------------------------------------------
  // A stable identity for a handle, so opening the same file twice focuses the
  // existing tab instead of duplicating it. Electron handles carry the absolute
  // path; browser handles fall back to the file name.
  function docKey(h) { return h ? (h._electronPath || h.name || null) : null; }

  // On launch, a browser window opened via "Move to New Window" carries a
  // ?tearoff=<id> pointing at a file handle stashed in IndexedDB. Adopt it.
  async function handleTearoff() {
    var m = location.search.match(/[?&]tearoff=([^&]+)/);
    if (!m) return;
    try {
      var h = await idbGet('tearoff', m[1]);
      if (!h) return;
      if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted') {
        if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') return;
      }
      await openInTab(h);
    } catch (e) { /* ignore a stale or unreadable handoff */ }
  }

  function isDocDirty(doc) { return doc.source !== doc.diskSource; }

  // Open a handle in a tab: focus it if already open, else append a new tab,
  // make it active, and load the file into it.
  async function openInTab(handle) {
    var key = docKey(handle);
    if (key != null) {
      for (var i = 0; i < app.tabs.length; i++) {
        if (docKey(app.tabs[i].fileHandle) === key) { activateTab(i); return; }
      }
    }
    var doc = newDoc();
    doc.fileHandle = handle;
    app.tabs.push(doc);
    activateTab(app.tabs.length - 1, true); // repoint state; loadHandle renders
    await loadHandle(handle);
    renderTabs();
  }

  // Make tab `i` the visible one. Commits an open editor on the tab we leave (so
  // typed text is never lost) and remembers its scroll, then repoints `state`,
  // renders, and restores the target tab's scroll. `skipRender` is set when the
  // caller (a fresh file load) will render the document itself.
  function activateTab(i, skipRender) {
    if (i < 0 || i >= app.tabs.length) return;
    if (app.active >= 0 && app.active !== i && app.tabs[app.active]) {
      if (state.editing != null) commitEdit(state.editing);
      app.tabs[app.active].scrollTop = docwrap ? docwrap.scrollTop : 0;
    }
    app.active = i;
    state = app.tabs[i];
    renderTabs();
    if (skipRender) return;
    paintSaveState(state.saveState, state.saveMsg);
    renderAll();
    if (docwrap) { docwrap.scrollTop = state.scrollTop; marginEl.scrollTop = state.scrollTop; }
  }

  // Close tab `i`. Flushes unsaved bytes to disk first so closing never loses
  // work, then activates a neighbor (or shows the empty state if it was last).
  async function closeTab(i) {
    var doc = app.tabs[i];
    if (!doc) return;
    clearTimeout(doc.saveTimer);
    if (doc.fileHandle && isDocDirty(doc)) await writeDoc(doc);
    app.tabs.splice(i, 1);
    if (app.tabs.length === 0) {
      app.active = -1;
      state = newDoc();
      paintSaveState('saved');
      renderAll();
      renderTabs();
      return;
    }
    var next = i < app.active ? app.active - 1 : Math.min(app.active, app.tabs.length - 1);
    app.active = -1; // closed tab is gone; skip activateTab's leave-handling
    activateTab(next);
  }

  function closeActiveTab() { if (app.active >= 0) closeTab(app.active); }
  function stepTab(dir) {
    if (app.tabs.length < 2) return;
    activateTab((app.active + dir + app.tabs.length) % app.tabs.length);
  }

  // Rebuild the tab strip. Hidden when nothing is open.
  function renderTabs() {
    var bar = $('tabbar');
    if (!bar) return;
    bar.innerHTML = '';
    bar.style.display = app.tabs.length ? 'flex' : 'none';
    for (var i = 0; i < app.tabs.length; i++) {
      bar.appendChild(buildTab(app.tabs[i], i));
    }
  }
  function buildTab(doc, i) {
    var tab = document.createElement('div');
    tab.className = 'tab' + (i === app.active ? ' active' : '') + (isDocDirty(doc) ? ' dirty' : '');
    tab.title = doc.fileName || 'Untitled';
    var title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = doc.fileName || 'Untitled';
    var dot = document.createElement('span');
    dot.className = 'tab-dot';
    var close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close tab (⌘W)';
    close.addEventListener('click', function (e) { e.stopPropagation(); closeTab(i); });
    tab.appendChild(dot);
    tab.appendChild(title);
    tab.appendChild(close);
    tab.addEventListener('click', function () { activateTab(i); });
    tab.addEventListener('auxclick', function (e) { if (e.button === 1) { e.preventDefault(); closeTab(i); } });
    tab.addEventListener('contextmenu', function (e) { e.preventDefault(); showTabMenu(e.clientX, e.clientY, i); });
    return tab;
  }
  function refreshTabsDirty() {
    var bar = $('tabbar');
    if (!bar) return;
    var els = bar.querySelectorAll('.tab');
    for (var i = 0; i < els.length && i < app.tabs.length; i++) {
      els[i].classList.toggle('dirty', isDocDirty(app.tabs[i]));
    }
  }

  // Right-click tab menu: move to a new window, or close.
  function showTabMenu(x, y, i) {
    hideTabMenu();
    var menu = document.createElement('div');
    menu.id = 'tabMenu';
    menu.className = 'ctx-menu';
    var items = [
      ['Move to New Window', function () { moveTabToNewWindow(i); }],
      ['Close', function () { closeTab(i); }],
      ['Close Others', function () { closeOtherTabs(i); }],
    ];
    items.forEach(function (it) {
      var row = document.createElement('div');
      row.className = 'ctx-item';
      row.textContent = it[0];
      row.addEventListener('click', function () { hideTabMenu(); it[1](); });
      menu.appendChild(row);
    });
    document.body.appendChild(menu);
    menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 8) + 'px';
    menu.style.top = y + 'px';
    setTimeout(function () { document.addEventListener('mousedown', hideTabMenu, { once: true }); }, 0);
  }
  function hideTabMenu() { var m = $('tabMenu'); if (m) m.remove(); }

  async function closeOtherTabs(keep) {
    var keepDoc = app.tabs[keep];
    for (var i = app.tabs.length - 1; i >= 0; i--) {
      if (app.tabs[i] !== keepDoc) { app.active = app.tabs.indexOf(keepDoc); await closeTab(i); }
    }
  }

  // Move a tab into its own OS window. In Electron the main process spawns a
  // real window for the file; in the browser we open a second app window and
  // hand it the file handle through IndexedDB. Either way the source tab closes.
  async function moveTabToNewWindow(i) {
    var doc = app.tabs[i];
    if (!doc || !doc.fileHandle) { toast('Nothing to move'); return; }
    clearTimeout(doc.saveTimer);
    if (isDocDirty(doc)) await writeDoc(doc); // the new window reads from disk
    if (window.electronAPI && window.electronAPI.openInNewWindow && doc.fileHandle._electronPath) {
      window.electronAPI.openInNewWindow(doc.fileHandle._electronPath);
      closeTab(i);
      return;
    }
    if (window.showOpenFilePicker) { // browser: pass the handle via IndexedDB
      try {
        var id = 'tear-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
        await idbPut('tearoff', id, doc.fileHandle);
        var w = window.open(location.pathname + '?tearoff=' + id, '_blank');
        if (w) { closeTab(i); return; }
      } catch (e) { /* fall through */ }
    }
    toast('Move to a new window needs the desktop app');
  }

  // ---- file access ------------------------------------------------------
  // The picker's starting directory: the last folder opened (persisted), else
  // the OS Documents folder. Browsers do not allow an arbitrary absolute path,
  // so the default becomes ~/agents once you open it once.
  function pickerStart() { return app.startDir || 'documents'; }

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
      await openInTab(picked[0]);
    } catch (e) { if (e.name !== 'AbortError') toast('Open failed: ' + e.message); }
  }

  async function openFolder() {
    try {
      var dir = await runPicker(window.showDirectoryPicker.bind(window));
      if (!dir) return;
      app.dirHandle = dir;
      setStartDir(dir);
      await buildTree(dir);
    } catch (e) { if (e.name !== 'AbortError') toast('Open folder failed: ' + e.message); }
  }

  function setStartDir(dirH) {
    app.startDir = dirH;
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
      await openInTab(electronFileHandle(path));
    } catch (e) { toast('Open failed: ' + e.message); }
  }

  async function loadHandle(h) {
    var file = await h.getFile();
    state.fileName = h.name; // shown on the tab
    applyLoadedText(await file.text());
  }

  // Install `text` as the current document and mark it clean: it is exactly what
  // is on disk. Abandons any open editor and cancels a pending autosave so a
  // stale write cannot fire afterward. Shared by the initial load and reload.
  function applyLoadedText(text) {
    clearTimeout(state.saveTimer);
    state.editing = null;
    setSource(text);
    state.diskSource = text;   // clean baseline: memory == disk
    setSaveState('saved');
    if (!app.dirHandle) renderSidebarOutline();
  }

  // Saving is bound to an explicit doc, never the global `state`. A queued
  // autosave must write the file it was scheduled for even if the user has since
  // switched tabs (which repoints `state` at a different document).
  async function writeDoc(doc) {
    if (!doc.fileHandle) return;
    try {
      setDocSaveState(doc, 'saving');
      var bytes = doc.source;                // snapshot: source may change mid-write
      var w = await doc.fileHandle.createWritable();
      await w.write(bytes);
      await w.close();
      doc.diskSource = bytes;                // these bytes are now the clean baseline
      setDocSaveState(doc, 'saved');
    } catch (e) {
      setDocSaveState(doc, 'error', 'Save failed');
      toast('Save failed: ' + e.message);
    }
  }
  function scheduleSaveDoc(doc, immediate) {
    setDocSaveState(doc, 'dirty');
    clearTimeout(doc.saveTimer);
    if (immediate) { writeDoc(doc); return; }
    doc.saveTimer = setTimeout(function () { writeDoc(doc); }, 500);
  }

  // Thin wrappers over the active document, so the many existing call sites keep
  // working unchanged.
  function writeFile() { return writeDoc(state); }
  function scheduleSave(immediate) { scheduleSaveDoc(state, immediate); }

  // Re-read the current file from disk, discarding the in-memory copy, to pick
  // up an external change (the app does not watch the file). Reloading destroys
  // whatever is in memory, so if the in-memory copy holds edits that never
  // reached disk (an autosave still pending, or a failed write), we STOP and let
  // the user save that work to a separate file first rather than lose it.
  async function reloadFromDisk() {
    if (!state.fileHandle) { toast('No file to reload'); return; }
    var disk;
    try { disk = await (await state.fileHandle.getFile()).text(); }
    catch (e) { toast('Reload failed: ' + e.message); return; }
    if (disk === state.source) { toast('Already up to date'); return; }
    // Unsaved edits = the in-memory copy diverges from the clean baseline we last
    // read or wrote. If so, flag it before discarding; otherwise reload straight.
    if (state.source !== state.diskSource) { showModal('reloadPrompt'); return; }
    applyLoadedText(disk);
    toast('Reloaded from disk');
  }

  // Re-read the file fresh and install it. Called from the reload prompt after
  // the user has decided; re-reading (rather than reusing the earlier read)
  // picks up anything an autosave flushed while the prompt was open.
  async function applyReloadFromHandle() {
    try {
      applyLoadedText(await (await state.fileHandle.getFile()).text());
      toast('Reloaded from disk');
    } catch (e) { toast('Reload failed: ' + e.message); }
  }

  function discardAndReload() { closeModal(); applyReloadFromHandle(); }

  // Save the current (unsaved) in-memory copy to a NEW file the user picks, then
  // reload the original from disk. On cancel or failure, nothing is reloaded, so
  // the unsaved work stays safe in memory.
  async function saveCopyAndReload() {
    if (!window.showSaveFilePicker) { toast('Save a copy is unavailable in this browser'); return; }
    var name = state.fileName || 'document.md';
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '.md';
    try {
      var opts = { suggestedName: base + '-unsaved' + ext,
        types: [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown'] } }] };
      if (app.startDir) opts.startIn = app.startDir;
      var h = await window.showSaveFilePicker(opts);
      var w = await h.createWritable();
      await w.write(state.source);
      await w.close();
      closeModal();
      toast('Saved a copy to ' + h.name);
      await applyReloadFromHandle();
    } catch (e) {
      if (e.name !== 'AbortError') toast('Save a copy failed: ' + e.message);
    }
  }

  // ---- IndexedDB (picker start dir; browser tab tear-off handoff) ------
  function idb() {
    return new Promise(function (res, rej) {
      var r = indexedDB.open('mdviewer', 1);
      r.onupgradeneeded = function () { r.result.createObjectStore('h'); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  // Generic put/get on the single 'h' store, keyed by namespaced string. Used
  // to hand a file handle to a browser tear-off window ('tearoff:<id>').
  async function idbPut(ns, id, val) {
    var db = await idb();
    db.transaction('h', 'readwrite').objectStore('h').put(val, ns + ':' + id);
  }
  async function idbGet(ns, id) {
    var db = await idb();
    return await new Promise(function (res) {
      var g = db.transaction('h').objectStore('h').get(ns + ':' + id);
      g.onsuccess = function () { res(g.result || null); };
      g.onerror = function () { res(null); };
    });
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
      await openInTab(entry); // each opened file becomes its own tab
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
    state.detectedWidth = MDCore.detectWrapWidth(text); // learn the file's wrap column
    relex();
    renderAll();
  }
  function relex() {
    state.blocks = MDCore.lexBlocks(state.source);
    state.comments = MDCore.parseComments(state.source, app.settings.responder);
    for (var i = 0; i < state.comments.length; i++) state.comments[i].id = i;
  }

  function renderAll() {
    $('empty').style.display = state.source ? 'none' : 'flex';
    docEl.style.display = state.source ? 'block' : 'none';
    if (!state.source) { marginEl.innerHTML = ''; return; }
    var scroll = docwrap.scrollTop; // preserve scroll across full re-render
    renderDocument();
    renderComments();
    if (!app.dirHandle) renderSidebarOutline();
    $('clearComments').style.display = state.comments.length ? 'inline-block' : 'none';
    $('exportPdf').style.display = state.source ? 'inline-block' : 'none';
    docwrap.scrollTop = scroll;
    marginEl.scrollTop = scroll;
    // The re-render replaced the document nodes; rebuild search ranges in place.
    if (state.search.open && state.search.query) runSearch(state.search.query, true);
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
      var ct = document.createElement('span'); ct.className = 'tag'; ct.textContent = app.settings.responder;
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
    openComposer({ type: 'new', pos: pos }, '', app.settings.prefix, ps.rect);
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
        if (s.prefix) app.settings.prefix = s.prefix;
        if (s.responder) app.settings.responder = s.responder;
        if (s.wrap != null) app.settings.wrap = s.wrap;
        if (s.font && FONTS[s.font]) app.settings.font = s.font;
        if (s.size != null) app.settings.size = cleanSize(s.size);
      }
    } catch (e) { /* defaults */ }
  }
  function persistSettings() {
    try { localStorage.setItem('mdviewer.settings', JSON.stringify(app.settings)); }
    catch (e) { /* non-fatal */ }
  }
  // Tags are uppercase letters/digits; responder allows letters/digits/-.
  function cleanPrefix(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6); }
  function cleanResponder(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 16); }
  // Wrap setting: 'auto', or a non-negative integer as a string (0 = off).
  function cleanWrap(s) {
    var t = String(s == null ? '' : s).trim().toLowerCase();
    if (t === '' || t === 'auto') return 'auto';
    var n = parseInt(t, 10);
    if (!isFinite(n) || n < 0) return 'auto';
    return String(Math.min(n, 400));
  }
  // Document font size in px, clamped to a sane range.
  function cleanSize(s) {
    var n = parseInt(s, 10);
    if (!isFinite(n)) return DEFAULT_SETTINGS.size;
    return Math.max(11, Math.min(n, 28));
  }
  // Push the appearance settings into CSS custom properties on :root. The
  // document reads --doc-font / --doc-size; headings, code, and tables are em-
  // scaled so they follow the base size.
  function applyAppearance() {
    var root = document.documentElement;
    root.style.setProperty('--doc-font', FONTS[app.settings.font] || FONTS.system);
    root.style.setProperty('--doc-size', cleanSize(app.settings.size) + 'px');
  }

  // Build the composer's variant dropdown from the configured prefix.
  function populateVariants() {
    var sel = composer.querySelector('select');
    sel.innerHTML = '';
    for (var i = 0; i < KINDS.length; i++) {
      var tag = app.settings.prefix + KINDS[i];
      var opt = document.createElement('option');
      opt.value = tag; opt.textContent = tag;
      sel.appendChild(opt);
    }
  }

  function openSettings() {
    $('setFont').value = FONTS[app.settings.font] ? app.settings.font : 'system';
    $('setSize').value = cleanSize(app.settings.size);
    $('setPrefix').value = app.settings.prefix;
    $('setResponder').value = app.settings.responder;
    $('setWrap').value = app.settings.wrap === 'auto' ? '' : app.settings.wrap;
    $('prefixPreview').textContent = app.settings.prefix;
    $('respPreview').textContent = app.settings.responder;
    showModal('settings');
    $('setFont').focus();
  }
  function saveSettings() {
    var prefix = cleanPrefix($('setPrefix').value) || DEFAULT_SETTINGS.prefix;
    var responder = cleanResponder($('setResponder').value) || DEFAULT_SETTINGS.responder;
    app.settings.prefix = prefix;
    app.settings.responder = responder;
    app.settings.wrap = cleanWrap($('setWrap').value);
    app.settings.font = FONTS[$('setFont').value] ? $('setFont').value : 'system';
    app.settings.size = cleanSize($('setSize').value);
    persistSettings();
    applyAppearance();
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
    $('reloadPrompt').classList.add('hidden');
  }

  function openComposer(mode, body, tag, anchorRect) {
    state.composerMode = mode;
    var sel = composer.querySelector('select');
    // Editing a comment with a foreign prefix (e.g. a collaborator's "AB-FIX"):
    // make sure its exact tag is selectable so saving preserves it.
    var want = tag || app.settings.prefix;
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
    var at;
    if (mode.type === 'new') {
      at = mode.pos;
      state.source = MDCore.spliceSource(state.source, mode.pos, mode.pos, text);
    } else {
      at = mode.comment.start;
      state.source = MDCore.spliceSource(state.source, mode.comment.start, mode.comment.end, text);
    }
    // Splicing a comment into a paragraph can overrun the wrap column; re-wrap
    // its host block so the saved line stays within the constraint.
    state.source = MDCore.rewrapAt(state.source, at, effectiveWrap());
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
    ta._trailer = trailer; ta._block = block; ta._orig = editText;
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
    // A click is how you ENTER the editor, and clicking away is how you leave
    // it, so an untouched block must never be written. Re-wrapping is not
    // guaranteed idempotent, so deciding this on the POST-wrap bytes would let
    // a stray click silently reflow (and reformat) a block the user only looked
    // at. Compare what is in the textarea against what we put there.
    if (ta.value === ta._orig) { state.editing = null; renderAll(); return; }
    var newRaw = ta.value + ta._trailer;
    // Re-hard-wrap prose to the file's column width so the saved file keeps its
    // line-length constraint. Only paragraphs; code/tables/lists stay verbatim.
    if (block.type === 'paragraph') newRaw = MDCore.wrapBlockRaw(newRaw, effectiveWrap());
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

  // ---- find in document (⌘F) -------------------------------------------
  // Builds a flat index of the document's text nodes, finds every occurrence of
  // the query, and paints them with the CSS Custom Highlight API (all matches
  // dim, the current match bright). Ranges are recomputed whenever the document
  // re-renders, so highlights survive edits while the bar is open.
  function docTextIndex() {
    var walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, null);
    var nodes = [];
    var total = 0;
    var n;
    while ((n = walker.nextNode())) {
      var len = n.nodeValue.length;
      nodes.push({ node: n, start: total, len: len });
      total += len;
    }
    return { nodes: nodes, text: nodes.map(function (x) { return x.node.nodeValue; }).join('') };
  }

  function clearSearchHighlights() {
    if (CSS && CSS.highlights) { CSS.highlights.delete('search'); CSS.highlights.delete('search-current'); }
  }

  function paintSearch() {
    if (typeof Highlight === 'undefined' || !CSS.highlights) return;
    var all = new Highlight(), cur = new Highlight();
    for (var i = 0; i < state.search.matches.length; i++) {
      if (i === state.search.current) cur.add(state.search.matches[i]);
      else all.add(state.search.matches[i]);
    }
    if (all.size) CSS.highlights.set('search', all); else CSS.highlights.delete('search');
    if (cur.size) CSS.highlights.set('search-current', cur); else CSS.highlights.delete('search-current');
  }

  function updateSearchUI() {
    var n = state.search.matches.length;
    var c = $('searchCount');
    if (!state.search.query) c.textContent = '';
    else if (!n) c.textContent = 'No results';
    else c.textContent = (state.search.current + 1) + ' of ' + n;
  }

  function runSearch(query, keepCurrent) {
    var changed = query !== state.search.query;
    state.search.query = query;
    clearSearchHighlights();
    var ranges = [];
    if (query && state.source) {
      var idx = docTextIndex();
      var hay = idx.text.toLowerCase();
      var needle = query.toLowerCase();
      var from = 0, pos;
      while ((pos = hay.indexOf(needle, from)) !== -1) {
        var s = charToNodeOffset(idx.nodes, pos);
        var e = charToNodeOffset(idx.nodes, pos + needle.length);
        var r = document.createRange();
        try { r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset); ranges.push(r); }
        catch (err) { /* skip an un-rangeable span */ }
        from = pos + needle.length;
        if (ranges.length > 5000) break;
      }
    }
    state.search.matches = ranges;
    if (!ranges.length) state.search.current = -1;
    else if (changed && !keepCurrent) state.search.current = 0;
    else state.search.current = Math.max(0, Math.min(state.search.current, ranges.length - 1));
    paintSearch();
    updateSearchUI();
    if (!keepCurrent && state.search.current >= 0) scrollToMatch(state.search.current);
  }

  function scrollToMatch(i) {
    var r = state.search.matches[i];
    if (!r) return;
    var rect = r.getBoundingClientRect();
    var wrapRect = docwrap.getBoundingClientRect();
    if (rect.top < wrapRect.top + 56 || rect.bottom > wrapRect.bottom - 16) {
      docwrap.scrollTop += (rect.top - wrapRect.top) - docwrap.clientHeight / 2;
      marginEl.scrollTop = docwrap.scrollTop;
    }
  }

  function searchStep(dir) {
    var n = state.search.matches.length;
    if (!n) return;
    state.search.current = (state.search.current + dir + n) % n;
    paintSearch();
    updateSearchUI();
    scrollToMatch(state.search.current);
  }

  function openSearch() {
    state.search.open = true;
    $('searchbar').classList.remove('hidden');
    var inp = $('searchInput');
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) inp.value = sel.toString().trim();
    inp.focus(); inp.select();
    if (inp.value) runSearch(inp.value);
  }

  function closeSearch() {
    state.search.open = false;
    $('searchbar').classList.add('hidden');
    clearSearchHighlights();
    state.search.matches = []; state.search.current = -1;
  }

  // ---- resizable panels -------------------------------------------------
  function applyLayout(layout) {
    if (!layout) return;
    var root = document.documentElement;
    if (layout.sidebar) root.style.setProperty('--sidebar-w', layout.sidebar + 'px');
    if (layout.margin) root.style.setProperty('--margin-w', layout.margin + 'px');
  }
  function persistLayout() {
    try {
      var cs = getComputedStyle(document.documentElement);
      localStorage.setItem('mdviewer.layout', JSON.stringify({
        sidebar: parseInt(cs.getPropertyValue('--sidebar-w'), 10),
        margin: parseInt(cs.getPropertyValue('--margin-w'), 10),
      }));
    } catch (e) { /* non-fatal */ }
  }
  function loadLayout() {
    try {
      var raw = localStorage.getItem('mdviewer.layout');
      if (raw) applyLayout(JSON.parse(raw));
    } catch (e) { /* defaults */ }
  }
  function setupGutter(el, side) {
    el.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var shellRect = $('shell').getBoundingClientRect();
      el.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      function onMove(ev) {
        var w;
        if (side === 'left') {
          w = Math.max(140, Math.min(ev.clientX - shellRect.left, 560));
          document.documentElement.style.setProperty('--sidebar-w', w + 'px');
        } else {
          w = Math.max(180, Math.min(shellRect.right - ev.clientX, 680));
          document.documentElement.style.setProperty('--margin-w', w + 'px');
        }
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        el.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        persistLayout();
        if (state.source) renderComments();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  function init() {
    docEl = $('doc'); docwrap = $('docwrap'); marginEl = $('margin');
    sidebar = $('sidebar'); composer = $('composer'); commentBtn = $('commentBtn');
    toastEl = $('toast');

    loadSettings();
    applyAppearance();
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
    $('reloadCancel').addEventListener('click', closeModal);
    $('reloadDiscard').addEventListener('click', discardAndReload);
    $('reloadSaveAs').addEventListener('click', saveCopyAndReload);
    $('modalBackdrop').addEventListener('click', closeModal);
    $('setPrefix').addEventListener('input', function () {
      $('prefixPreview').textContent = cleanPrefix(this.value) || DEFAULT_SETTINGS.prefix;
    });
    $('setResponder').addEventListener('input', function () {
      $('respPreview').textContent = cleanResponder(this.value) || DEFAULT_SETTINGS.responder;
    });

    // find-in-document bar
    $('searchInput').addEventListener('input', function () { runSearch(this.value); });
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); docwrap.focus(); }
    });
    $('searchNext').addEventListener('click', function () { searchStep(1); });
    $('searchPrev').addEventListener('click', function () { searchStep(-1); });
    $('searchClose').addEventListener('click', closeSearch);

    // resizable panels
    loadLayout();
    setupGutter($('gutterLeft'), 'left');
    setupGutter($('gutterRight'), 'right');

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
      if (e.key === 'Escape' && state.search.open) { e.preventDefault(); closeSearch(); return; }
      var mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); openSearch(); }
      else if (mod && (e.key === 'g' || e.key === 'G')) {
        if (state.search.open) { e.preventDefault(); searchStep(e.shiftKey ? -1 : 1); }
      }
      else if (mod && e.key === 's') { e.preventDefault(); writeFile(); }
      else if (mod && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
      else if (mod && (e.key === 'r' || e.key === 'R') && !e.shiftKey) { e.preventDefault(); reloadFromDisk(); }
      else if (mod && e.key === 'w' && !e.shiftKey) { e.preventDefault(); closeActiveTab(); }
      else if (e.ctrlKey && e.key === 'Tab') { e.preventDefault(); stepTab(e.shiftKey ? -1 : 1); }
    });

    renderTabs();          // hidden until a file opens
    handleTearoff();       // browser: adopt a tab handed over from another window

    // Remember the folder to start pickers in (set once you open a folder).
    getStartDir().then(function (d) { if (d) app.startDir = d; });

    if (!window.showOpenFilePicker) {
      toast('This browser lacks the File System Access API. Use Chrome, Edge, or Brave.');
    }

    if (location.search.indexOf('selftest') !== -1 || location.search.indexOf('e2e') !== -1) {
      window.__mdv = {
        setSource: setSource, getSource: function () { return state.source; },
        beginNewComment: beginNewComment, submitComposer: submitComposer,
        composer: composer, enterEdit: enterEdit, commitEdit: commitEdit,
        deleteComment: deleteComment, writeFile: writeFile,
        reloadFromDisk: reloadFromDisk, scheduleSave: scheduleSave,
        discardAndReload: discardAndReload, saveCopyAndReload: saveCopyAndReload,
        clearAllComments: clearAllComments,
        pickerStart: pickerStart, setStartDir: setStartDir,
        toggleSidebar: toggleSidebar, buildTree: buildTree, exportPDF: exportPDF,
        sidebar: function () { return sidebar; },
        openSettings: openSettings, saveSettings: saveSettings, showModal: showModal,
        closeModal: closeModal, populateVariants: populateVariants,
        openSearch: openSearch, closeSearch: closeSearch, runSearch: runSearch,
        searchStep: searchStep, effectiveWrap: effectiveWrap,
        applyAppearance: applyAppearance, FONTS: FONTS,
        app: app, openInTab: openInTab, closeTab: closeTab, activateTab: activateTab,
        closeActiveTab: closeActiveTab, stepTab: stepTab, renderTabs: renderTabs,
        moveTabToNewWindow: moveTabToNewWindow, newDoc: newDoc,
      };
      // `state` is reassigned on every tab switch, so expose it as a live getter
      // rather than a snapshot (the e2e driver reads __mdv.state.comments etc.).
      Object.defineProperty(window.__mdv, 'state', { get: function () { return state; } });
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
          else if (a === 'reload-file') reloadFromDisk();
          else if (a === 'close-tab') closeActiveTab();
          else if (a === 'move-tab-new-window') { if (app.active >= 0) moveTabToNewWindow(app.active); }
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
    function skip(name) { results.push('SKIP ' + name); }
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
      var savedStart = app.startDir;
      app.startDir = null;
      check('picker defaults to Documents when no folder remembered', pickerStart() === 'documents');
      var fakeDir = { name: 'agents' };
      setStartDir(fakeDir);
      check('picker starts in the remembered folder', pickerStart() === fakeDir);
      check('remembered folder kept in state', app.startDir === fakeDir);
      app.startDir = savedStart;

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
      app.dirHandle = fakeRoot;
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
      app.dirHandle = null;

      // --- customizable comment style + help ----------------------------
      var savedSettings = { prefix: app.settings.prefix, responder: app.settings.responder, wrap: app.settings.wrap, font: app.settings.font, size: app.settings.size };
      populateVariants();
      var optVals = Array.prototype.map.call(composer.querySelectorAll('select option'), function (o) { return o.value; });
      check('composer variants from prefix (GK default)',
        optVals.join(',') === 'GK,GK-FIX,GK-Q,GK-NIT');
      // change the tag prefix + responder via the settings form
      $('setPrefix').value = 'ab!'; $('setResponder').value = 'me';
      saveSettings();
      check('prefix cleaned + uppercased', app.settings.prefix === 'AB');
      check('responder cleaned + uppercased', app.settings.responder === 'ME');
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
      // a new comment must default to YOUR prefix, not a hardcoded "GK"
      var pw = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, null), ptn = null, pn;
      while ((pn = pw.nextNode())) { if (pn.nodeValue.indexOf('Para') !== -1) { ptn = pn; break; } }
      check('found paragraph text node', !!ptn);
      if (ptn) {
        var pr = document.createRange();
        var pi = ptn.nodeValue.indexOf('Para');
        pr.setStart(ptn, pi); pr.setEnd(ptn, pi + 4);
        var psel = window.getSelection(); psel.removeAllRanges(); psel.addRange(pr);
        state.pendingSel = null;
        beginNewComment();
        check('new comment defaults to the configured prefix',
          composer.querySelector('select').value === 'AB');
        composer.querySelector('textarea').value = '';
        submitComposer(); // empty body: closes the composer, writes nothing
        check('empty composer body writes no comment', state.comments.length === 3);
      }
      // restore default settings
      app.settings = savedSettings; persistSettings(); populateVariants();

      // help overlay
      showModal('help');
      check('help overlay opens', !$('help').classList.contains('hidden') && !$('modalBackdrop').classList.contains('hidden'));
      check('help explains commenting', $('help').textContent.indexOf('Comment') !== -1);
      closeModal();
      check('help overlay closes', $('help').classList.contains('hidden'));

      // --- find in document (⌘F) -----------------------------------------
      app.settings.wrap = '0'; // keep editing tests below from re-wrapping yet
      setSource('# Doc\n\nThe word target appears here, and target again, plus TARGET upper.\n\nAnother para with no hits at all.\n');
      openSearch();
      $('searchInput').value = 'target';
      runSearch('target');
      check('search finds all matches, case-insensitively', state.search.matches.length === 3);
      check('search registers a CSS custom highlight',
        typeof Highlight !== 'undefined' && CSS.highlights && CSS.highlights.has('search-current'));
      check('search count shows current position', $('searchCount').textContent === '1 of 3');
      check('current match text equals the query', state.search.matches[0].toString().toLowerCase() === 'target');
      searchStep(1);
      check('search next advances the current match', state.search.current === 1 && $('searchCount').textContent === '2 of 3');
      searchStep(-1);
      check('search prev steps back', state.search.current === 0);
      runSearch('nonexistent-zzz');
      check('search reports no results', state.search.matches.length === 0 && $('searchCount').textContent === 'No results');
      closeSearch();
      check('search closes and clears its highlights',
        !state.search.open && !(CSS.highlights && CSS.highlights.has('search')));

      // --- hard-wrap on save: forced width -------------------------------
      var firstPara = function () {
        for (var i = 0; i < state.blocks.length; i++) if (state.blocks[i].type === 'paragraph') return i;
        return -1;
      };
      app.settings.wrap = '24';
      setSource('Edit me please.\n');
      var wi = firstPara();
      enterEdit(wi);
      docEl.querySelector('.block[data-idx="' + wi + '"] textarea').value =
        'one two three four five six seven eight nine ten eleven twelve';
      commitEdit(wi);
      var wlines = state.source.replace(/\n+$/, '').split('\n');
      check('edited paragraph hard-wrapped to <=24 columns',
        wlines.length > 1 && wlines.every(function (l) { return l.length <= 24; }));
      check('wrapping preserved every word',
        state.source.replace(/\n/g, ' ').trim() === 'one two three four five six seven eight nine ten eleven twelve');

      // --- hard-wrap on save: auto-detected width ------------------------
      app.settings.wrap = 'auto';
      var sample40 = MDCore.wrapText(
        'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho', 40);
      setSource(sample40 + '\n');
      check('auto detects the file wrap column', state.detectedWidth > 0 && state.detectedWidth <= 40);
      check('effective wrap follows auto-detection', effectiveWrap() === state.detectedWidth);
      var ai = firstPara();
      enterEdit(ai);
      docEl.querySelector('.block[data-idx="' + ai + '"] textarea').value = sample40.replace(/\n/g, ' ');
      commitEdit(ai);
      check('auto re-wrap reproduces the file wrapping exactly',
        state.source.replace(/\n+$/, '') === sample40);

      // --- a click must never rewrite the file --------------------------
      // Clicking a block ENTERS the editor and clicking away commits it, so
      // opening a block and leaving it untouched must be a pure no-op. The old
      // guard compared post-wrap bytes, which let a stray click silently reflow
      // a block the user only looked at.
      app.settings.wrap = 'auto';
      var outline = [
        '3.7 Persist check-failure detail in the run record (deferred from the work order;',
        '    today the detail survives only in the console output).',
        '3.8 Harden the external-evidence machinery it inherits from arm B: `external.py`',
        "    should scope quote matching to the claim's own source block.",
        '',
      ].join('\n');
      setSource(outline);
      check('a numbered outline is one paragraph, not a list',
        state.blocks[0].type === 'paragraph');
      var oi = firstPara();
      enterEdit(oi);
      commitEdit(oi); // opened and left alone: the user typed nothing
      check('clicking a block and leaving it does NOT rewrite the file',
        state.source === outline);
      check('hanging indents survive an untouched click',
        state.source.indexOf('\n    today the detail') !== -1);
      check('numbered items do not weld together on click',
        state.source.indexOf('\n3.8 Harden') !== -1);

      // Even a REAL edit must not reflow authored plain-text layout.
      enterEdit(oi);
      docEl.querySelector('.block[data-idx="' + oi + '"] textarea').value =
        outline.replace(/\n+$/, '') + '\n3.9 A new item.';
      commitEdit(oi);
      check('a real edit still preserves the outline layout',
        state.source.indexOf('\n    today the detail') !== -1 &&
        state.source.indexOf('\n3.9 A new item.') !== -1);

      // --- reload from disk (⌘R) -----------------------------------------
      // A fake handle whose bytes we can change out from under the app, standing
      // in for an external edit. `written` records what the app writes through
      // the handle so we can verify a save-a-copy target.
      var savedFH = state.fileHandle;
      var diskText = 'line one\nline two on disk\n';
      var written = null;
      state.fileHandle = {
        name: 'reload.md',
        getFile: function () {
          return Promise.resolve({ name: 'reload.md', text: function () { return Promise.resolve(diskText); } });
        },
        createWritable: function () {
          return Promise.resolve({ write: function (d) { written = d; return Promise.resolve(); },
            close: function () { return Promise.resolve(); } });
        },
      };
      state.fileName = 'reload.md';

      // A clean reload (no unsaved edits) applies disk bytes straight, abandons
      // an open editor, and cancels a queued autosave.
      applyLoadedText('in memory, clean\n'); // sets diskSource == source
      diskText = 'externally changed\n';
      var rwrote = false;
      state.saveTimer = setTimeout(function () { rwrote = true; }, 5);
      state.editing = 0;
      await reloadFromDisk();
      check('clean reload takes the external disk bytes', state.source === 'externally changed\n');
      check('reload abandons the open editor', state.editing === null);
      await new Promise(function (r) { setTimeout(r, 20); });
      check('reload cancels the queued autosave', rwrote === false);

      // No divergence: reload is a no-op ("Already up to date").
      var beforeNoop = state.source;
      await reloadFromDisk();
      check('reload with no changes leaves the document untouched', state.source === beforeNoop);

      // Unsaved edits + an external change: reload must STOP and flag it, not
      // silently discard the in-memory work.
      applyLoadedText('shared base\n');
      state.source = 'shared base\nmy unsaved edit\n';   // dirty: source != diskSource
      diskText = 'shared base\nsomeone elses edit\n';    // and disk moved too
      await reloadFromDisk();
      check('unsaved edits raise the reload prompt', !$('reloadPrompt').classList.contains('hidden'));
      check('the prompt does not touch the document', state.source === 'shared base\nmy unsaved edit\n');

      // "Save a Copy" writes the in-memory version to a new file, then reloads.
      var picked = { name: 'reload-unsaved.md',
        createWritable: function () {
          return Promise.resolve({ write: function (d) { written = d; return Promise.resolve(); },
            close: function () { return Promise.resolve(); } });
        } };
      var realPicker = window.showSaveFilePicker;
      window.showSaveFilePicker = function () { return Promise.resolve(picked); };
      await saveCopyAndReload();
      window.showSaveFilePicker = realPicker;
      check('save-a-copy writes the unsaved in-memory version', written === 'shared base\nmy unsaved edit\n');
      check('after saving the copy, the original reloads from disk',
        state.source === 'shared base\nsomeone elses edit\n');
      check('the reload prompt closes after saving a copy',
        $('reloadPrompt').classList.contains('hidden'));

      // "Discard & Reload" throws the unsaved edit away and takes disk.
      applyLoadedText('base\n');
      state.source = 'base\nunsaved\n';
      diskText = 'base\ndisk wins\n';
      await reloadFromDisk();
      check('discard path is offered for unsaved edits', !$('reloadPrompt').classList.contains('hidden'));
      discardAndReload();
      await new Promise(function (r) { setTimeout(r, 10); });
      check('discard & reload takes the disk version', state.source === 'base\ndisk wins\n');

      state.fileHandle = savedFH;
      state.fileName = '';

      // --- resizable panels: gutter drag adjusts widths ------------------
      var shellRect = $('shell').getBoundingClientRect();
      var gl = $('gutterLeft');
      gl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: shellRect.left + 240 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: shellRect.left + 320 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      var sbw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-w'), 10);
      check('left gutter drag resizes the sidebar', sbw === 320);
      check('panel layout persisted to localStorage',
        JSON.parse(localStorage.getItem('mdviewer.layout')).sidebar === 320);
      var gr = $('gutterRight');
      gr.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: shellRect.right - 350 }));
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: shellRect.right - 350 }));
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      var mgw = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--margin-w'), 10);
      check('right gutter drag resizes the comment margin', mgw === 350);
      check('left gutter hides with the sidebar',
        getComputedStyle((sidebar.classList.add('hidden'), $('gutterLeft'))).display === 'none');
      sidebar.classList.remove('hidden');

      // --- appearance: document font + size ------------------------------
      openSettings();
      $('setFont').value = 'serif';
      $('setSize').value = '20';
      saveSettings();
      var rootStyle = getComputedStyle(document.documentElement);
      check('font setting applied to --doc-font',
        rootStyle.getPropertyValue('--doc-font').indexOf('Georgia') !== -1);
      check('font size applied to --doc-size',
        rootStyle.getPropertyValue('--doc-size').trim() === '20px');
      check('document picks up the font size',
        Math.round(parseFloat(getComputedStyle(docEl).fontSize)) === 20);
      check('appearance persisted to localStorage',
        JSON.parse(localStorage.getItem('mdviewer.settings')).font === 'serif');
      // out-of-range size is clamped
      openSettings(); $('setSize').value = '400'; saveSettings();
      check('oversized font size clamped to 28', app.settings.size === 28);
      // unknown font falls back to system
      app.settings.font = 'bogus'; applyAppearance();
      check('unknown font falls back to system',
        getComputedStyle(document.documentElement).getPropertyValue('--doc-font').indexOf('-apple-system') !== -1);

      app.settings = savedSettings; persistSettings(); applyAppearance();

      // --- tabs: multiple files, isolation, per-tab autosave, close ------
      function fakeHandle(name, text) {
        var store = { text: text };
        return {
          name: name, _electronPath: '/x/' + name, _store: store,
          getFile: function () {
            return Promise.resolve({ name: name, text: function () { return Promise.resolve(store.text); } });
          },
          createWritable: function () {
            return Promise.resolve({ write: function (d) { store.text = d; return Promise.resolve(); },
              close: function () { return Promise.resolve(); } });
          },
        };
      }
      while (app.tabs.length) app.tabs.pop();
      app.active = -1;
      var hA = fakeHandle('a.md', '# Alpha\n\naaa aaa aaa\n');
      var hB = fakeHandle('b.md', '# Bravo\n\nbbb bbb bbb\n');
      await openInTab(hA);
      check('opening a file creates a tab', app.tabs.length === 1 && app.active === 0);
      check('tab bar is shown with one tab',
        $('tabbar').style.display === 'flex' && $('tabbar').querySelectorAll('.tab').length === 1);
      check('the tab shows the opened content', state.source.indexOf('Alpha') !== -1);
      await openInTab(hB);
      check('a second file adds a tab and does not replace the first',
        app.tabs.length === 2 && app.active === 1 && state.source.indexOf('Bravo') !== -1);
      await openInTab(hA);
      check('reopening an open file focuses it (no duplicate)', app.tabs.length === 2 && app.active === 0);

      state = app.tabs[1]; app.active = 1; // (activateTab keeps state in sync; assert isolation)
      activateTab(0);
      state.source = '# Alpha\n\nedited in A\n';
      activateTab(1);
      check('tab B is unaffected by an edit made in tab A', state.source.indexOf('edited in A') === -1);
      activateTab(0);
      check('returning to tab A preserves its in-memory edit', state.source.indexOf('edited in A') !== -1);

      // per-tab autosave binding: a save queued on B must write B even after we
      // switch to A (the old global-timer design would have written the wrong file).
      var bDoc = app.tabs[1];
      bDoc.source = '# Bravo\n\nautosave me\n';
      scheduleSaveDoc(bDoc, false); // 500 ms debounce
      activateTab(0); // state now points at A
      await new Promise(function (r) { setTimeout(r, 560); });
      check('a queued autosave writes the tab it was scheduled for', hB._store.text.indexOf('autosave me') !== -1);
      check('and does not write the other tab', hA._store.text.indexOf('autosave me') === -1);

      await closeTab(app.active === 0 ? 1 : 0); // close B
      check('closing a tab removes it', app.tabs.length === 1);
      await closeTab(0);
      check('closing the last tab shows the empty state',
        app.tabs.length === 0 && $('empty').style.display === 'flex' && $('tabbar').style.display === 'none');

      // move a tab to a new window. In the packaged app electronAPI is a
      // read-only contextBridge object we cannot stub, and actually invoking
      // tear-off would spawn a real window, so we only drive this in the
      // headless browser run (where electronAPI is absent).
      await openInTab(hA);
      if (!window.electronAPI) {
        var movedPath = null;
        window.electronAPI = { openInNewWindow: function (p) { movedPath = p; } };
        await moveTabToNewWindow(0);
        delete window.electronAPI;
        check('move-to-new-window asks Electron to open the file path', movedPath === '/x/a.md');
        check('the moved tab is closed locally', app.tabs.length === 0);
      } else {
        skip('move-to-new-window (Electron tear-off, covered by the headless run)');
        while (app.tabs.length) app.tabs.pop();
        app.active = -1; state = newDoc();
      }
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

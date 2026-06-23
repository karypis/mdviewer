# mdviewer — Specification

A local, single-file web app for viewing, inline-editing, and commenting on Markdown
files, with comments stored in your established `<!-- GK: ... -->` convention. This
spec is for your review before any code is written.

## 1. Goal

Build a tool that lets you:

1. Open a Markdown file and see it rendered correctly (GFM, highlighted code).
2. Edit the file in place while viewing it, with changes saved to disk automatically.
3. Select a span of text, attach a comment, and have that comment persisted into the
   source file as an inline `<!-- GK: <comment> -->` HTML comment.
4. Re-open any file containing such comments and have the viewer render them (as margin
   notes), not show them as raw text.

## 2. Locked decisions

These were confirmed and are not open for re-litigation in this spec.

| Area        | Decision                                                             |
| ----------- | -------------------------------------------------------------------- |
| Delivery    | Single-file HTML web app using the File System Access API (Chromium) |
| Edit model  | Inline block editing: click a block, edit its raw markdown, blur     |
| Comments UI | Margin notes in a right-hand sidebar, aligned to the commented span  |
| MD features | GitHub Flavored Markdown + code syntax highlighting                  |
| Out         | No math/KaTeX, no Mermaid, no collab, no cloud sync (see Non-goals)  |

## 3. Delivery and technology

- **Runtime:** Chromium browsers only (Chrome, Edge, Brave). The File System Access API
  (`showOpenFilePicker`, `showDirectoryPicker`, writable streams) is not available in
  Safari or Firefox. This matches the constraint already documented for `gkpv.html`.

- **No build step, no server.** Open the app's HTML file directly (or from a local file
  server if `file://` proves limiting for a given library). All app CSS and JS live
  inline in the one HTML file, exactly like `gkpv.html` and `calendar.html`.

- **Vendored libraries** (rendering needs more than a hand-rolled parser can safely
  cover):

| Library      | Purpose                                            |
| ------------ | -------------------------------------------------- |
| marked       | GFM parsing with a token lexer exposing raw source |
| DOMPurify    | Sanitize rendered HTML (you fixed XSS in calendar) |
| highlight.js | Fenced-code syntax highlighting                    |

All of these are **inlined** into one self-contained `mdviewer.html` (your decision):
library JS/CSS pasted inline. The file works fully offline with no sibling assets.
Expected size well under ~0.5 MB now that math (KaTeX + its fonts) is dropped. Math
support can be added later by vendoring KaTeX; see Non-goals.

## 4. Layout

A three-column shell with a top toolbar. Dark theme only, matching the palette of
your existing apps.

```
┌─────────────────────────────────────────────────────────────────────┐
│ Toolbar: [Open File] [Open Folder]   file.md   ● Saved   [☀/☾]        │
├───────────────┬─────────────────────────────────────┬───────────────┤
│ Left sidebar  │ Document (rendered + inline-editable)│ Comments      │
│               │                                      │ margin        │
│ • file tree   │ # Heading                            │ ┌───────────┐ │
│   (folder) or │ paragraph text with a ░highlighted░  │ │ GK: note  │ │
│ • outline /   │ span that has a comment ───────────────▶│ aligned   │ │
│   TOC (single │                                      │ │ to span   │ │
│   file)       │ - list item                          │ └───────────┘ │
│               │ ```code block (highlighted)```       │               │
│               │ | table | cell |                     │               │
└───────────────┴─────────────────────────────────────┴───────────────┘
```

- **Left sidebar.** When a folder is opened, a tree of `.md` files (click to open),
  like `gkpv.html`'s folder navigation. When a single file is opened, the sidebar
  shows the document outline (headings) for quick navigation. Collapsible.

- **Center.** The rendered document. Each top-level block is clickable to edit (Section
  6). Commented spans are visually highlighted.

- **Right margin.** One card per comment, vertically aligned to its anchored span.
  Clicking a card scrolls to and flashes the span; clicking a span highlights its
  card.

## 5. File access and autosave

- **Open a file.** `showOpenFilePicker()` filtered to `.md`/`.markdown`/`.txt`. The
  returned handle is read for content and retained for writing.

- **Open a folder.** `showDirectoryPicker()` builds the left file tree; selecting a
  file acquires its handle.

- **Reopen last.** The most recent file/folder handle is stored in IndexedDB so the app
  can offer "Reopen last" on launch (the browser re-prompts for permission once per
  session, which is expected and unavoidable).

- **Autosave.** Writes go to the file handle's writable stream. Triggers:
  - Debounced ~500 ms after the last keystroke in an open block editor.
  - Immediately on block blur / commit (Cmd+Enter, click-away).
  - Immediately on adding, editing, or deleting a comment.

- **Save indicator.** Toolbar shows `Saving…` / `● Saved` / `Unsaved`. Write failures
  surface a non-destructive error and keep the in-memory content intact.

- **Minimal-diff writes.** Saving must never re-serialize the whole document from a
  parsed AST (that would reflow your 85-char wrapping and normalize formatting). The
  app holds the file as a source string and splices only the touched byte range. See
  Section 8.

## 6. Inline block editing

- **Block model.** On load, the source is lexed into ordered top-level blocks (heading,
  paragraph, list, blockquote, table, fenced code, thematic break, HTML/comment
  block). Each rendered block records its exact `[start, end]` offsets in the source
  string (a "source map").

- **Enter edit.** Clicking a block replaces its rendered HTML with an auto-sizing
  `<textarea>` pre-filled with that block's verbatim raw markdown (including any
  inline GK comments it contains).

- **Commit.** On blur, Cmd+Enter, or clicking another block: the edited text is
  re-lexed (it may now be zero, one, or several blocks), spliced back into the source
  string at the block's range, offsets after it are recomputed, the affected region
  is re-rendered, and autosave fires. Esc cancels and restores.

- **Keyboard.** Enter inserts a newline; Cmd+Enter commits; Esc cancels. Tab behavior
  inside the textarea inserts spaces (configurable), it does not leave the field.

- **Fidelity.** Editing one block must leave every other block's bytes untouched. The
  app never rewraps or reformats text you did not edit.

## 7. Comments

### 7.1 Storage format

Comments are stored exactly as your established convention, so files stay compatible
with your existing grep-and-process workflow and render invisibly in GitHub/Notion:

```
<!-- GK: free-form comment text -->
```

The viewer also recognizes and renders your documented variants — `GK-FIX:`, `GK-Q:`,
`GK-NIT:` — and the audit-trail form `<!-- GK: original / CLAUDE: response -->`. New
comments default to the `GK:` tag, with a small dropdown to pick a variant.

### 7.2 Creating a comment

1. In the rendered view, select a span of text. A floating "Comment" affordance appears
   near the selection (and via right-click → Add comment).
2. You type the comment and confirm.
3. The app inserts `<!-- GK: text -->` into the **source** immediately after the **first
   word** of the selected span, splices it in, autosaves, and renders the margin
   card.

Inserting a comment must not reflow the surrounding block.

### 7.3 Anchoring and rendering

Anchoring is **pure mode** (your decision): the `<!-- GK: ... -->` format is kept
byte-identical to your existing convention, with no extra markers ever written.

- **Render.** Every `<!-- GK: ... -->` in the source is parsed out of the rendered flow
  and shown as a margin card aligned to its anchored span. The raw comment text is
  never shown inline in the document body.

- **Anchoring rule.** A new comment is placed right after the first word of the
  selection. When rendered, a comment highlights the inline run of text immediately
  preceding it within the same block, bounded by the start of the block or the end of
  a previous GK comment in that block. The margin card aligns to that anchor's line.

  - Anchoring to the first word keeps the card aligned with the top of what you selected
    (rather than trailing to the end of a multi-line selection).
  - This keeps the comment bytes pure and leaves zero stray markers in your files.

### 7.4 Editing and deleting comments

- Each margin card has edit and delete affordances. Editing rewrites the comment text
  in the source; deleting removes the `<!-- GK: ... -->` entirely (collapsing a blank
  line left by a standalone comment). Both autosave and never touch surrounding
  content.

- A **Clear Comments** toolbar action removes every GK comment from the file at once
  (after confirmation), leaving non-GK HTML comments untouched.

## 8. Source-fidelity requirements (hard constraints)

These exist because your markdown is hand-formatted (85-char wrap, aligned tables)
and because GK comments must survive round-trips through other tools.

1. The file is held and saved as a **source string**; edits are byte-range splices.
2. Untouched regions are written back **verbatim** — no rewrapping, no table
   reformatting, no normalization of list markers or heading styles.
3. GK comment bytes are preserved exactly except when you explicitly edit/delete them.
4. Rendered HTML is sanitized with DOMPurify before insertion into the DOM.
5. No full-file AST re-serialization, ever.

## 9. Architecture sketch

- **Render pipeline:** `source → marked.lexer (block tokens w/ raw + offsets) → strip &
  collect GK comments → marked inline render with offset-tagged text nodes →
  DOMPurify → highlight.js post-pass → DOM`.

- **Source map:** block offsets come from summing token `raw` lengths; inline text
  nodes carry `data-src-start`/`data-src-end` so a DOM `Selection` resolves to a
  source offset (needed to place a comment and to map a span to a card).

- **State:** `{ fileHandle, source (string), blocks (source map), comments (parsed
  list) }`. All mutations go through a single `spliceSource(range, text)` that
  updates `source`, recomputes the map, re-renders the affected region, and schedules
  autosave.

## 10. Non-goals

- Math rendering (KaTeX / LaTeX) — deferred for now; can be added later.
- Mermaid or other diagram rendering.
- Real-time / multi-user collaboration, cloud sync, or a backend.
- Git integration, PDF/HTML export, printing.
- Safari/Firefox/mobile support.
- WYSIWYG rich-text editing (we keep markdown source authoritative).

## 11. Resolved decisions

All design decisions are settled; nothing is open.

- Single self-contained `mdviewer.html` with everything inlined (Section 3).
- Dark-only theme (Section 4).
- All GK variants supported and rendered (Section 7.1).
- Comment anchoring: pure mode, no extra markers (Section 7.3).
- No `.bak` files; rely on Google Drive version history.

## 12. Build plan

1. App shell, file/folder open, read-only GFM render (marked + DOMPurify +
   highlight.js), outline/file-tree sidebar.
2. Source map + inline block editing + debounced autosave with save indicator.
3. Comment parsing + margin rendering + span highlighting (read path, requirement 4).
4. Comment creation/edit/delete with `<!-- GK: -->` splicing (write path, requirement
   3).
5. Polish: reopen-last, keyboard shortcuts, variant tags, chosen open-decision options.

## 13. Testing and acceptance

Unit tests ship with the code (run after every change) covering the pure logic that
does not need the DOM:

- **Source map:** block offsets for a corpus of representative markdown round-trip
  (`source[start:end]` equals each block's raw).
- **Splice:** editing block N changes only block N's bytes; all other bytes identical.
- **Comment round-trip:** inserting, editing, and deleting a `<!-- GK: -->` produces
  the expected source and leaves surrounding bytes byte-identical.
- **Comment parsing:** all variants (`GK:`, `GK-FIX:`, `GK-Q:`, `GK-NIT:`, audit-trail)
  are detected and extracted; non-GK HTML comments are left untouched.
- **Fidelity:** an open→render→save cycle with no edits produces a byte-identical file.

Manual acceptance checklist (the four requirements):

- [ ] Open a `.md` file; it renders with correct GFM and highlighted code.
- [ ] Click a paragraph, edit it, click away; only that paragraph changes and the file
  is saved automatically.
- [ ] Select a span, add a comment; the file gains a `<!-- GK: ... -->` next to it.
- [ ] Re-open a file that already has `<!-- GK: ... -->` comments; they render as
  margin notes, not raw text.

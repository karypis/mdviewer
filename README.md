# mdviewer

A local, single-file Markdown viewer / inline editor / commenter. Open a `.md` file,
read it rendered, click any block to edit it, and select text to attach comments that
are saved into the file as `<!-- GK: ... -->` HTML comments.

Built per `spec.md`. Runs in Chromium browsers (Chrome, Edge, Brave) — it uses the
File System Access API for direct, autosaving disk access.

## Use it

1. Open **`mdviewer.html`** in Chrome/Edge/Brave (double-click, or drag into a tab). No
   install, no build, no server.
2. Click **Open File** (or **Open Folder** for a file tree) and pick a Markdown file.
   Grant read/write permission when prompted. The picker starts in the last folder
   you opened (persisted across sessions), so open `~/agents` once with **Open
   Folder** and every subsequent picker starts there. (Browsers do not allow an app
   to hardcode an absolute path, so this one-time pick is required.)
3. **Read** it rendered (GitHub Flavored Markdown + syntax-highlighted code).
4. **Edit**: click any block (paragraph, heading, list, table, code…). It turns into a
   raw-Markdown editor. `⌘↵` or click away to save; `Esc` to cancel. Only that block
   changes; everything else stays byte-for-byte identical. Changes autosave to disk.
5. **Comment**: select text, click the **＋ Comment** bubble, pick a tag (`GK` / `GK-FIX`
   / `GK-Q` / `GK-NIT`), and type. The comment is written into the source right after
   the **first word** of your selection as `<!-- GK: your text -->` and shown as a
   card in the right margin, aligned to that anchor.
6. **Existing comments**: any file already containing `<!-- GK: ... -->` (and the
   variants, plus the audit-trail form `<!-- GK: ... / CLAUDE: ... -->`) renders
   those as margin cards automatically. Click a card to edit or delete it.
7. **Clear all**: the **Clear Comments** toolbar button (appears when a file has
   comments) removes every `<!-- GK: ... -->` from the file in one step, after a
   confirmation. Non-GK HTML comments are left untouched.

The save indicator in the toolbar shows `Saved` / `Saving…` / `Unsaved`. The app also
offers **Reopen last** on launch (it remembers your last file/folder).

**Customize the tag (⚙):** the comment tag defaults to `GK` (with `-FIX` / `-Q` /
`-NIT` kinds) and a `CLAUDE` audit-trail responder, but **⚙ Settings** lets anyone set
their own initials and responder (persisted locally). The viewer renders *any*
initials-style tag (`<!-- AB: ... -->`, `<!-- AB-FIX: ... -->`), so a file shared
between people shows everyone's comments; new comments you create use your configured
prefix. The **?** button opens an in-app help page.

**Sidebar:** the file tree has collapsible, lazily-loaded folders (click a folder to
expand/collapse; children load on first open). Toggle the whole sidebar with the **☰**
toolbar button or **⌘B** (View → Toggle Sidebar in the desktop app).

**Export PDF:** the **PDF** toolbar button exports the document you're viewing as a
clean, light, chrome-free PDF (no toolbar/sidebar/comment-margin; GK comments are
omitted). In the desktop app this writes a real file via a save dialog (also File →
Export as PDF, **⌘P**); in the browser it opens the print dialog where you choose "Save
as PDF".

## Comment format

Comments are stored exactly in your established convention, byte-pure:

```
<!-- GK: free-form comment text -->
```

They are invisible in GitHub/Notion/other renderers and survive your grep-and-process
workflow unchanged. New comments anchor to the first word of your selection.
Highlighting uses pure-mode anchoring: a comment highlights the run of text preceding
it within its block.

## Desktop app (macOS)

`electron/` wraps the same `mdviewer.html` as a standalone macOS `.app` (Electron
bundles Chromium, so every API the web app uses works unchanged). This adds Finder
**Open With** + double-click-to-open with autosave, a native File menu, and its own
window.

```
cd electron
npm install            # one-time (downloads Electron)
npm start              # run the app from source
npm run dist           # build dist/mdviewer-<ver>-arm64.dmg
npm run selftest       # run the 42-check self-test inside the Electron bundle
```

Install: open the `.dmg`, drag **mdviewer** to Applications. First launch of an
unsigned local app: right-click → Open (or System Settings → Privacy & Security →
Open Anyway). Then double-click any `.md`, or right-click → Open With → mdviewer; set
it as the default for `.md` via Finder's Get Info if you like.

Files opened from Finder read/write through a native fs bridge (main process), so
autosave writes straight to the original file. The in-app Open File / Open Folder
buttons still use the File System Access API as in the browser.

The app is unsigned (fine for personal use). Distributing it to others would require
Apple code signing + notarization.

## Project layout

The shipped artifact is the single self-contained `mdviewer.html`. It is assembled
from sources so the logic can be unit-tested; you never need to build it to *use* it.

```
mdviewer.html        ← the deliverable (open this). Generated.
src/
  mdcore.js          ← pure, DOM-free logic (lexing, source map, comments)
  mdapp.js           ← browser UI (open/render/edit/autosave/comments)
  app.css            ← styles (dark theme)
  template.html      ← HTML shell with inline placeholders
vendor/              ← marked, DOMPurify, highlight.js (+ css), pinned
tools/
  build.js           ← inlines src + vendor -> mdviewer.html
  selftest.sh        ← headless-Chrome smoke test of the real UI
tests/               ← Node unit + integration tests
samples/demo.md      ← a file to try, with example GK comments
electron/            ← macOS desktop wrapper (main.js, preload.js, packaging)
```

## Develop

```
node tools/build.js          # rebuild mdviewer.html after editing src/ or vendor/
node --test tests/*.test.js  # unit + integration tests (pure logic + shipped file)
bash tools/selftest.sh       # in-browser checks (render, highlight, edit, comment)
```

Always rebuild after changing anything in `src/` or `vendor/`; an integration test
guards against the inlined core drifting from `src/mdcore.js`.

## Scope and limits

- Chromium only (File System Access API). Not Safari/Firefox.
- Math (KaTeX) and Mermaid are out of scope for now (see `spec.md` Non-goals).
- Block-by-block rendering: reference-style link definitions that live in a different
  block from their use, and a comment placed inside an inline emphasis/link span, are
  edge cases that may render imperfectly.

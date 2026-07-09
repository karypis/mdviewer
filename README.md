# mdviewer

A local, single-file Markdown viewer, inline editor, and commenter. Open a `.md`
file, read it rendered, click any block to edit it, and select text to attach
comments that are saved into the file as `<!-- GK: ... -->` HTML comments.

Everything runs offline. There is no server, no account, and no cloud copy: the
app reads and writes your original file on disk. Built per `spec.md`. It works in
Chromium browsers (Chrome, Edge, Brave) and in the bundled macOS desktop app,
because it uses the File System Access API for direct, autosaving disk access.

## Quick start

**In a browser.** Double-click `mdviewer.html`, or drag it into a Chrome tab. No
install, no build, no server. Click **Open File**, pick a Markdown file, and grant
read/write permission when the browser asks.

**As a macOS app.** Download the `.dmg` from the
[latest release](https://github.com/karypis/mdviewer/releases/latest), drag
**mdviewer** to Applications, and double-click any `.md` file. See
[Install the macOS app](#install-the-macos-app) for the first-launch step that
unsigned apps require.

Try `samples/demo.md`. It ships with example comments already in it.

---

# Manual

## 1. The window

Three vertical panels sit under a toolbar:

| Panel | Contents |
|---|---|
| **Sidebar** (left) | The document outline, or a file tree when you open a folder |
| **Document** (center) | The rendered Markdown. Click a block to edit it |
| **Margin** (right) | One card per comment, aligned to the text it annotates |

Drag the thin bar between any two panels to resize them. The sidebar clamps to
140-560 px and the comment margin to 180-680 px; the document takes the rest and
its prose reflows to whatever width is left. Both widths persist across sessions
in `localStorage` under the key `mdviewer.layout`.

Hide the sidebar entirely with the **☰** toolbar button or **⌘B**.

The toolbar's right end shows the save indicator: **Saved**, **Saving…**,
**Unsaved**, or **Save error**.

## 2. Opening files

**Open File** picks a single Markdown file. **Open Folder** opens a folder as a
collapsible file tree in the sidebar; folders load their children the first time
you expand them, so a deep tree costs nothing until you click into it.

The picker starts in the last folder you opened, remembered across sessions. Open
`~/agents` once with **Open Folder** and every later picker starts there. Browsers
do not let a web app hardcode an absolute path, so this one-time pick is required.

On launch the app offers **Reopen last**, which restores your previous file or
folder from the handle it stored in IndexedDB. The browser may re-prompt for
permission.

In the desktop app you can also double-click a `.md` file in Finder, or use
right-click → **Open With** → mdviewer. Files opened this way read and write
through a native bridge in the Electron main process, so autosave writes straight
to the original path with no permission prompt.

## 3. Reading

Documents render as GitHub Flavored Markdown with syntax-highlighted code blocks.

In single-file mode the sidebar shows the document **outline**: every heading,
indented by level. Click a heading to scroll to it.

Links behave differently from a normal page, because a plain click is how you
enter the editor. **Click** a link to edit the block that contains it.
**⌘-click** (Ctrl-click on Windows and Linux) to open the link in a new tab.

## 4. Finding text

Press **⌘F** to open the find bar. If you have text selected when you press it,
that text seeds the query.

Typing highlights every match at once, with the current one brighter than the
rest, and the counter reads `3 of 17`. Matching is a case-insensitive plain
substring search, not a regular expression, and it stops after 5000 matches.

- **⏎** jumps to the next match, **⇧⏎** to the previous. Both wrap around.
- **⌘G** and **⇧⌘G** do the same without focusing the find bar.
- **Esc** closes the bar and clears the highlights.

Highlights are rebuilt whenever the document re-renders, so they survive an edit
made while the bar is open.

## 5. Editing a block

Click any block (paragraph, heading, list, table, code fence, blockquote) and it
becomes a textarea holding that block's raw Markdown.

- **⌘↵**, or clicking away, saves.
- **Esc** cancels and discards your changes.
- **Tab** inserts two spaces instead of moving focus.

Only the bytes of the block you touched change. Every other byte in the file,
including whitespace and comments, stays exactly as it was. Saving a paragraph
also re-hard-wraps it (see [Line wrapping](#7-line-wrapping)). The change
autosaves to disk.

## 6. Commenting

**Add a comment.** Select text inside one block, click the **＋ Comment** bubble
that appears next to the selection, pick a tag from the dropdown, type your note,
and press **⌘↵** or click **Save**. Submitting an empty note cancels instead.

The comment is written into the source immediately after the **first word** of
your selection:

```
The algorithm computes<!-- GK-Q: which one? --> an initial partition.
```

That first word is what the margin card anchors to and what the app highlights.
A selection that spans two blocks is ignored, and so is a selection that starts
in a block and ends outside it.

Selections that cross inline markup work correctly. Selecting the rendered text
`reverse converter` inside `**reverse converter**` places the comment after
`**reverse`, not at the end of the paragraph.

**Kinds.** The dropdown offers four tags. The suffix picks the card's color:

| Tag | Meaning | Card color |
|---|---|---|
| `GK` | A plain note | Blue |
| `GK-FIX` | Something to fix | Amber |
| `GK-Q` | A question | Purple |
| `GK-NIT` | A nitpick | Gray |

**Work with existing comments.** Any file that already contains
`<!-- GK: ... -->` renders those as margin cards on open. Click a card to scroll
to and highlight its anchor word. Each card carries **edit** and **delete**
links. The **Clear Comments** toolbar button, which appears only when the file
has comments, removes every one of them in a single step after a confirmation.
HTML comments that are not review comments, such as `<!-- prettier-ignore -->`,
are never touched.

**Audit trail.** A comment can carry a response, separated by a slash:

```
<!-- GK-FIX: this should be O(n log n) / CLAUDE: fixed in c3a91f0 -->
```

The card shows the response as a green reply block below your note. `CLAUDE` is
the default responder name and is configurable.

**Sharing a file.** The renderer accepts *any* initials-style tag, so
`<!-- AB: ... -->` and `<!-- AB-FIX: ... -->` show up as cards alongside yours,
and the kind suffix colors them the same way regardless of whose initials they
carry. New comments that *you* create always use the prefix you configured.

## 7. Line wrapping

Many Markdown files are hard-wrapped to a fixed column. mdviewer preserves that
constraint without letting it dictate how the text looks on screen.

**On screen** the document always reflows prose to the width of the window, so
resizing the window or dragging a panel gutter re-flows the paragraphs. This is
just standard Markdown: soft-wrapped lines join into one paragraph.

**On disk** every paragraph you edit, and every paragraph you drop a comment
into, is re-wrapped back to the file's column width before it is saved.

Set the width under **⚙ Settings → Line wrapping**:

- `auto` (the default) infers the column from the file itself, by taking the
  longest non-final line of any multi-line paragraph. Under greedy wrapping that
  line reproduces the file's existing wrapping exactly, so re-saving an untouched
  paragraph is a no-op.
- A number, such as `80`, forces that column.
- `0` turns re-wrapping off and leaves your line breaks alone.

Only paragraphs are re-wrapped. Code blocks, tables, lists, headings, and
blockquotes are left byte-for-byte unchanged. A paragraph containing a Markdown
hard break (two trailing spaces or a trailing backslash) is never reflowed,
because reflowing it would change how it renders.

## 8. Saving

Saving is automatic. A block edit saves 500 ms after you commit it; adding,
editing, or deleting a comment saves immediately. **⌘S** forces a save now.

Watch the toolbar indicator to know where you stand:

| State | Meaning |
|---|---|
| **Saved** | The file on disk matches what you see |
| **Saving…** | A write is in flight |
| **Unsaved** | An edit is queued and not yet written |
| **Save error** | The write failed. The reason appears in a toast |

## 9. Exporting a PDF

The **PDF** toolbar button exports the document you are viewing as a clean, light,
chrome-free PDF: no toolbar, no sidebar, no comment margin, and no review
comments. In the desktop app it writes a real file through a save dialog (also
**File → Export as PDF**, or **⌘P**). In the browser it opens the print dialog,
where you choose "Save as PDF".

## 10. Settings

Click **⚙** in the toolbar. Settings persist in `localStorage` under
`mdviewer.settings` and apply to every file you open.

| Setting | Values | Default | Effect |
|---|---|---|---|
| Document font | System, Helvetica/Arial, Georgia, Charter/New York, Monospace | System | Font of the rendered document |
| Font size | 11 to 28 px | 15 | Base size. Headings, code, and tables scale with it |
| Your initials | 1 to 6 letters or digits, uppercased | `GK` | The tag on comments you create |
| Audit-trail responder | 1 to 16 letters, digits, or hyphens, uppercased | `CLAUDE` | The name that splits a comment from its response |
| Hard-wrap width | `auto`, a number, or `0` | `auto` | Column that edited paragraphs are wrapped to on save |

The font and size affect the rendered document only. The block editor, the
comment cards, and the toolbar keep their own type.

The **?** toolbar button opens the same guidance as an in-app help page.

## 11. Keyboard shortcuts

On Windows and Linux, use **Ctrl** wherever this table says **⌘**.

| Key | Where | Action |
|---|---|---|
| **⌘F** | Anywhere | Open the find bar, seeded with the selection |
| **⏎** / **⇧⏎** | Find bar | Next / previous match |
| **⌘G** / **⇧⌘G** | Anywhere, while find is open | Next / previous match |
| **Esc** | Anywhere | Close the find bar, or the open dialog |
| **⌘S** | Anywhere | Save now |
| **⌘B** | Anywhere | Show or hide the sidebar |
| **⌘↵** | Block editor | Save the block |
| **Esc** | Block editor | Cancel the edit |
| **Tab** | Block editor | Insert two spaces |
| **⌘↵** | Comment composer | Save the comment |
| **Esc** | Comment composer | Cancel the comment |
| **⌘-click** | On a link | Open the link in a new tab |
| **⌘O** / **⇧⌘O** | Desktop app | Open File / Open Folder |
| **⌘P** | Desktop app | Export as PDF |

---

## Comment format

Comments are stored in your established convention, byte-pure:

```
<!-- GK: free-form comment text -->
```

They are invisible in GitHub, Notion, and every other Markdown renderer, and they
survive a grep-and-process workflow unchanged. The exact grammar the app reads:

- The tag starts with an uppercase letter, then any letters or digits, then any
  number of `-`-separated segments: `GK`, `GK-FIX`, `AB`, `AB-NIT`.
- A colon separates the tag from the body. Whitespace around both is optional.
- Lowercase tooling comments (`<!-- prettier-ignore -->`) and tags with no colon
  never match, so mdviewer leaves them alone.
- An optional `/ RESPONDER:` inside the body splits it into a note and a
  response.

New comments anchor after the first word of your selection. The app highlights
exactly the single word immediately preceding the comment, never the whole run of
text before it.

## Install the macOS app

`electron/` wraps the same `mdviewer.html` as a standalone macOS `.app`. Electron
bundles Chromium, so every API the web app uses works unchanged. The wrapper adds
Finder **Open With** and double-click-to-open with autosave, a native File menu,
and its own window and icon.

### Download

Grab the `.dmg` for your Mac from the
[**Releases** page](https://github.com/karypis/mdviewer/releases/latest). The
disk images are release assets, not files in this repository, because each one is
about 100 MB.

| File | For |
|---|---|
| `mdviewer-<ver>-arm64.dmg` | Apple Silicon (M1 and later) |
| `mdviewer-<ver>.dmg` | Intel |

Run `uname -m` if you are unsure: `arm64` means Apple Silicon, `x86_64` means
Intel.

### Install

1. Open the `.dmg` and drag **mdviewer** onto the **Applications** shortcut.
2. Eject the disk image, then launch mdviewer once from Applications.

The app is ad-hoc signed rather than signed with an Apple Developer ID, so on
first launch macOS reports an unidentified developer. Right-click the app in
Applications and choose **Open**, then confirm. You only do this once. If macOS
instead calls the app damaged, clear the download quarantine flag and reopen:

```
xattr -dr com.apple.quarantine /Applications/mdviewer.app
```

### Markdown file association

The bundle claims `.md` and `.markdown` as an **Editor** with `LSHandlerRank`
set to `Owner`, so macOS registers mdviewer as a handler the first time you
launch it. After that, `.md` files show the mdviewer icon and right-click →
**Open With** lists it.

macOS does not let an installer silently seize a file type that another app
already owns. If double-clicking a `.md` file still opens something else, set the
default once: select any `.md` file in Finder, press **⌘I**, choose **mdviewer**
under **Open with**, then click **Change All…**.

Files opened from Finder read and write through a native fs bridge in the main
process, so autosave writes straight to the original file. The in-app **Open
File** and **Open Folder** buttons still use the File System Access API, exactly
as in the browser.

### Build it yourself

```
cd electron
npm install            # one-time (downloads Electron)
npm start              # run the app from source
npm run selftest       # run the 89-check self-test inside the Electron bundle
npm run dist           # build both .dmg files into electron/dist/
```

`npm run dist` ad-hoc signs each bundle through the `build/after-pack.js` hook.
codesign refuses to sign files carrying `com.apple.FinderInfo` or resource-fork
extended attributes, which a cloud-sync daemon (Google Drive, Dropbox, iCloud)
re-stamps at unpredictable moments. The hook strips them before every codesign
call. If the sync daemon still wins the race, build outside the synced folder:

```
MDVIEWER_OUT=/tmp/mdv-build npm run dist
```

Shipping to others without the unidentified-developer prompt would require an
Apple Developer ID certificate and notarization, which this project does not use.

## Project layout

The shipped artifact is the single self-contained `mdviewer.html`. It is assembled
from sources so the logic can be unit-tested; you never need to build it to *use*
it.

```
mdviewer.html        <- the deliverable (open this). Generated.
src/
  mdcore.js          <- pure, DOM-free logic (lexing, source map, comments, wrapping)
  mdapp.js           <- browser UI (open/render/edit/autosave/comments/find)
  app.css            <- styles (dark theme)
  template.html      <- HTML shell with inline placeholders
vendor/              <- marked, DOMPurify, highlight.js (+ css), pinned
tools/
  build.js           <- inlines src + vendor -> mdviewer.html
  selftest.sh        <- headless-Chrome smoke test of the real UI
tests/               <- Node unit + integration tests
samples/demo.md      <- a file to try, with example GK comments
electron/            <- macOS desktop wrapper (main.js, preload.js, packaging)
  build/after-pack.js  <- ad-hoc signs the .app before the .dmg is built
icon-concepts/       <- app icon: concepts, the chosen master, and the build script
```

## Develop

```
node tools/build.js          # rebuild mdviewer.html after editing src/ or vendor/
node --test tests/*.test.js  # 53 unit + integration tests (pure logic + shipped file)
bash tools/selftest.sh       # 89 in-browser checks (render, edit, comment, find, wrap)
```

Always rebuild after changing anything in `src/` or `vendor/`. An integration test
guards against the inlined core drifting from `src/mdcore.js`.

## Scope and limits

- Chromium only (File System Access API). Not Safari, not Firefox.
- Math (KaTeX) and Mermaid are out of scope for now (see `spec.md` Non-goals).
- Block-by-block rendering has two known edge cases: a reference-style link
  definition that lives in a different block from its use, and a comment placed
  inside an inline emphasis or link span, may render imperfectly.

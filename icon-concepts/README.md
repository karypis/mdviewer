# App icon concepts

Design exploration for the mdviewer macOS app icon. Four concepts were generated
with OpenAI `gpt-image-1` (`gen_icons.py`), then concept **c3** (the M-with-down-arrow
monogram on a blue squircle) was chosen and processed into the shipped icon.

## Files

| File                          | What it is                                              |
| ----------------------------- | ------------------------------------------------------- |
| `c1-markdown-doc.png`         | Concept: blue page with an `M↓` mark on a dark tile.    |
| `c2-comment-bubble.png`       | Concept: light page with an amber comment bubble.       |
| `c3-monogram.png`             | Concept (chosen): white `M↓` monogram on a blue tile.   |
| `c4-dark-editor.png`          | Concept: dark page, blue headings, amber margin note.   |
| `_chosen-c3-master-1024.png`  | Final 1024px master derived from c3.                    |
| `gen_icons.py`                | Calls `gpt-image-1` to render the four concepts.        |
| `process_icon.py`             | Turns a concept PNG into a macOS `.iconset`.            |

The shipped icon is `electron/build/icon.icns`, referenced by `electron/package.json`
(`build.mac.icon`).

## Regenerate the icon from the chosen concept

```
python3 icon-concepts/process_icon.py icon-concepts/c3-monogram.png   # writes mdviewer.iconset
iconutil -c icns mdviewer.iconset -o electron/build/icon.icns
cd electron && npm run dist                                           # bundles the icon
```

`process_icon.py` accounts for how the model renders the tile: the squircle is opaque
but the monogram is a transparent cutout (it only looks white over the page). The
script flattens the cutout to white, fills the enclosed holes from the alpha
silhouette via a border-seeded flood fill, trims the white border, and insets the art
to the macOS content size (824 of 1024) so the corners are transparent and the margins
match native icons.

Generation needs `OPENAI_API_KEY` in the environment; processing needs `numpy` and
`Pillow`.

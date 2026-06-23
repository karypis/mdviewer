# mdviewer demo

This file exercises the renderer and shows how existing `GK` comments appear as
margin notes. Open it in **mdviewer.html**, then try editing a block and adding a
comment of your own.

## Markdown features

Inline styles: **bold**, _italic_, `inline code`, ~~strikethrough~~, and a
[link](https://example.com). Here is a sentence with a span worth commenting on
about the multilevel coarsening step. <!-- GK: explain coarsening here -->

A task list:

- [x] render GitHub Flavored Markdown
- [x] inline block editing
- [ ] try adding your own comment

A table:

| Method  | Quality | Speed  |
| ------- | ------- | ------ |
| random  | low     | fast   |
| METIS   | high    | fast   |
| optimal | best    | slow   |

A fenced code block (syntax highlighted):

```python
def coarsen(graph):
    # collapse matched vertex pairs
    return contract(graph, maximal_matching(graph))
```

> A blockquote, for good measure, with a `code` span inside it.

## Existing comments render as cards

The paragraph below already carries several comment variants so you can see how
each renders. <!-- GK-FIX: tighten this sentence --> The standard tag is neutral,
fixes are amber, questions are purple <!-- GK-Q: is purple the right color? -->,
and nits are gray <!-- GK-NIT: trailing space somewhere -->.

This line shows the audit-trail form, which renders both the feedback and the
response. <!-- GK: clarify the claim / CLAUDE: reworded to cite the source -->

## Try it yourself

1. Click this paragraph to edit its raw Markdown, then click away to save.
2. Select any phrase above and use the ＋ Comment bubble to attach a note.
3. Reopen this file later: your comments come back as margin cards.

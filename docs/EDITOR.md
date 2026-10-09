# The file editor

The file pane is one component in both shells (`features/shell/CodeEditor.tsx`):
a CodeMirror 6 editor whose highlighting is shiki's — the same tokens and themes
the read-only preview has always used, painted as decorations — so a file does
not change colour when it becomes editable.

## Find (`⌘F`)

Pressing `⌘F` opens the widget at the top of the pane: an input, a match count,
`Aa` / `ab` / `.*` toggles, ↑ ↓ to move, Enter / Shift-Enter, Escape to close.
The editor answers the key wherever the focus is: the library's keymap covers
the focused case, and a window-level capture listener (`registerFindTarget`)
routes `⌘F` to the editor the user last touched when the focus is somewhere
else — a file that was just opened answers ⌘F without a click first.

The *engine* is `@codemirror/search` — the query, the match highlighter, and the
keymap (`F3`, `⌘G`, `⌘⌥F`) are the library's, which is why the whole family of
search keys behaves the way it does everywhere else. The *panel* is Orbit's
(`features/shell/editor-find.ts`), because the library's panel is one row of
English button labels with the replace field always open and no match count —
and "3/12" or "无结果" is the answer to "is it worth pressing Enter".

Two details worth keeping:

* the field carries `main-field=true`, which is how `openSearchPanel` finds what
  to focus when `⌘F` is pressed with the panel already open;
* the count is computed from the editor's *state*, not its DOM, so it is covered
  by `tests/editor-find.test.ts` — a wrong count still looks like a working find
  box, so it is exactly the part a click-through cannot verify.

## Editing and saving

* Every text file opens editable — typing is how a draft begins, and the caret
  is already in the text when the file opens. `⌘S` writes the file and `⌘Z`
  undoes. The command is `write_text_file`, which is mirrored to a paired phone
  like every other workspace command, so the same component saves to the same
  disk from either shell; the phone has no ⌘S, so its save affordance is the
  footer button, shown only while there is something to save.
* The editor mounts **one view per file** and reads the document once, at mount.
  The parent re-renders on every keystroke with the new buffer, so depending on
  the value would rebuild the editor under the user's caret.
* Highlighting is not re-run per keystroke. A token pass happens when typing
  pauses (350 ms) or the theme changes, and CodeMirror's decoration mapping
  carries the colours through every edit in between — decorations are positions,
  so the caret never waits for a parser. Files past 200k characters stay plain.
* Past `MAX_HIGHLIGHT_CHARS` or an unknown language, the file is plain text:
  a preview is not worth a parser grind.

## Drafts (`lib/drafts.ts`)

Unsaved text lives in a store keyed by file path, not in the editor component,
because the component unmounts whenever a pane switches files, moves a file to
another pane, or closes a tab — and losing an edit because a tab was clicked is
not a thing an editor is allowed to do.

So:

* a draft **outlives its tab**: the dot on the tab is the warning, and reopening
  the file brings the edit back;
* only 保存 (⌘S, or the footer button on a phone) or quitting the process drops
  it — saving is one keystroke, on purpose.
* a file with a draft opens showing that draft, so an edit survives every
  pane and mode switch.

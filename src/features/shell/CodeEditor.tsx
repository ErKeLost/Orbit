import { useEffect, useRef } from "react"
import { EditorState, type Extension } from "@codemirror/state"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching } from "@codemirror/language"
import { search, searchKeymap } from "@codemirror/search"
import type { BundledLanguage } from "shiki"
import { languageForFileName } from "../../components/FileHighlighter"
import { highlightField, highlightSpans, setHighlights } from "../../lib/editor-highlight"
import { useColorScheme } from "../../lib/appearance"
import type { ResolvedTheme } from "../../lib/theme"
import { OrbitFindPanel, registerFindTarget } from "./editor-find"

/**
 * The file editor.
 *
 * CodeMirror 6 rather than a `<textarea>`: the features asked of an editor —
 * undo/redo, real selection, bracket matching and above all the find widget —
 * are the ones a bare textarea cannot do, and CodeMirror already ships the
 * search engine this app's diffs use.
 *
 * Highlighting is shiki's, painted as decorations (see `lib/editor-highlight`):
 * the same tokens and themes as the read-only preview, so a file does not change
 * colour when it becomes editable. Tokenizing is deferred until typing pauses,
 * and positions are carried through every edit by CodeMirror's decoration
 * mapping, so the caret never waits for a parser.
 *
 * The component owns a view per file (`key` on the parent side); the parent owns
 * the buffer. Nothing here decides whether to save.
 */
export function CodeEditor({
  value,
  fileName,
  onChange,
  onSave,
}: {
  value: string
  fileName: string
  onChange?: (text: string) => void
  onSave?: () => void
}) {
  const host = useRef<HTMLDivElement | null>(null)
  const view = useRef<EditorView | null>(null)
  const tokenTimer = useRef<number | null>(null)
  const theme = useColorScheme()
  // Read through refs so the extensions can stay constant for the view's life:
  // CodeMirror holds them for as long as the view exists, and rebuilding the
  // extension set on every render would throw away the undo history.
  const handlers = useRef({ onChange, onSave })
  const themeRef = useRef(theme)
  useEffect(() => {
    handlers.current = { onChange, onSave }
    themeRef.current = theme
  })

  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions(handlers, () => themeRef.current, (current) => scheduleTokenize(current, tokenTimer, fileName, () => themeRef.current)),
      }),
    })
    view.current = instance
    // Files open as the active editing surface: the caret is in the text, so
    // typing works immediately and the find keys are live without a click.
    instance.focus()
    const stopFind = registerFindTarget(instance)
    void tokenizeFile(instance, fileName, themeRef.current)
    return () => {
      if (tokenTimer.current !== null) window.clearTimeout(tokenTimer.current)
      tokenTimer.current = null
      stopFind()
      instance.destroy()
      view.current = null
    }
    // One view per file, and the document is read once, at mount: the parent
    // re-renders on every keystroke with the new buffer, so depending on
    // `value` here would rebuild the editor under the user's caret and eat the
    // edit. A different file arrives as a new `fileName`, which recreates it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName])

  // A theme switch re-tokenizes: the colours come from the tokens, not CSS.
  useEffect(() => {
    const instance = view.current
    if (!instance) return
    void tokenizeFile(instance, fileName, theme)
  }, [theme, fileName])

  return <div ref={host} className="orbit-editor" />
}

function editorExtensions(
  handlers: { current: { onChange?: (text: string) => void; onSave?: () => void } },
  theme: () => ResolvedTheme,
  schedule: (view: EditorView) => void,
): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
    bracketMatching(),
    history(),
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ "aria-label": "文件内容", spellcheck: "false" }),
    search({ top: true, createPanel: (instance) => new OrbitFindPanel(instance) }),
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
      indentWithTab,
      { key: "Mod-s", preventDefault: true, run: () => { handlers.current.onSave?.(); return true } },
    ]),
    highlightField,
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        handlers.current.onChange?.(update.state.doc.toString())
        schedule(update.view)
      }
    }),
    editorTheme(theme()),
  ]
}

/** How long typing pauses before shiki sees the document again. */
const RETOKENIZE_DELAY = 350
/** Past this, the file is plain text: a preview is not worth a parser grind. */
const MAX_HIGHLIGHT_CHARS = 200_000

function scheduleTokenize(view: EditorView, timer: { current: number | null }, fileName: string, theme: () => ResolvedTheme) {
  if (timer.current !== null) window.clearTimeout(timer.current)
  timer.current = window.setTimeout(() => {
    timer.current = null
    void tokenizeFile(view, fileName, theme())
  }, RETOKENIZE_DELAY)
}

/** Paint `fileName`'s syntax onto the view's current document. */
async function tokenizeFile(view: EditorView, fileName: string, theme: ResolvedTheme) {
  const code = view.state.doc.toString()
  const language = languageForFileName(fileName)
  if (language === "text" || code.length > MAX_HIGHLIGHT_CHARS) {
    view.dispatch({ effects: setHighlights.of([]) })
    return
  }
  try {
    const { codeToTokens } = await import("shiki")
    const result = await codeToTokens(code, {
      lang: language as BundledLanguage,
      theme: theme === "light" ? "vitesse-light" : "vitesse-dark",
    })
    // The document may have moved on while shiki worked; the decorations are
    // positions, so tokenizing stale text would paint the wrong columns.
    if (view.state.doc.toString() !== code) return
    view.dispatch({ effects: setHighlights.of(highlightSpans(result.tokens, code.length)) })
  } catch {
    // An unknown language or a tokenizer failure: plain text is a fine answer.
  }
}

function editorTheme(theme: ResolvedTheme): Extension {
  return EditorView.theme(
    {
      "&": { color: "var(--color-content)", backgroundColor: "transparent", fontSize: "12px" },
      ".cm-scroller": { fontFamily: "var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)", lineHeight: "1.6" },
      ".cm-content": { padding: "10px 0", caretColor: "var(--color-accent)" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        color: "color-mix(in srgb, var(--color-content) 32%, transparent)",
        border: "none",
        paddingRight: "6px",
      },
      ".cm-lineNumbers .cm-gutterElement": { padding: "0 4px 0 10px" },
      ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--color-content) 4%, transparent)" },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "color-mix(in srgb, var(--color-content) 60%, transparent)" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-accent)" },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground": {
        backgroundColor: "var(--color-selection-strong, var(--color-selection))",
      },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "color-mix(in srgb, var(--color-accent) 22%, transparent)",
        outline: "none",
      },
      ".cm-searchMatch": { backgroundColor: "color-mix(in srgb, var(--color-accent) 26%, transparent)" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "color-mix(in srgb, var(--color-accent) 55%, transparent)" },
      ".cm-panels": { backgroundColor: "transparent" },
    },
    { dark: theme !== "light" },
  )
}

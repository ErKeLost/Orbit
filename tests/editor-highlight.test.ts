import { describe, expect, test } from "bun:test"
import { EditorState } from "@codemirror/state"
import { highlightSpans, highlightField, setHighlights, type HighlightToken } from "../src/lib/editor-highlight"

/**
 * The editor paints shiki's tokens as CodeMirror decorations, so this mapping is
 * the one place where a highlighting bug can appear — and it cannot be caught by
 * looking at the editor, because a wrong *offset* still looks like coloured code
 * (just the wrong characters are coloured).
 *
 * The rules worth pinning: spans are clamped to the document, sorted (CodeMirror
 * requires it), and uncoloured or blank tokens contribute nothing.
 */
const token = (content: string, offset: number, color?: string, fontStyle?: number): HighlightToken => ({
  content,
  offset,
  ...(color ? { color } : {}),
  ...(fontStyle ? { fontStyle } : {}),
})

describe("editor highlighting", () => {
  test("maps tokens to sorted, styled ranges", () => {
    const spans = highlightSpans([[token("const", 0, "#111"), token(" x", 5, "#222")], [token("= 1", 7, "#333")]], 10)
    expect(spans).toEqual([
      { from: 0, to: 5, style: "color:#111" },
      { from: 5, to: 7, style: "color:#222" },
      { from: 7, to: 10, style: "color:#333" },
    ])
  })

  test("keeps shiki's italics and bold", () => {
    const spans = highlightSpans([[token("note", 0, "#abc", 1), token("x", 4, "#abc", 2)]], 5)
    expect(spans.map((span) => span.style)).toEqual(["color:#abc;font-style:italic", "color:#abc;font-weight:600"])
  })

  test("drops tokens that carry no style", () => {
    // A mark with no style costs a decoration per transaction and paints
    // nothing: uncoloured tokens (including the trailing newline shiki emits at
    // the end of every line) must not produce one.
    expect(highlightSpans([[token("plain", 0), token("\n", 5)]], 6)).toEqual([])
    expect(highlightSpans([[token("   ", 0, "#fff")]], 3)).toEqual([])
  })

  test("clamps a token that addresses past the document", () => {
    // The document can be shorter than the tokenized text: shiki ran on an older
    // revision, or the file was truncated. A range past the end is an exception
    // in CodeMirror, not a cosmetic problem.
    expect(highlightSpans([[token("abcdef", 0, "#f00")]], 3)).toEqual([{ from: 0, to: 3, style: "color:#f00" }])
    expect(highlightSpans([[token("abc", 10, "#f00")]], 3)).toEqual([])
  })

  test("the decoration field carries the colours through edits", () => {
    // This is the reason tokenizing is deferred rather than run per keystroke:
    // the marks are positions, so CodeMirror moves them with the text. A plain
    // view plugin would drop them, and the file would go grey while typing.
    let state = EditorState.create({ doc: "const a = 1", extensions: [highlightField] })
    state = state.update({ effects: setHighlights.of([{ from: 0, to: 5, style: "color:#abc" }]) }).state
    const spans = (current: EditorState) => {
      const found: { from: number; to: number }[] = []
      current.field(highlightField).between(0, current.doc.length, (from, to) => { found.push({ from, to }) })
      return found
    }
    expect(spans(state)).toEqual([{ from: 0, to: 5 }])
    state = state.update({ changes: { from: 0, insert: "// " } }).state
    expect(spans(state)).toEqual([{ from: 3, to: 8 }])
    // A new token pass replaces them rather than piling up.
    state = state.update({ effects: setHighlights.of([{ from: 0, to: 2, style: "color:#def" }]) }).state
    expect(spans(state)).toEqual([{ from: 0, to: 2 }])
  })
})

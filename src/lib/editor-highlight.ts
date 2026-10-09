import { StateEffect, StateField } from "@codemirror/state"
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view"

/**
 * File highlighting for the editor, using the same engine as the preview.
 *
 * The read-only preview has always been shiki's HTML. A second highlighter for
 * the editor would have meant two answers to "what colour is this token", and
 * the editor's answer is the one a user sees while typing — so the editor paints
 * shiki's tokens as CodeMirror decorations instead. Same theme, same colours,
 * same language table.
 *
 * The token pass is deliberately *not* per keystroke: shiki is a real
 * tokenizer, and a file is a lot of text. Decorations are positions, so
 * CodeMirror maps them through every edit on its own; a background pass
 * re-tokenizes when typing pauses, which keeps the colours right for the code
 * that is actually there without making the caret wait for a parser.
 */

/** One token of shiki's output, structurally (no dependency on its types). */
export type HighlightToken = {
  content: string
  offset: number
  color?: string
  fontStyle?: number
}

export type HighlightSpan = { from: number; to: number; style: string }

/** shiki's `FontStyle` flags. */
const ITALIC = 1
const BOLD = 2
const UNDERLINE = 4

/**
 * Turn shiki's tokens into decoration ranges.
 *
 * Whitespace-only and uncoloured tokens are dropped: a mark with no style is
 * noise in the decoration set, and every one of them costs a comparison per
 * transaction. Ranges are clamped to the document, because a token whose line
 * ends in a newline can address one past the end.
 */
export function highlightSpans(tokens: HighlightToken[][], length: number): HighlightSpan[] {
  const spans: HighlightSpan[] = []
  for (const line of tokens) {
    for (const token of line) {
      if (!token.color || token.content.trim() === "") continue
      const from = Math.max(0, Math.min(length, token.offset))
      const to = Math.max(from, Math.min(length, token.offset + token.content.length))
      if (from >= to) continue
      const style = [`color:${token.color}`, fontStyle(token.fontStyle)].filter(Boolean).join(";")
      spans.push({ from, to, style })
    }
  }
  return spans.sort((left, right) => left.from - right.from || left.to - right.to)
}

function fontStyle(flags: number | undefined): string {
  if (!flags) return ""
  const parts: string[] = []
  if (flags & ITALIC) parts.push("font-style:italic")
  if (flags & BOLD) parts.push("font-weight:600")
  if (flags & UNDERLINE) parts.push("text-decoration:underline")
  return parts.join(";")
}

/** Replace the editor's highlight decorations. */
export const setHighlights = StateEffect.define<HighlightSpan[]>()

/**
 * A decoration field rather than a view plugin: `map` is what carries the
 * colours through edits between token passes, and that only exists on a field.
 */
export const highlightField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    const mapped = value.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(setHighlights)) continue
      return Decoration.set(
        effect.value.map((span) => Decoration.mark({ attributes: { style: span.style } }).range(span.from, span.to)),
        true,
      )
    }
    return mapped
  },
  provide: (field) => EditorView.decorations.from(field),
})

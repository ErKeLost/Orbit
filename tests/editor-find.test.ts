import { describe, expect, test } from "bun:test"
import { EditorSelection, EditorState } from "@codemirror/state"
import { SearchQuery } from "@codemirror/search"
import { countMatches, currentMatch } from "../src/features/shell/editor-find"

/**
 * The find widget's numbers.
 *
 * "3/12" or "无结果" is the answer to "is it worth pressing Enter", so the count
 * is a feature and not a decoration — and it is the part of the widget a manual
 * click-through cannot verify, because a wrong count still looks like a working
 * find box.
 */
const state = (doc: string, selection?: { from: number; to?: number }) =>
  EditorState.create({ doc, selection: selection ? EditorSelection.single(selection.from, selection.to ?? selection.from) : undefined })

const query = (config: { search: string; caseSensitive?: boolean; wholeWord?: boolean; regexp?: boolean }) =>
  new SearchQuery({ search: config.search, ...config })

describe("find panel counting", () => {
  test("counts every match, and says which one the caret is on", () => {
    const document = "const a = 1\nconst b = 2\nconst c = 3\n"
    const state1 = state(document)
    expect(countMatches(state1, query({ search: "const" }))).toBe(3)
    // Not on a match: the widget shows the match it would jump to, so the
    // renderer falls back to the first.
    expect(currentMatch(state1, query({ search: "const" }))).toBe(-1)
    // The selection is what findNext sets, so this is the number after Enter.
    const second = state(document, { from: 12, to: 17 })
    expect(currentMatch(second, query({ search: "const" }))).toBe(1)
  })

  test("honours the toggles the widget exposes", () => {
    const document = "Value value VALUE\n"
    // Aa off (the default) folds case, exactly like the editor's own default.
    expect(countMatches(state(document), query({ search: "value" }))).toBe(3)
    expect(countMatches(state(document), query({ search: "value", caseSensitive: true }))).toBe(1)
    expect(countMatches(state(document), query({ search: "VALUE", caseSensitive: true }))).toBe(1)
    // Whole word: `val` is inside `Value`, so only the standalone word counts.
    expect(countMatches(state("val value\n"), query({ search: "val" }))).toBe(2)
    expect(countMatches(state("val value\n"), query({ search: "val", wholeWord: true }))).toBe(1)
  })

  test("a regexp query counts matches, and an invalid one is called out", () => {
    const document = "a1 b2 c3\n"
    expect(countMatches(state(document), query({ search: "\\d", regexp: true }))).toBe(3)
    const broken = query({ search: "([", regexp: true })
    // `valid` is what the widget reads to print 无效表达式 instead of 无结果: an
    // empty result would be indistinguishable from "the pattern is wrong".
    expect(broken.valid).toBe(false)
    expect(query({ search: "[" , regexp: true }).valid).toBe(false)
    // Literal search treats the same text as a plain string, which is the
    // documented escape hatch.
    expect(new SearchQuery({ search: "[", literal: true }).valid).toBe(true)
  })

  test("an empty query matches nothing and counts nothing", () => {
    expect(countMatches(state("abc"), query({ search: "" }))).toBe(0)
  })
})

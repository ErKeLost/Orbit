import { beforeEach, describe, expect, test } from "bun:test"
import { draftFor, dropDraftFor, setDraftFor, useDrafts } from "../src/lib/drafts"

/**
 * Unsaved editor buffers.
 *
 * The behaviour that matters is what happens when a tab closes: the editor
 * component unmounts, and if the buffer lived there the edit would be gone. It
 * lives in this store instead, so the rules below are the contract the editor
 * relies on — a draft outlives its component, is keyed by the exact file path,
 * and is only dropped by 保存 or 丢弃.
 */
describe("editor drafts", () => {
  beforeEach(() => {
    useDrafts.setState({ drafts: {} })
  })

  test("keeps a buffer per path, independently of any component", () => {
    setDraftFor("/work/a.ts", "one")
    setDraftFor("/work/b.ts", "two")
    expect(draftFor("/work/a.ts")).toBe("one")
    expect(draftFor("/work/b.ts")).toBe("two")
    expect(draftFor("/work/c.ts")).toBeUndefined()
  })

  test("a renamed path takes its buffer with it", () => {
    setDraftFor("/work/old.ts", "text")
    useDrafts.getState().moveDraft("/work/old.ts", "/work/new.ts")
    expect(draftFor("/work/old.ts")).toBeUndefined()
    expect(draftFor("/work/new.ts")).toBe("text")
  })

  test("dropping is what saving and discarding have in common", () => {
    setDraftFor("/work/a.ts", "text")
    dropDraftFor("/work/a.ts")
    expect(draftFor("/work/a.ts")).toBeUndefined()
    // Dropping something that is not there is not an error: 丢弃 on a clean file
    // and a save that already happened both land here.
    expect(() => dropDraftFor("/work/a.ts")).not.toThrow()
  })

  test("an unchanged value does not churn the store", () => {
    setDraftFor("/work/a.ts", "text")
    const first = useDrafts.getState().drafts
    setDraftFor("/work/a.ts", "text")
    expect(useDrafts.getState().drafts).toBe(first)
  })
})

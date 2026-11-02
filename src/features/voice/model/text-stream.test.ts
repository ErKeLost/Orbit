import { describe, expect, test } from "vitest"
import { updateTextBlock } from "../../../../src-tauri/resources/voice/text-stream.ts"

describe("voice answer stream text", () => {
  test("uses final text when a provider emits no deltas", () => {
    const blocks = new Map<number, string>()
    expect(updateTextBlock(blocks, 0, "The project builds a desktop app.", true)).toBe("The project builds a desktop app.")
  })

  test("does not duplicate streamed text when text_end closes the block", () => {
    const blocks = new Map<number, string>()
    updateTextBlock(blocks, 0, "The project ", false)
    updateTextBlock(blocks, 0, "builds a desktop app.", false)
    expect(updateTextBlock(blocks, 0, "The project builds a desktop app.", true)).toBe("The project builds a desktop app.")
  })

  test("keeps text blocks in provider order", () => {
    const blocks = new Map<number, string>()
    updateTextBlock(blocks, 1, " second", false)
    expect(updateTextBlock(blocks, 0, "First", true)).toBe("First second")
  })
})

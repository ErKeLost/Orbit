import { describe, expect, test } from "bun:test"
import { emptyTranscript, reconnectKeepsTranscript, transcriptLoading } from "../src/lib/protocol"

/**
 * What a reconnect does to the screen.
 *
 * The phone's pairing socket is a WebSocket inside the WebView, so it does not
 * survive the app being backgrounded — coming back always reconnects. That much
 * is Android's, not ours. What *is* ours is whether that reconnect blanks the
 * conversation: it did, on every single return from another app, which is the
 * most common thing a phone does and the least forgivable thing to get wrong.
 */
describe("keeping the transcript through a reconnect", () => {
  const base = { recovery: true, sameConnection: true, hasMessages: true }

  test("a recovery of the session on screen keeps it", () => {
    expect(reconnectKeepsTranscript(base)).toBe(true)
  })

  test("a first connect has nothing to keep", () => {
    expect(reconnectKeepsTranscript({ ...base, hasMessages: false })).toBe(false)
  })

  test("landing on another project must not show the previous one's messages", () => {
    // The rule needs both halves: this is the case that makes `sameConnection`
    // load-bearing rather than a redundant check.
    expect(reconnectKeepsTranscript({ ...base, sameConnection: false })).toBe(false)
  })

  test("switching projects deliberately is not a recovery", () => {
    expect(reconnectKeepsTranscript({ ...base, recovery: false })).toBe(false)
  })
})

describe("the loading flag", () => {
  test("is the only thing the skeleton keys off, so keeping messages is enough", () => {
    const loaded = { ...emptyTranscript(), messages: [{ role: "user", content: "hi" } as never] }
    expect(transcriptLoading(loaded, false)).toBe(loaded)
    expect(transcriptLoading(loaded, true).messages).toBe(loaded.messages)
    expect(transcriptLoading(loaded, true).loading).toBe(true)
  })
})

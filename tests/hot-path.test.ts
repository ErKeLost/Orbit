import { describe, expect, test } from "bun:test"
import { collectChanges } from "../src/lib/changes"
import { gitPollInterval, noteGitPoll } from "../src/lib/git"
import { foregroundFlushDelay } from "../src/lib/stream-cadence"

describe("change panel", () => {
  test("an unchanged tool call is not parsed again", () => {
    const messages = [{ message: { content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "a.ts", content: "hello" } }] } }]
    const first = collectChanges(messages, {})
    const second = collectChanges(messages, {})
    expect(second[0]?.change).toBe(first[0]?.change)
    const edited = [{ message: { content: [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "a.ts", content: "hello!" } }] } }]
    expect(collectChanges(edited, {})[0]?.change).not.toBe(first[0]?.change)
  })
})

describe("git poll", () => {
  test("two unchanged polls stretch the interval, a change restores it", () => {
    const key = `test:${Date.now()}`
    expect(gitPollInterval(false, 0)).toBe(false)
    expect(noteGitPoll(key, "1:2:3")).toBe(0)
    expect(gitPollInterval(true, 0)).toBe(5_000)
    expect(noteGitPoll(key, "1:2:3")).toBe(1)
    expect(noteGitPoll(key, "1:2:3")).toBe(2)
    expect(gitPollInterval(true, 2)).toBe(10_000)
    expect(noteGitPoll(key, "2:0:1")).toBe(0)
  })
})

describe("stream cadence", () => {
  test("a long active reply leaves the animation frame", () => {
    expect(foregroundFlushDelay(100)).toBeNull()
    expect(foregroundFlushDelay(8_000)).toBe(32)
  })
})

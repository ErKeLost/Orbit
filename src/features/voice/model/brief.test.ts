import { describe, expect, test } from "vitest"
import { agentPrompt, callContext, taskOf } from "./brief"
import { playbackReport, quietPrismError } from "./prism-fault"

describe("voice handoff context", () => {
  test("the prompt keeps the call so far and the request", () => {
    const context = callContext([
      { id: "1", role: "user", text: "帮我查一下天气" },
      { id: "2", role: "agent", text: "正在帮你查询。" },
    ])
    expect(context).toContain("Person: 帮我查一下天气")
    expect(context).toContain("Voice: 正在帮你查询。")
    const prompt = agentPrompt("查天气", context)
    expect(prompt).toContain("Call so far:")
    expect(prompt).toContain("Request:\n查天气")
    expect(prompt).toContain("read aloud")
  })

  test("a tool payload wins, a broken one falls back to what was said", () => {
    expect(taskOf('{"task":"weather in Shanghai"}', "帮我查一下天气")).toBe("weather in Shanghai")
    expect(taskOf("not json", "帮我查一下天气")).toBe("not json")
    expect(taskOf("{}", "帮我查一下天气")).toBe("帮我查一下天气")
    expect(taskOf(undefined, "帮我查一下天气")).toBe("帮我查一下天气")
  })
})

describe("prism playback faults", () => {
  test("a reply from before the session was quiet is not shown as a call failure", () => {
    expect(quietPrismError("truncate_not_current", "anything")).toBe(true)
    expect(quietPrismError(undefined, 'the reply "item_1" played before the session was last quiet')).toBe(true)
    expect(quietPrismError("turn_failed", "Prism 拒绝了这次请求")).toBe(false)
  })

  test("a finished reply is not reported as played", () => {
    expect(playbackReport(false, "item_1", 800)).toBeNull()
    expect(playbackReport(true, "", 800)).toBeNull()
    expect(playbackReport(true, "item_1", 800.4)).toEqual({ itemId: "item_1", heardMs: 800 })
  })
})

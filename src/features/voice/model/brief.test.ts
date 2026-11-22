import { describe, expect, test } from "vitest"
import { agentPrompt, emptyBrief, freshContext, nextBrief, noteSpoken, spokenSituation, taskOf } from "./brief"
import { playbackReport, quietPrismError } from "./prism-fault"

describe("voice handoff context", () => {
  test("the first prompt keeps earlier context, not the request itself", () => {
    const turns = [
      { id: "1", role: "user" as const, text: "你好" },
      { id: "2", role: "agent" as const, text: "你好，说吧。" },
      { id: "3", role: "user" as const, text: "帮我查一下天气" },
    ]
    const context = freshContext(turns, "查天气", new Set(), [])
    expect(context).toContain("Person: 你好")
    expect(context).not.toContain("帮我查一下天气")
    const prompt = agentPrompt("查天气", context)
    expect(prompt).toContain("Call so far:")
    expect(prompt).toContain("Request:\n查天气")
    expect(prompt).toContain("spoken aloud")
  })

  test("a later handoff does not replay the call or the instructions", () => {
    const first = nextBrief(emptyBrief, [
      { id: "1", role: "user", text: "你好" },
      { id: "2", role: "agent", text: "你好，说吧。" },
      { id: "3", role: "user", text: "check Beijing weather" },
    ], "Check the weather in Beijing")
    const heard = noteSpoken(first.state, "Beijing is sunny and cold this morning, about minus four degrees.")
    const second = nextBrief(heard, [
      { id: "1", role: "user", text: "你好" },
      { id: "2", role: "agent", text: "你好，说吧。" },
      { id: "3", role: "user", text: "check Beijing weather" },
      { id: "4", role: "agent", text: "Okay, checking the weather in Beijing, just a moment." },
      { id: "5", role: "agent", text: "Beijing is sunny and cold this morning, about minus four degrees." },
      { id: "6", role: "user", text: "check bitcoin" },
    ], "Check the current value of Bitcoin")
    expect(second.prompt).not.toContain("Call so far")
    expect(second.prompt).not.toContain("Do not ask them to repeat it")
    expect(second.prompt).not.toContain("Beijing is sunny")
    expect(second.prompt).not.toContain("你好")
    expect(second.prompt).toContain("Request:\nCheck the current value of Bitcoin")
    expect(second.prompt).toContain("Same voice call")
  })

  test("a situation is data for a prompt, not a line to read", () => {
    const data = spokenSituation("could not send", "查一下现在的价格")
    expect(data).toContain("situation: could not send")
    expect(data).toContain("查一下现在的价格")
    expect(data).not.toContain("还在做")
    expect(data).not.toContain("没发出去")
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

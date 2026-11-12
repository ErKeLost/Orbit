import { describe, expect, test } from "vitest"
import { applyAgentPart, applyAgentSnapshot, disconnectNotice, upsertTurn } from "./turns"

describe("voice turns", () => {
  test("a later shorter agent snapshot does not wipe the live caption", () => {
    const live = applyAgentPart([], "resp-1", "delta", "先看一下目录")
    expect(applyAgentSnapshot(live, "resp-1", "先看").find(item => item.id === "resp-1")?.text).toBe("先看一下目录")
    expect(applyAgentSnapshot(live, "resp-1", "先看一下目录，已经改好了。").at(-1)?.text).toBe("先看一下目录，已经改好了。")
  })

  test("parts append without inserting spaces, and start does not clear an existing caption", () => {
    const started = applyAgentPart([], "resp-1", "start", "")
    const spoken = applyAgentPart(applyAgentPart(started, "resp-1", "delta", "你好"), "resp-1", "delta", "。")
    expect(spoken[0]?.text).toBe("你好。")
    expect(applyAgentPart(spoken, "resp-1", "start", "")[0]?.text).toBe("你好。")
  })

  test("the same user event replaces the tentative line instead of joining it", () => {
    const tentative = upsertTurn([], { id: "user-3", role: "user", text: "改一" }, "replace")
    expect(upsertTurn(tentative, { id: "user-3", role: "user", text: "改一下语音" }, "replace")[0]?.text).toBe("改一下语音")
  })

  test("a user hang-up is not an error, a duration cap is", () => {
    expect(disconnectNotice({ reason: "user" })).toBeNull()
    expect(disconnectNotice({ reason: "error", context: { type: "max_duration_exceeded" } })).toContain("时长上限")
  })
})

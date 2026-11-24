import { describe, expect, test } from "bun:test"
import { announcementOf, decide } from "../src/features/voice/model/route.ts"

describe("voice desk", () => {
  test("an announcement is spoken back, not routed", () => {
    expect(announcementOf("orbit:announce:做完了。")).toBe("做完了。")
    expect(announcementOf("你好")).toBeNull()
  })

  test("a missing or unsure answer never dispatches", () => {
    expect(decide(null, { running: false, pendingId: null })).toEqual({ lane: "speak" })
    expect(decide({ lane: "dispatch", sure: 0.74 }, { running: false, pendingId: null })).toEqual({ lane: "speak" })
    expect(decide({ lane: "confirm", sure: 0.9 }, { running: false, pendingId: null })).toEqual({ lane: "speak" })
    expect(decide({ lane: "control_task", sure: 0.8 }, { running: true, pendingId: null })).toEqual({ lane: "speak" })
  })

  test("a sure dispatch is the user's words, queued when work is already running", () => {
    expect(decide({ lane: "dispatch", sure: 0.9 }, { running: false, pendingId: null })).toEqual({ lane: "dispatch", delivery: "prompt" })
    expect(decide({ lane: "dispatch", sure: 0.9, delivery: "steer" }, { running: true, pendingId: null })).toEqual({ lane: "dispatch", delivery: "steer" })
    expect(decide({ lane: "dispatch", sure: 0.9 }, { running: true, pendingId: null })).toEqual({ lane: "dispatch", delivery: "followUp" })
  })
})

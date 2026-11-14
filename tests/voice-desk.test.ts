import { describe, expect, test } from "bun:test"
import { Desk, announcementOf, withoutAnnouncements } from "../tools/speech-engine/src/desk.ts"
import { ack, decide } from "../src/features/voice/model/route.ts"

describe("voice desk", () => {
  test("an announcement is spoken back, not routed", () => {
    expect(announcementOf("orbit:announce:做完了。")).toBe("做完了。")
    expect(announcementOf("你好")).toBeNull()
    expect(withoutAnnouncements([
      { role: "user", content: "orbit:announce:做完了。" },
      { role: "agent", content: "做完了。" },
      { role: "user", content: "继续" },
    ]).map(item => item.content)).toEqual(["做完了。", "继续"])
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
    expect(ack("started")).toBe("开始了。")
    expect(ack("no-session")).toBe("没有正在用的会话。")
  })

  test("the pipe holds the turn until the desk sends the words", async () => {
    const desk = new Desk()
    const signal = new AbortController().signal
    const { id, spoken } = desk.enqueue("把登录改一下", "", signal)
    const turn = await desk.next(10)
    expect(turn?.id).toBe(id)
    desk.chunk(id, "开始了。")
    desk.end(id)
    const text: string[] = []
    for await (const chunk of spoken) text.push(chunk)
    expect(text).toEqual(["开始了。"])
  })
})

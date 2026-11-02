import { describe, expect, test } from "vitest"
import { requestsRefresh, TaskLedger, voiceTaskKey } from "./task-ledger"

describe("voice task ledger", () => {
  test("normalizes weather wording to one reusable task key", () => {
    expect(voiceTaskKey("北京现在天气怎么样？", "lookup")).toBe(voiceTaskKey("查一下北京天气预报", "lookup"))
  })

  test("reuses a fresh settled result and expires it", () => {
    const ledger = new TaskLedger()
    const record = ledger.start({ taskId: "t1", targetSession: "/session", kind: "lookup", request: "查北京天气", now: 100 })
    ledger.markRunning(record.taskId, "/session", 110)
    ledger.settle(record.taskId, "/session", "Sunny, 17 degrees.", "lookup", 120)
    expect(ledger.findReusable(voiceTaskKey("北京天气怎么样", "lookup"), "/session", 121)?.result).toBe("Sunny, 17 degrees.")
    expect(ledger.findReusable(voiceTaskKey("北京天气怎么样", "lookup"), "/session", 5 * 60_000 + 121)).toBeUndefined()
  })

  test("refresh wording bypasses reuse", () => {
    expect(requestsRefresh("重新查一下北京最新天气")).toBe(true)
    expect(requestsRefresh("天气怎么样")).toBe(false)
  })
})

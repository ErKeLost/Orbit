import { describe, expect, test } from "vitest"
import { gateOpen } from "./route"

describe("Jev only opens the gate", () => {
  test("a missing or unsure answer does not hand the words to Pi", () => {
    expect(gateOpen(null)).toBe(false)
    expect(gateOpen({})).toBe(false)
    expect(gateOpen({ answers: { handoff: { noul: 0.74 } } })).toBe(false)
    expect(gateOpen({ answers: { handoff: {} } })).toBe(false)
  })

  test("a sure yes is the only handoff", () => {
    expect(gateOpen({ answers: { handoff: { noul: 0.75 } } })).toBe(true)
    expect(gateOpen({ answers: { handoff: { noul: 0.91 } } })).toBe(true)
  })
})

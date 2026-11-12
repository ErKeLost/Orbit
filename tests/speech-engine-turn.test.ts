import { describe, expect, test } from "bun:test"
import { compose } from "../tools/speech-engine/src/turn.ts"
import { previousAgentText } from "../tools/speech-engine/src/utterance.ts"

describe("voice lane", () => {
  test("only a sure yes wakes the agent", () => {
    expect(compose("anything", 0.75)).toEqual({ kind: "pi", text: "anything" })
    expect(compose("anything", 0.74)).toEqual({ kind: "speak", text: "anything" })
    expect(compose("anything", null)).toEqual({ kind: "speak", text: "anything" })
  })

  test("the gate sees the previous spoken line and nothing else", () => {
    expect(previousAgentText([
      { role: "user", content: "first" },
      { role: "agent", content: "previous" },
      { role: "user", content: "again" },
    ])).toBe("previous")
  })
})

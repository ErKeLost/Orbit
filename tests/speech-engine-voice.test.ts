import { PassThrough } from "node:stream"
import { describe, expect, test } from "bun:test"
import { readLfLines } from "../tools/speech-engine/src/lines.ts"
import { dropReason, fillerFor, latestUserText } from "../tools/speech-engine/src/utterance.ts"

describe("speech engine utterance", () => {
  test("only the newest user line is forwarded", () => {
    expect(latestUserText([
      { role: "user", content: "第一句" },
      { role: "agent", content: "在" },
      { role: "user", content: " 第二句 " },
    ])).toBe("第二句")
  })

  test("silence and a room-length transcript are not requests", () => {
    expect(dropReason("...")).toBe("empty")
    expect(dropReason("")).toBe("empty")
    expect(dropReason("改一下")).toBeNull()
    expect(dropReason("a".repeat(1201))).toBe("background")
  })

  test("a stock ack is not invented", () => {
    const previous = process.env.FILLER
    delete process.env.FILLER
    expect(fillerFor("改一下")).toBe("")
    process.env.FILLER = "hold on"
    expect(fillerFor("改一下")).toBe("hold on ")
    if (previous === undefined) delete process.env.FILLER
    else process.env.FILLER = previous
  })
})

describe("speech engine rpc lines", () => {
  test("splits on LF and keeps a unicode line separator inside the record", async () => {
    const stream = new PassThrough()
    const lines: string[] = []
    readLfLines(stream, line => lines.push(line))
    stream.write(`{"text":"a\u2028b"}\n`)
    stream.end()
    await new Promise(resolve => stream.on("end", resolve))
    expect(lines).toEqual(['{"text":"a\u2028b"}'])
  })
})

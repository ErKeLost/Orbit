import { describe, expect, test } from "bun:test"
import { deliverPtyEvent, ptyLocalEvent } from "../src/lib/remote-pty"
import type { RemoteEvent } from "../src/lib/remote-protocol"

/**
 * Terminal frames, socket → local event bus.
 *
 * The dock on a phone is the same component as the dock on the desktop, so it
 * listens for the same two events. What has to stay true is the translation: the
 * right local name for each frame, the payload left exactly as it arrived
 * (base64 stays base64 — PTY output is bytes, not text, and decoding it here
 * would be the second place that decision is made), and nothing else on the
 * socket being treated as terminal traffic.
 */
const frame = (event: RemoteEvent, send: (name: string, payload: unknown) => Promise<unknown> = async () => undefined) =>
  deliverPtyEvent(event, send)

describe("forwarded terminal frames", () => {
  test("output becomes pty-data, bytes untouched", () => {
    expect(ptyLocalEvent({ type: "pty.event", id: "t1", data: "G1sx" })).toEqual({
      name: "pty-data",
      payload: { id: "t1", data: "G1sx" },
    })
  })

  test("a finished child becomes pty-exit, including a signal", () => {
    expect(ptyLocalEvent({ type: "pty.exit", id: "t1", code: 0 })).toEqual({
      name: "pty-exit",
      payload: { id: "t1", code: 0 },
    })
    // `null` is "no exit code", not "no event": it must survive the trip.
    expect(ptyLocalEvent({ type: "pty.exit", id: "t1", code: null })).toEqual({
      name: "pty-exit",
      payload: { id: "t1", code: null },
    })
  })

  test("every other frame on the socket is left alone", () => {
    const others = [
      { type: "host.pong", serverTime: 1 },
      { type: "pi.event", project: "/w", payload: { type: "x" } },
      { type: "remote.error", error: "boom" },
    ] as RemoteEvent[]
    for (const event of others) expect(ptyLocalEvent(event)).toBeNull()
  })
})

describe("delivering terminal frames", () => {
  test("passes the local name and the payload through", async () => {
    const sent: { name: string; payload: unknown }[] = []
    const handled = await frame({ type: "pty.event", id: "t1", data: "aGk=" }, async (name, payload) => {
      sent.push({ name, payload })
    })
    expect(handled).toBe(true)
    expect(sent).toEqual([{ name: "pty-data", payload: { id: "t1", data: "aGk=" } }])
  })

  test("reports a frame it does not own without emitting anything", async () => {
    let called = 0
    const handled = await frame({ type: "connection.closed", project: "/w" }, async () => {
      called += 1
    })
    expect(handled).toBe(false)
    expect(called).toBe(0)
  })

  test("a failing bus cannot take the socket down with it", async () => {
    // The pairing socket also carries the transcript; a terminal that cannot be
    // drawn is not a reason to drop it.
    const handled = await frame({ type: "pty.event", id: "t1", data: "" }, async () => {
      throw new Error("window is gone")
    })
    expect(handled).toBe(true)
  })
})

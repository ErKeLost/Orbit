import { describe, expect, test } from "vitest"
import type { RemoteEvent } from "./remote-protocol"
import { deliverVoiceEvent, subscribeVoiceRemote } from "./voice-remote"

describe("forwarded prism events", () => {
  test("a voice frame reaches the call, and nothing else does", () => {
    const seen: string[] = []
    const stop = subscribeVoiceRemote(event => {
      if (event.kind) seen.push(event.kind)
    })
    expect(deliverVoiceEvent({ type: "voice.event", event: { kind: "ready" } })).toBe(true)
    expect(deliverVoiceEvent({ type: "pty.event", id: "t", data: "aa" } as RemoteEvent)).toBe(false)
    expect(seen).toEqual(["ready"])
    stop()
  })
})

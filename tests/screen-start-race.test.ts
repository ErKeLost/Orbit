import { describe, expect, mock, test } from "bun:test"

// The first frame of a stream can reach the phone before the reply to
// `screen.start`. It is the only frame that carries the decoder configuration,
// so if the reply handler throws the decoder away, the picture is black while
// the frame counter looks perfectly healthy (the 28 fps black preview).

const globals = globalThis as unknown as Record<string, unknown>

class FakeVideoDecoder {
  static instances: FakeVideoDecoder[] = []
  configured = 0
  decoded = 0
  closed = false
  reset() {}
  constructor(public init: { output: (frame: unknown) => void; error: (e: unknown) => void }) {
    FakeVideoDecoder.instances.push(this)
  }
  static async isConfigSupported() { return { supported: true } }
  configure() { this.configured += 1 }
  decode() { this.decoded += 1 }
  close() { this.closed = true }
}
class FakeEncodedVideoChunk { constructor(public init: unknown) {} }

globals.VideoDecoder = FakeVideoDecoder
globals.EncodedVideoChunk = FakeEncodedVideoChunk
globals.window ??= { addEventListener() {}, removeEventListener() {} }
globals.localStorage ??= { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }

type Handlers = { onEvent?: (event: unknown) => void; onState?: (s: string) => void; onHandshake?: (t: number) => void }
let handlers: Handlers = {}
let deliverFrameBeforeReply: (() => void) | null = null

const fakeClient = {
  connectionState: "online",
  async request(payload: { type: string }) {
    if (payload.type === "screen.start") {
      // The host answers after it has already started sending.
      deliverFrameBeforeReply?.()
      return { display: { id: 1, name: "显示器 1" }, displays: [], codec: "h264", width: 1080, height: 608 }
    }
    return { running: true }
  },
  notifyForeground() {},
  close() {},
}

mock.module("../src/lib/remote-runtime", () => ({
  screenRemoteChannel: async (h: Handlers) => { handlers = h; return fakeClient },
  addRemoteForegroundListener: () => () => undefined,
  sendRemoteScreenAck: () => undefined,
  sendRemoteScreenInput: () => undefined,
}))

const { screenChannel, decoderActionOnStart } = await import("../src/lib/remote-screen")

// avcC with SPS 4d401f
const description = Buffer.from([1, 0x4d, 0x40, 0x1f, 0xff, 0xe1, 0, 4, 0x67, 0x4d, 0x40, 0x1f, 1, 0, 2, 0x68, 0xee]).toString("base64")
const frame = (seq: number, keyframe: boolean, withDescription: boolean) => ({
  type: "screen.frame", seq, capturedAt: seq, encodedAt: seq, width: 1080, height: 608,
  codec: "h264", keyframe, resync: keyframe, description: withDescription ? description : null,
  bytes: 4, data: Buffer.from([0, 0, 0, 1]).toString("base64"),
})

describe("decoderActionOnStart", () => {
  test("a decoder that already took frames is kept", () => {
    expect(decoderActionOnStart({ codec: "h264", hasDecoder: true, framesSinceRequest: 3 })).toBe("keep")
  })
  test("builds one when there is none, or when nothing arrived yet", () => {
    expect(decoderActionOnStart({ codec: "h264", hasDecoder: false, framesSinceRequest: 0 })).toBe("build")
    expect(decoderActionOnStart({ codec: "h264", hasDecoder: true, framesSinceRequest: 0 })).toBe("build")
  })
  test("jpeg never keeps a video decoder", () => {
    expect(decoderActionOnStart({ codec: "jpeg", hasDecoder: true, framesSinceRequest: 9 })).toBe("release")
  })
})

describe("screen.start reply racing the first frame", () => {
  test("the first keyframe is decoded even though it arrives before the reply", async () => {
    FakeVideoDecoder.instances.length = 0
    const channel = screenChannel()
    deliverFrameBeforeReply = () => handlers.onEvent?.(frame(1, true, true))
    await channel.start({ codec: "h264" })
    const alive = FakeVideoDecoder.instances.filter(d => !d.closed)
    expect(alive.length).toBe(1)
    // The keyframe went to the decoder instead of being dropped, and the
    // decoder was configured from the description that came with it.
    expect(alive[0]!.configured).toBeGreaterThan(0)
    expect(alive[0]!.decoded).toBe(1)
    // Same fact from the channel's side: the frame reached the screen state and
    // nothing was reported as an error.
    expect(channel.current.frame?.seq).toBe(1)
    expect(channel.current.error).toBeNull()
  })

  test("later frames keep decoding after the reply", async () => {
    const channel = screenChannel()
    const live = FakeVideoDecoder.instances.filter(d => !d.closed)[0]!
    const before = live.decoded
    handlers.onEvent?.(frame(2, false, false))
    handlers.onEvent?.(frame(3, false, false))
    expect(live.decoded).toBe(before + 2)
    expect(channel.current.frame?.seq).toBe(3)
    expect(channel.current.error).toBeNull()
  })
})

describe("keyframe re-request from the watchdog", () => {
  test("a second screen.start while frames are flowing does not tear the decoder down", async () => {
    const channel = screenChannel()
    const live = FakeVideoDecoder.instances.filter(d => !d.closed)
    expect(live.length).toBe(1)
    const decoder = live[0]!
    // The watchdog re-issues `screen.start` to get a keyframe; the host answers
    // after it has already forced one and started sending it.
    deliverFrameBeforeReply = () => handlers.onEvent?.(frame(10, true, true))
    await channel.start({ codec: "h264" })
    const aliveNow = FakeVideoDecoder.instances.filter(d => !d.closed)
    expect(aliveNow.length).toBe(1)
    expect(aliveNow[0]).toBe(decoder)
    expect(decoder.closed).toBe(false)
    // And that keyframe was actually used.
    expect(channel.current.error).toBeNull()
    expect(decoder.configured).toBeGreaterThan(0)
  })
})

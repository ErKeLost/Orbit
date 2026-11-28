// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const deps = vi.hoisted(() => ({
  invoke: vi.fn(),
  prepare: vi.fn(async () => {}),
  mic: vi.fn(),
  player: vi.fn(),
  openSession: vi.fn(async () => {}),
}))
vi.mock("@/lib/native", () => ({ invoke: deps.invoke }))
vi.mock("@/lib/runtime", () => ({ mobileRuntime: () => true }))
vi.mock("@/lib/remote-workspace", () => ({ remoteCanInvoke: () => true }))
vi.mock("@/lib/store", () => ({ useWorkspace: { getState: () => ({ cwd: "/project" }) } }))
vi.mock("./handoff", () => ({
  beginFreshVoiceSession: deps.openSession,
  cancelVoiceSessionOpening: vi.fn(),
  haltVoiceWork: vi.fn(),
  handToAgent: vi.fn(async () => "no"),
}))
vi.mock("./prism-mic", () => ({
  PrismMic: class {
    constructor(handlers: { onAudio: (audio: string) => void }) { deps.mic(handlers) }
    async start() {}
    stop() {}
  },
}))
vi.mock("./pcm-player", () => ({
  PcmPlayer: class {
    constructor(_onLevel: (level: number) => void, onDrained: () => void) { deps.player(this, onDrained) }
    playing = false
    prepare = deps.prepare
    push(_audio: string, _itemId: string) { this.playing = true }
    stop() { this.playing = false; return { itemId: "", heardMs: 0 } }
    async close() {}
  },
}))

import { VoiceCall } from "./call"
import { deliverVoiceEvent } from "@/lib/voice-remote"

let call: VoiceCall
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  deps.invoke.mockImplementation(async (command: string) => command === "rime_config" ? { hasCredential: true } : undefined)
  call = new VoiceCall()
})
afterEach(async () => {
  await call.stop()
  vi.useRealTimers()
})

it("unlocks playback before the network handshake and accepts repeated words in separate turns", async () => {
  const started = call.start()
  expect(deps.prepare).toHaveBeenCalledOnce()
  await started
  const send = (kind: string, extra = {}) => deliverVoiceEvent({ type: "voice.event", event: { kind, ...extra } })
  deps.mic.mock.calls[0][0].onAudio("AAAA")
  expect(deps.invoke).toHaveBeenCalledWith("rime_prism_audio", { audioBase64: "AAAA" })
  for (const id of ["one", "two"]) {
    send("speech_started")
    send("speech_stopped")
    expect(call.getSnapshot().state).toBe("thinking")
    send("transcript", { text: "你好", itemId: id })
    send("transcript", { text: "你好", itemId: id })
    send("reply", { text: "你好，有什么可以帮你？", itemId: `${id}-reply` })
    expect(call.getSnapshot().state).toBe("listening")
  }
  expect(call.getSnapshot().turns.filter(turn => turn.role === "user")).toEqual([
    { id: "one", role: "user", text: "你好" }, { id: "two", role: "user", text: "你好" },
  ])
})

it("keeps a live mobile reply playing when transcription arrives late and settles when PCM drains", async () => {
  const [player, drained] = deps.player.mock.calls[0]
  await call.start()
  const send = (kind: string, extra = {}) => deliverVoiceEvent({ type: "voice.event", event: { kind, ...extra } })
  deps.mic.mock.calls[0][0].onAudio("AAAA")
  send("speech_started")
  send("speech_stopped")
  send("audio", { itemId: "answer", audio: "AAA=" })
  send("transcript", { itemId: "question", text: "Can you hear me?" })
  expect(call.getSnapshot().state).toBe("speaking")
  send("audio_done", { itemId: "answer" })
  player.playing = false
  drained()
  expect(call.getSnapshot().state).toBe("listening")
  await vi.advanceTimersByTimeAsync(16_000)
  expect(call.getSnapshot().error).toBeNull()
})

it("surfaces a speech timeout and an audio transport failure", async () => {
  await call.start()
  deps.mic.mock.calls[0][0].onAudio("AAAA")
  deliverVoiceEvent({ type: "voice.event", event: { kind: "speech_stopped" } })
  await vi.advanceTimersByTimeAsync(12_000)
  expect(call.getSnapshot()).toMatchObject({ state: "listening", error: expect.stringContaining("没有收到识别结果") })
  deps.invoke.mockRejectedValueOnce(new Error("disconnected"))
  deps.mic.mock.calls[0][0].onAudio("AAAA")
  await vi.advanceTimersByTimeAsync(0)
  expect(call.getSnapshot()).toMatchObject({ state: "off", error: expect.stringContaining("音频发送失败") })
})

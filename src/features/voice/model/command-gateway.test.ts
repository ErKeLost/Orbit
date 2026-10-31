import { beforeEach, describe, expect, test, vi } from "vitest"
import type { VoiceDecision } from "../../../../src-tauri/resources/voice/contract"
const fixture = vi.hoisted(() => ({ snapshot: { connection: "online", state: { sessionFile: "/voice" }, dialogs: [] }, connections: new Map([["voice", {}]]), request: vi.fn(), prompt: vi.fn(), answer: vi.fn() }))
vi.mock("@/lib/rpc-core", () => ({ current: () => fixture.snapshot, connections: fixture.connections, request: fixture.request }))
vi.mock("@/lib/rpc-session", () => ({ sendPrompt: fixture.prompt, answerDialog: fixture.answer }))
const { CommandGateway } = await import("./command-gateway")
const binding = { connectionId: "voice", sessionFile: "/voice" }
const decision = { intent: "dispatch_task" } as VoiceDecision
describe("voice command delivery", () => {
  beforeEach(() => {
    vi.clearAllMocks(); fixture.snapshot.state.sessionFile = "/voice"
    fixture.request.mockResolvedValue({ sessionFile: "/voice", isStreaming: true })
    fixture.prompt.mockResolvedValue({})
  })
  test("hangup during state validation prevents delivery", async () => {
    let release!: (value: unknown) => void
    fixture.request.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const abort = new AbortController()
    const delivery = new CommandGateway().execute("turn", binding, decision, "fix login", undefined, abort.signal)
    abort.abort(); release({ sessionFile: "/voice", isStreaming: true })
    await expect(delivery).rejects.toThrow(); expect(fixture.prompt).not.toHaveBeenCalled()
  })
  test("delivery remains fenced across the prompt's queue preflight", async () => {
    fixture.prompt.mockImplementationOnce(async (_command, _target, _running, guard) => { fixture.snapshot.state.sessionFile = "/replacement"; guard() })
    await expect(new CommandGateway().execute("turn", binding, decision, "fix login")).rejects.toThrow("会话")
  })
  test("retrying an accepted command does not dispatch it twice", async () => {
    const gateway = new CommandGateway()
    await Promise.all([gateway.execute("turn", binding, decision, "fix login"), gateway.execute("turn", binding, decision, "fix login")])
    expect(fixture.prompt).toHaveBeenCalledOnce()
    expect(fixture.prompt.mock.calls[0]![0]).toMatchObject({ streamingBehavior: "followUp" })
  })
})

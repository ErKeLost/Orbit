import { beforeEach, describe, expect, test, vi } from "vitest"
import type { VoiceDecision } from "../../../../src-tauri/resources/voice/contract"
const fixture = vi.hoisted(() => ({ snapshot: { connection: "online", state: { sessionFile: "/voice" }, dialogs: [] }, connections: new Map([["voice", {}]]), request: vi.fn(), prompt: vi.fn(), answer: vi.fn() }))
vi.mock("@/lib/rpc-core", () => ({ current: () => fixture.snapshot, connections: fixture.connections, request: fixture.request }))
vi.mock("@/lib/rpc-session", () => ({ sendPrompt: fixture.prompt, answerDialog: fixture.answer }))
const { CommandGateway, stopBoundTask } = await import("./command-gateway")
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
  test("task stop clears queued work before aborting, and never submits replacement work", async () => {
    await new CommandGateway().execute("stop",binding,{intent:"control_task"} as VoiceDecision,"stop")
    expect(fixture.request.mock.calls.map(call=>call[0].type)).toEqual(["get_state","clear_queue","abort"])
    expect(fixture.request.mock.calls.every(call=>call[2]==="voice")).toBe(true)
    expect(fixture.prompt).not.toHaveBeenCalled()
  })
  test("an interrupted stop still aborts after clearing the queue", async () => {
    const controller=new AbortController()
    fixture.request.mockImplementation(async (command)=>{
      if(command.type==="clear_queue")controller.abort()
      return {sessionFile:"/voice"}
    })
    await stopBoundTask(binding,controller.signal)
    expect(fixture.request.mock.calls.map(call=>call[0].type)).toEqual(["get_state","clear_queue","abort"])
  })
  test("queue cleanup failure still sends abort and reports incomplete cleanup", async () => {
    fixture.request.mockImplementation(async command => {
      if (command.type === "clear_queue") throw new Error("queue timed out")
      return { sessionFile: "/voice" }
    })
    await expect(stopBoundTask(binding)).rejects.toThrow("队列清理失败")
    expect(fixture.request.mock.calls.map(call => call[0].type)).toEqual(["get_state", "clear_queue", "abort"])
  })
  test("a changed session identity prevents an abort of the replacement", async () => {
    fixture.request.mockResolvedValueOnce({sessionFile:"/replacement"})
    await expect(stopBoundTask(binding)).rejects.toThrow("身份已改变")
    expect(fixture.request).toHaveBeenCalledOnce()
  })
  test("changing the session during queue cleanup prevents aborting the new session", async () => {
    fixture.request.mockImplementation(async command=>{
      if(command.type==="clear_queue")fixture.snapshot.state.sessionFile="/replacement"
      return {sessionFile:"/voice"}
    })
    await expect(stopBoundTask(binding)).rejects.toThrow("更换")
    expect(fixture.request.mock.calls.map(call=>call[0].type)).toEqual(["get_state","clear_queue"])
  })
})

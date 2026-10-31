import { beforeEach, describe, expect, test, vi } from "vitest"

const fake = vi.hoisted(() => ({ handlers: null as Record<string, (...args: unknown[]) => unknown> | null, open: vi.fn(), push: vi.fn(async () => {}), finish: vi.fn(async () => ({ text: "hello" })), abort: vi.fn(async () => {}), fallback:vi.fn(async()=>({text:"fallback"})) }))
vi.mock("./micCapture", () => ({
  MicCapture: class { constructor(handlers: typeof fake.handlers) { fake.handlers = handlers } setEndpointMs() {} setListening() {} async start() {} stop() {} setAgentSpeaking() {} },
  pcmToBase64: (pcm: Int16Array) => btoa(String.fromCharCode(...new Uint8Array(pcm.buffer))),
}))
vi.mock("@/lib/rpc-projects", () => ({ rimeSttOpen: fake.open, rimeSttPush: fake.push, rimeSttFinish: fake.finish, rimeSttAbort: fake.abort, rimeStt: fake.fallback }))
const { SpeechInput } = await import("./speech-input")
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }
describe("speech stream capture", () => {
  beforeEach(() => { vi.clearAllMocks(); fake.finish.mockReset().mockResolvedValue({text:"hello"}); fake.open.mockReset().mockImplementation(async () => ({ id: crypto.randomUUID(), language: "en" })) })
  test("first frames survive an opening stream and the final short batch is flushed before end", async () => {
    let release!: (value: { id: string; language: string }) => void
    fake.open.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const onText = vi.fn(), input = new SpeechInput({ endpointMs: 450 }, { onStart() {}, onPartial() {}, onText, onLevel() {}, onError() {}, onBargeIn() {} })
    await input.start()
    fake.handlers!.onSpeechStart!()
    fake.handlers!.onChunk!(new Int16Array([11, 12]))
    fake.handlers!.onChunk!(new Int16Array([13, 14]))
    fake.handlers!.onChunk!(new Int16Array([15]))
    fake.handlers!.onUtterance!({ pcm: new Int16Array([11, 12, 13, 14, 15]), durationMs: 60 })
    expect(fake.push).not.toHaveBeenCalled()
    release({ id: "first", language: "en" }); await tick()
    expect(fake.push.mock.calls.map(call => [...new Int16Array(Uint8Array.from(atob(String(call[1])), c => c.charCodeAt(0)).buffer)])).toEqual([[11,12,13,14],[15]])
    expect(fake.finish).toHaveBeenCalledWith("first")
    expect(fake.push.mock.invocationCallOrder.at(-1)).toBeLessThan(fake.finish.mock.invocationCallOrder[0]!)
    expect(onText).toHaveBeenCalledOnce(); input.stop()
  })
  test("a final transcript arriving after hangup cannot create a user turn", async () => {
    let release!: (value: { text: string }) => void
    fake.finish.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const onText = vi.fn(), input = new SpeechInput({ endpointMs: 450 }, { onStart() {}, onPartial() {}, onText, onLevel() {}, onError() {}, onBargeIn() {} })
    await input.start(); fake.handlers!.onSpeechStart!(); fake.handlers!.onUtterance!({ pcm: new Int16Array([1]), durationMs: 80 }); await tick()
    input.stop(); release({ text: "do something" }); await tick()
    expect(onText).not.toHaveBeenCalled(); expect(fake.abort).toHaveBeenCalled()
  })
  test("resuming before recognition finishes keeps earlier words even when results arrive out of order", async () => {
    const finals: ((value: { text: string }) => void)[] = []
    fake.finish.mockImplementationOnce(() => new Promise(resolve => finals.push(resolve)))
    fake.finish.mockImplementationOnce(() => new Promise(resolve => finals.push(resolve)))
    const onStart = vi.fn(), onText = vi.fn(), onPartial = vi.fn()
    const input = new SpeechInput({ endpointMs: 450 }, { onStart, onPartial, onText, onLevel() {}, onError() {}, onBargeIn() {} })
    await input.start()
    fake.handlers!.onSpeechStart!()
    fake.open.mock.calls[0]![0]({partial:"Open"})
    fake.open.mock.calls[0]![0]({partial:"Open the browser"})
    expect(onPartial).toHaveBeenLastCalledWith("Open the browser")
    fake.handlers!.onUtterance!({ pcm: new Int16Array([1]), durationMs: 1000 }); await tick()
    fake.handlers!.onSpeechStart!()
    fake.open.mock.calls[1]![0]({partial:"and go to Baidu"})
    expect(onPartial).toHaveBeenLastCalledWith("Open the browser and go to Baidu")
    fake.handlers!.onUtterance!({ pcm: new Int16Array([2]), durationMs: 1000 }); await tick()
    finals[1]!({text:"and go to Baidu"}); await tick()
    expect(onText).not.toHaveBeenCalled()
    finals[0]!({text:"Open the browser"}); await tick()
    expect(new Set(onStart.mock.calls.map(call => call[0])).size).toBe(1)
    expect(onText).toHaveBeenCalledExactlyOnceWith("Open the browser and go to Baidu", onStart.mock.calls[0]![0], expect.objectContaining({durationMs:2000}))
    input.stop()
  })
  test("a duration split stays in the same user turn and cannot dispatch until the speaker finishes", async () => {
    fake.finish.mockResolvedValueOnce({text:"open"}).mockResolvedValueOnce({text:"open"}).mockResolvedValueOnce({text:"open the browser"})
    const onText = vi.fn(), onStart = vi.fn(), onEndpoint = vi.fn()
    const input = new SpeechInput({ endpointMs: 450 }, { onStart, onPartial() {}, onText, onEndpoint, onLevel() {}, onError() {}, onBargeIn() {} })
    await input.start()
    for (let index=0; index<3; index++) {
      fake.handlers!.onSpeechStart!()
      fake.handlers!.onUtterance!({pcm:new Int16Array([index+1]),durationMs:20000,endReason:index<2?"segment":"silence"})
      await tick()
      if (index<2) { expect(onText).not.toHaveBeenCalled(); expect(onEndpoint).not.toHaveBeenCalled() }
    }
    expect(new Set(onStart.mock.calls.map(call => call[0])).size).toBe(1)
    expect(onText).toHaveBeenCalledExactlyOnceWith("open open open the browser",onStart.mock.calls[0]![0],expect.objectContaining({durationMs:60000}))
    expect(onEndpoint).toHaveBeenCalledOnce(); input.stop()
  })
  test("noise after a completed segment cannot discard the preceding speech", async () => {
    const onText = vi.fn(), onDiscard = vi.fn()
    const input = new SpeechInput({endpointMs:450},{onStart(){},onPartial(){},onText,onDiscard,onLevel(){},onError(){},onBargeIn(){}})
    await input.start();fake.handlers!.onSpeechStart!()
    fake.handlers!.onUtterance!({pcm:new Int16Array([1]),durationMs:20000,endReason:"segment"});await tick()
    expect(onText).not.toHaveBeenCalled()
    fake.handlers!.onSpeechStart!();fake.handlers!.onDiscard!();await tick()
    expect(onText).toHaveBeenCalledExactlyOnceWith("hello",expect.any(String),expect.anything())
    expect(onDiscard).not.toHaveBeenCalled();input.stop()
  })
  test("a previous turn that already committed is not merged into a later request", async () => {
    const onStart=vi.fn(),onText=vi.fn()
    const input=new SpeechInput({endpointMs:450},{onStart,onPartial(){},onText,onLevel(){},onError(){},onBargeIn(){}})
    await input.start()
    for(let index=0;index<2;index++) {fake.handlers!.onSpeechStart!();fake.handlers!.onUtterance!({pcm:new Int16Array([1]),durationMs:100});await tick()}
    expect(onText).toHaveBeenCalledTimes(2)
    expect(onStart.mock.calls[0]![0]).not.toBe(onStart.mock.calls[1]![0]);input.stop()
  })
  test("a failed earlier segment cannot dispatch only the successful tail", async () => {
    let reject!: (error: unknown) => void
    fake.finish.mockImplementationOnce(()=>new Promise((_resolve,fail)=>{reject=fail})).mockResolvedValueOnce({text:"only the last words"})
    const onText=vi.fn(),onError=vi.fn()
    const input=new SpeechInput({endpointMs:450},{onStart(){},onPartial(){},onText,onLevel(){},onError,onBargeIn(){}})
    await input.start()
    for(let index=0;index<2;index++){fake.handlers!.onSpeechStart!();fake.handlers!.onUtterance!({pcm:new Int16Array([1]),durationMs:20000,endReason:index===0?"segment":"silence"});await tick()}
    expect(onText).not.toHaveBeenCalled()
    reject({kind:"resource_exhausted",message:"capacity reached",retryable:false});await tick()
    expect(onError).toHaveBeenCalledOnce();expect(onText).not.toHaveBeenCalled();input.stop()
  })
  test("an opening failure falls back using the complete captured utterance", async () => {
    fake.open.mockRejectedValueOnce(new Error("opening failed"))
    const onText=vi.fn(), onError=vi.fn()
    const input=new SpeechInput({endpointMs:450},{onStart(){},onPartial(){},onText,onLevel(){},onError,onBargeIn(){}})
    await input.start();fake.handlers!.onSpeechStart!();fake.handlers!.onUtterance!({pcm:new Int16Array([1,2]),durationMs:80});await tick()
    expect(onText).toHaveBeenCalledWith("fallback",expect.any(String),expect.anything());expect(onError).not.toHaveBeenCalled();input.stop()
  })
  test.each(["unauthenticated","permission_denied","invalid_input","resource_exhausted"])("a %s failure is surfaced without re-uploading the recording", async kind => {
    fake.open.mockRejectedValueOnce({kind,message:"Rime rejected the request",retryable:false,requestId:"failed-1"})
    const onError=vi.fn(),onText=vi.fn()
    const input=new SpeechInput({endpointMs:450},{onStart(){},onPartial(){},onText,onLevel(){},onError,onBargeIn(){}})
    await input.start(); await tick()
    fake.handlers!.onSpeechStart!(); fake.handlers!.onUtterance!({pcm:new Int16Array([1,2]),durationMs:80}); await tick()
    expect(fake.fallback).not.toHaveBeenCalled(); expect(onText).not.toHaveBeenCalled()
    expect(onError).toHaveBeenCalledWith(expect.stringContaining("failed-1")); input.stop()
  })
})

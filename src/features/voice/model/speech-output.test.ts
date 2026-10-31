import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import type { TtsEvent } from "@/lib/rpc-projects"

const fake = vi.hoisted(() => ({
  streams: [] as { audio:(audio:string,rate?:number)=>void; event:(event:TtsEvent)=>void }[],
  open: vi.fn(), send: vi.fn(async () => {}), finish: vi.fn(async () => {}), cancel: vi.fn(async () => {}),
}))
vi.mock("@/lib/rpc-projects", () => ({ rimeTtsStream: fake.open, rimeTtsSend: fake.send, rimeTtsFinish: fake.finish, rimeTtsCancel: fake.cancel }))
import { SpeechOutput } from "./speech-output"

class FakeAudioContext {
  static buffers: { rate:number; data:Float32Array }[] = []
  static sources: { onended: (()=>void) | null; stop:ReturnType<typeof vi.fn> }[] = []
  state = "running"
  currentTime = 1
  destination = {}
  async resume() {}
  async close() {}
  createAnalyser() { return {fftSize:256,connect() {},getFloatTimeDomainData(samples:Float32Array) {samples.fill(0)}} }
  createBuffer(_channels:number,size:number,rate:number) {
    const data = new Float32Array(size); FakeAudioContext.buffers.push({rate,data})
    return {duration:size/rate,getChannelData() {return data}}
  }
  createBufferSource() {
    const source = { buffer:null,connect() {},disconnect() {},start() {},stop:vi.fn(),onended:null as (()=>void)|null }
    FakeAudioContext.sources.push(source); return source
  }
}
const tick = async () => { for(let index=0;index<20;index++) await Promise.resolve() }
let output: SpeechOutput
const handlers = { onActivity:vi.fn(),onLevel:vi.fn(),onFirstAudio:vi.fn(),onComplete:vi.fn(),onRequest:vi.fn(),onError:vi.fn() }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); fake.streams = []; FakeAudioContext.buffers=[]; FakeAudioContext.sources=[]
  vi.stubGlobal("AudioContext", FakeAudioContext)
  fake.open.mockImplementation(async (audio,event) => { fake.streams.push({audio,event}); return {id:`stream-${fake.streams.length}`,sampleRate:22050} })
  output = new SpeechOutput(handlers)
})
afterEach(() => { output.dispose(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe("Rime streaming playback", () => {
  test("token bursts retain spaces and flush the last text before end", async () => {
    await output.prepare(); output.begin(); output.append("Hello"); output.append(" "); output.append("world.")
    expect(fake.send).not.toHaveBeenCalled()
    output.finish(); await tick()
    expect(fake.send).toHaveBeenCalledExactlyOnceWith("stream-1","Hello world.")
    expect(fake.finish).toHaveBeenCalledExactlyOnceWith("stream-1")
    expect(fake.send.mock.invocationCallOrder[0]).toBeLessThan(fake.finish.mock.invocationCallOrder[0]!)
  })
  test("streamed text is sent within one small batch without waiting for a complete answer", async () => {
    output.begin(); output.append("A partial ")
    await vi.advanceTimersByTimeAsync(16)
    expect(fake.send).toHaveBeenCalledWith("stream-1","A partial ")
    expect(fake.finish).not.toHaveBeenCalled()
  })
  test("odd transport chunks form whole PCM16 samples at the model's native rate", async () => {
    await output.prepare(); output.begin(); await tick()
    fake.streams[0]!.audio(btoa("\x00"))
    expect(FakeAudioContext.buffers).toHaveLength(0)
    fake.streams[0]!.audio(btoa("\x80\x00\x40"))
    expect(FakeAudioContext.buffers[0]!.rate).toBe(22050)
    expect([...FakeAudioContext.buffers[0]!.data]).toEqual([-1,0.5])
    fake.streams[0]!.event({done:true})
    expect(output.busy).toBe(true); expect(handlers.onComplete).not.toHaveBeenCalled()
    FakeAudioContext.sources[0]!.onended!()
    expect(output.busy).toBe(false); expect(handlers.onComplete).toHaveBeenCalledOnce()
  })
  test("interruption discards pending text, late audio and old completion events", async () => {
    await output.prepare(); output.begin(); output.append("old text"); await tick()
    const previous = fake.streams[0]!
    output.cancel(); output.begin(); await tick()
    previous.audio(btoa("\x00\x40")); previous.event({done:true})
    await vi.advanceTimersByTimeAsync(16)
    expect(fake.cancel).toHaveBeenCalledWith("stream-1")
    expect(fake.send).not.toHaveBeenCalled(); expect(FakeAudioContext.buffers).toHaveLength(0)
    expect(output.busy).toBe(true); expect(handlers.onComplete).not.toHaveBeenCalled()
  })
  test("a failed synthesis retains the request ID and stops its audio", async () => {
    await output.prepare(); output.begin(); await tick()
    fake.streams[0]!.event({requestId:"request-1"})
    fake.streams[0]!.audio(btoa("\x00\x40"))
    fake.streams[0]!.event({error:"permission denied",kind:"permission_denied",retryable:false,requestId:"request-1"})
    expect(handlers.onRequest).toHaveBeenCalledWith("request-1")
    expect(handlers.onError).toHaveBeenCalledWith(expect.stringContaining("request-1"))
    expect(FakeAudioContext.sources[0]!.stop).toHaveBeenCalledOnce()
    expect(output.busy).toBe(false)
  })
})

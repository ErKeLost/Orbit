import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { MicCapture, type Utterance } from "./micCapture"

const media = vi.fn<(...args: unknown[]) => Promise<MediaStream>>()
let resume: () => Promise<void>
let addModule: () => Promise<void>
class FakeContext {
  static instances: FakeContext[] = []
  state = "suspended"
  sampleRate = 48000
  destination = {}
  node = { connect:vi.fn(), disconnect:vi.fn(), onaudioprocess:null }
  audioWorklet = {addModule: () => addModule()}
  close = vi.fn(async () => {this.state="closed"})
  constructor() {FakeContext.instances.push(this)}
  resume = vi.fn(async () => { await resume(); if(this.state!=="closed")this.state="running" })
  createMediaStreamSource() {return this.node}
  createScriptProcessor() {return this.node}
  createGain() {return {...this.node,gain:{value:1}}}
}
const tick=async()=>{for(let index=0;index<15;index++)await Promise.resolve()}
function stream() {const stop=vi.fn();return {value:{getTracks:()=>[{stop}]} as unknown as MediaStream,stop}}
function capture() {return new MicCapture({onUtterance(){},onBargeIn(){},onLevel(){},onError(){}})}
beforeEach(()=>{
  vi.clearAllMocks();FakeContext.instances=[];resume=async()=>{};addModule=async()=>{throw new Error("worklet unavailable")}
  vi.stubGlobal("AudioContext",FakeContext)
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{getUserMedia:media}})
})
afterEach(()=>vi.unstubAllGlobals())

describe("microphone startup ownership",()=>{
  test("capture requests and resumes the device synchronously and deduplicates pending starts",async()=>{
    const source=stream();let grant!:(value:MediaStream)=>void
    media.mockImplementationOnce(()=>new Promise(resolve=>{grant=resolve}))
    const mic=capture(),first=mic.start(),second=mic.start()
    expect(media).toHaveBeenCalledOnce();expect(FakeContext.instances[0]!.resume).toHaveBeenCalledOnce()
    expect(first).toBe(second);grant(source.value);await first
    expect(mic.active).toBe(true);mic.stop();expect(source.stop).toHaveBeenCalledOnce()
  })
  test("a late permission grant after cancellation releases the stream even if resume never resolves",async()=>{
    resume=()=>new Promise(()=>{});let grant!:(value:MediaStream)=>void
    media.mockImplementationOnce(()=>new Promise(resolve=>{grant=resolve}))
    const mic=capture();void mic.start();mic.stop()
    const source=stream();grant(source.value);await tick()
    expect(source.stop).toHaveBeenCalledOnce();expect(mic.active).toBe(false)
    expect(FakeContext.instances[0]!.close).toHaveBeenCalledOnce()
  })
  test("cancelling a pending worklet load releases its already granted microphone",async()=>{
    let loaded!:()=>void;addModule=()=>new Promise(resolve=>{loaded=resolve})
    const source=stream();media.mockResolvedValueOnce(source.value)
    const mic=capture(),starting=mic.start();await tick()
    mic.stop();expect(source.stop).toHaveBeenCalled()
    const rejected=expect(starting).rejects.toMatchObject({name:"AbortError"})
    loaded();await rejected;expect(mic.active).toBe(false)
  })
  test("a device setup error closes its context and allows a fresh attempt",async()=>{
    media.mockRejectedValueOnce(new DOMException("denied","NotAllowedError"))
    const mic=capture();await expect(mic.start()).rejects.toMatchObject({name:"NotAllowedError"})
    expect(FakeContext.instances[0]!.close).toHaveBeenCalledOnce()
    const source=stream();media.mockResolvedValueOnce(source.value);await mic.start()
    expect(mic.active).toBe(true);expect(media).toHaveBeenCalledTimes(2);mic.stop()
  })
})

describe("microphone utterance boundaries", () => {
  async function recording() {
    const port: {onmessage: ((event: {data: Float32Array}) => void) | null} = {onmessage:null}
    vi.stubGlobal("AudioWorkletNode", class {port=port;connect(){}disconnect(){}})
    addModule=async()=>{}
    media.mockResolvedValueOnce(stream().value)
    const utterances: Utterance[]=[]
    const onSpeechStart=vi.fn(),onDiscard=vi.fn(),onBargeIn=vi.fn()
    const mic=new MicCapture({onUtterance:utterance=>utterances.push(utterance),onSpeechStart,onDiscard,onBargeIn,onLevel(){},onError(){}})
    await mic.start()
    return {mic,utterances,onSpeechStart,onDiscard,onBargeIn,feed:(value:number,frames:number)=>{for(let index=0;index<frames;index++)port.onmessage!({data:new Float32Array(320).fill(value)})}}
  }
  test("the configured silence boundary is respected and audio durations include every captured sample", async () => {
    const {mic,utterances,feed}=await recording()
    mic.setEndpointMs(1000)
    feed(0.1,20);feed(0,49)
    expect(utterances).toHaveLength(0)
    feed(0,1)
    expect(utterances).toHaveLength(1)
    expect(utterances[0]).toMatchObject({endReason:"silence",durationMs:1400})
    expect(utterances[0]!.pcm.length).toBe(70*320);mic.stop()
  })
  test("a long uninterrupted recording rolls streams without dropping or duplicating samples", async () => {
    const {mic,utterances,feed,onSpeechStart}=await recording()
    feed(0.1,1100);feed(0,23)
    expect(utterances).toHaveLength(2)
    expect(utterances.map(utterance=>utterance.endReason)).toEqual(["segment","silence"])
    expect(utterances.reduce((sum,utterance)=>sum+utterance.pcm.length,0)).toBe(1123*320)
    expect(utterances.flatMap(utterance=>[...utterance.pcm]).filter(sample=>sample!==0)).toHaveLength(1100*320)
    expect(onSpeechStart).toHaveBeenCalledTimes(2);mic.stop()
  })
  test("a delayed playback-stop callback cannot restart capture repeatedly during an interruption", async () => {
    const {mic,utterances,feed,onSpeechStart,onBargeIn}=await recording()
    mic.setAgentSpeaking(true)
    feed(0.1,20);feed(0,23)
    expect(onBargeIn).toHaveBeenCalledOnce()
    expect(onSpeechStart).toHaveBeenCalledOnce()
    expect(utterances).toHaveLength(1)
    expect(utterances[0]!.pcm.length).toBe(43*320);mic.stop()
  })
})

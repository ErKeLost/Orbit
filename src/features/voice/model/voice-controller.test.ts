import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { emptyTranscript } from "@/lib/protocol/types"
import { useWorkspace } from "@/lib/store"
const fixture = vi.hoisted(() => ({ snapshots: new Map<string, unknown>(), connections: new Map<string, { cwd: string }>(), prepareInput: vi.fn(async () => {}), prepareOutput: vi.fn(async () => {}), activate: vi.fn(), setDevice: vi.fn(async () => {}), stopInput: vi.fn(), disposeOutput: vi.fn(), config: vi.fn(), checkService: vi.fn(async () => {}), configure: vi.fn(async () => ({type:"done"})), outputHandlers: undefined as {onFirstAudio:(at:number)=>void}|undefined, create: vi.fn(), close: vi.fn(async () => {}), route: vi.fn(), execute: vi.fn(async () => {}), cancels: vi.fn(), append: vi.fn(), events: new Map<string, (event: unknown) => void>() }))
vi.mock("@/lib/rpc-core", () => ({ connections: fixture.connections, current: (id: string) => fixture.snapshots.get(id), subscribeSessionEvents: (id: string, callback: (event: unknown) => void) => { fixture.events.set(id,callback); return ()=>fixture.events.delete(id) } }))
vi.mock("@/lib/rpc-connection", () => ({ startConnection: fixture.create, closeConnection: fixture.close }))
vi.mock("@/lib/rpc-projects", () => ({ rimeConfig: fixture.config, rimeTtsPrepare: async () => {}, saveRimeConfig: async (config: unknown) => config }))
vi.mock("./voice-service", () => ({ checkVoiceService: fixture.checkService, voiceService: (target: string, input: {action:string}, ...args: unknown[]) => input.action === "configure_session" ? fixture.configure(target,input,...args) : fixture.route(target,input,...args) }))
vi.mock("./command-gateway", () => ({ boundSnapshot: (binding: {connectionId:string;sessionFile:string}) => { const snapshot=fixture.snapshots.get(binding.connectionId) as {state:{sessionFile:string}};if(snapshot?.state.sessionFile!==binding.sessionFile)throw new Error("binding changed");return snapshot }, CommandGateway: class { execute = fixture.execute } }))
vi.mock("./speech-input", () => ({ SpeechInput: class { prepareDevice=fixture.prepareInput; activate=fixture.activate; setEndpointMs() {} stop=fixture.stopInput; setSpeaking() {} setDevice=fixture.setDevice } }))
vi.mock("./speech-output", () => ({ SpeechOutput: class { constructor(handlers: {onFirstAudio:(at:number)=>void}) {fixture.outputHandlers=handlers} busy=false; prepare=fixture.prepareOutput; begin() {} append=fixture.append; finish() {} cancel=fixture.cancels; dispose=fixture.disposeOutput } }))
const { VoiceController } = await import("./voice-controller")
function snapshot(file: string, running=false) { return { connection:"online",state:{sessionFile:file,sessionName:file},transcript:{...emptyTranscript(),running},dialogs:[],statuses:{} } }
const decision = (intent: string, target: string) => ({type:"decision",decision:{intent,target,confidence:0.99,targetConfidence:0.99,mutation:0.99,actionability:0.99,compound:0,model:"fixture",latencyMs:1}})
const settle = async () => { for (let index=0; index<20; index++) await Promise.resolve() }
describe("voice call and session isolation", () => {
  afterEach(() => vi.useRealTimers())
  beforeEach(() => {
    vi.clearAllMocks(); fixture.config.mockResolvedValue({ hasCredential: true, configured: true, lang: "en", sttLang: "en" }); fixture.snapshots.clear(); fixture.connections.clear(); fixture.events.clear()
    fixture.snapshots.set("original",snapshot("/original",true));fixture.connections.set("original",{cwd:"/project"})
    useWorkspace.getState().set({connection:"online",connectionId:"original",cwd:"/project",panel:"voice",state:{sessionFile:"/original"} as never,transcript:{...emptyTranscript(),running:true}})
    fixture.create.mockImplementation(async (_cwd: string,id: string) => { fixture.snapshots.set(id,snapshot("/new-voice",true));fixture.connections.set(id,{cwd:"/project"}) })
    fixture.route.mockImplementation(async (target: string,input: {action:string;context?:{latestReply?:string;state?:string;task?:{latestReply?:string}};input?:{text:string;focused:string}}, _signal: AbortSignal, onEvent?: (value: unknown)=>void) => {
      if (input.action === "configure_session") return {type:"done"}
      if (input.action === "answer") { onEvent?.({type:"delta",text:input.context?.task?.latestReply || "It is still running."}); return {type:"done"} }
      return decision(input.input?.text.includes("progress")?"query_progress":"dispatch_task",input.input?.focused??target)
    })
  })
  test("starting binds a fresh background session while preserving the current page and loading state", async () => {
    const voice=new VoiceController();await voice.start()
    expect(fixture.create).toHaveBeenCalledWith("/project",expect.stringMatching(/^voice-/),expect.objectContaining({background:true,restoreLast:false,keepTranscript:true}))
    expect(voice.getSnapshot().focusId).not.toBe("original")
    expect(fixture.configure).toHaveBeenCalledWith(voice.getSnapshot().focusId,{action:"configure_session",language:"en"},expect.any(AbortSignal))
    expect(fixture.configure).not.toHaveBeenCalledWith("original",expect.anything(),expect.anything())
    expect(useWorkspace.getState()).toMatchObject({connectionId:"original",panel:"voice",transcript:{loading:false,running:true}})
    voice.stop()
  })
  test("first click starts both audio devices before waiting for configuration or Pi", async () => {
    let finishConfig!: (value: unknown) => void
    fixture.config.mockImplementationOnce(() => new Promise(resolve => {finishConfig=resolve}))
    const voice = new VoiceController(), starting=voice.start()
    expect(fixture.prepareInput).toHaveBeenCalledOnce(); expect(fixture.prepareOutput).toHaveBeenCalledOnce()
    expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.activate).not.toHaveBeenCalled()
    expect(voice.getSnapshot()).toMatchObject({starting:true,startupStage:"config",state:"off"})
    finishConfig({hasCredential:true,configured:true,lang:"en",sttLang:"en"})
    await starting
    expect(voice.getSnapshot()).toMatchObject({starting:false,startupStage:null,state:"ready",error:null})
    expect(fixture.activate).toHaveBeenCalledOnce(); voice.stop()
  })
  test("session readiness cannot activate capture until the pending device is ready", async () => {
    let ready!: () => void
    fixture.prepareInput.mockImplementationOnce(() => new Promise(resolve=>{ready=resolve}))
    const voice=new VoiceController(),starting=voice.start();await settle()
    expect(voice.getSnapshot()).toMatchObject({starting:true,startupStage:"devices",state:"off"})
    await voice.submitText("fix login");expect(fixture.execute).not.toHaveBeenCalled()
    expect(fixture.activate).not.toHaveBeenCalled()
    ready();await starting
    expect(voice.getSnapshot().state).toBe("ready");expect(fixture.create).toHaveBeenCalledOnce();voice.stop()
  })
  test("repeated clicks and the same microphone selection do not restart startup or capture", async () => {
    let ready!: () => void
    fixture.prepareInput.mockImplementationOnce(()=>new Promise(resolve=>{ready=resolve}))
    const voice=new VoiceController();voice.setDeviceId("builtin")
    const starting=voice.start();await settle();await voice.start()
    voice.setDeviceId("builtin");voice.setDeviceId("another")
    expect(voice.getSnapshot().deviceId).toBe("builtin")
    ready();await starting;voice.setDeviceId("builtin")
    expect(fixture.create).toHaveBeenCalledOnce();expect(fixture.setDevice).not.toHaveBeenCalled()
    expect(fixture.prepareInput).toHaveBeenCalledExactlyOnceWith("builtin");voice.stop()
  })
  test("a device AbortError is visible and the next attempt succeeds without a stale state", async () => {
    fixture.prepareInput.mockRejectedValueOnce(new DOMException("capture interrupted","AbortError"))
    const voice=new VoiceController();await voice.start();await settle()
    expect(voice.getSnapshot()).toMatchObject({starting:false,state:"off",error:expect.stringContaining("麦克风初始化被中断")})
    expect(fixture.stopInput).toHaveBeenCalled();expect(fixture.disposeOutput).toHaveBeenCalled()
    await voice.start()
    expect(voice.getSnapshot()).toMatchObject({starting:false,state:"ready",error:null});voice.stop()
  })
  test("a cancelled startup settles before the device grants permission", async () => {
    let ready!: () => void
    fixture.prepareInput.mockImplementationOnce(()=>new Promise(resolve=>{ready=resolve}))
    const voice=new VoiceController(),starting=voice.start();await settle()
    voice.stop();await starting
    expect(voice.getSnapshot()).toMatchObject({starting:false,state:"off",error:null})
    await voice.start();const active=voice.getSnapshot().focusId
    ready();await settle()
    expect(voice.getSnapshot()).toMatchObject({state:"ready",focusId:active,error:null})
    expect(fixture.activate).toHaveBeenCalledOnce();voice.stop()
  })
  test("a suspended audio device times out explicitly instead of leaving the first click pending", async () => {
    vi.useFakeTimers()
    fixture.prepareOutput.mockImplementationOnce(()=>new Promise(()=>{}))
    const voice=new VoiceController(),starting=voice.start();await settle()
    await vi.advanceTimersByTimeAsync(30000);await starting
    expect(voice.getSnapshot()).toMatchObject({state:"off",starting:false,error:expect.stringContaining("音频设备准备超时")})
    expect(fixture.activate).not.toHaveBeenCalled();expect(fixture.disposeOutput).toHaveBeenCalled()
    expect(fixture.close).toHaveBeenCalled();voice.stop()
  })
  test("cancelled session startup cannot attach or stop the following successful call", async () => {
    let ready!: () => void
    fixture.create.mockImplementationOnce(()=>new Promise(resolve=>{ready=resolve}))
    const voice=new VoiceController(),first=voice.start();await settle()
    const cancelled=fixture.create.mock.calls[0]![1]
    voice.stop();await first;await voice.start();const active=voice.getSnapshot().focusId
    ready();await settle()
    expect(fixture.close.mock.calls.every(call=>call[0]===cancelled)).toBe(true)
    expect(voice.getSnapshot()).toMatchObject({state:"ready",starting:false,focusId:active});voice.stop()
  })
  test("every new call creates a different session and clears previous conversation context", async () => {
    fixture.create.mockImplementation(async (_cwd: string, id: string) => {
      fixture.snapshots.set(id, snapshot(`/sessions/${id}.jsonl`, true)); fixture.connections.set(id, {cwd:"/project"})
    })
    const voice = new VoiceController(); await voice.start(); const first = voice.getSnapshot().focusId
    await voice.submitText("fix login"); voice.stop(); await voice.start(); const second = voice.getSnapshot().focusId
    expect(second).not.toBe(first)
    expect(fixture.snapshots.get(second)).not.toEqual(fixture.snapshots.get(first))
    expect(voice.getSnapshot().log).toEqual([])
    await voice.submitText("progress?")
    expect(fixture.route.mock.calls.filter(call=>call[1].action === "route").at(-1)![1].input).toMatchObject({focused:second,history:[]})
    expect(useWorkspace.getState()).toMatchObject({connectionId:"original",panel:"voice",transcript:{loading:false}})
    expect(fixture.close).not.toHaveBeenCalled(); voice.stop()
  })
  test("a fresh-information question dispatches to Pi rather than the tool-less answer model", async () => {
    fixture.route.mockImplementationOnce(async (target: string) => ({...decision("lookup",target),decision:{...decision("lookup",target).decision,mutation:0.1}}))
    const voice = new VoiceController(); await voice.start(); const target = voice.getSnapshot().focusId
    await voice.submitText("北京现在天气怎么样？")
    expect(fixture.execute).toHaveBeenCalledWith(expect.any(String),{connectionId:target,sessionFile:"/new-voice"},expect.objectContaining({intent:"lookup"}),expect.stringContaining("北京现在天气怎么样？"),undefined,expect.any(AbortSignal))
    expect(fixture.route.mock.calls.filter(call => call[1].action === "route")).toHaveLength(1)
    expect(voice.getSnapshot().log.at(-1)?.text).toBe("I'll look that up."); voice.stop()
  })
  test("redirected retrieval preserves both delivery and information-only instructions", async () => {
    fixture.route.mockImplementationOnce(async (target: string) => {
      const value = decision("steer_task", target)
      return { ...value, decision: { ...value.decision, workKind: "lookup", deliveryConfidence: 0.99 } }
    })
    const voice = new VoiceController(); await voice.start()
    await voice.submitText("别做这个了，改查上海天气")
    expect(fixture.execute.mock.calls[0]![2]).toMatchObject({ intent: "steer_task", workKind: "lookup" })
    expect(fixture.execute.mock.calls[0]![3]).toContain("Read-only information request")
    expect(fixture.execute.mock.calls[0]![3]).toContain("改查上海天气")
    voice.stop()
  })
  test("clarification asks about the missing detail and carries it into the next execution", async () => {
    fixture.route.mockImplementationOnce(async (target: string) => ({...decision("clarify",target),decision:{...decision("clarify",target).decision,clarificationReason:"incomplete_request"}}))
    fixture.route.mockImplementationOnce(async (_target: string, input: {context:unknown}, _signal: AbortSignal, onEvent: (event:unknown)=>void) => {
      expect(input.context).toMatchObject({kind:"clarification",reason:"incomplete_request",request:"start a task"})
      onEvent({type:"delta",text:"What would you like me to do?"}); return {type:"done"}
    })
    const voice = new VoiceController(); await voice.start(); const target = voice.getSnapshot().focusId
    await voice.submitText("start a task")
    expect(fixture.execute).not.toHaveBeenCalled()
    expect(voice.getSnapshot().log.at(-1)?.text).toBe("What would you like me to do?")
    fixture.route.mockImplementationOnce(async (_target: string, input: {input:{pendingRequest:unknown}}) => {
      expect(input.input.pendingRequest).toMatchObject({text:"start a task",question:"What would you like me to do?",attempts:1})
      const result = decision("dispatch_task",target); return {...result,decision:{...result.decision,continuesRequest:true}}
    })
    await voice.submitText("打开百度")
    expect(fixture.execute.mock.calls[0]![3]).toContain('"currentRequest":"打开百度"'); voice.stop()
  })
  test("Pi completion speaks the actual result and unrelated sessions stay quiet", async () => {
    const voice = new VoiceController(); await voice.start(); const target = voice.getSnapshot().focusId
    const completed = snapshot("/new-voice")
    completed.transcript.messages = [{id:"reply",message:{role:"assistant",content:[{type:"text",text:"Beijing: clear skies, 18°C. Source: current weather report."}]}}] as never
    fixture.snapshots.set(target,completed)
    fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:10,observedAt:100,event:{type:"agent_settled"}})
    await settle()
    expect(voice.getSnapshot().log.at(-1)?.text).toContain("18°C")
    const count = voice.getSnapshot().log.length
    fixture.events.get("original")!({connectionId:"original",sessionFile:"/original",sequence:11,observedAt:100,event:{type:"agent_settled"}})
    await settle()
    expect(voice.getSnapshot().log).toHaveLength(count); voice.stop()
  })
  test("asking progress leaves the running agent alone", async () => {
    const voice=new VoiceController();await voice.start();await voice.submitText("progress?")
    expect(fixture.execute).not.toHaveBeenCalled();expect(voice.getSnapshot().log.at(-1)?.text).toContain("running");voice.stop()
  })
  test("routing receives bounded task evidence for replies to Pi's own questions", async () => {
    const voice = new VoiceController(); await voice.start(); const target = voice.getSnapshot().focusId
    const waiting = snapshot("/new-voice")
    waiting.transcript.messages = [
      { id: "request", message: { role: "user", content: "查天气预报" } },
      { id: "reply", message: { role: "assistant", content: "你想查询哪个城市？" } },
    ] as never
    fixture.snapshots.set(target, waiting)
    fixture.route.mockImplementationOnce(async (_target: string, request: { input: unknown }) => {
      expect(request.input).toMatchObject({ focused: target, text: "北京", focusedTask: { sessionFile: "/new-voice", goal: "查天气预报", latestReply: "你想查询哪个城市？" } })
      return decision("lookup", target)
    })
    await voice.submitText("北京")
    expect(fixture.execute).toHaveBeenCalledWith(expect.any(String), { connectionId: target, sessionFile: "/new-voice" }, expect.objectContaining({ intent: "lookup" }), expect.stringContaining("北京"), undefined, expect.any(AbortSignal))
    voice.stop()
  })
  test("task dispatch keeps its bound target when the user switches workspace; hangup never cancels the task", async () => {
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    useWorkspace.getState().set({connectionId:"somewhere-else",panel:"chat"})
    await voice.submitText("fix login")
    expect(fixture.execute).toHaveBeenCalledWith(expect.any(String),{connectionId:target,sessionFile:"/new-voice"},expect.objectContaining({intent:"dispatch_task"}),expect.stringContaining("fix login"),undefined,expect.any(AbortSignal))
    voice.stop();expect(fixture.close).not.toHaveBeenCalled()
  })
  test("a delayed route result after hangup cannot dispatch a task", async () => {
    let release!: (value: unknown)=>void
    fixture.route.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    const accepted=voice.submitText("fix login");voice.stop();release(decision("dispatch_task",target));await accepted
    expect(fixture.execute).not.toHaveBeenCalled()
  })
  test("watching an older session keeps all internal service commands on the new voice connection", async () => {
    const voice=new VoiceController();await voice.start();const service=voice.getSnapshot().focusId
    voice.setFocus("original");await voice.submitText("progress?")
    expect(fixture.route.mock.calls.find(call=>call[1].action === "route")![0]).toBe(service)
    expect(fixture.route.mock.calls.find(call=>call[1].action === "route")![1].input.focused).toBe("original")
    expect(fixture.execute).not.toHaveBeenCalled();voice.stop()
  })
  test("a session replacement during routing cannot retarget the task", async () => {
    let release!: (value: unknown)=>void
    fixture.route.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve}))
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    const accepted=voice.submitText("fix login")
    fixture.snapshots.set(target,snapshot("/replacement"))
    release(decision("dispatch_task",target));await accepted
    expect(fixture.execute).not.toHaveBeenCalled();voice.stop()
  })
  test("closing during session startup cleans up only the new connection", async () => {
    let release!: ()=>void
    fixture.create.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve}))
    const voice=new VoiceController();const starting=voice.start();await settle()
    voice.stop();release();await starting
    expect(fixture.close).toHaveBeenCalledWith(expect.stringMatching(/^voice-/))
    expect(useWorkspace.getState().connectionId).toBe("original")
  })
  test("watching and dispatching to an ordinary Pi session does not add the voice profile or brevity instruction", async () => {
    const voice=new VoiceController(); await voice.start()
    voice.setFocus("original"); await voice.submitText("fix login")
    expect(fixture.configure).toHaveBeenCalledOnce()
    expect(fixture.configure.mock.calls[0]![0]).not.toBe("original")
    expect(fixture.execute).toHaveBeenCalledWith(expect.any(String),{connectionId:"original",sessionFile:"/original"},expect.objectContaining({intent:"dispatch_task"}),"fix login",undefined,expect.any(AbortSignal))
    voice.stop()
  })
  test("Chinese Pi results are rendered into a short English announcement before log or Rime output", async () => {
    const voice=new VoiceController(); await voice.start(); const target=voice.getSnapshot().focusId
    const completed=snapshot("/new-voice")
    completed.transcript.messages=[{id:"a",message:{role:"assistant",content:"已经打开百度。"}}] as never
    fixture.snapshots.set(target,completed)
    fixture.route.mockImplementationOnce(async (_target: string,input: {context:unknown;language:string}, _signal: AbortSignal,onEvent:(event:unknown)=>void) => {
      expect(input).toMatchObject({language:"en",context:{kind:"task_event",task:{latestReply:"已经打开百度。"}}})
      onEvent({type:"delta",text:"Baidu is open."});return {type:"done"}
    })
    fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:10,observedAt:100,event:{type:"agent_settled"}})
    await settle()
    expect(voice.getSnapshot().log.at(-1)?.text).toBe("Baidu is open.")
    expect(fixture.append).toHaveBeenCalledExactlyOnceWith("Baidu is open.")
    voice.stop()
  })
  test("a language violation never falls back to reading the original task result", async () => {
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    const completed=snapshot("/new-voice")
    completed.transcript.messages=[{id:"a",message:{role:"assistant",content:"完成，所有步骤如下。"}}] as never
    fixture.snapshots.set(target,completed)
    fixture.route.mockImplementationOnce(async (_target: string,_input:unknown,_signal:AbortSignal,onEvent:(event:unknown)=>void)=>{onEvent({type:"delta",text:"完成。"});return {type:"done"}})
    fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:11,observedAt:100,event:{type:"agent_settled"}})
    await settle()
    expect(fixture.append).toHaveBeenCalledExactlyOnceWith("There is a new reply in the task session. Please review it there.")
    expect(voice.getSnapshot().log.every(item=>!/[完成]/u.test(item.text))).toBe(true)
    voice.stop()
  })
  test("Spanish uses Spanish acknowledgments", async () => {
    fixture.config.mockResolvedValueOnce({hasCredential:true,configured:true,lang:"es",sttLang:"es"})
    const voice=new VoiceController();await voice.start();await voice.submitText("abre Baidu")
    expect(voice.getSnapshot().log.at(-1)?.text).toBe("He enviado la tarea.");voice.stop()
  })
  test("hangup or focus change during announcement rendering cannot play a late result", async () => {
    for (const end of [false,true]) {
      const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
      let finish!:()=>void
      fixture.route.mockImplementationOnce(async (_target:string,_input:unknown,_signal:AbortSignal,onEvent:(event:unknown)=>void)=>{await new Promise<void>(resolve=>{finish=resolve});onEvent({type:"delta",text:"Late result."});return {type:"done"}})
      fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:20,observedAt:100,event:{type:"agent_settled"}})
      await settle(); if(end) voice.stop(); else voice.setFocus("original")
      fixture.append.mockClear();finish();await settle()
      expect(fixture.append).not.toHaveBeenCalled();voice.stop()
    }
  })
  test("a confirmation that disappeared while being rendered never becomes announced", async () => {
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    const waiting={...snapshot("/new-voice"),dialogs:[{id:"dialog",method:"confirm",message:"要删除文件吗？"}]}
    fixture.snapshots.set(target,waiting)
    let finish!:()=>void
    fixture.route.mockImplementationOnce(async (_target:string,_input:unknown,_signal:AbortSignal,onEvent:(event:unknown)=>void)=>{await new Promise<void>(resolve=>{finish=resolve});onEvent({type:"delta",text:"Delete the file?"});return {type:"done"}})
    fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:21,observedAt:100,event:{type:"extension_ui_request",method:"confirm"}})
    await settle();fixture.snapshots.set(target,snapshot("/new-voice"));finish();await settle()
    expect(fixture.append).not.toHaveBeenCalled();voice.stop()
  })

  test("the original location reaches Pi even if Jev does not mark the clarification as a continuation", async () => {
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    fixture.route.mockImplementationOnce(async()=>({...decision("clarify",target),decision:{...decision("clarify",target).decision,clarificationReason:"unclear_request"}}))
    fixture.route.mockImplementationOnce(async(_target:string,_input:unknown,_signal:AbortSignal,onEvent:(value:unknown)=>void)=>{onEvent({type:"delta",text:"Do you mean the weather?"});return {type:"done"}})
    await voice.submitText("Help me check beijing Wiser")
    fixture.route.mockImplementationOnce(async()=>({...decision("lookup",target),decision:{...decision("lookup",target).decision,continuesRequest:false}}))
    await voice.submitText("Weather.")
    const sent=fixture.execute.mock.calls[0]![3]
    expect(sent).toContain('"currentRequest":"Weather."')
    expect(sent).toContain("Help me check beijing Wiser")
    expect(sent).toContain("Do you mean the weather?")
    voice.stop()
  })
  test("a brief clarification from the voice executor is relayed directly without a completion paraphrase", async () => {
    const voice=new VoiceController();await voice.start();const target=voice.getSnapshot().focusId
    const waiting=snapshot("/new-voice")
    waiting.transcript.messages=[{id:"u",message:{role:"user",content:"Weather."}},{id:"a",message:{role:"assistant",content:"Which city should I check the weather for?"}}] as never
    fixture.snapshots.set(target,waiting)
    fixture.events.get(target)!({connectionId:target,sessionFile:"/new-voice",sequence:30,observedAt:100,event:{type:"agent_settled"}})
    await settle()
    expect(voice.getSnapshot().log.at(-1)?.text).toBe("Which city should I check the weather for?")
    expect(fixture.route).not.toHaveBeenCalled()
    expect(fixture.append).toHaveBeenCalledExactlyOnceWith("Which city should I check the weather for?")
    voice.stop()
  })

})

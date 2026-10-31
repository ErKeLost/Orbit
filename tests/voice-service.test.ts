import { describe, expect, test } from "bun:test"
import { registerVoiceService } from "../src-tauri/resources/voice/service"
import { SESSION_PROFILE_ENTRY } from "../src-tauri/resources/voice/session-profile"

async function call(action: string, text: string[], extra: Record<string,unknown> = {}) {
  const commands = new Map<string, (args:string,ctx:unknown)=>Promise<void>>()
  const events: {type:string;text?:string}[] = []
  const entries: {customType:string;data:unknown}[] = []
  let options: {signal:AbortSignal;maxTokens:number}|undefined
  let complete!:()=>void
  const completed=new Promise<void>(resolve=>{complete=resolve})
  const pi = {
    on() {}, registerCommand(name:string,value:{handler:(args:string,ctx:unknown)=>Promise<void>}) {commands.set(name,value.handler)},
    appendEntry(customType:string,data:unknown) {entries.push({customType,data})},
  }
  const ctx = {
    sessionManager:{getEntries:()=>entries.map(e=>({type:"custom",...e}))},
    ui:{setStatus(_key:string,value:string) {const event=JSON.parse(value);events.push(event);if(event.type!=="delta")complete()}},
    model:{id:"fixture"}, modelRegistry:{streamSimple(_model:unknown,_context:unknown,value:typeof options) {
      options=value
      return (async function* () {for(const delta of text)yield {type:"text_delta",delta}})()
    }},
  }
  registerVoiceService(pi as never)
  await commands.get("gui-voice")!(JSON.stringify({id:"request",action,text:"What happened?",language:"en",...extra}),ctx)
  await completed; await Promise.resolve()
  return {events,entries,options,spoken:events.filter(e=>e.type==="delta").map(e=>e.text).join("")}
}
describe("voice service output boundary", () => {
  test("the configure command marks only its own session and never invokes generation", async () => {
    const result=await call("configure_session",[])
    expect(result.entries).toEqual([{customType:SESSION_PROFILE_ENTRY,data:{version:1,type:"voice",language:"en"}}])
    expect(result.options).toBeUndefined()
    expect(result.events.at(-1)?.type).toBe("done")
  })
  test("a model cannot stream Chinese evidence to Rime", async () => {
    const result=await call("answer",["The task ","完成了。"])
    expect(result.spoken).not.toMatch(/完成/u)
    expect(result.events.at(-1)?.type).toBe("error")
    expect(result.options?.signal.aborted).toBe(true)
  })
  test("generation is bounded, stops its provider stream, and keeps word boundaries", async () => {
    const result=await call("answer",Array.from({length:100},()=>"word "))
    expect(result.spoken.split(/\s+/u).length).toBeLessThanOrEqual(60)
    expect(result.spoken.length).toBeLessThanOrEqual(480)
    expect(result.events.at(-1)?.type).toBe("done")
    expect(result.options?.maxTokens).toBe(180)
    expect(result.options?.signal.aborted).toBe(true)
  })
  test("an oversized confirmation is never emitted as a truncated explanation", async () => {
    const result=await call("answer",["word ".repeat(100)],{context:{kind:"task_event",event:"confirmation"}})
    expect(result.spoken).toBe("")
    expect(result.events.at(-1)?.type).toBe("error")
  })
})

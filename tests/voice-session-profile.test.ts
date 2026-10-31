import { describe, expect, test } from "bun:test"
import { registerSessionProfile, configureVoiceSession, SESSION_PROFILE_ENTRY } from "../src-tauri/resources/voice/session-profile"
import { assertSpokenScript, conciseReply, spokenReplyPrefix, voiceLanguage, voiceTaskInstructions } from "../src-tauri/resources/voice/policy"

function fixture() {
  let entries: unknown[] = []
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
  const pi = {
    appendEntry(customType: string, data: unknown) { entries.push({type:"custom",customType,data}) },
    on(name: string, handler: (event: unknown, ctx: unknown) => unknown) { handlers.set(name,handler) },
  }
  const ctx = {sessionManager:{getEntries:()=>entries}}
  return {pi,ctx,handlers,replace:(value:unknown[])=>{entries=value},entries:()=>entries}
}
describe("durable voice session policy", () => {
  test("the origin is persisted and restored on every turn without affecting ordinary sessions", () => {
    const f = fixture(); registerSessionProfile(f.pi as never)
    const before = () => f.handlers.get("before_agent_start")!({systemPrompt:"base"},f.ctx) as {systemPrompt:string}|undefined
    expect(before()).toBeUndefined()
    configureVoiceSession(f.pi as never,f.ctx as never,"en")
    const saved = [...f.entries()]
    expect(saved).toEqual([{type:"custom",customType:SESSION_PROFILE_ENTRY,data:{version:1,type:"voice",language:"en"}}])
    expect(before()?.systemPrompt).toContain("base")
    expect(before()?.systemPrompt).toContain("at most 60 words")
    expect(before()?.systemPrompt).toContain("English")
    f.replace([]); expect(before()).toBeUndefined()
    f.replace(saved); expect(before()?.systemPrompt).toContain("<voice_session>")
    configureVoiceSession(f.pi as never,f.ctx as never,"en"); expect(f.entries()).toHaveLength(1)
    configureVoiceSession(f.pi as never,f.ctx as never,"es"); expect(before()?.systemPrompt).toContain("Spanish")
  })
  test("invalid languages cannot create a profile", () => {
    const f = fixture()
    expect(()=>configureVoiceSession(f.pi as never,f.ctx as never,"zh")).toThrow("Rime")
    expect(f.entries()).toEqual([])
  })
  test("short replies preserve the full work requirement", () => {
    expect(voiceTaskInstructions("en")).toContain("does not reduce the work or verification required")
  })
})
describe("Rime spoken text policy", () => {
  test("allows Spanish and English punctuation, names and values while rejecting unsupported scripts", () => {
    expect(voiceLanguage("es")).toBe("es")
    expect(()=>voiceLanguage("zh")).toThrow("Rime")
    expect(()=>assertSpokenScript("Está listo. Beijing: 18°C, €25. ¿Continuamos?")).not.toThrow()
    expect(()=>assertSpokenScript("The result: 北京 18°C")).toThrow("Rime")
    expect(()=>assertSpokenScript("東京")).toThrow()
  })
  test("streaming word prefixes remain monotonic and within the spoken budget", () => {
    for (const input of ["word ".repeat(100), "a".repeat(400)+" "+"long ".repeat(100), "long".repeat(200)]) {
      let received="", sent=""
      for (const char of input) {
        received+=char
        const next=spokenReplyPrefix(received)
        expect(next.startsWith(sent)).toBe(true)
        sent=next
      }
      const final=spokenReplyPrefix(received,true)
      expect(final.startsWith(sent)).toBe(true)
      expect(final.length).toBeLessThanOrEqual(480)
      expect(final.split(/\s+/).length).toBeLessThanOrEqual(60)
    }
    expect(conciseReply("A useful short answer.")).toBe("A useful short answer.")
  })
})

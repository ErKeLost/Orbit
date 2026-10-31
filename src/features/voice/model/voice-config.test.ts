import { describe, expect, test } from "vitest"
import type { RimeConfig } from "@/lib/rpc-projects"
import { resolveVoiceConfig } from "./voice-config"
const defaults: RimeConfig = {model:"coda",speaker:"astra",lang:"en",sttLang:"en",configured:false,hasCredential:false}
describe("explicit Rime conversation language", () => {
  test("uses the saved language without OS locale inference", () => {
    expect(resolveVoiceConfig(defaults)).toMatchObject({lang:"en",sttLang:"en"})
    expect(resolveVoiceConfig({...defaults,lang:"es",sttLang:"es"})).toMatchObject({lang:"es",sttLang:"es"})
  })
  test("rejects unsupported or mismatched conversation languages", () => {
    expect(()=>resolveVoiceConfig({...defaults,lang:"zh"})).toThrow("Rime")
    expect(()=>resolveVoiceConfig({...defaults,sttLang:"es"})).toThrow("must match")
  })
})

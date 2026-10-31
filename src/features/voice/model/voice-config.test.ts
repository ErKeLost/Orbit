import { describe, expect, test } from "vitest"
import type { RimeConfig } from "@/lib/rpc-projects"
import { resolveVoiceConfig } from "./voice-config"

const defaults: RimeConfig = {model:"coda",speaker:"astra",lang:"en",sttLang:"en",sttBackend:"rime",ttsBackend:"rime",spokenLang:"en",configured:false,hasCredential:false}
describe("voice language capabilities", () => {
  test("an unsupported system locale keeps the Rime recognition language", () => {
    expect(resolveVoiceConfig(defaults,"zh-Hans-CN")).toMatchObject({spokenLang:"en",sttBackend:"rime",ttsBackend:"rime"})
  })
  test("Rime streaming remains available in its supported languages", () => {
    expect(resolveVoiceConfig(defaults,"es-MX")).toMatchObject({spokenLang:"es",sttBackend:"rime",ttsBackend:"rime",sttLang:"es",lang:"es"})
  })
  test("an explicit language choice is preserved regardless of system language", () => {
    expect(resolveVoiceConfig({...defaults,configured:true,spokenLang:"en"},"zh-CN")).toMatchObject({spokenLang:"en",sttBackend:"rime",ttsBackend:"rime"})
  })
  test("a legacy configuration cannot reactivate external recognition or system speech", () => {
    const legacy = {...defaults,configured:true,spokenLang:"zh",sttBackend:"speech",ttsBackend:"system"} as unknown as RimeConfig
    expect(resolveVoiceConfig(legacy,"zh-CN")).toMatchObject({spokenLang:"en",sttLang:"en",lang:"en",sttBackend:"rime",ttsBackend:"rime"})
  })
})

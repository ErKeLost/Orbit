import type { RimeConfig } from "@/lib/rpc-projects"
import { voiceLanguage } from "../../../../src-tauri/resources/voice/policy"

/** Explicit Rime configuration only; no locale inference or provider migration. */
export function resolveVoiceConfig(config: RimeConfig): RimeConfig {
  voiceLanguage(config.lang)
  if (config.sttLang !== config.lang) throw new Error("Rime recognition and playback languages must match. Save the conversation language in voice settings.")
  return config
}

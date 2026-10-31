import type { RimeConfig } from "@/lib/rpc-projects"

/** The voice call uses Rime exclusively, including when loading legacy configs. */
export function resolveVoiceConfig(config: RimeConfig, locale = navigator.language): RimeConfig {
  const requested = config.configured === false ? locale : config.spokenLang ?? config.lang
  const requestedLanguage = requested.toLowerCase().split(/[-_]/u)[0] || "en"
  const sttLanguages = config.sttLangs ?? ["en", "es"]
  const language = sttLanguages.includes(requestedLanguage) ? requestedLanguage : sttLanguages.includes(config.sttLang) ? config.sttLang : "en"
  return {
    ...config, spokenLang: language, sttBackend: "rime", ttsBackend: "rime", sttLang: language, lang: language,
  }
}

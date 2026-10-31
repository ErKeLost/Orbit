/** The real-time Rime call supports exactly these recognition/output languages. */
export type VoiceLanguage = "en" | "es"
export function voiceLanguage(value: unknown): VoiceLanguage {
  if (value !== "en" && value !== "es") throw new Error("Rime voice calls support English (en) and Spanish (es). Choose a supported language in voice settings.")
  return value
}
export const MAX_SPOKEN_WORDS = 60
export const MAX_SPOKEN_CHARS = 480
/** A script guard, not a language detector: never send unsupported scripts to en/es TTS. */
export function assertSpokenScript(text: string) {
  for (const letter of text.match(/\p{L}/gu) ?? []) {
    if (!/\p{Script_Extensions=Latin}/u.test(letter)) throw new Error("The voice reply contains text outside the selected Rime language.")
  }
}
export function conciseReply(text: string): string {
  const words = text.trim().split(/\s+/u).slice(0, MAX_SPOKEN_WORDS)
  while (words.join(" ").length > MAX_SPOKEN_CHARS - 1) words.pop()
  const result = words.join(" ")
  return result && result.length < text.trim().length ? `${result.replace(/[,;:]$/u, "")}.` : result
}
export function voiceTaskInstructions(language: VoiceLanguage): string {
  return `<voice_session>\nThis request is delivered through a Rime voice call. Reply only in ${language === "es" ? "Spanish" : "English"}, including when the request, tools or workspace instructions use another language. Translate names into a pronounceable form if needed; never copy unsupported scripts into your reply. Complete the work using the available tools. Keep spoken-facing commentary and the final answer concise: one to three short sentences, at most 60 words. Lead with the result, blocker or one essential question. Do not read code, logs, lists or implementation details aloud. Put extensive details in files when needed and briefly identify the result. Concise communication does not reduce the work or verification required.\n</voice_session>`
}

export function spokenBudgetExceeded(text: string) {
  return text.trim().length >= MAX_SPOKEN_CHARS || text.trim().split(/\s+/u).length > MAX_SPOKEN_WORDS
}
export function spokenReplyPrefix(text: string, final = false) {
  if (final || spokenBudgetExceeded(text)) return conciseReply(text)
  const boundary = text.search(/\s+\S*$/u)
  return boundary >= 0 ? text.slice(0, boundary).trimStart() : ""
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { voiceLanguage, voiceTaskInstructions, type VoiceLanguage } from "./policy.ts"

export const SESSION_PROFILE_ENTRY = "gui-session-profile"
export type VoiceSessionProfile = { version: 1; type: "voice"; language: VoiceLanguage }
export function sessionProfile(ctx: Pick<ExtensionContext, "sessionManager">): VoiceSessionProfile | undefined {
  const entry = ctx.sessionManager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === SESSION_PROFILE_ENTRY)
  if (entry?.type !== "custom") return
  const data = entry.data as Partial<VoiceSessionProfile> | undefined
  if (data?.version !== 1 || data.type !== "voice") return
  return { version: 1, type: "voice", language: voiceLanguage(data.language) }
}
export function configureVoiceSession(pi: ExtensionAPI, ctx: ExtensionContext, language: unknown) {
  const profile: VoiceSessionProfile = { version: 1, type: "voice", language: voiceLanguage(language) }
  const previous = sessionProfile(ctx)
  if (previous?.language !== profile.language) pi.appendEntry(SESSION_PROFILE_ENTRY, profile)
}
export function registerSessionProfile(pi: ExtensionAPI) {
  // Read the current session every turn: reconnects, forks and session switches
  // must not inherit another session's in-memory conversation settings.
  pi.on("before_agent_start", (event, ctx) => {
    const profile = sessionProfile(ctx)
    if (profile) return { systemPrompt: `${event.systemPrompt}\n\n${voiceTaskInstructions(profile.language)}` }
  })
}

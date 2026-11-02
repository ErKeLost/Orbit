import type { VoiceRouteInput } from "./contract.ts"

/**
 * Build the smallest useful user message for Pi.
 *
 * Pi already owns the target session transcript. Re-sending the voice history
 * as JSON made the model treat old assistant replies and policy text as fresh
 * instructions. Only a clarification that happened outside the target session
 * needs a short bridge; ordinary voice requests remain ordinary user text.
 *
 * There is deliberately no instruction wrapper. Prepending something like
 * "Answer the user's informational request as Pi, using the current
 * conversation" did three harmful things: it appeared verbatim in the user's
 * working session, it told Pi the caller was asking for information even when
 * they had only said "Ah.", and "using the current conversation" made Pi answer
 * the session's older question instead of the utterance. The voice lane's own
 * constraints belong in the voice session profile, not in a user message.
 */
export function voiceExecutionContext(text: string, input: VoiceRouteInput): string {
  const request = text.trim()
  if (!input.pendingRequest) return request
  const { text: original, question } = input.pendingRequest
  return `Original request: ${original.slice(0, 3000)}\nVoice clarification: ${question.slice(0, 1000)}\nUser clarification: ${request}`
}

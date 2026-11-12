export type TranscriptTurn = { role: string; content?: string }

/** ElevenLabs sends the whole history. Pi already has its own, so only the newest user line is forwarded. */
export function latestUserText(transcript: TranscriptTurn[]) {
  return [...transcript].reverse().find(message => message.role === "user")?.content?.trim() ?? ""
}

/** The last line already spoken. Jev may use it to tell "continue" from a greeting. Nothing else from the history is sent. */
export function previousAgentText(transcript: TranscriptTurn[]) {
  return [...transcript].reverse().find(message => message.role === "agent")?.content?.trim() ?? ""
}

/** "..." is silence. A very long line is the room (a video, a podcast), not a request to Pi. */
export function dropReason(text: string, maxChars = Number(process.env.MAX_UTTERANCE_CHARS ?? 1200)): "empty" | "background" | null {
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return "empty"
  if (text.length > maxChars) return "background"
  return null
}

/** Optional spoken ack while tools run. Empty unless FILLER is set, so the call does not invent a stock phrase. */
export function fillerFor(_text: string) {
  const filler = process.env.FILLER?.trim()
  if (!filler) return ""
  return filler.endsWith(" ") ? filler : `${filler} `
}

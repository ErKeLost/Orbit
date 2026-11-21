const QUIET = new Set([
  "truncate_not_current",
  "nudge_superseded",
  "response_superseded",
  "typed_turn_superseded",
  "response_cancel_not_active",
])

/**
 * A refused playback report is not a failed call. Prism keeps going.
 * Reporting a reply from before the session went quiet is one of these.
 */
export function quietPrismError(code: string | undefined, message: string | undefined): boolean {
  if (code && QUIET.has(code)) return true
  return /played before the session was last quiet/i.test(message ?? "")
}

/** Only the reply that is actually playing gets a playback report. A finished one is an earlier stretch. */
export function playbackReport(playing: boolean, itemId: string, heardMs: number): { itemId: string; heardMs: number } | null {
  if (!playing || !itemId) return null
  return { itemId, heardMs: Math.max(0, Math.round(heardMs)) }
}

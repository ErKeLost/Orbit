/**
 * The session this call is watching. Opening a call does not create one, and
 * hanging up does not clear work that was already sent.
 */
import type { UiRequest } from "@/lib/protocol"
import { useWorkspace } from "@/lib/store"

export type VoiceBinding = {
  connectionId: string
  sessionFile: string
  cwd: string
  owed: number
  skipSettle: boolean
  pending: UiRequest | null
}

let binding: VoiceBinding | null = null

export function voiceBinding() {
  return binding
}

/** Remember the session on screen. Same session keeps its owed announcements. */
export function bindCall() {
  const state = useWorkspace.getState()
  const connectionId = state.connectionId
  const sessionFile = state.state?.sessionFile ?? ""
  const cwd = state.cwd
  if (!connectionId || !sessionFile || !cwd) return binding
  const same = binding?.connectionId === connectionId
  binding = {
    connectionId,
    sessionFile,
    cwd,
    owed: same ? binding?.owed ?? 0 : 0,
    skipSettle: false,
    pending: same ? binding?.pending ?? null : null,
  }
  return binding
}

export function noteDispatch() {
  if (binding) binding.owed += 1
}

export function noteAbort() {
  if (!binding) return
  binding.skipSettle = true
  if (binding.owed > 0) binding.owed -= 1
}

export function takeSettle(connectionId: string) {
  if (!binding || binding.connectionId !== connectionId) return false
  if (binding.skipSettle) {
    binding.skipSettle = false
    return false
  }
  if (binding.owed <= 0) return false
  binding.owed -= 1
  return true
}

export function notePending(connectionId: string, request: UiRequest) {
  if (!binding || binding.connectionId !== connectionId || binding.owed <= 0) return false
  binding.pending = request
  return true
}

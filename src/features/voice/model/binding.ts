/**
 * The session this call owns. Opening a call creates a new one in the current
 * directory. Hanging up stops work this call started; it does not delete the session.
 */
import type { UiRequest } from "@/lib/protocol"
import { useWorkspace } from "@/lib/store"

let token = 1
let panelHolds = 0

export function voiceToken() {
  return token
}

export function nextVoiceToken() {
  token += 1
  return token
}

export function voiceCurrent(expected: number) {
  return expected === token
}

/** Session creation briefly leaves the voice page. That must not count as hanging up. */
export function holdVoicePanel() {
  panelHolds += 1
  let released = false
  return () => {
    if (released) return
    released = true
    panelHolds -= 1
  }
}

export function voicePanelHeld() {
  return panelHolds > 0
}

export function dropAnnouncements() {
  if (!binding) return
  binding.owed = 0
  binding.skipSettle = true
  binding.pending = null
}

export function clearVoiceBinding() {
  binding = null
}

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

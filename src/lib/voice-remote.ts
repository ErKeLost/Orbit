import type { RemoteEvent } from "./remote-protocol"

export type VoiceRemoteEvent = {
  kind?: string
  text?: string
  audio?: string
  itemId?: string
  message?: string
  code?: string
  callId?: string
  responseId?: string
  arguments?: string
}

const listeners = new Set<(event: VoiceRemoteEvent) => void>()

/** Prism events republished by the paired computer. The phone has no socket of its own. */
export function subscribeVoiceRemote(listener: (event: VoiceRemoteEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function deliverVoiceEvent(event: RemoteEvent): boolean {
  if (event.type !== "voice.event" || !event.event || typeof event.event !== "object" || Array.isArray(event.event)) return false
  const payload = event.event as VoiceRemoteEvent
  for (const listener of listeners) listener(payload)
  return true
}

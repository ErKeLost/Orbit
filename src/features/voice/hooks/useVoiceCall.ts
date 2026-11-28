import { useSyncExternalStore } from "react"
import { voiceCall, type CallSnapshot } from "../model/call"

/** Each subscriber only renders when its own part of the call changes. */
export function useVoiceCall<K extends keyof CallSnapshot>(key: K): CallSnapshot[K] {
  return useSyncExternalStore(voiceCall.subscribe, () => voiceCall.getSnapshot()[key])
}

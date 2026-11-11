import { useSyncExternalStore } from "react"
import { voiceCall } from "../model/call"

/** 通话状态是应用级单例：切面板不该把电话挂掉。 */
export function useVoiceCall() {
  return useSyncExternalStore(voiceCall.subscribe, voiceCall.getSnapshot)
}

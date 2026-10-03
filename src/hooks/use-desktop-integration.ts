import { useEffect, useRef } from "react"
import { NOTIFY_ON_COMPLETE_KEY, notifyRunComplete } from "../lib/desktop-integration"
import { useWorkspace } from "../lib/store"

/**
 * Sends a system notification when a run finishes. Only the running -> idle edge
 * notifies, so opening Orbit never fires one, and `notifyRunComplete` stays
 * silent while the window has focus.
 */
export function useDesktopNotifications(): void {
  const running = useWorkspace(state => state.transcript.running)
  const wasRunning = useRef(running)
  useEffect(() => {
    const previous = wasRunning.current
    wasRunning.current = running
    if (!previous || running) return
    if (localStorage.getItem(NOTIFY_ON_COMPLETE_KEY) === "false") return
    void notifyRunComplete("任务完成")
  }, [running])
}

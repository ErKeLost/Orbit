import { useEffect } from "react"

/**
 * Keeps the screen awake while the floating window is open.
 *
 * Watching a computer through a phone is exactly the case the Screen Wake Lock
 * API exists for, and without it the preview stops being usable after the
 * display timeout — which is a couple of minutes on most phones.
 *
 * Two details the API forces on us:
 *
 * * The lock is released by the platform whenever the page is hidden, so it has
 *   to be re-acquired on the way back rather than requested once.
 * * Acquiring can reject (low battery, a browser that refuses without a user
 *   gesture), and that is not an error worth surfacing: the preview still works,
 *   it just does not hold the screen on.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
    if (!wakeLock) return

    let sentinel: WakeLockSentinel | null = null
    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState === "hidden") return
      try {
        sentinel = await wakeLock.request("screen")
      } catch {
        // Refused; nothing to report and nothing to retry until the next resume.
        sentinel = null
      }
    }

    // A hidden document drops the lock, so every return to the foreground needs
    // a fresh request.
    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire()
    }

    void acquire()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      cancelled = true
      document.removeEventListener("visibilitychange", onVisibility)
      void sentinel?.release().catch(() => undefined)
      sentinel = null
    }
  }, [active])
}

type WakeLock = { request: (type: "screen") => Promise<WakeLockSentinel> }
type WakeLockSentinel = { release: () => Promise<void> }

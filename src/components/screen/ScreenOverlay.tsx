import { useCallback, useEffect, useState } from "react"
import { gooeyToast } from "goey-toast"
import { useWorkspace } from "../../lib/store"
import { screenChannel, type ScreenChannelSnapshot } from "../../lib/remote-screen"
import { loadPlacement, savePlacement, type PipPlacement } from "../../lib/screen-pip"
import { streamSettings, useScreenPreferences } from "../../lib/screen-settings"
import { ScreenPip } from "./ScreenPip"
import { ScreenExpanded } from "./ScreenExpanded"

/**
 * Owns the screen channel for the mobile app.
 *
 * Mounted once at the app shell, so the preview is independent of which panel
 * is showing: switching tabs, opening settings, or reading a session never
 * disturbs it, and closing it never disturbs the session.
 *
 * The pixel budget follows the surface that is actually on screen. The floating
 * window asks for roughly the device pixels it occupies (a thumbnail's worth),
 * and enlarging asks for the full panel — which is what keeps a streaming
 * desktop from competing with the conversation for the phone's link.
 */
export function ScreenOverlay() {
  const mobile = useWorkspace(state => state.runtimeTarget === "mobile")
  const online = useWorkspace(state => state.connection === "online")
  const open = useWorkspace(state => state.screenPip)
  const expanded = useWorkspace(state => state.screenExpanded)
  const preferences = useScreenPreferences()
  const [snapshot, setSnapshot] = useState<ScreenChannelSnapshot>(() => screenChannel().current)
  const [placement, setPlacement] = useState<PipPlacement>(loadPlacement)

  useEffect(() => screenChannel().subscribe(setSnapshot), [])

  const commit = useCallback((next: PipPlacement) => {
    setPlacement(next)
    savePlacement(next)
  }, [])

  // One shape for both surfaces. Matching the pixel budget to the window size
  // would save bytes, but it is also a resolution change — a new capture
  // session, a new encoder and a keyframe — and enlarging should be instant.
  // The small window simply downscales a sharp picture, which is free.
  // `configure` is a no-op when the host already accepted the same shape.
  useEffect(() => {
    if (!mobile || !open || !online) return
    void screenChannel().configure(streamSettings(preferences)).catch(error => {
      gooeyToast.error("屏幕预览未启动", { description: message(error), showTimestamp: false })
    })
  }, [mobile, open, online, preferences])

  // Closing the window releases the subscription; the desktop keeps the capture
  // session for its own idle grace so reopening is instant.
  useEffect(() => {
    if (!mobile || open) return
    void screenChannel().stop()
  }, [mobile, open])

  // Drawing is skipped while hidden; decoding continues, because pausing an
  // inter-frame codec is corruption rather than a saving.
  useEffect(() => screenChannel().setRendering(open), [open])

  // Keep the window inside the viewport after a rotation.
  useEffect(() => {
    const onResize = () => setPlacement(current => {
      const next = { ...current, x: -1, y: -1 }
      savePlacement(next)
      return next
    })
    window.addEventListener("orientationchange", onResize)
    return () => window.removeEventListener("orientationchange", onResize)
  }, [])

  if (!mobile || !open) return null
  return <>
    <ScreenPip snapshot={snapshot} placement={placement} onPlacement={commit} />
    {expanded && <ScreenExpanded snapshot={snapshot} />}
  </>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

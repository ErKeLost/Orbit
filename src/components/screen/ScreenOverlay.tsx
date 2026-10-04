import { useCallback, useEffect, useRef, useState } from "react"
import { gooeyToast } from "goey-toast"
import { useWorkspace } from "../../lib/store"
import { screenChannel, type ScreenChannelSnapshot } from "../../lib/remote-screen"
import { loadPlacement, savePlacement, type PipPlacement } from "../../lib/screen-pip"
import { measurePanelFps, streamSettings, useScreenPreferences } from "../../lib/screen-settings"
import { ScreenPip } from "./ScreenPip"
import { ScreenExpanded } from "./ScreenExpanded"
// Imported here rather than only from the settings panel: that panel is
// lazily loaded, so a phone that had never opened Settings → 屏幕 rendered the
// floating window with no stylesheet at all — unstyled, in normal flow, pushing
// the page open with its contents laid out as plain text.
import "../../styles/screen-channel.css"

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
  // Everything that needs explaining becomes a toast exactly once, on the
  // transition. The window itself stays a picture.
  const announced = useRef(new Set<string>())
  const lastState = useRef<ScreenChannelSnapshot["state"]>("idle")
  /** Whether a picture has ever arrived, which is what "was connected" means. */
  const hadFrame = useRef(false)

  useEffect(() => screenChannel().subscribe(setSnapshot), [])
  // The frame rate is only meaningful once the panel's real refresh rate is
  // known, so measure it as soon as the app shell mounts.
  useEffect(() => {
    void measurePanelFps()
  }, [])

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
    announced.current.clear()
    lastState.current = "idle"
    hadFrame.current = false
  }, [mobile, open])

  // Drawing is skipped while hidden; decoding continues, because pausing an
  // inter-frame codec is corruption rather than a saving.
  useEffect(() => screenChannel().setRendering(open), [open])

  useEffect(() => {
    if (!open) return
    const announce = (id: string, kind: "error" | "info" | "success", text: string, description?: string) => {
      if (announced.current.has(id)) return
      announced.current.add(id)
      if (kind === "error") gooeyToast.error(text, { description, showTimestamp: false })
      else if (kind === "success") gooeyToast.success(text, { description, showTimestamp: false })
      else gooeyToast.warning(text, { description, showTimestamp: false })
    }
    if (snapshot.state === "failed" && snapshot.error) {
      announce(`failed:${snapshot.error}`, "error", "屏幕预览未启动", snapshot.error)
    }
    // Only a *lost* connection is worth a warning. The first connect is what the
    // user just asked for, and announcing it as a disconnection would be wrong.
    if (snapshot.state === "connecting" && hadFrame.current) {
      announce("connecting", "info", "与电脑的连接已断开，正在重连…", "电脑端的「移动端」Host 需要处于启用状态")
    }
    if (snapshot.state === "live" && lastState.current !== "live" && hadFrame.current) {
      announced.current.delete("connecting")
      gooeyToast.success("已重新连接电脑", { showTimestamp: false })
    }
    lastState.current = snapshot.state
    hadFrame.current = hadFrame.current || snapshot.frame !== null
    if (snapshot.codecNote) announce(`codec:${snapshot.codecNote}`, "info", snapshot.codecNote)
    if (snapshot.fpsNote) announce(`fps:${snapshot.fpsNote}`, "info", snapshot.fpsNote)
    // `snapshot.frame` is read through a ref-like accumulator above, but its
    // presence is what makes "was connected" true, so it belongs in the deps.
  }, [open, snapshot.state, snapshot.error, snapshot.frame, snapshot.codecNote, snapshot.fpsNote])

  if (!mobile || !open) return null
  // Success shows the screen; failure is a toast, not an empty box. A floating
  // window whose entire content is "connecting…" says less than one sentence
  // that disappears on its own.
  //
  // Once a picture has arrived the window stays put through a blip, holding the
  // last frame, so a momentary drop does not blank what the user was watching.
  if (!snapshot.frame) return null
  return <>
    <ScreenPip snapshot={snapshot} placement={placement} onPlacement={commit} />
    {expanded && <ScreenExpanded snapshot={snapshot} />}
  </>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

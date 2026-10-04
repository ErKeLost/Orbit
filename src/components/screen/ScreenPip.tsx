import { useRef } from "react"
import { useWorkspace } from "../../lib/store"
import { Icon } from "../Icon"
import { Button } from "../UI"
import type { ScreenChannelSnapshot } from "../../lib/remote-screen"
import { PIP_SIZE_CYCLE, pipBox, type PipPlacement } from "../../lib/screen-pip"
import { ScreenFrame } from "./ScreenFrame"

/**
 * The screen as a floating window, not a tab.
 *
 * The conversation is the product; the screen is something to keep an eye on
 * while the agent works. So it floats *over* the chat instead of replacing it,
 * and opening or closing it touches nothing about the session — no panel
 * change, no remount of the transcript, no reconnect of the control socket
 * (frames travel on their own connection).
 *
 * Tap to enlarge is the whole interaction model: a window this small is fine to
 * watch and useless to aim at, so pointer input lives in the enlarged view and
 * this window only ever receives a drag on its title bar.
 */
export function ScreenPip({ snapshot, placement, onPlacement }: {
  snapshot: ScreenChannelSnapshot
  placement: PipPlacement
  onPlacement: (next: PipPlacement) => void
}) {
  const expanded = useWorkspace(state => state.screenExpanded)
  const drag = useRef<{ pointerId: number; dx: number; dy: number } | null>(null)
  const box = pipBox(placement.size, placement.x, placement.y)
  const nextSize = PIP_SIZE_CYCLE[(PIP_SIZE_CYCLE.indexOf(placement.size) + 1) % PIP_SIZE_CYCLE.length]!

  return <section
    className="screen-pip"
    style={{ left: box.left, top: box.top, width: box.width }}
    data-state={snapshot.state}
    aria-label="电脑屏幕预览"
  >
    <header
      className="screen-pip-bar"
      onPointerDown={event => {
        drag.current = { pointerId: event.pointerId, dx: event.clientX - box.left, dy: event.clientY - box.top }
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const state = drag.current
        if (!state || state.pointerId !== event.pointerId) return
        const next = pipBox(placement.size, event.clientX - state.dx, event.clientY - state.dy)
        onPlacement({ ...placement, x: next.left, y: next.top })
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return
        drag.current = null
      }}
    >
      <span className="screen-state-dot" aria-hidden />
      <span className="screen-pip-title">{snapshot.display?.name ?? "电脑屏幕"}</span>
      <span className="screen-pip-spacer" />
      <Button
        className="screen-pip-action"
        title="切换大小"
        aria-label="切换大小"
        onClick={() => onPlacement({ ...placement, size: nextSize })}
      ><Icon name={placement.size === "large" ? "caret-down" : "caret-up"} /></Button>
      <Button
        className="screen-pip-action"
        title="关闭屏幕预览"
        aria-label="关闭屏幕预览"
        onClick={() => useWorkspace.getState().set({ screenPip: false, screenExpanded: false })}
      ><Icon name="x" /></Button>
    </header>
    {/* `role="button"` rather than a real <button>: a button may only contain
        phrasing content, and the picture inside is not. */}
    <div
      className="screen-pip-body"
      role="button"
      tabIndex={0}
      aria-label="放大以便操作电脑"
      onClick={() => useWorkspace.getState().set({ screenExpanded: true })}
      onKeyDown={event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          useWorkspace.getState().set({ screenExpanded: true })
        }
      }}
    >
      <ScreenFrame snapshot={snapshot} interactive={false} active={!expanded} />
    </div>
    {/* Numbers only. Anything that needs explaining is a toast: a line of status
        text parked at the bottom of a small floating window is both noise and
        invisible at a glance, which is the opposite of what a status line is
        for. The header dot carries the state. */}
    {snapshot.frame && <footer className="screen-pip-foot">
      <span>{`${snapshot.frame.width}×${snapshot.frame.height}`}</span>
      <span>{`${snapshot.receivedFps.toFixed(1)} fps`}</span>
    </footer>}
  </section>
}

import { useEffect, useMemo, useState } from "react"
import { motion, useMotionValue } from "motion/react"
import { useWorkspace } from "../../lib/store"
import { Icon } from "../Icon"
import { Button } from "../UI"
import type { ScreenChannelSnapshot } from "../../lib/remote-screen"
import { PIP_SIZE_CYCLE, currentViewport, pipBox, pipConstraints, type PipPlacement } from "../../lib/screen-pip"
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
  // Tracked as data, not as a counter: the geometry is a pure function of it,
  // so the bounds and the position both follow a rotation as real dependencies.
  const [viewport, setViewport] = useState(currentViewport)
  useEffect(() => {
    const onResize = () => setViewport(currentViewport())
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])
  const box = pipBox(placement.size, placement.x, placement.y, viewport)
  const constraints = useMemo(() => pipConstraints(placement.size, viewport), [placement.size, viewport])
  const nextSize = PIP_SIZE_CYCLE[(PIP_SIZE_CYCLE.indexOf(placement.size) + 1) % PIP_SIZE_CYCLE.length]!

  // The position lives in motion values rather than in `left`/`top`, which is
  // what lets the library own the gesture: it applies a transform while the
  // finger moves and we only commit the result at the end, so React does not
  // re-render on every pointer sample.
  const x = useMotionValue(box.left)
  const y = useMotionValue(box.top)
  // The motion values are the source of truth while dragging, but the stored
  // placement can also change from outside (a size change, a rotation, or a
  // restored default). Both end up here: move to the stored position if it is
  // not already where the window is, and clamp it into the current bounds —
  // motion only clamps during a drag, so a rotation would otherwise leave the
  // window off-screen.
  useEffect(() => {
    const target = pipBox(placement.size, placement.x, placement.y, viewport)
    x.set(Math.min(Math.max(target.left, constraints.left), constraints.right))
    y.set(Math.min(Math.max(target.top, constraints.top), constraints.bottom))
  }, [x, y, constraints, viewport, placement.size, placement.x, placement.y])

  return <motion.section
    className="screen-pip"
    // The whole window drags, not just the title bar: on a phone the natural
    // gesture is to grab the picture, and a 30px handle is a poor target. A tap
    // is still a tap — motion only suppresses it once the pointer has actually
    // moved — so tapping the picture can still enlarge it.
    drag
    // A monitor window should land where it is put: no fling, no rubber-banding.
    dragMomentum={false}
    dragElastic={0}
    dragConstraints={constraints}
    onDragEnd={() => onPlacement({ ...placement, x: x.get(), y: y.get() })}
    style={{ x, y, position: "fixed", left: 0, top: 0, width: box.width }}
    data-state={snapshot.state}
    aria-label="电脑屏幕预览"
  >
    <header className="screen-pip-bar">
      <span className="screen-state-dot" aria-hidden />
      <span className="screen-pip-title">{snapshot.display?.name ?? "电脑屏幕"}</span>
      <span className="screen-pip-spacer" />
      <Button
        className="screen-pip-action"
        title="切换大小"
        aria-label="切换大小"
        // A size change re-clamps the position, so the window never ends up
        // half off-screen after growing.
        onClick={() => {
          const grown = pipBox(nextSize, x.get(), y.get(), viewport)
          onPlacement({ size: nextSize, x: grown.left, y: grown.top })
        }}
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
  </motion.section>
}

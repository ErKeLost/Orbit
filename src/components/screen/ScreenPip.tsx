import { useEffect, useMemo, useRef, useState } from "react"
import { Rnd } from "react-rnd"
import { useWorkspace } from "../../lib/store"
import { Icon } from "../Icon"
import { Button } from "../UI"
import type { ScreenChannelSnapshot } from "../../lib/remote-screen"
import {
  currentViewport,
  defaultWidth,
  maxWidth,
  minWidth,
  pipBox,
  watchViewport,
  type PipPlacement,
  type PipViewport,
} from "../../lib/screen-pip"
import { ScreenFrame } from "./ScreenFrame"

/**
 * The screen as a floating, resizable window over the conversation.
 *
 * Movement and resizing are `react-rnd`, which owns the gesture handling,
 * the eight resize edges and the viewport clamping. What is left here is the
 * part that is this product's: what the window shows, what its size means for
 * the stream, and where it remembers being.
 *
 * The window is free-form sized rather than preset-sized because the picture is
 * the point: a three-step cycle cannot match "that show, in that corner, at
 * that size".
 */
export function ScreenPip({ snapshot, placement, onPlacement }: {
  snapshot: ScreenChannelSnapshot
  placement: PipPlacement
  onPlacement: (next: PipPlacement) => void
}) {
  const expanded = useWorkspace(state => state.screenExpanded)
  const [viewport, setViewport] = useState<PipViewport>(currentViewport)
  useEffect(() => watchViewport(() => setViewport(currentViewport())), [])

  const limits = useMemo(() => ({
    min: minWidth(viewport),
    max: maxWidth(viewport),
  }), [viewport])

  // The stored size can be out of range after a rotation, and `react-rnd` only
  // clamps while the user is actually dragging.
  const width = Math.min(Math.max(placement.width, limits.min), limits.max)
  const height = placement.height > 0 ? placement.height : Math.round(width * 0.62) + 34
  const box = pipBox(placement.x, placement.y, width, height, viewport)

  // `react-rnd` is controlled for position, so an out-of-range stored position
  // (after a rotation, or a size change) is corrected by handing it the clamped
  // value rather than by fighting it.
  const dragged = useRef(false)
  useEffect(() => {
    if (box.left === placement.x && box.top === placement.y) return
    onPlacement({ ...placement, x: box.left, y: box.top })
  }, [box.left, box.top, placement, onPlacement])

  return <Rnd
    className="screen-pip"
    data-state={snapshot.state}
    aria-label="电脑屏幕预览"
    size={{ width, height }}
    position={{ x: box.left, y: box.top }}
    bounds="window"
    minWidth={limits.min}
    minHeight={Math.round(limits.min * 0.62) + 34}
    maxWidth={limits.max}
    maxHeight={Math.round(viewport.height * 0.9)}
    // No `dragHandleClassName`: the whole window drags, which is what a phone
    // wants — a 30px title bar is a poor target. A tap still behaves as a tap
    // (the library suppresses the click only after the pointer has moved), so
    // tapping the picture can still enlarge it.
    onDragStart={() => { dragged.current = true }}
    onDragStop={(_event, data) => onPlacement({ ...placement, x: data.x, y: data.y })}
    onResizeStop={(_event, _direction, element, _delta, position) => {
      onPlacement({
        ...placement,
        width: element.offsetWidth,
        height: element.offsetHeight,
        x: position.x,
        y: position.y,
      })
    }}
    style={{ position: "fixed", zIndex: 60 }}
    enableResizing={{
      top: true, right: true, bottom: true, left: true,
      topRight: true, bottomRight: true, bottomLeft: true, topLeft: true,
    }}
    // The default handles are 10px, which is not a phone target. The two bottom
    // corners get a real hit area and a visible grip; the edges stay as they are
    // so the picture is not surrounded by invisible drag zones.
    resizeHandleStyles={{
      bottomRight: { width: 28, height: 28, right: -2, bottom: -2, zIndex: 4 },
      bottomLeft: { width: 28, height: 28, left: -2, bottom: -2, zIndex: 4 },
    }}
    resizeHandleClasses={{ bottomRight: "screen-pip-grip", bottomLeft: "screen-pip-grip" }}
  >
    <header className="screen-pip-bar">
      <span className="screen-state-dot" aria-hidden />
      <span className="screen-pip-title">{snapshot.display?.name ?? "电脑屏幕"}</span>
      <span className="screen-pip-spacer" />
      <Button
        className="screen-pip-action"
        title="重置大小与位置"
        aria-label="重置大小与位置"
        onClick={() => onPlacement({ x: -1, y: -1, width: defaultWidth(viewport), height: -1 })}
      ><Icon name="arrows-clockwise" /></Button>
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
      <ScreenFrame snapshot={snapshot} interactive={false} active={!expanded} fill />
    </div>
    {/* Numbers only. Anything that needs explaining is a toast: a line of status
        text parked at the bottom of a small floating window is both noise and
        invisible at a glance, which is the opposite of what a status line is
        for. The header dot carries the state. */}
    {snapshot.frame && <footer className="screen-pip-foot">
      <span>{`${snapshot.frame.width}×${snapshot.frame.height}`}</span>
      <span>{`${snapshot.receivedFps.toFixed(1)} fps`}</span>
    </footer>}
  </Rnd>
}

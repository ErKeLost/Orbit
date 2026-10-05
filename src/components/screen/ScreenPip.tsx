import { useEffect, useMemo, useRef, useState } from "react"
import { Rnd } from "react-rnd"
import { useWorkspace } from "../../lib/store"
import { Icon } from "../Icon"
import { Button } from "../UI"
import type { ScreenChannelSnapshot } from "../../lib/remote-screen"
import {
  currentViewport,
  defaultWidth,
  fitSize,
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
/** A drag that ends within this distance of where it began was a tap. */
const TAP_SLOP_PX = 6

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
  const wanted = Math.min(Math.max(placement.width, limits.min), limits.max)
  const wantedHeight = placement.height > 0 ? placement.height : Math.round(wanted * 0.62) + 34
  // Fitted to the *height* as well: in landscape the width-based size is taller
  // than the space the window can move in, and every drag then snaps to the top.
  const { width, height } = fitSize(wanted, wantedHeight, viewport)
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
    minWidth={limits.min}
    minHeight={Math.round(limits.min * 0.62) + 34}
    maxWidth={limits.max}
    maxHeight={Math.round(viewport.height * 0.9)}
    // No `dragHandleClassName`: the whole window drags, which is what a phone
    // wants — a 30px title bar is a poor target.
    //
    // But on a touch screen `react-draggable` calls `preventDefault()` on
    // `touchstart` (to stop the page scrolling under the drag), and that makes
    // the browser skip the `click` it would otherwise synthesize. So nothing
    // inside this window ever received a tap: the close and refresh buttons and
    // "tap the picture to enlarge" were all dead on a phone, while working with a
    // mouse. Two parts to the fix:
    //  * `cancel` keeps the buttons out of the drag entirely, so they get their
    //    ordinary touch handling and their `click`;
    //  * a tap on the picture is recognised when the drag *ends* without having
    //    moved, instead of waiting for a `click` that will not come.
    cancel=".screen-pip-action"
    onDragStart={() => { dragged.current = true }}
    onDragStop={(event, data) => {
      const moved = Math.hypot(data.x - box.left, data.y - box.top)
      const target = event.target instanceof Element ? event.target : null
      if (moved < TAP_SLOP_PX && target?.closest(".screen-pip-body")) {
        useWorkspace.getState().set({ screenExpanded: true })
        return
      }
      // Clamped with the same function that positions the window, so the
      // library and this component can never disagree about where the edge is.
      // `bounds="window"` used `innerHeight` while placement uses the visual
      // viewport minus the composer, and in landscape the two differ enough
      // that every release was pulled back to the top.
      const settled = pipBox(data.x, data.y, width, height, viewport)
      onPlacement({ ...placement, x: settled.left, y: settled.top })
    }}
    onResizeStop={(_event, _direction, element, _delta, position) => {
      onPlacement({
        ...placement,
        width: element.offsetWidth,
        height: element.offsetHeight,
        x: position.x,
        y: position.y,
      })
    }}
    // `react-rnd` writes `display: inline-block` as an *inline* style, which
    // beats the stylesheet's `display: flex`. Without a flex parent the
    // picture's `flex: 1` does nothing and its box collapses to zero height:
    // the canvas holds a good frame, but the window shows only its own dark
    // background. That was the black preview. Restating the layout here puts it
    // after the library's defaults in the same inline style, so it wins.
    style={{ position: "fixed", zIndex: 60, display: "flex", flexDirection: "column" }}
    enableResizing={{
      top: true, right: true, bottom: true, left: true,
      topRight: true, bottomRight: true, bottomLeft: false, topLeft: true,
    }}
    // The default handles are 10px, which is not a phone target. The bottom-right
    // corner gets a real hit area and a visible grip; the edges stay as they are
    // so the picture is not surrounded by invisible drag zones.
    resizeHandleStyles={{
      bottomRight: { width: 28, height: 28, right: -2, bottom: -2, zIndex: 4 },
    }}
    resizeHandleClasses={{ bottomRight: "screen-pip-grip" }}
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
      {/* 收到 / 已解码 / 电脑发出：黑屏时一眼看出断在哪一段，不必先点开放大视图。 */}
      <span>{`收${snapshot.diag.received} 解${snapshot.diag.decoded} 画${snapshot.diag.painted}`}</span>
      <span>{`${snapshot.receivedFps.toFixed(1)} fps`}</span>
    </footer>}
    {(snapshot.diag.lastProblem || snapshot.status?.failure || (snapshot.diag.received > 0 && snapshot.diag.painted === 0)) && <div className="screen-pip-problem" role="status">
      {snapshot.status?.failure
        ? `电脑端：${snapshot.status.failure}`
        : snapshot.diag.lastProblem
          ?? `收到 ${snapshot.diag.received} 帧、送入解码 ${snapshot.diag.decoded}，但画到屏幕上的是 ${snapshot.diag.painted} 帧`}
    </div>}
  </Rnd>
}

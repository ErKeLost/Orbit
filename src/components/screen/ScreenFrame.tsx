import { useCallback, useEffect, useRef } from "react"
import { screenChannel, sendScreenInput, type ScreenChannelSnapshot } from "../../lib/remote-screen"

/**
 * The picture itself: the decoded frame plus, optionally, the touch surface.
 *
 * Both the floating window and the expanded view render this. The coordinate
 * mapping is the one piece of this feature that silently goes wrong — a
 * letterboxed preview offsets every click — so it exists exactly once.
 */
export function ScreenFrame({ snapshot, interactive, active = true }: {
  snapshot: ScreenChannelSnapshot
  interactive: boolean
  /** Whether this surface is the one currently on screen. */
  active?: boolean
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null)
  // A stable identity per mounted surface, so releasing the canvas cannot
  // blank a sibling's picture.
  const owner = useRef({})
  useEffect(() => {
    if (snapshot.codec !== "h264" || !active) return
    // Copied out of the refs so the cleanup releases the same element and
    // identity it claimed, not whatever the ref holds by then.
    const surface = owner.current
    const element = canvas.current
    // The channel owns drawing and the `VideoFrame` lifecycle: handing over the
    // element is what keeps VideoFrames from leaking GPU memory, and splitting
    // that ownership across a component boundary is how they get forgotten.
    screenChannel().attachCanvas(element, surface)
    return () => screenChannel().attachCanvas(null, surface)
  }, [snapshot.codec, active])

  const aspect = snapshot.frame ? snapshot.frame.width / snapshot.frame.height : 16 / 9

  return <div className="screen-stage" style={{ aspectRatio: aspect }}>
    {interactive
      ? <ScreenSurface aspect={aspect} enabled={snapshot.state === "live"} />
      : null}
    {snapshot.codec === "h264"
      ? <canvas className="screen-frame" ref={canvas} role="img" aria-label="电脑屏幕" />
      : snapshot.frameUrl
        ? <img className="screen-frame" src={snapshot.frameUrl} alt="电脑屏幕" draggable={false} />
        : <div className="screen-placeholder"><p>{placeholder(snapshot)}</p></div>}
  </div>
}

function placeholder(snapshot: ScreenChannelSnapshot): string {
  if (snapshot.error) return snapshot.error
  if (snapshot.state === "connecting") return "正在连接电脑…"
  if (snapshot.state === "failed") return "预览已停止"
  return "正在等待画面…"
}

/**
 * The touch surface.
 *
 * Coordinates are normalized against the *rendered image box*, not the outer
 * container: the preview uses `object-fit: contain`, so a wide desktop in a
 * tall box has real letterboxing that would otherwise offset every click.
 *
 * Two fingers scroll, and the in-flight single-pointer gesture is cancelled
 * with a `pointer up` first, so a two-finger scroll never leaves a phantom drag
 * behind on the computer.
 */
function ScreenSurface({ aspect, enabled }: { aspect: number; enabled: boolean }) {
  const surface = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const scrolling = useRef(false)
  const dragging = useRef(false)
  const pending = useRef<{ x: number; y: number } | null>(null)
  const raf = useRef<number | null>(null)

  const normalize = useCallback((clientX: number, clientY: number) => {
    const element = surface.current
    if (!element) return null
    const rect = element.getBoundingClientRect()
    if (!rect.width || !rect.height) return null
    const containerAspect = rect.width / rect.height
    let width = rect.width
    let height = rect.height
    let offsetX = 0
    let offsetY = 0
    if (aspect > containerAspect) {
      height = rect.width / aspect
      offsetY = (rect.height - height) / 2
    } else {
      width = rect.height * aspect
      offsetX = (rect.width - width) / 2
    }
    return {
      x: clamp01((clientX - rect.left - offsetX) / width),
      y: clamp01((clientY - rect.top - offsetY) / height),
    }
  }, [aspect])

  const flush = useCallback(() => {
    raf.current = null
    const point = pending.current
    pending.current = null
    if (!point) return
    sendScreenInput({ kind: "pointer", phase: "move", x: point.x, y: point.y })
  }, [])

  useEffect(() => () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
  }, [])

  if (!enabled) return <div className="screen-surface screen-surface-inert" ref={surface} aria-hidden />

  return <div
    className="screen-surface"
    ref={surface}
    onPointerDown={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      pointers.current.set(event.pointerId, point)
      if (pointers.current.size > 1) {
        if (!scrolling.current) {
          scrolling.current = true
          // Cancel the gesture the first finger already started, or the
          // computer is left holding a mouse button down.
          sendScreenInput({ kind: "pointer", phase: "up", x: point.x, y: point.y })
        }
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      dragging.current = true
      sendScreenInput({ kind: "pointer", phase: "down", x: point.x, y: point.y })
    }}
    onPointerMove={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      const previous = pointers.current.get(event.pointerId)
      pointers.current.set(event.pointerId, point)
      if (scrolling.current) {
        if (previous && pointers.current.size > 1) {
          // The vertical distance between the two fingers drives the wheel.
          sendScreenInput({ kind: "scroll", x: point.x, y: point.y, dx: 0, dy: Math.round((previous.y - point.y) * 24) })
        }
        return
      }
      if (!dragging.current) return
      pending.current = point
      // One move per animation frame is the most the eye can use, and it keeps
      // a fast drag from flooding the socket.
      if (raf.current === null) raf.current = requestAnimationFrame(flush)
    }}
    onPointerUp={event => {
      const point = normalize(event.clientX, event.clientY) ?? pointers.current.get(event.pointerId)
      pointers.current.delete(event.pointerId)
      if (scrolling.current) {
        if (pointers.current.size === 0) scrolling.current = false
        return
      }
      dragging.current = false
      if (!point) return
      sendScreenInput({ kind: "pointer", phase: "up", x: point.x, y: point.y })
    }}
    onPointerCancel={event => {
      pointers.current.delete(event.pointerId)
      dragging.current = false
      if (pointers.current.size === 0) scrolling.current = false
    }}
    onWheel={event => {
      const point = normalize(event.clientX, event.clientY)
      if (!point) return
      sendScreenInput({ kind: "scroll", x: point.x, y: point.y, dx: Math.round(event.deltaX / 12), dy: Math.round(event.deltaY / 12) })
    }}
    role="application"
    aria-label="电脑触控区域"
  />
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

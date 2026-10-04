/**
 * Geometry for the floating screen window.
 *
 * Kept as plain functions, separate from the component, because the *width* is
 * needed by the overlay as well: it decides how many pixels to ask the computer
 * for, and asking a thumbnail for full-screen pixels is exactly the waste this
 * window exists to avoid.
 */

import { persistState } from "./persistent"

const STORAGE_KEY = "orbit.screen.pip.v1"
const MARGIN = 10

export const PIP_SIZES = { small: 0.38, medium: 0.52, large: 0.72 } as const
export type PipSize = keyof typeof PIP_SIZES

export type PipPlacement = {
  /** Left edge in CSS pixels; `-1` means "pin to the right edge" until moved. */
  x: number
  y: number
  size: PipSize
}

export const PIP_SIZE_CYCLE: PipSize[] = ["small", "medium", "large"]

export function loadPlacement(): PipPlacement {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as PipPlacement
      if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number" && parsed.size in PIP_SIZES) {
        return parsed
      }
    }
  } catch {
    // A corrupt preference is not worth failing over.
  }
  return { x: -1, y: -1, size: "medium" }
}

export function savePlacement(placement: PipPlacement): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(placement))
    persistState(STORAGE_KEY, JSON.stringify(placement))
  } catch {
    // Private mode, quota, or a locked profile; the window still works.
  }
}

export type PipBox = { width: number; height: number; left: number; top: number }

/**
 * The rectangle the window is allowed to occupy, in **layout** coordinates.
 *
 * This is the *visual* viewport, not `innerWidth`/`innerHeight`. On Android the
 * on-screen keyboard shrinks the visual viewport while the layout viewport keeps
 * its size, so clamping to `innerHeight` puts a `position: fixed` element behind
 * the keyboard. Being a pure function of this rectangle is also what lets a
 * resize recompute the geometry as a real dependency.
 */
export type PipViewport = { left: number; top: number; width: number; height: number }

export function currentViewport(): PipViewport {
  const visual = window.visualViewport
  if (visual) {
    return { left: visual.offsetLeft, top: visual.offsetTop, width: visual.width, height: visual.height }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/** Subscribe to the events that can change the visible rectangle. */
export function watchViewport(notify: () => void): () => void {
  window.visualViewport?.addEventListener("resize", notify)
  window.visualViewport?.addEventListener("scroll", notify)
  window.addEventListener("orientationchange", notify)
  return () => {
    window.visualViewport?.removeEventListener("resize", notify)
    window.visualViewport?.removeEventListener("scroll", notify)
    window.removeEventListener("orientationchange", notify)
  }
}

/**
 * `env(safe-area-inset-bottom)` in pixels.
 *
 * Not readable from JavaScript directly, so it goes through a probe element
 * that has the value as padding and is measured. This replaces a guessed
 * constant for the home-indicator inset.
 */
export function safeAreaBottom(): number {
  if (typeof document === "undefined") return 0
  safeAreaProbe ??= (() => {
    const probe = document.createElement("div")
    probe.setAttribute("aria-hidden", "true")
    probe.style.cssText =
      "position:fixed;left:0;bottom:0;width:0;height:0;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom,0px)"
    document.body.append(probe)
    return probe
  })()
  return Number.parseFloat(getComputedStyle(safeAreaProbe).paddingBottom) || 0
}

let safeAreaProbe: HTMLDivElement | null = null

/**
 * Height of the message composer dock, measured rather than assumed.
 *
 * The floating window should not land on the thing the user is typing into, and
 * that height depends on the composer's own state — attachments, a multi-line
 * draft. Measuring it beats the reserved-constant this used to be.
 */
export function dockClearance(viewport: PipViewport): number {
  const dock = document.querySelector(".composer-container")
  if (!dock) return 0
  const rect = dock.getBoundingClientRect()
  if (rect.height <= 0) return 0
  const visibleBottom = viewport.top + viewport.height
  return Math.max(0, Math.min(rect.height, visibleBottom - rect.top))
}

/**
 * Where the window may be dragged to, in the same coordinates the window is
 * positioned in.
 *
 * Motion's `dragConstraints` takes the allowed offset range, so with the
 * element laid out at the viewport origin these are plain viewport bounds —
 * which is what keeps the window from being dragged off-screen.
 */
export type PipConstraints = { left: number; top: number; right: number; bottom: number }

export function pipConstraints(size: PipSize, viewport: PipViewport): PipConstraints {
  const height = Math.round(pipWidth(size, viewport) * 0.62) + 34
  const { left, right, bottom } = pipBounds(size, viewport, height)
  return { left, top: viewport.top + MARGIN, right, bottom }
}

/** Width in CSS pixels, which is also what the pixel budget is derived from. */
export function pipWidth(size: PipSize, viewport: PipViewport = currentViewport()): number {
  return Math.round(viewport.width * PIP_SIZES[size])
}

export function pipBox(size: PipSize, x: number, y: number, viewport: PipViewport): PipBox {
  const width = pipWidth(size, viewport)
  // The picture keeps the display's aspect ratio and the window lets it decide
  // its own height, so an estimate is enough for clamping to the visible area.
  const height = Math.round(width * 0.62) + 34
  const { left, right, bottom } = pipBounds(size, viewport, height)
  return {
    width,
    height,
    left: Math.min(Math.max(x < 0 ? right : x, left), right),
    top: Math.min(Math.max(y < 0 ? bottom : y, left), bottom),
  }
}

/** The allowed position range, shared by placement and drag constraints. */
function pipBounds(size: PipSize, viewport: PipViewport, height: number) {
  const width = pipWidth(size, viewport)
  const left = viewport.left + MARGIN
  const right = Math.max(left, viewport.left + viewport.width - width - MARGIN)
  // Clearance for the home indicator and the composer dock, both measured.
  const clear = safeAreaBottom() + dockClearance(viewport)
  const bottom = Math.max(
    viewport.top + MARGIN,
    viewport.top + viewport.height - height - MARGIN - clear,
  )
  return { left, right, bottom }
}

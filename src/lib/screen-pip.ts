/**
 * Geometry for the floating screen window.
 *
 * Kept as plain functions, separate from the component, because the *width* is
 * needed by the overlay as well: it decides how many pixels to ask the computer
 * for, and asking a thumbnail for full-screen pixels is exactly the waste this
 * window exists to avoid.
 */

import { persistState } from "./persistent"

const STORAGE_KEY = "orbit.screen.pip.v2"
const MARGIN = 10

/// Default width as a fraction of the viewport, used when there is nothing
/// stored and by the "reset size" action.
const DEFAULT_WIDTH_RATIO = 0.52

/// Fractions of the viewport the window may be sized to. The floor keeps the
/// picture recognisable; the ceiling keeps the conversation usable.
const MIN_WIDTH_RATIO = 0.22
const MAX_WIDTH_RATIO = 0.94

export type PipPlacement = {
  /** Left edge in CSS pixels; `-1` means "pin to the right edge" until moved. */
  x: number
  y: number
  /** Width in CSS pixels. Free-form: the window is resizable, not preset-sized. */
  width: number
  /** Height in CSS pixels; `-1` means "derive from the picture's aspect ratio". */
  height: number
}

export function defaultWidth(viewport: PipViewport): number {
  return Math.round(viewport.width * DEFAULT_WIDTH_RATIO)
}

export function minWidth(viewport: PipViewport): number {
  return Math.round(viewport.width * MIN_WIDTH_RATIO)
}

export function maxWidth(viewport: PipViewport): number {
  return Math.round(viewport.width * MAX_WIDTH_RATIO)
}

export function loadPlacement(): PipPlacement {
  const fallback = (viewport: PipViewport): PipPlacement => ({
    x: -1,
    y: -1,
    width: defaultWidth(viewport),
    height: -1,
  })
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<PipPlacement>
      if (parsed && typeof parsed.x === "number" && typeof parsed.y === "number" && typeof parsed.width === "number" && parsed.width > 0) {
        return { x: parsed.x, y: parsed.y, width: parsed.width, height: typeof parsed.height === "number" ? parsed.height : -1 }
      }
    }
  } catch {
    // A corrupt preference is not worth failing over.
  }
  return fallback(currentViewport())
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

export function pipConstraints(viewport: PipViewport, width: number, height: number): PipConstraints {
  const { left, right, bottom } = pipBounds(viewport, width, height)
  return { left, top: viewport.top + MARGIN, right, bottom }
}

/** Width in CSS pixels, which is also what the pixel budget is derived from. */
export function pipBox(x: number, y: number, width: number, height: number, viewport: PipViewport): PipBox {
  const { left, right, bottom } = pipBounds(viewport, width, height)
  return {
    width,
    height,
    left: Math.min(Math.max(x < 0 ? right : x, left), right),
    top: Math.min(Math.max(y < 0 ? bottom : y, left), bottom),
  }
}

/** The allowed position range, shared by placement and drag constraints. */
function pipBounds(viewport: PipViewport, width: number, height: number) {
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

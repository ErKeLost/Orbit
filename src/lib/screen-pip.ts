/**
 * Geometry for the floating screen window.
 *
 * Kept as plain functions, separate from the component, because the *width* is
 * needed by the overlay as well: it decides how many pixels to ask the computer
 * for, and asking a thumbnail for full-screen pixels is exactly the waste this
 * window exists to avoid.
 */

const STORAGE_KEY = "orbit.screen.pip.v1"
const MARGIN = 10
/**
 * Space kept clear at the bottom.
 *
 * The default position is the bottom-right corner, which on this app is where
 * the composer lives. Reserving roughly its height keeps the floating window
 * from covering the thing the user is typing into — the session stays usable
 * with the screen open, which is the entire point of the window.
 */
const BOTTOM_RESERVE = 92

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
  } catch {
    // Private mode, quota, or a locked profile; the window still works.
  }
}

export type PipBox = { width: number; height: number; left: number; top: number }

/**
 * The viewport the window is placed in.
 *
 * Passed in rather than read from `window` so the geometry is a pure function —
 * which is what lets a resize recompute it as a real dependency instead of
 * something the caller has to remember to invalidate.
 */
export type PipViewport = { width: number; height: number }

export function currentViewport(): PipViewport {
  return { width: window.innerWidth, height: window.innerHeight }
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
  const box = pipBox(size, -1, -1, viewport)
  return {
    left: MARGIN,
    top: MARGIN,
    // The window's own size is what makes `right`/`bottom` the far edge of its
    // position rather than of the viewport.
    right: Math.max(MARGIN, viewport.width - box.width - MARGIN),
    bottom: Math.max(MARGIN, viewport.height - box.height - MARGIN - BOTTOM_RESERVE),
  }
}

/** Width in CSS pixels, which is also what the pixel budget is derived from. */
export function pipWidth(size: PipSize, viewport: PipViewport = currentViewport()): number {
  return Math.round(viewport.width * PIP_SIZES[size])
}

export function pipBox(size: PipSize, x: number, y: number, viewport: PipViewport): PipBox {
  const width = pipWidth(size, viewport)
  // The picture keeps the display's aspect ratio and the window lets it decide
  // its own height, so an estimate is enough for clamping to the viewport.
  const height = Math.round(width * 0.62) + 34
  const maxX = Math.max(MARGIN, viewport.width - width - MARGIN)
  const maxY = Math.max(MARGIN, viewport.height - height - MARGIN - BOTTOM_RESERVE)
  return {
    width,
    height,
    left: Math.min(Math.max(x < 0 ? maxX : x, MARGIN), maxX),
    top: Math.min(Math.max(y < 0 ? maxY : y, MARGIN), maxY),
  }
}

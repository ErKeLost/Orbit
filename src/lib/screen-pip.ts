import type { RemoteScreenSettings } from "./remote-protocol"

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

/** Width in CSS pixels, which is also what the pixel budget is derived from. */
export function pipWidth(size: PipSize): number {
  return Math.round(window.innerWidth * PIP_SIZES[size])
}

export function pipBox(size: PipSize, x: number, y: number): PipBox {
  const width = pipWidth(size)
  // The picture keeps the display's aspect ratio and the window lets it decide
  // its own height, so an estimate is enough for clamping to the viewport.
  const height = Math.round(width * 0.62) + 34
  const maxX = Math.max(MARGIN, window.innerWidth - width - MARGIN)
  const maxY = Math.max(MARGIN, window.innerHeight - height - MARGIN - BOTTOM_RESERVE)
  return {
    width,
    height,
    left: Math.min(Math.max(x < 0 ? maxX : x, MARGIN), maxX),
    top: Math.min(Math.max(y < 0 ? maxY : y, MARGIN), maxY),
  }
}

/**
 * Pixel budget per surface.
 *
 * The point of the floating window is that it is affordable: a thumbnail asks
 * for a thumbnail's worth of pixels instead of paying for a full-screen stream
 * nobody is looking at. `maxWidth` is matched to the device pixels the surface
 * actually occupies, so the picture is 1:1 rather than upscaled and soft —
 * which is what "the screen is blurry" turned out to be.
 */
export function pipSettings(width: number): RemoteScreenSettings {
  return {
    maxWidth: clamp(Math.round(width * devicePixelRatio()), 360, 900),
    maxFps: 10,
    quality: 60,
  }
}

export function expandedSettings(): RemoteScreenSettings {
  // Full panel width in device pixels: a phone at 412pt and dpr 3 wants ~1236,
  // where the old `min(dpr, 2)` cap asked for 824 and then upscaled it.
  return {
    maxWidth: clamp(Math.round(window.innerWidth * devicePixelRatio()), 640, 1600),
    maxFps: 15,
    quality: 72,
  }
}

/** Three is where phone panels stop; beyond that the extra pixels are wasted. */
function devicePixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, 3)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

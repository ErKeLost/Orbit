import { create } from "zustand"

/**
 * Screen preferences, and the one place they are turned into a stream shape.
 *
 * The defaults ask for the most the channel can do — highest resolution the
 * panel can show, highest frame rate, highest quality — because a preview that
 * is deliberately mediocre is a preview you have to squint at. What the link
 * can actually carry is not a preference, it is a measurement, so the host's
 * bandwidth governor discovers it and walks *down* from here. The settings
 * exist to lower the ceiling deliberately, not to set a timid one.
 */

export type ScreenSource = "app" | "display"
export type ScreenCodecChoice = "auto" | "h264" | "jpeg"
export type ScreenQuality = "max" | "balanced" | "saver"

export type ScreenPreferences = {
  /** `app` follows the frontmost application's window: the one being operated. */
  source: ScreenSource
  /** Which display when `source` is `display`; `null` means the main display. */
  displayId: number | null
  /** `auto` probes WebCodecs and prefers H.264, falling back to JPEG. */
  codec: ScreenCodecChoice
  quality: ScreenQuality
  showCursor: boolean
}

/** Ceilings the host enforces; asking for more is silently clamped there. */
const MAX_FPS = 30
const MAX_WIDTH = 2560

const QUALITY_PROFILES: Record<ScreenQuality, { maxFps: number; quality: number; widthScale: number }> = {
  // The default: as fast, as sharp, and as fine as the host will go.
  max: { maxFps: MAX_FPS, quality: 90, widthScale: 1 },
  balanced: { maxFps: 15, quality: 72, widthScale: 0.75 },
  saver: { maxFps: 8, quality: 55, widthScale: 0.5 },
}

const STORAGE_KEY = "orbit.screen.prefs.v1"

function defaults(): ScreenPreferences {
  return { source: "app", displayId: null, codec: "auto", quality: "max", showCursor: true }
}

function load(): ScreenPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ScreenPreferences>
      const base = defaults()
      return {
        source: parsed.source === "display" ? "display" : parsed.source === "app" ? "app" : base.source,
        displayId: typeof parsed.displayId === "number" ? parsed.displayId : base.displayId,
        codec: parsed.codec === "h264" || parsed.codec === "jpeg" ? parsed.codec : base.codec,
        quality: parsed.quality && parsed.quality in QUALITY_PROFILES ? parsed.quality : base.quality,
        showCursor: typeof parsed.showCursor === "boolean" ? parsed.showCursor : base.showCursor,
      }
    }
  } catch {
    // A corrupt preference is not worth failing over.
  }
  return defaults()
}

function persist(preferences: ScreenPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
  } catch {
    // Private mode, quota, or a locked profile; the preview still works.
  }
}

type ScreenSettingsStore = ScreenPreferences & {
  set: (patch: Partial<ScreenPreferences>) => void
}

export const useScreenPreferences = create<ScreenSettingsStore>((set, get) => ({
  ...load(),
  set: patch => {
    set(patch)
    const { source, displayId, codec, quality, showCursor } = get()
    persist({ source, displayId, codec, quality, showCursor })
  },
}))

/** Current preferences outside React, for callers that are not components. */
export function screenPreferences(): ScreenPreferences {
  const { source, displayId, codec, quality, showCursor } = useScreenPreferences.getState()
  return { source, displayId, codec, quality, showCursor }
}

/**
 * Turn preferences into the shape sent to the host.
 *
 * One shape for both surfaces on purpose. Matching the pixel budget to the
 * window size would save bytes, but it also means a resolution change — and a
 * resolution change is a new capture session, a new encoder and a keyframe. The
 * floating window enlarging should be instant, so the stream stays put and the
 * small window simply downscales a sharp picture, which is free.
 */
export function streamSettings(preferences: ScreenPreferences = screenPreferences()) {
  const profile = QUALITY_PROFILES[preferences.quality]
  // Three is where phone panels stop; beyond that the extra pixels are wasted.
  const deviceWidth = Math.round(window.innerWidth * Math.min(window.devicePixelRatio || 1, 3))
  return {
    maxWidth: clamp(Math.round(deviceWidth * profile.widthScale), 360, MAX_WIDTH),
    maxFps: profile.maxFps,
    quality: profile.quality,
    showCursor: preferences.showCursor,
    source: preferences.source,
    ...(preferences.source === "display" && preferences.displayId !== null
      ? { displayId: preferences.displayId }
      : {}),
    ...(preferences.codec === "auto" ? {} : { codec: preferences.codec }),
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

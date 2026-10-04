import { create } from "zustand"
import { persistState } from "./persistent"

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
/**
 * Target frame rate. `panel` asks for the phone's own refresh rate, because
 * anything beyond it is invisible: a 60 Hz panel cannot show frame 61, and
 * asking for 120 on one only spends bandwidth on frames the compositor drops.
 */
export type ScreenFps = "panel" | 30 | 60 | 90 | 120

export type ScreenPreferences = {
  /** `app` follows the frontmost application's window: the one being operated. */
  source: ScreenSource
  /** Which display when `source` is `display`; `null` means the main display. */
  displayId: number | null
  /** `auto` probes WebCodecs and prefers H.264, falling back to JPEG. */
  codec: ScreenCodecChoice
  quality: ScreenQuality
  fps: ScreenFps
  showCursor: boolean
}

/** Ceilings the host enforces; asking for more is silently clamped there. */
const MAX_FPS = 120
const MAX_WIDTH = 2560

const QUALITY_PROFILES: Record<ScreenQuality, { maxFps: number; quality: number; widthScale: number }> = {
  // The default: as fast, as sharp, and as fine as the host will go.
  max: { maxFps: MAX_FPS, quality: 90, widthScale: 1 },
  balanced: { maxFps: 30, quality: 72, widthScale: 0.75 },
  saver: { maxFps: 15, quality: 55, widthScale: 0.5 },
}

/**
 * The phone's refresh rate, measured rather than assumed.
 *
 * `requestAnimationFrame` fires at the panel's rate, so counting frames for half
 * a second answers the only question that matters here: how many frames per
 * second can this screen actually show. Cached for the session — it does not
 * change, and measuring on every settings change would be silly.
 */
let measuredPanelFps: number | null = null
let measuring: Promise<number> | null = null

export function measurePanelFps(): Promise<number> {
  measuring ??= new Promise<number>(resolve => {
    let frames = 0
    const started = performance.now()
    const tick = () => {
      frames += 1
      const elapsed = performance.now() - started
      if (elapsed < 400) {
        requestAnimationFrame(tick)
        return
      }
      const rate = Math.round((frames * 1000) / elapsed)
      // Snap to a real panel rate: timer jitter should not produce "117".
      const snapped = [60, 90, 120, 144].find(candidate => Math.abs(candidate - rate) <= 8) ?? rate
      measuredPanelFps = Math.min(Math.max(snapped, 30), MAX_FPS)
      resolve(measuredPanelFps)
    }
    requestAnimationFrame(tick)
  })
  return measuring
}

/** The measured panel rate, or 60 until the first measurement lands. */
export function panelFps(): number {
  return measuredPanelFps ?? 60
}

const STORAGE_KEY = "orbit.screen.prefs.v2"

function defaults(): ScreenPreferences {
  return { source: "app", displayId: null, codec: "auto", quality: "max", fps: "panel", showCursor: true }
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
        fps: parsed.fps === "panel" || [30, 60, 90, 120].includes(parsed.fps as number)
          ? (parsed.fps as ScreenFps)
          : base.fps,
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
    persistState(STORAGE_KEY, JSON.stringify(preferences))
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
    const { source, displayId, codec, quality, fps, showCursor } = get()
    persist({ source, displayId, codec, quality, fps, showCursor })
  },
}))

/** Current preferences outside React, for callers that are not components. */
export function screenPreferences(): ScreenPreferences {
  const { source, displayId, codec, quality, fps, showCursor } = useScreenPreferences.getState()
  return { source, displayId, codec, quality, fps, showCursor }
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
  // The explicit frame-rate choice wins over the quality profile's ceiling:
  // "maximum" means the panel's maximum, not 30.
  const fps = preferences.fps === "panel"
    ? Math.min(panelFps(), profile.maxFps)
    : Math.min(preferences.fps, profile.maxFps)
  return {
    maxWidth: clamp(Math.round(deviceWidth * profile.widthScale), 360, MAX_WIDTH),
    maxFps: fps,
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

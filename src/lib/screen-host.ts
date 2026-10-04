import { invoke } from "@tauri-apps/api/core"

/** Mirror of `screen::capture::DisplayInfo` on the desktop side. */
export type ScreenDisplay = {
  id: number
  name: string
  logicalX: number
  logicalY: number
  logicalWidth: number
  logicalHeight: number
  pixelWidth: number
  pixelHeight: number
  scale: number
  primary: boolean
}

/** Mirror of `screen::ScreenStatus`. */
export type ScreenHostStatus = {
  running: boolean
  /** macOS TCC "Screen Recording", which is separate from accessibility. */
  permission: boolean
  subscribers: number
  /** `"h264"` or `"jpeg"`, as actually used by the running pipeline. */
  codec: string
  width: number
  height: number
  fps: number
  effectiveFps: number
  quality: number
  displays: ScreenDisplay[]
  display?: ScreenDisplay
  captured: number
  published: number
  dropped: number
  unchanged: number
  encodeMsAvg: number
  encodeMsMax: number
  bitsPerSecond: number
  failure?: string
}

export function screenHostStatus(): Promise<ScreenHostStatus> {
  return invoke<ScreenHostStatus>("screen_status")
}

export function screenHostDisplays(): Promise<ScreenDisplay[]> {
  return invoke<ScreenDisplay[]>("screen_displays")
}

/**
 * Ask macOS for screen-recording access. The answer only turns true after the
 * user grants it in System Settings and restarts Orbit, so callers re-read
 * `screenHostStatus` rather than trusting the return value.
 */
export function screenHostRequestPermission(): Promise<boolean> {
  return invoke<boolean>("screen_request_permission")
}

export function screenHostStop(): Promise<ScreenHostStatus> {
  return invoke<ScreenHostStatus>("screen_stop")
}

export function formatBitrate(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return "0 kbps"
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB"
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

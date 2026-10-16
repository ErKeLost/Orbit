import { randomUUID } from "node:crypto"
import type { CuaDriver } from "../cua/driver.ts"
import type { CuaObservation } from "../cua/types.ts"

/**
 * Attach the window to the chooser.
 *
 * Jev 1.14 accepts images, and its strength with them is *discrimination among
 * bounded options* — not precise localisation. Measured on a real window: the
 * `noul` presence answer was 0.96, while a `Box` answer for the same field
 * landed at confidence 0.35 with wrong coordinates. So the screenshot travels
 * with the candidate table and Jev still picks a candidate id: the action stays
 * an exact, snapshot-bound `element_token`, and the pixels only inform *which*
 * candidate is right.
 *
 * Limits are the service's, not ours: 256–1568 px per side and 78,400–2,458,624
 * total pixels. An image outside them is rejected, never resized, so an
 * out-of-range capture is skipped rather than sent.
 */

export const VISION_MIN_SIDE = 256
export const VISION_MAX_SIDE = 1_568
export const VISION_MIN_PIXELS = 78_400
export const VISION_MAX_PIXELS = 2_458_624

export type VisionImage = {
  /** Reference string used in `state`; unique per request by design. */
  reference: string
  format: "png"
  dataBase64: string
  width: number
  height: number
}

export function visionLimitsOk(width: number, height: number): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false
  if (width < VISION_MIN_SIDE || height < VISION_MIN_SIDE) return false
  if (width > VISION_MAX_SIDE || height > VISION_MAX_SIDE) return false
  const pixels = width * height
  return pixels >= VISION_MIN_PIXELS && pixels <= VISION_MAX_PIXELS
}

/**
 * Capture the window for the chooser. The driver caps the long edge itself, so
 * no local resampling is needed — and `click`/`type_text` pixels stay in the
 * same coordinate space as the returned image.
 */
export async function captureVisionImage(driver: CuaDriver, observation: CuaObservation): Promise<VisionImage | undefined> {
  const state = await driver.getWindowState({
    pid: observation.pid,
    windowId: observation.windowId,
    includeAccessibilityTree: false,
    includeScreenshot: true,
    maxImageDimension: VISION_MAX_SIDE,
  })
  const base64 = state.screenshot?.base64
  const width = state.screenshot?.width ?? 0
  const height = state.screenshot?.height ?? 0
  if (!base64 || !visionLimitsOk(width, height)) return undefined
  return { reference: `${randomUUID()}-window`, format: "png", dataBase64: base64, width, height }
}

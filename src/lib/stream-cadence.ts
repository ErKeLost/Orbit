/** Visible streams stay on the animation frame until the active reply is long. */
export const SLOW_STREAM_CHARS = 8_000;
export const SLOW_STREAM_MS = 32;

/** `null` means flush on the next animation frame. A number is a timeout. */
export function foregroundFlushDelay(activeChars: number): number | null {
  return activeChars >= SLOW_STREAM_CHARS ? SLOW_STREAM_MS : null;
}

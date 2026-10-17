/**
 * The size policy for images on their way to a model.
 *
 * One place, because two paths act on it — a pasted screenshot (`image-encode.ts`
 * and its worker) and a picked file (`image-attachment.ts`) — and they must agree
 * about what "small enough" means.
 *
 * Every number here is a latency decision as much as a quality one. A picture is
 * uploaded inside the request, so its bytes are time the user waits before the
 * first token: measured against DeepSeek, roughly one second per 1.2MB of
 * base64. A 1400px-tall capture took 0.9s as text, 2.0s at 923KB, 3.6s at 5.6MB.
 */

/**
 * Long-edge ceiling. Providers resample above ~1568px anyway, so pixels past it
 * are paid for twice and used once. 1568 keeps UI text legible while leaving ~41%
 * fewer pixels than 2048.
 */
export const MAX_IMAGE_EDGE = 1568

/**
 * PNG stays PNG — a screenshot re-encoded as JPEG puts ringing around every glyph
 * — but not at any price. Past this size the lossless copy is what the user waits
 * on, so an oversized PNG becomes high-quality JPEG instead. The threshold sits
 * above a normal 1568px UI capture (~200-600KB).
 */
export const PNG_FALLBACK_BYTES = 1_200_000

/** Under this, an image is sent as it came: re-encoding a small image loses more than it saves. */
export const RECODE_ABOVE_BYTES = 2 * 1024 * 1024

/** Above this, the attachment is refused by name rather than sent and dropped somewhere. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

import { describe, expect, test } from "bun:test"
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_EDGE,
  RECODE_ABOVE_BYTES,
  outputMimeFor,
  prepareImageAttachment,
  resolveImageMime,
  shouldReencode,
  type ImageCodec,
} from "../src/lib/image-attachment"

/**
 * A picked image, on its way to the model.
 *
 * The phone is where this goes wrong and the desktop is where it does not: a
 * camera JPEG is several megabytes in one WebSocket frame, and Android's picker
 * hands back sources whose `File.type` is empty often enough that the desktop
 * path already derives the type from the name instead. Both failures are silent
 * — the attachment looks fine in the composer and reaches the model as nothing.
 */
const blob = (bytes: number, type = "image/jpeg") => new Blob([new Uint8Array(bytes)], { type })

function fakeCodec(overrides: Partial<ImageCodec> = {}) {
  const calls = { measure: 0, rescale: 0 }
  const codec: ImageCodec = {
    async measure() {
      calls.measure += 1
      return { width: 4000, height: 3000 }
    },
    async rescale(_blob, _maxEdge, mimeType) {
      calls.rescale += 1
      return blob(500_000, mimeType)
    },
    ...overrides,
  }
  return { codec, calls }
}

describe("what type an attachment is", () => {
  test("keeps a type the picker declared", () => {
    expect(resolveImageMime({ name: "photo.bin", type: "image/webp" })).toBe("image/webp")
  })

  test("falls back to the file name when the picker says nothing", () => {
    // Android hands back `content://` sources and `File.type` is empty for
    // enough of them that this is the normal case, not the edge case.
    expect(resolveImageMime({ name: "IMG_0421.JPG", type: "" })).toBe("image/jpeg")
    expect(resolveImageMime({ name: "screenshot.PNG" })).toBe("image/png")
    expect(resolveImageMime({ name: "clip.heic", type: "" })).toBe("image/heic")
  })

  test("refuses anything that is neither", () => {
    expect(resolveImageMime({ name: "notes.txt", type: "text/plain" })).toBeNull()
    expect(resolveImageMime({ name: "archive", type: "" })).toBeNull()
    expect(resolveImageMime({ type: "application/octet-stream" })).toBeNull()
  })

  test("a declared non-image type does not win over the name", () => {
    // `application/octet-stream` is what several pickers report for a real
    // image; the extension is the better answer.
    expect(resolveImageMime({ name: "photo.jpg", type: "application/octet-stream" })).toBe("image/jpeg")
  })
})

describe("whether to re-encode", () => {
  test("leaves an already small image exactly as it is", () => {
    expect(shouldReencode({ width: 1200, height: 800, bytes: 300_000 })).toBe(false)
    expect(shouldReencode({ width: MAX_ATTACHMENT_EDGE, height: 1000, bytes: RECODE_ABOVE_BYTES })).toBe(false)
  })

  test("re-encodes on either axis being too big", () => {
    expect(shouldReencode({ width: 4000, height: 3000, bytes: 5_000_000 })).toBe(true)
    expect(shouldReencode({ width: 1200, height: 800, bytes: RECODE_ABOVE_BYTES + 1 })).toBe(true)
  })

  test("re-encodes when the size is unknown", () => {
    // A zero width means the measurement did not happen; guessing "small" would
    // send the one attachment most likely to be a phone photo untouched.
    expect(shouldReencode({ width: 0, height: 0, bytes: 100 })).toBe(true)
    expect(shouldReencode({ width: Number.NaN, height: 100, bytes: 100 })).toBe(true)
  })
})

describe("what to encode to", () => {
  test("PNG stays PNG so a screenshot keeps its text crisp", () => {
    expect(outputMimeFor("image/png")).toBe("image/png")
  })

  test("everything else becomes JPEG", () => {
    for (const mime of ["image/jpeg", "image/heic", "image/webp", "image/gif"]) {
      expect(outputMimeFor(mime)).toBe("image/jpeg")
    }
  })
})

describe("preparing an attachment", () => {
  const file = { name: "IMG_0421.jpg", type: "", size: 5_000_000, blob: blob(5_000_000) }

  test("downscales a camera photo and says so", async () => {
    const { codec, calls } = fakeCodec()
    const prepared = await prepareImageAttachment(file, codec)
    expect(calls.rescale).toBe(1)
    expect(prepared.recoded).toBe(true)
    expect(prepared.mimeType).toBe("image/jpeg")
    expect(prepared.blob.size).toBe(500_000)
  })

  test("does not touch a small image, and never pays for a decode it does not need", async () => {
    const { codec, calls } = fakeCodec({ measure: async () => ({ width: 800, height: 600 }) })
    const small = { ...file, size: 200_000, blob: blob(200_000) }
    const prepared = await prepareImageAttachment(small, codec)
    expect(calls.rescale).toBe(0)
    expect(prepared.recoded).toBe(false)
    expect(prepared.blob).toBe(small.blob)
  })

  test("names the type even when nothing had to be re-encoded", async () => {
    // The empty `mimeType` is the failure that reaches the provider as an
    // undecodable image, and re-encoding is not the only place it gets fixed.
    const { codec } = fakeCodec({ measure: async () => ({ width: 800, height: 600 }) })
    const prepared = await prepareImageAttachment({ ...file, size: 200_000, blob: blob(200_000) }, codec)
    expect(prepared.mimeType).toBe("image/jpeg")
  })

  test("sends a format the WebView cannot decode rather than refusing it", async () => {
    const { codec } = fakeCodec({
      measure: async () => {
        throw new Error("cannot decode")
      },
    })
    const prepared = await prepareImageAttachment(file, codec)
    expect(prepared.recoded).toBe(false)
    expect(prepared.blob).toBe(file.blob)
    expect(prepared.mimeType).toBe("image/jpeg")
  })

  test("refuses a file that is not an image by name", async () => {
    const { codec } = fakeCodec()
    await expect(prepareImageAttachment({ name: "notes.txt", type: "text/plain", size: 10, blob: blob(10) }, codec)).rejects.toThrow(
      "不是图片：notes.txt",
    )
  })

  test("refuses a result that is still too large, saying how large", async () => {
    const { codec } = fakeCodec({ rescale: async () => blob(MAX_ATTACHMENT_BYTES + 1) })
    await expect(prepareImageAttachment(file, codec)).rejects.toThrow("超过 8 MB")
  })

  test("keeps the frame inside what the host will read", () => {
    // The host reads with tungstenite's defaults: 16 MiB per frame. base64 is a
    // third larger than the bytes it carries, so the cap has to leave room for
    // that — an attachment that overflowed it would not be refused with a
    // message, it would drop the pairing socket in the middle of the send.
    const HOST_MAX_FRAME_BYTES = 16 * 1024 * 1024
    expect(MAX_ATTACHMENT_BYTES * (4 / 3)).toBeLessThan(HOST_MAX_FRAME_BYTES)
  })
})

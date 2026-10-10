import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { MAX_REMOTE_PREVIEW_BYTES, base64ToBytes, planMediaPreview, tooLargeMessage } from "../src/lib/media-preview"

/**
 * How a media file reaches the screen that shows it.
 *
 * Two rules carry the whole design, and both are invisible until a phone is
 * holding something it cannot draw: the desktop is never diverted away from the
 * asset protocol (it streams, and has no limit), and a phone is never asked to
 * pull a file whose bytes would not fit in its webview's memory.
 */
describe("choosing how to preview media", () => {
  test("the desktop keeps the asset protocol and its lack of a limit", () => {
    expect(planMediaPreview({ remote: false, kind: "image", size: 4 * 1024 * 1024 * 1024 })).toEqual({ mode: "asset" })
    expect(planMediaPreview({ remote: false, kind: "video", size: null })).toEqual({ mode: "asset" })
  })

  test("a phone takes the bytes over the pairing socket", () => {
    expect(planMediaPreview({ remote: true, kind: "image", size: 434_000 })).toEqual({ mode: "socket" })
  })

  test("an unknown size is still asked for, so the Host gives the reason", () => {
    // `media_meta` can be missing a file; the cap is not this side's to enforce,
    // it is only here to skip a request whose answer is already known.
    expect(planMediaPreview({ remote: true, kind: "video", size: null })).toEqual({ mode: "socket" })
  })

  test("a file past the cap is refused before it is asked for", () => {
    const plan = planMediaPreview({ remote: true, kind: "video", size: MAX_REMOTE_PREVIEW_BYTES + 1 })
    expect(plan.mode).toBe("blocked")
    expect(plan.mode === "blocked" && plan.message).toContain("视频")
    expect(plan.mode === "blocked" && plan.message).toContain("24.0 MB")
  })

  test("the cap is inclusive: a file at exactly the limit is sent", () => {
    expect(planMediaPreview({ remote: true, kind: "image", size: MAX_REMOTE_PREVIEW_BYTES })).toEqual({ mode: "socket" })
  })

  test("a refusal names the kind, the size and the limit", () => {
    expect(tooLargeMessage("pdf", 40 * 1024 * 1024)).toBe("PDF 40.0 MB，超过手机预览上限 24.0 MB；请在电脑上查看")
  })
})

describe("decoding what the socket sent", () => {
  test("base64 becomes the bytes it stands for", () => {
    expect([...base64ToBytes("aGk=")]).toEqual([104, 105])
    expect([...base64ToBytes("")]).toEqual([])
  })

  test("bytes that are not text survive the round trip", () => {
    // A JPEG has no characters: the whole reason this path is bytes end to end.
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])
    const encoded = Buffer.from(bytes).toString("base64")
    expect([...base64ToBytes(encoded)]).toEqual([...bytes])
  })

  test("malformed input throws rather than becoming a silent empty image", () => {
    expect(() => base64ToBytes("not base64!!")).toThrow()
  })
})

describe("the cap agrees with the Host", () => {
  test("mirrors media::MAX_REMOTE_MEDIA_BYTES", () => {
    // Two copies of one number, in two languages, with nothing else to keep them
    // in step: if they disagree, a file is either refused here that the Host
    // would have sent, or sent here and refused there.
    const rust = readFileSync("src-tauri/src/media.rs", "utf8")
    const limit = rust.match(/pub const MAX_REMOTE_MEDIA_BYTES: u64 = ([^;]+);/)?.[1]
    expect(limit).toBeDefined()
    const evaluated = limit!
      .split("*")
      .map((part) => Number(part.trim()))
      .reduce((left, right) => left * right, 1)
    expect(evaluated).toBe(MAX_REMOTE_PREVIEW_BYTES)
  })
})

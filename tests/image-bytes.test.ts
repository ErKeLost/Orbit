import { describe, expect, test } from "bun:test";
import { base64ToBlob, base64ToBytes, blobToBase64, bytesToBase64 } from "../src/lib/image-bytes";

describe("image attachment bytes", () => {
  test("round-trips base64 without touching the DOM", () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    expect(bytesToBase64(bytes)).toBe("AAEC/f7/");
    expect(base64ToBytes("AAEC/f7/")).toEqual(bytes);
  });

  test("handles payloads past the fromCharCode chunk boundary", () => {
    // 0x8000 分块：跨块和刚好整块都要对（真实截图是 MB 级）。
    for (const size of [0x8000 - 1, 0x8000, 0x8000 + 1, 200_000]) {
      const bytes = new Uint8Array(size);
      for (let index = 0; index < size; index += 1) bytes[index] = (index * 31) % 256;
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  test("blob helpers keep the mime type", async () => {
    const blob = base64ToBlob("AAEC/f7/", "image/png");
    expect(blob.type).toBe("image/png");
    expect(await blobToBase64(blob)).toBe("AAEC/f7/");
  });
});

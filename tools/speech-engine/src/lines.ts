import type { Readable } from "node:stream"

/**
 * Split stdout on LF only. Node's readline also splits on U+2028/U+2029, which are
 * legal inside a JSON string, and it buffers a whole line before the caller can
 * reject it. Past `maxBytes` without a newline, the rest of that record is discarded.
 */
export function readLfLines(stream: Readable, onLine: (line: string) => void, maxBytes = 8 * 1024 * 1024) {
  let pending = Buffer.alloc(0)
  let skipping = false
  const take = (chunk: Buffer) => {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
    for (;;) {
      const newline = pending.indexOf(0x0a)
      if (skipping) {
        if (newline === -1) {
          pending = Buffer.alloc(0)
          return
        }
        pending = pending.subarray(newline + 1)
        skipping = false
        continue
      }
      if (newline === -1) {
        if (pending.length > maxBytes) {
          skipping = true
          pending = Buffer.alloc(0)
          console.warn(`[pi] dropped a line over ${Math.round(maxBytes / 1024 / 1024)}MB`)
        }
        return
      }
      const line = pending.subarray(0, newline)
      pending = pending.subarray(newline + 1)
      if (line.length > maxBytes) {
        console.warn(`[pi] dropped a ${Math.round(line.length / 1024 / 1024)}MB rpc line`)
        continue
      }
      onLine(line.toString("utf8").replace(/\r$/, ""))
    }
  }
  stream.on("data", take)
}

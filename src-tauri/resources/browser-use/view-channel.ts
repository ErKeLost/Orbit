/** Cross-platform management of native browser identities and session leases.
 * The private browser-home descriptor contains an ephemeral loopback token.
 * Remote webpages cannot open this channel: the host rejects every Origin. */
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { WebSocket } from "ws"

export type ViewStatus = { open: boolean; url: string; visible: boolean; loading: boolean; tab: string; profile?: string | null }
type Reply = { ok: boolean; result?: unknown; error?: string }

export function viewHostPath(): string {
  const root = process.env.ORBIT_BROWSER_HOME?.trim()
  return join(root || join(homedir(), ".pi/agent/browser"), "native-host.json")
}

export async function viewRequest<T = unknown>(request: Record<string, unknown>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T | null> {
  options.signal?.throwIfAborted()
  let host: { url: string; token: string }
  try { host = JSON.parse(await readFile(viewHostPath(), "utf8")) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw new Error("Native browser host descriptor is unreadable", { cause: error })
  }
  const url = new URL(host.url)
  if (url.protocol !== "ws:" || url.hostname !== "127.0.0.1" || url.pathname !== "/control" || typeof host.token !== "string" || !host.token) throw new Error("Invalid native browser endpoint")
  url.searchParams.set("token", host.token)
  options.signal?.throwIfAborted()
  return new Promise<T | null>((resolve, reject) => {
    const socket = new WebSocket(url, { handshakeTimeout: options.timeoutMs ?? 15000, maxPayload: 1024 * 1024 })
    let settled = false
    const finish = (done: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", abort)
      socket.terminate()
      done()
    }
    const abort = () => finish(() => reject(new Error("Native browser request cancelled")))
    const timer = setTimeout(() => finish(() => reject(new Error("Native browser host timed out"))), options.timeoutMs ?? 15000)
    options.signal?.addEventListener("abort", abort, { once: true })
    socket.once("open", () => socket.send(JSON.stringify(request)))
    socket.once("message", raw => {
      try {
        const reply = JSON.parse(raw.toString()) as Reply
        finish(() => reply.ok ? resolve((reply.result ?? null) as T) : reject(new Error(reply.error ?? "Native browser request failed")))
      } catch { finish(() => reject(new Error("Malformed native browser response"))) }
    })
    socket.on("error", error => finish(() => (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? resolve(null) : reject(error)))
    socket.once("close", () => finish(() => resolve(null)))
    if (options.signal?.aborted) abort()
  })
}

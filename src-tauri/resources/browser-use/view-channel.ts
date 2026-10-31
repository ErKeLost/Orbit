/**
 * The column's driving channel, from the agent's side.
 *
 * The view belongs to the app process; the tools belong to Pi. The app serves a
 * unix socket in the browser home (`browser_view::serve`, mode 0600) and every
 * request is one JSON line with one JSON answer. The host keeps a directory of session-owned pages and grants a short lease
 * for each tool call. Evaluations, navigation and input always name that page.
 *
 * Deliberately not HTTP and not a port: this channel can run scripts in a page
 * the user is signed into, so it must be reachable only by the user's own
 * processes — a filesystem permission is a stronger answer than a token.
 */

import { connect, type Socket } from "node:net"
import { homedir } from "node:os"
import { join } from "node:path"

export type ViewStatus = { open: boolean; url: string; visible: boolean; loading: boolean; /** Which tab this describes (the active one when unnamed). */ tab: string }

export function viewSocketPath(): string {
  const root = process.env.ORBIT_BROWSER_HOME?.trim()
  return root ? join(root, "view.sock") : join(homedir(), ".pi/agent/browser/view.sock")
}

type Reply = { ok: boolean; result?: unknown; error?: string }

/**
 * One request. Resolves with the reply's `result`, or `null` when the host
 * is not running. An open host with an empty tab directory is still reachable.
 */
export async function viewRequest<T = unknown>(
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const path = viewSocketPath()
  return new Promise<T | null>((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error("视图通道请求被取消")); return }
    let socket: Socket
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      options.signal?.removeEventListener("abort", abort)
      fn()
    }
    const abort = () => finish(() => reject(new Error("视图通道请求被取消")))
    options.signal?.addEventListener("abort", abort, { once: true })

    socket = connect(path)
    timer = setTimeout(() => finish(() => reject(new Error("视图通道没有响应"))), options.timeoutMs ?? 15_000)
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", chunk => {
      buffer += chunk
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timer)
      const line = buffer.slice(0, newline)
      let reply: Reply
      try {
        reply = JSON.parse(line) as Reply
      } catch {
        finish(() => reject(new Error(`视图通道返回了无法解析的响应：${line.slice(0, 120)}`)))
        return
      }
      if (reply.ok) finish(() => resolve((reply.result ?? null) as T))
      else finish(() => reject(new Error(reply.error ?? "视图通道返回失败")))
    })
    socket.on("error", error => {
      clearTimeout(timer)
      // Missing host is reported to Pi; never fall back to an unrelated browser.
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ECONNREFUSED"
      finish(() => (missing ? resolve(null) : reject(error)))
    })
    socket.on("close", () => {
      clearTimeout(timer)
      finish(() => resolve(null))
    })
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

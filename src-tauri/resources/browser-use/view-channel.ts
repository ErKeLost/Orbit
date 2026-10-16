/**
 * The column's driving channel, from the agent's side.
 *
 * The view belongs to the app process; this loop belongs to Pi. The app serves a
 * unix socket in the browser home (`browser_view::serve`, mode 0600) and every
 * request is one JSON line with one JSON answer. Three operations are all the
 * driver needs: read a page by running a script in it, navigate it, and ask
 * whether there is a view at all.
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
 * One request. Resolves with the reply's `result`, or `null` when there is no
 * view to talk to (the column is closed) — which is a state, not a failure.
 */
export async function viewRequest<T = unknown>(
  request: Record<string, unknown>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<T | null> {
  const path = viewSocketPath()
  return new Promise<T | null>((resolve, reject) => {
    let socket: Socket
    let settled = false
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      socket?.destroy()
      options.signal?.removeEventListener("abort", abort)
      fn()
    }
    const abort = () => finish(() => reject(new Error("视图通道请求被取消")))
    options.signal?.addEventListener("abort", abort, { once: true })

    socket = connect(path)
    const timer = setTimeout(() => finish(() => reject(new Error("视图通道没有响应"))), options.timeoutMs ?? 15_000)
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
      // No socket means no column: the caller falls back to its own browser.
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

/** Whether the column has a page right now. */
export async function viewStatus(): Promise<ViewStatus | null> {
  return viewRequest<ViewStatus>({ op: "status" }, { timeoutMs: 3_000 })
}

/** Run a script in the column's page and return its result. */
export async function viewEval<T = unknown>(script: string, timeoutMs = 10_000): Promise<T | null> {
  return viewRequest<T>({ op: "eval", script, timeoutMs }, { timeoutMs: timeoutMs + 2_000 })
}

export async function viewNavigate(url: string): Promise<void> {
  await viewRequest({ op: "navigate", url })
}

/**
 * Ask the app for a browser tab.
 *
 * A tab, not a rectangle: the pane owns where its page goes. This resolves as
 * soon as the app has been asked; the caller then waits for the tab to appear
 * (`viewStatus`), which is what keeps placement out of the agent's hands.
 */
export async function viewOpen(url: string): Promise<void> {
  await viewRequest({ op: "open", url }, { timeoutMs: 5_000 })
}

/**
 * Click once *through the system* at a point inside a tab's page.
 *
 * A real mouse event, not a synthesized one: a JS-driven control that checks
 * `isTrusted` or calls `window.open` ignores anything a script dispatches, and
 * this is the only honest way around that.
 */
export async function viewClickAt(tab: string, x: number, y: number): Promise<{ x: number; y: number } | null> {
  return viewRequest<{ x: number; y: number }>({ op: "clickAt", tab, x, y }, { timeoutMs: 5_000 })
}


export async function viewClose(tab: string): Promise<void> {
  await viewRequest({ op: "close", tab }, { timeoutMs: 5_000 })
}

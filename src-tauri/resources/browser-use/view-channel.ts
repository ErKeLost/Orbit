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

/**
 * Whether the column has a page right now, and which tab it describes.
 *
 * A tab is named explicitly wherever the caller has one: the channel's default
 * is "whatever is in front", and a run that reads one tab while it clicks another
 * is the bug this parameter exists to prevent.
 */
export async function viewStatus(tab?: string, owner?: string): Promise<ViewStatus | null> {
  return viewRequest<ViewStatus>({ op: "status", ...(tab ? { tab } : {}), ...(owner ? { owner } : {}) }, { timeoutMs: 3_000 })
}

/** Run a script in one tab's page and return its result. */
export async function viewEval<T = unknown>(script: string, options: { tab?: string; timeoutMs?: number; owner?: string } = {}): Promise<T | null> {
  const timeoutMs = options.timeoutMs ?? 10_000
  return viewRequest<T>(
    { op: "eval", script, timeoutMs, owner: options.owner, ...(options.tab ? { tab: options.tab } : {}) },
    { timeoutMs: timeoutMs + 2_000 },
  )
}

/** Navigate one tab. Without a tab the app navigates the active one. */
export async function viewNavigate(url: string, tab?: string, owner?: string): Promise<void> {
  await viewRequest({ op: "navigate", url, owner, ...(tab ? { tab } : {}) })
}

/**
 * Ask the app for the agent's browser tab.
 *
 * A tab, not a rectangle: the pane owns where its page goes. Passing the reserved
 * name `agent` asks for the column's shared agent tab — the app keeps one, so
 * sequential runs navigate the same page (and keep its history) instead of
 * adding a tab per run. The answer says whether that tab is shared: a second
 * concurrent run is given a tab of its own and must close it when it is done.
 *
 * An older app that does not return a tab id answers with `null`; the caller
 * treats that as "ask for a tab and then use the active one".
 */
export async function viewOpen(url: string, tab?: string, claim?: {scope:string;owner:string}): Promise<{ tab: string; shared?: boolean } | null> {
  return viewRequest<{ tab: string; shared?: boolean } | null>({ op: "open", url, ...claim, ...(tab ? { tab } : {}) }, { timeoutMs: 5_000 })
}

/**
 * Give the agent's tab back without closing it.
 *
 * The page, its scroll and its back/forward history stay exactly where the run
 * left them, and the next run continues in this tab. Closing instead is what used
 * to make every task end by taking its page away.
 */
export async function viewRelease(tab: string, owner?: string): Promise<void> {
  await viewRequest({ op: "release", tab, owner }, { timeoutMs: 3_000 })
}

/**
 * Click once *through the system* at a point inside a tab's page.
 *
 * A real mouse event, not a synthesized one: a JS-driven control that checks
 * `isTrusted` or calls `window.open` ignores anything a script dispatches, and
 * this is the only honest way around that.
 */
export async function viewClickAt(tab: string, x: number, y: number, owner?: string): Promise<{ x: number; y: number } | null> {
  return viewRequest<{ x: number; y: number }>({ op: "clickAt", tab, x, y, owner }, { timeoutMs: 5_000 })
}


export async function viewClose(tab: string, owner?: string): Promise<void> {
  await viewRequest({ op: "close", tab, owner }, { timeoutMs: 5_000 })
}

/**
 * Chrome DevTools protocol over Node's own WebSocket — no dependencies.
 *
 * The extension is a Node process, so `WebSocket` and `fetch` are already
 * there. That matters beyond convenience: the driver this file serves is a port
 * of `jev_ultrafast/browser.py`, which talks to Chrome through browser-harness's
 * Python daemon. Keeping the protocol here rather than in Rust means the port
 * stays a transliteration, and the bundled runtime needs no new package.
 *
 * One connection is one *browser* connection. Every call may carry a session
 * id, and events arrive with theirs, because the tab, its popups and the
 * browser itself are different sessions on the same socket.
 */

export type CdpParams = Record<string, unknown>

type Pending = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}

export class CdpError extends Error {
  readonly method: string
  constructor(method: string, detail: { message: string; data?: string }) {
    super(`${method} failed: ${detail.message}${detail.data ? ` (${detail.data})` : ""}`)
    this.name = "CdpError"
    this.method = method
  }
}

export class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly listeners = new Map<string, Set<(params: CdpParams, sessionId?: string) => void>>()
  private readonly socket: WebSocket
  private finished = false
  private readonly finish: () => void
  private readonly done: Promise<void>

  private constructor(socket: WebSocket) {
    this.socket = socket
    let finish = () => {}
    this.done = new Promise<void>(resolve => {
      finish = resolve
    })
    this.finish = finish
    socket.onmessage = event => this.receive(String(event.data))
    socket.onclose = () => this.fail(new Error("浏览器调试连接已关闭"))
    socket.onerror = () => this.fail(new Error("浏览器调试连接出错"))
  }

  static connect(url: string, signal?: AbortSignal): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url)
      const abort = () => {
        socket.close()
        reject(new Error("浏览器调试连接已取消"))
      }
      signal?.addEventListener("abort", abort, { once: true })
      socket.onopen = () => {
        signal?.removeEventListener("abort", abort)
        resolve(new CdpClient(socket))
      }
      socket.onerror = () => {
        signal?.removeEventListener("abort", abort)
        reject(new Error(`无法连接浏览器调试端口 ${url}`))
      }
    })
  }

  get closed(): Promise<void> {
    return this.done
  }

  get isOpen(): boolean {
    return !this.finished && this.socket.readyState === WebSocket.OPEN
  }

  send<T = CdpParams>(method: string, params: CdpParams = {}, options: { sessionId?: string; timeoutMs?: number } = {}): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error("浏览器调试连接已关闭"))
    const id = this.nextId++
    const timeoutMs = options.timeoutMs ?? 20_000
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            if (this.pending.delete(id)) reject(new CdpError(method, { message: `超时（${timeoutMs}ms）` }))
          }, timeoutMs)
        : undefined
      this.pending.set(id, { method, resolve: value => resolve(value as T), reject, timer })
      this.socket.send(JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }))
    })
  }

  on(method: string, handler: (params: CdpParams, sessionId?: string) => void): () => void {
    const group = this.listeners.get(method) ?? new Set()
    group.add(handler)
    this.listeners.set(method, group)
    return () => {
      group.delete(handler)
    }
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) this.socket.close()
    this.fail(new Error("浏览器调试连接已关闭"))
  }

  private receive(text: string): void {
    let message: { id?: number; method?: string; sessionId?: string; params?: CdpParams; result?: unknown; error?: { message: string; data?: string } }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (typeof message.id === "number") {
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (request.timer) clearTimeout(request.timer)
      if (message.error) request.reject(new CdpError(request.method, message.error))
      else request.resolve(message.result ?? {})
      return
    }
    if (!message.method) return
    for (const handler of this.listeners.get(message.method) ?? []) {
      try {
        handler(message.params ?? {}, message.sessionId)
      } catch {
        // A listener must never break the socket loop.
      }
    }
  }

  private fail(error: Error): void {
    this.finished = true
    for (const request of this.pending.values()) {
      if (request.timer) clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.finish()
  }
}

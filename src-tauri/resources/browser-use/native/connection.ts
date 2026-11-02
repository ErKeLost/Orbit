import { randomBytes } from "node:crypto"
import { chromium, type Browser, type Page } from "playwright-core"
import { WebSocket, WebSocketServer } from "ws"
import { createCdpRelayConnection } from "./cdp-relay.ts"
import { PageDriver } from "./page.ts"

export type NativeEndpoint = { url: string; token: string; tab: string; owner: string }
type Lease = { owner: string; stale: boolean }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Protocol adapter only. Chromium's native view owns all rendering and input. */
export class NativePage {
  readonly driver: PageDriver
  private constructor(readonly tab: string, readonly page: Page, private browser: Browser, private socket: WebSocket, private gateway: WebSocketServer, private connections: Set<WebSocket>, private lease: Lease) {
    this.driver = new PageDriver(page)
  }
  get owner() { return this.lease.owner }
  set owner(value: string) { this.lease.owner = value }
  get connected() { return this.browser.isConnected() && this.socket.readyState === WebSocket.OPEN && !this.lease.stale }
  async close() {
    // A browser attached over CDP disconnects here; the native page is owned by
    // Rust and survives the executor's lifetime.
    await this.browser.close().catch(() => undefined)
    await new Promise<void>(done => {
      if (this.socket.readyState === WebSocket.CLOSED) { done(); return }
      const timer = setTimeout(() => { this.socket.terminate(); done() }, 3000)
      this.socket.once("close", () => { clearTimeout(timer); done() })
      this.socket.close()
    })
    for (const connection of this.connections) connection.terminate()
    this.gateway.close()
  }

  static async connect(endpoint: NativeEndpoint, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const address = new URL(endpoint.url)
    if (address.protocol !== "ws:" || address.hostname !== "127.0.0.1") throw new Error("Invalid native Chromium endpoint")
    address.searchParams.set("token", endpoint.token)
    address.searchParams.set("tab", endpoint.tab)
    address.searchParams.set("owner", endpoint.owner)
    const native = new WebSocket(address, { handshakeTimeout: 10000, maxPayload: 8 * 1024 * 1024 })
    const connections = new Set<WebSocket>()
    const lease = { owner: endpoint.owner, stale: false }
    let nextId = 0
    let gateway: WebSocketServer | undefined
    const pending = new Map<number, Pending>()
    const relays = new Set<ReturnType<typeof createCdpRelayConnection>>()
    const fail = () => {
      for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error("Native Chromium page disconnected")) }
      pending.clear()
      for (const connection of connections) connection.terminate()
    }
    const cleanup = () => { native.terminate(); fail(); gateway?.close() }
    signal?.addEventListener("abort", cleanup, { once: true })
    native.on("close", fail)
    native.on("error", fail)
    native.on("message", data => {
      let message: { id?: number; result?: unknown; error?: { message?: string }; method?: string; params?: unknown; sessionId?: string }
      try { message = JSON.parse(data.toString()) } catch { cleanup(); return }
      if (message.id !== undefined) {
        const task = pending.get(message.id)
        if (task) {
          pending.delete(message.id); clearTimeout(task.timer)
          if (message.error) {
            // A frame can appear while no tool holds the operation lease. The
            // native page keeps running; reconnect on the next tool so that
            // Playwright rebuilds any interrupted frame initialization.
            if (message.error.message?.includes("lease has been released")) lease.stale = true
            task.reject(new Error(message.error.message ?? "CDP failed"))
          }
          else task.resolve(message.result)
        }
      } else if (message.method) for (const relay of relays) relay.event(message.method, message.params, message.sessionId)
    })
    try {
      await new Promise<void>((done, reject) => {
        native.once("open", done)
        native.once("error", reject)
        native.once("close", () => reject(new Error("Native Chromium connection closed")))
      })
      const trace = process.env.ORBIT_BROWSER_TRACE === "1"
      const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<unknown>((resolve, reject) => {
        if (native.readyState !== WebSocket.OPEN) { reject(new Error("Native Chromium disconnected")); return }
        if (trace) console.error("[native-cdp] send", method)
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Native CDP timed out: ${method}`)) }, 15000)
        pending.set(id, { resolve, reject, timer })
        // Tool completion must never leave a newly created iframe paused while
        // Playwright waits for the next session lease.
        let nativeMethod = method
        let forwarded = method === "Target.setAutoAttach" ? { ...params, waitForDebuggerOnStart: false } : params
        // Storage cookie methods with browserContextId require a browser-level
        // target. This bridge owns one page: use that page's Network domain.
        if (["Storage.getCookies", "Storage.setCookies", "Storage.clearCookies"].includes(method)) {
          if (params.browserContextId !== undefined && params.browserContextId !== "orbit-native") { pending.delete(id); clearTimeout(timer); reject(new Error("Cookie request is outside this native Profile")); return }
          nativeMethod = ({ "Storage.getCookies": "Network.getAllCookies", "Storage.setCookies": "Network.setCookies", "Storage.clearCookies": "Network.clearBrowserCookies" } as Record<string, string>)[method]!
          const { browserContextId: _context, ...cookieParams } = params
          forwarded = cookieParams
        }
        native.send(JSON.stringify({ id, method: nativeMethod, params: forwarded, ...(sessionId ? { sessionId } : {}), orbitOwner: lease.owner }), error => {
          if (!error) return
          pending.delete(id); clearTimeout(timer); reject(error)
        })
      })
      // Native tabs can be hidden while Pi works. Focus emulation keeps the
      // page's animation frames alive for Playwright's actionability checks.
      await send("Emulation.setFocusEmulationEnabled", { enabled: true })
      const info = await send("Target.getTargetInfo") as { targetInfo: { targetId: string; url: string; title: string; browserContextId?: string } }
      gateway = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false, maxPayload: 1024 * 1024 })
      const ticket = randomBytes(24).toString("hex")
      gateway.on("connection", (socket, request) => {
        if (request.url !== `/${ticket}` || request.headers.origin) { socket.close(4403); return }
        connections.add(socket)
        const relay = createCdpRelayConnection({
          send, targetId: async () => info.targetInfo.targetId,
          url: () => info.targetInfo.url, title: () => info.targetInfo.title,
          userAgent: () => "Chrome/151.0.0.0", setDownloadDirectory: () => {},
        }, message => {
          if (trace) { const value = JSON.parse(message); console.error("[native-cdp] reply", value.id ?? value.method, value.error?.message ?? "") }
          if (socket.readyState === WebSocket.OPEN) socket.send(message)
        })
        relays.add(relay)
        socket.on("error", () => socket.terminate())
        socket.on("message", raw => relay.receive(raw.toString()))
        socket.on("close", () => { relays.delete(relay); connections.delete(socket) })
      })
      await new Promise<void>((done, reject) => {
        if (gateway!.address()) done()
        else { gateway!.once("listening", done); gateway!.once("error", reject) }
      })
      const port = (gateway.address() as { port: number }).port
      const browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}/${ticket}`, { timeout: 10000, noDefaults: true })
      const page = browser.contexts().flatMap(context => context.pages())[0]
      if (!page) { await browser.close(); throw new Error("Native Chromium target did not expose a page") }
      signal?.throwIfAborted()
      return new NativePage(endpoint.tab, page, browser, native, gateway, connections, lease)
    } catch (error) { cleanup(); throw error }
    finally { signal?.removeEventListener("abort", cleanup) }
  }
}

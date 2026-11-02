import { randomUUID } from "node:crypto"
import { NativePage, type NativeEndpoint } from "./native/connection.ts"
import { viewRequest, type ViewStatus } from "./view-channel.ts"

export type NativeConnector=(endpoint:NativeEndpoint,signal?:AbortSignal)=>Promise<Pick<NativePage,"page"|"driver"|"owner"|"connected"|"close">>
type JsonInput = Record<string, unknown>
type TabDirectory = { currentTabId: string | null; tabs: ViewStatus[] }
export type BrowserTransport = <T>(input: JsonInput, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<T | null>

/** A tool executor, not a second agent. The host owns page identity and leases;
 * Pi owns reasoning, task context, recovery and verification. */
export class BrowserService {
  private pages = new Map<string, Awaited<ReturnType<NativeConnector>>>()
  private queues = new Map<string, Promise<unknown>>()
  private transport: BrowserTransport

  constructor(transport: BrowserTransport = viewRequest,private connect:NativeConnector=NativePage.connect) { this.transport = transport }

  async run(scope: string, operation: string, input: JsonInput, signal?: AbortSignal): Promise<unknown> {
    const previous = this.queues.get(scope) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(() => this.execute(scope, operation, input, signal))
    this.queues.set(scope, result)
    try { return await result }
    finally { if (this.queues.get(scope) === result) this.queues.delete(scope) }
  }

  async close(){
    await Promise.allSettled([...this.pages.values()].map(page=>page.close()))
    this.pages.clear()
  }

  private async execute(scope: string, operation: string, input: JsonInput, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    validate(operation, input)
    const directory = await this.transport<TabDirectory>({ op: "tabs", scope }, { signal, timeoutMs: 3000 })
    if (!directory) throw new Error("The browser host is unavailable. Open Orbit desktop and retry.")
    if (operation === "status") return { engine: "chromium-native", ...directory }

    const requested = typeof input.tabId === "string" ? input.tabId : undefined
    if (requested && !directory.tabs.some(tab => tab.tab === requested)) {
      throw new Error("This session does not own that live tab. Read browser_status, or use browser_open to create one.")
    }
    const fresh = operation === "open" && input.reuseExistingTab === false
    if (fresh && requested) throw new Error("Use either tabId or reuseExistingTab=false, not both.")
    const tab = requested ?? (fresh ? undefined : directory.currentTabId ?? undefined)
    if (!tab && operation !== "open") throw new Error("This session has no current browser tab. Call browser_open first.")

    const owner = randomUUID()
    // Existing operations never reopen the panel, allocate a fallback page,
    // or follow whichever tab the person happens to be viewing.
    const opened = await this.transport<{ tab: string }>(tab
      ? { op: "acquire", scope, owner, tab }
      : { op: "open", scope, owner, tab: "agent", newTab: true, url: input.url ?? "" }, { signal, timeoutMs: 8000 }).catch(async error => {
        // The host may have granted control before cancellation/timeout lost
        // the reply. Reclaim only this invocation's lease, even without its id.
        await this.transport({ op: "releaseOwner", scope, owner }, { timeoutMs: 3000 }).catch(() => undefined)
        throw error
      })
    if (!opened?.tab) throw new Error("The browser host did not return a tab.")
    const id = opened.tab
    const send = async <T>(op: string, fields: JsonInput = {}, timeoutMs = 10000) => {
      signal?.throwIfAborted()
      const value = await this.transport<T>({ op, tab: id, owner, ...fields }, { signal, timeoutMs: timeoutMs + 1000 })
      signal?.throwIfAborted()
      return value
    }
    try {
      if (tab && id !== tab) throw new Error("The host returned a different tab; operation cancelled.")
      if (operation === "open" && tab) await send("present")
      let ready: ViewStatus | null = null
      const until = Date.now() + 8000
      do {
        ready = await send<ViewStatus>("status", {}, 3000)
        if (ready?.open) break
        await delay(80, signal)
      } while (Date.now() < until)
      if (!ready?.open) throw new Error("The browser tab did not become ready")

      let native=this.pages.get(id)
      if(native&&!native.connected){await native.close();this.pages.delete(id);native=undefined}
      if(!native){
        const endpoint=await send<NativeEndpoint>("cdp")
        if(!endpoint)throw new Error("Native Chromium automation channel is not ready")
        native=await this.connect(endpoint,signal);this.pages.set(id,native)
      }
      native.owner=owner
      const abort=new AbortController(),cancel=()=>abort.abort()
      signal?.addEventListener("abort",cancel,{once:true})
      try {
        signal?.throwIfAborted()
        if(operation==="open"){
          if(typeof input.url==="string"&&native.page.url()!==input.url)await native.page.goto(input.url,{waitUntil:"domcontentloaded",timeout:15000,signal:abort.signal})
          return {tabId:id,...await native.driver.snapshot(abort.signal)}
        }
        return {tabId:id,...await native.driver.action(operation,input,abort.signal)}
      } finally {signal?.removeEventListener("abort",cancel)}
    } finally {
      // Cleanup is independent of the aborted signal. Releasing control never
      // destroys page state, logins, playback or navigation history.
      await this.transport({ op: "release", tab: id, owner }, { timeoutMs: 3000 }).catch(() => undefined)
    }
  }

}

function validate(operation: string, input: JsonInput) {
  if (input.tabId !== undefined && (typeof input.tabId !== "string" || !input.tabId.trim())) throw new Error("tabId must be nonempty")
  if (operation === "open" || operation === "navigate") {
    if (operation === "navigate" && typeof input.url !== "string") throw new Error("Provide a URL")
    if (input.url !== undefined) {
      const url = new URL(String(input.url))
      if (!["http:", "https:"].includes(url.protocol) && input.url !== "about:blank") throw new Error("Only HTTP(S) or about:blank URLs are supported")
    }
  }
  if (operation === "evaluate" && (typeof input.expression !== "string" || !input.expression.trim() || input.expression.length > 32000)) throw new Error("Provide an expression up to 32000 characters")
  if (operation === "wait_for") {
    if (!input.ref && !input.selector && !input.text && !input.url) throw new Error("Provide a ref, selector, text or URL condition")
    if (input.timeoutMs !== undefined && (typeof input.timeoutMs !== "number" || !Number.isFinite(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 10000)) throw new Error("timeoutMs must be between 100 and 10000")
  }
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}

import { randomUUID } from "node:crypto"
import { pageScript } from "./page-runtime.ts"
import { viewRequest, type ViewStatus } from "./view-channel.ts"

type JsonInput = Record<string, unknown>
type PageReply = { ok: boolean; value?: unknown; error?: string; pending?: boolean }
type TabDirectory = { currentTabId: string | null; tabs: ViewStatus[] }
export type BrowserTransport = <T>(input: JsonInput, options?: { timeoutMs?: number; signal?: AbortSignal }) => Promise<T | null>

/** A tool executor, not a second agent. The host owns page identity and leases;
 * Pi owns reasoning, task context, recovery and verification. */
export class BrowserService {
  private queues = new Map<string, Promise<unknown>>()
  private transport: BrowserTransport

  constructor(transport: BrowserTransport = viewRequest) { this.transport = transport }

  async run(scope: string, operation: string, input: JsonInput, signal?: AbortSignal): Promise<unknown> {
    const previous = this.queues.get(scope) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(() => this.execute(scope, operation, input, signal))
    this.queues.set(scope, result)
    try { return await result }
    finally { if (this.queues.get(scope) === result) this.queues.delete(scope) }
  }

  private async execute(scope: string, operation: string, input: JsonInput, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    validate(operation, input)
    const directory = await this.transport<TabDirectory>({ op: "tabs", scope }, { signal, timeoutMs: 3000 })
    if (!directory) throw new Error("The browser host is unavailable. Open Orbit desktop and retry.")
    if (operation === "status") return { engine: "native", ...directory }

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
    const script = async (code: string): Promise<unknown> => {
      const reply = await send<PageReply>("eval", { script: code, timeoutMs: 10000 })
      if (!reply?.ok) throw new Error(reply?.error ?? "Page evaluation returned no result")
      return reply.value
    }
    const page = (op: string, fields: JsonInput = input) => script(pageScript(op, fields))
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

      if (operation === "open" || operation === "navigate") {
        const url = typeof input.url === "string" ? input.url : undefined
        if (url && ready.url !== url) await send("navigate", { url })
        if ((url ?? ready.url) === "about:blank") return blankSnapshot(id)
        return { tabId: id, ...await page("snapshot") as object }
      }
      if (operation === "snapshot") return ready.url === "about:blank" ? blankSnapshot(id) : { tabId: id, ...await page("snapshot") as object }
      if (operation === "evaluate") return { tabId: id, value: await this.evaluate(String(input.expression), send,
        code => this.transport({ op: "eval", tab: id, owner, script: code, timeoutMs: 500 }, { timeoutMs: 1000 }), signal) }
      if (operation === "wait_for") {
        const deadline = Date.now() + (Number(input.timeoutMs) || 5000)
        do {
          if ((await page("wait") as { matched: boolean }).matched) return { tabId: id, matched: true }
          if (Date.now() >= deadline) break
          await delay(100, signal)
        } while (Date.now() < deadline)
        throw new Error("The requested page condition did not match before the timeout")
      }
      if (operation === "click" && process.platform === "darwin") {
        if (!ready.visible) {
          await send("present")
          const deadline = Date.now() + 3000
          while (!(await send<ViewStatus>("status", {}, 1000))?.visible) {
            if (Date.now() >= deadline) throw new Error("The target tab is not visible; no click was delivered.")
            await delay(50, signal)
          }
        }
        const point = await page("click_point") as { x: number; y: number }
        await send("clickAt", point, 5000)
      } else await page(operation)
      return { tabId: id, delivered: true, note: "Operation delivered. Read browser_snapshot or browser_evaluate to verify its effect." }
    } finally {
      // Cleanup is independent of the aborted signal. Releasing control never
      // destroys page state, logins, playback or navigation history.
      await this.transport({ op: "release", tab: id, owner }, { timeoutMs: 3000 }).catch(() => undefined)
    }
  }

  private async evaluate(expression: string, send: <T>(op: string, fields?: JsonInput, timeoutMs?: number) => Promise<T | null>, cleanup: (script: string) => Promise<unknown>, signal?: AbortSignal) {
    const key = `orbit-eval-${randomUUID()}`
    // Wry callbacks do not await promises. Store a bounded JSON result in the
    // page, and poll just this invocation's key.
    try {
      await send("eval", { script: `(() => {
        const key=${JSON.stringify(key)};
        window[key]={pending:true};
        Promise.resolve().then(()=>(${expression})).then(value=>{
          const json=JSON.stringify(value??null)??"null";
          if(new TextEncoder().encode(json).length>65536)throw new Error("Evaluation result exceeds 64 KB. Return fewer fields.");
          if(Object.hasOwn(window,key))window[key]={ok:true,value:JSON.parse(json)};
        }).catch(error=>{if(Object.hasOwn(window,key))window[key]={ok:false,error:String(error?.message??error)}});
        return null;
      })()`, timeoutMs: 10000 })
      const deadline = Date.now() + 10000
      do {
        const reply = await send<PageReply>("eval", { script: `window[${JSON.stringify(key)}] ?? {ok:false,error:"Page navigated during evaluation"}`, timeoutMs: 1000 }, 1000)
        if (!reply?.pending) {
          if (!reply?.ok) throw new Error(reply?.error ?? "Evaluation returned no result")
          return reply.value ?? null
        }
        await delay(50, signal)
      } while (Date.now() < deadline)
      throw new Error("Page expression timed out after 10 seconds")
    } finally {
      await cleanup(`delete window[${JSON.stringify(key)}]`).catch(() => undefined)
    }
  }
}

function blankSnapshot(tabId: string) {
  return { tabId, url: "about:blank", title: "", readyState: "complete", text: "", elements: [], media: [], frames: [], omitted: 0 }
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

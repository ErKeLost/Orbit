/**
 * The browser driver: observe the page, act on it, never guess a selector.
 *
 * This is a port of `jev_ultrafast/browser.py` (MIT) onto Orbit's own Chrome.
 * The invariants are upstream's and they are the reason this can drive real
 * sites:
 *
 * * Every target is a DOM node the page observer actually saw. The decision
 *   model chooses an element *index*; the driver turns it back into the node
 *   it observed. Model output never becomes a selector, a coordinate, script,
 *   or a command.
 * * Freshness is checked twice — when a decision is made and again immediately
 *   before input, including after text generation — so a stale decision cannot
 *   click whatever moved into that spot.
 * * Input goes through `Input.*`, which produces trusted events; and the target
 *   is re-resolved with `elementFromPoint`, so a control that is covered is
 *   rejected instead of clicked through.
 *
 * The one addition over upstream is how field text arrives: Orbit has no
 * second text model inside the agent loop. Values come from the caller's local
 * text slots (`textSlots`) and the decision model only ever sees their
 * *purposes*, never their values — the same rule `gui_task` follows.
 */

import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { CdpClient } from "./cdp.ts"

/** The page observer, evaluated inside the tab. */
const SNAPSHOT = readFileSync(new URL("./snapshot.js", import.meta.url), "utf8")

/**
 * Why a decision could not be delivered.
 *
 * The engine turns this into the note the decision model reads on its next turn,
 * and the two cases need different advice: a covered target is fixed by removing
 * what is on top of it, a navigating page only needs another look.
 */
export type StaleReason = "changed" | "covered" | "navigating" | "taken-over";

/** A decision that no longer refers to the observed page. */
export class StalePage extends Error {
  readonly reason: StaleReason
  /** What the page said was on top of the target, when it could name it. */
  readonly coverer?: string

  constructor(message: string, reason: StaleReason = "changed", coverer?: string) {
    super(message)
    this.name = "StalePage"
    this.reason = reason
    if (coverer !== undefined) this.coverer = coverer
  }
}

/**
 * The page never reached a state worth deciding about.
 *
 * Distinct from `StalePage` on purpose: nothing was decided and nothing was
 * delivered, so the loop's answer is to wait and read again, not to re-decide
 * an action against a page it has already seen.
 */
export class PageBusy extends Error {
  constructor(message = "页面一直没有读完（可能正在加载或渲染阻塞）") {
    super(message)
    this.name = "PageBusy"
  }
}

/** The tab (or popup) this run was driving is gone and nothing can replace it. */
export class DetachedTarget extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DetachedTarget"
  }
}

/**
 * One console argument as a short string.
 *
 * `Runtime.consoleAPICalled` reports remote objects, not values: a logged string
 * arrives as `value`, a logged number as `value`, a logged object only as a
 * description. Quoting the description's first line is enough to recognise
 * "Uncaught TypeError: cannot read properties of undefined" — which is the whole
 * reason these lines are collected.
 */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return ""
  return args
    .map(arg => {
      const remote = arg as { value?: unknown; description?: string; unserializableValue?: string }
      if (typeof remote.value === "string") return remote.value
      if (remote.value !== undefined) return JSON.stringify(remote.value)
      if (typeof remote.unserializableValue === "string") return remote.unserializableValue
      if (typeof remote.description === "string") return remote.description.split("\n")[0] ?? ""
      return "?"
    })
    .join(" ")
    .slice(0, 400)
}

export type BrowserKind = "click" | "fill" | "select" | "scroll" | "wait"

/** One observed control the model may choose, exactly as the page reports it. */
export type BrowserAction = {
  id: string
  kind: BrowserKind
  node?: number
  label: string
  value?: string
  delta?: number
  role?: string
  rect?: { x: number; y: number; w: number; h: number }
  checked?: string
  selected?: string
  expanded?: string
  current_value?: string
  /** The control is outside the viewport: nothing can be delivered until the
   * page scrolls, and the observer keeps it so the model can decide to scroll. */
  offscreen?: boolean
  /** Something else sits over the control's centre; a click would land on that
   * instead. Reported during observation, not only refused at input time. */
  covered?: boolean
  /** A readable description of the covering element, when the observer has one. */
  covered_by?: string
  /**
   * The control lives in a same-origin frame. `rect` is still in top-level
   * pixels, which is what input dispatch needs, but an overlay inside the frame
   * cannot be hit-tested from here — so the model is told where the control is
   * instead of being refused later without an explanation.
   */
  frame?: boolean
  /**
   * The page draws this field's value as dots (`-webkit-text-security`, OTP and
   * card widgets). `value` carries the dots; the real value stays out of the
   * decision context and is kept in `raw` only so the loop can still tell that a
   * field already holds the value it would type.
   */
  masked?: boolean
  raw?: string
  /** Filled in by `actionSpace`, not by the page. */
  options?: { index: string; label: string; value: string }[]
}

export type BrowserObservation = {
  url: string
  title: string
  w: number
  h: number
  text: string
  /**
   * What the page reported about itself since the previous observation: console
   * errors, uncaught exceptions, 4xx/5xx responses, failed loads. Absent when
   * nothing new happened, which is the common case.
   */
  errors?: string[]
  scroll: { y: number; height: number }
  actions: BrowserAction[]
  marker: unknown
  page_key: unknown
  guards: Record<string, unknown>
  omitted_actions: number
  fingerprint: string
  /** An optional accessibility outline (Chrome path only). Never a replacement
   * for `actions`: the element table stays the contract. */
  aria?: string
}

/** Mirror of the Rust session file (`browser.rs`). */
export type BrowserSession = {
  port: number
  targetId: string
  url: string
  pid: number
  executable: string
  startedAt: number
  browserVersion: string
  browserWs: string
  userAgent: string
}

/** Where the session file lives. Mirrors `browser::browser_dir` in Rust,
 * including the `ORBIT_BROWSER_HOME` override that keeps a test run away from
 * the profile the user's own browser column uses. */
export function sessionPath(): string {
  const root = process.env.ORBIT_BROWSER_HOME?.trim()
  return root ? join(root, "session.json") : join(homedir(), ".pi/agent/browser/session.json")
}

function readSessionFile(): BrowserSession | null {
  try {
    const text = readFileSync(sessionPath(), "utf8")
    const parsed = JSON.parse(text) as BrowserSession
    return parsed && typeof parsed.port === "number" && parsed.targetId ? parsed : null
  } catch {
    return null
  }
}

/** A port in the session file that no longer answers is not a running browser. */
async function isAlive(session: BrowserSession): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${session.port}/json/version`, { signal: AbortSignal.timeout(700) })
    return response.ok
  } catch {
    return false
  }
}

/**
 * Start Chrome through the app binary, or reuse the one the dock already
 * started. The launch flags live in Rust (`browser.rs`) so the column and the
 * agent can never disagree about how the browser runs.
 */
export async function ensureBrowser(url: string | undefined, signal?: AbortSignal): Promise<BrowserSession> {
  const binary = process.env.ORBIT_APP_BINARY?.trim()
  if (binary) {
    const started = await runHelper(binary, url, signal)
    if (started.session) return started.session
    // A browser that was already up is still usable even if the launcher said
    // something: the launcher is the only thing that knows *why* it failed, and
    // that reason travels with the error.
    const existing = readSessionFile()
    if (existing && (await isAlive(existing))) return existing
    throw new Error(`无法启动浏览器内核：${started.error ?? "启动器没有返回会话"}`)
  }
  const existing = readSessionFile()
  if (existing && (await isAlive(existing))) return existing
  throw new Error("无法启动浏览器：ORBIT_APP_BINARY 未设置。请在 Orbit 中运行浏览器任务，或先在浏览器栏里手动打开一个页面")
}

function runHelper(binary: string, url: string | undefined, signal?: AbortSignal): Promise<{ session: BrowserSession | null; error?: string }> {
  return new Promise(resolve => {
    const args = ["--browser-ensure", ...(url ? ["--url", url] : [])]
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], signal })
    let out = ""
    let error = ""
    child.stdout?.on("data", chunk => {
      out += String(chunk)
    })
    child.stderr?.on("data", chunk => {
      error += String(chunk)
    })
    child.on("error", spawnError => resolve({ session: null, error: spawnError.message }))
    child.on("close", code => {
      const reason = error.trim().split("\n")[0]
      if (code !== 0) {
        if (reason) process.stderr.write(`[browser] ${reason}\n`)
        resolve({ session: null, error: reason ?? `启动器退出码 ${code ?? "signal"}` })
        return
      }
      try {
        resolve({ session: JSON.parse(out.trim()) as BrowserSession })
      } catch {
        resolve({ session: null, error: "启动器返回了无法解析的会话" })
      }
    })
  })
}

/**
 * One CDP session on the tab Orbit owns. The column may hold another session on
 * the same tab at the same time: Chrome allows several clients, which is what
 * lets a user watch (and take over) while the agent works.
 */
export class BrowserDriver {
  private readonly client: CdpClient
  /**
   * Every target this run has attached to, oldest first. The last entry is the
   * page `send` talks to. A popup the page opens is pushed on top (that is
   * "following" it); when it detaches the run drops back to the page that
   * opened it instead of sending into a dead session.
   */
  private readonly stack: { sessionId: string; targetId: string }[] = []
  private readonly session: BrowserSession
  /** Set by the last non-wait action: the settle read happens in `observe`. */
  private afterInput: BrowserAction | null = null
  private closed = false
  /** Set when every attached target is gone; every later send fails with it. */
  private detached?: string
  /**
   * A `confirm()`/`alert()` the page opened and that was dismissed for it.
   *
   * An open JavaScript dialog blocks the renderer, so every `Runtime.evaluate`
   * after it hangs until the socket times out — the run appeared to freeze for
   * no reason at all. Dismissing it is what keeps the loop able to see the page;
   * the notice travels with the next observation so the model learns that
   * something on the page asked a question (and that the answer was "no").
   */
  private dialogNotice: string | null = null
  /**
   * Errors the page reported about itself, newest last.
   *
   * Bounded, deduplicated by text, and delivered *once*: they are the evidence a
   * decision is missing when a click produces nothing visible, and repeating the
   * same eight lines on every turn would spend the observation budget on noise.
   */
  private pageProblems: { seq: number; text: string }[] = []
  private problemSeq = 0
  private reportedProblemSeq = 0

  /** The engine this driver reports in the run's metrics. */
  readonly engine = "chrome" as const

  private constructor(client: CdpClient, sessionId: string, session: BrowserSession) {
    this.client = client
    this.stack.push({ sessionId, targetId: session.targetId })
    this.session = session
  }

  static async open(url: string | undefined, signal?: AbortSignal): Promise<BrowserDriver> {
    const session = await ensureBrowser(url, signal)
    const client = await CdpClient.connect(`ws://127.0.0.1:${session.port}${session.browserWs}`, signal)
    // Auto-attach applies to targets that already exist, not only to new ones.
    // Without this baseline, every other tab in this browser looks like a popup
    // the page just opened, and the run would start driving a tab nobody asked
    // it to touch — which is exactly what happened once the column kept its own
    // tab open next to the task's.
    const existing = await client.send<{ targetInfos: { targetId: string }[] }>("Target.getTargets")
    const known = new Set(existing.targetInfos.map(info => info.targetId))
    const attached = await client.send<{ sessionId: string }>("Target.attachToTarget", { targetId: session.targetId, flatten: true })
    const driver = new BrowserDriver(client, attached.sessionId, session)
    // A page that opens a window (login flows, target="_blank") would otherwise
    // run in a tab nobody is attached to. Auto-attach with
    // `waitForDebuggerOnStart` is what makes the new tab arrive paused, so it
    // becomes this run's page *before* its own script runs.
    //
    // The listener is registered first on purpose: auto-attach also applies to
    // this tab, and pausing a target pauses it for every session — including
    // the one this driver is using. Resuming that session immediately is what
    // keeps the first `Runtime.evaluate` from hanging forever.
    const stops: Array<() => void> = []
    const detach = client.on("Target.attachedToTarget", params => {
      const info = params.targetInfo as { targetId?: string; type?: string } | undefined
      const sessionId = params.sessionId ? String(params.sessionId) : undefined
      if (!sessionId || info?.type !== "page" || !info.targetId) return
      if (known.has(info.targetId)) {
        // A tab that was already open. It is paused by `waitForDebuggerOnStart`
        // like everything else auto-attach reaches, so it must be released —
        // and then left alone.
        known.add(info.targetId)
        void client.send("Runtime.runIfWaitingForDebugger", {}, { sessionId }).catch(() => undefined)
        return
      }
      known.add(info.targetId)
      // Follow the tab the page opened, exactly as a browser would.
      void driver.follow({ sessionId, targetId: info.targetId }).catch(() => undefined)
    })
    // A popup that closes takes its session with it. Without this the run keeps
    // sending into a session that no longer exists and fails the whole task; the
    // right answer is to fall back to the page that opened it.
    const detached = client.on("Target.detachedFromTarget", params => {
      const sessionId = params.sessionId ? String(params.sessionId) : undefined
      if (sessionId) driver.onDetached(sessionId)
    })
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    for (const stop of await BrowserDriver.watchPage(client, driver)) stops.push(stop)
    void client.closed.then(() => {
      detach()
      detached()
      for (const stop of stops) stop()
    })
    // `session.url` is a record of intent, not of fact. The session file is
    // shared by every run and every Orbit instance, and `ensure` closes the tab
    // it replaced — so the tab attached to above can be a page nobody asked for,
    // or one another run swapped out a moment ago. Ask the tab where it actually
    // is; that is the only answer that cannot be stale.
    //
    // The comparison is origin + path (+ query): a blank tab is wrong, and so is
    // the right host on the wrong page — requesting `/login` while the shared tab
    // sat on the same site's `/` used to skip the navigation and start the run on
    // the wrong page. The cost is one extra navigation when a site's own redirect
    // lands somewhere else, which is cheaper than driving the wrong page.
    if (url) {
      const landed = await driver.evaluate("location.href").catch(() => null)
      if (typeof landed !== "string" || landed === "about:blank" || !sameLocation(landed, url)) await driver.navigate(url)
    }
    // A freshly created tab is still loading when the helper returns, and a
    // single-page app finishes drawing its controls after `load` has already
    // fired. Waiting here means the first decision is about the real page.
    await driver.settle()
    return driver
  }

  /**
   * Watch what the page says about itself.
   *
   * Two things, and they answer the same question — "why did nothing happen":
   *
   * * a JavaScript dialog **blocks the renderer**, so an open one stalls every
   *   later `Runtime.evaluate` until the socket times out, which reads as a
   *   frozen run. It is dismissed and reported, never left open;
   * * console errors, uncaught exceptions, 4xx/5xx responses and failed loads,
   *   which a DOM-only observer cannot see at all: it sees a page that stopped
   *   changing, not the 500 that stopped it.
   *
   * Scoped to the session being driven. Auto-attach makes the browser emit
   * events for every tab, and another tab's failing analytics request must not
   * change a decision here. Returns the disposers so `open` can stop watching.
   */
  private static async watchPage(client: CdpClient, driver: BrowserDriver): Promise<Array<() => void>> {
    const drives = (sessionId?: string): boolean =>
      sessionId !== undefined && driver.stack[driver.stack.length - 1]?.sessionId === sessionId
    // The domains are what make the events arrive; a control that only reads the
    // DOM would never see any of them. Best effort: an older Chrome refusing one
    // loses a signal, not the run.
    for (const domain of ["Page", "Runtime", "Log", "Network"]) {
      await driver.send(`${domain}.enable`).catch(() => undefined)
    }
    return [
      client.on("Page.javascriptDialogOpening", (params, sessionId) => {
        if (!drives(sessionId)) return
        const type = String(params.type ?? "dialog")
        const message = String(params.message ?? "").trim()
        driver.dialogNotice = message ? `${type}：${message}` : type
        void driver.send("Page.handleJavaScriptDialog", { accept: false }).catch(() => undefined)
      }),
      client.on("Runtime.consoleAPICalled", (params, sessionId) => {
        const level = String(params.type ?? "")
        if (!drives(sessionId)) return
        if (level !== "error" && level !== "warning" && level !== "assert") return
        driver.notePageProblem(`${level}: ${consoleText(params.args)}`, sessionId)
      }),
      client.on("Runtime.exceptionThrown", (params, sessionId) => {
        if (!drives(sessionId)) return
        const details = params.exceptionDetails as
          | { text?: string; exception?: { description?: string } }
          | undefined
        const message = details?.exception?.description?.split("\n")[0] ?? details?.text ?? ""
        driver.notePageProblem(`未捕获异常: ${message}`, sessionId)
      }),
      client.on("Log.entryAdded", (params, sessionId) => {
        if (!drives(sessionId)) return
        const entry = params.entry as { level?: string; text?: string; url?: string } | undefined
        if (entry?.level !== "error" && entry?.level !== "warning") return
        driver.notePageProblem(`${entry.level}: ${entry.text ?? ""}${entry.url ? ` (${entry.url})` : ""}`, sessionId)
      }),
      client.on("Network.responseReceived", (params, sessionId) => {
        if (!drives(sessionId)) return
        const response = params.response as { status?: number; url?: string } | undefined
        const status = Number(response?.status ?? 0)
        // 3xx is a page doing its job; 4xx/5xx is the page explaining itself.
        if (!Number.isFinite(status) || status < 400) return
        driver.notePageProblem(`HTTP ${status} ${response?.url ?? ""}`, sessionId)
      }),
      client.on("Network.loadingFailed", (params, sessionId) => {
        if (!drives(sessionId)) return
        const errorText = String(params.errorText ?? "")
        // A cancelled load is what a normal SPA navigation produces.
        if (!errorText || errorText === "net::ERR_ABORTED") return
        driver.notePageProblem(`请求失败: ${errorText}`, sessionId)
      }),
    ]
  }

  /** Move this driver onto another tab (a popup) and let it run. */
  private async follow(target: { sessionId: string; targetId: string }): Promise<void> {
    this.stack.push(target)
    await this.send("Runtime.runIfWaitingForDebugger").catch(() => undefined)
    await this.send("Page.enable").catch(() => undefined)
  }

  /**
   * A target this run was attached to has gone.
   *
   * If it was the page on top (a popup the page opened, since closed), the run
   * falls back to the page that opened it — which is still the same session. If
   * the original page detached too, there is nothing left to drive and every
   * later call fails with `DetachedTarget` instead of driving some other tab.
   */
  private onDetached(sessionId: string): void {
    const index = this.stack.findIndex(entry => entry.sessionId === sessionId)
    if (index < 0) return
    const wasCurrent = index === this.stack.length - 1
    this.stack.splice(index, 1)
    if (this.stack.length === 0) this.detached = "本次运行驱动的浏览器标签页已经关闭"
    else if (wasCurrent) this.afterInput = null
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const current = this.stack[this.stack.length - 1]
    if (!current || this.detached) return Promise.reject(new DetachedTarget(this.detached ?? "本次运行驱动的浏览器标签页已经关闭"))
    return this.client.send<T>(method, params, { sessionId: current.sessionId, ...(timeoutMs ? { timeoutMs } : {}) })
  }

  private async evaluate(expression: string, options: { awaitPromise?: boolean } = {}): Promise<unknown> {
    const response = await this.send<{ exceptionDetails?: { text?: string; exception?: { description?: string } }; result?: { value?: unknown } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      ...(options.awaitPromise ? { awaitPromise: true } : {}),
    })
    if (response.exceptionDetails) {
      // Same disposition as upstream — nothing was executed, so the caller
      // observes again — but the reason travels with it. A guard evaluation
      // that failed inside the page is otherwise indistinguishable from a
      // navigation, and that is exactly the case a run has to be able to report.
      const detail = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown error"
      throw new StalePage(`页面内求值失败：${String(detail).split("\n")[0]}`)
    }
    return response.result?.value
  }

  /**
   * Wait until the tab has committed a real page.
   *
   * A new tab reports `complete` for `about:blank` well before the requested
   * address is committed, and `about:blank` still yields one control (the
   * trailing wait entry) — so neither "document complete" nor "some controls"
   * means "the page is up". `observe` keeps re-reading until it sees a page
   * that is neither blank nor empty, which is the condition that matters.
   */
  private async settle(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    // Step one: the requested address must have been committed.
    while (Date.now() < deadline) {
      const href = await this.evaluate("location.href").catch(() => null)
      if (typeof href === "string" && href && href !== "about:blank") break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    // Step two: the document must be complete *and* have drawn controls — a
    // single-page app paints its form after `load` has already fired.
    while (Date.now() < deadline) {
      const page = await this.observe().catch(() => null)
      if (page && page.actions.some(action => action.kind !== "wait")) return
      await new Promise(resolve => setTimeout(resolve, 150))
    }
  }

  private async navigate(url: string): Promise<void> {
    await this.send("Page.navigate", { url })
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await this.evaluate("document.readyState") === "complete") return
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }

  /** Read the page's controls and text in one atomic pass. */
  async observe(): Promise<BrowserObservation> {
    if (this.afterInput) {
      const action = this.afterInput
      this.afterInput = null
      // Read-only, and it happens after execution was logged: a navigation that
      // interrupts this must not erase the action that caused it.
      await this.send("Runtime.evaluate", {
        expression: `(action => new Promise(resolve => {
          const field = window.__jevFast?.nodes.get(action.node);
          const autocomplete = action.kind === 'fill' && field?.getAttribute('role') === 'combobox';
          let frames = 0, stopped = false;
          const finish = () => { stopped = true; resolve() };
          // Autocomplete suggestions arrive from the network: the window has to
          // be long enough for a cold one (measured ~1s on Google Flights) and
          // it still ends the moment a visible option shows up. A field that
          // genuinely has no suggestions pays this, which is why it only
          // applies where the page itself declares a combobox.
          setTimeout(finish, autocomplete ? 600 : 50);
          const ready = () => {
            if (stopped) return;
            const ids = (field?.getAttribute('aria-controls') || field?.getAttribute('aria-owns') || '')
              .split(/\\s+/).filter(Boolean);
            const roots = ids.length ? ids.map(id => document.getElementById(id)).filter(Boolean) : [document];
            const options = roots.flatMap(root => [...root.querySelectorAll('[role="option"]')]);
            if (++frames >= 2 && (!autocomplete || options.some(e => {
              const r = e.getBoundingClientRect();
              return r.width && r.height && r.bottom > 0 && r.top < innerHeight &&
                e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
            }))) finish();
            else requestAnimationFrame(ready);
          };
          requestAnimationFrame(ready);
        }))(${JSON.stringify(action)})`,
        awaitPromise: true,
        returnByValue: true,
      }).catch(() => undefined)
    }
    let last: BrowserObservation | undefined
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        last = await this.read()
      } catch (error) {
        if (!(error instanceof StalePage) || attempt === 11) throw error
        await new Promise(resolve => setTimeout(resolve, 20))
        continue
      }
      // Two states are not a page yet: an uncommitted tab (`about:blank`) and a
      // document whose controls have not been painted. Re-reading is cheap next
      // to a decision made about a blank screen.
      const ready = last.url !== "about:blank" && last.actions.some(action => action.kind !== "wait")
      if (ready || attempt === 11) return await this.withAria(last)
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    if (!last) throw new PageBusy("页面一直没有读完（可能正在加载或渲染阻塞）")
    return last
  }

  /**
   * Report a dialog the page opened or an error it logged, once each.
   *
   * Both are prepended to the page text rather than carried as new fields: the
   * text is what the element table and the decision prompt already include, so
   * the notice reaches the model without touching the contract with the View
   * path. The fingerprint was taken before this, so a notice does not read as a
   * change.
   */
  private decorate<T extends { text: string; errors?: string[] }>(page: T): T {
    const problems = this.takePageProblems()
    if (!this.dialogNotice && problems === undefined) return page
    const notice = this.dialogNotice ? `【页面弹窗】${this.dialogNotice}（已自动取消）` : null
    this.dialogNotice = null
    return {
      ...page,
      text: notice ? `${notice}\n${page.text}` : page.text,
      ...(problems ? { errors: problems } : {}),
    }
  }

  /**
   * Record one page-reported problem for the page this run is driving.
   *
   * A session filter rather than a tab filter: auto-attach means the browser
   * also emits events for tabs this run is not driving, and another tab's
   * failing analytics request is not a reason to change a decision here.
   */
  private notePageProblem(text: string, sessionId?: string): void {
    const current = this.stack[this.stack.length - 1]
    if (!current || !sessionId || sessionId !== current.sessionId) return
    const clean = text.replace(/\s+/g, " ").trim().slice(0, 200)
    if (!clean) return
    // The same error often repeats (a retry loop, a broken asset on every
    // navigation): the newest copy is the one worth keeping.
    this.pageProblems = [...this.pageProblems.filter(entry => entry.text !== clean), { seq: ++this.problemSeq, text: clean }].slice(-8)
  }

  /** The problems recorded since the last observation, or `undefined` when none. */
  private takePageProblems(): string[] | undefined {
    const fresh = this.pageProblems.filter(entry => entry.seq > this.reportedProblemSeq)
    if (fresh.length === 0) return undefined
    this.reportedProblemSeq = fresh[fresh.length - 1]!.seq
    return fresh.map(entry => entry.text)
  }

  private async read(): Promise<BrowserObservation> {
    const state = await this.evaluate(SNAPSHOT) as Omit<BrowserObservation, "fingerprint"> | null
    if (state === null) {
      // The document exists but has no body to read: an uncommitted tab, or a
      // navigation in flight. Reported as an empty page so the readiness loop
      // in `observe` can wait for it instead of failing the run.
      const href = await this.evaluate("location.href").catch(() => "")
      return this.decorate({
        url: typeof href === "string" ? href : "",
        title: "",
        w: 0,
        h: 0,
        text: "",
        scroll: { y: 0, height: 0 },
        actions: [],
        marker: null,
        page_key: null,
        guards: {},
        omitted_actions: 0,
        fingerprint: "empty",
      })
    }
    if (typeof state !== "object") throw new StalePage("页面正在导航（document 还没就绪），请稍后再看", "navigating")
    return this.decorate({ ...state, fingerprint: fingerprint(state) })
  }

  /**
   * Attach an accessibility outline to an observation.
   *
   * The element table stays the contract — it is what the decision model picks
   * indices from, and it is the contract with the View path. This is *added*
   * structure for the same page, taken from Chrome's own AX tree, so roles,
   * names and states survive even where `snapshot.js`'s fixed selector does not
   * recognise a control. It is bounded, best-effort, and never fatal: a failed
   * read simply leaves the observation without it.
   */
  private async withAria(page: BrowserObservation): Promise<BrowserObservation> {
    const aria = await this.ariaOutline().catch(() => "")
    return aria ? { ...page, aria } : page
  }

  private async ariaOutline(): Promise<string> {
    const result = await this.send<{ nodes?: AxNode[] }>("Accessibility.getFullAXTree")
    const nodes = (result.nodes ?? []).filter(node => !node.ignored && node.role?.value && node.nodeId)
    if (!nodes.length) return ""
    const byId = new Map(nodes.map(node => [node.nodeId!, node]))
    const children = new Map<string, AxNode[]>()
    const roots: AxNode[] = []
    for (const node of nodes) {
      const parent = node.parentId ? byId.get(node.parentId) : undefined
      if (!parent) {
        roots.push(node)
        continue
      }
      const list = children.get(parent.nodeId!) ?? []
      list.push(node)
      children.set(parent.nodeId!, list)
    }
    const lines: string[] = []
    let chars = 0
    const walk = (node: AxNode, depth: number): void => {
      if (lines.length >= 400 || chars >= 6_000) return
      const role = node.role?.value ?? "?"
      const name = (node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120)
      const states: string[] = []
      for (const property of node.properties ?? []) {
        const value = property.value?.value
        if (value === undefined || value === null || value === false || value === "") continue
        if (["checked", "selected", "expanded", "disabled", "required", "invalid", "focused", "pressed", "value"].includes(property.name)) {
          states.push(`${property.name}=${String(value).slice(0, 80)}`)
        }
      }
      const line = `${"  ".repeat(Math.min(depth, 12))}${role}${name ? ` "${name}"` : ""}${states.length ? ` [${states.join(", ")}]` : ""}`
      lines.push(line)
      chars += line.length + 1
      for (const child of children.get(node.nodeId!) ?? []) walk(child, depth + 1)
    }
    for (const root of roots) walk(root, 0)
    return lines.join("\n")
  }

  /** Is this decision still about the page in front of us? */
  async fresh(page: BrowserObservation, action?: BrowserAction): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      const node = action.node
      if (typeof node !== "number") return false
      const current = await this.evaluate(`(() => { const c = window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${node}))] : null; })()`)
      if (!current) return false
      const [pageKey, guard] = current as [unknown, unknown]
      return stable(pageKey) === stable(page.page_key) && stable(guard) === stable(page.guards[String(node)])
    }
    return stable(await this.evaluate(`(() => { const state = ${SNAPSHOT}; return state?.marker ?? null; })()`)) === stable(page.marker)
  }

  /** Execute one observed target. Throws `StalePage` when nothing was delivered. */
  async act(action: BrowserAction, page: BrowserObservation, text?: string): Promise<void> {
    // A missing action is a bug in the loop, not a page condition: failing here
    // is the difference between a clear error and a silent no-op.
    if (!action || typeof action.kind !== "string") throw new Error("没有可执行的目标（内部错误）")
    if (!(await this.fresh(page, action))) throw new StalePage("页面在决策之后已经变化，请重新观察")
    if (action.kind === "wait") {
      await new Promise(resolve => setTimeout(resolve, 100))
      return
    }
    if (action.kind === "scroll") {
      // Upstream scrolls at a fixed point; the viewport center is the same idea
      // without a magic coordinate that a narrower page would miss.
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: Math.round((page.w || 1120) / 2),
        y: Math.round((page.h || 780) / 2),
        deltaX: 0,
        deltaY: action.delta ?? 0,
      })
      this.afterInput = action
      return
    }
    if (typeof action.node !== "number") throw new Error("观察到的目标节点无效")
    // Resolve the node again, in the page, immediately before input: it must
    // still be connected, enabled, visible, on screen, and not covered. Every
    // refusal names itself, because "this is unclickable" is much less useful to
    // a decision model than "a cookie banner is on top of it".
    type Delivery =
      | { x: number; y: number }
      | { blocked: { reason: "gone" | "readonly" | "offscreen" | "covered"; coverer?: string } }
      | null
    const delivered = await this.evaluate(`(action => {
      const named = e => (e.getAttribute('aria-label') || e.innerText || '').trim().replace(/\\s+/g,' ').slice(0, 40) || e.tagName.toLowerCase();
      const e = window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return { blocked: { reason: 'gone' } };
      if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return { blocked: { reason: 'readonly' } };
      // The dispatch happens in top-level pixels, so an element inside a frame
      // needs its ancestors' offsets added. The chain is that walk, kept because
      // the coverage test needs the outermost frame element too.
      const chain = [];
      let rect = e.getBoundingClientRect(), win = e.ownerDocument.defaultView, guard = 0;
      while (win && win !== window && guard++ < 4) {
        const frame = win.frameElement;
        if (!frame) break;
        chain.push(frame);
        const outer = frame.getBoundingClientRect();
        rect = { x: rect.x + outer.x, y: rect.y + outer.y, width: rect.width, height: rect.height };
        win = frame.ownerDocument.defaultView;
      }
      const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
      if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { blocked: { reason: 'offscreen' } };
      const at = document.elementFromPoint(x, y);
      // From the top document, everything inside a frame resolves to the frame
      // itself. A point that lands on this element's outermost frame is inside
      // the frame, not under an overlay.
      const owned = chain.length > 0 && at === chain[chain.length - 1];
      if (!owned && !e.contains(at)) return { blocked: { reason: 'covered', coverer: at ? named(at) : '' } };
      if (action.kind === 'select') {
        if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
            !o.disabled && !o.closest('optgroup[disabled]'))) return { blocked: { reason: 'gone' } };
        e.value = action.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
        // A controlled (React/Vue) select re-renders and restores its own value.
        // Reading the value back is what separates "selected" from "submit sent";
        // without it the loop logs success for a value that never took.
        if (e.value !== action.value) return { blocked: { reason: 'gone' } };
      }
      return { x, y };
    })(${JSON.stringify(action)})`) as Delivery
    if (delivered === null || "blocked" in delivered) {
      if (action.kind === "select") throw new Error("下拉框执行未获确认，请先观察再重试")
      const blocked = delivered !== null && "blocked" in delivered ? delivered.blocked : { reason: "gone" as const }
      if (blocked.reason === "covered") {
        throw new StalePage(
          `目标被「${blocked.coverer || "另一个元素"}」遮住了：先关掉它再重新观察`,
          "covered",
          blocked.coverer || undefined,
        )
      }
      if (blocked.reason === "offscreen") throw new StalePage("目标已经滚出屏幕，请重新观察", "changed")
      if (blocked.reason === "readonly") throw new StalePage("这个字段变成了只读，写不进去了", "changed")
      throw new StalePage("目标已变化，请重新观察", "changed")
    }
    const target = delivered
    if (action.kind === "select") {
      this.afterInput = action
      return
    }
    for (const type of ["mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", { type, x: target.x, y: target.y, button: "left", clickCount: 1 })
    }
    if (action.kind === "fill") {
      const modifier = process.platform === "darwin" ? 4 : 2
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", modifiers: modifier, commands: ["selectAll"] })
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", modifiers: modifier })
      if (text) await this.send("Input.insertText", { text })
    }
    this.afterInput = action
  }

  /** A PNG of the viewport. Reserved for the image-grounded path (Box questions). */
  async screenshot(): Promise<string> {
    const shot = await this.send<{ data: string }>("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    return shot.data
  }

  get target(): BrowserSession {
    return this.session
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.client.close()
  }
}

/** One node of Chrome's accessibility tree, as `Accessibility.getFullAXTree`
 * returns it (only the fields the outline reads). */
type AxNode = {
  nodeId?: string
  parentId?: string
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
}

/** Upstream's fingerprint: the parts of an observation that mean "same page". */
export function fingerprint(state: Pick<BrowserObservation, "url" | "text" | "actions" | "scroll">): string {
  const content = {
    url: state.url,
    text: state.text,
    actions: state.actions.map(({ rect: _rect, ...action }) => action),
    scroll: state.scroll,
  }
  return createHash("sha256").update(stable(content)).digest("hex")
}

/**
 * Whether two addresses name the same page, for "did I land where I asked".
 *
 * Origin + path (+ query), with the trailing slash ignored: the same host on a
 * different path is a different page, and treating it as "close enough" is how a
 * run used to start on `/` when the goal asked for `/login`. A site's own
 * redirect to a slightly different path costs one extra navigation, which is the
 * accepted price of never driving the wrong page.
 */
export function sameLocation(left: string, right: string): boolean {
  const a = landingTarget(left)
  const b = landingTarget(right)
  return a !== null && a === b
}

function landingTarget(raw: string): string | null {
  try {
    const url = new URL(raw)
    const path = url.pathname.replace(/\/+$/, "")
    return `${url.origin}${path}${url.search}`
  } catch {
    return null
  }
}

/** Key-sorted JSON, the equivalent of Python's `sort_keys=True`. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
  })
}

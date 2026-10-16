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

/** A decision that no longer refers to the observed page. */
export class StalePage extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StalePage"
  }
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
  /** Filled in by `actionSpace`, not by the page. */
  options?: { index: string; label: string; value: string }[]
}

export type BrowserObservation = {
  url: string
  title: string
  w: number
  h: number
  text: string
  scroll: { y: number; height: number }
  actions: BrowserAction[]
  marker: unknown
  page_key: unknown
  guards: Record<string, unknown>
  omitted_actions: number
  fingerprint: string
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
  private sessionId: string
  private readonly session: BrowserSession
  /** Set by the last non-wait action: the settle read happens in `observe`. */
  private afterInput: BrowserAction | null = null
  private closed = false

  private constructor(client: CdpClient, sessionId: string, session: BrowserSession) {
    this.client = client
    this.sessionId = sessionId
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
      void driver.follow(sessionId).catch(() => undefined)
    })
    await client.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
    void client.closed.then(() => detach())
    // `ensureBrowser` already opened the tab at the requested address, so a
    // navigation here would only restart a load in flight. It is needed in the
    // fallback path, where the browser was already showing something else.
    if (url && session.url !== url) await driver.navigate(url)
    // A freshly created tab is still loading when the helper returns, and a
    // single-page app finishes drawing its controls after `load` has already
    // fired. Waiting here means the first decision is about the real page.
    await driver.settle()
    return driver
  }

  /** Move this driver onto another tab (a popup) and let it run. */
  private async follow(sessionId: string): Promise<void> {
    this.sessionId = sessionId
    await this.send("Runtime.runIfWaitingForDebugger").catch(() => undefined)
    await this.send("Page.enable").catch(() => undefined)
  }

  private send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    return this.client.send<T>(method, params, { sessionId: this.sessionId, ...(timeoutMs ? { timeoutMs } : {}) })
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
      if (ready || attempt === 11) return last
      await new Promise(resolve => setTimeout(resolve, 150))
    }
    if (!last) throw new StalePage("页面没有稳定下来")
    return last
  }

  private async read(): Promise<BrowserObservation> {
    const state = await this.evaluate(SNAPSHOT) as Omit<BrowserObservation, "fingerprint"> | null
    if (state === null) {
      // The document exists but has no body to read: an uncommitted tab, or a
      // navigation in flight. Reported as an empty page so the readiness loop
      // in `observe` can wait for it instead of failing the run.
      const href = await this.evaluate("location.href").catch(() => "")
      return {
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
      }
    }
    if (typeof state !== "object") throw new StalePage("Document is navigating")
    return { ...state, fingerprint: fingerprint(state) }
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
    // still be connected, enabled, visible, on screen, and not covered.
    const target = await this.evaluate(`(action => {
      const e = window.__jevFast?.nodes.get(action.node);
      if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
          !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return null;
      if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return null;
      const r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return null;
      if (!e.contains(document.elementFromPoint(x, y))) return null;
      if (action.kind === 'select') {
        if (e.tagName !== 'SELECT' || ![...e.options].some(o => o.value === action.value &&
            !o.disabled && !o.closest('optgroup[disabled]'))) return null;
        e.value = action.value;
        e.dispatchEvent(new Event('input', { bubbles: true }));
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { x, y };
    })(${JSON.stringify(action)})`) as { x: number; y: number } | null
    if (!target) {
      if (action.kind === "select") throw new Error("下拉框执行未获确认，请先观察再重试")
      throw new StalePage("目标已变化或被遮挡，请重新观察")
    }
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

/** Key-sorted JSON, the equivalent of Python's `sort_keys=True`. */
export function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item
    const record = item as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]))
  })
}

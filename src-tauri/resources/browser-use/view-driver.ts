/**
 * Driving the column's own view.
 *
 * This is the same driver contract as `browser-driver.ts` (`BrowserDriverLike`),
 * on a different transport: instead of the DevTools protocol against a Chrome
 * this process does not own, every step is a script run inside the view the user
 * is looking at (`view-channel.ts` → the app).
 *
 * What that buys: the agent works in the page the user sees, on the screen, in
 * the same session the user is signed into. What it costs, honestly:
 *
 * * **Events are synthesized.** `dispatchEvent` runs the site's handlers, and
 *   React/Vue sites respond, but a page that inspects `event.isTrusted` (some
 *   Google flows) will ignore them. CDP's `Input.*` produces trusted input and
 *   is why the Chrome path exists; the fallback for a site like that is Orbit's
 *   physical input route, not this file.
 * * **No CDP niceties**: no screencast, no dialogs interception, no `Fetch`
 *   interception — the view is the browser, not a protocol endpoint.
 *
 * The invariants are unchanged and are the reason this can drive real sites:
 * every target is a node the page observer actually saw (`snapshot.js` keeps the
 * real nodes in `window.__jevFast`), the node is re-resolved and hit-tested
 * immediately before input, and a stale decision never clicks whatever moved
 * under it.
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { fingerprint, sameLocation, StalePage, stable, type BrowserAction, type BrowserObservation } from "./browser-driver.ts"
import { viewClickAt, viewEval, viewNavigate, viewOpen, viewRelease, viewStatus } from "./view-channel.ts"

/** The page observer, evaluated inside the view. */
const SNAPSHOT = readFileSync(new URL("./snapshot.js", import.meta.url), "utf8")

/** The reserved name of the column's shared agent tab (`browser_view.rs`). */
const AGENT_TAB = "agent"
const READY_DEADLINE_MS = 20_000
const OPEN_DEADLINE_MS = 8_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export class ViewDriver {
  private closed = false
  /** The engine this driver reports in the run's metrics. */
  readonly engine = "view" as const
  /**
   * Trusted inputs the user made in this tab, as the page counted them.
   *
   * The user shares this web view: they can click, type and scroll in the very
   * tab this run drives, and a decision made a second earlier may now be aimed
   * at something they moved. Synthetic events this driver dispatches are not
   * trusted, so `isTrusted` counts exactly the human. `0` means the counter is
   * not installed (a fresh document after navigation), which is not evidence of
   * anything and never raises a refusal.
   */
  private observedInput = 0

  private constructor(private url: string, private tab: string, private owner: string, private signal?: AbortSignal) {}

  /**
   * Ask the app for the column's agent tab, then drive only that tab.
   *
   * The tab is named in every request, so a run cannot read one page while
   * clicking another, and cannot navigate the page the user is reading. It is the
   * *same* tab from one run to the next (the app hands it out as long as no other
   * run holds it), which is what keeps a page — and its back/forward history —
   * across tasks instead of putting a tab in the strip for each one.
   */
  static async open(url: string | undefined, signal?: AbortSignal, scope = "default"): Promise<ViewDriver> {
    const asked = url?.trim()
    // Scope/site identity survives the run. Concurrent runs receive distinct pages.
    if (signal?.aborted) throw new Error("浏览器任务已取消")
    const owner = randomUUID()
    const opened = await viewOpen(asked ?? "", AGENT_TAB, {scope,owner})
    const tab = opened?.tab?.trim() ?? ""
    if (!tab) throw new Error("浏览器没有返回确定的目标页面，请重连后重试")
    const target = asked || undefined
    try {
      // The app generated an id; wait for that exact tab to have a view.
      let ready = false
      const deadline = Date.now() + OPEN_DEADLINE_MS
      while (Date.now() < deadline) {
        const current = await viewStatus(tab, owner)
        if (current?.open) {
          ready = true
          break
        }
        await sleep(200)
        signal?.throwIfAborted()
      }
      if (!ready) {
        // The claim must not outlive this attempt: the tab never appeared, so
        // holding it would make the next run take a private tab for no reason.
        throw new Error(`浏览器标签页 ${tab} 没有在应用里出现`)
      }
    const driver = new ViewDriver(target ?? "", tab, owner, signal)
    // The app opens the tab at the requested address; a blank or wrong landing
    // gets the task's address. This goes through the tab we own, never through
    // "active", so a tab the user switched to is not what gets navigated.
    if (target) {
      const landed = await viewStatus(tab, owner)
      if (!landed?.url || landed.url === "about:blank" || !sameLocation(landed.url, target)) {
        await viewNavigate(target, tab, owner)
        await sleep(300)
      }
    }
    signal?.throwIfAborted()
    await driver.settle()
    signal?.throwIfAborted()
    return driver
    } catch (error) {
      await viewRelease(tab, owner).catch(() => undefined)
      throw error
    }
  }

  /**
   * Whether the app (and therefore its browser tabs) is reachable at all.
   *
   * Not "is a tab open": a run with no tab gets one opened for it, and the app
   * being up is what makes the view the right engine to drive.
   */
  static async available(): Promise<boolean> {
    return (await viewStatus().catch(() => null)) !== null
  }

  private send<T = unknown>(script: string, timeoutMs?: number): Promise<T | null> {
    if (this.closed) return Promise.resolve(null)
    return viewEval<T>(script, { owner: this.owner, ...(this.tab ? { tab: this.tab } : {}), ...(timeoutMs ? { timeoutMs } : {}) })
  }

  /** Wait until the document is complete and the page has painted something. */
  private async settle(): Promise<void> {
    const initial = await viewStatus(this.tab, this.owner)
    if (initial?.open && initial.url === "about:blank") { this.url = initial.url; return }
    const deadline = Date.now() + READY_DEADLINE_MS
    while (Date.now() < deadline) {
      const ready = await this.send<string>("document.readyState").catch(() => null)
      if (ready === "complete") {
        const status = await viewStatus(this.tab, this.owner)
        if (status?.open && status.url === "about:blank") { this.url = status.url; return }
        break
      }
      await sleep(60)
    }
    let last: BrowserObservation | null = null
    let problem: unknown
    while (Date.now() < deadline) {
      try {
        last = await this.observe()
      } catch (error) {
        // Keep the reason: a tab that was closed mid-open must report why, not
        // a generic "never settled".
        problem = error
        last = null
      }
      if (last && (last.actions.some(action => action.kind !== "wait") || last.text.trim().length > 0)) {
        this.url = last.url
        return
      }
      await sleep(150)
    }
    if (!last) throw new Error(`第三栏的页面没有稳定下来：${problem instanceof Error ? problem.message : "未知原因"}`)
  }

  async observe(): Promise<BrowserObservation> {
    const status = await viewStatus(this.tab, this.owner)
    if (status?.open && status.url === "about:blank") {
      // about:blank is already a complete browser state. WebKit need not emit
      // a network load event for it; waiting for a page body would never finish.
      const blank: BrowserObservation = { url: status.url, title: "", w: 0, h: 0, text: "", scroll: { y: 0, height: 0 }, actions: [], marker: [this.tab, status.url], page_key: [this.tab, status.url], guards: {}, omitted_actions: 0, fingerprint: "" }
      return { ...blank, fingerprint: fingerprint(blank) }
    }
    // Re-installed on every observation because navigation drops it. The script
    // is guarded, so on an unchanged document this costs one no-op evaluation.
    await this.installUserWatch().catch(() => undefined)
    this.observedInput = await this.userInputCount().catch(() => this.observedInput)
    const raw = await this.send<BrowserObservation>(SNAPSHOT, 20_000)
    if (!raw || typeof raw !== "object") throw new StalePage("页面没有返回可读状态")
    return { ...raw, fingerprint: fingerprint(raw) }
  }

  /** Count trusted user input in this document, exactly once per document. */
  private installUserWatch(): Promise<unknown> {
    return this.send(
      `(() => {
        if (typeof window.__orbitUserEpoch === "number") return "ready";
        window.__orbitUserEpoch = 0;
        const bump = event => { if (event.isTrusted) window.__orbitUserEpoch += 1 };
        for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) {
          addEventListener(name, bump, { capture: true, passive: true });
        }
        return "installed";
      })()`,
    )
  }

  private async userInputCount(): Promise<number> {
    const value = await this.send<unknown>("window.__orbitUserEpoch ?? 0")
    return typeof value === "number" ? value : 0
  }

  /**
   * Is this decision still about the page in front of us?
   *
   * Same two comparisons as the Chrome driver, run inside the page: the click
   * guard compares the target and its scope, the terminal guard compares the
   * whole marker.
   */
  async fresh(page: BrowserObservation, action?: BrowserAction): Promise<boolean> {
    if (action && (action.kind === "click" || action.kind === "select")) {
      const node = action.node
      if (typeof node !== "number") return false
      const current = await this.send<[unknown, unknown]>(
        `(() => { const c = window.__jevFast; return c ? [c.pageKey(), c.guard(c.nodes.get(${node}))] : null; })()`,
      ).catch(() => null)
      if (!current) return false
      return stable(current[0]) === stable(page.page_key) && stable(current[1]) === stable(page.guards[String(node)])
    }
    const marker = await this.send<unknown>(
      `(() => { const c = window.__jevFast; if (c) c.skipGuards = true; try { return (${SNAPSHOT})?.marker ?? null } finally { if (c) c.skipGuards = false } })()`,
    ).catch(() => null)
    return stable(marker) === stable(page.marker)
  }

  /** Execute one observed target. Throws `StalePage` when nothing was delivered. */
  async act(action: BrowserAction, page: BrowserObservation, text?: string): Promise<void> {
    this.signal?.throwIfAborted()
    if (!action || typeof action.kind !== "string") throw new Error("没有可执行的目标（内部错误）")
    if (action.kind === "wait") {
      await new Promise(resolve => setTimeout(resolve, 150))
      return
    }
    if (action.kind === "scroll") {
      await this.send(`window.scrollBy({ top: ${Math.round(action.delta ?? 0)}, behavior: "instant" }); null`)
      return
    }
    if (typeof action.node !== "number") throw new Error("观察到的目标节点无效")
    // The user is allowed to be in this page. Acting on top of their typing is
    // the same class of mistake as acting on a page that moved, and is reported
    // as its own reason so the next decision knows to wait rather than retry.
    const inputs = await this.userInputCount().catch(() => this.observedInput)
    if (inputs !== 0 && inputs !== this.observedInput) {
      throw new StalePage("用户刚刚在这个标签页上操作过，先让开，重新观察后再继续", "taken-over")
    }
    if (!(await this.fresh(page, action))) throw new StalePage("页面在决策之后已经变化，请重新观察")
    this.signal?.throwIfAborted()
    if (action.kind === "click" && this.tab && process.platform === "darwin") {
      // Trusted first: a real mouse event at the point, through the system. The
      // scripted click below only runs when that path is unavailable, because a
      // JS-driven control ignores synthesized events.
      const point = await this.send<{ x: number; y: number } | null>(viewClickPointScript(action.node))
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new StalePage("点击目标已变化或被遮挡，请重新观察")
      this.signal?.throwIfAborted()
      // An injection error can occur after mouse-down. Replaying a synthetic
      // click here could activate the same control twice.
      const clicked = await viewClickAt(this.tab, point.x, point.y, this.owner)
      if (!clicked) throw new Error("浏览器点击通道已断开，无法确认点击结果")
      return
    }
    // The action runs *in the page*: same node identity check, same occlussion
    // test, and the events a real click would produce.
    const outcome = await this.send<{ ok: boolean; reason?: string }>(viewActionScript(action, text ?? null), 20_000)
    if (!outcome?.ok) {
      // An interrupted dropdown is an uncertain mutation: stop, never retry.
      if (outcome?.reason === "select-unconfirmed") throw new Error("下拉框执行未获确认，请先观察再重试")
      if (outcome?.reason === "fill-unconfirmed") throw new Error("输入内容未获确认，请先观察字段当前内容再重试")
      throw new StalePage(outcome?.reason === "covered" ? "目标被遮挡，请重新观察" : "目标已变化，请重新观察")
    }
    this.url = page.url
  }

  get currentUrl(): string {
    return this.url
  }

  /** Release this run's control; the user's page stays open. */
  close(): void {
    if (this.closed) return
    this.closed = true
    if (!this.tab) return
    // The page outlives the run, including concurrent runs. Only the user's close action destroys it.
    void viewRelease(this.tab, this.owner).catch(() => undefined)
  }
}

/** Resolve and hit-test in the target's document, then return top-level CSS pixels. */
export const viewClickPointScript = (node: number): string => `(() => {
  const e = window.__jevFast?.nodes.get(${JSON.stringify(node)});
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return null;
  e.scrollIntoView({block:'center',inline:'center'});
  const r = e.getBoundingClientRect();
  let x = r.x + r.width / 2, y = r.y + r.height / 2;
  if (!r.width || !r.height) return null;
  let target = e, doc = e.ownerDocument;
  for (let depth = 0; depth < 5; depth++) {
    const hit = doc.elementFromPoint(x,y);
    if (!hit || !(target === hit || target.contains(hit))) return null;
    if (doc === document) return {x,y};
    const frame = doc.defaultView?.frameElement;
    if (!frame) return null;
    const outer = frame.getBoundingClientRect();
    x += outer.x + frame.clientLeft; y += outer.y + frame.clientTop;
    target = frame; doc = frame.ownerDocument;
  }
  return null;
})()`

/**
 * One action, as a script.
 *
 * `elementFromPoint` before input is what stops a covered control from being
 * clicked, and the whole thing returns a small status instead of a value: the
 * caller only needs to know whether anything was delivered.
 */
export const viewActionScript = (action: BrowserAction, text: string | null): string => `((action, text) => {
  const fail = reason => ({ ok: false, reason });
  const e = window.__jevFast?.nodes.get(action.node);
  if (!e || !e.isConnected) return fail('stale');
  const doc = e.ownerDocument, win = doc.defaultView;
  if (e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]')) return fail('disabled');
  const style = win.getComputedStyle(e);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return fail('hidden');
  if (action.kind === 'fill' && (e.readOnly || e.getAttribute('aria-readonly') === 'true')) return fail('readonly');
  // Scroll first, then measure, then hit-test and dispatch — all against one set
  // of coordinates. Measuring before scrollIntoView produced a point that
  // described where the element used to be, and every event landed there.
  e.scrollIntoView({ block: 'center', inline: 'center' });
  const r = e.getBoundingClientRect();
  const x = r.x + r.width / 2;
  const y = r.y + r.height / 2;
  if (!r.width || !r.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return fail('offscreen');
  const at = doc.elementFromPoint(x, y);
  if (!at || !(e === at || e.contains(at))) return fail('covered');

  const fire = (node, type, extra = {}) => node.dispatchEvent(new win.MouseEvent(type, {
    bubbles: true, cancelable: true, composed: true, view: win,
    clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0, ...extra,
  }));

  if (action.kind === 'select') {
    const ok = e.tagName === 'SELECT' && [...e.options].some(o => o.value === action.value && !o.disabled && !o.closest('optgroup[disabled]'));
    if (!ok) return fail('select-unconfirmed');
    e.value = action.value;
    e.dispatchEvent(new win.Event('input', { bubbles: true }));
    e.dispatchEvent(new win.Event('change', { bubbles: true }));
    // Read back: a controlled (React/Vue) select re-renders and restores its own
    // value, and reporting success for a value that did not stick is a false
    // step. "Unconfirmed" makes the caller observe again instead.
    if (e.value !== action.value) return fail('select-unconfirmed');
    return { ok: true };
  }

  if (typeof e.focus === 'function') e.focus({ preventScroll: true });
  // A real click targets the *deepest* element at the point and lets the event
  // bubble; activation (a link's navigation, a button's default action) then runs
  // for the nearest activatable ancestor. Dispatching on the observed wrapper
  // instead — and never sending the click event itself — is why a synthesized
  // click did nothing.
  const hit = doc.elementFromPoint(x, y) || e;
  if (action.kind === 'click') {
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      fire(hit, type);
    }
  } else {
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      fire(hit, type);
    }
  }

  if (action.kind === 'fill' && text !== null) {
    if (e.isContentEditable) {
      const selection = win.getSelection();
      const range = doc.createRange(); range.selectNodeContents(e);
      selection?.removeAllRanges(); selection?.addRange(range);
      const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text);
      if (!inserted) {
        e.textContent = text;
        e.dispatchEvent(new win.InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
      }
      return (e.innerText ?? e.textContent ?? '').trim() === text.trim() ? {ok:true} : fail('fill-unconfirmed');
    }
    const setValue = value => {
      const proto = e.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(e, value); else e.value = value;
      e.dispatchEvent(new win.Event('input', { bubbles: true }));
      e.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    if (typeof e.select === 'function') e.select();
    // insertText is the closest thing to typing: it goes through the same
    // input pipeline, so autocomplete and validation react to it.
    const inserted = typeof doc.execCommand === 'function' && doc.execCommand('insertText', false, text);
    if (!inserted || (e.value ?? '').trim() !== text.trim()) setValue(text);
    return (e.value ?? '').trim() === text.trim() ? {ok:true} : fail('fill-unconfirmed');
  }
  return { ok: true };
})(${JSON.stringify(action)}, ${text === null ? "null" : JSON.stringify(text)})`

import type { Page, Locator } from "playwright-core"
import type { CDPSession } from "playwright-core"
import { assignRefs, frameSnapshotText, identityMismatch, inspectTarget, observeTree, rewriteRefs, type RefEntry } from "./refs.ts"

export type Input = Record<string, unknown>

/** A page can run an infinite script or return a Promise that never settles.
 * Abort the protocol request and terminate executing JS before releasing its queue. */
const terminators = new WeakMap<Page, Promise<CDPSession>>()
function terminator(page: Page) {
  let pending = terminators.get(page)
  if (!pending) {
    pending = page.context().newCDPSession(page).catch(error => {
      terminators.delete(page)
      throw error
    })
    terminators.set(page, pending)
  }
  return pending
}

export async function boundedEvaluation<T>(page:Page,work:()=>Promise<T>,signal?:AbortSignal,timeout=8000):Promise<T> {
  signal?.throwIfAborted()
  // One session for the page, reused. Attaching and detaching on every snapshot
  // cost more than the read itself.
  const session=await terminator(page)
  let timer:ReturnType<typeof setTimeout>|undefined,aborted=false
  let termination:Promise<unknown>|undefined
  let reject!: (error:Error)=>void
  const stopped=new Promise<never>((_resolve,fail)=>{reject=fail})
  const abort=()=>{
    if(aborted)return
    aborted=true
    termination=session.send("Runtime.terminateExecution").catch(()=>{
      terminators.delete(page)
    }).finally(()=>reject(signal?.aborted?new Error("Browser evaluation cancelled"):new Error("Browser evaluation timed out")))
  }
  signal?.addEventListener("abort",abort,{once:true})
  timer=setTimeout(abort,timeout)
  try {
    if(signal?.aborted){abort();return await stopped}
    return await Promise.race([work(),stopped])
  } catch(error) {
    if(aborted)throw new Error(signal?.aborted?"Browser evaluation cancelled":"Browser evaluation timed out")
    throw error
  } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);await termination}
}
export class PageDriver {
  private generation = 0
  private nextRef = 1
  private refs = new Map<string, RefEntry>()
  constructor(readonly page: Page) {
    page.on("framenavigated", () => this.invalidate())
    page.on("framedetached", () => this.invalidate())
  }
  invalidate() { this.generation++; this.refs.clear() }

  async target(input: Input, optional = false) {
    const ref = typeof input.ref === "string" ? input.ref.replace(/^aria-ref=/, "") : ""
    if (ref) {
      const entry = this.refs.get(ref)
      if (!entry) throw new Error("Stale element reference. Read a new browser_snapshot after navigation or a changed control.")
      return { locator: this.page.locator(`aria-ref=${entry.native}`), identity: entry.identity }
    }
    if (typeof input.selector === "string") {
      // Playwright resolves open shadow roots; a selector must still identify exactly one target.
      const locator = this.page.locator(input.selector)
      if (await locator.count() !== 1) throw new Error("Selector must identify exactly one observed element")
      return { locator, identity: null }
    }
    if (optional) return undefined
    throw new Error("Pass an observed ref or a unique selector")
  }

  private async confirm(target: { locator: Locator; identity: string | null }, signal: AbortSignal) {
    if (!target.identity) return
    signal.throwIfAborted()
    const changed = await target.locator.evaluate(identityMismatch as unknown as (element: HTMLElement, identity: string | null) => string | null, target.identity, { timeout: 2000, signal })
    if (changed) throw new Error(changed)
  }

  private async reachable(target: { locator: Locator; identity: string | null }, signal: AbortSignal) {
    signal.throwIfAborted()
    await target.locator.scrollIntoViewIfNeeded({ timeout: 8000, signal })
    const blocked = await target.locator.evaluate(inspectTarget as unknown as (element: HTMLElement, identity: string | null) => string | null, target.identity, { timeout: 2000, signal })
    if (blocked) throw new Error(blocked)
  }

  async snapshot(signal?: AbortSignal, attempt=0):Promise<Record<string,unknown>> {
    const generation = this.generation
    const tree = await this.page.ariaSnapshot({ mode: "ai", timeout: 8000, signal })
    signal?.throwIfAborted()
    if (generation !== this.generation) {
      if(attempt<2)return this.snapshot(signal,attempt+1)
      throw new Error("Page changed while taking snapshot. Read it again.")
    }
    const main = this.page.mainFrame()
    const frames = await boundedEvaluation(this.page,()=>Promise.all(this.page.frames().map(async frame => {
      try {
        const read = await frame.evaluate(() => ({
          text: (document.body?.innerText ?? "").slice(0,4000),
          media: [...document.querySelectorAll<HTMLMediaElement>("video,audio")].slice(0,30).map(m => ({kind:m.tagName.toLowerCase(),paused:m.paused,ended:m.ended,currentTime:m.currentTime,duration:Number.isFinite(m.duration)?m.duration:null,readyState:m.readyState,muted:m.muted,error:m.error?{code:m.error.code,message:m.error.message}:null})),
          secrets: [...document.querySelectorAll<HTMLInputElement>("input,textarea")].filter(e => e.type === "password" || /disc|circle|square/.test(getComputedStyle(e).getPropertyValue("-webkit-text-security"))).map(e => e.value).filter(Boolean),
        }))
        return { ...read, main: frame === main }
      } catch { return { text: "", media: [], secrets: [], main: frame === main } }
    })),signal)
    const secrets = frames.flatMap(frame => frame.secrets)
    const mask = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[hidden]"), text)
    const masked = mask(tree)
    if (generation !== this.generation) {
      if (attempt < 2) return this.snapshot(signal, attempt + 1)
      throw new Error("Page changed while taking snapshot. Read it again.")
    }
    const assigned = assignRefs(this.refs, observeTree(masked), this.nextRef)
    this.refs = assigned.refs
    this.nextRef = assigned.nextId
    return {
      url: this.page.url(), title: await this.page.title(),
      accessibilityTree: rewriteRefs(masked, assigned.publicOf).slice(0, 40000),
      text: mask(frameSnapshotText(frames)),
      frames: this.page.frames().map(frame => ({url:frame.url(),name:frame.name()})),
      media: frames.flatMap(frame => frame.media), viewport: this.page.viewportSize(),
    }
  }

  async action(operation: string, input: Input, signal: AbortSignal) {
    signal.throwIfAborted()
    const timeout = 8000
    if (operation === "snapshot") return this.snapshot(signal)
    if (operation === "evaluate") {
      if (typeof input.expression !== "string" || !input.expression.trim() || input.expression.length > 32000) throw new Error("Provide a JavaScript expression up to 32000 characters")
      const json = await boundedEvaluation(this.page,()=>this.page.evaluate(expression => {
        const encode=(value:unknown)=>{
          const result=JSON.stringify(value??null)
          if(new TextEncoder().encode(result).byteLength>65536)throw new Error("Evaluation result exceeds 64 KB")
          return result
        }
        return Promise.resolve(globalThis.eval(expression)).then(encode)
      }, input.expression as string),signal)
      return {value:JSON.parse(json)}
    }
    if (operation === "navigate") {
      const url = validateUrl(input.url)
      await this.page.goto(url, {waitUntil:"domcontentloaded",timeout:15000,signal})
      return this.snapshot(signal)
    }
    if (operation === "wait_for") {
      if (!input.ref && !input.selector && !input.text && !input.url) throw new Error("Provide a ref, selector, text or URL condition")
      const wait = Number(input.timeoutMs ?? 5000)
      if (!Number.isFinite(wait) || wait < 100 || wait > 10000) throw new Error("timeoutMs must be between 100 and 10000")
      if (input.url) await this.page.waitForURL(url => url.href.includes(String(input.url)), {timeout:wait,signal})
      if (input.text) await this.page.getByText(String(input.text), {exact:false}).first().waitFor({state:"visible",timeout:wait,signal})
      const target = await this.target(input,true)
      if (target) await target.locator.waitFor({state:"visible",timeout:wait,signal})
      return {matched:true}
    }
    if (operation === "scroll") {
      const target = await this.target(input,true)
      if (target) await target.locator.hover({timeout,signal})
      await this.page.mouse.wheel(Number(input.deltaX)||0,Number(input.deltaY)||0)
      return {delivered:true}
    }
    const target = await this.target(input, operation === "press")
    signal.throwIfAborted()
    if (operation === "click") {
      await this.reachable(target!, signal)
      // An alert keeps Playwright's click pending until it is answered. Return
      // at the dialog so the next tool can inspect and resolve it.
      let opened!:()=>void
      const dialog=new Promise<void>(done=>{opened=done})
      this.page.once("dialog",opened)
      const clicked=target!.locator.click({timeout,signal})
      try {await Promise.race([clicked,dialog])}finally{this.page.off("dialog",opened);void clicked.catch(()=>undefined)}
    }
    else if (operation === "hover") {
      await this.reachable(target!, signal)
      await target!.locator.hover({timeout,signal})
    }
    else if (operation === "type") {
      if (typeof input.text !== "string") throw new Error("text must be a string")
      await this.confirm(target!, signal)
      if (input.clear !== false) await target!.locator.fill(input.text,{timeout,signal})
      else { await target!.locator.focus({timeout,signal}); signal.throwIfAborted(); await this.page.keyboard.insertText(input.text) }
    } else if (operation === "press") {
      if (typeof input.key !== "string") throw new Error("Provide a key")
      if (target) { await this.confirm(target, signal); await target.locator.press(input.key,{timeout,signal}) }
      else await this.page.keyboard.press(input.key)
    } else if (operation === "select") {
      await this.confirm(target!, signal)
      await target!.locator.selectOption(typeof input.value === "string" ? {value:input.value} : {label:String(input.label)}, {timeout,signal})
    } else throw new Error(`Unsupported browser operation: ${operation}`)
    return {delivered:true,note:"Operation delivered. Read browser_snapshot to verify the result."}
  }
}
export function validateUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("Provide a URL")
  const url = new URL(value)
  if (!["http:","https:"].includes(url.protocol) && value !== "about:blank") throw new Error("Only HTTP(S) or about:blank URLs are supported")
  return url.href
}

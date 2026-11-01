import type { Page, Locator } from "playwright-core"
import { randomUUID } from "node:crypto"

export type Input = Record<string, unknown>

/** A page can run an infinite script or return a Promise that never settles.
 * Abort the protocol request and terminate executing JS before releasing its queue. */
export async function boundedEvaluation<T>(page:Page,work:()=>Promise<T>,signal?:AbortSignal,timeout=8000):Promise<T> {
  signal?.throwIfAborted()
  const session=await page.context().newCDPSession(page)
  let timer:ReturnType<typeof setTimeout>|undefined,aborted=false
  let termination:Promise<unknown>|undefined
  let reject!: (error:Error)=>void
  const stopped=new Promise<never>((_resolve,fail)=>{reject=fail})
  const abort=()=>{
    if(aborted)return
    aborted=true
    termination=session.send("Runtime.terminateExecution").catch(()=>undefined).finally(()=>reject(signal?.aborted?new Error("Browser evaluation cancelled"):new Error("Browser evaluation timed out")))
  }
  signal?.addEventListener("abort",abort,{once:true})
  timer=setTimeout(abort,timeout)
  try {
    if(signal?.aborted){abort();return await stopped}
    return await Promise.race([work(),stopped])
  } catch(error) {
    if(aborted)throw new Error(signal?.aborted?"Browser evaluation cancelled":"Browser evaluation timed out")
    throw error
  } finally {clearTimeout(timer);signal?.removeEventListener("abort",abort);await termination;await session.detach().catch(()=>undefined)}
}
export class PageDriver {
  private generation = randomUUID()
  private refs = new Map<string, { native: string; signature: string }>()
  constructor(readonly page: Page) {
    page.on("framenavigated", () => this.invalidate())
    page.on("framedetached", () => this.invalidate())
  }
  invalidate() { this.generation = randomUUID(); this.refs.clear() }

  private signature(locator: Locator) {
    return locator.evaluate(e => JSON.stringify([e.tagName, e.getAttribute("role"), e.getAttribute("href"), e.getAttribute("aria-label"), e.textContent?.replace(/\s+/g," ").trim().slice(0,220), (e as HTMLInputElement).value, (e as HTMLInputElement).checked]), undefined, { timeout: 2000 })
  }
  async target(input: Input, optional = false) {
    const ref = typeof input.ref === "string" ? input.ref.replace(/^aria-ref=/, "") : ""
    if (ref) {
      const entry = this.refs.get(ref)
      if (!entry) throw new Error("Stale element reference. Read a new browser_snapshot after navigation or human input.")
      const locator = this.page.locator(`aria-ref=${entry.native}`)
      if (await this.signature(locator).catch(() => "") !== entry.signature) throw new Error("The observed target changed. Read a new browser_snapshot.")
      return locator
    }
    if (typeof input.selector === "string") {
      // Playwright resolves open shadow roots; a selector must still identify exactly one target.
      const locator = this.page.locator(input.selector)
      if (await locator.count() !== 1) throw new Error("Selector must identify exactly one observed element")
      return locator
    }
    if (optional) return undefined
    throw new Error("Pass an observed ref or a unique selector")
  }

  async snapshot(signal?: AbortSignal, attempt=0):Promise<Record<string,unknown>> {
    this.invalidate()
    const generation = this.generation
    const tree = await this.page.ariaSnapshot({ mode: "ai", boxes: true, timeout: 8000, signal })
    const nativeRefs = [...new Set([...tree.matchAll(/\[ref=((?:f\d+)?e\d+)\]/g)].map(match => match[1]!))].slice(0,220)
    const entries = await Promise.all(nativeRefs.map(async native => {
      const signature = await this.signature(this.page.locator(`aria-ref=${native}`)).catch(() => "")
      return [native, signature] as const
    }))
    signal?.throwIfAborted()
    if (generation !== this.generation) {
      if(attempt<2)return this.snapshot(signal,attempt+1)
      throw new Error("Page changed while taking snapshot. Read it again.")
    }
    for (const [native, signature] of entries) if (signature) this.refs.set(`${generation}-${native}`, { native, signature })
    const frames = await boundedEvaluation(this.page,()=>Promise.all(this.page.frames().map(async frame => {
      try {
        return await frame.evaluate(() => ({
          text: (document.body?.innerText ?? "").slice(0,16000),
          media: [...document.querySelectorAll<HTMLMediaElement>("video,audio")].slice(0,30).map(m => ({kind:m.tagName.toLowerCase(),paused:m.paused,ended:m.ended,currentTime:m.currentTime,duration:Number.isFinite(m.duration)?m.duration:null,readyState:m.readyState,muted:m.muted,error:m.error?{code:m.error.code,message:m.error.message}:null})),
          secrets: [...document.querySelectorAll<HTMLInputElement>("input,textarea")].filter(e => e.type === "password" || /disc|circle|square/.test(getComputedStyle(e).getPropertyValue("-webkit-text-security"))).map(e => e.value).filter(Boolean),
        }))
      } catch { return { text: "", media: [], secrets: [] } }
    })),signal)
    const secrets = frames.flatMap(frame => frame.secrets)
    const mask = (text: string) => secrets.reduce((value, secret) => value.replaceAll(secret, "[hidden]"), text)
    return {
      url: this.page.url(), title: await this.page.title(),
      accessibilityTree: mask(tree).replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_all, native: string) => `[ref=${generation}-${native}]`).slice(0,40000),
      text: mask(frames.map(frame => frame.text).join("\n")).slice(0,16000),
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
      const locator = await this.target(input,true)
      if (locator) await locator.waitFor({state:"visible",timeout:wait,signal})
      return {matched:true}
    }
    if (operation === "scroll") {
      const target = await this.target(input,true)
      if (target) await target.hover({timeout,signal})
      await this.page.mouse.wheel(Number(input.deltaX)||0,Number(input.deltaY)||0)
      return {delivered:true}
    }
    const target = await this.target(input, operation === "press")
    signal.throwIfAborted()
    if (operation === "click") {
      // An alert keeps Playwright's click pending until it is answered. Return
      // at the dialog so the next tool can inspect and resolve it.
      let opened!:()=>void
      const dialog=new Promise<void>(done=>{opened=done})
      this.page.once("dialog",opened)
      const clicked=target!.click({timeout,signal})
      try {await Promise.race([clicked,dialog])}finally{this.page.off("dialog",opened);void clicked.catch(()=>undefined)}
    }
    else if (operation === "hover") await target!.hover({timeout,signal})
    else if (operation === "type") {
      if (typeof input.text !== "string") throw new Error("text must be a string")
      if (input.clear !== false) await target!.fill(input.text,{timeout,signal})
      else { await target!.focus({timeout,signal}); signal.throwIfAborted(); await this.page.keyboard.insertText(input.text) }
      // A type+Enter sequence can keep its ref, but changed semantics cannot.
      const entry = typeof input.ref === "string" ? this.refs.get(input.ref) : undefined
      if (entry) entry.signature = await this.signature(target!)
    } else if (operation === "press") {
      if (typeof input.key !== "string") throw new Error("Provide a key")
      if (target) await target.press(input.key,{timeout,signal})
      else await this.page.keyboard.press(input.key)
    } else if (operation === "select") {
      await target!.selectOption(typeof input.value === "string" ? {value:input.value} : {label:String(input.label)}, {timeout,signal})
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

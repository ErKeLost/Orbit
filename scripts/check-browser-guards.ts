/** Native WebView integration checks. Requires a running Orbit desktop.
 * No model, API key, external website or Chromium fallback is involved. */
import { randomUUID } from "node:crypto"
import { BrowserService } from "../src-tauri/resources/browser-use/browser-service"
import { viewRequest } from "../src-tauri/resources/browser-use/view-channel"

const scope = `browser-guards-${randomUUID()}`
if (!await viewRequest({ op: "tabs", scope })) {
  console.log("SKIP: start Orbit desktop before running the native browser checks")
  process.exit(0)
}
const server = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    const html = url.pathname === "/watch"
      ? '<h1>Player fixture</h1><video controls></video><button onclick="window.clicks=(window.clicks||0)+1;this.textContent=\'Clicked once\'">Native click</button><aside id="clock"></aside>'
      : url.pathname === "/search"
        ? '<h1>Search results</h1><a href="/watch">Observed result</a>'
        : '<h1>Browser guard checks</h1><form action="/search"><label>Query<input name="q"></label></form><button id="guard">Continue</button><aside id="clock"></aside>'
    return new Response(`<!doctype html><meta charset="utf-8"><title>Orbit browser checks</title>
      <style>body{font:16px system-ui;padding:24px}button,input,a{display:block;margin:20px;padding:12px}video{width:160px;height:90px}</style>
      ${html}<script>addEventListener('pointerdown',e=>window.lastPointer={x:e.clientX,y:e.clientY,screenX:e.screenX,screenY:e.screenY,target:e.target.tagName});setInterval(()=>{const c=document.querySelector('#clock');if(c)c.textContent=String(Date.now())},50)</script>`,
      { headers: { "content-type": "text/html; charset=utf-8" } })
  },
})
const service = new BrowserService()
type Snapshot = { tabId: string; url: string; elements: { ref: string; name: string; href?: string }[]; media: { paused: boolean }[] }
let tabId = ""
const passed: string[] = []
const check = (name: string, condition: unknown) => { if (!condition) throw new Error(name); passed.push(name) }
const run = (operation: string, input: Record<string, unknown> = {}) => service.run(scope, operation, { ...(tabId ? { tabId } : {}), ...input })
try {
  const opened = await run("open", { url: `http://127.0.0.1:${server.port}/` }) as Snapshot
  tabId = opened.tabId
  check("real native tab opened", tabId && opened.url.includes(`:${server.port}`))
  const target = opened.elements.find(element => element.name === "Continue")!
  await run("evaluate", { expression: "document.querySelector('#guard').textContent='Delete account'" })
  let refused = false
  try { await run("click", { ref: target.ref }) } catch (error) { refused = String(error).includes("Stale") }
  check("changed target refused before native input", refused)
  const snapshot = await run("snapshot") as Snapshot
  const query = snapshot.elements.find(element => element.name === "Query")!
  const value = "现在就出发 exact literal query"
  await run("type", { ref: query.ref, text: value })
  const filled = await run("evaluate", { expression: "document.querySelector('input').value" }) as { value: string }
  check("full search text reaches native WebView", filled.value === value)
  await run("press", { ref: query.ref, key: "Enter" })
  await run("wait_for", { url: "/search?", text: "Search results", timeoutMs: 5000 })
  const result = await run("snapshot") as Snapshot
  check("Enter submits exactly the requested search", new URL(result.url).searchParams.get("q") === value)
  const link = result.elements.find(element => element.name === "Observed result")!
  await run("navigate", { url: link.href })
  await run("wait_for", { url: "/watch", text: "Player fixture", timeoutMs: 5000 })
  const player = await run("snapshot") as Snapshot
  check("observed href navigates the same tab", player.tabId === tabId && new URL(player.url).pathname === "/watch")
  check("media state reports paused rather than assuming playback", player.media[0]?.paused === true)
  const native = player.elements.find(element => element.name === "Native click")!
  await run("click", { ref: native.ref })
  await run("wait_for", { text: "Clicked once", timeoutMs: 2000 })
  const count = await run("evaluate", { expression: "Promise.resolve(window.clicks||0)" }) as { value: number }
  check("native click delivered once despite unrelated clock changes", count.value === 1)
  const recovered = await new BrowserService().run(scope, "snapshot", {}) as Snapshot
  check("new Pi executor recovers stable session tab", recovered.tabId === tabId)
  console.log(JSON.stringify({ passed: passed.length, checks: passed, tabId }, null, 2))
} catch (error) {
  const geometry = tabId ? await viewRequest({ op: "geometry", tab: tabId }).catch(() => null) : null
  const pointer = tabId ? await run("evaluate", { expression: "({pointer:window.lastPointer??null,clicks:window.clicks??0,screen:{x:screenX,y:screenY},viewport:{width:innerWidth,height:innerHeight}})" }).catch(() => null) : null
  console.error(JSON.stringify({ passed, tabId, geometry, pointer, error: String(error) }, null, 2))
  throw error
} finally {
  server.stop(true)
  // Keep the diagnostic page available to inspect; only give back control.
  // Production tools also release instead of destroying browser tabs.
}

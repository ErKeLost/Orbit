/** Real native Chromium integration against a running Orbit desktop app.
 * Local fixtures only; no model requests or private account data are used. */
import assert from "node:assert/strict"
import { BrowserService } from "../src-tauri/resources/browser-use/browser-service.ts"
import { viewRequest } from "../src-tauri/resources/browser-use/view-channel.ts"

const scope = `native-check-${process.pid}`
let service = new BrowserService()
const server = Bun.serve({ port: 0, fetch(request) {
  if (new URL(request.url).pathname === "/frame") return new Response(`<!doctype html><meta charset="utf-8"><label>子框架<input></label><button onclick="parent.postMessage({nativeFrame: event.isTrusted}, '*')">跨域点击</button>`, { headers: { "content-type": "text/html;charset=utf-8" } })
  return new Response(`<!doctype html><meta charset="utf-8"><title>Native Chromium check</title>
    <form><label>查询<input name="q"></label></form>
    <button id="click" onclick="window.clicked=event.isTrusted;this.textContent='可信点击成功'">原生点击</button>
    <textarea aria-label="多行文本"></textarea>
    <iframe title="跨域框架" src="http://localhost:${server.port}/frame"></iframe>
    <script>addEventListener('message',e=>{if(e.data.nativeFrame)window.frameClicked=true})</script>`, { headers: { "content-type": "text/html;charset=utf-8" } })
} })
type Result = { tabId: string; value?: any; accessibilityTree?: string; text?: string }
const run = (op: string, input: Record<string, unknown>, signal?: AbortSignal) => service.run(scope, op, input, signal) as Promise<Result>
let tabId = ""
let leaseOwner = ""
let extraConnection: { close(): Promise<void> } | undefined
try {
  const opened = await run("open", { url: `http://127.0.0.1:${server.port}/` })
  tabId = opened.tabId
  assert.ok(tabId)
  await run("type", { tabId, selector: "input", text: "现在就出发 中文输入" })
  await run("click", { tabId, selector: "#click" })
  await run("type", { tabId, selector: "textarea", text: "第一行\n第二行" })
  await run("type", { tabId, selector: "textarea", text: "\n第三行", clear: false })
  const value = (await run("evaluate", { tabId, expression: "({text:document.querySelector('input').value,multiline:document.querySelector('textarea').value,trusted:window.clicked,dpr:devicePixelRatio,engine:navigator.userAgent})" })).value
  assert.equal(value.text, "现在就出发 中文输入")
  assert.equal(value.multiline, "第一行\n第二行\n第三行")
  assert.equal(value.trusted, true)
  assert.match(value.engine, /Chrome\/151\./)
  console.log("PASS native Chromium, Chinese/multiline input, trusted click, DPR", value.dpr)

  await run("wait_for", { tabId, selector: 'iframe >> internal:control=enter-frame >> button', timeoutMs: 8000 })
  const snapshot = await run("snapshot", { tabId })
  assert.match(snapshot.text!, /子框架/)
  await run("click", { tabId, selector: 'iframe >> internal:control=enter-frame >> button' })
  assert.equal((await run("evaluate", { tabId, expression: "window.frameClicked" })).value, true)
  console.log("PASS cross-origin iframe snapshot and trusted input")

  // A Cookie in an unrelated domain must be visible from this Profile's store;
  // Network.getCookies at about:blank would falsely report an empty import.
  const owner = crypto.randomUUID()
  leaseOwner = owner
  await viewRequest({ op: "acquire", scope, tab: tabId, owner })
  const endpoint = await viewRequest<any>({ op: "cdp", tab: tabId, owner })
  const { NativePage } = await import("../src-tauri/resources/browser-use/native/connection.ts")
  const attached = await NativePage.connect(endpoint)
  extraConnection = attached
  const cdp = await attached.page.context().newCDPSession(attached.page)
  const cookie = { name: `orbit_native_${process.pid}`, value: "fixture", domain: "orbit-fixture.test", path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const, expires: Math.floor(Date.now() / 1000) + 3600 }
  await cdp.send("Network.setCookies", { cookies: [cookie] })
  const stored = (await cdp.send("Storage.getCookies")).cookies.find(row => row.name === cookie.name)
  assert.ok(stored)
  for (const key of ["value", "domain", "path", "secure", "httpOnly", "sameSite", "expires"] as const) assert.equal(stored[key], cookie[key])
  await cdp.send("Network.deleteCookies", { name: cookie.name, domain: cookie.domain, path: "/" })
  await cdp.detach()
  await attached.close()
  extraConnection = undefined
  await viewRequest({ op: "release", tab: tabId, owner })
  console.log("PASS native Profile Cookie readback with expiry and flags")

  const controller = new AbortController()
  const waiting = run("evaluate", { tabId, expression: "while (true) {}" }, controller.signal)
  const cancelTimer = setTimeout(() => controller.abort(), 300)
  const started = Date.now()
  try { await assert.rejects(waiting, /cancel|abort/i) } finally { clearTimeout(cancelTimer) }
  assert.ok(Date.now() - started < 4000, "Cancelling an executing script must promptly free the page")
  assert.equal((await run("evaluate", { tabId, expression: "6*7" })).value, 42)
  console.log("PASS cancellation terminates executing script and releases control")

  const other = new BrowserService()
  try { await assert.rejects(other.run("another-session", "evaluate", { tabId, expression: "1" }), /does not own/) }
  finally { await other.close() }
  await service.close()
  service = new BrowserService()
  const resumed = await run("open", {})
  assert.equal(resumed.tabId, tabId)
  assert.equal((await run("evaluate", { tabId, expression: "document.querySelector('input').value" })).value, value.text)
  console.log("PASS session isolation and executor restart preserve the native page")
} catch (error) { console.error(error); process.exitCode = 1 }
finally {
  await extraConnection?.close()
  if (leaseOwner) await viewRequest({ op: "releaseOwner", scope, owner: leaseOwner }).catch(() => undefined)
  await service.close()
  server.stop(true)
  console.log("Fixture tab:", tabId, "— close it with the tab's × button after inspection")
}

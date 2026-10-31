import { describe, expect, test } from "bun:test"
import { BrowserService, type BrowserTransport } from "../src-tauri/resources/browser-use/browser-service"
import { browserFixture } from "./browser-fixture"

function browserHost() {
  const fixture = browserFixture('<form><input aria-label="Search"></form><button>Play</button>')
  const calls: Record<string, unknown>[] = []
  const tabs = new Map<string, { scope: string; owner?: string; url: string; visible: boolean }>()
  const current = new Map<string, string>()
  let next = 0
  let hook: ((request: Record<string, unknown>) => Promise<void> | void) | undefined
  const transport: BrowserTransport = async <T>(request: Record<string, unknown>) => {
    calls.push(request)
    await hook?.(request)
    const tabId = String(request.tab)
    const state = tabs.get(tabId)
    let result: unknown = null
    switch (request.op) {
      case "tabs": result = { currentTabId: current.get(String(request.scope)) ?? null, tabs: [...tabs].filter(([, tab]) => tab.scope === request.scope).map(([tab, data]) => ({ tab, open: true, loading: false, url: data.url, visible: data.visible })) }; break
      case "open": {
        const tab = `browser:test-${++next}`
        tabs.set(tab, { scope: String(request.scope), owner: String(request.owner), url: String(request.url || "about:blank"), visible: true })
        current.set(String(request.scope), tab)
        result = { tab }; break
      }
      case "acquire":
        if (!state || state.scope !== request.scope || state.owner) throw new Error("Tab is unavailable")
        state.owner = String(request.owner); current.set(state.scope, tabId); result = { tab: tabId }; break
      case "status": result = { ...state, tab: tabId, open: !!state, loading: false }; break
      case "release":
        if (state?.owner === request.owner) delete state.owner
        break
      case "releaseOwner":
        for (const tab of tabs.values()) if (tab.scope === request.scope && tab.owner === request.owner) delete tab.owner
        break
      case "present": if (state) state.visible = true; break
      case "navigate": if (state) state.url = String(request.url); break
      case "eval": result = fixture.evaluate(String(request.script)); break
      case "clickAt": result = { x: request.x, y: request.y }; break
      default: throw new Error(`Unexpected transport op ${request.op}`)
    }
    return result as T
  }
  return { fixture, calls, tabs, transport, hook: (next: typeof hook) => { hook = next }, close: () => fixture.close() }
}

describe("direct browser service", () => {
  test("status never creates a tab; actions require browser_open", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      expect(await service.run("a", "status", {})).toMatchObject({ tabs: [], currentTabId: null })
      await expect(service.run("a", "snapshot", {})).rejects.toThrow("browser_open")
      expect(host.calls.every(call => call.op === "tabs")).toBe(true)
    } finally { host.close() }
  })
  test("ordinary navigation reuses a stable tab and only explicit newTab allocates another", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      const first = await service.run("a", "open", { url: "https://one.test/" }) as { tabId: string }
      const second = await service.run("a", "open", { url: "https://two.test/" }) as { tabId: string }
      expect(second.tabId).toBe(first.tabId)
      const third = await service.run("a", "open", { reuseExistingTab: false }) as { tabId: string }
      expect(third.tabId).not.toBe(first.tabId)
      expect(host.tabs.size).toBe(2)
      expect(host.calls.filter(call => call.op === "navigate").map(call => call.url)).toEqual(["https://two.test/"])
      expect([...host.tabs.values()].every(tab => !tab.owner)).toBe(true)
    } finally { host.close() }
  })
  test("snapshot does not reopen the panel, and a fresh service recovers the host's session tabs", async () => {
    const host = browserHost()
    try {
      const opened = await new BrowserService(host.transport).run("a", "open", { url: "https://fixture.test/" }) as { tabId: string }
      host.calls.length = 0
      const snapshot = await new BrowserService(host.transport).run("a", "snapshot", {}) as { tabId: string }
      expect(snapshot.tabId).toBe(opened.tabId)
      expect(host.calls.map(call => call.op)).toEqual(["tabs", "acquire", "status", "eval", "release"])
    } finally { host.close() }
  })
  test("another session cannot operate a tab and busy tabs never create substitutes", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      const { tabId } = await service.run("a", "open", { url: "https://fixture.test/" }) as { tabId: string }
      await expect(service.run("b", "type", { tabId, text: "wrong" })).rejects.toThrow("does not own")
      host.tabs.get(tabId)!.owner = "other-operation"
      await expect(service.run("a", "snapshot", { tabId })).rejects.toThrow("unavailable")
      expect(host.tabs.size).toBe(1)
      expect(host.calls.filter(call => call.op === "eval")).toHaveLength(1)
    } finally { host.close() }
  })
  test("failed page actions release control without closing the tab", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      const { tabId } = await service.run("a", "open", { url: "https://fixture.test/" }) as { tabId: string }
      await expect(service.run("a", "type", { tabId, ref: "stale", text: "wrong" })).rejects.toThrow("Stale")
      expect(host.tabs.get(tabId)!.owner).toBeUndefined()
      expect(host.calls.some(call => call.op === "close")).toBe(false)
      await service.run("a", "snapshot", { tabId })
    } finally { host.close() }
  })
  test("cancellation at a transport boundary prevents the next action and still releases", async () => {
    const host = browserHost(), service = new BrowserService(host.transport), abort = new AbortController()
    try {
      const { tabId } = await service.run("a", "open", { url: "https://fixture.test/" }) as { tabId: string }
      host.calls.length = 0
      host.hook(request => { if (request.op === "status") abort.abort() })
      await expect(service.run("a", "type", { tabId, selector: "input", text: "should not type" }, abort.signal)).rejects.toThrow()
      expect(host.fixture.document.querySelector("input")!.value).toBe("")
      expect(host.calls.map(call => call.op)).toEqual(["tabs", "acquire", "status", "release"])
      expect(host.tabs.get(tabId)!.owner).toBeUndefined()
    } finally { host.close() }
  })
  test("async evaluation returns primitives, arrays and null in a bounded value wrapper", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      await service.run("a", "open", { url: "https://fixture.test/" })
      for (const [expression, value] of [["Promise.resolve([1,2])", [1, 2]], ["42", 42], ["undefined", null]] as const) {
        expect(await service.run("a", "evaluate", { expression })).toMatchObject({ value })
      }
      await expect(service.run("a", "evaluate", { expression: "'字'.repeat(22000)" })).rejects.toThrow("64 KB")
      await expect(service.run("a", "evaluate", { expression: "(() => {throw new Error('site failed')})()" })).rejects.toThrow("site failed")
      expect(Object.keys(host.fixture.window).filter(key => key.startsWith("orbit-eval-"))).toEqual([])
    } finally { host.close() }
  })
  test("wait conditions poll missing elements until they appear", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      await service.run("a", "open", { url: "https://fixture.test/" })
      setTimeout(() => host.fixture.document.body.insertAdjacentHTML("beforeend", '<button id="loaded">Ready</button>'), 15)
      expect(await service.run("a", "wait_for", { selector: "#loaded", text: "Ready", timeoutMs: 500 })).toMatchObject({ matched: true })
    } finally { host.close() }
  })
  test("invalid URLs fail before opening or executing a page", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      await expect(service.run("a", "open", { url: "javascript:alert(1)" })).rejects.toThrow("HTTP")
      expect(host.calls).toEqual([])
    } finally { host.close() }
  })
  test.skipIf(process.platform !== "darwin")("a native input failure is not retried as a DOM click", async () => {
    const host = browserHost(), service = new BrowserService(host.transport)
    try {
      const { tabId } = await service.run("a", "open", { url: "https://fixture.test/" }) as { tabId: string }
      host.hook(request => { if (request.op === "clickAt") throw new Error("mouse-up failed") })
      await expect(service.run("a", "click", { tabId, selector: "button" })).rejects.toThrow("mouse-up failed")
      expect(host.calls.filter(call => call.op === "clickAt")).toHaveLength(1)
      expect(host.tabs.get(tabId)!.owner).toBeUndefined()
    } finally { host.close() }
  })
})

import { describe, expect, test } from "bun:test"
import { createDriver, normalizeWindowState, type WindowState } from "../src-tauri/resources/computer-use/cua/driver.ts"
import { buildCallPayload, NO_SESSION_TOOLS, parseToolResult } from "../src-tauri/resources/computer-use/cua/tool-client.ts"
import { DriverToolError, escalationOf } from "../src-tauri/resources/computer-use/cua/errors.ts"
import type { CuaToolClient } from "../src-tauri/resources/computer-use/cua/tool-client.ts"
import type { ToolResult } from "../src-tauri/resources/computer-use/cua/tool-result.ts"

function fakeClient(handler: (name: string, args: Record<string, unknown>) => Record<string, unknown>): { client: CuaToolClient; calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = []
  const client: CuaToolClient = {
    transport: "cli",
    listTools: async () => [],
    call: async (name, args = {}) => {
      calls.push({ name, args })
      return { value: handler(name, args), text: "", images: [], isError: false } satisfies ToolResult
    },
    dispose: async () => undefined,
  }
  return { client, calls }
}

describe("cua driver normalisation", () => {
  test("maps the driver's snake_case window state and keeps tree order", () => {
    const state = normalizeWindowState({
      app_name: "汽水音乐",
      window_title: "汽水音乐",
      pid: 65246,
      window_id: 31480,
      snapshot_id: "s00000003",
      capture_id: "capture_abc_0",
      elements_complete: false,
      truncated: false,
      total_element_count: 152,
      screenshot_mime_type: "image/png",
      screenshot_width: 2560,
      screenshot_height: 1309,
      elements: [
        { element_index: 60, element_token: "s00000003:60", role: "AXTextField", depth: 2, label: "歌手、歌曲或专辑名", value: "歌手、歌曲或专辑名", enabled: true, in_web_content: true, actions: ["AXPress", "AXShowMenu"], frame: { x: 2106, y: 34, w: 240, h: 30 } },
        { element_index: 3, element_token: "s00000003:3", role: "AXLink", depth: 2, label: "推荐", actions: ["press"] },
      ],
    })
    expect(state.appName).toBe("汽水音乐")
    expect(state.snapshotId).toBe("s00000003")
    expect(state.captureId).toBe("capture_abc_0")
    // A partial tree must stay visibly partial: the loop gates the visual
    // fallback on this flag.
    expect(state.elementsComplete).toBe(false)
    expect(state.screenshot?.width).toBe(2560)
    expect(state.elements.map(item => item.elementIndex)).toEqual([3, 60])
    const field = state.elements[1]
    expect(field.role).toBe("AXTextField")
    expect(field.label).toBe("歌手、歌曲或专辑名")
    expect(field.elementToken).toBe("s00000003:60")
    expect(field.inWebContent).toBe(true)
    expect(field.frame).toEqual({ x: 2106, y: 34, w: 240, h: 30 })
  })
})

describe("cua CLI transport", () => {
  test("adds the session label to every tool that declares the field", () => {
    expect(buildCallPayload("get_window_state", { pid: 1, window_id: 2 }, "s1", true)).toEqual({ pid: 1, window_id: 2, session: "s1" })
    expect(buildCallPayload("click", { x: 1, y: 2 }, "s1", true)).toEqual({ x: 1, y: 2, session: "s1" })
    expect(buildCallPayload("check_permissions", {}, "s1", true)).toEqual({ session: "s1" })
    // list_sessions is the only tool without a session field.
    expect(NO_SESSION_TOOLS.has("list_sessions")).toBe(true)
    expect(buildCallPayload("list_sessions", {}, "s1", true)).toEqual({})
    // An explicit caller session wins, and undefined keys never ship.
    expect(buildCallPayload("click", { session: "own", x: undefined }, "s1", true)).toEqual({ session: "own" })
    expect(buildCallPayload("click", { x: 1 }, "s1", false)).toEqual({ x: 1 })
    expect(buildCallPayload("click", { x: 1 }, undefined, true)).toEqual({ x: 1 })
  })

  test("turns both refusal shapes into a DriverToolError and keeps the escalation", () => {
    // Action-level refusal: the driver exits non-zero and prints JSON on stdout.
    const actionRefusal = () => parseToolResult("type_text", { stdout: JSON.stringify({ code: "background_unavailable", effect: "refused", escalation: { recommended: "foreground", reason: "Electron AX target" } }), stderr: "", code: 1 })
    expect(actionRefusal).toThrow(DriverToolError)
    let caught: unknown
    try { actionRefusal() } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(DriverToolError)
    expect((caught as DriverToolError).code).toBe("background_unavailable")
    // The rung is what lets the loop offer the next candidate instead of dying.
    expect(escalationOf(caught)).toBe("foreground")

    // Tool-level refusal: same non-zero exit, nested shape.
    let nested: unknown
    try { parseToolResult("click", { stdout: JSON.stringify({ refusal: { code: "stale_element_token", message: "token is stale" }, status: "refused" }), stderr: "", code: 1 }) } catch (error) { nested = error }
    expect((nested as DriverToolError).code).toBe("stale_element_token")
    expect(escalationOf(nested)).toBeUndefined()

    // A successful payload is returned untouched.
    const ok = parseToolResult("list_apps", { stdout: JSON.stringify({ apps: [] }), stderr: "", code: 0 })
    expect(ok.value).toEqual({ apps: [] })
    // A non-zero exit without a structured refusal is a real transport failure.
    expect(() => parseToolResult("x", { stdout: "", stderr: "boom", code: 2 })).toThrow(/exited 2/)
    // Non-JSON stdout on a clean exit is not an error by itself.
    expect(parseToolResult("x", { stdout: "not json", stderr: "", code: 0 }).text).toBe("not json")
  })

  test("never escalates a background refusal on its own", async () => {
    const { client, calls } = fakeClient(() => ({ effect: "refused", code: "background_unavailable", escalation: { recommended: "foreground", reason: "needs focus" } }))
    const result = await createDriver(client).click({ elementToken: "s00000003:60", pid: 65246, windowId: 31480 })
    expect(calls).toEqual([{ name: "click", args: { element_token: "s00000003:60", pid: 65246, window_id: 31480 } }])
    expect(result.effect).toBe("refused")
    expect(result.verified).toBe(false)
    expect(result.escalation?.recommended).toBe("foreground")
    expect(result.code).toBe("background_unavailable")
  })

  test("type_text and set_value carry the prepared text and the token", async () => {
    const { client, calls } = fakeClient(() => ({ effect: "confirmed", verified: true }))
    const driver = createDriver(client)
    await driver.typeText({ text: "蓝", elementToken: "s00000003:60" })
    await driver.setValue({ elementToken: "s00000003:60", value: "蓝" })
    expect(calls[0]).toEqual({ name: "type_text", args: { text: "蓝", element_token: "s00000003:60" } })
    expect(calls[1]).toEqual({ name: "set_value", args: { element_token: "s00000003:60", value: "蓝" } })
  })
})

// Live smoke against the real desktop; opt-in so CI never needs a GUI.
const live = process.env.ORBIT_CU_LIVE === "1"
describe.if(live)("cua driver live", () => {
  test("reads a labelled text field from a running app", async () => {
    const target = process.env.ORBIT_CU_LIVE_APP ?? "汽水音乐"
    const { connectDriver } = await import("../src-tauri/resources/computer-use/cua/driver.ts")
    const driver = await connectDriver()
    try {
      const apps = await driver.listApps()
      const app = apps.find(item => item.name === target)
      expect(app, `app not running: ${target}`).toBeDefined()
      const windows = await driver.listWindows({ pid: app!.pid })
      expect(windows.length).toBeGreaterThan(0)
      const state: WindowState = await driver.getWindowState({ pid: app!.pid, windowId: windows[0].windowId, includeScreenshot: false, maxElements: 4000 })
      const fields = state.elements.filter(item => /text|edit|entry/i.test(item.role))
      console.log(`[cua live] ${target}: ${state.elements.length} elements, complete=${state.elementsComplete}, fields=${fields.length}`)
      for (const field of fields) console.log(`[cua live]   ${field.role} "${field.label ?? field.value ?? ""}" token=${field.elementToken}`)
      expect(fields.some(field => Boolean(field.label ?? field.value))).toBe(true)
    } finally {
      await driver.dispose()
    }
  }, 90_000)
})

/**
 * Registration contract: Browser Use is a tool, and it is gated like one.
 *
 * The Pi extension registers the direct browser tools, and its
 * gating (enabled → in the tool set → its instructions in the prompt) is the
 * part that silently stops working after a refactor. The stub API below is the
 * whole surface the mode uses, so this runs without a Pi process.
 */
import { describe, expect, test } from "bun:test"
import { applyBrowserUseMode, BROWSER_USE_INSTRUCTIONS, BROWSER_USE_TOOL_NAMES, registerBrowserUseMode } from "../src-tauri/resources/browser-use/mode"

type Tool = {
  name: string
  label?: string
  description: string
  parameters?: Record<string, unknown>
  promptGuidelines?: string[]
  execute: (...args: unknown[]) => unknown
}

function stubApi() {
  const tools = new Map<string, Tool>()
  const commands = new Map<string, (args: string, ctx: never) => unknown>()
  const handlers = new Map<string, (event: never, ctx: never) => unknown>()
  let active = ["read", "bash"]
  const statuses: Record<string, string | undefined> = {}
  const pi = {
    registerTool: (tool: Tool) => {
      tools.set(tool.name, tool)
    },
    registerCommand: (name: string, options: { handler: (args: string, ctx: never) => unknown }) => {
      commands.set(name, options.handler)
    },
    on: (name: string, handler: (event: never, ctx: never) => unknown) => {
      handlers.set(name, handler)
    },
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => {
      active = names
    },
    getAllTools: () => [...tools.values(), { name: "read" }, { name: "bash" }].map(tool => ({ ...tool, description: tool.description ?? "built in" })),
  }
  const context = { ui: { setStatus: (key: string, text: string | undefined) => { statuses[key] = text } } }
  const publish = (ctx: { ui: { setStatus(key: string, text: string | undefined): void } }) => {
    ctx.ui.setStatus("gui-tools", "published")
  }
  return { pi, context, tools, commands, handlers, statuses, publish, active: () => active }
}

describe("browser use mode", () => {
  test("registers direct browser tools without a nested task agent", () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    expect([...api.tools.keys()]).toEqual(BROWSER_USE_TOOL_NAMES)
    expect(api.tools.has("browser_task")).toBe(false)
    for (const name of ["browser_open", "browser_snapshot", "browser_type", "browser_evaluate", "browser_wait_for"]) {
      expect(api.tools.has(name)).toBe(true)
      expect(api.tools.get(name)!.execute).toBeFunction()
    }
    const schema = api.tools.get("browser_type")!.parameters as { required: string[] }
    expect(schema.required).toContain("text")
    expect(JSON.stringify([...api.tools.values()])).not.toContain("textSlots")
  })

  test("the command turns the tool on and off, and publishes the tool state", async () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)

    api.pi.setActiveTools(applyBrowserUseMode(api.pi.getActiveTools(), api.pi.getAllTools().map(tool => tool.name), false))
    expect(api.active().filter(name => BROWSER_USE_TOOL_NAMES.includes(name))).toEqual([])
    expect(api.statuses["gui-browser-use-mode"]).toBeUndefined()

    await api.commands.get("gui-browser-use-mode")!(JSON.stringify({ enabled: true }), api.context as never)
    expect(api.active()).toEqual(expect.arrayContaining(BROWSER_USE_TOOL_NAMES))
    expect(api.statuses["gui-browser-use-mode"]).toBe("enabled")
    expect(api.statuses["gui-tools"]).toBe("published")

    await api.commands.get("gui-browser-use-mode")!(JSON.stringify({ enabled: false }), api.context as never)
    expect(api.active().filter(name => BROWSER_USE_TOOL_NAMES.includes(name))).toEqual([])
    expect(api.statuses["gui-browser-use-mode"]).toBe("disabled")

    await expect(api.commands.get("gui-browser-use-mode")!("{}", api.context as never)).rejects.toThrow("Expected enabled boolean")
  })

  test("a session starts with the tool active, and the tool is removed from unknown names only", () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    api.handlers.get("session_start")!({} as never, api.context as never)
    expect(api.active()).toEqual(expect.arrayContaining(BROWSER_USE_TOOL_NAMES))
    // Another session's tool list must not be able to add a name that is absent.
    expect(applyBrowserUseMode(["read"], ["read"], true)).toEqual(["read"])
    expect(applyBrowserUseMode(["read", ...BROWSER_USE_TOOL_NAMES], ["read", ...BROWSER_USE_TOOL_NAMES], false)).toEqual(["read"])
  })

  test("the instructions reach the prompt only while the tool is active", async () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    const before = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, api.context as never) as { systemPrompt: string } | undefined
    expect(before).toBeUndefined()

    api.pi.setActiveTools(["read", "browser_snapshot"])
    const after = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, api.context as never) as { systemPrompt: string }
    expect(after.systemPrompt.startsWith("base")).toBe(true)
    expect(after.systemPrompt).toContain("<browser_use_mode>")
    // The rules that keep a run honest have to be in the prompt the model reads.
    for (const rule of ["untrusted evidence", "tabId", "paused=false", "captcha", "authorization", "browser_evaluate"]) {
      expect({ rule, present: BROWSER_USE_INSTRUCTIONS.includes(rule) }).toEqual({ rule, present: true })
    }
  })
})

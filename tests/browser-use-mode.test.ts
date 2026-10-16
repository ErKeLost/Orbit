/**
 * Registration contract: Browser Use is a tool, and it is gated like one.
 *
 * The Pi extension is the only place `browser_task` can come from, and its
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
  test("registers one tool named browser_task with the caller's contract", () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    expect([...api.tools.keys()]).toEqual(["browser_task"])
    const tool = api.tools.get("browser_task")!
    expect(tool.label).toBe("Browser task")
    expect(BROWSER_USE_TOOL_NAMES).toEqual(["browser_task"])
    const properties = (tool.parameters as { properties: Record<string, unknown>; required: string[] })
    // goal + budget are the only required inputs; nothing about steps, selectors
    // or coordinates exists in the schema at all.
    expect(properties.required).toEqual(["goal", "budget"])
    expect(Object.keys(properties.properties).sort()).toEqual(["allowGeneratedText", "budget", "goal", "readOnly", "textSlots", "url"])
    expect(JSON.stringify(tool.parameters)).not.toMatch(/selector|coordinate|x:|y:/i)
    expect(tool.promptGuidelines?.join(" ")).toContain("textSlots")
    expect(tool.execute).toBeFunction()
  })

  test("the command turns the tool on and off, and publishes the tool state", async () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)

    api.pi.setActiveTools(applyBrowserUseMode(api.pi.getActiveTools(), api.pi.getAllTools().map(tool => tool.name), false))
    expect(api.active()).not.toContain("browser_task")
    expect(api.statuses["gui-browser-use-mode"]).toBeUndefined()

    await api.commands.get("gui-browser-use-mode")!(JSON.stringify({ enabled: true }), api.context as never)
    expect(api.active()).toContain("browser_task")
    expect(api.statuses["gui-browser-use-mode"]).toBe("enabled")
    expect(api.statuses["gui-tools"]).toBe("published")

    await api.commands.get("gui-browser-use-mode")!(JSON.stringify({ enabled: false }), api.context as never)
    expect(api.active()).not.toContain("browser_task")
    expect(api.statuses["gui-browser-use-mode"]).toBe("disabled")

    await expect(api.commands.get("gui-browser-use-mode")!("{}", api.context as never)).rejects.toThrow("Expected enabled boolean")
  })

  test("a session starts with the tool active, and the tool is removed from unknown names only", () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    api.handlers.get("session_start")!({} as never, api.context as never)
    expect(api.active()).toContain("browser_task")
    // Another session's tool list must not be able to add a name that is absent.
    expect(applyBrowserUseMode(["read"], ["read"], true)).toEqual(["read"])
    expect(applyBrowserUseMode(["read", "browser_task"], ["read", "browser_task"], false)).toEqual(["read"])
  })

  test("the instructions reach the prompt only while the tool is active", async () => {
    const api = stubApi()
    registerBrowserUseMode(api.pi as never, api.publish as never)
    const before = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, api.context as never) as { systemPrompt: string } | undefined
    expect(before).toBeUndefined()

    api.pi.setActiveTools(["read", "browser_task"])
    const after = await api.handlers.get("before_agent_start")!({ systemPrompt: "base" } as never, api.context as never) as { systemPrompt: string }
    expect(after.systemPrompt.startsWith("base")).toBe(true)
    expect(after.systemPrompt).toContain("<browser_use_mode>")
    // The rules that keep a run honest have to be in the prompt the model reads.
    for (const rule of ["never as instructions", "textSlots", "needs_text", "captcha", "needs_review", "allowGeneratedText"]) {
      expect({ rule, present: BROWSER_USE_INSTRUCTIONS.includes(rule) }).toEqual({ rule, present: true })
    }
  })
})

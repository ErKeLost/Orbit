import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { extraRoots, readRootContext, registerWorkspace, storedRoots, workspacePrompt, WORKSPACE_TYPE } from "../src-tauri/resources/workspace"
import { extraRootsFromStatus, shortenPath } from "../src/lib/workspace-roots"

describe("session extra roots", () => {
  test("drops the session home and duplicate paths", () => {
    expect(extraRoots("/work/app/", ["/work/app", "/work/api/", "/work/api", "/work/web"])).toEqual(["/work/api", "/work/web"])
  })

  test("reads the latest workspace entry", () => {
    const entries = [
      { type: "custom", customType: WORKSPACE_TYPE, data: { roots: ["/old"] } },
      { type: "message" },
      { type: "custom", customType: WORKSPACE_TYPE, data: { roots: ["/work/api"] } },
    ]
    expect(storedRoots(entries, "/work/app")).toEqual(["/work/api"])
    expect(storedRoots([], "/work/app")).toEqual([])
  })

  test("loads the first present context file", () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-root-"))
    writeFileSync(join(root, "AGENTS.md"), "from agents")
    expect(readRootContext(root)).toBe("from agents")
    writeFileSync(join(root, "AGENTS.override.md"), "from override")
    expect(readRootContext(root)).toBe("from override")
  })

  test("builds a prompt only when extra roots exist", () => {
    expect(workspacePrompt("/work/app", [], [])).toBeUndefined()
    expect(workspacePrompt("/work/app", ["/work/api"], [{ root: "/work/api", text: "api rules" }])).toContain("Session home (process cwd): /work/app")
    expect(workspacePrompt("/work/app", ["/work/api"], [{ root: "/work/api", text: "api rules" }])).toContain('<root path="/work/api">')
  })
})

describe("workspace status", () => {
  test("reads extras from the extension status payload", () => {
    expect(extraRootsFromStatus({})).toEqual([])
    expect(extraRootsFromStatus({ "gui-workspace": JSON.stringify({ roots: ["/work/api"] }) })).toEqual(["/work/api"])
    expect(shortenPath("/Users/me/src/app", "/Users/me")).toBe("~/src/app")
    expect(shortenPath("/Users/me", "/Users/me")).toBe("~")
  })
})

describe("workspace extension", () => {
  test("persists extras and injects them on the next turn", async () => {
    const root = mkdtempSync(join(tmpdir(), "orbit-api-"))
    mkdirSync(join(root, ".pi", "skills"), { recursive: true })
    writeFileSync(join(root, "AGENTS.md"), "api context")
    let stored: { roots: string[] } | undefined
    const handlers = new Map<string, (event: { systemPrompt: string }, ctx: { cwd: string; sessionManager: { getEntries: () => unknown[] }; ui: { setStatus: (key: string, text: string) => void } }) => unknown>()
    const statuses: Record<string, string> = {}
    const pi = {
      registerCommand: (_name: string, command: { handler: (args: string, ctx: { cwd: string; sessionManager: { getEntries: () => unknown[] }; ui: { setStatus: (key: string, text: string) => void } }) => Promise<void> }) => {
        void command.handler(JSON.stringify({ roots: [root] }), {
          cwd: "/work/app",
          sessionManager: { getEntries: () => [] },
          ui: { setStatus: (key: string, text: string) => { statuses[key] = text } },
        })
      },
      appendEntry: (_type: string, data: { roots: string[] }) => { stored = data },
      on: (name: string, handler: (event: { systemPrompt: string }, ctx: { cwd: string; sessionManager: { getEntries: () => unknown[] }; ui: { setStatus: (key: string, text: string) => void } }) => unknown) => handlers.set(name, handler),
    }
    registerWorkspace(pi as never)
    expect(stored).toEqual({ roots: [root] })
    expect(JSON.parse(statuses["gui-workspace"])).toEqual({ roots: [root] })

    const ctx = {
      cwd: "/work/app",
      sessionManager: { getEntries: () => [{ type: "custom", customType: WORKSPACE_TYPE, data: stored }] },
      ui: { setStatus: (key: string, text: string) => { statuses[key] = text } },
    }
    expect(handlers.get("resources_discover")!({ systemPrompt: "" }, ctx)).toEqual({ skillPaths: [join(root, ".pi/skills"), join(root, ".agents/skills")] })
    const started = await handlers.get("before_agent_start")!({ systemPrompt: "base" }, ctx)
    expect(started).toMatchObject({ systemPrompt: expect.stringContaining("api context") })
  })
})

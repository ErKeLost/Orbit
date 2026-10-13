import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { MAX_ACTIVE_CHILDREN, modelVisibleOutput, SubagentRuntime } from "../src-tauri/resources/subagents/runtime"
import { filterForkSession } from "../src-tauri/resources/subagents/fork"
import type { AgentNode, AgentSnapshot } from "../src-tauri/resources/subagents/types"
import { registerSubagentTools, SUBAGENT_TOOL_NAMES } from "../src-tauri/resources/subagents/tools"

const fakePi = resolve(import.meta.dir, "fixtures/fake-pi-rpc.mjs")
const testNode = "/opt/homebrew/bin/node"
const roots: string[] = []
const runtimes: SubagentRuntime[] = []
const originalNode = process.env.ORBIT_PI_NODE_PATH
const originalPi = process.env.ORBIT_PI_CLI_PATH
const originalHang = process.env.FIXTURE_HANG

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "orbit-subagent-runtime-"))
  const cwd = join(root, "project")
  const parentSession = join(root, "sessions", "parent.jsonl")
  await mkdir(cwd, { recursive: true })
  roots.push(root)
  return { root, cwd, parentSession }
}

/** A parent conversation in the shape spawn sees: tool payloads plus an unanswered call. */
async function seedParentSession(parentSession: string) {
  const entries = [
    { type: "session", version: 3, id: "parent-id", timestamp: new Date().toISOString(), cwd: "/tmp" },
    { type: "message", id: "e1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "把登录按钮改成蓝色" }] } },
    { type: "message", id: "e2", parentId: "e1", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", api: "a", model: "m", stopReason: "toolUse", content: [{ type: "toolCall", id: "tc-read", name: "read", arguments: { path: "src/LoginButton.tsx" } }] } },
    { type: "message", id: "e3", parentId: "e2", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "tc-read", toolName: "read", isError: false, content: [{ type: "text", text: "SECRET_TOOL_PAYLOAD_".repeat(50) }] } },
    { type: "message", id: "e4", parentId: "e3", timestamp: new Date().toISOString(), message: { role: "assistant", provider: "p", api: "a", model: "m", stopReason: "stop", content: [{ type: "text", text: "改完了，顺便补个单测。" }] } },
  ]
  await mkdir(join(parentSession, ".."), { recursive: true })
  await writeFile(parentSession, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
}

async function spawnArgv(root: string, agentId: string): Promise<string[]> {
  return JSON.parse(await readFile(join(root, "sessions", "subagents", agentId, "fixture-argv.json"), "utf8")) as string[]
}

async function spawnedPrompts(root: string, agentId: string): Promise<string> {
  const raw = await readFile(join(root, "sessions", "subagents", agentId, "fixture-prompts.jsonl"), "utf8")
  return raw.trim().split("\n").map((line) => JSON.parse(line) as string).join("\n")
}

function makeRuntime(
  parentSession: string | undefined,
  deliver?: (node: AgentNode, output: string) => void,
  publish?: (snapshot: AgentSnapshot) => void,
): SubagentRuntime {
  const runtime = new SubagentRuntime(
    "parent",
    publish ?? (() => {}),
    parentSession,
    deliver ? { deliver } : undefined,
  )
  runtimes.push(runtime)
  return runtime
}

function useFakePi() {
  process.env.ORBIT_PI_NODE_PATH = testNode
  process.env.ORBIT_PI_CLI_PATH = fakePi
}

/** Poll until `check` passes or the deadline elapses. */
async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return check()
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  if (originalNode === undefined) delete process.env.ORBIT_PI_NODE_PATH
  else process.env.ORBIT_PI_NODE_PATH = originalNode
  if (originalPi === undefined) delete process.env.ORBIT_PI_CLI_PATH
  else process.env.ORBIT_PI_CLI_PATH = originalPi
  if (originalHang === undefined) delete process.env.FIXTURE_HANG
  else process.env.FIXTURE_HANG = originalHang
})

describe("collaboration surface", () => {
  test("exposes the Codex V2 tool set and injects orchestration only when enabled", async () => {
    const tools: string[] = []
    let spawnExecutionMode: string | undefined
    const handlers = new Map<string, (event: unknown) => unknown>()
    let active: string[] = []
    const pi = {
      registerTool: (tool: { name: string; executionMode?: string }) => {
        tools.push(tool.name)
        if (tool.name === "spawn_agent") spawnExecutionMode = tool.executionMode
      },
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      getActiveTools: () => active,
      sendMessage: () => {},
    }
    registerSubagentTools(pi as never)
    // Codex V2 has exactly these six; there is deliberately no batch spawner.
    expect(tools).toEqual([...SUBAGENT_TOOL_NAMES])
    expect([...SUBAGENT_TOOL_NAMES]).toHaveLength(6)
    expect(tools).not.toContain("spawn_agents")
    expect(spawnExecutionMode).toBe("sequential")

    const beforeStart = handlers.get("before_agent_start") as (event: { systemPrompt: string }) => Promise<unknown>
    expect(await beforeStart({ systemPrompt: "base" })).toBeUndefined()
    active = [...SUBAGENT_TOOL_NAMES]
    expect(await beforeStart({ systemPrompt: "base" })).toMatchObject({
      systemPrompt: expect.stringContaining("You are the supervisor"),
    })
  })

  test("tells the supervisor that results arrive as messages, not tool results", async () => {
    const tools: Array<{ name: string; description: string }> = []
    const pi = { registerTool: (tool: { name: string; description: string }) => tools.push(tool), on: () => {}, getActiveTools: () => [], sendMessage: () => {} }
    registerSubagentTools(pi as never)
    const spawn = tools.find((tool) => tool.name === "spawn_agent")!
    expect(spawn.description).toContain("delivered to you later as a separate message")
    const wait = tools.find((tool) => tool.name === "wait_agent")!
    expect(wait.description).toContain("never their content")
  })

  test("warns every agent that the working directory is shared", async () => {
    const handlers = new Map<string, (event: unknown) => unknown>()
    let active: string[] = []
    const pi = {
      registerTool: () => {},
      on: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler),
      getActiveTools: () => active,
      sendMessage: () => {},
    }
    registerSubagentTools(pi as never)
    const beforeStart = handlers.get("before_agent_start") as (event: { systemPrompt: string }) => Promise<{ systemPrompt: string }>
    active = [...SUBAGENT_TOOL_NAMES]

    const root = (await beforeStart({ systemPrompt: "base" })).systemPrompt
    expect(root).toContain("All agents share the same directory")
    expect(root).toContain("edits made by one agent are immediately visible to all other agents")
    expect(root).toContain(`up to ${MAX_ACTIVE_CHILDREN} workers can be active at once`)
    expect(root).toContain("prefer longer waits")

    // Workers can spawn too, so they need the same warning.
    process.env.PI_GUI_SUBAGENT = "1"
    const child = (await beforeStart({ systemPrompt: "base" })).systemPrompt
    delete process.env.PI_GUI_SUBAGENT
    expect(child).toContain("You are a specialist")
    expect(child).toContain("All agents share the same directory")
    expect(child).toContain(`up to ${MAX_ACTIVE_CHILDREN} workers can be active at once`)
  })

  test("caps model-visible child output while preserving a transcript pointer", () => {
    const output = modelVisibleOutput("内容".repeat(30_000))
    expect(Buffer.byteLength(output, "utf8")).toBeLessThan(52 * 1024)
    expect(output).toContain("完整内容保留在子会话中")
  })
})

describe("asynchronous delegation", () => {
  test("spawn returns before the worker finishes, and the result is delivered later", async () => {
    const paths = await fixture()
    useFakePi()
    const delivered: Array<{ node: AgentNode; output: string }> = []
    const runtime = makeRuntime(paths.parentSession, (node, output) => delivered.push({ node, output }))

    const started = await runtime.spawn({ name: "unit_tests", task: "补单测", cwd: paths.cwd })
    // The tool result carries an identity, never the answer.
    expect(started.output).toBe("")
    expect(started.agent.status).toBe("running")
    expect(delivered).toHaveLength(0)

    expect(await until(() => delivered.length > 0)).toBe(true)
    expect(delivered[0].output).toBe("result-1")
    expect(delivered[0].node.status).toBe("completed")
    expect(delivered[0].node.name).toBe("unit_tests")
    expect(delivered[0].node.path).toBe("/root/unit_tests")
  })

  test("wait_agent returns a signal summary and leaks no worker content", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    await runtime.spawn({ name: "alpha", task: "a", cwd: paths.cwd })

    const outcome = await runtime.waitForUpdate(4_000)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.message).toContain("alpha")
    expect(outcome.message).not.toContain("result-1")
  })

  test("wait_agent times out while workers are still running", async () => {
    const paths = await fixture()
    useFakePi()
    process.env.FIXTURE_HANG = "1"
    const runtime = makeRuntime(paths.parentSession)
    await runtime.spawn({ name: "stuck", task: "never finishes", cwd: paths.cwd })

    const outcome = await runtime.waitForUpdate(150)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.message).toBe("Wait timed out.")
  })

  test("wait_agent reports immediately when there are no live agents", async () => {
    const paths = await fixture()
    const runtime = makeRuntime(paths.parentSession)
    const outcome = await runtime.waitForUpdate(50)
    expect(outcome.timedOut).toBe(false)
    expect(outcome.message).toBe("No live agents.")
  })

  test("a second follow-up turn reports again", async () => {
    const paths = await fixture()
    useFakePi()
    const delivered: string[] = []
    const runtime = makeRuntime(paths.parentSession, (_node, output) => delivered.push(output))
    const started = await runtime.spawn({ name: "worker", task: "first", cwd: paths.cwd })
    expect(await until(() => delivered.length === 1)).toBe(true)

    await runtime.send(started.agent.id, "again", "followUp")
    expect(await until(() => delivered.length === 2)).toBe(true)
    expect(delivered).toEqual(["result-1", "result-2"])
  })

  test("steering an idle worker queues without starting a turn", async () => {
    const paths = await fixture()
    useFakePi()
    const delivered: string[] = []
    const runtime = makeRuntime(paths.parentSession, (_node, output) => delivered.push(output))
    const started = await runtime.spawn({ name: "worker", task: "first", cwd: paths.cwd })
    expect(await until(() => delivered.length === 1)).toBe(true)

    await runtime.send(started.agent.id, "note for later", "steer")
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(delivered).toHaveLength(1)

    // The queued note rides along with the next task instead of being lost.
    await runtime.send(started.agent.id, "second task", "followUp")
    expect(await until(() => delivered.length === 2)).toBe(true)
    const prompts = await spawnedPrompts(paths.root, started.agent.id)
    expect(prompts).toContain("note for later")
    expect(prompts.indexOf("note for later")).toBeLessThan(prompts.indexOf("second task"))
  })
})

describe("context inheritance", () => {
  test("forks a filtered copy of the supervisor session and drops tool payloads", async () => {
    const paths = await fixture()
    await seedParentSession(paths.parentSession)
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)

    const started = await runtime.spawn({ name: "worker", task: "写单测", cwd: paths.cwd })
    const argv = await spawnArgv(paths.root, started.agent.id)
    expect(argv).toContain("--fork")
    const fork = argv[argv.indexOf("--fork") + 1]
    // The fork source lives beside the worker, never the supervisor's own file.
    expect(fork).toBe(join(paths.root, "sessions", "subagents", started.agent.id, "fork-source.jsonl"))
    expect(fork).not.toBe(paths.parentSession)

    const content = await readFile(fork, "utf8")
    expect(content).toContain("把登录按钮改成蓝色")
    expect(content).toContain("改完了，顺便补个单测。")
    // Codex-style: the conversation is inherited, tool traffic is not.
    expect(content).not.toContain("SECRET_TOOL_PAYLOAD")
    expect(content).not.toContain("toolResult")

    const prompt = await spawnedPrompts(paths.root, started.agent.id)
    expect(prompt).toContain("你已继承父 agent 的完整对话上下文")
    expect(prompt).not.toContain("父 Agent 上下文")
  })

  test("the filtered fork is a linear chain so Pi can still walk it", async () => {
    const paths = await fixture()
    await seedParentSession(paths.parentSession)
    const { content } = filterForkSession(await readFile(paths.parentSession, "utf8"))
    const entries = content.trim().split("\n").map((line) => JSON.parse(line) as { id?: string; parentId?: string | null })
    const body = entries.slice(1)
    expect(body[0].parentId).toBeNull()
    for (let index = 1; index < body.length; index += 1) {
      expect(body[index].parentId).toBe(body[index - 1].id)
    }
  })

  test("context: isolated starts empty and still works without a parent session", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const isolated = await runtime.spawn({ name: "solo", task: "standalone", cwd: paths.cwd, context: "isolated" })
    expect(await spawnArgv(paths.root, isolated.agent.id)).not.toContain("--fork")
    expect(await spawnedPrompts(paths.root, isolated.agent.id)).not.toContain("你已继承")

    // Parent session file is never written in this fixture: Pi persists lazily.
    expect(existsSync(paths.parentSession)).toBe(false)
    const fallback = await runtime.spawn({ name: "fallback", task: "inherit anyway", cwd: paths.cwd })
    expect(await spawnArgv(paths.root, fallback.agent.id)).not.toContain("--fork")
  })
})

describe("agent addressing and lifecycle", () => {
  test("resolves targets by agent id or unique task name", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const started = await runtime.spawn({ name: "worker", task: "x", cwd: paths.cwd })

    expect(runtime.resolveAgentId(started.agent.id)).toBe(started.agent.id)
    expect(runtime.resolveAgentId("worker")).toBe(started.agent.id)
    expect(() => runtime.resolveAgentId("missing")).toThrow("找不到 agent")
    expect(() => runtime.resolveAgentId("  ")).toThrow("不能为空")
  })

  test("assigns Codex-style canonical paths and addresses them like Codex does", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const started = await runtime.spawn({ name: "unit_tests", task: "x", cwd: paths.cwd })

    expect(started.agent.path).toBe("/root/unit_tests")
    // The supervisor is /root, so its children hang directly off it.
    expect(runtime.selfPath).toBe("/root")
    // Absolute path, path relative to the supervisor, and the opaque id all work.
    expect(runtime.resolveAgentId("/root/unit_tests")).toBe(started.agent.id)
    expect(runtime.resolveAgentId("unit_tests")).toBe(started.agent.id)
    expect(runtime.resolveAgentId(started.agent.id)).toBe(started.agent.id)
    expect(() => runtime.resolveAgentId("/root/missing")).toThrow("找不到 agent")
    expect(runtime.liveAgentNames()).toEqual(["/root/unit_tests [running]"])
  })

  test("a worker's children hang off its own path, not the root", async () => {
    const paths = await fixture()
    useFakePi()
    // A worker process receives its path through PI_GUI_AGENT_PATH.
    const runtime = new SubagentRuntime("parent", () => {}, paths.parentSession, { selfPath: "/root/researcher" })
    runtimes.push(runtime)
    const child = await runtime.spawn({ name: "worker", task: "x", cwd: paths.cwd })
    expect(child.agent.path).toBe("/root/researcher/worker")
    expect(runtime.resolveAgentId("worker")).toBe(child.agent.id)
    expect(runtime.resolveAgentId("/root/researcher/worker")).toBe(child.agent.id)
    expect(runtime.liveAgentNames()).toEqual(["/root/researcher/worker [running]"])
  })

  test("rejects a task name that cannot be an agent path segment", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    // Codex rejects rather than rewrites, so the model learns the rule.
    await expect(runtime.spawn({ name: "unit-tests", task: "x", cwd: paths.cwd })).rejects.toThrow("lowercase letters")
    await expect(runtime.spawn({ name: "root", task: "x", cwd: paths.cwd })).rejects.toThrow("reserved")
    expect(runtime.snapshot().active).toHaveLength(0)
  })

  test("rejects ambiguous task names instead of guessing", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    await runtime.spawn({ name: "dup", task: "one", cwd: paths.cwd })
    await runtime.spawn({ name: "dup", task: "two", cwd: paths.cwd })
    expect(() => runtime.resolveAgentId("dup")).toThrow("不唯一")
  })

  test("interrupts a running worker and publishes an aborted state", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const started = await runtime.spawn({ name: "long", task: "never", cwd: paths.cwd })
    expect(runtime.snapshot().active).toHaveLength(1)

    const interrupted = await runtime.interrupt(started.agent.id)
    expect(interrupted.status).toBe("aborted")
    expect(runtime.snapshot().active).toHaveLength(0)
    expect(runtime.snapshot().recent[0]?.endedAt).toEqual(expect.any(Number))
  })

  test("a new user turn never kills workers, and eviction only touches finished ones", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)

    // A live worker must survive a new user turn. The GUI sends its mode-sync
    // prompts concurrently with the user's message, so reclaiming on input once
    // raced a spawn and killed running workers.
    process.env.FIXTURE_HANG = "1"
    const running = await runtime.spawn({ name: "busy", task: "long", cwd: paths.cwd })
    runtime.beginUserTurn()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runtime.snapshot().active.map((node) => node.id)).toEqual([running.agent.id])
    expect(runtime.resolveAgentId(running.agent.id)).toBe(running.agent.id)
  })

  test("eviction bounds live processes without touching active workers", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const started = []
    for (let index = 0; index < 13; index += 1) {
      started.push(await runtime.spawn({ name: `w${index}`, task: "quick", cwd: paths.cwd }))
      expect(await until(() => runtime.snapshot().recent.length === index + 1)).toBe(true)
    }
    // The oldest finished worker is gone; the newest is still addressable.
    expect(() => runtime.resolveAgentId(started[0].agent.id)).toThrow()
    expect(runtime.resolveAgentId(started[12].agent.id)).toBe(started[12].agent.id)
  })

  test("delivers each worker result through pi.sendMessage with turn triggering", async () => {
    const paths = await fixture()
    await seedParentSession(paths.parentSession)
    useFakePi()

    const registered = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
    const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> | undefined }> = []
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const pi = {
      registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => registered.set(tool.name, tool),
      on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
      getActiveTools: () => [...SUBAGENT_TOOL_NAMES],
      sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => sent.push({ message, options }),
    }
    registerSubagentTools(pi as never)

    const statuses: string[] = []
    const ctx = {
      cwd: paths.cwd,
      model: { provider: "fixture", id: "m" },
      thinkingLevel: "off",
      sessionManager: { getSessionId: () => "parent", getSessionFile: () => paths.parentSession },
      ui: { setStatus: (key: string) => statuses.push(key) },
    }

    const result = (await registered.get("spawn_agent")!.execute("call-1", { task_name: "worker", message: "do it" }, undefined, undefined, ctx)) as {
      content: Array<{ text: string }>
    }
    // The tool result is an acknowledgement, not the answer.
    expect(result.content[0].text).toContain("will arrive as a separate FINAL_ANSWER message")
    expect(result.content[0].text).not.toContain("result-1")
    expect(sent).toHaveLength(0)

    expect(await until(() => sent.length > 0)).toBe(true)
    const delivered = sent[0]
    expect(delivered.message.customType).toBe("subagent_result")
    expect(delivered.message.content).toEqual([{ type: "text", text: expect.stringContaining("Message Type: FINAL_ANSWER") }])
    expect((delivered.message.content as Array<{ text: string }>)[0].text).toContain("result-1")
    // Codex's delivery contract: inject into context and start a turn if idle.
    expect(delivered.options).toEqual({ triggerTurn: true })
    // The payload stays visible so the work fold can show it; it must not be
    // hidden, or the report would be unreachable outside the child session.
    expect(delivered.message.display).toBe(true)
    expect(statuses).toContain("gui-agents")
  })

  test("a new top-level user turn resets the tree, but an injected result does not", async () => {
    useFakePi()
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>()
    const pi = { registerTool: () => {}, on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler), getActiveTools: () => [], sendMessage: () => {} }
    registerSubagentTools(pi as never)
    const input = handlers.get("input")!
    // Only real user input resets; extension-injected results and streaming
    // steers must leave the running tree alone.
    expect(await input({ streamable: true, source: "rpc", streamingBehavior: "steer" }, {})).toBeUndefined()
    expect(await input({ source: "extension" }, {})).toBeUndefined()
    expect(await input({ source: "rpc" }, {})).toBeUndefined()
  })

  test("restores capability-bearing built-ins without re-enabling extension discovery", async () => {
    const paths = await fixture()
    useFakePi()
    const runtime = makeRuntime(paths.parentSession)
    const started = await runtime.spawn({ name: "worker", task: "x", cwd: paths.cwd })
    const argv = await spawnArgv(paths.root, started.agent.id)

    // `--no-extensions` stays: discovery must remain off so Orbit's own GUI
    // extension cannot register itself inside a worker.
    expect(argv).toContain("--no-extensions")
    // ...but the built-ins a worker needs to match its supervisor come back.
    const extensions = argv.flatMap((arg, index) => (arg === "--extension" ? [argv[index + 1]] : []))
    expect(extensions).toContain("builtin:mcp")
    expect(extensions).toContain("builtin:codemode")
    expect(extensions).toContain("builtin:tool-search")
    expect(extensions).toContain("builtin:llama.cpp")
    // The worker's own control surface is the only file extension.
    expect(extensions.filter((name) => name.endsWith(".ts"))).toHaveLength(1)
    expect(extensions.some((name) => name.includes("gui-extension"))).toBe(false)
  })

  test("publishes snapshots for the activity panel", async () => {
    const paths = await fixture()
    useFakePi()
    const snapshots: AgentSnapshot[] = []
    const runtime = makeRuntime(paths.parentSession, undefined, (snapshot) => snapshots.push(structuredClone(snapshot)))
    const started = await runtime.spawn({ name: "worker", task: "inspect", cwd: paths.cwd })
    // Snapshot publication is throttled to 64 ms, so poll rather than assume.
    expect(await until(() => snapshots.some((snapshot) => snapshot.active.some((agent) => agent.status === "running")))).toBe(true)
    expect(started.agent.sessionPath).toContain("/subagents/")
  })
})

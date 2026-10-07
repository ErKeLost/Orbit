import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DesktopDriver, DesktopEnvelope } from "../src-tauri/resources/computer-use/desktop-driver"
import { createFileMemory, createInMemoryMemory, matchStep, memoryIdentity, memoryKey } from "../src-tauri/resources/computer-use/affordance-memory"
import { attachMedia } from "../src-tauri/resources/computer-use/desktop-observation"
import { runGuiTaskEngine } from "./helpers/gui-task-engine"
import type { DesktopCandidate, DesktopDecision, DesktopObservation, GuiTaskInput } from "../src-tauri/resources/computer-use/gui-task-contract"

const task = (overrides: Partial<GuiTaskInput> = {}): GuiTaskInput => ({
  goal: "search for the prepared song and play it",
  target: { app: "Music" },
  textSlots: [{ id: "query", value: "private song", description: "song search query" }],
  budget: { maxActions: 6, maxDecisions: 10, maxDurationMs: 30_000 },
  ...overrides,
})

const obs = (fingerprint: string, candidates: DesktopCandidate[], overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  app: "Music", windowId: "w-1", title: "Music", surface: "window", complete: true, capturedAt: Date.now(),
  candidates, context: "Music window", fingerprint, treeFingerprint: fingerprint, tree: { role: "window" }, ...overrides,
})

const choice = (operation: DesktopDecision["operation"], candidateId: string, extra: Partial<DesktopDecision> = {}): DesktopDecision => ({
  operation, candidateId, confidence: 0.9, model: "jev-test", latencyMs: 1, probabilities: { [candidateId]: 1 }, usage: { inputTokens: 1, outputTokens: 1 }, ...extra,
})

const resolveApp = async () => ({ displayName: "Music", bundleId: "test.music", path: "/Applications/Music.app", launchId: "test.music" })

function client(handler: (args: string[]) => DesktopEnvelope | Promise<DesktopEnvelope>, _legacyBackend?: string): DesktopDriver {
  return { run: async <T>(args: string[]) => await handler(args) as DesktopEnvelope<T>, dispose: async () => undefined }
}

const ok = (command: string, data: Record<string, unknown> = {}): DesktopEnvelope => ({ version: "1", ok: true, command, data: { app: "Music", pid: 1, ...data } })

const search = (ref: string): DesktopCandidate => ({ id: "type", operation: "SET_VALUE", ref, slotId: "query", description: "Search", criteria: { what: "textfield \"Search\"", supports: "SetValue" } })
const play = (ref: string, extra: Record<string, string> = {}): DesktopCandidate => ({ id: "play", operation: "CLICK", ref, description: "Play", criteria: { what: "button \"Play\"", supports: "Click", ...extra } })
const done: DesktopCandidate = { id: "done", operation: "DONE", description: "done" }

describe("event-driven settle", () => {
  test("uses the worker settle report and observes exactly once after an action", async () => {
    const commands: string[][] = []
    const c = client(args => {
      commands.push(args)
      if (args[0] === "launch") return ok("launch")
      if (args[0] === "now-playing") return ok("now-playing", { available: false })
      return ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" }, settle: { supported: true, changed: true, events: 3, notifications: ["ValueChanged"], ms: 120 } })
    }, "xa11y")
    let observeCalls = 0
    const skipMedia: boolean[] = []
    const result = await runGuiTaskEngine({
      input: task(), client: c, resolveApp,
      observe: async (_client, input) => {
        observeCalls++
        skipMedia.push(Boolean(input.skipMedia))
        return observeCalls === 1 ? obs("before", [search("@s1:e1"), done]) : obs("after", [search("@s2:e1"), done])
      },
      decide: async (_goal, candidates) => candidates.some(c => c.operation === "SET_VALUE") && observeCalls === 1 ? choice("SET_VALUE", "type") : choice("DONE", "done"),
      assessRisk: async () => ({ probability: 0.1, model: "t", latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 } }),
    })
    expect(result.status).toBe("done")
    // one initial observation + exactly one settled observation (no polling)
    expect(observeCalls).toBe(2)
    expect(skipMedia).toEqual([false, true])
    const action = commands.find(args => args[0] === "set-value")!
    expect(action).toContain("--settle-timeout-ms")
    expect(result.metrics.settleEvents).toBe(3)
  })

  test("falls back to polling when the worker cannot observe notifications", async () => {
    const c = client(args => {
      if (args[0] === "launch") return ok("launch")
      if (args[0] === "now-playing") return ok("now-playing", { available: false })
      return ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" }, settle: { supported: false, changed: false, events: 0, ms: 0 } })
    }, "xa11y")
    let observeCalls = 0
    const result = await runGuiTaskEngine({
      input: task(), client: c, resolveApp,
      observe: async () => {
        observeCalls++
        // unchanged for two polls, then changes
        return observeCalls <= 3 ? obs("before", [search(`@s${observeCalls}:e1`), done]) : obs("after", [done])
      },
      decide: async (_goal, candidates) => candidates.some(c => c.operation === "SET_VALUE") ? choice("SET_VALUE", "type") : choice("DONE", "done"),
      assessRisk: async () => ({ probability: 0.1, model: "t", latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 } }),
    })
    expect(result.status).toBe("done")
    expect(observeCalls).toBe(4)
  })

  test("attachMedia completes a settle observation with the media fact", () => {
    const base = obs("x", [done], { context: "app=Music\ncandidates=1\n1. Play", mediaSkipped: true, treeFingerprint: "tree" })
    const withMedia = attachMedia(base, "system_now_playing: title=\"a\" state=playing")
    const without = attachMedia(base, undefined)
    expect(withMedia.context).toContain("candidates=1\nsystem_now_playing")
    expect(withMedia.mediaSkipped).toBeUndefined()
    expect(withMedia.fingerprint).not.toBe(without.fingerprint)
  })
})

describe("risk cache and new markers", () => {
  test("passes cached risks back to Jev and skips separate risk calls", async () => {
    const c = client(args => args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" } }))
    let step = 0
    const known: Array<Record<string, number>> = []
    let riskCalls = 0
    await runGuiTaskEngine({
      input: task({ textSlots: [], budget: { maxActions: 2, maxDecisions: 4, maxDurationMs: 30_000 } }), client: c, resolveApp,
      observe: async () => obs(`s${step}`, [play(`@s${step}:e1`), done]),
      decide: async (_g, _c, _ctx, _h, _s, options) => {
        known.push({ ...(options?.knownRisks ?? {}) })
        step++
        return step === 1 ? choice("CLICK", "play", { risk: 0.2, risks: { play: 0.2 } }) : choice("CLICK", "play")
      },
      assessRisk: async () => { riskCalls++; return { probability: 0.1, model: "t", latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0 } } },
    })
    expect(known[0]).toEqual({})
    expect(known[1]).toEqual({ play: 0.2 })
    expect(riskCalls).toBe(0)
  })

  test("marks targets that appeared after the last action as new", async () => {
    const c = client(args => args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" } }))
    let observeCalls = 0
    const seen: DesktopCandidate[][] = []
    const menuItem: DesktopCandidate = { id: "item", operation: "CLICK", ref: "@s2:m1", description: "Add to playlist", criteria: { what: "menu_item \"Add to playlist\"", supports: "Click" } }
    const others = Array.from({ length: 4 }, (_, i): DesktopCandidate => ({ id: `o${i}`, operation: "CLICK", ref: `@s:o${i}`, description: `o${i}`, criteria: { what: `button "o${i}"` } }))
    await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: c, resolveApp,
      observe: async () => {
        observeCalls++
        return observeCalls === 1 ? obs("a", [play("@s1:e1"), ...others, done]) : obs("b", [play("@s2:e1"), ...others, menuItem, done])
      },
      decide: async (_g, candidates) => {
        seen.push(candidates)
        return seen.length === 1 ? choice("CLICK", "play", { risk: 0.1 }) : choice("DONE", "done")
      },
    })
    const second = seen[1]
    expect(second.find(c => c.id === "item")?.criteria?.new).toBe("appeared after the last action")
    expect(second.find(c => c.id === "play")?.criteria?.new).toBeUndefined()
  })
})

describe("affordance memory", () => {
  const slots = task().textSlots!

  test("identity ignores volatile fields and redacts slot values", () => {
    const a: DesktopCandidate = { ...play("@s1:e1"), criteria: { what: "row \"private song\"", state: "selected", holds: "x", new: "y", at: "1,2" } }
    const b: DesktopCandidate = { ...play("@s9:e4"), criteria: { what: "row \"private song\"" } }
    expect(memoryIdentity(a, slots)).toBe(memoryIdentity(b, slots))
    expect(memoryIdentity(a, slots)).not.toContain("private song")
    expect(memoryKey("Music", "play private song", slots, false)).not.toContain("private song")
  })

  test("matchStep requires a unique target", () => {
    const step = { operation: "CLICK" as const, identity: memoryIdentity(play("@a"), slots) }
    expect(matchStep(step, [play("@s1:e1")], slots)?.ref).toBe("@s1:e1")
    expect(matchStep(step, [play("@s1:e1"), { ...play("@s1:e2"), id: "p2" }], slots)).toBeUndefined()
  })

  const scenario = () => {
    let phase = 0
    const c = client(args => args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" } }))
    const observe = async () => {
      const state = phase === 0 ? obs("p0", [search(`@s${phase}:e1`), done]) : phase === 1 ? obs("p1", [play("@s1:e2"), done]) : obs("p2", [done])
      return state
    }
    const advance = () => { phase++ }
    return { c, observe, advance, reset: () => { phase = 0 } }
  }

  test("learns a done trajectory and replays it with a single Jev DONE check", async () => {
    const memory = createInMemoryMemory()
    const s = scenario()
    const wrap = (c: DesktopDriver): DesktopDriver => ({ ...c, run: async <T>(args: string[]) => { const r = await c.run<T>(args); if (args[0] !== "launch") s.advance(); return r } })
    let jev = 0
    const decide = async (_g: string, candidates: DesktopCandidate[]) => {
      jev++
      if (candidates.some(c => c.operation === "SET_VALUE")) return choice("SET_VALUE", "type", { risk: 0.1 })
      if (candidates.some(c => c.operation === "CLICK")) return choice("CLICK", "play", { risk: 0.1 })
      return choice("DONE", "done")
    }
    const first = await runGuiTaskEngine({ input: task(), client: wrap(s.c), resolveApp, observe: s.observe, decide, memory })
    expect(first.status).toBe("done")
    expect(jev).toBe(3)
    await new Promise(r => setTimeout(r, 0))
    expect([...memory.entries.values()][0].steps.map(step => step.operation)).toEqual(["SET_VALUE", "CLICK"])

    s.reset(); jev = 0
    const second = await runGuiTaskEngine({ input: task(), client: wrap(s.c), resolveApp, observe: s.observe, decide, memory })
    expect(second.status).toBe("done")
    expect(jev).toBe(1)
    expect(second.metrics.replayedSteps).toBe(2)
    expect(second.metrics.jevCalls).toBe(1)
    expect(second.trace.filter(t => t.source === "memory")).toHaveLength(2)
  })

  test("self-heals: a remembered step without a match falls back to Jev and records a failure", async () => {
    const memory = createInMemoryMemory()
    const key = memoryKey("Music", task().goal, [], false)
    await memory.recordSuccess(key, [{ operation: "CLICK", identity: memoryIdentity({ ...play("@x"), criteria: { what: "button \"Gone\"" } }, []) }])
    let jev = 0
    const c = client(args => args[0] === "launch" ? ok("launch") : ok(args[0]))
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: c, resolveApp, memory,
      observe: async () => obs("p", [play("@s1:e1"), done]),
      decide: async () => { jev++; return choice("DONE", "done") },
    })
    expect(result.status).toBe("done")
    expect(jev).toBe(1)
    expect(memory.entries.get(key)!.failures).toBe(1)
    expect(result.trace.some(t => t.note?.includes("memory replay stopped"))).toBe(true)
  })

  test("remembered risky steps still require confirmation", async () => {
    const memory = createInMemoryMemory()
    const key = memoryKey("Music", task().goal, slots, false)
    await memory.recordSuccess(key, [{ operation: "CLICK", identity: memoryIdentity(play("@x"), slots), risk: 0.9 }])
    const commands: string[] = []
    const c = client(args => { commands.push(args[0]); return ok(args[0]) })
    const result = await runGuiTaskEngine({
      input: task(), client: c, resolveApp, memory,
      observe: async () => obs("p", [play("@s1:e1"), done]),
      decide: async () => choice("DONE", "done"),
    })
    expect(result.status).toBe("needs_review")
    expect(commands).toEqual(["launch"])
  })

  test("file memory persists without slot values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cu-mem-"))
    try {
      const path = join(dir, "m.json")
      const key = memoryKey("Music", "play private song", slots, false)
      await createFileMemory(path).recordSuccess(key, [{ operation: "CLICK", identity: memoryIdentity(play("@x"), slots) }])
      const reloaded = await createFileMemory(path).lookup(key)
      expect(reloaded?.steps).toHaveLength(1)
      expect(await Bun.file(path).text()).not.toContain("private song")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("loop guard", () => {
  test("stops an A,B,A,B,A,B mutation cycle", async () => {
    const c = client(args => args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" } }))
    let step = 0
    const histories: string[][] = []
    const a: DesktopCandidate = { id: "a", operation: "CLICK", ref: "@s:a", description: "Delete", criteria: { what: "button \"Delete\"" } }
    const bb: DesktopCandidate = { id: "b", operation: "CLICK", ref: "@s:b", description: "Confirm", criteria: { what: "button \"Confirm\"" } }
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [], budget: { maxActions: 20, maxDecisions: 30, maxDurationMs: 30_000 } }), client: c, resolveApp,
      observe: async () => obs(`s${step}`, [a, bb, done]),
      decide: async (_g, _c, _ctx, history) => { histories.push(history); step++; return choice("CLICK", step % 2 ? "a" : "b", { risk: 0.1 }) },
    })
    expect(result.status).toBe("blocked")
    expect(result.actions).toBe(6)
    expect(histories.some(h => h.some(line => line.includes("second time")))).toBe(true)
  })
})

describe("replay waits for loading targets", () => {
  test("re-observes until a remembered target appears instead of abandoning replay", async () => {
    const memory = createInMemoryMemory()
    const key = memoryKey("Music", task().goal, [], false)
    const open: DesktopCandidate = { id: "open", operation: "CLICK", ref: "@s:r", description: "Result", criteria: { what: "table_cell \"Result\"" } }
    const go: DesktopCandidate = { id: "go", operation: "CLICK", ref: "@s:go", description: "Search", criteria: { what: "button \"Search\"" } }
    await memory.recordSuccess(key, [{ operation: "CLICK", identity: memoryIdentity(go, []) }, { operation: "CLICK", identity: memoryIdentity(open, []) }])
    let phase = 0
    let loadingPolls = 0
    const c = client(args => { if (args[0] !== "launch") phase++; return args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_verified", retry: "never" } }) })
    let jev = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: c, resolveApp, memory,
      observe: async () => {
        if (phase === 0) return obs("home", [go, done])
        if (phase === 1 && loadingPolls++ < 3) return obs(`loading${loadingPolls}`, [go, done])
        return obs(`p${phase}`, phase === 1 ? [go, open, done] : [done])
      },
      decide: async () => { jev++; return choice("DONE", "done") },
    })
    expect(result.status).toBe("done")
    expect(result.metrics.replayedSteps).toBe(2)
    expect(jev).toBe(1)
  })
})

describe("parameterized memory", () => {
  test("learns a template from sibling targets named in the goal and binds a new value", async () => {
    const memory = createInMemoryMemory()
    const { parameterize, lookupTemplate } = await import("../src-tauri/resources/computer-use/affordance-memory")
    const row = (name: string): DesktopCandidate => ({ id: name, operation: "CLICK", ref: `@s:${name}`, description: name, criteria: { what: `table_cell "${name}"`, sibling: "item 2 of 4" } })
    const steps = [{ operation: "CLICK" as const, identity: memoryIdentity(row("李四"), []) }]
    const template = parameterize("Chat", "给李四发一条问候", [], false, steps, ["李四"])!
    expect(template.key).toContain("给{v1}发一条问候")
    await memory.recordSuccess(template.key, template.steps)
    const bound = await lookupTemplate(memory, "Chat", "给王五发一条问候", [], false)
    expect(bound).toBeDefined()
    expect(matchStep(bound!.entry.steps[0], [row("张三"), row("王五")], [])?.id).toBe("王五")
    expect(await lookupTemplate(memory, "Chat", "删除王五", [], false)).toBeUndefined()
  })
})

describe("V4 decision shortcuts", () => {
  const changing = () => {
    let step = 0
    const c = client(args => { if (args[0] !== "launch") step++; return args[0] === "launch" ? ok("launch") : ok(args[0], { disposition: { delivery: "delivered_unverified", retry: "never" } }) })
    return { c, step: () => step }
  }

  test("finishes on predicted completion with local evidence, saving the DONE request", async () => {
    const { c, step } = changing()
    let jev = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: c, resolveApp,
      observe: async () => step() === 0 ? obs("before", [play("@s0:p"), done], { tree: { role: "window", children: [] } }) : obs("after", [done], { tree: { role: "window", children: [{ role: "static_text", name: "Now playing" }] } }),
      decide: async () => { jev++; return choice("CLICK", "play", { risk: 0.1, completesGoal: 0.9 }) },
    })
    expect(result.status).toBe("done")
    expect(jev).toBe(1)
    expect(result.trace[0].outcome).toContain("goal_verified_by_prediction")
  })

  test("does not accept predicted completion when an alert appeared or text is undelivered", async () => {
    const { c, step } = changing()
    let jev = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: c, resolveApp,
      observe: async () => step() === 0 ? obs("before", [play("@s0:p"), done], { tree: { role: "window", children: [] } }) : obs("after", [done], { tree: { role: "window", children: [{ role: "alert", name: "Error" }] } }),
      decide: async () => { jev++; return jev === 1 ? choice("CLICK", "play", { risk: 0.1, completesGoal: 0.95 }) : choice("DONE", "done") },
    })
    expect(result.status).toBe("done")
    expect(jev).toBe(2)
    const slotted = changing()
    let jev2 = 0
    const second = await runGuiTaskEngine({
      input: task(), client: slotted.c, resolveApp,
      observe: async () => slotted.step() === 0 ? obs("before", [play("@s0:p"), search("@s0:s"), done], { tree: { role: "window", children: [] } }) : obs("after", [search("@s1:s"), done], { tree: { role: "window", children: [{ role: "static_text", name: "x" }] } }),
      decide: async () => { jev2++; return jev2 === 1 ? choice("CLICK", "play", { risk: 0.1, completesGoal: 0.95 }) : choice("DONE", "done") },
    })
    expect(second.trace.some(t => t.outcome?.includes("goal_verified_by_prediction"))).toBe(false)
  })

  test("menu bar commands are offered as MENU_ITEM and pressed by exact path", async () => {
    const { observeDesktop } = await import("../src-tauri/resources/computer-use/desktop-observation")
    const commands: string[][] = []
    const snapshot = { app: "Editor", complete: true, ref_count: 1, snapshot_id: "s", window: { id: "w", title: "Doc" }, tree: { role: "application", children: [{ role: "window", name: "Doc", ref_id: "@s:w", children_count: 1, children: [{ role: "button", name: "Save", ref_id: "@s:b", available_actions: ["Click"] }] }] } }
    const c = client(args => {
      commands.push(args)
      if (args[0] === "snapshot") return { version: "1", ok: true, command: "snapshot", data: snapshot as unknown as Record<string, unknown> }
      if (args[0] === "menubar") return ok("menubar", { items: [{ path: ["File", "Save"], enabled: true }, { path: ["File", "Export", "PDF…"], enabled: true, shortcut: "⌘E" }, { path: ["File", "Print"], enabled: false }, { path: ["App", "Quit"], enabled: true, shortcut: "⌘Q" }] })
      if (args[0] === "now-playing") return ok("now-playing", { available: false })
      return ok(args[0])
    }, "xa11y")
    const result = await observeDesktop(c, { app: "Editor", goal: "export as PDF", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false }, { timeoutMs: 5000 })
    const menus = result.candidates.filter(candidate => candidate.operation === "MENU_ITEM")
    expect(menus.map(m => m.menuPath?.join(">"))).toEqual(["File>Export>PDF…"])
    expect(menus[0].criteria?.shortcut).toBe("⌘E")
  })
})

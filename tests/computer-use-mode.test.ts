import { describe, expect, test } from "bun:test"
import { AgentDesktopCommandError, type AgentDesktopClient, type DesktopEnvelope, type SnapshotData } from "../src-tauri/resources/computer-use/agent-desktop-client"
import { observeDesktop } from "../src-tauri/resources/computer-use/desktop-observation"
import { selectInstalledDesktopApp, type InstalledDesktopApp } from "../src-tauri/resources/computer-use/desktop-app-resolver"
import { runGuiTaskEngine } from "../src-tauri/resources/computer-use/gui-task-engine"
import { formatResult } from "../src-tauri/resources/computer-use/gui-task"
import { validateTaskInput, type DesktopDecision, type DesktopObservation, type GuiTaskInput } from "../src-tauri/resources/computer-use/gui-task-contract"
import { isRetryableJevError, redactLocalSlots } from "../src-tauri/resources/computer-use/jev"
import { applyComputerUseMode, COMPUTER_USE_INSTRUCTIONS } from "../src-tauri/resources/computer-use/mode"

const task = (overrides: Partial<GuiTaskInput> = {}): GuiTaskInput => ({
  goal: "search for the prepared song and play it",
  target: { app: "Music" },
  textSlots: [{ id: "query", value: "private song", description: "song search query" }],
  budget: { maxActions: 5, maxDecisions: 8, maxDurationMs: 30_000 },
  ...overrides,
})

const observation = (fingerprint: string, candidates: DesktopObservation["candidates"], overrides: Partial<DesktopObservation> = {}): DesktopObservation => ({
  app: "Music",
  windowId: "w-1",
  title: "Music",
  surface: "window",
  complete: true,
  capturedAt: Date.now(),
  candidates,
  context: "Music window",
  fingerprint,
  tree: { role: "window" },
  ...overrides,
})

const choice = (operation: DesktopDecision["operation"], candidateId: string): DesktopDecision => ({
  operation,
  candidateId,
  confidence: 0.9,
  model: "jev-test",
  latencyMs: 1,
  probabilities: { [candidateId]: 1 },
  usage: { inputTokens: 1, outputTokens: 1 },
})

const resolveApp = async () => ({ displayName: "Music", bundleId: "test.music", path: "/Applications/Music.app", launchId: "test.music" })

function mockClient(handler: (args: string[]) => DesktopEnvelope | Promise<DesktopEnvelope>, backend?: string): AgentDesktopClient {
  return {
    ...(backend ? { backend } : {}),
    run: async <T>(args: string[]) => await handler(args) as DesktopEnvelope<T>,
    dispose: async () => undefined,
  }
}

describe("computer use tool surface", () => {
  test("toggles only the one desktop tool", () => {
    expect(applyComputerUseMode(["read", "gui_task"], ["read", "gui_task"], false)).toEqual(["read"])
    expect(applyComputerUseMode(["read"], ["read", "gui_task"], true).sort()).toEqual(["gui_task", "read"])
  })

  test("exposes one goal instead of a caller-authored UI plan", () => {
    expect(COMPUTER_USE_INSTRUCTIONS).toContain("Do not plan UI phases")
    expect(COMPUTER_USE_INSTRUCTIONS).toContain("does not capture screenshots")
    expect(() => validateTaskInput(task())).not.toThrow()
    expect(() => validateTaskInput(task({ target: { app: "" } }))).toThrow("Invalid GUI task contract")
  })

  test("does not retry deterministic Jev request errors", () => {
    expect(isRetryableJevError(new Error("Jev target request rejected: 400 max_tokens_exceeded"))).toBe(false)
    expect(isRetryableJevError(new Error("Jev operation request rejected: fetch failed"))).toBe(true)
  })
})

describe("installed app resolver", () => {
  const calendar: InstalledDesktopApp = { displayName: "日历", bundleId: "com.apple.iCal", path: "/System/Applications/Calendar.app", launchId: "com.apple.iCal" }
  const chrome: InstalledDesktopApp = { displayName: "Google Chrome", bundleId: "com.google.Chrome", path: "/Applications/Google Chrome.app", launchId: "com.google.Chrome" }

  test("uses the localized display name as a local fact without calling Jev", async () => {
    let calls = 0
    const result = await selectInstalledDesktopApp("日历", [calendar], async () => [calendar], async () => { calls++; return null })
    expect(result.launchId).toBe("com.apple.iCal")
    expect(calls).toBe(0)
  })

  test("uses the bundle filename as an exact local identity", async () => {
    const result = await selectInstalledDesktopApp("Calendar", [calendar], async () => [calendar], async () => null)
    expect(result).toBe(calendar)
  })

  test("lets Jev choose only among real bounded candidates when the intent is semantic", async () => {
    const result = await selectInstalledDesktopApp("浏览器", [], async () => [calendar, chrome], async candidates => {
      expect(candidates).toHaveLength(2)
      return "app-1"
    })
    expect(result).toBe(chrome)
  })

  test("refuses a missing or ambiguous target instead of guessing", async () => {
    await expect(selectInstalledDesktopApp("不存在的应用", [], async () => [calendar, chrome], async () => null)).rejects.toThrow("unambiguously")
  })
})

describe("AX-first desktop observation", () => {
  test("builds compatible candidates from a skeleton without exposing local text", async () => {
    let command: string[] = []
    const snapshot: SnapshotData = {
      app: "Music",
      complete: true,
      ref_count: 3,
      snapshot_id: "s1",
      window: { id: "w-1", title: "Music" },
      tree: {
        role: "window",
        name: "Music",
        children: [{
          role: "textfield",
          name: "Song input",
          ref_id: "@s1:e1",
          available_actions: ["SetValue", "TypeText"],
        }, {
          role: "button",
          name: "Play",
          ref_id: "@s1:e2",
          available_actions: ["Click"],
        }, {
          role: "group",
          name: "Results",
          ref_id: "@s1:e3",
          children_count: 20,
          available_actions: ["ScrollTo"],
        }, {
          role: "textfield",
          name: "Password",
          ref_id: "@s1:e4",
          states: ["secure"],
          available_actions: ["SetValue", "TypeText"],
        }],
      },
    }
    const client = mockClient(args => {
      command = args
      return { version: "2.4", ok: true, command: "snapshot", data: snapshot }
    })
    const result = await observeDesktop(client, {
      app: "Music",
      textSlots: [{ id: "query", value: "private song", description: "song search query" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(command).toContain("--skeleton")
    expect(command).not.toContain("screenshot")
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "TYPE_TEXT", ref: "@s1:e1", slotId: "query" }),
    ]))
    expect(result.candidates.some(candidate => candidate.ref === "@s1:e2")).toBe(true)
    expect(JSON.stringify(result)).not.toContain("private song")
    expect(result.candidates.some(candidate => candidate.ref === "@s1:e4" && candidate.operation === "TYPE_TEXT")).toBe(false)
  })

  test("keeps SetValue for native text areas that do not expose TypeText", async () => {
    const snapshot: SnapshotData = {
      app: "WeChat",
      complete: true,
      ref_count: 1,
      snapshot_id: "s1",
      window: { id: "w-1", title: "WeChat" },
      tree: {
        role: "window",
        name: "WeChat",
        children: [{
          role: "text_area",
          name: "大儿子",
          ref_id: "@s1:e1",
          states: ["editable"],
          available_actions: ["SetFocus", "SetValue"],
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "WeChat",
      textSlots: [{ id: "message", value: "我是奥特曼", description: "message body" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "SET_VALUE", ref: "@s1:e1", slotId: "message" }),
    ]))
  })

  test("offers physical typing for web fields that expose only SetValue", async () => {
    const snapshot: SnapshotData = {
      app: "SodaMusic",
      complete: true,
      ref_count: 1,
      snapshot_id: "s1",
      window: { id: "w-1", title: "SodaMusic" },
      tree: {
        role: "window",
        name: "SodaMusic",
        children: [{
          role: "webarea",
          name: "SodaMusic",
          children: [{
            role: "text_field",
            ref_id: "@s1:e1",
            states: ["editable"],
            available_actions: ["SetFocus", "SetValue"],
          }],
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "SodaMusic",
      textSlots: [{ id: "query", value: "蓝", description: "song query" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "TYPE_TEXT", ref: "@s1:e1", slotId: "query", headed: true }),
    ]))
  })

  test("treats xa11y web_area content as web and keeps a prefilled field typeable", async () => {
    const snapshot: SnapshotData = {
      app: "SodaMusic",
      complete: true,
      ref_count: 3,
      snapshot_id: "s1",
      window: { id: "w-1", title: "SodaMusic" },
      tree: {
        role: "window",
        name: "SodaMusic",
        children: [{
          role: "web_area",
          available_actions: ["ScrollDownByPage"],
          children: [
            { role: "text_field", ref_id: "@s1:e1", value: "蓝", states: ["editable"], available_actions: ["SetFocus", "SetValue"] },
            ...[0, 1, 2].map(row => ({
              role: "group",
              ref_id: row === 0 ? "@s1:e2" : `@s1:row${row}`,
              bounds: { x: 0, y: 100 + row * 56, width: 800, height: 48 },
              available_actions: ["SetFocus"],
              children_count: 2,
              children: [
                { role: "static_text", value: row === 0 ? "蓝" : `song ${row}`, ref_id: `@s1:t${row}` },
                { role: "image", description: "/tos/cover.jpg", ref_id: `@s1:i${row}` },
              ],
            })),
            // A lone bar with time text and several children is not a row.
            {
              role: "group",
              ref_id: "@s1:bar",
              bounds: { x: 0, y: 900, width: 800, height: 48 },
              available_actions: ["SetFocus"],
              children_count: 3,
              children: [
                { role: "static_text", value: "00:28 / 01:37", ref_id: "@s1:time" },
                { role: "group", ref_id: "@s1:b1", bounds: { x: 300, y: 910, width: 24, height: 24 }, available_actions: ["SetFocus"] },
                { role: "group", ref_id: "@s1:b2", bounds: { x: 340, y: 905, width: 36, height: 36 }, available_actions: ["SetFocus"] },
              ],
            },
          ],
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "SodaMusic",
      textSlots: [{ id: "query", value: "蓝", description: "song query" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "TYPE_TEXT", ref: "@s1:e1", headed: true }),
      expect.objectContaining({ operation: "DOUBLE_CLICK", ref: "@s1:e2", headed: true }),
    ]))
    expect(result.candidates.some(candidate => candidate.operation === "SET_VALUE" && candidate.ref === "@s1:e1")).toBe(false)
    const row = result.candidates.find(candidate => candidate.ref === "@s1:e2")!
    expect(row.description).not.toContain("cover.jpg")
    expect(row.description).toContain("row 1 of 3 repeated same-shaped rows")
    expect(result.candidates.some(candidate => candidate.ref === "@s1:bar" && ["CLICK", "DOUBLE_CLICK"].includes(candidate.operation))).toBe(false)
    expect(result.candidates.some(candidate => candidate.ref === "@s1:bar" && candidate.operation === "DRILL")).toBe(true)
  })

  test("keeps quoted goal evidence visible beyond the first 32 text nodes", async () => {
    const snapshot: SnapshotData = {
      app: "Chat", complete: true, ref_count: 41, snapshot_id: "s1",
      window: { id: "w-1", title: "Chat" },
      tree: { role: "window", name: "Chat", children: [
        { role: "group", ref_id: "@s1:e1", available_actions: ["SetFocus"], children: [
          ...Array.from({ length: 36 }, (_, i) => ({ role: "static_text", name: `irrelevant-${i}` })),
          { role: "table_cell", name: "我说:我是蜘蛛侠", ref_id: "@s1:e2", available_actions: ["SetFocus"] },
        ] },
      ] },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "Chat", goal: "只读确认“我是蜘蛛侠”", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    expect(result.context).toContain("observed_goal_matches:")
    expect(result.context).toContain("table_cell 我说:我是蜘蛛侠")
  })

  test("keeps the observation bounded and marks locally matched targets", async () => {
    const snapshot: SnapshotData = {
      app: "WeChat",
      complete: true,
      ref_count: 100,
      snapshot_id: "s1",
      window: { id: "w-1", title: "WeChat" },
      tree: {
        role: "window",
        name: "WeChat",
        children: Array.from({ length: 100 }, (_, index) => ({
          role: "button",
          name: index === 90 ? "赵东升" : `联系人 ${index}`,
          ref_id: `@s1:e${index}`,
          available_actions: ["Click"],
        })),
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "WeChat",
      textSlots: [{ id: "recipient", value: "赵东升", description: "单人聊天联系人" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(result.context).toContain("candidate_space_truncated=true")
    expect(result.candidates.length).toBeLessThan(100)
    expect(result.candidates.find(candidate => candidate.criteria?.local_match)).toEqual(expect.objectContaining({
      criteria: expect.objectContaining({ local_match: expect.stringContaining("单人聊天联系人") }),
    }))
  })

  test("attaches structured identity criteria to node candidates", async () => {
    const snapshot: SnapshotData = {
      app: "Music",
      complete: true,
      ref_count: 2,
      snapshot_id: "s1",
      window: { id: "w-1", title: "Music" },
      tree: {
        role: "window",
        name: "Music",
        children: [{
          role: "button",
          name: "开启读屏标签",
          ref_id: "@s1:e1",
          states: ["offscreen"],
          available_actions: ["Click"],
        }, {
          role: "group",
          ref_id: "@s1:e2",
          children_count: 5,
          available_actions: ["Click"],
          bounds: { x: 10, y: 20, width: 100, height: 50 },
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "Music",
      textSlots: [],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    const button = result.candidates.find(candidate => candidate.ref === "@s1:e1")
    expect(button?.criteria?.what).toContain("开启读屏标签")
    expect(button?.criteria?.state).toBe("offscreen")
    expect(button?.criteria?.supports).toBe("Click")
    expect(button?.criteria?.at).toBeUndefined()
    const group = result.candidates.find(candidate => candidate.ref === "@s1:e2")
    expect(group?.criteria?.contains).toBe("5 items not shown")
    expect(group?.criteria?.at).toBeDefined()
    expect(result.candidates.find(candidate => candidate.operation === "WAIT")?.criteria).toBeUndefined()
  })

  test("keeps large structural regions drillable in complete skeletons", async () => {
    const snapshot: SnapshotData = {
      app: "WeChat",
      complete: true,
      ref_count: 2,
      snapshot_id: "s1",
      window: { id: "w-1", title: "WeChat" },
      tree: {
        role: "window",
        name: "WeChat",
        children: [{
          role: "split_group",
          ref_id: "@s1:e1",
          children_count: 6,
          available_actions: ["SetFocus"],
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "WeChat",
      textSlots: [{ id: "message", value: "hello", description: "message body" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })

    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "DRILL", ref: "@s1:e1" }),
    ]))
  })

  test("withholds inert wrapper clicks when a named control inside shares the label", async () => {
    const snapshot: SnapshotData = {
      app: "抖音",
      complete: true,
      ref_count: 3,
      snapshot_id: "s1",
      window: { id: "w-1", title: "抖音" },
      tree: {
        role: "window",
        name: "抖音",
        children: [{
          role: "group",
          ref_id: "@s1:e1",
          available_actions: ["Click"],
          children: [{
            role: "button",
            name: "开启读屏标签",
            ref_id: "@s1:e2",
            available_actions: ["Click"],
          }],
        }],
      },
    }
    const client = mockClient(args => {
      void args
      return { version: "2.4", ok: true, command: "snapshot", data: snapshot }
    })
    const result = await observeDesktop(client, {
      app: "抖音", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    const groupClicks = result.candidates.filter(candidate => candidate.ref === "@s1:e1" && candidate.operation === "CLICK")
    expect(groupClicks).toHaveLength(0)
    const buttonClicks = result.candidates.filter(candidate => candidate.ref === "@s1:e2" && candidate.operation === "CLICK")
    expect(buttonClicks.length).toBeGreaterThanOrEqual(1)
  })

  test("redacts local text from candidate criteria before Jev sees it", async () => {
    const commands: string[][] = []
    let seenCriteria: unknown
    const client = mockClient(args => {
      commands.push(args)
      return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1, window: { id: "w-1", title: "Music" } } }
    })
    const current = observation("field", [{ id: "type", operation: "TYPE_TEXT", ref: "@s1:e1", slotId: "query", description: "Search", criteria: { what: "textfield \"Search\"", holds: "private song" } }, { id: "done", operation: "DONE", description: "done" }])
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [{ id: "query", value: "private song", description: "song search query" }] }), client,
      observe: async () => current,
      decide: async (_goal, candidates) => {
        seenCriteria = candidates.find(candidate => candidate.id === "type")?.criteria
        return choice("DONE", "done")
      },
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(JSON.stringify(seenCriteria)).not.toContain("private song")
    expect(JSON.stringify(seenCriteria)).toContain("[slot:query]")
  })

  test("compiles context-menu and clear candidates only for the agent-desktop backend", async () => {
    const snapshot: SnapshotData = {
      app: "Music",
      complete: true,
      ref_count: 3,
      snapshot_id: "s1",
      window: { id: "w-1", title: "Music" },
      tree: {
        role: "window",
        name: "Music",
        children: [{
          role: "group",
          name: "song row",
          ref_id: "@s1:e1",
          available_actions: ["RightClick"],
        }, {
          role: "textfield",
          name: "搜索",
          ref_id: "@s1:e2",
          value: "leftover",
          available_actions: ["SetValue"],
        }, {
          role: "button",
          name: "更多",
          ref_id: "@s1:e3",
          available_actions: ["Click", "RightClick"],
        }],
      },
    }
    const envelope = { version: "2.4", ok: true, command: "snapshot", data: snapshot }
    const agentResult = await observeDesktop(mockClient(() => envelope, "agent-desktop"), { app: "Music", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false }, { timeoutMs: 5_000 })
    expect(agentResult.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "RIGHT_CLICK", ref: "@s1:e1" }),
      expect.objectContaining({ operation: "CLEAR", ref: "@s1:e2" }),
    ]))
    const xaResult = await observeDesktop(mockClient(() => envelope), { app: "Music", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false }, { timeoutMs: 5_000 })
    expect(xaResult.candidates.some(candidate => ["RIGHT_CLICK", "CLEAR"].includes(candidate.operation))).toBe(false)
  })

  test("routes multiline prepared text through set-value instead of physical typing", async () => {
    const snapshot: SnapshotData = {
      app: "Music",
      complete: true,
      ref_count: 1,
      snapshot_id: "s1",
      window: { id: "w-1", title: "Music" },
      tree: {
        role: "window",
        name: "Music",
        children: [{
          role: "textfield",
          name: "Composer",
          ref_id: "@s1:e1",
          available_actions: ["SetValue", "TypeText"],
        }],
      },
    }
    const result = await observeDesktop(mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot })), {
      app: "Music",
      textSlots: [{ id: "msg", value: "第一行\n第二行", description: "message body" }],
      usedSlotIds: new Set(),
      allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    expect(result.candidates.some(candidate => candidate.ref === "@s1:e1" && candidate.operation === "TYPE_TEXT")).toBe(false)
    expect(result.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ operation: "SET_VALUE", ref: "@s1:e1", slotId: "msg" }),
    ]))
  })
})

describe("local text evidence", () => {
  test("identifies matching slots without revealing values or rewriting generated markers", () => {
    const slots = [
      { id: "contact", value: "赵东升", description: "recipient" },
      { id: "message", value: "我是蜘蛛侠", description: "body" },
    ]
    const evidence = redactLocalSlots('text_area "赵东升"; table_cell "我说:我是蜘蛛侠"; value "赵东升"', slots)
    expect(evidence).toBe('text_area "[slot:contact]"; table_cell "我说:[slot:message]"; value "[slot:contact]"')
    expect(evidence).not.toContain("我是蜘蛛侠")
  })

  test("treats regex punctuation and overlapping slot values as literal text", () => {
    expect(redactLocalSlots("hello+world hello [slot:long]", [
      { id: "short", value: "hello", description: "short" },
      { id: "long", value: "hello+world", description: "long" },
    ])).toBe("[slot:long] [slot:short] [slot:long]")
  })
})

describe("desktop goal loop", () => {
  test("can finish a launch-only goal without inventing an action", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1, window: { id: "w-1", title: "Music" } } }
    })
    const ready = observation("ready", [{ id: "done", operation: "DONE", description: "done" }])
    const result = await runGuiTaskEngine({
      input: task({ goal: "open Music", textSlots: [] }),
      client,
      observe: async () => ready,
      decide: async () => choice("DONE", "done"),
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(result.appLaunched).toBe(true)
    expect(result.goalVerified).toBe(true)
    expect(result.actions).toBe(0)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("--activate")
  })

  test("does not accept DONE based only on a drilled message leaf", async () => {
    const client = mockClient(args => ({ version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }))
    const states = [
      observation("whole", [{ id: "drill", operation: "DRILL", ref: "@s1:e1", description: "message history" }]),
      observation("leaf", [{ id: "done", operation: "DONE", description: "done" }]),
      observation("whole-again", [{ id: "done", operation: "DONE", description: "done" }]),
    ]
    const roots: (string | undefined)[] = []
    const decisions = [choice("DRILL", "drill"), choice("DONE", "done"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client, resolveApp,
      observe: async (_client, input) => { roots.push(input.root); return states.shift()! },
      decide: async () => decisions.shift()!,
    })
    expect(result.status).toBe("done")
    expect(result.decisions).toBe(3)
    expect(result.actions).toBe(0)
    expect(roots).toEqual([undefined, "@s1:e1", undefined])
    expect(result.trace.some(entry => entry.outcome === "completion_requires_full_window")).toBe(true)
  })

  test("read-only tasks never see or deliver mutating candidates", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      return { version: "2.4", ok: true, command: "launch", data: { app: "WeChat", pid: 1, window: { id: "w-1", title: "WeChat" } } }
    })
    let offered: string[] = []
    const current = observation("view", [
      { id: "row", operation: "CLICK", ref: "@s1:e1", description: "chat row" },
      { id: "enter", operation: "PRESS_ENTER", description: "submit" },
      { id: "up", operation: "SCROLL_UP", ref: "@s1:e2", description: "history" },
      { id: "done", operation: "DONE", description: "done" },
    ])
    const result = await runGuiTaskEngine({
      input: { ...task({ textSlots: [] }), readOnly: true }, client, resolveApp,
      observe: async () => current,
      decide: async (_goal, candidates) => {
        offered = candidates.map(candidate => candidate.operation)
        return choice("DONE", "done")
      },
    })
    expect(offered).not.toContain("CLICK")
    expect(offered).not.toContain("PRESS_ENTER")
    expect(offered).toContain("SCROLL_UP")
    expect(result.status).toBe("done")
    expect(commands).toHaveLength(1)
  })

  test("read-only execution refuses a delivered mutation as defense in depth", async () => {
    const client = mockClient(args => ({ version: "2.4", ok: true, command: "launch", data: { app: "WeChat", pid: 1 } }))
    const current = observation("view", [{ id: "row", operation: "CLICK", ref: "@s1:e1", description: "chat row" }])
    const result = await runGuiTaskEngine({
      input: { ...task({ textSlots: [], budget: { maxActions: 3, maxDecisions: 5, maxDurationMs: 10_000 } }), readOnly: true }, client, resolveApp,
      observe: async () => current,
      decide: async () => choice("CLICK", "row"),
    })
    expect(result.status).toBe("error")
    expect(result.trace.at(-1)?.note).toContain("read-only task refused CLICK")
  })

  test("accepts Jev DONE even with low numeric confidence", async () => {
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } }))
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => observation("ready", [{ id: "done", operation: "DONE", description: "done" }]),
      decide: async () => ({ ...choice("DONE", "done"), confidence: 0.45 }), resolveApp,
    })
    expect(result.status).toBe("done")
    expect(result.goalVerified).toBe(true)
  })

  test("accepts Jev BLOCKED without a confidence gate", async () => {
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } }))
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => observation("stuck", [{ id: "blocked", operation: "BLOCKED", description: "blocked" }]),
      decide: async () => ({ ...choice("BLOCKED", "blocked"), confidence: 0.2 }), resolveApp,
    })
    expect(result.status).toBe("blocked")
    expect(result.appLaunched).toBe(true)
    expect(result.goalVerified).toBe(false)
  })

  test("continues when NSWorkspace attaches to an already-running helper process", async () => {
    const client = mockClient(args => {
      if (args[0] === "launch") throw new AgentDesktopCommandError("launch", {
        code: "APP_UNRESPONSIVE",
        message: "NSWorkspace returned a different application while attaching",
        details: { expected_pid: 42, returned_pid: 43 },
        disposition: { delivery: "delivered_unverified", retry: "unsafe" },
      })
      throw new Error(`unexpected command: ${args[0]}`)
    })
    let observedApp = ""
    const result = await runGuiTaskEngine({
      input: task({ goal: "open Music", textSlots: [] }),
      client,
      observe: async (_client, input) => {
        observedApp = input.app
        return observation("ready", [{ id: "done", operation: "DONE", description: "done" }])
      },
      decide: async () => choice("DONE", "done"),
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(observedApp).toBe("Music")
  })

  test("blocks with PERM_DENIED when the Accessibility grant is missing", async () => {
    const client = mockClient(args => {
      if (args[0] === "launch") throw new AgentDesktopCommandError("launch", {
        code: "PERM_DENIED",
        message: "AX_PERMISSION_DENIED: this process is not trusted for Accessibility",
        disposition: { delivery: "not_delivered", retry: "never" },
      })
      throw new Error(`unexpected command: ${args[0]}`)
    })
    const result = await runGuiTaskEngine({
      input: task({ goal: "open Music", textSlots: [] }),
      client,
      resolveApp,
    })
    expect(result.status).toBe("blocked")
    expect(result.trace.some(entry => entry.note?.includes("PERM_DENIED"))).toBe(true)
  })

  test("types prepared text, submits it, then finishes", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1, window: { id: "w-1", title: "Music" } } }
      return { version: "2.4", ok: true, command: args[0], data: { disposition: { delivery: "delivered_verified", retry: "unsafe" } } }
    })
    const states = [
      observation("field", [{ id: "type", operation: "SET_VALUE", ref: "@s1:e1", slotId: "query", description: "Search; prepared text purpose=song query" }]),
      observation("filled", [{ id: "enter", operation: "PRESS_ENTER", description: "submit" }]),
      observation("results", [{ id: "done", operation: "DONE", description: "done" }]),
    ]
    // Jev chooses every step, including which field receives the text.
    const decisions = [choice("SET_VALUE", "type"), choice("PRESS_ENTER", "enter"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task(),
      client,
      observe: async () => states.shift()!,
      decide: async () => decisions.shift()!,
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(result.actions).toBe(2)
    expect(commands.map(args => args[0])).toEqual(["launch", "set-value", "press"])
    expect(commands[1]).toContain("private song")
  })

  test("never replays an action after uncertain delivery", async () => {
    let clicks = 0
    const client = mockClient(args => {
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1, window: { id: "w-1", title: "Music" } } }
      clicks++
      throw new AgentDesktopCommandError("click", { code: "ACTION_FAILED", message: "effect unverified", disposition: { delivery: "delivered_unverified", retry: "unsafe" } })
    })
    const current = observation("play", [{ id: "play", operation: "CLICK", ref: "@s1:e2", description: "Play" }])
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }),
      client,
      observe: async () => current,
      decide: async () => choice("CLICK", "play"),
      resolveApp,
    })
    expect(result.status).toBe("needs_review")
    expect(result.appLaunched).toBe(true)
    expect(result.goalVerified).toBe(false)
    expect(result.lastAction?.delivery).toBe("delivered_unverified")
    expect(formatResult(task(), result)).toContain("目标未获 Jev 验证")
    expect(clicks).toBe(1)
  })

  test("lets Jev choose an ordinary action at low confidence while assessing risk", async () => {
    const commands: string[] = []
    const client = mockClient(args => {
      commands.push(args[0])
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1, disposition: { delivery: "delivered_verified", retry: "unsafe" } } }
    })
    let riskCalls = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [], budget: { maxActions: 1, maxDecisions: 3, maxDurationMs: 30_000 } }), client,
      observe: async () => observation("play", [{ id: "play", operation: "CLICK", ref: "@s1:e2", description: "Play" }]),
      decide: async () => ({ ...choice("CLICK", "play"), confidence: 0.4 }), resolveApp,
      assessRisk: async () => { riskCalls++; return { probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } } },
    })
    expect(result.status).toBe("max_actions")
    expect(commands).toEqual(["launch", "click"])
    expect(riskCalls).toBe(1)
    expect(result.lastAction?.delivery).toBe("delivered_verified")
    expect(result.goalVerified).toBe(false)
  })

  test("requires review for an irreversible action even at high confidence", async () => {
    const commands: string[] = []
    const client = mockClient(args => { commands.push(args[0]); return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } } })
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => observation("delete", [{ id: "delete", operation: "CLICK", ref: "@s1:e2", description: "Delete" }]),
      decide: async () => choice("CLICK", "delete"), resolveApp,
      assessRisk: async () => ({ probability: 0.9, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("needs_review")
    expect(commands).toEqual(["launch"])
  })

  test("does not switch text delivery routes after a failed Jev-selected operation", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } }
      throw new AgentDesktopCommandError("set-value", { code: "ACTION_FAILED", message: "not settable", disposition: { delivery: "not_delivered", retry: "safe" } })
    })
    const current = observation("field", [{ id: "type", operation: "SET_VALUE", ref: "@s1:e1", slotId: "query", description: "Search" }])
    const result = await runGuiTaskEngine({
      input: task(),
      client,
      observe: async () => current,
      decide: async () => choice("SET_VALUE", "type"),
      resolveApp,
    })
    expect(result.status).toBe("blocked")
    expect(commands.map(args => args[0])).toEqual(["launch", "set-value", "set-value", "set-value"])
    expect(result.trace.filter(item => item.note).length).toBeGreaterThanOrEqual(3)
  })

  test("undoes an inferred click that opens an unrelated overlay and excludes that target", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } }
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }
    })
    const guess = { id: "guess", operation: "DOUBLE_CLICK" as const, ref: "@s1:bar", headed: true, speculative: true, expect: ["no_overlay" as const], criteria: { what: "group containing \"00:28\"" }, description: "group containing 00:28" }
    const leaf = { id: "leaf", operation: "CLICK" as const, ref: "@s1:play", headed: true, speculative: true, criteria: { what: "group embedded control" }, description: "leaf control" }
    const base = observation("base", [guess, leaf, { id: "done", operation: "DONE", description: "done" }])
    const menu = { ...observation("menu", [{ id: "dismiss", operation: "DISMISS", description: "dismiss" }]), surface: "menu" }
    const played = observation("played", [guess, leaf, { id: "done", operation: "DONE", description: "done" }])
    const states = [base, menu, base, played, played]
    let offered: string[][] = []
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }),
      client,
      observe: async () => states.shift() ?? played,
      decide: async (_goal, candidates, _context, history) => {
        offered.push(candidates.map(candidate => candidate.id))
        if (history.some(item => item.includes("verdict=side_effect")) && !history.some(item => item.startsWith("CLICK"))) return choice("CLICK", "leaf")
        if (history.some(item => item.startsWith("CLICK"))) return choice("DONE", "done")
        return choice("DOUBLE_CLICK", "guess")
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(commands.map(args => args.filter(arg => arg !== "--headed")).map(args => args[0] === "press" ? `press ${args[1]}` : args[0])).toEqual(["launch", "double-click", "press escape", "click"])
    expect(result.trace.find(entry => entry.operation === "DOUBLE_CLICK")?.verdict).toBe("side_effect")
    expect(offered[1]).not.toContain("guess")
    expect(result.status).toBe("done")
  })

  test("lets Jev pick a different candidate after a proven non-delivered failure", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1 } }
      if (args[0] === "scroll-to") throw new AgentDesktopCommandError("scroll-to", { code: "ACTION_FAILED", message: "Target remains clipped or its visible bounds are unknown", disposition: { delivery: "not_delivered", retry: "safe" } })
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }
    })
    const offscreen = observation("feed", [
      { id: "offscreen", operation: "SCROLL_TO", ref: "@s1:e9", description: "offscreen item; bring this observed target into the visible viewport" },
      { id: "labels", operation: "CLICK", ref: "@s1:e2", description: "button labels toggle; delivery=exact-window physical pointer" },
      { id: "done", operation: "DONE", description: "done" },
    ])
    let turn = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }),
      client,
      observe: async () => offscreen,
      decide: async (_goal, _candidates, _context, history) => {
        turn++
        if (turn === 1) return choice("SCROLL_TO", "offscreen")
        if (turn === 2 && history.some(item => item.includes("failed before delivery"))) return choice("CLICK", "labels")
        return choice("DONE", "done")
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(turn).toBe(3)
    expect(commands.map(args => args[0])).toEqual(["launch", "scroll-to", "click"])
    expect(result.status).toBe("done")
    expect(result.goalVerified).toBe(true)
    expect(result.lastAction?.operation).toBe("CLICK")
  })

  test("offers semantic before pointer delivery for web content", async () => {
    const snapshot: SnapshotData = {
      app: "抖音",
      complete: true,
      ref_count: 1,
      snapshot_id: "s1",
      window: { id: "w-1", title: "抖音" },
      tree: {
        role: "window",
        name: "抖音",
        children: [{
          role: "webarea",
          name: "抖音-记录美好生活",
          children: [{
            role: "button",
            name: "开启读屏标签",
            ref_id: "@s1:e2",
            available_actions: ["Click"],
          }],
        }],
      },
    }
    const client = mockClient(() => ({ version: "2.4", ok: true, command: "snapshot", data: snapshot }))
    const result = await observeDesktop(client, {
      app: "抖音", textSlots: [], usedSlotIds: new Set(), allowPressEnter: false,
    }, { timeoutMs: 5_000 })
    const clicks = result.candidates.filter(candidate => candidate.ref === "@s1:e2" && candidate.operation === "CLICK")
    expect(clicks).toHaveLength(2)
    expect(clicks[0].headed).toBe(false)
    expect(clicks[0].description).toContain("semantic accessibility press")
    expect(clicks[1].headed).toBe(true)
    expect(clicks[1].description).toContain("physical pointer")
  })

  test("refreshes a stale window id instead of failing the task", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "launch") return { version: "2.4", ok: true, command: "launch", data: { app: "Music", pid: 1, window: { id: "w-1", title: "Music" } } }
      if (args.includes("--window-id")) throw new AgentDesktopCommandError("snapshot", { code: "WINDOW_NOT_FOUND", message: "No window with id w-1" })
      return {
        version: "2.4", ok: true, command: "snapshot",
        data: {
          app: "Music", complete: true, ref_count: 1, snapshot_id: "s2", window: { id: "w-2", title: "Music" },
          tree: { role: "window", name: "Music", children: [] },
        },
      }
    })
    const current = observation("empty", [{ id: "done", operation: "DONE", description: "done" }])
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async (_client, options) => (options.windowId ? client.run(["snapshot", "--window-id", options.windowId]).then(() => current) : current),
      resolveApp,
    })
    expect(result.status).toBe("done")
  })

  test("retries once when the Jev decision call fails transiently", async () => {
    const client = mockClient(args => ({ version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }))
    const current = observation("ready", [{ id: "done", operation: "DONE", description: "done" }])
    let attempts = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => current,
      decide: async () => {
        attempts++
        if (attempts === 1) throw new Error("Connection error: fetch failed")
        return choice("DONE", "done")
      },
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(attempts).toBe(2)
  })

  test("feeds Jev a structured diff of what the previous action changed", async () => {
    const commands: string[] = []
    const client = mockClient(args => {
      commands.push(args[0])
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1, disposition: { delivery: "delivered_verified", retry: "never" } } }
    })
    const before = observation("before", [
      { id: "row", operation: "CLICK", ref: "@s1:e1", description: "button \"更多\"" },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "button", name: "更多" }] } })
    const after = observation("after", [
      { id: "row", operation: "CLICK", ref: "@s2:e1", description: "button \"更多\"" },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "button", name: "更多" }, { role: "menu", name: "操作" }] } })
    const seenHistory: string[][] = []
    const decisions = [choice("CLICK", "row"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => (seenHistory.length === 0 ? before : after),
      decide: async (_goal, _offered, _context, history) => {
        seenHistory.push([...history])
        return decisions[seenHistory.length - 1]!
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("done")
    expect(seenHistory[1]![0]).toContain("diff: +menu \"操作\"")
    expect(seenHistory[1]![0]).toContain("changed=true")
  })

  test("verifies typed text against the settled field and excludes the failed route", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "set-value") return { version: "2.4", ok: true, command: "set-value", data: { disposition: { delivery: "delivered_unverified", retry: "never" } } }
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }
    })
    const attempt = observation("empty", [
      { id: "type", operation: "SET_VALUE", ref: "@s1:e1", slotId: "query", expect: ["value_equals"], description: "Search", criteria: { what: "textfield \"Search\"", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "" }] } })
    const settled = observation("typed", [
      { id: "type", operation: "SET_VALUE", ref: "@s2:e1", slotId: "query", expect: ["value_equals"], description: "Search", criteria: { what: "textfield \"Search\"", holds: "someone else", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "someone else" }] } })
    let observeCalls = 0
    let seenHistory: string[] | undefined
    let offeredSecond: string[] | undefined
    const decisions = [choice("SET_VALUE", "type"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task(), client,
      observe: async () => {
        observeCalls++
        return observeCalls === 1 ? attempt : settled
      },
      decide: async (_goal, offered, _context, history) => {
        if (decisions.length === 1) {
          offeredSecond = offered.map(candidate => candidate.id)
          seenHistory = [...history]
        }
        return decisions.shift()!
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("done")
    expect(result.trace.find(entry => entry.operation === "SET_VALUE")?.verdict).toBe("no_effect")
    expect(offeredSecond).not.toContain("type")
    expect(seenHistory![0]).toContain("verdict=no_effect (the observed field value does not contain the prepared text)")
    expect(commands.filter(args => args[0] === "set-value")).toHaveLength(1)
  })

  test("reports verified text delivery as evidence when the field holds the prepared text", async () => {
    const client = mockClient(args => {
      if (args[0] === "set-value") return { version: "2.4", ok: true, command: "set-value", data: { disposition: { delivery: "delivered_unverified", retry: "never" } } }
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }
    })
    const attempt = observation("empty", [
      { id: "type", operation: "SET_VALUE", ref: "@s1:e1", slotId: "query", expect: ["value_equals"], description: "Search", criteria: { what: "textfield \"Search\"", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "" }] } })
    const settled = observation("typed", [
      { id: "type", operation: "SET_VALUE", ref: "@s2:e1", slotId: "query", expect: ["value_equals"], description: "Search", criteria: { what: "textfield \"Search\"", holds: "private song", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "private song" }] } })
    let observeCalls = 0
    let seenHistory: string[] | undefined
    const decisions = [choice("SET_VALUE", "type"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task(), client,
      observe: async () => {
        observeCalls++
        return observeCalls === 1 ? attempt : settled
      },
      decide: async (_goal, _offered, _context, history) => {
        if (decisions.length === 1) seenHistory = [...history]
        return decisions.shift()!
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("done")
    expect(result.trace.find(entry => entry.operation === "SET_VALUE")?.verdict).toBeUndefined()
    expect(seenHistory![0]).toContain("verified: the field now holds the prepared query text")
  })

  test("clears a field and excludes the route when text remains", async () => {
    const commands: string[][] = []
    const client = mockClient(args => {
      commands.push(args)
      if (args[0] === "clear") return { version: "2.4", ok: true, command: "clear", data: { disposition: { delivery: "delivered", retry: "never" } } }
      return { version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } }
    })
    const attempt = observation("full", [
      { id: "wipe", operation: "CLEAR", ref: "@s1:e1", description: "Search", criteria: { what: "textfield \"Search\"", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "leftover" }] } })
    const settled = observation("wiped", [
      { id: "wipe", operation: "CLEAR", ref: "@s2:e1", description: "Search", criteria: { what: "textfield \"Search\"", holds: "leftover", supports: "SetValue" } },
      { id: "done", operation: "DONE", description: "done" },
    ], { tree: { role: "window", children: [{ role: "textfield", name: "Search", value: "leftover" }] } })
    let observeCalls = 0
    let offeredSecond: string[] | undefined
    const decisions = [choice("CLEAR", "wipe"), choice("DONE", "done")]
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client,
      observe: async () => {
        observeCalls++
        return observeCalls === 1 ? attempt : settled
      },
      decide: async (_goal, offered) => {
        if (decisions.length === 1) offeredSecond = offered.map(candidate => candidate.id)
        return decisions.shift()!
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.4, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("done")
    expect(commands.map(args => args[0])).toEqual(["launch", "clear"])
    expect(result.trace.find(entry => entry.operation === "CLEAR")?.verdict).toBe("no_effect")
    expect(offeredSecond).not.toContain("wipe")
  })

  test("read-only tasks are never offered context-menu or clear operations", async () => {
    const current = observation("ready", [
      { id: "menu", operation: "RIGHT_CLICK", ref: "@s1:e1", description: "row context menu" },
      { id: "wipe", operation: "CLEAR", ref: "@s1:e2", description: "empty the field" },
      { id: "done", operation: "DONE", description: "done" },
    ])
    let offered: string[] = []
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [], readOnly: true }),
      client: mockClient(args => ({ version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } })),
      observe: async () => current,
      decide: async (_goal, candidates) => {
        offered = candidates.map(candidate => candidate.operation)
        return choice("DONE", "done")
      },
      resolveApp,
    })
    expect(offered).not.toContain("RIGHT_CLICK")
    expect(offered).not.toContain("CLEAR")
    expect(result.status).toBe("done")
  })

  test("retries a protocol-invalid Jev answer once and completes", async () => {
    const current = observation("ready", [{ id: "done", operation: "DONE", description: "done" }])
    let attempts = 0
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: mockClient(args => ({ version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1 } })),
      observe: async () => current,
      decide: async () => {
        attempts++
        if (attempts === 1) throw new Error("Jev returned an invalid confidence or non-maximal desktop choice")
        return choice("DONE", "done")
      },
      resolveApp,
    })
    expect(result.status).toBe("done")
    expect(attempts).toBe(2)
  })

  test("auto-widens a drill that revealed no new candidates and excludes the region", async () => {
    const drill = { id: "deep", operation: "DRILL" as const, ref: "@s1:e9", description: "group containing \"推荐 · 听歌模式\"" }
    const click = { id: "act", operation: "CLICK" as const, ref: "@s1:e2", description: "button \"搜索\"" }
    const done = { id: "done", operation: "DONE" as const, description: "done" }
    const fullWindow = observation("full", [{ ...drill }, { ...click }, { ...done }])
    const drilled = observation("drilled", [{ ...drill }, { ...click }, { ...done }], { root: "@s1:e9" })
    const widened = observation("full-again", [{ ...drill }, { ...click }, { ...done }])
    let observeCalls = 0
    const roots: (string | undefined)[] = []
    const decisions = [choice("DRILL", "deep"), choice("CLICK", "act"), choice("DONE", "done")]
    let offeredSecond: string[] | undefined
    const result = await runGuiTaskEngine({
      input: task({ textSlots: [] }), client: mockClient(args => ({ version: "2.4", ok: true, command: args[0], data: { app: "Music", pid: 1, disposition: { delivery: "delivered_verified", retry: "never" } } })),
      observe: async (_client, options) => {
        observeCalls++
        roots.push(options.root)
        return observeCalls === 2 ? drilled : observeCalls === 3 ? widened : fullWindow
      },
      decide: async (_goal, offered) => {
        if (decisions.length === 2) offeredSecond = offered.map(candidate => candidate.id)
        return decisions.shift()!
      },
      resolveApp,
      assessRisk: async () => ({ probability: 0.1, model: "jev-test", latencyMs: 1, usage: { inputTokens: 1, outputTokens: 1 } }),
    })
    expect(result.status).toBe("done")
    // The drill's successor observation revealed nothing new: the engine
    // widened and excluded the region without spending a Jev round on it.
    expect(result.decisions).toBe(3)
    expect(result.trace.some(entry => entry.note?.includes("DRILL revealed no new candidates"))).toBe(true)
    expect(offeredSecond).not.toContain("deep")
    expect(roots).toEqual([undefined, "@s1:e9", undefined, undefined])
  })
})

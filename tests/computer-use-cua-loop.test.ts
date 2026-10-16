import { describe, expect, test } from "bun:test"
import { describeElement, detectOverlay, stripMenuBar } from "../src-tauri/resources/computer-use/cua/observation.ts"
import { roleClass } from "../src-tauri/resources/computer-use/candidates/roles.ts"
import { buildCandidates, menuPath } from "../src-tauri/resources/computer-use/candidates/sources.ts"
import { applyPolicy, boundCandidates, isRisky, MAX_EXECUTABLE_CANDIDATES } from "../src-tauri/resources/computer-use/candidates/policy.ts"
import { buildChoiceRequest, validateChoiceAnswer } from "../src-tauri/resources/computer-use/choice/contract.ts"
import { RepeatBrake, sameScreen, StallTracker } from "../src-tauri/resources/computer-use/loop/stall.ts"
import { isAmbiguous, runCuaTask, verifyStep, visionMode } from "../src-tauri/resources/computer-use/loop/engine.ts"
import type { CuaCandidate, CuaElement, CuaObservation } from "../src-tauri/resources/computer-use/cua/types.ts"
import type { CuaDriver, WindowState } from "../src-tauri/resources/computer-use/cua/driver.ts"
import { DriverToolError } from "../src-tauri/resources/computer-use/cua/errors.ts"
import type { GuiTaskInput } from "../src-tauri/resources/computer-use/gui-task-contract.ts"

// ---------------------------------------------------------------- helpers

function element(partial: Partial<CuaElement> & { elementIndex: number; role: string }): CuaElement {
  return { depth: 2, actions: [], ...partial }
}

function observation(elements: CuaElement[], extra: Partial<CuaObservation> = {}): CuaObservation {
  const lines = elements.map(describeElement)
  return {
    pid: 1,
    windowId: 2,
    app: "Demo",
    title: "Demo",
    elements,
    complete: true,
    truncated: false,
    total: elements.length,
    context: `app=Demo\nelements:\n${lines.join("\n")}`,
    lines,
    fingerprint: lines.join("|"),
    capturedAt: 0,
    ...extra,
  }
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    goal: "搜索并播放蓝",
    readOnly: false,
    pid: 1,
    windowId: 2,
    textSlots: [] as Array<{ id: string; value: string; description: string }>,
    usedSlotIds: new Set<string>(),
    allowEnter: false,
    allElements: [] as CuaElement[],
    ...overrides,
  }
}

// ---------------------------------------------------------------- roles

describe("role classes", () => {
  test("normalises every platform's raw role", () => {
    expect(roleClass("AXTextField")).toBe("text_entry")
    expect(roleClass("AXButton")).toBe("button")
    expect(roleClass("AXLink")).toBe("link")
    expect(roleClass("AXCheckBox")).toBe("checkbox")
    expect(roleClass("AXMenuItem")).toBe("menu_item")
    // Windows UIA
    expect(roleClass("Edit")).toBe("text_entry")
    expect(roleClass("Hyperlink")).toBe("link")
    // Linux AT-SPI
    expect(roleClass("push button")).toBe("button")
    expect(roleClass("entry")).toBe("text_entry")
    expect(roleClass("check box")).toBe("checkbox")
    // Unknown roles are excluded, never guessed.
    expect(roleClass("AXSomethingWeird")).toBe("unknown")
  })
})

// ---------------------------------------------------------------- observation

describe("observation shaping", () => {
  test("drops the always-present menu bar subtree but keeps an open popup menu", () => {
    const elements = [
      element({ elementIndex: 0, role: "AXWindow", depth: 0 }),
      element({ elementIndex: 1, role: "AXTextField", depth: 1, label: "搜索会话", value: "搜索会话…", actions: ["AXPress"] }),
      element({ elementIndex: 2, role: "AXMenuBar", depth: 1, actions: ["AXCancel"] }),
      element({ elementIndex: 3, role: "AXMenuBarItem", depth: 2, label: "File" }),
      element({ elementIndex: 4, role: "AXMenuItem", depth: 3, label: "Save" }),
      element({ elementIndex: 5, role: "AXWindow", depth: 0 }),
      element({ elementIndex: 6, role: "AXMenu", depth: 1, actions: ["AXCancel"] }),
      element({ elementIndex: 7, role: "AXMenuItem", depth: 2, label: "Copy", actions: ["AXPress"] }),
    ]
    const kept = stripMenuBar(elements).map(item => item.elementIndex)
    expect(kept).toContain(1)
    expect(kept).not.toContain(2)
    expect(kept).not.toContain(3)
    expect(kept).not.toContain(4)
    // the popup menu at depth 1 survives
    expect(kept).toContain(6)
    expect(kept).toContain(7)
  })

  test("describes an element with its role class, label, value and actions", () => {
    expect(describeElement(element({ elementIndex: 60, role: "AXTextField", label: "歌手、歌曲或专辑名", value: "歌手、歌曲或专辑名", actions: ["AXPress", "AXShowMenu"], inWebContent: true })))
      .toBe('[60] text_entry "歌手、歌曲或专辑名" Press,ShowMenu web')
  })

  test("detects an overlay so Escape is a real option", () => {
    expect(detectOverlay([element({ elementIndex: 1, role: "AXSheet" })])).toBe("AXSheet")
    expect(detectOverlay([element({ elementIndex: 1, role: "AXWindow" })])).toBeUndefined()
  })
})

// ---------------------------------------------------------------- candidates

describe("candidate sources", () => {
  test("offers a labelled text field as type_text and a pressable control as click", () => {
    const search = element({ elementIndex: 60, role: "AXTextField", label: "歌手、歌曲或专辑名", value: "歌手、歌曲或专辑名", actions: ["AXPress", "AXShowMenu"], inWebContent: true, elementToken: "s1:60" })
    const play = element({ elementIndex: 12, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:12" })
    const built = buildCandidates(observation([search, play]), context({ textSlots: [{ id: "q", value: "蓝", description: "搜索关键词" }] }))
    const type = built.find(candidate => candidate.operation === "type_text")
    expect(type?.tool).toBe("type_text")
    expect(type?.args).toEqual({ element_token: "s1:60", text: "蓝", delivery_mode: "background" })
    expect(type?.slotId).toBe("q")
    const click = built.find(candidate => candidate.operation === "click" && candidate.identity === "button:播放")
    expect(click?.tool).toBe("click")
    expect(click?.args).toEqual({ element_token: "s1:12", action: "press" })
  })

  test("press also declares a menu -> menu-only, so click and right_click never overlap", () => {
    const both = element({ elementIndex: 5, role: "AXButton", label: "更多", actions: ["AXPress", "AXShowMenu"], elementToken: "s1:5" })
    const menuOnly = element({ elementIndex: 6, role: "AXButton", label: "选项", actions: ["AXShowMenu"], elementToken: "s1:6" })
    const built = buildCandidates(observation([both, menuOnly]), context())
    expect(built.filter(item => item.identity === "button:更多").map(item => item.operation)).toEqual(["click"])
    expect(built.filter(item => item.identity === "button:选项").map(item => item.operation)).toEqual(["right_click"])
  })

  test("Return is offered only after a text operation, and Escape only with an overlay", () => {
    const field = element({ elementIndex: 1, role: "AXTextField", label: "Search", actions: ["AXPress"], elementToken: "s1:1" })
    const none = buildCandidates(observation([field]), context())
    expect(none.some(item => item.operation === "press_key")).toBe(false)
    const afterType = buildCandidates(observation([field]), context({ allowEnter: true, lastTypedToken: "s1:1" }))
    expect(afterType.find(item => item.operation === "press_key")?.args).toEqual({ key: "return", element_token: "s1:1" })
    const overlay = buildCandidates(observation([field], { overlay: "AXSheet" }), context())
    expect(overlay.find(item => item.id === "ax.key.escape")?.args).toEqual({ key: "escape", pid: 1, window_id: 2 })
  })

  test("scroll is offered only for a partial tree", () => {
    const base = element({ elementIndex: 1, role: "AXButton", label: "A", actions: ["AXPress"] })
    expect(buildCandidates(observation([base]), context()).some(item => item.operation === "scroll")).toBe(false)
    expect(buildCandidates(observation([base], { truncated: true, complete: false }), context()).some(item => item.operation === "scroll")).toBe(true)
  })

  test("menu commands are offered only when the goal names them, with an exact path", () => {
    const all = [
      element({ elementIndex: 2, role: "AXMenuBar", depth: 1 }),
      element({ elementIndex: 3, role: "AXMenuBarItem", depth: 2, label: "File" }),
      element({ elementIndex: 4, role: "AXMenuItem", depth: 3, label: "Save As", parentIndex: 3, actions: ["AXPress"] }),
      element({ elementIndex: 5, role: "AXMenuItem", depth: 3, label: "Export", parentIndex: 3, actions: ["AXPress"] }),
    ]
    expect(menuPath(all, all[2])).toEqual(["File", "Save As"])
    const mentioned = buildCandidates(observation([element({ elementIndex: 1, role: "AXButton", label: "x", actions: ["AXPress"] })]), context({ goal: "把文件 Save As 到桌面", allElements: all }))
    const menu = mentioned.find(item => item.operation === "menu")
    expect(menu?.args).toEqual({ pid: 1, window_id: 2, path: ["File", "Save As"] })
    const unmentioned = buildCandidates(observation([element({ elementIndex: 1, role: "AXButton", label: "x", actions: ["AXPress"] })]), context({ allElements: all }))
    expect(unmentioned.some(item => item.operation === "menu")).toBe(false)
  })

  test("reserved candidates are always present and last", () => {
    const built = buildCandidates(observation([element({ elementIndex: 1, role: "AXButton", label: "A", actions: ["AXPress"] })]), context())
    expect(built.slice(-3).map(item => item.id)).toEqual(["done", "reobserve", "abstain"])
    expect(built.filter(item => item.tool === null).length).toBe(3)
  })

  test("candidate ids are ASCII, unique and stable, and never carry the label", () => {
    const field = element({ elementIndex: 60, role: "AXTextField", label: "搜索会话", actions: ["AXPress"], elementToken: "s1:60" })
    const built = buildCandidates(observation([field]), context({ textSlots: [{ id: "q", value: "x", description: "d" }] }))
    const executable = built.filter(item => item.tool)
    expect(new Set(executable.map(item => item.id)).size).toBe(executable.length)
    for (const candidate of executable) expect(candidate.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/)
    // Same shape -> same id; the id holds no label text.
    expect(buildCandidates(observation([field]), context({ textSlots: [{ id: "q", value: "x", description: "d" }] }))[0].id).toBe(built[0].id)
    expect(built[0].id).not.toContain("搜索会话")
  })

  test("read-only runs have no text entry when no slot is free, for any reason", () => {
    const field = element({ elementIndex: 1, role: "AXTextField", label: "To", actions: ["AXPress"], elementToken: "s1:1" })
    const built = buildCandidates(observation([field]), context({ readOnly: true, textSlots: [{ id: "q", value: "x", description: "d" }] }))
    expect(built.some(item => item.operation === "type_text")).toBe(false)
  })
})

// ---------------------------------------------------------------- policy

describe("policy", () => {
  test("withholds hard-to-undo labels unless the goal names them", () => {
    expect(isRisky("删除")).toBe(true)
    expect(isRisky("Delete account")).toBe(true)
    expect(isRisky("播放")).toBe(false)
    const remove = element({ elementIndex: 1, role: "AXButton", label: "删除", actions: ["AXPress"], elementToken: "s1:1" })
    const play = element({ elementIndex: 2, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:2" })
    const built = buildCandidates(observation([remove, play]), context({ goal: "播放蓝", textSlots: [] }))
    const filtered = applyPolicy(built, { readOnly: false, goal: "播放蓝", quarantined: new Set(), triedHere: new Set(), repeatedTargets: new Set() })
    expect(filtered.some(item => item.label === "删除")).toBe(false)
    const allowed = applyPolicy(built, { readOnly: false, goal: "删除这首歌", quarantined: new Set(), triedHere: new Set(), repeatedTargets: new Set() })
    expect(allowed.some(item => item.label === "删除")).toBe(true)
  })

  test("read-only runs cannot click, type, submit or open a menu", () => {
    const button = element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })
    const field = element({ elementIndex: 2, role: "AXTextField", label: "搜索", actions: ["AXPress"], elementToken: "s1:2" })
    const built = buildCandidates(observation([button, field], { truncated: true, complete: false }), context({ readOnly: true, textSlots: [{ id: "q", value: "x", description: "d" }] }))
    const filtered = applyPolicy(built, { readOnly: true, goal: "只看不去点", quarantined: new Set(), triedHere: new Set(), repeatedTargets: new Set() })
    expect(filtered.every(item => item.operation === "scroll" || item.tool === null)).toBe(true)
    expect(filtered.some(item => item.operation === "click")).toBe(false)
    expect(filtered.some(item => item.operation === "type_text")).toBe(false)
  })

  test("withholds quarantined and repeated targets, and bounds the offer set", () => {
    const button = element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })
    const built = buildCandidates(observation([button]), context())
    const filtered = applyPolicy(built, { readOnly: false, goal: "g", quarantined: new Set(["button:播放"]), triedHere: new Set(), repeatedTargets: new Set() })
    expect(filtered.some(item => item.tool)).toBe(false)
    const many = Array.from({ length: 40 }, (_, index) => ({ id: `c${index}`, tool: "click", operation: "click" } as unknown as CuaCandidate))
    const { offered, dropped } = boundCandidates([...many, { id: "reobserve", tool: null } as unknown as CuaCandidate, { id: "abstain", tool: null } as unknown as CuaCandidate])
    expect(offered.filter(item => item.tool).length).toBe(MAX_EXECUTABLE_CANDIDATES)
    expect(dropped).toBe(40 - MAX_EXECUTABLE_CANDIDATES)
    expect(offered.slice(-2).map(item => item.id)).toEqual(["reobserve", "abstain"])
  })
})

// ---------------------------------------------------------------- contract

describe("choice contract", () => {
  const candidates = [
    { id: "ax.button.aaaa1111", description: "press it", source: "ax", operation: "click", tool: "click", args: {}, legacyOperation: "CLICK" },
    { id: "reobserve", description: "look again", source: null, operation: "reobserve", tool: null, args: {}, legacyOperation: "WAIT" },
    { id: "abstain", description: "stop", source: null, operation: "abstain", tool: null, args: {}, legacyOperation: "BLOCKED" },
  ] as unknown as CuaCandidate[]

  test("builds a v2 request carrying the source tag and both reserved ids", () => {
    const request = buildChoiceRequest({ goal: "g", observation: observation([element({ elementIndex: 1, role: "AXButton", label: "A" })], { snapshotId: "s1", captureId: "cap1" }), candidates, history: ["a"] })
    expect(request.schema).toBe("cua.jev_choice_request_v2")
    expect(request.snapshot_id).toBe("s1")
    expect(request.capture_id).toBe("cap1")
    expect(request.candidates.map(item => item.id)).toEqual(["ax.button.aaaa1111", "reobserve", "abstain"])
    expect(request.candidates[0].source).toBe("ax")
  })

  test("rejects a request missing a reserved candidate or with duplicate ids", () => {
    expect(() => buildChoiceRequest({ goal: "g", observation: observation([element({ elementIndex: 1, role: "AXButton" })]), candidates: candidates.slice(0, 2), history: [] })).toThrow(/reserved/)
    expect(() => buildChoiceRequest({ goal: "g", observation: observation([element({ elementIndex: 1, role: "AXButton" })]), candidates: [candidates[0], candidates[0], candidates[2]], history: [] })).toThrow(/duplicate/)
  })

  test("validates the answer shape strictly", () => {
    const answer = { type: "choice", choice: "reobserve", confidence: 0.8, probabilities: { "ax.button.aaaa1111": 0.1, reobserve: 0.8, abstain: 0.1 } }
    expect(validateChoiceAnswer(answer, candidates).selectedId).toBe("reobserve")
    expect(() => validateChoiceAnswer({ ...answer, choice: "nope" }, candidates)).toThrow(/unknown candidate/)
    expect(() => validateChoiceAnswer({ ...answer, probabilities: { reobserve: 1 } }, candidates)).toThrow(/incomplete/)
    expect(() => validateChoiceAnswer({ ...answer, probabilities: { "ax.button.aaaa1111": 0.9, reobserve: 0.1, abstain: 0.0 } }, candidates)).toThrow(/confidence/)
  })
})

// ---------------------------------------------------------------- stall

describe("stall brake", () => {
  test("sameScreen tolerates one differing line", () => {
    expect(sameScreen(["a", "b", "c"], ["a", "b", "c"])).toBe(true)
    expect(sameScreen(["a", "b", "c"], ["a", "b", "clock"])).toBe(true)
    expect(sameScreen(["a", "b", "c"], ["a", "x", "y"])).toBe(false)
  })

  test("stops after three different actions left the screen unchanged", () => {
    const tracker = new StallTracker()
    const screen = ["row 1", "row 2"]
    expect(tracker.record("click:a", screen, screen).stalled).toBe(false)
    expect(tracker.record("click:b", screen, screen).stalled).toBe(false)
    const verdict = tracker.record("click:c", screen, screen)
    expect(verdict.stalled).toBe(true)
    if (verdict.stalled) expect(verdict.reason).toMatch(/unchanged/)
  })

  test("stops when the same action is taken twice on one unchanged screen", () => {
    const tracker = new StallTracker()
    const screen = ["a"]
    tracker.record("click:x", screen, screen)
    const verdict = tracker.record("click:x", screen, screen)
    expect(verdict.stalled).toBe(true)
  })

  test("repeat brake withholds a target after two identical selections", () => {
    const brake = new RepeatBrake(2)
    brake.observe("button:风清扬")
    expect(brake.blocked.has("button:风清扬")).toBe(false)
    brake.observe("button:风清扬")
    expect(brake.blocked.has("button:风清扬")).toBe(true)
    brake.reset()
    brake.observe("button:风清扬")
    expect(brake.blocked.has("button:风清扬")).toBe(true)
  })
})

// ---------------------------------------------------------------- verify

describe("step verification", () => {
  const input = { goal: "g", target: { app: "Demo" }, budget: { maxActions: 3, maxDecisions: 3, maxDurationMs: 5_000 }, textSlots: [{ id: "q", value: "蓝", description: "搜索" }] } as GuiTaskInput

  test("a text step is verified from the successor field value, not the return value", () => {
    const candidate = { operation: "type_text", slotId: "q", args: {}, tool: "type_text", id: "t", description: "", source: "ax", legacyOperation: "TYPE_TEXT" } as unknown as CuaCandidate
    const before = observation([element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"] })])
    const filled = observation([element({ elementIndex: 1, role: "AXTextField", label: "搜索", value: "蓝", actions: ["AXPress"] })])
    expect(verifyStep(candidate, before, filled, input).failed).toBe(false)
    // Delivered but the field stayed empty: not evidence.
    expect(verifyStep(candidate, before, before, input).failed).toBe(true)
  })

  test("a click that changed nothing fails verification", () => {
    const candidate = { operation: "click", args: {}, tool: "click", id: "c", description: "", source: "ax", legacyOperation: "CLICK" } as unknown as CuaCandidate
    const screen = observation([element({ elementIndex: 1, role: "AXButton", label: "A", actions: ["AXPress"] })])
    expect(verifyStep(candidate, screen, screen, input).failed).toBe(true)
  })
})

// ---------------------------------------------------------------- loop

function fakeDriver(screen: () => CuaElement[], onAction?: (tool: string, args: Record<string, unknown>) => void, opts: { degraded?: string } = {}): CuaDriver {
  const windows = [{ windowId: 2, title: "Demo", pid: 1, onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } }]
  return {
    transport: "cli",
    listTools: async () => [],
    listApps: async () => [{ name: "Demo", pid: 1, running: true, active: true }],
    listWindows: async () => windows,
    getWindowState: async () => ({ appName: "Demo", windowTitle: "Demo", pid: 1, windowId: 2, snapshotId: "s1", elements: opts.degraded ? [] : screen(), elementsComplete: !opts.degraded, truncated: Boolean(opts.degraded), totalElementCount: opts.degraded ? 0 : screen().length, screenshot: { mimeType: "image/png", width: 1568, height: 979, base64: "aGVsbG8=" }, raw: opts.degraded ? { degraded_reason: opts.degraded } : {} }) as WindowState,
    callTool: async (name, args = {}) => { onAction?.(name, args); return { value: { effect: "unconfirmed" }, text: "", images: [], isError: false } },
    dispose: async () => undefined,
  } as unknown as CuaDriver
}

describe("cua loop", () => {
  const budget = { maxActions: 20, maxDecisions: 20, maxDurationMs: 20_000 }

  test("stops as blocked when an action never changes the screen", async () => {
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async ({ candidates }) => {
        const click = candidates.find(candidate => candidate.operation === "click")!
        return { selectedId: click.id, confidence: 0.9, probabilities: { [click.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(result.status).toBe("blocked")
    expect(result.failure?.detail).toMatch(/did not change|unchanged|twice/)
    // Three delivered actions, not eight.
    expect(result.actions).toBeLessThanOrEqual(3)
  })

  test("finishes done when the chooser says the goal is satisfied and the screen confirms it", async () => {
    let elements = [element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"], elementToken: "s1:1" })]
    const driver = fakeDriver(() => elements, (tool) => { if (tool === "type_text") elements = [element({ elementIndex: 1, role: "AXTextField", label: "搜索", value: "蓝", actions: ["AXPress"], elementToken: "s1:1" })] })
    const result = await runCuaTask({ goal: "在搜索框输入蓝", target: { app: "Demo" }, budget, textSlots: [{ id: "q", value: "蓝", description: "搜索关键词" }] } as GuiTaskInput, {
      driver,
      decide: async ({ candidates }) => {
        // First turn: type the prepared text. Second: the goal is satisfied.
        const type = candidates.find(candidate => candidate.operation === "type_text")
        const pick = type ?? candidates.find(candidate => candidate.id === "done")!
        return { selectedId: pick.id, confidence: 0.95, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, ...(type ? {} : { completesGoal: 0.9 }) }
      },
    })
    expect(result.status).toBe("done")
    expect(result.goalVerified).toBe(true)
    expect(result.trace.some(entry => entry.operation === "TYPE_TEXT")).toBe(true)
  })

  test("abstain blocks, and reobserve does not spend an action", async () => {
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    let turn = 0
    const result = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async ({ candidates }) => {
        turn++
        const pick = turn === 1 ? candidates.find(candidate => candidate.id === "reobserve")! : candidates.find(candidate => candidate.id === "abstain")!
        return { selectedId: pick.id, confidence: 0.9, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(result.status).toBe("blocked")
    expect(result.actions).toBe(0)
    expect(result.decisions).toBe(2)
  })

  test("attaches a screenshot to the chooser only when vision says so", async () => {
    const button = () => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })]
    const chooseDone = (seen: Array<unknown>) => async ({ candidates, image }: { candidates: CuaCandidate[]; image?: unknown }) => {
      seen.push(image)
      const pick = candidates.find(candidate => candidate.id === "done")!
      return { selectedId: pick.id, confidence: 1, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
    }
    const withVision: unknown[] = []
    const on = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, { driver: fakeDriver(button), vision: "always", decide: chooseDone(withVision) as never })
    expect(on.status).toBe("done")
    expect(withVision[0]).toBeDefined()
    expect((withVision[0] as { width: number }).width).toBe(1568)
    expect(on.trace[0].note).toContain("screenshot attached")

    const off: unknown[] = []
    const withoutVision = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, { driver: fakeDriver(button), vision: "off", decide: chooseDone(off) as never })
    expect(withoutVision.status).toBe("done")
    expect(off[0]).toBeUndefined()
    expect(withoutVision.trace[0].note ?? "").not.toContain("screenshot")
  })

  test("vision mode and ambiguity decide when a picture is worth its cost", () => {
    expect(visionMode(undefined)).toBe("off")
    expect(visionMode("0")).toBe("off")
    expect(visionMode("1")).toBe("auto")
    expect(visionMode("true")).toBe("auto")
    expect(visionMode("auto")).toBe("auto")
    expect(visionMode(" ALWAYS ")).toBe("always")
    const labelled = [{ id: "a", tool: "click", label: "播放" }] as unknown as CuaCandidate[]
    const unlabelled = [{ id: "a", tool: "click" }] as unknown as CuaCandidate[]
    const reserved = [{ id: "done", tool: null }] as unknown as CuaCandidate[]
    // A labelled, confidently-chosen set needs no image.
    expect(isAmbiguous(labelled, 0.9)).toBe(false)
    // An unlabelled target, or a previous uncertain choice, does.
    expect(isAmbiguous(unlabelled, 0.9)).toBe(true)
    expect(isAmbiguous(labelled, 0.4)).toBe(true)
    // Reserved candidates alone never justify a picture.
    expect(isAmbiguous(reserved, 0.9)).toBe(false)
  })

  test("offers the driver's next rung after a background refusal instead of dying", async () => {
    let elements = [element({ elementIndex: 1, role: "AXTextField", label: "歌手、歌曲或专辑名", actions: ["AXPress"], elementToken: "s1:1" })]
    const attempts: Array<{ tool: string; mode?: unknown }> = []
    const driver = fakeDriver(() => elements, (tool, args) => {
      attempts.push({ tool, mode: args.delivery_mode })
      if (tool !== "type_text") return
      if (args.delivery_mode !== "foreground") {
        // Exactly what the real driver does for an Electron text field.
        throw new DriverToolError("type_text", "background_unavailable", "The Electron AX target cannot establish a safe exact background text route", false, { code: "background_unavailable", effect: "refused", escalation: { recommended: "foreground", reason: "Electron/Chromium" } })
      }
      elements = [element({ elementIndex: 1, role: "AXTextField", label: "歌手、歌曲或专辑名", value: "奥特曼", actions: ["AXPress"], elementToken: "s1:1" })]
    })

    const seenIds: string[] = []
    const result = await runCuaTask(
      { goal: "搜索奥特曼", target: { app: "Demo" }, budget, textSlots: [{ id: "keyword", value: "奥特曼", description: "搜索关键词" }] } as GuiTaskInput,
      {
        driver,
        decide: async ({ candidates }) => {
          // Background first, then the explicitly offered foreground twin, then done.
          const background = candidates.find(candidate => candidate.operation === "type_text" && !candidate.id.endsWith(".fg"))
          const foreground = candidates.find(candidate => candidate.operation === "type_text" && candidate.id.endsWith(".fg"))
          const pick = background ?? foreground ?? candidates.find(candidate => candidate.id === "done")!
          seenIds.push(pick.id)
          return { selectedId: pick.id, confidence: 0.9, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
        },
      },
    )

    // The background attempt was refused; the foreground twin was then offered
    // and chosen; only then did the field actually take the text.
    expect(attempts[0]).toEqual({ tool: "type_text", mode: "background" })
    expect(attempts[1]).toEqual({ tool: "type_text", mode: "foreground" })
    expect(seenIds[1].endsWith(".fg")).toBe(true)
    expect(seenIds[0].endsWith(".fg")).toBe(false)
    // A refusal is not an action, and it must not surface as an error status.
    expect(result.status).toBe("done")
    expect(result.actions).toBe(1)
    // The refused attempt is recorded as a refusal, not as an action or an error.
    expect(result.trace[0].outcome).toBe("refused")
    expect(result.trace.some(entry => entry.verdict === "no_effect")).toBe(false)
  })

  test("a degraded, empty tree tries one recovery, then blocks with a precise reason", async () => {
    const actions: string[] = []
    const driver = fakeDriver(() => [], (tool) => { actions.push(tool) }, { degraded: "window_id 2 exists but no AXWindow reports it" })
    const result = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, { driver, decide: async () => { throw new Error("must not be called") } })
    expect(result.status).toBe("blocked")
    expect(result.failure?.branch).toBe("ax-unresolved")
    // The driver's documented escalation is tried once, and never twice.
    expect(actions).toEqual(["bring_to_front"])
    expect(result.trace.some(entry => entry.note?.includes("foreground activation"))).toBe(true)
    // The hint must not let the caller conclude the app lacks accessibility.
    expect(result.failure?.hint).toContain("最小化")
    expect(result.failure?.hint).toContain("不要据此改用其它方式")
    expect(result.actions).toBe(0)
  })
})

import { describe, expect, test } from "bun:test"
import { describeElement, describeElementSignature, detectOverlay, stripMenuBar } from "../src-tauri/resources/computer-use/cua/observation.ts"
import { roleClass } from "../src-tauri/resources/computer-use/candidates/roles.ts"
import { buildCandidates, escalatedTwin, menuPath } from "../src-tauri/resources/computer-use/candidates/sources.ts"
import { applyPolicy, boundCandidates, isRisky, MAX_EXECUTABLE_CANDIDATES } from "../src-tauri/resources/computer-use/candidates/policy.ts"
import { buildChoiceRequest, validateChoiceAnswer } from "../src-tauri/resources/computer-use/choice/contract.ts"
import { RepeatBrake, sameScreen, StallTracker } from "../src-tauri/resources/computer-use/loop/stall.ts"
import { escalatedTarget, isAmbiguous, requiresConfirmation, runCuaTask, verifyStep, visionMode } from "../src-tauri/resources/computer-use/loop/engine.ts"
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
  const signature = elements.map(describeElementSignature)
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
    signature,
    fingerprint: signature.join("|"),
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

  test("the change signature drops the snapshot index but keeps semantic state", () => {
    // Inserting one element renumbers every later `[index]`, which is not a
    // change to the screen. The signature must therefore not carry the index.
    const first = element({ elementIndex: 5, role: "AXCheckBox", label: "同意", actions: ["AXPress"], selected: true })
    const later = element({ elementIndex: 99, role: "AXCheckBox", label: "同意", actions: ["AXPress"], selected: true })
    expect(describeElementSignature(first)).toBe(describeElementSignature(later))
    // `selected` and `enabled` are semantic and must still show up, or a checkbox
    // that just became checked reads as "nothing happened".
    expect(describeElementSignature(first)).toContain("selected")
    expect(describeElementSignature(element({ elementIndex: 7, role: "AXButton", label: "保存", actions: ["AXPress"], enabled: false }))).toContain("disabled")
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

  test("identical siblings get distinct identities and a positional note", () => {
    // Thirty rows all labelled "更多" shared one identity before: one wrong click
    // quarantined every sibling, including the correct one, and the repeat brake
    // counted different rows as one target.
    const first = element({ elementIndex: 5, role: "AXButton", label: "更多", actions: ["AXPress"], elementToken: "s1:5" })
    const second = element({ elementIndex: 9, role: "AXButton", label: "更多", actions: ["AXPress"], elementToken: "s1:9" })
    const unique = element({ elementIndex: 12, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:12" })
    const built = buildCandidates(observation([first, second, unique]), context())
    const more = built.filter(item => item.label === "更多")
    expect(more.map(item => item.identity).sort()).toEqual(["button:更多#0", "button:更多#1"])
    expect(more[0].description).toContain("1 of 2 controls with the same label")
    expect(more[1].description).toContain("2 of 2 controls with the same label")
    // A label that occurs once keeps the bare identity the brakes already use.
    expect(built.find(item => item.label === "播放")?.identity).toBe("button:播放")
  })

  test("the driver's px rung becomes its own pointer candidate, never a foreground twin", () => {
    const candidate = {
      id: "ax.button.aaaa1111", description: 'button "更多"; press it', source: "ax", operation: "click", tool: "click",
      args: { element_token: "s1:5", action: "press" }, elementToken: "s1:5", identity: "button:更多", legacyOperation: "CLICK",
    } as unknown as CuaCandidate
    const frame = { x: 100, y: 50, w: 40, h: 20 }
    const px = escalatedTwin(candidate, "px", { windowId: 2, pid: 1, frame, captureId: "cap1" })
    expect(px?.id).toBe("ax.button.aaaa1111.px")
    expect(px?.identity).toBe("button:更多:px")
    expect(px?.escalated).toBe(true)
    expect(px?.args).toMatchObject({ x: 120, y: 60, pid: 1, window_id: 2, capture_id: "cap1" })
    expect(px?.args.element_token).toBeUndefined()
    expect(px?.description).toContain("POINTER")
    // A pointer delivery is capture-bound: without the capture_id the
    // coordinates came from, the driver cannot execute it, so there is no
    // pointer target to offer. Dropping it is honest.
    expect(escalatedTwin(candidate, "px", { windowId: 2, pid: 1, frame })).toBeUndefined()
    expect(escalatedTwin(candidate, "px", { windowId: 2, pid: 1, captureId: "cap1" })).toBeUndefined()
    expect(escalatedTwin(candidate, "px", { windowId: 2, pid: 1 })).toBeUndefined()
    // The foreground rung is still a semantic re-run, not a pointer click.
    const fg = escalatedTwin(candidate, "foreground", { windowId: 2, pid: 1, frame })
    expect(fg?.id).toBe("ax.button.aaaa1111.fg")
    expect(fg?.identity).toBe("button:更多:fg")
    expect(fg?.args).toMatchObject({ element_token: "s1:5", delivery_mode: "foreground" })
  })

  test("a px twin is not offered when there is no capture to bind it to", () => {
    // The offer set must never contain a pointer candidate the driver is certain
    // to refuse: a capture-bound click needs both the frame and the capture_id.
    const field = element({ elementIndex: 60, role: "AXTextField", label: "搜索", actions: ["AXPress"], elementToken: "s1:60", frame: { x: 10, y: 20, w: 100, h: 30 } })
    const escalate = new Map<string, "px">([["text_entry:搜索", "px"]])
    const slots = [{ id: "q", value: "蓝", description: "d" }]
    const withoutCapture = buildCandidates(observation([field]), context({ escalate, textSlots: slots }))
    expect(withoutCapture.some(item => item.id.endsWith(".px"))).toBe(false)
    const withCapture = buildCandidates(observation([field], { captureId: "cap1" }), context({ escalate, textSlots: slots }))
    const px = withCapture.find(item => item.id.endsWith(".px"))
    expect(px?.args).toMatchObject({ capture_id: "cap1", x: 60, y: 35 })
  })

  test("a forced scroll candidate is built for a capped offer set", () => {
    const button = element({ elementIndex: 1, role: "AXButton", label: "A", actions: ["AXPress"] })
    expect(buildCandidates(observation([button]), context()).some(item => item.operation === "scroll")).toBe(false)
    const forced = buildCandidates(observation([button]), context({ forceScroll: true }))
    expect(forced.filter(item => item.operation === "scroll").map(item => item.id)).toEqual(["ax.scroll.down", "ax.scroll.up"])
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

  test("never drops the scroll candidates that reveal what the cap hid", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ id: `c${index}`, tool: "click", operation: "click" } as unknown as CuaCandidate))
    const scrolls = [
      { id: "ax.scroll.down", tool: "scroll", operation: "scroll" } as unknown as CuaCandidate,
      { id: "ax.scroll.up", tool: "scroll", operation: "scroll" } as unknown as CuaCandidate,
    ]
    const { offered, dropped } = boundCandidates([...many, ...scrolls, { id: "reobserve", tool: null } as unknown as CuaCandidate, { id: "abstain", tool: null } as unknown as CuaCandidate])
    expect(offered.filter(item => item.operation === "scroll").length).toBe(2)
    expect(offered.filter(item => item.tool).length).toBe(MAX_EXECUTABLE_CANDIDATES)
    expect(dropped).toBe(32 - MAX_EXECUTABLE_CANDIDATES)
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
    const candidate = { operation: "type_text", slotId: "q", identity: "text_entry:搜索", args: {}, tool: "type_text", id: "t", description: "", source: "ax", legacyOperation: "TYPE_TEXT" } as unknown as CuaCandidate
    const before = observation([element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"] })])
    const filled = observation([element({ elementIndex: 1, role: "AXTextField", label: "搜索", value: "蓝", actions: ["AXPress"] })])
    expect(verifyStep(candidate, before, filled, input).failed).toBe(false)
    // Delivered but the field stayed empty: not evidence.
    expect(verifyStep(candidate, before, before, input).failed).toBe(true)
  })

  test("a text step is bound to its own field, and a vanished field is not a failure", () => {
    const candidate = { operation: "type_text", slotId: "q", identity: "text_entry:搜索", args: {}, tool: "type_text", id: "t", description: "", source: "ax", legacyOperation: "TYPE_TEXT" } as unknown as CuaCandidate
    const before = observation([element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"] })])
    // The prepared text landed in a DIFFERENT field: the target's own value did
    // not change, so this must not be graded as verified (the old whole-tree
    // `some()` reported success here).
    const wrongField = observation([
      element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"] }),
      element({ elementIndex: 2, role: "AXTextField", label: "其它", value: "蓝", actions: ["AXPress"] }),
    ])
    expect(verifyStep(candidate, before, wrongField, input).failed).toBe(true)
    // The field is gone after navigation: unverifiable here, but not a failure.
    const gone = observation([element({ elementIndex: 1, role: "AXButton", label: "结果", actions: ["AXPress"] })])
    const outcome = verifyStep(candidate, before, gone, input)
    expect(outcome.failed).toBe(false)
    expect(outcome.note).toMatch(/no longer on screen/)
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

// A driver whose app/window state the test owns, so a recovery can be watched
// step by step. `fakeDriver` above always reports one on-screen window, which is
// exactly the state these tests need to vary.
function statefulDriver(options: {
  apps: () => Array<{ name: string; pid: number; running: boolean; active: boolean }>
  windows: (pid?: number) => Array<{ windowId: number; title: string; pid: number; onScreen: boolean; bounds?: { x: number; y: number; w: number; h: number } }>
  onAction?: (tool: string, args: Record<string, unknown>) => void
}): CuaDriver {
  return {
    transport: "cli",
    listTools: async () => [],
    listApps: async () => options.apps(),
    listWindows: async (query) => options.windows(query?.pid),
    getWindowState: async input => ({
      appName: "Demo",
      windowTitle: "Demo",
      pid: input.pid,
      windowId: input.windowId,
      snapshotId: "s1",
      elements: [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })],
      elementsComplete: true,
      truncated: false,
      totalElementCount: 1,
      raw: {},
    }) as WindowState,
    callTool: async (name, args = {}) => { options.onAction?.(name, args); return { value: { effect: "unconfirmed" }, text: "", images: [], isError: false } },
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

  test("a done the chooser itself is unsure of is rejected, and the run keeps going", async () => {
    // The measured failure this locks down: one refused press, then `done` at
    // 0.39 — a run that reported success having delivered nothing, and that also
    // skipped the escalation the refusal had queued up.
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    let doneAsked = 0
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async ({ candidates }) => {
        // First turn: an unsure "done", which must not end the run. After that,
        // the press the screen offers.
        const low = doneAsked === 0
        if (low) doneAsked += 1
        const choice = low
          ? candidates.find(candidate => candidate.id === "done")!
          : candidates.find(candidate => candidate.operation === "click")!
        return { selectedId: choice.id, confidence: low ? 0.39 : 0.9, probabilities: { [choice.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    // The low-confidence done was recorded as rejected, and the run went on to
    // act instead of ending there.
    expect(result.trace.some(entry => entry.outcome === "done_rejected_low_confidence")).toBe(true)
    expect(result.trace.some(entry => entry.operation === "CLICK")).toBe(true)
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
        // A change-class escalated twin (type_text) is risk-gated, so the run has
        // to be able to confirm it.
        confirm: async () => true,
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

  test("restarts an app whose only window is off-screen, instead of driving that window", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = []
    let apps = [{ name: "Demo", pid: 1, running: true, active: false }]
    const driver = statefulDriver({
      apps: () => apps,
      windows: pid => pid === 1
        ? [{ windowId: 5, title: "Demo", pid: 1, onScreen: false }]
        : [{ windowId: 7, title: "Demo", pid: 9, onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } }],
      onAction: (tool, args) => {
        calls.push({ tool, args })
        if (tool === "kill_app") apps = []
        if (tool === "launch_app") apps = [{ name: "Demo", pid: 9, running: true, active: false }]
      },
    })
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      // The restart is destructive, so it must be confirmed before it runs.
      confirm: async () => true,
      decide: async () => ({ selectedId: "done", confidence: 0.95, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, completesGoal: 0.9 }),
    })
    // One activation, then a restart — and never a look at the off-screen window.
    // The trailing activation after the relaunch is wanted, not incidental: we
    // do not take the driver's word for which app is in front.
    const tools = calls.map(call => call.tool)
    expect(tools.slice(0, 3)).toEqual(["bring_to_front", "kill_app", "launch_app"])
    expect(tools.filter(tool => tool === "kill_app")).toHaveLength(1)
    expect(tools.filter(tool => tool === "launch_app")).toHaveLength(1)
    expect(calls[1]!.args.pid).toBe(1)
    expect(result.appLaunched).toBe(true)
    expect(result.status).not.toBe("error")
    expect(result.trace.some(entry => entry.note?.includes("restarted"))).toBe(true)
  })

  test("brings the app to the front when it is not the one in front", async () => {
    // The complaint this locks down: the agent drove the app in the background and
    // the user never saw it move. A run nobody can see is also a run whose input
    // the driver keeps declining, so raising it is not only cosmetic.
    const calls: string[] = []
    const driver = statefulDriver({
      apps: () => [{ name: "Demo", pid: 1, running: true, active: false }],
      windows: () => [{ windowId: 7, title: "Demo", pid: 1, onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } }],
      onAction: tool => { calls.push(tool) },
    })
    const result = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async () => ({ selectedId: "done", confidence: 0.9, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, completesGoal: 0.9 }),
    })
    expect(calls).toEqual(["bring_to_front"])
    expect(result.status).not.toBe("error")
  })

  test("leaves an app that is already in front alone", async () => {
    // The other half: raising an app the user is already looking at would steal
    // focus for nothing.
    const calls: string[] = []
    const driver = statefulDriver({
      apps: () => [{ name: "Demo", pid: 1, running: true, active: true }],
      windows: () => [{ windowId: 7, title: "Demo", pid: 1, onScreen: true, bounds: { x: 0, y: 0, w: 800, h: 600 } }],
      onAction: tool => { calls.push(tool) },
    })
    await runCuaTask({ goal: "g", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async () => ({ selectedId: "done", confidence: 0.9, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, completesGoal: 0.9 }),
    })
    expect(calls).toEqual([])
  })

  test("never restarts the app the user is working in", async () => {
    const calls: string[] = []
    const driver = statefulDriver({
      apps: () => [{ name: "Demo", pid: 1, running: true, active: true }],
      windows: () => [{ windowId: 5, title: "Demo", pid: 1, onScreen: false }],
      onAction: tool => { calls.push(tool) },
    })
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async () => { throw new Error("must not be called") },
    })
    expect(calls).toEqual(["bring_to_front"])
    expect(result.status).toBe("error")
    expect(result.failure?.branch).toBe("window-unreachable")
    expect(result.failure?.detail).toContain("not restarting")
    expect(result.appLaunched).toBe(false)
  })

  test("a risky delivery never runs without a confirmation", async () => {
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "删除", actions: ["AXPress"], elementToken: "s1:1" })])
    const pickRemove = async ({ candidates }: { candidates: CuaCandidate[] }) => {
      const remove = candidates.find(candidate => candidate.label === "删除")!
      return { selectedId: remove.id, confidence: 0.9, probabilities: { [remove.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
    }
    // No confirmation surface at all: the step must not execute.
    const noUi = await runCuaTask({ goal: "删除这条记录", target: { app: "Demo" }, budget } as GuiTaskInput, { driver, decide: pickRemove as never })
    expect(noUi.status).toBe("needs_review")
    expect(noUi.failure?.stage).toBe("risk-gate")
    expect(noUi.failure?.branch).toBe("irreversible")
    expect(noUi.actions).toBe(0)
    // A declined confirmation is reported as such, not as an unknown failure.
    const declined = await runCuaTask({ goal: "删除这条记录", target: { app: "Demo" }, budget } as GuiTaskInput, { driver, decide: pickRemove as never, confirm: async () => false })
    expect(declined.status).toBe("needs_review")
    expect(declined.failure?.branch).toBe("declined")
  })

  test("a low-confidence done does not permanently exclude done", async () => {
    // The false-failure this locks down: rejecting a low-confidence done used to
    // add "done" to triedHere, and a screen that has stopped changing — exactly
    // the shape of a finished goal — then never offered done again.
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    let asked = 0
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async ({ candidates }) => {
        asked++
        expect(candidates.some(candidate => candidate.id === "done")).toBe(true)
        return { selectedId: "done", confidence: asked === 1 ? 0.39 : 0.9, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(result.status).toBe("done")
    expect(asked).toBe(2)
    expect(result.trace.some(entry => entry.outcome === "done_rejected_low_confidence")).toBe(true)
  })

  test("a high predicted completion does not excuse a very low confidence done", async () => {
    // The hole this closes: `predicted >= COMPLETION_THRESHOLD` alone used to
    // accept the answer, so a chooser that pointed at the wrong control could
    // predict 0.99 from the goal text and still finish having changed nothing.
    // The prediction must not cover for a missing confidence.
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    let asked = 0
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async () => {
        asked++
        const low = asked === 1
        return { selectedId: "done", confidence: low ? 0.05 : 0.9, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 }, completesGoal: 0.99 }
      },
    })
    expect(result.trace.some(entry => entry.outcome === "done_rejected_low_confidence")).toBe(true)
    expect(asked).toBe(2)
    expect(result.status).toBe("done")
  })

  test("an escalated delivery is confirmed once per target; a risky one every time", () => {
    const escalated = { id: "ax.button.aaaa1111.fg", description: "", source: "ax", operation: "click", tool: "click", args: {}, legacyOperation: "CLICK", escalated: true, identity: "button:播放:fg" } as unknown as CuaCandidate
    // The first escalated attempt at a target needs a human.
    expect(requiresConfirmation(escalated)).toBe(true)
    // Approving it records the *base* target, not the rung-suffixed identity.
    const approved = new Set<string>([escalatedTarget(escalated)!])
    expect(approved.has("button:播放")).toBe(true)
    // The same target's later escalated attempts are the same decision.
    expect(requiresConfirmation(escalated, approved)).toBe(false)
    // A different target still asks.
    expect(requiresConfirmation({ ...escalated, identity: "button:删除:fg" } as unknown as CuaCandidate, approved)).toBe(true)
    // A risky label keeps asking, whatever was approved: repeating a
    // confirmation for a destructive action is the point.
    expect(requiresConfirmation({ ...escalated, risky: true } as unknown as CuaCandidate, new Set(["button:播放"]))).toBe(true)
    // Only a change-class escalated delivery is gated; neither a plain change
    // nor an escalated non-change asks.
    expect(requiresConfirmation({ ...escalated, operation: "scroll" } as unknown as CuaCandidate)).toBe(false)
    expect(requiresConfirmation({ ...escalated, escalated: false, identity: "button:播放" } as unknown as CuaCandidate)).toBe(false)
  })

  test("the loop remembers an approved escalation, so it does not ask twice for one target", async () => {
    // The unusable-for-Electron case: the driver refuses background input for a
    // target every time, so every step arrives as an escalated candidate. Only
    // the first attempt at that target should reach the confirmation surface.
    let elements = [
      element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" }),
      element({ elementIndex: 2, role: "AXStaticText", label: "状态0" }),
      element({ elementIndex: 3, role: "AXStaticText", label: "计数0" }),
    ]
    let seq = 0
    const driver = fakeDriver(() => elements, (tool, args) => {
      if (tool !== "click") return
      if (args.delivery_mode !== "foreground") {
        throw new DriverToolError("click", "background_unavailable", "Electron AX target", false, { code: "background_unavailable", effect: "refused", escalation: { recommended: "foreground", reason: "Electron/Chromium" } })
      }
      seq++
      // The target keeps its identity; two other controls change so the screen
      // really moved (>1 line) and the base candidate is not suppressed as a
      // no-op or by the stall brake's one-line tolerance.
      elements = [
        element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" }),
        element({ elementIndex: 2, role: "AXStaticText", label: `状态${seq}` }),
        element({ elementIndex: 3, role: "AXStaticText", label: `计数${seq}` }),
      ]
    })
    let confirms = 0
    let turn = 0
    const result = await runCuaTask({ goal: "播放蓝", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      confirm: async () => { confirms++; return true },
      decide: async ({ candidates }) => {
        turn++
        const pick = turn <= 2
          ? candidates.find(candidate => candidate.operation === "click" && (turn === 1 ? !candidate.id.endsWith(".fg") : candidate.id.endsWith(".fg")))!
          : turn === 3
            ? candidates.find(candidate => candidate.id.endsWith(".fg"))!
            : candidates.find(candidate => candidate.id === "done")!
        return { selectedId: pick.id, confidence: 0.9, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(confirms).toBe(1)
    expect(result.status).toBe("done")
  })

  test("a capped offer set says so and still offers scrolling", async () => {
    const elements = Array.from({ length: 30 }, (_, index) => element({ elementIndex: index + 1, role: "AXButton", label: `按钮${index + 1}`, actions: ["AXPress"], elementToken: `s1:${index + 1}` }))
    const driver = fakeDriver(() => elements)
    let seenContext = ""
    let sawScroll = false
    const result = await runCuaTask({ goal: "找到一个按钮", target: { app: "Demo" }, budget } as GuiTaskInput, {
      driver,
      decide: async ({ candidates, observation }) => {
        seenContext = observation.context
        sawScroll = candidates.some(candidate => candidate.operation === "scroll")
        return { selectedId: "done", confidence: 0.9, probabilities: { done: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(result.status).toBe("done")
    expect(sawScroll).toBe(true)
    expect(seenContext).toContain("dropped=")
  })

  test("a decision killed by the spent deadline is a timeout, not a decide error", async () => {
    const driver = fakeDriver(() => [element({ elementIndex: 1, role: "AXButton", label: "播放", actions: ["AXPress"], elementToken: "s1:1" })])
    const result = await runCuaTask({ goal: "g", target: { app: "Demo" }, budget: { maxActions: 5, maxDecisions: 5, maxDurationMs: 1_000 } } as GuiTaskInput, {
      driver,
      decide: async () => { await new Promise(resolve => setTimeout(resolve, 1_500)); throw new Error("the chooser was killed") },
    })
    expect(result.status).toBe("timeout")
    expect(result.failure?.branch).toBe("duration")
  })

  test("the chooser receives performed steps, not just counters", async () => {
    let elements = [element({ elementIndex: 1, role: "AXTextField", label: "搜索", actions: ["AXPress"], elementToken: "s1:1" })]
    const driver = fakeDriver(() => elements, tool => { if (tool === "type_text") elements = [element({ elementIndex: 1, role: "AXTextField", label: "搜索", value: "蓝", actions: ["AXPress"], elementToken: "s1:1" })] })
    const progress: Array<Record<string, unknown>> = []
    const result = await runCuaTask({ goal: "输入蓝", target: { app: "Demo" }, budget, textSlots: [{ id: "q", value: "蓝", description: "搜索" }] } as GuiTaskInput, {
      driver,
      decide: async ({ candidates, progress: seen }) => {
        progress.push(seen as unknown as Record<string, unknown>)
        const type = candidates.find(candidate => candidate.operation === "type_text")
        const pick = type ?? candidates.find(candidate => candidate.id === "done")!
        return { selectedId: pick.id, confidence: 0.95, probabilities: { [pick.id]: 1 }, model: "fake", latencyMs: 0, usage: { inputTokens: 0, outputTokens: 0 } }
      },
    })
    expect(result.status).toBe("done")
    expect(progress[0]).toMatchObject({ actions: 0, decisions: 0, performedSteps: {} })
    expect(progress[1]).toMatchObject({ actions: 1, decisions: 1, performedSteps: { "text_entry:搜索": 1 } })
  })
})

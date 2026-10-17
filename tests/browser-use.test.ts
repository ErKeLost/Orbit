/**
 * Offline contracts for the browser loop. No network, no browser, no model.
 *
 * Same intent as `jev_ultrafast/tests/test_agent.py` (MIT) — that project's
 * rules are only worth anything if code enforces them — plus the offer-set and
 * pairing rules Orbit's port adds, which are the parts most likely to drift.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Window } from "happy-dom"
import { actionSpace, choose, runBrowserTask, type BrowserDriverLike } from "../src-tauri/resources/browser-use/browser-engine"
import { PageBusy, StalePage, fingerprint, sameLocation, stable } from "../src-tauri/resources/browser-use/browser-driver"
import type { BrowserAction, BrowserObservation } from "../src-tauri/resources/browser-use/browser-driver"
import type { BrowserDecision, TextSlot } from "../src-tauri/resources/browser-use/browser-contract"
import { parseText, prompt } from "../src-tauri/resources/browser-use/text-helper"
import { normalizeAddress } from "../src/lib/browser"

function observation(actions: BrowserAction[], overrides: Partial<BrowserObservation> = {}): BrowserObservation {
  const page: BrowserObservation = {
    url: "https://example.test/",
    title: "Search",
    w: 1120,
    h: 780,
    text: "Search",
    scroll: { y: 0, height: 780 },
    actions,
    marker: ["marker"],
    page_key: ["key"],
    guards: {},
    omitted_actions: 0,
    fingerprint: "f0",
    ...overrides,
  }
  return page
}

const fill = (id: string, node: number, label: string, extra: Partial<BrowserAction> = {}): BrowserAction => ({ id, kind: "fill", node, label, role: "textbox", value: "", ...extra })
const click = (id: string, node: number, label: string, extra: Partial<BrowserAction> = {}): BrowserAction => ({ id, kind: "click", node, label, role: "button", ...extra })
const controls: BrowserAction[] = [
  { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 },
  { id: "wait", kind: "wait", label: "Wait for the page to update" },
]

describe("action space", () => {
  test("numbers each node once and keeps one target list per operation", () => {
    const { elements, targets, controls: control } = actionSpace([fill("e1", 10, "Search"), click("e2", 10, "Open Search"), click("e3", 20, "Go"), ...controls])
    expect(elements.map(element => element.index)).toEqual(["1", "2"])
    expect(elements[0]).toMatchObject({ label: "Search", operations: ["TYPE_TEXT", "CLICK"] })
    expect(Object.keys(targets)).toEqual(["TYPE_TEXT", "CLICK"])
    expect(Object.keys(targets.TYPE_TEXT!)).toEqual(["1"])
    expect(Object.keys(targets.CLICK!)).toEqual(["1", "2"])
    // A control acts on the page, not on an element, so it is not numbered.
    expect(Object.keys(control).sort()).toEqual(["SCROLL_DOWN", "WAIT"])
  })

  test("a dropdown value is its own target, so no value is ever quoted by the model", () => {
    const select: BrowserAction = {
      id: "e1",
      kind: "select",
      node: 30,
      label: "Category → Design",
      role: "combobox",
      value: "design",
      current_value: "All",
    }
    const second: BrowserAction = { ...select, id: "e2", label: "Category → Coastal", value: "coastal" }
    const { elements, targets } = actionSpace([select, second])
    expect(elements).toHaveLength(1)
    expect(elements[0]!.options?.map(option => option.index)).toEqual(["1:1", "1:2"])
    expect(Object.keys(targets.SELECT!)).toEqual(["1:1", "1:2"])
  })

  test("an element carries its reachability, so the model can scroll or close an overlay first", () => {
    const { elements, targets } = actionSpace([
      click("e1", 10, "Accept cookies", { covered: true, covered_by: "Cookie banner" }),
      click("e2", 11, "Submit", { offscreen: true }),
    ])
    // The flags travel with the element and with the offered target, not only
    // with the input attempt that would fail.
    expect(elements[0]).toMatchObject({ covered: true, covered_by: "Cookie banner" })
    expect(elements[1]).toMatchObject({ offscreen: true })
    expect(targets.CLICK!["1"]).toMatchObject({ covered: true, covered_by: "Cookie banner" })
    expect(targets.CLICK!["2"]).toMatchObject({ offscreen: true })
  })
})

describe("fingerprint", () => {
  test("geometry is not part of it: a moved control is still the same page", () => {
    const before = observation([click("e1", 10, "Continue", { rect: { x: 0, y: 0, w: 10, h: 10 } })])
    const after = observation([click("e1", 10, "Continue", { rect: { x: 400, y: 20, w: 10, h: 10 } })])
    expect(fingerprint(before)).toBe(fingerprint(after))
  })

  test("a changed value or label is a different page", () => {
    const before = observation([fill("e1", 10, "City", { value: "Zurich" })])
    expect(fingerprint(before)).not.toBe(fingerprint(observation([fill("e1", 10, "City", { value: "London" })])))
    expect(fingerprint(before)).not.toBe(fingerprint(observation([fill("e1", 10, "Town", { value: "Zurich" })])))
  })

  test("key order does not change it", () => {
    expect(stable({ b: 1, a: { d: 2, c: 3 } })).toBe(stable({ a: { c: 3, d: 2 }, b: 1 }))
  })
})

/** A text helper that answers without a model process. */
const helper = (answer: string | null | Error) => async () => {
  if (answer instanceof Error) throw answer
  return answer === null ? null : { text: answer, latencyMs: 1 }
}

/** A driver whose page the test controls, plus the calls it received. */
function fakeDriver(pages: BrowserObservation[], options: { stale?: number; unreadableAfter?: number; engine?: "view" | "chrome"; fail?: Error[]; busy?: boolean } = {}): BrowserDriverLike & { acts: { id: string; text?: string }[]; observes: number } {
  const state = { acts: [] as { id: string; text?: string }[], observes: 0, stale: options.stale ?? 0 }
  const failures = [...(options.fail ?? [])]
  return {
    acts: state.acts,
    ...(options.engine ? { engine: options.engine } : {}),
    get observes() {
      return state.observes
    },
    async observe() {
      state.observes += 1
      if (options.busy) throw new PageBusy()
      if (options.unreadableAfter !== undefined && state.observes > options.unreadableAfter) throw new Error("renderer gone")
      return pages[Math.min(state.observes - 1, pages.length - 1)]!
    },
    async fresh() {
      return true
    },
    async act(action, _page, text) {
      if (failures.length > 0) throw failures.shift()
      if (state.stale > 0) {
        state.stale -= 1
        throw new StalePage("page moved")
      }
      state.acts.push({ id: action.id, ...(text === undefined ? {} : { text }) })
    },
    close() {},
  }
}

function decision(action: BrowserAction, extra: Partial<BrowserDecision> = {}): BrowserDecision {
  return {
    action,
    operation: action.kind === "fill" ? "TYPE_TEXT" : action.kind === "scroll" ? "SCROLL_DOWN" : "CLICK",
    confidence: 1,
    probabilities: { [action.id]: 1 },
    model: "test",
    latencyMs: 1,
    usage: { inputTokens: 1, outputTokens: 1 },
    request: {},
    ...extra,
  }
}

const budget = { maxActions: 6, maxDecisions: 10, maxDurationMs: 30_000 }
const slots: TextSlot[] = [{ id: "query", value: "private song", description: "the song to search for" }]

describe("loop rules", () => {
  test("records the action before observing its result", async () => {
    // The post-action read fails; the delivered action must still be reported.
    const driver = fakeDriver([observation([...controls]), observation([...controls])], { unreadableAfter: 1 })
    const result = await runBrowserTask({
      input: { goal: "go", budget },
      driver,
      decide: async () => decision(click("e3", 20, "Go")),
    })
    expect(driver.acts).toHaveLength(1)
    expect(result.trace).toHaveLength(1)
    expect(result.trace[0]).toMatchObject({ operation: "CLICK", label: "Go" })
    expect(result.status).toBe("error")
  })

  test("a stale decision executes nothing and is not counted as an action", async () => {
    const page = observation([click("e3", 20, "Go"), ...controls])
    const driver = fakeDriver([page, page, page], { stale: 1 })
    let calls = 0
    const result = await runBrowserTask({
      input: { goal: "go", budget },
      driver,
      decide: async () => (++calls === 1 ? decision(click("e3", 20, "Go")) : { ...decision(click("e3", 20, "Go")), action: undefined, operation: "DONE" }),
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.decisions).toBe(2)
    expect(result.steps).toBe(0)
    expect(result.status).toBe("done")
  })

  test("a field with no prepared value stops with needs_text instead of inventing one", async () => {
    const page = observation([fill("e1", 10, "Where from?")])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "book a flight", budget },
      driver,
      decide: async () => decision(fill("e1", 10, "Where from?"), { operation: "TYPE_TEXT" }),
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.status).toBe("needs_text")
    expect(result.failure?.stage).toBe("slot")
    expect(result.failure?.detail).toContain("Where from?")
  })

  test("the caller's prepared value is what gets typed, never anything else", async () => {
    const page = observation([fill("e1", 10, "Search")])
    const driver = fakeDriver([page, page])
    let calls = 0
    const result = await runBrowserTask({
      input: { goal: "search", budget, textSlots: slots },
      driver,
      decide: async () => (++calls === 1
        ? decision(fill("e1", 10, "Search"), { slotId: "query" })
        : { ...decision(fill("e1", 10, "Search")), action: undefined, operation: "DONE" }),
    })
    expect(driver.acts).toEqual([{ id: "e1", text: "private song" }])
    expect(result.trace[0]).toMatchObject({ slotId: "query" })
  })

  test("a field nothing covers is written by the run's own model", async () => {
    const page = observation([fill("e1", 10, "Search Wikipedia")])
    const driver = fakeDriver([page, page])
    let calls = 0
    const result = await runBrowserTask({
      input: { goal: "search Wikipedia for Gödel", budget },
      driver,
      generate: helper("Gödel's incompleteness theorems"),
      decide: async () => (++calls === 1
        ? decision(fill("e1", 10, "Search Wikipedia"), { operation: "TYPE_TEXT" })
        : { ...decision(fill("e1", 10, "Search Wikipedia")), action: undefined, operation: "DONE" }),
    })
    expect(driver.acts).toEqual([{ id: "e1", text: "Gödel's incompleteness theorems" }])
    expect(result.metrics.generatedValues).toBe(1)
    expect(result.status).toBe("done")
  })

  test("a prepared slot beats the model's own answer", async () => {
    const page = observation([fill("e1", 10, "Search Wikipedia")])
    const driver = fakeDriver([page, page])
    let generated = 0
    let calls = 0
    await runBrowserTask({
      input: { goal: "search Wikipedia", budget, textSlots: slots },
      driver,
      generate: async () => {
        generated += 1
        return { text: "from the model", latencyMs: 1 }
      },
      decide: async () => (++calls === 1
        ? decision(fill("e1", 10, "Search Wikipedia"), { slotId: "query" })
        : { ...decision(fill("e1", 10, "Search Wikipedia")), action: undefined, operation: "DONE" }),
    })
    expect(driver.acts).toEqual([{ id: "e1", text: "private song" }])
    expect(generated).toBe(0)
  })

  test("with generated text off, a field with no slot stops the run", async () => {
    const page = observation([fill("e1", 10, "Search Wikipedia")])
    const driver = fakeDriver([page])
    let generated = 0
    const result = await runBrowserTask({
      input: { goal: "search Wikipedia", budget, allowGeneratedText: false },
      driver,
      generate: async () => {
        generated += 1
        return { text: "never", latencyMs: 1 }
      },
      decide: async () => decision(fill("e1", 10, "Search Wikipedia"), { operation: "TYPE_TEXT" }),
    })
    expect(generated).toBe(0)
    expect(driver.acts).toHaveLength(0)
    expect(result.status).toBe("needs_text")
    expect(result.failure?.branch).toBe("slot-disabled")
  })

  test("a model that cannot know the value stops the run instead of inventing one", async () => {
    const page = observation([fill("e1", 10, "Email address")])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "sign up for the newsletter", budget },
      driver,
      generate: helper(null),
      decide: async () => decision(fill("e1", 10, "Email address"), { operation: "TYPE_TEXT" }),
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.status).toBe("needs_text")
    expect(result.failure?.branch).toBe("model-gap")
    expect(result.failure?.detail).toContain("Email address")
  })

  test("a broken text helper is reported, not swallowed", async () => {
    const page = observation([fill("e1", 10, "Search")])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "search", budget },
      driver,
      generate: helper(new Error("没有可用的文本模型")),
      decide: async () => decision(fill("e1", 10, "Search"), { operation: "TYPE_TEXT" }),
    })
    expect(result.status).toBe("needs_text")
    expect(result.failure?.branch).toBe("text-helper")
    expect(result.failure?.detail).toContain("没有可用的文本模型")
  })

  test("three steps that change nothing stop the run instead of clicking on", async () => {
    const page = observation([click("e3", 20, "Go"), ...controls])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "go", budget },
      driver,
      decide: async () => decision(click("e3", 20, "Go")),
    })
    expect(driver.acts).toHaveLength(3)
    expect(result.status).toBe("blocked")
    expect(result.failure?.branch).toBe("no-effect")
  })

  test("an irreversible step is never executed without a confirmation", async () => {
    const page = observation([click("e3", 20, "Place order"), ...controls])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "order", budget },
      driver,
      decide: async () => decision(click("e3", 20, "Place order"), { irreversible: 0.9 }),
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.status).toBe("needs_review")
    expect(result.failure?.stage).toBe("risk-gate")
  })

  test("a declined confirmation stops the run", async () => {
    const page = observation([click("e3", 20, "Place order"), ...controls])
    const driver = fakeDriver([page])
    const result = await runBrowserTask({
      input: { goal: "order", budget },
      driver,
      confirm: async () => false,
      decide: async () => decision(click("e3", 20, "Place order"), { irreversible: 0.9 }),
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.status).toBe("needs_review")
    expect(result.failure?.branch).toBe("declined")
  })

  test("an accepted confirmation executes exactly once", async () => {
    const page = observation([click("e3", 20, "Place order"), ...controls])
    const driver = fakeDriver([page, page, page, page])
    let calls = 0
    const result = await runBrowserTask({
      input: { goal: "order", budget },
      driver,
      confirm: async () => true,
      decide: async () => (++calls === 1 ? decision(click("e3", 20, "Place order"), { irreversible: 0.9 }) : { ...decision(click("e3", 20, "Place order")), action: undefined, operation: "DONE" }),
    })
    expect(driver.acts).toHaveLength(1)
    expect(result.status).toBe("done")
  })

  test("the action budget is a stop, not a suggestion", async () => {
    const page = observation([click("e3", 20, "Go"), ...controls])
    const driver = fakeDriver([page])
    let index = 0
    const result = await runBrowserTask({
      input: { goal: "go", budget: { ...budget, maxActions: 2 } },
      driver,
      // Alternate so the no-change guard cannot fire first.
      decide: async () => decision(index++ % 2 ? observation([]).actions[0] ?? click("e3", 20, "Go") : click("e3", 20, "Go")),
    })
    expect(result.status).toBe("max_actions")
    expect(result.steps).toBe(2)
  })

  test("the page's own errors reach the decision, and only when there are new ones", async () => {
    const page = observation([click("e3", 20, "Search"), ...controls], {
      errors: ["error: Uncaught TypeError: cannot read properties of undefined", "HTTP 500 https://example.test/api/search"],
    })
    const seen: { state?: Record<string, unknown> } = {}
    const client = {
      systemOne: async (request: { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, unknown> }> }) => {
        seen.state = request.state
        const criteria = Object.keys(request.questions.operation!.criteria!)
        const chosen = criteria.includes("DONE") ? "DONE" : "CLICK"
        return {
          model: "test",
          answers: {
            operation: {
              type: "choice",
              choice: chosen,
              confidence: 1,
              probabilities: Object.fromEntries(criteria.map(key => [key, key === chosen ? 1 : 0])),
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    await choose(page, "find a flight", [], [], { readOnly: true, client: client as never })
    const state = seen.state as { page?: { errors?: string[] } }
    expect(state.page?.errors).toEqual([
      "error: Uncaught TypeError: cannot read properties of undefined",
      "HTTP 500 https://example.test/api/search",
    ])
    // An observation without new errors carries no key at all, so a decision is
    // never re-reading yesterday's failure.
    await choose(observation([click("e3", 20, "Search"), ...controls]), "find a flight", [], [], { readOnly: true, client: client as never })
    expect((seen.state as { page?: { errors?: string[] } }).page?.errors).toBeUndefined()
  })

  test("read-only never offers a mutation, and the offer set pairs values with fields", async () => {
    const page = observation([
      fill("e1", 10, "Where from?"),
      fill("e2", 11, "Where to?"),
      click("e3", 20, "Search"),
      ...controls,
      { id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 },
    ])
    const seen: { questions: Record<string, { criteria?: Record<string, unknown> }> } = { questions: {} }
    // Answers are built from the request's own criteria, so the test fails if
    // the offer set and the question disagree — the way a real request would.
    const client = {
      systemOne: async (request: { questions: Record<string, { criteria?: Record<string, unknown> }> }) => {
        seen.questions = request.questions
        const criteria = Object.keys(request.questions.operation!.criteria!)
        const chosen = criteria.includes("DONE") ? "DONE" : "CLICK"
        return {
          model: "test",
          answers: {
            operation: {
              type: "choice",
              choice: chosen,
              confidence: 1,
              probabilities: Object.fromEntries(criteria.map(key => [key, key === chosen ? 1 : 0])),
            },
          },
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
    await choose(page, "find a flight", [], slots, { readOnly: true, client: client as never })
    const operation = seen.questions.operation!.criteria!
    expect(Object.keys(operation)).not.toContain("CLICK")
    expect(Object.keys(operation)).not.toContain("TYPE_TEXT")
    expect(Object.keys(operation)).not.toContain("SELECT")
    expect(Object.keys(operation)).toContain("DONE")
    // Scrolling is observation, not mutation, and it is what a read-only run on
    // a long page needs. It used to be removed along with the real targets.
    expect(Object.keys(operation)).toContain("SCROLL_DOWN")
    expect(Object.keys(operation)).toContain("SCROLL_UP")
    expect(seen.questions.type_text_target).toBeUndefined()
    expect(seen.questions.click_target).toBeUndefined()

    await choose(page, "find a flight", [], slots, { client: client as never })
    // One offered target per field × prepared value, and the field it belongs to
    // travels with it: `1:query` is "element 1 with the caller's query value".
    const targets = seen.questions.type_text_target!.criteria!
    expect(Object.keys(targets)).toEqual(["1:query", "2:query"])
    expect(targets["1:query"]).toMatchObject({ prepared_value_purpose: "the song to search for" })
    // A dropdown option keeps its own encoding, so a value is never quoted.
    expect(Object.keys(seen.questions.click_target!.criteria!)).toEqual(["3"])
  })

  test("a DONE below the confidence floor is refused, and DONE stays on the table", async () => {
    const page = observation([click("e3", 20, "Go"), ...controls])
    const driver = fakeDriver([page])
    let calls = 0
    const result = await runBrowserTask({
      input: { goal: "go", budget },
      driver,
      decide: async () => {
        calls += 1
        // A weak "done", then the same decision with a real answer.
        return calls === 1
          ? decision(click("e3", 20, "Go"), { action: undefined, operation: "DONE", confidence: 0.4 })
          : { ...decision(click("e3", 20, "Go")), action: undefined, operation: "DONE", confidence: 0.95 }
      },
    })
    expect(driver.acts).toHaveLength(0)
    expect(result.decisions).toBe(2)
    expect(result.status).toBe("done")
    // The refusal is written down, so the next decision can see why it happened
    // instead of repeating the same weak answer forever.
    expect(result.trace.some(step => step.operation === "DONE" && step.note?.includes("置信度"))).toBe(true)
  })

  test("no prepared value reaches the decision model, wherever it sits on the page", async () => {
    const page = observation([
      fill("e1", 10, "Search", { value: "private song" }),
      { id: "e2", kind: "select", node: 30, label: "Category → private song", role: "combobox", value: "private song", current_value: "private song" },
      ...controls,
    ])
    const { client, seen } = captureClient()
    await choose(page, "search", [], slots, { client: client as never })
    // Observation *and* offer set: the value used to survive in an element's own
    // `value`, a select's `current_value` and its option labels.
    const payload = JSON.stringify({ state: seen.state, questions: seen.questions })
    expect(payload).not.toContain("private song")
    expect(payload).toContain("[slot:query]")
  })

  test("the result reports which engine actually drove the run", async () => {
    const page = observation([click("e3", 20, "Go"), ...controls])
    const result = await runBrowserTask({
      input: { goal: "go", budget: { ...budget, maxActions: 1 } },
      driver: fakeDriver([page], { engine: "view" }),
      decide: async () => decision(click("e3", 20, "Go")),
    })
    expect(result.metrics.engine).toBe("view")
  })
})

/**
 * A refusal has to say *why*, because the two cases need different next moves:
 * an overlay is removed, a moving page is re-read, a busy page is waited for.
 */
describe("refusals that name themselves", () => {
  test("a covered target names the coverer and the loop re-observes instead of stopping", async () => {
    const page = observation([click("e3", 20, "Pay"), ...controls])
    const driver = fakeDriver([page], { fail: [new StalePage("目标被「Cookie 横幅」遮住了：先关掉它再重新观察", "covered", "Cookie 横幅")] })
    const result = await runBrowserTask({
      input: { goal: "pay", budget: { ...budget, maxActions: 1 } },
      driver,
      decide: async () => decision(click("e3", 20, "Pay")),
    })
    // The refusal is recorded with the coverer's name, and the click that was
    // refused is not counted as a step that happened.
    expect(result.trace[0]?.note).toContain("Cookie 横幅")
    expect(result.steps).toBe(1)
    expect(driver.acts.map(action => action.id)).toEqual(["e3"])
  })

  test("a page that never becomes readable ends as blocked, not as an error to retry blindly", async () => {
    const result = await runBrowserTask({
      input: { goal: "pay", budget },
      driver: fakeDriver([observation(controls)], { busy: true }),
      decide: async () => decision(click("e3", 20, "Pay")),
    })
    expect(result.status).toBe("blocked")
    expect(result.failure?.branch).toBe("busy")
  })
})

describe("landing address", () => {
  test("the same host on a different page is a different page", () => {
    expect(sameLocation("https://example.test/", "https://example.test/")).toBe(true)
    // A trailing slash never means a different page.
    expect(sameLocation("https://example.test/", "https://example.test")).toBe(true)
    // The bug this replaced: `/login` requested, tab parked on the same site's `/`.
    expect(sameLocation("https://example.test/login", "https://example.test/")).toBe(false)
    // A different query is a different page; the fragment is not.
    expect(sameLocation("https://example.test/login", "https://example.test/login?next=1")).toBe(false)
    expect(sameLocation("https://example.test/login#a", "https://example.test/login#b")).toBe(true)
    expect(sameLocation("about:blank", "https://example.test/")).toBe(false)
  })
})

/** A client that answers without a model and records the request it was sent. */
function captureClient(pick: (criteria: string[]) => string = criteria => (criteria.includes("DONE") ? "DONE" : criteria[0]!)) {
  const seen: { state?: Record<string, unknown>; questions?: Record<string, unknown> } = {}
  const client = {
    systemOne: async (request: { state: Record<string, unknown>; questions: Record<string, { criteria?: Record<string, unknown> }> }) => {
      seen.state = request.state
      seen.questions = request.questions as never
      const criteria = Object.keys(request.questions.operation!.criteria!)
      const chosen = pick(criteria)
      return {
        model: "test",
        answers: {
          operation: {
            type: "choice",
            choice: chosen,
            confidence: 1,
            probabilities: Object.fromEntries(criteria.map(key => [key, key === chosen ? 1 : 0])),
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    },
  }
  return { client, seen }
}

describe("the text helper's contract", () => {
  test("accepts exactly one text value", () => {
    expect(parseText('{"text": "Zurich"}')).toBe("Zurich")
    // A model that wraps its answer is still understood…
    expect(parseText('Here you go:\n```json\n{"text": "London"}\n```')).toBe("London")
    // …but a missing value is missing, not invented.
    expect(parseText('{"text": null}')).toBeNull()
  })

  test("refuses anything that is not one field value", () => {
    expect(() => parseText("Zurich")).toThrow("没有返回 JSON 对象")
    expect(() => parseText('{"text": "a", "why": "b"}')).toThrow("只有一个 text 键")
    expect(() => parseText('{"value": "Zurich"}')).toThrow("只有一个 text 键")
    expect(() => parseText('{"text": ""}')).toThrow("不是有效的字段值")
    expect(() => parseText('{"text": {"a": 1}}')).toThrow("不是有效的字段值")
    expect(() => parseText(`{"text": "${"x".repeat(2_001)}"}`)).toThrow("不是有效的字段值")
  })

  test("the prompt carries the field, the goal and only prepared *purposes*", () => {
    const body = prompt({
      goal: "search Wikipedia for Gödel",
      field: fill("e1", 10, "Search Wikipedia"),
      page: observation([]),
      history: [],
      slots: [{ id: "query", value: "private song", description: "the term to search for" }],
    })
    expect(body).toContain("search Wikipedia for Gödel")
    expect(body).toContain("Search Wikipedia")
    expect(body).toContain("the term to search for")
    // The value itself is never sent: the helper writes new text, it does not
    // get to see the caller's secrets.
    expect(body).not.toContain("private song")
  })
})

describe("the address bar is an omnibox", () => {
  test("a URL keeps its scheme, a host gets https, a word becomes a search", () => {
    expect(normalizeAddress("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(normalizeAddress("http://127.0.0.1:5173/")).toBe("http://127.0.0.1:5173/")
    expect(normalizeAddress("localhost:3000")).toBe("http://localhost:3000")
    expect(normalizeAddress("192.168.1.4")).toBe("http://192.168.1.4")
    expect(normalizeAddress("example.com/docs")).toBe("https://example.com/docs")
    expect(normalizeAddress("  example.com  ")).toBe("https://example.com")
    // The case that made typing a word look broken: it is a query, not a host.
    expect(normalizeAddress("baidu")).toBe("https://www.baidu.com/s?wd=baidu")
    expect(normalizeAddress("百度 音乐")).toContain("wd=%E7%99%BE%E5%BA%A6%20%E9%9F%B3%E4%B9%90")
    expect(normalizeAddress("   ")).toBe("")
  })
})

/**
 * The page observer's own budgets, run against the real `snapshot.js` in a DOM.
 *
 * The guard script is the end-to-end check, but it needs a real browser. This
 * runs the same observer with a stubbed layout so the rule that matters — the
 * heuristic channel is not squeezed out by a selector that fills the table —
 * cannot silently regress where no browser is available.
 */
describe("page observer budgets", () => {
  const SNAPSHOT = readFileSync(new URL("../src-tauri/resources/browser-use/snapshot.js", import.meta.url), "utf8")

  function observeDocument(html: string): BrowserObservation {
    const window = new Window({ url: "http://localhost/" })
    const document = window.document
    document.body.innerHTML = html
    // happy-dom does no layout, so every element needs a real on-screen box and
    // the two probes the observer makes need an answer. `checkVisibility` stays
    // true and `elementFromPoint` finds nothing, so nothing is dropped as hidden
    // or covered and the budget is the only thing under test.
    const prototype = (window as unknown as { HTMLElement: { prototype: Record<string, unknown> } }).HTMLElement.prototype
    prototype.getBoundingClientRect = () => ({ x: 10, y: 10, width: 180, height: 40, top: 10, left: 10, right: 190, bottom: 50 })
    prototype.checkVisibility = () => true
    ;(document as unknown as { elementFromPoint: () => null }).elementFromPoint = () => null
    const run = new Function(
      "document", "window", "performance", "location", "getComputedStyle",
      "innerWidth", "innerHeight", "scrollX", "scrollY", "NodeFilter",
      // The parens matter: `return` followed by a newline is ASI, which would
      // drop the whole observer expression instead of returning it.
      `return (${SNAPSHOT})`,
    ) as (...args: unknown[]) => BrowserObservation
    return run(document, window, window.performance, window.location, window.getComputedStyle.bind(window), 1120, 780, 0, 0, window.NodeFilter)
  }

  test("a heuristic control survives a selector that fills the table", () => {
    // Upstream spent the whole table cap on the fixed selector, so the heuristic
    // pass — the reason a React page full of `<div onClick>` is visible at all —
    // ran after the cap was full and collected nothing.
    const buttons = Array.from({ length: 260 }, (_, index) => `<button>Dense ${index}</button>`).join("")
    const page = observeDocument(`<div>${buttons}</div><div><div onclick="1">Book now</div></div>`)
    expect(page.omitted_actions).toBeGreaterThan(0)
    expect(page.actions.some(action => action.label.trim() === "Book now")).toBe(true)
    // The selector still gets the rest of the table; the reserve is not a tax on it.
    expect(page.actions.filter(action => /^Dense \d+$/.test(action.label.trim())).length).toBeGreaterThan(200)
  })

  test("a page that fits keeps every control", () => {
    const page = observeDocument(`<button>Only</button><div onclick="1">Box</div>`)
    expect(page.omitted_actions).toBe(0)
    expect(page.actions.map(action => action.label)).toEqual(["Only", "Box", "Wait for the page to update"])
  })

  test("a field the page draws as dots keeps its value out of the table", () => {
    // An OTP / card widget: an ordinary text input whose CSS draws the value as
    // dots. The field stays actionable — the model may need to type into it —
    // but the value itself is the page saying "nobody should read this".
    const page = observeDocument(
      `<input aria-label="验证码" style="-webkit-text-security: disc" value="482913">` +
        `<input aria-label="数量" value="2">`,
    )
    const otp = page.actions.find(action => action.label === "验证码" && action.kind === "fill")!
    expect(otp.value).toBe("••••••••")
    expect(otp.masked).toBe(true)
    // Kept for the loop's own "this field already holds it" check, never for the
    // decision context: `actionSpace` only copies the fields it names.
    expect(otp.raw).toBe("482913")
    const quantity = page.actions.find(action => action.label === "数量")!
    expect(quantity.value).toBe("2")
    expect(quantity.masked).toBeUndefined()
  })

  test("an empty dotted field still reads as empty", () => {
    const page = observeDocument(`<input aria-label="验证码" style="-webkit-text-security: disc">`)
    const otp = page.actions.find(action => action.label === "验证码" && action.kind === "fill")!
    expect(otp.value).toBe("")
    expect(otp.masked).toBeUndefined()
  })

  test("a control inside a same-origin frame is observed and marked", () => {
    // Payment and login forms are often an <iframe>. A walk of the top document
    // cannot see one, which is exactly why those pages looked empty: the fields
    // existed, one document down.
    const page = observeDocument(
      `<button>Pay</button><iframe srcdoc='<input aria-label="Card number" value="4242"><button>Confirm</button>'></iframe>`,
    )
    const card = page.actions.find(action => action.label === "Card number")
    expect(card).toBeDefined()
    expect(card?.frame).toBe(true)
    expect(card?.value).toBe("4242")
    expect(page.actions.some(action => action.label === "Confirm")).toBe(true)
    // The top document's own controls are unaffected.
    expect(page.actions.some(action => action.label === "Pay" && !action.frame)).toBe(true)
  })
})


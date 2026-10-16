/**
 * Offline contracts for the browser loop. No network, no browser, no model.
 *
 * Same intent as `jev_ultrafast/tests/test_agent.py` (MIT) — that project's
 * rules are only worth anything if code enforces them — plus the offer-set and
 * pairing rules Orbit's port adds, which are the parts most likely to drift.
 */
import { describe, expect, test } from "bun:test"
import { actionSpace, choose, runBrowserTask, type BrowserDriverLike } from "../src-tauri/resources/browser-use/browser-engine"
import { StalePage, fingerprint, stable } from "../src-tauri/resources/browser-use/browser-driver"
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
function fakeDriver(pages: BrowserObservation[], options: { stale?: number; unreadableAfter?: number } = {}): BrowserDriverLike & { acts: { id: string; text?: string }[]; observes: number } {
  const state = { acts: [] as { id: string; text?: string }[], observes: 0, stale: options.stale ?? 0 }
  return {
    acts: state.acts,
    get observes() {
      return state.observes
    },
    async observe() {
      state.observes += 1
      if (options.unreadableAfter !== undefined && state.observes > options.unreadableAfter) throw new Error("renderer gone")
      return pages[Math.min(state.observes - 1, pages.length - 1)]!
    },
    async fresh() {
      return true
    },
    async act(action, _page, text) {
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

  test("read-only never offers a mutation, and the offer set pairs values with fields", async () => {
    const page = observation([
      fill("e1", 10, "Where from?"),
      fill("e2", 11, "Where to?"),
      click("e3", 20, "Search"),
      ...controls,
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
    expect(Object.keys(operation)).toContain("DONE")

    await choose(page, "find a flight", [], slots, { client: client as never })
    // One offered target per field × prepared value, and the field it belongs to
    // travels with it: `1:query` is "element 1 with the caller's query value".
    const targets = seen.questions.type_text_target!.criteria!
    expect(Object.keys(targets)).toEqual(["1:query", "2:query"])
    expect(targets["1:query"]).toMatchObject({ prepared_value_purpose: "the song to search for" })
    // A dropdown option keeps its own encoding, so a value is never quoted.
    expect(Object.keys(seen.questions.click_target!.criteria!)).toEqual(["3"])
  })
})

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


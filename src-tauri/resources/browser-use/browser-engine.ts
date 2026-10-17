/**
 * The browser task loop: one goal, Jev picks an operation and a target, code
 * executes it, and the page decides what happens next.
 *
 * Ported from `jev_ultrafast/agent.py` + `model.py` (MIT) onto Orbit's
 * decision contract. The shape is deliberately the same as `gui-task-engine.ts`:
 * budgets, an observe/decide/act loop, a risk gate for irreversible steps, local
 * text slots, and a structured result the calling model can act on. What
 * differs is only what drives it — a DOM element table instead of an
 * accessibility tree.
 *
 * Two rules are load-bearing:
 *
 * * Jev chooses an *operation* and an *observed element index*, never text, a
 *   selector or a coordinate. Text comes from the caller's local slots; when
 *   nothing prepared fits the field, the run stops with `needs_text` instead of
 *   inventing a value.
 * * Every step is validated twice — the decision is checked against the page it
 *   was made for, and the target is re-resolved and hit-tested immediately
 *   before input. A stale decision never clicks whatever moved under it.
 */

import { choice, noul, type TypeSafeClient } from "@typesafe-ai/sdk"
import { createDecisionClient } from "../computer-use/decision-provider.ts"
import { isRetryableJevError, loadApiKey, redactLocalSlots } from "../computer-use/jev.ts"
import { BrowserDriver, StalePage, type BrowserAction, type BrowserObservation } from "./browser-driver.ts"
import { ViewDriver } from "./view-driver.ts"
import {
  EVIDENCE_CHARS,
  REQUEST_CHARS,
  validateTaskInput,
  type BrowserDecision,
  type BrowserTaskFailure,
  type BrowserTaskInput,
  type BrowserTaskMetrics,
  type BrowserTaskResult,
  type BrowserTaskStatus,
  type BrowserTaskStep,
  type TextSlot,
} from "./browser-contract.ts"
import { IRREVERSIBLE, NEXT_ACTION, TARGET, TEXT_SLOT } from "./questions.ts"
import { cachedText, generateFieldText, type FieldTextContext, type GeneratedText } from "./text-helper.ts"

/** Operations the page can be driven with. `SCROLL_*`, `WAIT` and the two
 * terminal operations are not targets: they act on the page, not an element. */
const CONTROL_OPERATIONS = {
  SCROLL_DOWN: "Scroll the page down to reveal content that is not on screen.",
  SCROLL_UP: "Scroll the page up to reveal content that is not on screen.",
  WAIT: "Wait briefly for the page to finish updating.",
  DONE: "Every requirement of the goal is now visibly satisfied on this page.",
  BLOCKED: "No offered operation can make progress from this page.",
} as const

const OPERATION_LABELS: Record<string, string> = {
  CLICK: "Click an element, button, menu option, autocomplete suggestion, or calendar day.",
  TYPE_TEXT: "Enter or replace text in an editable field, using a value the caller prepared.",
  SELECT: "Select an observed dropdown value.",
}

/** Above this many target options, pairing values with fields stops paying for
 * itself and the fallback question takes over. */
const MAX_PAIRED_TARGETS = 120
const STATE_CHARS = 100_000
const RISK_THRESHOLD = 0.6
/**
 * Below this, a `DONE` is the model's weakest opinion rather than evidence that
 * the goal is met. The Claude-guided loop (`loop/engine.ts`) runs the same check;
 * the browser loop used to accept any `DONE` its freshness guard allowed.
 */
export const DONE_CONFIDENCE_FLOOR = 0.6

export type BrowserTaskEvent = {
  type: "launching" | "observed" | "decided" | "acted" | "status"
  step: number
  status: BrowserTaskStatus | "running"
  payload: Record<string, unknown>
}

/** One element of the page's own table, with the operations its capabilities allow. */
type ElementView = {
  index: string
  label: string
  role?: string
  value?: string
  checked?: string
  selected?: string
  expanded?: string
  operations: string[]
  options?: { index: string; label: string; value: string }[]
  /** Outside the viewport: reachable only after a scroll. */
  offscreen?: boolean
  /** Something is over it; a click would land there instead. */
  covered?: boolean
  covered_by?: string
}

/**
 * One index per observed element, and one target list per operation.
 *
 * Upstream's mapping, unchanged: an element is numbered once no matter how many
 * operations it supports, and a dropdown value is its own target
 * (`3:2` = element 3, second option), so "SELECT the 4th option of the
 * destination field" is expressible without the model ever quoting a value.
 */
export function actionSpace(actions: readonly BrowserAction[]): {
  elements: ElementView[]
  targets: Record<string, Record<string, BrowserAction>>
  controls: Record<string, BrowserAction>
} {
  const elements: ElementView[] = []
  const indices = new Map<number, string>()
  const targets: Record<string, Record<string, BrowserAction>> = {}
  const controls: Record<string, BrowserAction> = {}
  const operations: Record<string, string> = { click: "CLICK", fill: "TYPE_TEXT", select: "SELECT" }
  for (const action of actions) {
    const operation = operations[action.kind]
    if (!operation) {
      controls[action.id.toUpperCase()] = action
      continue
    }
    const node = action.node
    if (typeof node !== "number") continue
    let index = indices.get(node)
    if (!index) {
      index = String(elements.length + 1)
      indices.set(node, index)
      const element: ElementView = {
        index,
        label: action.label.split(" → ")[0] ?? action.label,
        operations: [],
        ...(action.role ? { role: action.role } : {}),
        ...(action.value !== undefined ? { value: action.kind === "select" ? (action.current_value ?? "") : action.value } : {}),
        ...(action.checked !== undefined ? { checked: action.checked } : {}),
        ...(action.selected !== undefined ? { selected: action.selected } : {}),
        ...(action.expanded !== undefined ? { expanded: action.expanded } : {}),
        // Reachability travels with the element, not only with its input attempt.
        ...(action.offscreen ? { offscreen: true } : {}),
        ...(action.covered ? { covered: true, ...(action.covered_by ? { covered_by: action.covered_by } : {}) } : {}),
        ...(action.kind === "select" ? { options: [] } : {}),
      }
      elements.push(element)
    }
    const element = elements[Number(index) - 1]!
    if (!element.operations.includes(operation)) element.operations.push(operation)
    let target = index
    if (action.kind === "select") {
      target = `${index}:${(element.options?.length ?? 0) + 1}`
      element.options?.push({ index: target, label: action.label, value: action.value ?? "" })
    }
    targets[operation] ??= {}
    targets[operation]![target] = action
  }
  return { elements, targets, controls }
}

/**
 * Ask Jev for the whole next step in one request: the operation, the best
 * target for *every* offered operation (speculative fan-out — the target heads
 * are cheap and running them separately would cost a round trip each), which
 * prepared value the step types, and whether the step can be undone.
 *
 * Code keeps only the answers for the operation that won, so asking about the
 * others costs tokens and nothing else.
 */
export async function choose(
  page: BrowserObservation,
  goal: string,
  history: readonly BrowserTaskStep[],
  slots: readonly TextSlot[],
  options: { readOnly?: boolean; signal?: AbortSignal; client?: TypeSafeClient; usedSlots?: ReadonlySet<string> } = {},
): Promise<BrowserDecision> {
  const { elements, targets, controls } = actionSpace(page.actions)
  const readOnly = options.readOnly ?? false
  const offered: Record<string, string> = {}
  // Every targeted operation (CLICK / TYPE_TEXT / SELECT) mutates the page, so a
  // read-only run offers none of them. Scrolling is an observation, not a change,
  // and it stays available: removing it once left read-only runs offering only
  // WAIT while the rules text still told the model to scroll.
  for (const [operation, group] of Object.entries(targets)) {
    if (readOnly) continue
    if (Object.keys(group).length === 0) continue
    offered[operation] = OPERATION_LABELS[operation] ?? operation
  }
  for (const [name, criteria] of Object.entries(CONTROL_OPERATIONS)) {
    // Scroll is offered only when the page reported it can scroll. WAIT and the
    // two terminal operations always exist. Offering a scroll the page cannot
    // perform would let the model choose an operation with no action behind it,
    // which the engine then has to reject as an internal error.
    const scroll = name === "SCROLL_DOWN" || name === "SCROLL_UP"
    if (scroll && !controls[name]) continue
    offered[name] = criteria
  }
  if (Object.keys(offered).length === 0) throw new Error("页面没有可用的操作目标")
  const offeredTargets = Object.fromEntries(Object.entries(targets).filter(([operation, group]) => offered[operation] && Object.keys(group).length))

  const rawState: Record<string, unknown> = {
    page: { url: page.url, title: page.title, text: page.text },
    elements,
    recent_actions: history.slice(-10).map(step => ({
      action: step.label ?? step.target ?? "",
      kind: step.operation,
      text: step.slotId ? "[slot]" : "",
      page_changed: step.verdict === "changed",
      // Why a step was refused (a DONE below the confidence floor, a stale
      // action) has to reach the next decision, or it will simply repeat itself.
      ...(step.note ? { note: step.note } : {}),
    })),
    ...(page.omitted_actions ? { elements_omitted: page.omitted_actions } : {}),
    // Chrome's own AX outline, when the driver could read it. Never a replacement
    // for `elements`: it is extra structure over the same page.
    ...(page.aria ? { aria: page.aria } : {}),
  }
  // Nothing the caller prepared may reach the decision model, wherever on the page
  // it happens to sit: page text, a field's current value, a dropdown option, an
  // AX value. Redaction happens once, over the finished payload — the local
  // "this field already holds the value" checks below still read the raw page.
  let state = redactTree(rawState, slots)
  // The offer set and the observation share one request budget. Page text is
  // the least actionable part, so it is what yields first.
  let stateChars = JSON.stringify(state).length
  if (stateChars > STATE_CHARS) {
    state.page = { url: page.url, title: page.title, text: "", text_omitted: true }
    stateChars = JSON.stringify(state).length
  }
  if (stateChars > STATE_CHARS) throw new Error(`页面状态过大（${stateChars} 字符），无法安全地交给决策模型`)


  const usableSlots = slots.filter(slot => slot.value.length > 0)
  const usedSlots = options.usedSlots ?? new Set<string>()
  const targetOptions = (index: string, action: BrowserAction): Record<string, unknown> => ({
    element: `[${index}] ${action.label}`,
    current_value: action.current_value ?? action.value ?? "",
    ...(action.role ? { role: action.role } : {}),
    ...(action.checked !== undefined ? { checked: action.checked } : {}),
    ...(action.selected !== undefined ? { selected: action.selected } : {}),
    ...(action.expanded !== undefined ? { expanded: action.expanded } : {}),
    // Told before the decision, not after the input fails.
    ...(action.offscreen ? { offscreen: true } : {}),
    ...(action.covered ? { covered: true, ...(action.covered_by ? { covered_by: action.covered_by } : {}) } : {}),
  })
  // A text field has no DOM options, so the caller's prepared values become
  // them: the target `19:query` means "type the prepared value called query
  // into element 19". Upstream encodes a dropdown option the same way
  // (`3:2`), and for the same reason — one decision then picks *both* the field
  // and what goes in it. A separate question cannot do that: it cannot see
  // which field the step writes, which is exactly how it picks the wrong value.
  const paired = usableSlots.length > 0 && Object.keys(offeredTargets.TYPE_TEXT ?? {}).length * usableSlots.length <= MAX_PAIRED_TARGETS
  const questions: Record<string, unknown> = {
    operation: choice({
      goal: goal.slice(0, 1_200),
      rules: [NEXT_ACTION, ...(readOnly ? ["This run is read-only: only observing and scrolling are allowed."] : [])],
    }, offered),
  }
  // One option key per offer, plus what that key resolves to. Keeping the two
  // together is what stops a paired key (`19:query`) from being looked up as an
  // element index later: the model answers in offered keys, and only the
  // resolution table knows what they mean.
  const offers: Record<string, { criteria: Record<string, unknown>; resolve: Record<string, { action: BrowserAction; slotId?: string }> }> = {}
  for (const [operation, group] of Object.entries(offeredTargets)) {
    const criteria: Record<string, unknown> = {}
    const resolve: Record<string, { action: BrowserAction; slotId?: string }> = {}
    for (const [index, action] of Object.entries(group)) {
      if (operation === "TYPE_TEXT") {
        // A fill whose exact value is already in the field changes nothing, and
        // offering it again is how a run spends its budget re-typing one input
        // while the page waits to be submitted.
        const current = (action.current_value ?? action.value ?? "").trim()
        if (paired) {
          for (const slot of usableSlots) {
            if (current && current === slot.value.trim()) continue
            const key = `${index}:${slot.id}`
            criteria[key] = {
              ...targetOptions(index, action),
              prepared_value_purpose: slot.description,
              ...(usedSlots.has(slot.id) ? { note: "this prepared value was already entered earlier in this run" } : {}),
            }
            resolve[key] = { action, slotId: slot.id }
          }
          continue
        }
        const written = cachedText(fieldContext(page, goal, history, action, slots))
        if (written && current && current === written.trim()) continue
        criteria[index] = {
          ...targetOptions(index, action),
          text_source: "the run's own model writes this field from the goal; no prepared value is needed",
        }
        resolve[index] = { action }
        continue
      }
      criteria[index] = targetOptions(index, action)
      resolve[index] = { action }
    }
    // Every target for this operation already holds its value: the operation
    // itself has nothing left to offer, so it is not offered either.
    if (Object.keys(criteria).length === 0) {
      delete offered[operation]
      continue
    }
    offers[operation] = { criteria, resolve }
    questions[`${operation.toLowerCase()}_target`] = choice({
      goal: goal.slice(0, 1_200),
      operation,
      rules: [NEXT_ACTION, TARGET],
    }, criteria as never)
  }
  // The fallback pairing question, only when the offer set would be too large:
  // it is weaker (it cannot see the field), so it is not the normal path.
  if (usableSlots.length && !paired) {
    questions.text_slot = choice({ goal: goal.slice(0, 1_200), rules: [NEXT_ACTION, TEXT_SLOT] }, Object.fromEntries([
      ...usableSlots.map(slot => [slot.id, slot.description]),
      ["missing", "No prepared value is needed by the goal."],
    ]))
  }
  // One question about the step as a whole, not one per candidate: it is asked
  // once, it costs one line, and the engine only reads it when the chosen
  // operation can actually mutate the page.
  questions.irreversible = noul({ goal: goal.slice(0, 1_200), rules: [IRREVERSIBLE] })

  const client = options.client ?? sharedClient()
  const started = Date.now()
  // Two halves of one request budget: the observation and the offer set. Both
  // are measured before sending, because a rejected request is a failed run. The
  // offer set carries labels, current values and option text, so it gets the same
  // redaction the observation did.
  const redactedQuestions = redactTree(questions, slots)
  const requestChars = stateChars + JSON.stringify(redactedQuestions).length
  if (requestChars > REQUEST_CHARS) throw new Error(`页面状态与选项合计过大（${requestChars} 字符），无法安全地交给决策模型`)
  const response = await callJev(client, { state, questions: redactedQuestions }, options.signal)
  const answers = response.answers as Record<string, { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number>; noul?: number }>
  const operationAnswer = validateChoice(answers.operation, offered)
  const operation = operationAnswer.choice
  let action: BrowserAction | undefined
  let target: string | undefined
  let slotId: string | undefined
  let probabilities: Record<string, number> = {}
  let confidence = operationAnswer.confidence
  const offer = offers[operation]
  if (offer) {
    const targetAnswer = validateChoice(answers[`${operation.toLowerCase()}_target`], offer.criteria)
    const picked = offer.resolve[targetAnswer.choice]
    if (!picked) throw new Error("Jev 选择了当前页面没有提供的目标")
    target = targetAnswer.choice
    action = picked.action
    slotId = picked.slotId
    probabilities = Object.fromEntries(Object.entries(targetAnswer.probabilities).map(([key, value]) => [offer.resolve[key]?.action.id ?? key, value]))
    confidence = targetAnswer.confidence
  } else if (operation !== "DONE" && operation !== "BLOCKED") {
    action = controls[operation]
    if (!action) throw new Error("Jev 选择了当前页面没有提供的操作")
    probabilities[action.id] = operationAnswer.probabilities[operation] ?? 0
  } else {
    // DONE and BLOCKED are decisions about the run, not about an element: the
    // engine reads `operation` and stops before it needs an action at all.
    probabilities[operation] = operationAnswer.probabilities[operation] ?? 0
  }
  // A paired target already named its value. The fallback path reads the
  // separate answer instead; either way the slot is resolved against the list
  // the caller actually supplied, never against text the page showed us.
  if (!slotId && !paired && usableSlots.length) {
    const slotAnswer = answers.text_slot?.choice
    if (slotAnswer && slotAnswer !== "missing" && usableSlots.some(slot => slot.id === slotAnswer)) slotId = slotAnswer
  }
  const irreversible = answers.irreversible?.noul
  return {
    action,
    operation,
    ...(target ? { target } : {}),
    ...(slotId ? { slotId } : {}),
    confidence,
    probabilities,
    model: response.model,
    latencyMs: Date.now() - started,
    usage: { inputTokens: response.usage?.input_tokens ?? 0, outputTokens: response.usage?.output_tokens ?? 0 },
    ...(typeof irreversible === "number" && Number.isFinite(irreversible) ? { irreversible } : {}),
    request: { state, questions },
  }
}

let cachedClient: TypeSafeClient | undefined

/**
 * Redact caller-prepared values from every string in a request payload.
 *
 * The decision model is promised it never sees a `textSlot` value. Applying the
 * redaction to the finished payload — not to `page.text` alone, which is where it
 * used to stop — is what keeps that promise for fields the run had already typed:
 * an element's `value`, a select's `current_value`, its option labels and the
 * accessibility tree are all covered by one pass. Object keys are preserved, and
 * a run with no slots returns the input unchanged.
 */
function redactTree<T>(value: T, slots: readonly TextSlot[]): T {
  if (!slots.some(slot => slot.value.length > 0)) return value
  if (typeof value === "string") return redactLocalSlots(value, slots) as unknown as T
  if (Array.isArray(value)) return value.map(item => redactTree(item, slots)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = redactTree(item, slots)
    return out as T
  }
  return value
}
function sharedClient(): TypeSafeClient {
  cachedClient ??= createDecisionClient(loadApiKey)
  return cachedClient
}

async function callJev(
  client: TypeSafeClient,
  request: { state: Record<string, unknown>; questions: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<{ model: string; answers: Record<string, unknown>; usage?: { input_tokens: number; output_tokens: number } }> {
  try {
    return await client.systemOne(request as never, { signal }) as never
  } catch (error) {
    const stateChars = JSON.stringify(request.state).length
    const questionChars = JSON.stringify(request.questions).length
    throw new Error(`Jev 浏览器决策请求被拒绝（state=${stateChars} 字符，questions=${questionChars} 字符）：${error instanceof Error ? error.message : String(error)}`)
  }
}

function validateChoice(
  answer: { type?: string; choice?: string; confidence?: number; probabilities?: Record<string, number> } | undefined,
  criteria: Record<string, unknown>,
): { choice: string; confidence: number; probabilities: Record<string, number> } {
  if (!answer || typeof answer.choice !== "string" || !Object.hasOwn(criteria, answer.choice)) throw new Error("Jev returned an invalid browser Choice answer")
  const probabilities = answer.probabilities
  if (!probabilities || Object.keys(probabilities).length !== Object.keys(criteria).length || Object.keys(criteria).some(key => !Object.hasOwn(probabilities, key))) {
    throw new Error("Jev returned an incomplete browser probability distribution")
  }
  const values = Object.values(probabilities)
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1) || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) {
    throw new Error("Jev returned an invalid browser probability distribution")
  }
  if (!Number.isFinite(answer.confidence) || (probabilities[answer.choice] ?? 0) < Math.max(...values) - 1e-6) {
    throw new Error("Jev returned an invalid confidence or non-maximal browser choice")
  }
  return { choice: answer.choice, confidence: answer.confidence ?? 0, probabilities: { ...probabilities } }
}

/**
 * The column's own view when the app is reachable, the agent's own Chrome otherwise.
 *
 * The view comes first because it is the panel the user can see, and asking the
 * app for a tab is what makes that panel appear at all. Driving Chrome instead
 * produces a browser with no UI anywhere in this app, so the run reports "opened"
 * and nothing happens on screen.
 *
 * The trade is real and worth naming: input in the view is synthesized
 * (`dispatchEvent`), except for clicks, which go through the system's own mouse
 * (`viewClickAt`). A page that inspects `event.isTrusted` (some Google flows)
 * ignores scripted input, so the view is the weaker engine for those. Chrome's
 * CDP `Input.*` is always trusted — which is why it is the fallback, and why the
 * engine a run used is now reported in its metrics: a fall back is never silent
 * again.
 */
async function openDriver(url: string | undefined, signal?: AbortSignal): Promise<{ driver: BrowserDriverLike; fallback?: string }> {
  if (await ViewDriver.available().catch(() => false)) {
    try {
      return { driver: await ViewDriver.open(url, signal) }
    } catch (error) {
      // A view that cannot be driven (no tab appeared, a page that refuses
      // scripts) must not fail the run — but *why* it fell back is the fact that
      // used to be swallowed by this catch while a run quietly drove a browser
      // nobody could see. It travels with the result instead.
      return { driver: await BrowserDriver.open(url, signal), fallback: error instanceof Error ? error.message : String(error) }
    }
  }
  return { driver: await BrowserDriver.open(url, signal) }
}

/**
 * What the loop needs from a browser. `BrowserDriver` is the real one; tests
 * provide an in-memory driver with the same behaviour contract, which is how
 * the loop's rules (no action after a stale decision, no invented text, no
 * claim after an unreadable page) are checked without a browser or a model.
 */
export type BrowserDriverLike = {
  observe(): Promise<BrowserObservation>
  fresh(page: BrowserObservation, action?: BrowserAction): Promise<boolean>
  act(action: BrowserAction, page: BrowserObservation, text?: string): Promise<void>
  close(): void
  /** Which engine is actually driving. Recorded in the run's metrics so a silent
   * fall back to Chrome is visible in the result instead of inferred from logs. */
  readonly engine?: "view" | "chrome"
}

export type RunBrowserTaskOptions = {
  input: BrowserTaskInput
  signal?: AbortSignal
  emit?: (event: BrowserTaskEvent) => void
  /** Asked before an irreversible step. Without it such a step never executes. */
  confirm?: (summary: string) => Promise<boolean>
  /** Injected by tests; the real run opens its own session. */
  driver?: BrowserDriverLike
  /** Injected by tests: the decision step, with no Jev request behind it. */
  decide?: typeof choose
  /** Injected by tests: the text helper, with no model process behind it. */
  generate?: (context: Parameters<typeof generateFieldText>[0], signal?: AbortSignal) => Promise<GeneratedText | null>
}

/**
 * The loop. One observation, one decision, one action, repeat — until the goal
 * is satisfied, the model reports it is stuck, a budget runs out, or an
 * irreversible step needs a human.
 */
export async function runBrowserTask(options: RunBrowserTaskOptions): Promise<BrowserTaskResult> {
  const { input, signal, emit } = options
  validateTaskInput(input)
  const started = Date.now()
  const deadline = started + input.budget.maxDurationMs
  const trace: BrowserTaskStep[] = []
  const metrics: BrowserTaskMetrics = { elapsedMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, generatedValues: 0 }
  const maxActions = input.budget.maxActions
  let driver = options.driver
  let page: BrowserObservation | null = null
  const usedSlots = new Set<string>()
  let decisions = 0
  let actions = 0
  let status: BrowserTaskStatus = "blocked"
  let failure: BrowserTaskFailure | undefined
  let goalVerified = false

  const stop = (next: BrowserTaskStatus, detail?: string, branch?: string, hint?: string, stage: BrowserTaskFailure["stage"] = "observe") => {
    status = next
    if (detail) failure = { stage, ...(branch ? { branch } : {}), detail, ...(hint ? { hint } : {}) }
    emit?.({ type: "status", step: actions, status: next, payload: { detail: detail ?? next } })
  }

  try {
    if (!driver) {
      emit?.({ type: "launching", step: 0, status: "running", payload: { url: input.url ?? "" } })
      const opened = await openDriver(input.url, signal)
      driver = opened.driver
      if (opened.fallback) {
        metrics.engineFallback = opened.fallback
        emit?.({ type: "status", step: 0, status: "running", payload: { note: `the browser column could not be driven, using Chrome: ${opened.fallback}` } })
      }
    }
    metrics.engine = driver.engine ?? "chrome"
    const observation = await time(metrics, "observation", () => driver!.observe())
    page = observation
    emit?.({ type: "observed", step: 0, status: "running", payload: { url: page.url, candidates: page.actions.length } })

    while (true) {
      if (signal?.aborted) {
        stop("aborted", "任务被取消")
        break
      }
      if (Date.now() > deadline) {
        stop("timeout", `超过时间预算（${input.budget.maxDurationMs}ms）`, "duration", "提高 maxDurationMs 或缩小目标", "budget")
        break
      }
      if (decisions >= input.budget.maxDecisions) {
        stop("max_decisions", `超过决策预算（${input.budget.maxDecisions}）`, "decisions", "提高 maxDecisions", "budget")
        break
      }
      let decision: BrowserDecision
      try {
        decision = options.decide
          ? await options.decide(page, input.goal, trace, input.textSlots ?? [], { readOnly: input.readOnly, usedSlots, signal })
          : await decideWithRetry(page, input, trace, usedSlots, signal)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        stop("error", detail, "decision", "可以重试；若反复失败请缩小目标或检查 Jev 额度", "decide")
        break
      }
      decisions += 1
      metrics.jevCalls += 1
      metrics.decisionMs += decision.latencyMs
      metrics.inputTokens += decision.usage.inputTokens
      metrics.outputTokens += decision.usage.outputTokens
      emit?.({
        type: "decided",
        step: actions,
        status: "running",
        payload: { operation: decision.operation, target: decision.target, label: decision.action?.label, latencyMs: decision.latencyMs, confidence: decision.confidence },
      })

      if (decision.operation === "DONE" || decision.operation === "BLOCKED") {
        // The page must not have moved since the decision: "done" about a page
        // that already changed is not evidence about the current one.
        if (!(await driver.fresh(page))) {
          const next = await time(metrics, "observation", () => driver!.observe())
          page = next
          trace.push({ step: actions, operation: decision.operation, note: "决策后页面已变化，重新观察" })
          continue
        }
        // A `DONE` with no confidence behind it is not evidence that the goal is
        // met, so it is refused and recorded — but it stays on the table. Taking
        // it away (as the desktop loop does) would mean a page that has genuinely
        // finished but whose screenshot-less judgement is weak can never be closed,
        // turning a false success into a false failure.
        if (decision.operation === "DONE" && decision.confidence < DONE_CONFIDENCE_FLOOR) {
          trace.push({
            step: actions,
            operation: "DONE",
            confidence: decision.confidence,
            note: `本轮完成判断的置信度 ${decision.confidence.toFixed(2)} 低于阈值 ${DONE_CONFIDENCE_FLOOR}；如果目标确实已完成，请下一轮给出更有把握的判断，否则继续推进`,
          })
          continue
        }
        goalVerified = decision.operation === "DONE"
        stop(decision.operation === "DONE" ? "done" : "blocked", decision.operation === "DONE" ? undefined : "Jev 认为当前页面无法继续推进目标", "model", "换个说法、给一个具体入口页面，或先在浏览器栏里登录")
        break
      }

      if (actions >= maxActions) {
        stop("max_actions", `超过动作预算（${maxActions}）`, "actions", "提高 maxActions 或把目标拆小", "budget")
        break
      }

      const action = decision.action
      if (!action) {
        stop("error", `Jev 选择 ${decision.operation} 但没有给出可执行的目标`, "decision", undefined, "decide")
        break
      }
      let missingText = false
      const text = await resolveFieldText({
        slotId: decision.slotId,
        input,
        action,
        page,
        trace,
        generate: options.generate ?? generateFieldText,
        signal,
        onProblem: (detail, branch, hint) => {
          missingText = true
          stop("needs_text", detail, branch, hint, "slot")
        },
      })
      if (missingText) break

      const irreversible = decision.irreversible ?? 0
      if (irreversible >= RISK_THRESHOLD && action.kind !== "wait") {
        const summary = `${decision.operation}「${action.label}」可能不可撤销（风险 ${irreversible.toFixed(2)}）`
        if (!options.confirm) {
          stop("needs_review", `${summary}，但当前没有可确认的界面`, "irreversible", "在 Orbit 界面中运行以便确认，或把这一步交给用户", "risk-gate")
          break
        }
        const accepted = await options.confirm(summary).catch(() => false)
        if (!accepted) {
          stop("needs_review", `用户拒绝了这一步：${summary}`, "declined", undefined, "risk-gate")
          break
        }
      }

      const step: BrowserTaskStep = {
        step: actions + 1,
        operation: decision.operation,
        ...(decision.target ? { target: decision.target } : {}),
        label: action.label,
        confidence: decision.confidence,
        ...(decision.slotId ? { slotId: decision.slotId } : {}),
      }
      const stepStarted = Date.now()
      try {
        await time(metrics, "action", () => driver!.act(action, page!, text))
      } catch (error) {
        if (error instanceof StalePage) {
          // Nothing was delivered: the page moved first. Re-observe and decide
          // again. This is the one case where an action is not counted.
          step.note = `未执行：${error.message}`
          step.ms = Date.now() - stepStarted
          trace.push(step)
          page = await time(metrics, "observation", () => driver!.observe())
          continue
        }
        const detail = error instanceof Error ? error.message : String(error)
        stop("error", detail, "deliver", "页面可能需要重新观察；重试一次通常可以恢复", "deliver")
        break
      }
      actions += 1
      if (decision.slotId) usedSlots.add(decision.slotId)
      else if (action.kind === "fill" && text) metrics.generatedValues += 1
      step.ms = Date.now() - stepStarted
      emit?.({ type: "acted", step: actions, status: "running", payload: { operation: decision.operation, label: action.label } })

      // Record execution *before* observing it. A post-action read can fail
      // (navigation, a crashed renderer), and that must not erase an action
      // that was already delivered.
      const before = page
      trace.push(step)
      try {
        page = await time(metrics, "observation", () => driver!.observe())
        step.verdict = page.fingerprint === before.fingerprint ? "no_change" : "changed"
      } catch (error) {
        step.note = `已执行，但无法再次读取页面：${error instanceof Error ? error.message : String(error)}`
        stop("error", step.note, "observe", "重试一次通常可以恢复；页面可能已经导航", "observe")
        break
      }
      // Three consecutive actions that changed nothing (excluding waits) mean
      // the page is not responding to what we do: stop instead of clicking on.
      const recent = trace.slice(-3)
      if (recent.length === 3 && recent.every(item => item.verdict === "no_change" && item.operation !== "WAIT")) {
        stop("blocked", "连续三步没有让页面发生变化", "no-effect", "换一个入口页面或缩小目标；也可能是页面把输入吃掉了（如 canvas 应用）")
        break
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const aborted = signal?.aborted
    stop(aborted ? "aborted" : "error", detail, undefined, undefined, aborted ? "observe" : (page ? "observe" : "launch"))
  } finally {
    driver?.close()
  }

  metrics.elapsedMs = Date.now() - started
  const evidence = page ? evidenceOf(page) : ""
  return {
    status,
    url: page?.url ?? input.url ?? "",
    title: page?.title ?? "",
    goalVerified,
    steps: actions,
    decisions,
    evidence,
    metrics,
    trace,
    ...(failure ? { failure } : {}),
  }
}

/** The helper's input for one field. Built the same way wherever it is needed,
 * because a different context would be a different cache entry — and a second
 * value typed into a field that already has one. */
function fieldContext(page: BrowserObservation, goal: string, history: readonly BrowserTaskStep[], field: BrowserAction, slots: readonly TextSlot[]): FieldTextContext {
  return { goal, field, page, history, slots }
}

/**
 * The value one field gets, in order of authority:
 *
 * 1. the caller's prepared slot (an exact string the calling model chose),
 * 2. the run's own model, asked for that one field (upstream's text helper),
 * 3. nothing — the run stops with `needs_text` naming the field.
 *
 * Returns `undefined` when there is no value to type, having recorded why.
 */
async function resolveFieldText(options: {
  slotId?: string
  input: BrowserTaskInput
  action: BrowserAction
  page: BrowserObservation
  trace: readonly BrowserTaskStep[]
  generate: (context: Parameters<typeof generateFieldText>[0], signal?: AbortSignal) => Promise<GeneratedText | null>
  signal?: AbortSignal
  onProblem: (detail: string, branch: string, hint: string) => void
}): Promise<string | undefined> {
  const { input, action } = options
  if (action.kind !== "fill") return undefined
  const slots = input.textSlots ?? []
  const prepared = options.slotId ? slots.find(slot => slot.id === options.slotId)?.value : undefined
  if (prepared) return prepared
  const anyPrepared = slots.find(slot => slot.value.length > 0 && slot.description)
  if (input.allowGeneratedText === false) {
    options.onProblem(
      `字段「${action.label}」需要一个准确的值，但本次运行不允许生成文本（allowGeneratedText=false），textSlots 里也没有可用的值`,
      "slot-disabled",
      "在 textSlots 里给出该字段的值，或允许生成文本后重试",
    )
    return undefined
  }
  try {
    const generated = await options.generate(fieldContext(options.page, input.goal, options.trace, action, anyPrepared ? slots : []), options.signal)
    if (generated?.text) return generated.text
    options.onProblem(
      `字段「${action.label}」需要一个值，而模型确认目标里没有这个信息`,
      "model-gap",
      "在 textSlots 里给出该字段的值（描述里写清用途），然后重试",
    )
    return undefined
  } catch (error) {
    options.onProblem(
      `字段「${action.label}」需要一个值，但文本模型不可用：${error instanceof Error ? error.message : String(error)}`,
      "text-helper",
      "检查项目连接与模型配置，或在 textSlots 里直接给出该字段的值",
    )
    return undefined
  }
}

async function decideWithRetry(
  page: BrowserObservation,
  input: BrowserTaskInput,
  trace: readonly BrowserTaskStep[],
  usedSlots: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<BrowserDecision> {
  const ask = () => choose(page, input.goal, trace, input.textSlots ?? [], { readOnly: input.readOnly, usedSlots, signal })
  try {
    return await ask()
  } catch (error) {
    // Sampling noise can produce a structurally invalid Choice answer. A fresh
    // sample usually fixes it; anything else is reported as-is.
    if (!isRetryableJevError(error)) throw error
    return await ask()
  }
}

async function time<T>(metrics: { observationMs: number; actionMs: number }, kind: "observation" | "action", run: () => Promise<T>): Promise<T> {
  const started = Date.now()
  try {
    return await run()
  } finally {
    if (kind === "observation") metrics.observationMs += Date.now() - started
    else metrics.actionMs += Date.now() - started
  }
}

/**
 * What the caller gets to see for itself. The page's own words, not the
 * agent's summary: a run that reports success has to be checkable, and a run
 * that reports anything else has to be diagnosable.
 */
function evidenceOf(page: BrowserObservation): string {
  const header = `${page.title || "(无标题)"} · ${page.url}`
  const text = page.text.replace(/\s*\n\s*/g, "\n").trim().slice(0, EVIDENCE_CHARS)
  const omitted = page.omitted_actions ? `\n[还有 ${page.omitted_actions} 个控件未显示]` : ""
  return `${header}\n${text}${omitted}`
}

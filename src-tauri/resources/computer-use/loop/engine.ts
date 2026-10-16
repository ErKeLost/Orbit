import { setTimeout as delay } from "node:timers/promises"
import type { CuaDriver } from "../cua/driver.ts"
import { normalizeAction } from "../cua/driver.ts"
import { DriverToolError, escalationOf, type EscalationRung } from "../cua/errors.ts"
import { observe } from "../cua/observation.ts"
import type { CuaCandidate, CuaObservation, VisualRegion } from "../cua/types.ts"
import { applyPolicy, boundCandidates } from "../candidates/policy.ts"
import { buildCandidates } from "../candidates/sources.ts"
import { chooseAction, isRetryableChoiceError, type JevChoice, type JevChoiceInput } from "../choice/jev.ts"
import { captureVisionImage, type VisionImage } from "../vision/image.ts"
import { RepeatBrake, StallTracker } from "./stall.ts"
import { validateTaskInput, type GuiTaskEvent, type GuiTaskFailure, type GuiTaskInput, type GuiTaskMetrics, type GuiTaskResult, type GuiTaskStatus, type GuiTaskTrace } from "../gui-task-contract.ts"

/** Predicted probability for finishing without an explicit done round trip. */
const COMPLETION_THRESHOLD = 0.75
const RE_OBSERVE_WAIT_MS = 400
const MAX_OBSERVE_RETRIES = 2
/** Below this the previous choice was uncertain, so a screenshot is worth its cost. */
const VISION_CONFIDENCE_FLOOR = 0.6

/**
 * When to attach a screenshot to the chooser.
 *
 * `auto` is the useful default: an image costs ~13s and ~4K input tokens,
 * against ~1.6s and 14K-to-20K for text alone, so it is attached only where a
 * picture can change the answer — an unlabelled target in the offer set, or a
 * previous choice the model itself was unsure about. `always` exists for A/B
 * measurement, not for production.
 */
export type VisionMode = "off" | "auto" | "always"

export function visionMode(raw: string | undefined): VisionMode {
  const value = raw?.trim().toLowerCase()
  if (value === "always") return "always"
  if (value === "1" || value === "true" || value === "auto") return "auto"
  return "off"
}

/**
 * True when the offer set cannot be told apart from text alone: some candidate
 * has no label at all, or the previous decision was uncertain.
 */
export function isAmbiguous(candidates: readonly CuaCandidate[], lastConfidence: number | undefined): boolean {
  if (typeof lastConfidence === "number" && lastConfidence < VISION_CONFIDENCE_FLOOR) return true
  return candidates.some(candidate => Boolean(candidate.tool) && !candidate.label)
}

export type CuaEngineDeps = {
  driver: CuaDriver
  signal?: AbortSignal
  decide?: (input: JevChoiceInput, signal?: AbortSignal) => Promise<JevChoice>
  emit?: (event: GuiTaskEvent) => void
  confirm?: (summary: string) => Promise<boolean>
  /** Region candidates from the perception extension (AGPL; not bundled). */
  visualFallback?: boolean
  /** Attach a screenshot to the chooser. See `VisionMode`. */
  vision?: VisionMode
}

export async function runCuaTask(
  input: GuiTaskInput,
  deps: CuaEngineDeps,
): Promise<GuiTaskResult> {
  const { driver, signal, decide = chooseAction, emit = () => undefined, visualFallback = false, vision = "off" } = deps
  validateTaskInput(input)
  const startedAt = Date.now()
  const deadline = startedAt + input.budget.maxDurationMs
  const metrics: GuiTaskMetrics = { elapsedMs: 0, launchMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, replayedSteps: 0, settleMs: 0, settleEvents: 0 }
  const trace: GuiTaskTrace[] = []
  const history: string[] = []
  const usedSlotIds = new Set<string>()
  const quarantined = new Set<string>()
  /** Rungs the driver asked for, keyed by the identity whose background route it refused. */
  const escalate = new Map<string, EscalationRung>()
  const triedHere = new Set<string>()
  const repeat = new RepeatBrake(2)
  const stall = new StallTracker()
  let actions = 0
  let decisions = 0
  let appLaunched = false
  let goalVerified = false
  let lastAction: GuiTaskResult["lastAction"]
  let allowEnter = false
  let lastTypedToken: string | undefined
  let visualUsed = false
  let lastNoEffect: string | undefined
  let lastConfidence: number | undefined
  // One bounded recovery is allowed when the window's accessibility surface is
  // unresolved: the driver reports `escalation: foreground`, and a window that
  // is merely behind on the same Space usually resolves after being raised.
  let recoveryAttempted = false

  const remaining = () => Math.max(1, deadline - Date.now())
  const classifyFailure = (status: GuiTaskStatus, note?: string): GuiTaskFailure | undefined => {
    if (status === "done") return undefined
    const text = note ?? ""
    const has = (needle: string) => text.toLowerCase().includes(needle.toLowerCase())
    if (has("stale_element_token") || has("element token is stale")) return { stage: "deliver", branch: "stale-token", detail: text, hint: "the snapshot changed before delivery; re-observing usually succeeds" }
    if (has("driver_unavailable")) return { stage: "launch", branch: "driver-missing", detail: text, hint: "install Cua Driver and grant Accessibility + Screen Recording" }
    if (has("driver_not_granted") || has("permission")) return { stage: "launch", branch: "permission", detail: text, hint: "grant CuaDriver Accessibility and Screen Recording in System Settings" }
    if (has("ax_window_unresolved")) return { stage: "observe", branch: "ax-unresolved", detail: text, hint: "该应用的窗口当前不是可见的普通窗口（被最小化、被隐藏，或窗口已关闭而进程仍在运行），所以 macOS 不向辅助功能暴露这个窗口，后台操作也被驱动按设计拒绝。请在 Dock 上点一下该应用、或用 Cmd+Tab 把它显示出来，再重试。这不代表该应用不支持辅助功能，不要据此改用其它方式。" }
    if (has("invalid choice answer")) return { stage: "decide", branch: "answer-shape", detail: text, hint: "the model returned a malformed answer; retrying usually succeeds" }
    if (has("max_tokens_exceeded")) return { stage: "decide", branch: "request-size", detail: text, hint: "the observation plus the offer set exceeded the model input budget" }
    if (status === "needs_review") return { stage: "risk-gate", detail: text, hint: "re-run in an interactive session so the confirmation can be shown" }
    if (status === "needs_text") return { stage: "decide", branch: "text-slot", detail: text, hint: "provide a textSlot carrying the value the field needs" }
    if (status === "blocked") return { stage: "offer-set", detail: text, hint: "the window offered no usable action; check the app state or rephrase the goal" }
    if (status === "max_actions") return { stage: "budget", branch: "actions", detail: `action budget (${input.budget.maxActions}) was spent`, hint: "raise budget.maxActions or narrow the goal" }
    if (status === "max_decisions") return { stage: "budget", branch: "decisions", detail: `decision budget (${input.budget.maxDecisions}) was spent`, hint: "raise budget.maxDecisions or narrow the goal" }
    if (status === "timeout") return { stage: "budget", branch: "duration", detail: `time budget (${input.budget.maxDurationMs}ms) was spent`, hint: "raise budget.maxDurationMs" }
    if (status === "error") return { stage: "decide", detail: text }
    return undefined
  }
  const finish = (status: GuiTaskStatus, observation?: CuaObservation, note?: string): GuiTaskResult => {
    metrics.elapsedMs = Math.max(0, Date.now() - startedAt)
    if (note) trace.push({ step: decisions, stateId: observation?.fingerprint ?? "unobserved", note })
    const failure = classifyFailure(status, note)
    return { status, appLaunched, goalVerified, lastAction, actions, decisions, evidence: observation?.context.slice(0, 2_000) ?? "", metrics, trace, ...(failure ? { failure } : {}) }
  }

  if (signal?.aborted) return finish("aborted")

  // ---- resolve the app and its window -------------------------------------
  const launchStarted = performance.now()
  let pid: number
  let windowId: number
  try {
    emit({ type: "launching", step: 0, status: "running", payload: { app: input.target.app } })
    const apps = await driver.listApps()
    let app = findApp(apps, input.target.app)
    if (!app) {
      try {
        await driver.callTool("launch_app", { name: input.target.app })
      } catch { /* reported below */ }
      await delay(Math.min(1_500, remaining()), undefined, { signal }).catch(() => undefined)
      app = findApp(await driver.listApps(), input.target.app)
    }
    if (!app) return finish("error", undefined, `app not found: ${input.target.app}`)
    pid = app.pid
    appLaunched = true
    const windows = await driver.listWindows({ pid })
    if (!windows.length) return finish("error", undefined, `no window for ${app.name}`)
    windowId = pickWindow(windows)
  } catch (error) {
    return finish(signal?.aborted ? "aborted" : "error", undefined, safeError(error))
  } finally {
    metrics.launchMs += performance.now() - launchStarted
  }

  // ---- the loop ------------------------------------------------------------
  let observation: CuaObservation | undefined
  let offered: CuaCandidate[] = []
  while (true) {
    if (signal?.aborted) return finish("aborted", observation)
    if (Date.now() >= deadline) return finish("timeout", observation)

    const observationStarted = performance.now()
    try {
      observation = await observeWithRetry(driver, { pid, windowId }, remaining(), signal)
    } catch (error) {
      const code = error instanceof DriverToolError ? error.code : ""
      return finish(signal?.aborted ? "aborted" : "error", undefined, code ? `${code}: ${safeError(error)}` : safeError(error))
    } finally {
      metrics.observationMs += performance.now() - observationStarted
    }
    emit({ type: "observed", step: decisions, status: "running", payload: { app: observation.app, window: observation.title, candidateCount: observation.elements.length, complete: observation.complete } })

    if (!observation.complete && observation.elements.length === 0) {
      if (!recoveryAttempted) {
        recoveryAttempted = true
        emit({ type: "status", step: decisions, status: "running", payload: { note: "ax_window_unresolved; attempting one foreground recovery" } })
        history.push("the window's accessibility surface is unresolved; tried to bring it to the front once")
        trace.push({ step: decisions, stateId: observation.fingerprint, note: "ax_window_unresolved: attempted one foreground activation before giving up" })
        await driver.callTool("bring_to_front", { pid, window_id: windowId }).catch(() => undefined)
        await delay(Math.min(1_200, remaining()), undefined, { signal }).catch(() => undefined)
        continue
      }
      const reason = observation.degradedReason
      return finish("blocked", observation, reason
        ? (/^ax_window_unresolved/i.test(reason) ? reason : `ax_window_unresolved: ${reason}`)
        : "ax_window_unresolved: the accessibility surface for this window could not be resolved right now")
    }
    if (actions >= input.budget.maxActions) return finish("max_actions", observation)
    if (decisions >= input.budget.maxDecisions) return finish("max_decisions", observation)

    // Candidates: built here, filtered here, bounded here.
    const visual = visualFallback && !visualUsed ? await readVisualRegions(driver, observation).catch(() => undefined) : undefined
    if (visual) visualUsed = true
    const all = buildCandidates(observation, {
      goal: input.goal,
      readOnly: Boolean(input.readOnly),
      pid,
      windowId,
      textSlots: input.textSlots ?? [],
      usedSlotIds,
      allowEnter,
      lastTypedToken,
      allElements: observation.elements,
      escalate,
      ...(visual ? { visual } : {}),
    })
    const policyCandidates = applyPolicy(all, {
      readOnly: Boolean(input.readOnly),
      goal: input.goal,
      quarantined,
      triedHere,
      repeatedTargets: repeat.blocked,
    })
    const { offered: bounded } = boundCandidates(policyCandidates)
    offered = bounded
    const executable = offered.filter(candidate => candidate.tool)
    if (executable.length === 0) {
      return finish("blocked", observation, lastNoEffect ? `no usable candidate remains; ${lastNoEffect}` : "no usable candidate on this screen")
    }

    const decisionStarted = performance.now()
    let choice: JevChoice
    const wantsImage = vision === "always" || (vision === "auto" && isAmbiguous(offered, lastConfidence))
    const image: VisionImage | undefined = wantsImage
      ? await captureVisionImage(driver, observation).catch(() => undefined)
      : undefined
    const choiceInput: JevChoiceInput = {
      goal: input.goal,
      observation,
      candidates: offered,
      history,
      progress: { actions, decisions },
      ...(visual ? { regions: visual.regions, captureId: visual.captureId } : {}),
      ...(image ? { image } : {}),
    }
    const visionNote = image ? `screenshot attached (${image.width}x${image.height})` : undefined
    try {
      metrics.jevCalls++
      choice = await decide(choiceInput, signal)
    } catch (error) {
      if (signal?.aborted || !isRetryableChoiceError(error)) return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
      try {
        choice = await decide({ goal: input.goal, observation, candidates: offered, history, ...(image ? { image } : {}) }, signal)
      } catch (retryError) {
        return finish(signal?.aborted ? "aborted" : "error", observation, safeError(retryError))
      }
    } finally {
      metrics.decisionMs += performance.now() - decisionStarted
    }
    decisions++
    lastConfidence = choice.confidence
    metrics.inputTokens += choice.usage.inputTokens
    metrics.outputTokens += choice.usage.outputTokens

    const selected = offered.find(candidate => candidate.id === choice.selectedId)
    if (!selected) return finish("error", observation, "the chooser selected a candidate outside the current offer set")
    const entry: GuiTaskTrace = { step: decisions, stateId: observation.fingerprint, operation: selected.legacyOperation, candidateId: selected.id, candidate: selected.description, confidence: choice.confidence, source: "jev", ...(visionNote ? { note: visionNote } : {}) }
    trace.push(entry)
    emit({ type: "decided", step: decisions, status: "running", payload: { operation: selected.legacyOperation, candidate: selected.description, confidence: choice.confidence, model: choice.model, latencyMs: choice.latencyMs } })

    if (selected.operation === "abstain") return finish("blocked", observation, "the chooser found no supplied action that can advance the goal")
    if (selected.operation === "done") {
      const undelivered = (input.textSlots ?? []).filter(slot => !usedSlotIds.has(slot.id))
      if (undelivered.length) {
        history.push(`done was rejected: prepared text ${undelivered.map(slot => slot.id).join(", ")} was never entered`)
        triedHere.add("done")
        continue
      }
      goalVerified = true
      entry.outcome = "goal_verified_by_chooser"
      return finish("done", observation)
    }
    if (selected.operation === "reobserve") {
      entry.outcome = "reobserved"
      history.push("reobserve")
      await delay(Math.min(RE_OBSERVE_WAIT_MS, remaining()), undefined, { signal }).catch(() => undefined)
      continue
    }

    // ---- deliver -----------------------------------------------------------
    const before = observation
    const actionStarted = performance.now()
    let effect: string | undefined
    let escalation: string | undefined
    try {
      const result = await driver.callTool(selected.tool!, selected.args as Record<string, unknown>, { timeoutMs: Math.min(remaining(), 30_000), signal })
      const normalized = normalizeAction(result)
      effect = normalized.effect
      escalation = normalized.escalation?.recommended
      actions++
      entry.outcome = normalized.effect ?? "delivered"
      lastAction = { operation: selected.legacyOperation, delivery: normalized.effect }
      if (selected.slotId) {
        usedSlotIds.add(selected.slotId)
        allowEnter = selected.operation === "type_text"
        lastTypedToken = selected.elementToken
      } else if (selected.operation !== "type_text") {
        allowEnter = false
      }
      if (escalation && escalation !== "px") {
        entry.note = `driver reports the next rung is ${escalation}`
      }
    } catch (error) {
      entry.note = safeError(error)
      if (error instanceof DriverToolError) {
        lastAction = { operation: selected.legacyOperation, delivery: "refused" }
        entry.outcome = "refused"
        // The refused attempt is excluded by id and by identity, so neither the
        // same candidate nor a near-identical one is offered again. The
        // escalated twin carries its own identity and survives that.
        triedHere.add(selected.id)
        if (selected.identity) quarantined.add(selected.identity)
        if (/stale_element_token/i.test(error.code)) {
          history.push(`${selected.legacyOperation} refused: the snapshot changed before delivery; re-observe and pick again`)
          continue
        }
        const rung = escalationOf(error)
        if ((rung === "foreground" || rung === "px") && selected.identity) {
          // The driver's contract: a background refusal is never retried in the
          // foreground implicitly. Offer it as a separate candidate instead.
          escalate.set(selected.identity, "foreground")
          history.push(`${selected.legacyOperation} refused (${error.code}); the driver recommends the ${rung} route for this target, so a FOREGROUND candidate for the same target is offered and must be chosen explicitly`)
          continue
        }
        if (error.retryable || /stale_element_token|x_unresolved|unsupported|refused|unavailable|background_/i.test(error.code)) {
          history.push(`${selected.legacyOperation} refused (${error.code}); choose a different candidate`)
          continue
        }
        return finish("needs_review", before, safeError(error))
      }
      return finish(signal?.aborted ? "aborted" : "error", before, safeError(error))
    } finally {
      metrics.actionMs += performance.now() - actionStarted
    }
    emit({ type: "acted", step: decisions, status: "running", payload: { operation: selected.legacyOperation, candidate: selected.description, outcome: effect } })

    // ---- verify against the successor observation --------------------------
    const settleStarted = performance.now()
    let after: CuaObservation | undefined
    try {
      after = await observeWithRetry(driver, { pid, windowId }, remaining(), signal)
    } catch {
      after = undefined
    }
    metrics.settleMs += performance.now() - settleStarted
    if (!after) return finish("needs_review", before, "delivery could not be verified: the successor observation failed")

    const verified = verifyStep(selected, before, after, input)
    entry.changed = !sameLines(before.lines, after.lines)
    if (verified.note) entry.note = entry.note ? `${entry.note}; ${verified.note}` : verified.note
    if (verified.failed) {
      entry.verdict = "no_effect"
      triedHere.add(selected.id)
      if (selected.identity) quarantined.add(selected.identity)
      lastNoEffect = `${selected.legacyOperation} was delivered but the interface did not change`
      history.push(`${selected.legacyOperation} ${selected.description.split(";")[0]}: no verified effect; that target is excluded, choose a different candidate`)
    } else {
      lastNoEffect = undefined
      history.push(`${selected.legacyOperation} ${selected.description.split(";")[0]}: ${verified.note ?? "delivered"}`)
    }

    // ---- stall brake -------------------------------------------------------
    const verdict = stall.record(`${selected.legacyOperation}:${selected.identity ?? selected.id}`, before.lines, after.lines)
    repeat.observe(selected.identity)
    if (entry.changed) {
      triedHere.clear()
      repeat.reset()
    }
    if (verdict.stalled) return finish("blocked", after, verdict.reason)

    // ---- predicted completion ---------------------------------------------
    if (typeof choice.completesGoal === "number" && choice.completesGoal >= COMPLETION_THRESHOLD && entry.changed && !verified.failed) {
      const undelivered = (input.textSlots ?? []).filter(slot => !usedSlotIds.has(slot.id))
      if (!undelivered.length) {
        goalVerified = true
        entry.outcome = `${entry.outcome ?? "delivered"}; goal_verified_by_prediction`
        return finish("done", after)
      }
    }
    observation = after
  }
}

/** Read visual regions only when the perception extension is installed. */
async function readVisualRegions(driver: CuaDriver, observation: CuaObservation): Promise<{ captureId: string; regions: VisualRegion[] } | undefined> {
  const state = await driver.getWindowState({ pid: observation.pid, windowId: observation.windowId, includeAccessibilityTree: false, includeScreenshot: true })
  if (!state.captureId) return undefined
  try {
    const parsed = await driver.parseVisualRegions(state.captureId, { kinds: ["text", "icon"], minConfidence: 0.8, maxRegions: 100 })
    return parsed.regions.length ? { captureId: state.captureId, regions: parsed.regions } : undefined
  } catch {
    // not_installed and friends: the fallback simply does not exist here.
    return undefined
  }
}

async function observeWithRetry(driver: CuaDriver, target: { pid: number; windowId: number }, timeoutMs: number, signal?: AbortSignal): Promise<CuaObservation> {
  let lastError: unknown
  for (let attempt = 0; attempt <= MAX_OBSERVE_RETRIES; attempt++) {
    try {
      return await observe(driver, { ...target, timeoutMs: Math.min(timeoutMs, 8_000) })
    } catch (error) {
      lastError = error
      if (signal?.aborted) throw error
      await delay(Math.min(400, timeoutMs), undefined, { signal }).catch(() => undefined)
    }
  }
  throw lastError
}

export type VerifyOutcome = { failed: boolean; note?: string }

/**
 * The successor observation is the only witness of an action.
 *
 * - text: the field must now hold the prepared text (driver read-back counts).
 * - everything else: the screen must have moved, or the driver confirmed it.
 */
export function verifyStep(candidate: CuaCandidate, before: CuaObservation, after: CuaObservation, input: GuiTaskInput): VerifyOutcome {
  if (candidate.operation === "type_text" || candidate.operation === "set_value") {
    const slot = input.textSlots?.find(item => item.id === candidate.slotId)
    if (!slot) return { failed: true, note: "no prepared text for the selected field" }
    const holds = after.elements.some(element => typeof element.value === "string" && element.value.includes(slot.value))
    if (holds) return { failed: false, note: `verified: a field now holds the prepared ${slot.id} text` }
    return { failed: true, note: "the observed field value does not contain the prepared text" }
  }
  if (sameLines(before.lines, after.lines) && before.fingerprint === after.fingerprint) {
    return { failed: true, note: "the interface did not change after the action" }
  }
  return { failed: false, note: "the interface changed" }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function findApp(apps: Array<{ name: string; bundleId?: string; pid: number; running: boolean }>, target: string): { name: string; bundleId?: string; pid: number } | undefined {
  const needle = target.trim().toLowerCase()
  const running = apps.filter(app => app.running && app.pid > 0)
  return running.find(app => app.name.toLowerCase() === needle)
    ?? running.find(app => app.bundleId?.toLowerCase() === needle)
    ?? running.find(app => app.name.toLowerCase().includes(needle))
    ?? running.find(app => needle.includes(app.name.toLowerCase()))
}

function pickWindow(windows: Array<{ windowId: number; onScreen: boolean; title: string; bounds?: { w: number; h: number } }>): number {
  const titled = windows.filter(window => window.title)
  const pool = titled.length ? titled : windows
  const onScreen = pool.filter(window => window.onScreen)
  const candidates = onScreen.length ? onScreen : pool
  const sorted = [...candidates].sort((left, right) => (right.bounds?.w ?? 0) * (right.bounds?.h ?? 0) - (left.bounds?.w ?? 0) * (left.bounds?.h ?? 0))
  return sorted[0].windowId
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

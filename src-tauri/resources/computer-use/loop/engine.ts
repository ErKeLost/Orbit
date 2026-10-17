import { setTimeout as delay } from "node:timers/promises"
import type { CuaDriver } from "../cua/driver.ts"
import { normalizeAction } from "../cua/driver.ts"
import { DriverToolError, DriverUnavailableError, escalationOf, type EscalationRung } from "../cua/errors.ts"
import { noteDroppedCandidates, observe } from "../cua/observation.ts"
import type { CuaCandidate, CuaObservation, VisualRegion } from "../cua/types.ts"
import { applyPolicy, boundCandidates } from "../candidates/policy.ts"
import { buildCandidates, indexByIdentity } from "../candidates/sources.ts"
import { chooseAction, isRetryableChoiceError, type JevChoice, type JevChoiceInput } from "../choice/jev.ts"
import { captureVisionImage, type VisionImage } from "../vision/image.ts"
import { RepeatBrake, StallTracker } from "./stall.ts"
import { validateTaskInput, type GuiTaskEvent, type GuiTaskFailure, type GuiTaskInput, type GuiTaskMetrics, type GuiTaskResult, type GuiTaskStatus, type GuiTaskTrace } from "../gui-task-contract.ts"

/** Predicted probability for finishing without an explicit done round trip. */
const COMPLETION_THRESHOLD = 0.75
/**
 * Below this, the chooser's own "done" is not evidence, and the run keeps going.
 *
 * The predicted-completion shortcut above already has a floor; the answer the
 * chooser gives in words needs the same rule. Without it a run could deliver
 * nothing — measured: one refused press, then `done` at 0.39 — and report success,
 * which is worse than failing because it also skips the escalation ladder the
 * refusal had queued up.
 */
const DONE_CONFIDENCE_FLOOR = 0.6
/**
 * The same floor when this decision carried a screenshot.
 *
 * A picture moves the chooser's own confidence on the *same* screen: the
 * project's own measurement recorded one question at 0.97 without a picture and
 * 0.59 with one. Applying the text floor to a vision answer would therefore
 * reject the very answers the picture was attached to improve, so the vision
 * path gets its own floor. The value sits between the two measured points that
 * bracket it — the 0.39 `done` that was accepted without evidence, and the 0.59
 * `done` that the picture made more reliable — so it is not a number taken from
 * the text path.
 */
const DONE_CONFIDENCE_FLOOR_VISION = 0.5
/**
 * The floor below which a `done` is never evidence, on any path.
 *
 * The text and vision floors already sit at or above this; keeping it explicit
 * means a future path cannot quietly accept a `done` the chooser itself was
 * unsure of, which is the case the 0.39 measurement below is meant to keep out.
 */
const DONE_CONFIDENCE_ABSOLUTE_FLOOR = 0.5
/**
 * Driver codes to the failure branch they name.
 *
 * The code is the driver's own contract, so it is matched exactly. The string
 * scanning inside `classifyFailure` stays only as a fallback for failures that
 * arrive without a code (launch messages, local errors); scanning first was how
 * a permission problem could be read out of an unrelated message.
 */
const DRIVER_FAILURES: Record<string, { stage: GuiTaskFailure["stage"]; branch?: string; hint?: string }> = {
  stale_element_token: { stage: "deliver", branch: "stale-token", hint: "the snapshot changed before delivery; re-observing usually succeeds" },
  element_not_found: { stage: "deliver", branch: "target-missing", hint: "the target was gone at delivery time; re-observe and choose again" },
  background_unavailable: { stage: "deliver", branch: "background-refused", hint: "该目标没有安全的后台通道；引擎已为它准备了 FOREGROUND 或 POINTER 候选，重试一次通常能选到" },
  ax_window_unresolved: { stage: "observe", branch: "ax-unresolved", hint: "该应用在跑，但它的窗口没有任何辅助功能对象；引擎已先激活、必要时重启过一次。请确认窗口真的显示出来再重试。" },
  driver_unavailable: { stage: "launch", branch: "driver-missing", hint: "install Cua Driver and grant Accessibility + Screen Recording" },
  driver_not_granted: { stage: "launch", branch: "permission", hint: "grant CuaDriver Accessibility and Screen Recording in System Settings" },
  permission_denied: { stage: "launch", branch: "permission", hint: "grant CuaDriver Accessibility and Screen Recording in System Settings" },
}
/** Operations whose delivery changes the visible interface. */
const CHANGE_OPERATIONS = new Set<CuaCandidate["operation"]>(["click", "double_click", "right_click", "type_text", "set_value", "press_key", "hotkey", "menu"])
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
  const { driver, signal, decide = chooseAction, emit = () => undefined, confirm, visualFallback = false, vision = "off" } = deps
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
  /** Targets whose escalated delivery a human has already approved this run. */
  const approvedEscalations = new Set<string>()
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
  /** Set when the perception extension is not installed, so the loop stops
   * paying for a screenshot and OCR every turn. */
  let visualUnavailable = false
  let lastNoEffect: string | undefined
  let lastConfidence: number | undefined
  /** Successful deliveries per stable target identity, for the chooser's
   * progress counters. */
  const performedSteps: Record<string, number> = {}
  // One bounded recovery is allowed when the window's accessibility surface is
  // unresolved: the driver reports `escalation: foreground`, and a window that
  // is merely behind on the same Space usually resolves after being raised.
  let recoveryAttempted = false

  const remaining = () => Math.max(1, deadline - Date.now())
  /**
   * True when the wall-clock budget is spent.
   *
   * `remaining()` bottoms out at 1ms so a tool call still gets a deadline; a
   * call killed by that floor must be classified as `timeout`, not left to
   * surface as a generic tool error under `decide`.
   */
  const budgetExhausted = () => Date.now() >= deadline
  const classifyFailure = (status: GuiTaskStatus, note?: string, error?: unknown): GuiTaskFailure | undefined => {
    if (status === "done") return undefined
    const text = note ?? ""
    const code = error instanceof DriverToolError ? error.code
      : error instanceof DriverUnavailableError ? error.code
        : ""
    const byCode = code ? DRIVER_FAILURES[code.toLowerCase()] : undefined
    if (byCode) return { stage: byCode.stage, ...(byCode.branch ? { branch: byCode.branch } : {}), detail: text || code, ...(byCode.hint ? { hint: byCode.hint } : {}) }
    const has = (needle: string) => text.toLowerCase().includes(needle.toLowerCase())
    if (has("stale_element_token") || has("element token is stale")) return { stage: "deliver", branch: "stale-token", detail: text, hint: "the snapshot changed before delivery; re-observing usually succeeds" }
    if (has("driver_unavailable")) return { stage: "launch", branch: "driver-missing", detail: text, hint: "install Cua Driver and grant Accessibility + Screen Recording" }
    if (has("driver_not_granted") || has("permission")) return { stage: "launch", branch: "permission", detail: text, hint: "grant CuaDriver Accessibility and Screen Recording in System Settings" }
    if (has("app not found") || has("did not come back") || has("no on-screen window") || has("exposes no window accessibility can reach") || has("not restarting the app you are using")) {
      return { stage: "launch", branch: "window-unreachable", detail: text, hint: "该应用没有能驱动的窗口：引擎已经先激活它、并在它不在前台时重启过一次。走到这里说明它既拉不出可见窗口，又是你正在使用的前台应用（引擎不会重启你正在用的应用），或者重启后窗口仍然不可达。请确认这个应用自己能把窗口显示出来，或换一个目标再试。" }
    }
    if (has("ax_window_unresolved")) return { stage: "observe", branch: "ax-unresolved", detail: text, hint: "该应用在跑，但它持有的窗口没有任何辅助功能对象——WindowServer 里能看到 window_id，AX 里却是 0 个 AXWindow——所以驱动读不到元素，按设计也拒绝在看不见的窗口上后台操作。常见原因是被最小化、被隐藏、在别的 Space，或进程还在但窗口已经被应用释放。引擎已经先试过激活、必要时重启该应用；走到这里说明它是你正在使用的前台应用（引擎不会重启你正在用的应用），或重启后窗口仍不可达。请在 Dock 上点一下该应用确认窗口真的显示出来，或退出它再重试。这不代表该应用不支持辅助功能，不要据此改用其它方式。" }
    if (has("invalid choice answer")) return { stage: "decide", branch: "answer-shape", detail: text, hint: "the model returned a malformed answer; retrying usually succeeds" }
    if (has("max_tokens_exceeded")) return { stage: "decide", branch: "request-size", detail: text, hint: "the observation plus the offer set exceeded the model input budget" }
    if (status === "needs_review") {
      if (has("declined") || has("refused by the user")) return { stage: "risk-gate", branch: "declined", detail: text, hint: "the user declined this step; ask for it explicitly or do it by hand" }
      if (has("no confirmation")) return { stage: "risk-gate", branch: "irreversible", detail: text, hint: "re-run in an interactive session so the confirmation can be shown" }
      return { stage: "risk-gate", detail: text, hint: "re-run in an interactive session so the confirmation can be shown" }
    }
    if (status === "needs_text") return { stage: "decide", branch: "text-slot", detail: text, hint: "provide a textSlot carrying the value the field needs" }
    if (status === "blocked") return { stage: "offer-set", detail: text, hint: "the window offered no usable action; check the app state or rephrase the goal" }
    if (status === "max_actions") return { stage: "budget", branch: "actions", detail: `action budget (${input.budget.maxActions}) was spent`, hint: "raise budget.maxActions or narrow the goal" }
    if (status === "max_decisions") return { stage: "budget", branch: "decisions", detail: `decision budget (${input.budget.maxDecisions}) was spent`, hint: "raise budget.maxDecisions or narrow the goal" }
    if (status === "timeout") return { stage: "budget", branch: "duration", detail: `time budget (${input.budget.maxDurationMs}ms) was spent`, hint: "raise budget.maxDurationMs" }
    if (status === "error") return { stage: "decide", detail: text }
    return undefined
  }
  const finish = (status: GuiTaskStatus, observation?: CuaObservation, note?: string, error?: unknown): GuiTaskResult => {
    metrics.elapsedMs = Math.max(0, Date.now() - startedAt)
    if (note) trace.push({ step: decisions, stateId: observation?.fingerprint ?? "unobserved", note })
    const failure = classifyFailure(status, note, error)
    return { status, appLaunched, goalVerified, lastAction, actions, decisions, evidence: observation?.context.slice(0, 2_000) ?? "", metrics, trace, ...(failure ? { failure } : {}) }
  }

  if (signal?.aborted) return finish("aborted")

  // ---- resolve the app and its window -------------------------------------
  const launchStarted = performance.now()
  let pid: number
  let windowId: number
  try {
    emit({ type: "launching", step: 0, status: "running", payload: { app: input.target.app } })
    const resolved = await resolveWindow(driver, input.target.app, { remaining, signal, emit, history, trace, confirm })
    pid = resolved.pid
    windowId = resolved.windowId
    // `appLaunched` is what the caller reports as "已打开并读取应用界面": it means
    // the app is up with a window this run can read — not that this run started
    // it. Adopting an app the user already had open is still having opened it in
    // every sense the caller cares about, and saying otherwise made a working run
    // read as a failure.
    appLaunched = true
    // The distinction that *is* worth recording goes in the trace, where it
    // explains why an app the user was already using got restarted.
    if (resolved.launched) trace.push({ step: 0, stateId: "unobserved", note: `launched ${input.target.app}` })
  } catch (error) {
    if (error instanceof AppResolutionError && error.needsReview) return finish("needs_review", undefined, safeError(error), error)
    return finish(signal?.aborted ? "aborted" : "error", undefined, safeError(error), error)
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
      const detail = error instanceof DriverToolError ? `${error.code}: ${safeError(error)}` : safeError(error)
      if (signal?.aborted) return finish("aborted", undefined, detail, error)
      if (budgetExhausted()) return finish("timeout", undefined, detail, error)
      return finish("error", undefined, detail, error)
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
    const observed = observation
    const visual = visualFallback && !visualUsed && !visualUnavailable
      ? await readVisualRegions(driver, observed).catch(error => {
          // The perception extension is absent, not broken: stop paying for a
          // screenshot and OCR on every turn once the driver says it is gone.
          if (isNotInstalled(error)) visualUnavailable = true
          return undefined
        })
      : undefined
    if (visual) visualUsed = true
    const buildOffers = (forceScroll: boolean) => {
      const all = buildCandidates(observed, {
        goal: input.goal,
        readOnly: Boolean(input.readOnly),
        pid,
        windowId,
        textSlots: input.textSlots ?? [],
        usedSlotIds,
        allowEnter,
        lastTypedToken,
        allElements: observed.elements,
        escalate,
        forceScroll,
        ...(visual ? { visual } : {}),
      })
      const policyCandidates = applyPolicy(all, {
        readOnly: Boolean(input.readOnly),
        goal: input.goal,
        quarantined,
        triedHere,
        repeatedTargets: repeat.blocked,
      })
      return boundCandidates(policyCandidates)
    }
    let bound = buildOffers(false)
    // A capped offer set hides targets the window really has, so the scroll
    // candidates must exist. They are built in a second pass because only the
    // first one knows that the cap bit.
    if (bound.dropped > 0) bound = buildOffers(true)
    offered = bound.offered
    if (bound.dropped > 0) {
      observation = noteDroppedCandidates(observed, bound.dropped)
      history.push(`${bound.dropped} candidates were dropped by the offer-set cap; scrolling is offered to reveal them`)
    }
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
      progress: { actions, decisions, performedSteps },
      ...(visual ? { regions: visual.regions, captureId: visual.captureId } : {}),
      ...(image ? { image } : {}),
    }
    const visionNote = image ? `screenshot attached (${image.width}x${image.height})` : undefined
    try {
      metrics.jevCalls++
      choice = await decide(choiceInput, signal)
    } catch (error) {
      if (signal?.aborted) return finish("aborted", observation, safeError(error), error)
      if (budgetExhausted()) return finish("timeout", observation, safeError(error), error)
      if (!isRetryableChoiceError(error)) return finish("error", observation, safeError(error), error)
      try {
        choice = await decide({ goal: input.goal, observation, candidates: offered, history, ...(image ? { image } : {}) }, signal)
      } catch (retryError) {
        if (signal?.aborted) return finish("aborted", observation, safeError(retryError), retryError)
        if (budgetExhausted()) return finish("timeout", observation, safeError(retryError), retryError)
        return finish("error", observation, safeError(retryError), retryError)
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
      const predicted = typeof choice.completesGoal === "number" ? choice.completesGoal : undefined
      const floor = Math.max(DONE_CONFIDENCE_ABSOLUTE_FLOOR, image ? DONE_CONFIDENCE_FLOOR_VISION : DONE_CONFIDENCE_FLOOR)
      // Both of the chooser's signals must be adequate, not one of them. Accepting
      // on `predicted >= COMPLETION_THRESHOLD` alone let a run point at the wrong
      // control, predict high completion from the goal text, and finish having
      // changed nothing — the confidence is the half that says it is looking at
      // the right thing. A missing prediction is an absent signal, not a bad one,
      // so a confidently stated `done` still finishes.
      const confident = choice.confidence >= floor
      const predictionAdequate = predicted === undefined || predicted >= COMPLETION_THRESHOLD
      if (!confident || !predictionAdequate) {
        const reasons: string[] = []
        if (!confident) reasons.push(`confidence ${choice.confidence.toFixed(2)} is below ${floor}`)
        if (!predictionAdequate) reasons.push(`the predicted completion ${(predicted ?? 0).toFixed(2)} is below ${COMPLETION_THRESHOLD}`)
        history.push(
          `done was rejected: ${reasons.join(" and ")}`
          + `${image ? " (a screenshot was attached, so the vision floor applies)" : ""}; done stays available next turn`,
        )
        entry.outcome = "done_rejected_low_confidence"
        // Deliberately NOT added to triedHere. Policy withholds tried
        // candidates, and a screen that has stopped changing is the very shape
        // of a finished goal: excluding done here turned a false success into a
        // false failure that ran out of budget instead.
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

    // ---- risk gate ---------------------------------------------------------
    const before = observation
    // A label that names a hard-to-undo action (the goal allowed it, but that is
    // not a confirmation), and a change-class delivery that exists only on the
    // escalated rung, both need a human before they run. Without a confirmation
    // surface the step does not execute at all, exactly as the browser engine's
    // risk gate behaves.
    if (requiresConfirmation(selected, approvedEscalations)) {
      const summary = confirmationSummary(selected)
      if (!confirm) return finish("needs_review", before, `${summary}，但当前没有可确认的界面 (no confirmation UI available)`)
      const accepted = await confirm(summary).catch(() => false)
      if (!accepted) return finish("needs_review", before, `用户拒绝 (the user declined): ${summary}`)
      // The approval is remembered per target, so the next escalated attempt at
      // the same target does not ask again. Only the escalated rung is
      // remembered; a risky label keeps asking every time.
      const target = escalatedTarget(selected)
      if (target) approvedEscalations.add(target)
    }

    // ---- deliver -----------------------------------------------------------
    const actionStarted = performance.now()
    let effect: string | undefined
    let escalation: string | undefined
    try {
      const result = await driver.callTool(selected.tool!, selected.args as Record<string, unknown>, { timeoutMs: Math.min(remaining(), 30_000), signal })
      const normalized = normalizeAction(result)
      effect = normalized.effect
      escalation = normalized.escalation?.recommended
      actions++
      const key = selected.identity ?? selected.id
      performedSteps[key] = (performedSteps[key] ?? 0) + 1
      entry.outcome = normalized.effect ?? "delivered"
      lastAction = { operation: selected.legacyOperation, delivery: normalized.effect }
      if (selected.slotId) {
        usedSlotIds.add(selected.slotId)
        allowEnter = selected.operation === "type_text"
        lastTypedToken = selected.elementToken
      } else if (selected.operation !== "type_text") {
        allowEnter = false
      }
      if (escalation) entry.note = `driver reports the next rung is ${escalation}`
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
          // foreground implicitly. Offer the rung it named as a separate
          // candidate. The rung is stored as the driver gave it: a pointer route
          // is not a foreground route and must not be silently downgraded.
          escalate.set(selected.identity, rung)
          history.push(`${selected.legacyOperation} refused (${error.code}); the driver recommends the ${rung} route for this target, so a ${rung.toUpperCase()} candidate for the same target is offered and must be chosen explicitly`)
          continue
        }
        if (error.retryable || /stale_element_token|x_unresolved|unsupported|refused|unavailable|background_/i.test(error.code)) {
          history.push(`${selected.legacyOperation} refused (${error.code}); choose a different candidate`)
          continue
        }
        return finish("needs_review", before, safeError(error), error)
      }
      if (signal?.aborted) return finish("aborted", before, safeError(error), error)
      if (budgetExhausted()) return finish("timeout", before, safeError(error), error)
      return finish("error", before, safeError(error), error)
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
    entry.changed = !sameLines(before.signature, after.signature)
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
    const verdict = stall.record(`${selected.legacyOperation}:${selected.identity ?? selected.id}`, before.signature, after.signature)
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
  } catch (error) {
    // not_installed: the fallback does not exist here. Reported so the loop can
    // stop asking every turn; other errors are transient and just yield no
    // regions this time.
    if (isNotInstalled(error)) throw new VisualUnavailableError(safeError(error))
    return undefined
  }
}

/** The perception extension is absent, so the visual fallback cannot run. */
class VisualUnavailableError extends Error {}

function isNotInstalled(error: unknown): boolean {
  if (error instanceof VisualUnavailableError) return true
  if (error instanceof DriverToolError) return /not[\s_-]*installed/i.test(error.code)
  return /not[\s_-]*installed|unknown tool|no such tool/i.test(safeError(error))
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
 * - text: the *same* field must now hold the prepared text. Whole-tree matching
 *   was the old bug: it reported success when any field held the text, so a
 *   value entered into the wrong field was graded as delivered. When the target
 *   has left the screen (navigation, dismissal) the delivery is neither
 *   confirmed nor refuted, so it is not graded as a failure.
 * - everything else: the screen must have moved, or the driver confirmed it.
 */
export function verifyStep(candidate: CuaCandidate, before: CuaObservation, after: CuaObservation, input: GuiTaskInput): VerifyOutcome {
  if (candidate.operation === "type_text" || candidate.operation === "set_value") {
    const slot = input.textSlots?.find(item => item.id === candidate.slotId)
    if (!slot) return { failed: true, note: "no prepared text for the selected field" }
    const target = candidate.identity ? indexByIdentity(after.elements).get(candidate.identity) : undefined
    if (!target) {
      return { failed: false, note: `the target field is no longer on screen, so the prepared ${slot.id} text cannot be confirmed here` }
    }
    const holds = typeof target.value === "string" && target.value.includes(slot.value)
    if (holds) return { failed: false, note: `verified: the target field now holds the prepared ${slot.id} text` }
    return { failed: true, note: "the target field does not contain the prepared text" }
  }
  if (sameLines(before.signature, after.signature) && before.fingerprint === after.fingerprint) {
    return { failed: true, note: "the interface did not change after the action" }
  }
  return { failed: false, note: "the interface changed" }
}

/** A shared empty set, so the common no-approvals case allocates nothing per call. */
const EMPTY_APPROVALS: ReadonlySet<string> = new Set()

/**
 * Which deliveries a human must approve first.
 *
 * Two things qualify:
 *
 * - A label that names a hard-to-undo action. This keeps asking every time: the
 *   goal explicitly allowed it, but repeating a confirmation for a destructive
 *   action is the point, not a nuisance.
 * - A change-class delivery that only exists because the driver refused the safe
 *   background route. This is not itself dangerous — it is unsighted. In an app
 *   that refuses background input for everything (Electron), every step arrives
 *   escalated, so asking every time makes the run unusable with no confirmation
 *   UI and tedious with one. The first escalation at a target is approved once;
 *   that target's later attempts are the same decision the user already made.
 */
export function requiresConfirmation(candidate: CuaCandidate, approved: ReadonlySet<string> = EMPTY_APPROVALS): boolean {
  if (candidate.risky === true) return true
  if (candidate.escalated !== true || !CHANGE_OPERATIONS.has(candidate.operation)) return false
  const target = escalatedTarget(candidate)
  return target === undefined || !approved.has(target)
}

/** The target an escalated candidate is a second attempt at, without the rung suffix. */
export function escalatedTarget(candidate: CuaCandidate): string | undefined {
  return candidate.identity?.replace(/:(fg|px)$/, "")
}

function confirmationSummary(candidate: CuaCandidate): string {
  const what = candidate.label ? `「${candidate.label}」` : candidate.description.split(";")[0]
  return `${candidate.legacyOperation} ${what} 可能不可撤销或会改变可见界面，是否执行？`
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
  return true
}

function findApp(apps: Array<{ name: string; bundleId?: string; pid: number; running: boolean; active?: boolean }>, target: string): { name: string; bundleId?: string; pid: number; active: boolean } | undefined {
  const needle = target.trim().toLowerCase()
  const running = apps.filter(app => app.running && app.pid > 0)
  const found = running.find(app => app.name.toLowerCase() === needle)
    ?? running.find(app => app.bundleId?.toLowerCase() === needle)
    ?? running.find(app => app.name.toLowerCase().includes(needle))
    ?? running.find(app => needle.includes(app.name.toLowerCase()))
  return found ? { name: found.name, pid: found.pid, active: found.active === true, ...(found.bundleId ? { bundleId: found.bundleId } : {}) } : undefined
}

/** A window the task can drive, and whether getting it launched the app. */
type WindowResolution = { pid: number; windowId: number; launched: boolean }

/** Why the task cannot be given a window, phrased for the calling model. */
class AppResolutionError extends Error {
  constructor(message: string, readonly needsReview = false) {
    super(message)
    this.name = "AppResolutionError"
  }
}

/**
 * The window this task will drive, bringing the app up when it has none.
 *
 * `pickWindow` refusing every window means the app is running with nothing an
 * accessibility client can reach. Two recoveries follow, in this order:
 *
 * 1. **Activate it.** That is the whole fix for a window merely behind another
 *    one on the same Space, and it never disturbs what the user is doing.
 * 2. **Restart it.** A window WindowServer still lists but that owns no
 *    `AXWindow` cannot be raised, focused or resized by any client —
 *    `bring_to_front` proves it by activating the process while the window
 *    stays off-screen, and `set_window_frame` refuses it outright. Only a
 *    relaunch clears that, so it is skipped while the user has the app in the
 *    foreground, re-checks that immediately before killing, and asks for
 *    confirmation first because a relaunch can close the user's unsaved work.
 */
async function resolveWindow(
  driver: CuaDriver,
  target: string,
  deps: { remaining: () => number; signal?: AbortSignal; emit: (event: GuiTaskEvent) => void; history: string[]; trace: GuiTaskTrace[]; confirm?: (summary: string) => Promise<boolean> },
): Promise<WindowResolution> {
  const { remaining, signal, emit, history, trace, confirm } = deps
  const wait = (ms: number) => delay(Math.min(ms, remaining()), undefined, { signal }).catch(() => undefined)

  let app = findApp(await driver.listApps(), target)
  let launched = false
  let frontmost = app?.active === true
  /**
   * The call itself, with no opinion about whether it is wanted.
   *
   * `frontmost` is set only when the call actually succeeded. Setting it
   * optimistically made a failed raise permanent: `activate` skips an app it
   * believes is already in front, so the one retry that would have worked never
   * happened.
   */
  const bringToFront = async (id: number | undefined) => {
    try {
      await driver.callTool("bring_to_front", { pid, ...(id === undefined ? {} : { window_id: id }) })
      frontmost = true
    } catch {
      // Leave the previous value; a later attempt may still succeed.
    }
    await wait(800)
  }
  /**
   * Put the app in front, unless it is already the one in front.
   *
   * Computer use is a foreground activity, and this is what makes it one: the
   * user has to be able to see what is being driven, and the driver declines
   * background input often enough that a run which never raises the app spends
   * its budget being refused. Skipping when it is already frontmost is the half
   * that matters for politeness — raising an app the user is already looking at
   * would steal focus for nothing. A failed first raise is retried once, because
   * the app may still have been settling.
   */
  const activate = async (id: number | undefined) => {
    if (frontmost) return
    emit({ type: "status", step: 0, status: "running", payload: { note: `bringing ${app?.name ?? target} to the front` } })
    await bringToFront(id)
    if (!frontmost) await bringToFront(id)
  }
  if (!app) {
    await driver.callTool("launch_app", { name: target }).catch(() => undefined)
    await wait(1_500)
    app = findApp(await driver.listApps(), target)
    launched = true
  }
  if (!app) throw new AppResolutionError(`app not found: ${target}`)
  let pid = app.pid

  let windows = await driver.listWindows({ pid })
  let windowId = pickWindow(windows)
  // A freshly started app registers its process before it draws, so an app with
  // no window at all is worth waiting for. An app with an off-screen window is
  // not: waiting cannot give that window an accessibility surface.
  for (let attempt = 0; windowId === undefined && windows.length === 0 && attempt < 8; attempt += 1) {
    await wait(250)
    windows = await driver.listWindows({ pid })
    windowId = pickWindow(windows)
  }
  if (windowId !== undefined) {
    await activate(windowId)
    return { pid, windowId, launched }
  }

  emit({ type: "status", step: 0, status: "running", payload: { note: "no on-screen window; attempting one foreground activation" } })
  const stale = windows[0]
  // Unconditional, unlike `activate`: this is the recovery, and a window that is
  // merely behind another one of the same app comes back by naming it exactly.
  await bringToFront(stale?.windowId)
  await wait(400)
  windowId = pickWindow(await driver.listWindows({ pid }))
  if (windowId !== undefined) return { pid, windowId, launched }

  const running = findApp(await driver.listApps(), target)
  if (running?.active) {
    throw new AppResolutionError(`${app.name} is the frontmost app but exposes no window accessibility can reach; not restarting the app you are using`)
  }
  if (running) {
    // Re-read the frontmost app immediately before the destructive step: the
    // check above is a snapshot, and the user can switch to the app in between.
    // Restarting an app someone is using would close their unsaved work.
    if (findApp(await driver.listApps(), target)?.active) {
      throw new AppResolutionError(`${app.name} came to the front while a restart was being prepared; not restarting the app you are using`)
    }
    const summary = `重启 ${app.name}：它正在运行，但它的窗口没有任何辅助功能对象，重启会关闭它当前未保存的内容`
    if (!confirm) {
      throw new AppResolutionError(`restarting ${app.name} needs user confirmation, but no confirmation UI is available: ${summary}`, true)
    }
    const accepted = await confirm(summary).catch(() => false)
    if (!accepted) throw new AppResolutionError(`the user declined to restart ${app.name}: ${summary}`, true)
    emit({ type: "status", step: 0, status: "running", payload: { note: "window unreachable by accessibility; restarting the app" } })
    await driver.callTool("kill_app", { pid }).catch(() => undefined)
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await wait(150)
    if (!findApp(await driver.listApps(), target)) break
  }
  await driver.callTool("launch_app", { name: target }).catch(() => undefined)
  launched = true
  let relaunched = findApp(await driver.listApps(), target)
  // The window to wait for belongs to a *new* process: the old pid still being
  // listed is the app shutting down, not the app coming back.
  for (let attempt = 0; (relaunched === undefined || relaunched.pid === pid) && attempt < 12; attempt += 1) {
    await wait(250)
    relaunched = findApp(await driver.listApps(), target)
  }
  if (!relaunched || relaunched.pid === pid) throw new AppResolutionError(`restarted ${app.name} but it did not come back`)
  // Recorded only now, not when the restart was decided: this is a side effect on
  // the user's machine, and a trace that claims one happened while the run is
  // failing is worse than no trace at all.
  history.push(`restarted ${app.name}: it was running with a window no accessibility client could reach`)
  trace.push({ step: 0, stateId: "unobserved", note: `restarted ${app.name}: its window had no accessibility surface` })
  pid = relaunched.pid
  frontmost = relaunched.active === true
  for (let attempt = 0; windowId === undefined && attempt < 30; attempt += 1) {
    await wait(200)
    windowId = pickWindow(await driver.listWindows({ pid }))
  }
  if (windowId === undefined) throw new AppResolutionError(`no on-screen window for ${app.name}: it is running but exposes no window accessibility can reach`)
  await activate(windowId)
  return { pid, windowId, launched }
}

/**
 * The window this task will drive: an on-screen one, or nothing.
 *
 * A window that WindowServer still lists but that is off-screen (minimized,
 * hidden, on another Space, or released by an app whose process outlived it) has
 * no accessibility surface, so driving it can only end in `ax_window_unresolved`.
 * Reporting "no usable window" lets the caller bring one up instead; returning
 * the off-screen window costs the whole run on something nothing can read.
 *
 * KNOWN LIMITATION: the only tie-breaker is area, so an app whose main window
 * has a large sheet/dialog open can hand the run the sheet. The driver's
 * `list_windows` rows expose `window_id`, `title`, `pid`, `app_name`,
 * `is_on_screen`, `bounds` and `z_index` — there is no `focused`/`main` flag to
 * prefer (checked in `cua/driver.ts`), and `z_index` carries no documented
 * direction, so guessing a front-most window from it would be worse than the
 * deterministic area rule. If the driver ever adds such a field, prefer it here.
 */
function pickWindow(windows: Array<{ windowId: number; onScreen: boolean; title: string; bounds?: { w: number; h: number } }>): number | undefined {
  const titled = windows.filter(window => window.title)
  const pool = titled.length ? titled : windows
  const onScreen = pool.filter(window => window.onScreen)
  if (!onScreen.length) return undefined
  const sorted = [...onScreen].sort((left, right) => (right.bounds?.w ?? 0) * (right.bounds?.h ?? 0) - (left.bounds?.w ?? 0) * (left.bounds?.h ?? 0))
  return sorted[0].windowId
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

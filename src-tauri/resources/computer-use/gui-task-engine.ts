import { setTimeout as delay } from "node:timers/promises"
import { DesktopCommandError, type DesktopDriver, type LaunchData } from "./desktop-driver.ts"
import { resolveDesktopApp } from "./desktop-app-resolver.ts"
import { attachMedia, invalidateMenuCache, observeDesktop, readMediaFact } from "./desktop-observation.ts"
import { isReplayableOperation, lookupTemplate, memoryIdentity, resolveStep, memoryKey, parameterize, type AffordanceMemory, type MemoryStep } from "./affordance-memory.ts"
import { assessDesktopRisk, decideDesktop, isRetryableJevError, redactLocalSlots } from "./jev.ts"
import { validateTaskInput, type DesktopCandidate, type DesktopDecision, type DesktopNode, type DesktopObservation, type GuiTaskEvent, type GuiTaskInput, type GuiTaskMetrics, type GuiTaskResult, type GuiTaskStatus, type GuiTaskTrace, stableCriteria } from "./gui-task-contract.ts"
import { describeDiff, diffTrees, findNodeByIdentity } from "./tree-diff.ts"

const CHROMIUM_RENDERER_SETTLE_MS = 2_000
const SETTLE_POLL_MS = 60
const SETTLE_CEILING_MS = 900
/** Wait for the first accessibility notification after an action. */
const EVENT_SETTLE_TIMEOUT_MS = 900
/** The "new" marker is only informative when a minority of targets changed. */
const MAX_NEW_MARKERS = 24
/** Replay: re-observe this many times for a remembered target to appear. */
const REPLAY_WAIT_POLLS = 8
const REPLAY_WAIT_POLL_MS = 120
/** Busy-aware settle: keep observing while a progress indicator is shown. */
const BUSY_CEILING_MS = 3_000
const BUSY_POLL_MS = 150
/** After typing into an autocomplete field, wait this long for suggestions. */
const SUGGESTION_WAIT_MS = 300
/** Minimum predicted probability for finishing without a DONE round trip. */
const COMPLETION_THRESHOLD = 0.75

export async function runGuiTaskEngine({
  input,
  client,
  signal,
  decide = decideDesktop,
  observe = observeDesktop,
  resolveApp = resolveDesktopApp,
  assessRisk = assessDesktopRisk,
  emit = () => undefined,
  confirm,
  memory,
}: {
  input: GuiTaskInput
  client: DesktopDriver
  signal?: AbortSignal
  decide?: typeof decideDesktop
  observe?: typeof observeDesktop
  resolveApp?: typeof resolveDesktopApp
  assessRisk?: typeof assessDesktopRisk
  emit?: (event: GuiTaskEvent) => void
  confirm?: (summary: string) => Promise<boolean>
  /** Affordance Memory; omitted in tests and when disabled. */
  memory?: AffordanceMemory
}): Promise<GuiTaskResult> {
  validateTaskInput(input)
  const startedAt = Date.now()
  const deadline = startedAt + input.budget.maxDurationMs
  const metrics: GuiTaskMetrics = { elapsedMs: 0, launchMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, replayedSteps: 0, settleMs: 0, settleEvents: 0 }
  const trace: GuiTaskTrace[] = []
  const history: string[] = []
  const usedSlotIds = new Set<string>()
  let root: string | undefined
  let repeatedDrillKey: string | undefined
  const drillCounts = new Map<string, number>()
  // Regions whose inspection stopped yielding anything new; their DRILL
  // candidates are no longer offered, forcing Jev to act on observed targets.
  const drillExhausted = new Set<string>()
  let pendingDrill: { key: string; signature: string } | undefined
  let allowPressEnter = false
  let consecutiveWaits = 0
  let unchangedMutations = 0
  let pendingMutation: { before: string; beforeTree: DesktopNode; entry: GuiTaskTrace; historyIndex: number } | undefined
  // Targets whose inferred action was verified to be wrong (opened an
  // unrelated overlay or had no effect). Keyed by observed identity, not by
  // snapshot ref, so they stay excluded across successor observations.
  const quarantined = new Set<string>()
  // Text targets whose declared text operation was delivered but verified to
  // have failed (value_equals). Excluded from the offered space without the
  // speculative gate so the alternate delivery operation stays available.
  const verifiedFailures = new Set<string>()
  let actions = 0
  let decisions = 0
  let appLaunched = false
  let goalVerified = false
  let lastAction: GuiTaskResult["lastAction"]
  const slotsForMemory = input.textSlots ?? []
  // Undo-risk answers by target identity: they do not change within a task.
  const riskCache = new Map<string, number>()
  // Identities offered before the last delivered action; successors not in
  // this set are marked "new" for Jev (browser-use's `*` marker).
  let previousIdentities: Set<string> | undefined
  // Affordance Memory: learned trajectory replay and learning.
  const memoryKeyValue = memory ? memoryKey(input.target.app, input.goal, slotsForMemory, Boolean(input.readOnly)) : undefined
  let replayPlan: MemoryStep[] | undefined
  let replayIndex = 0
  let replayMisses = 0
  // Completion probability recorded when the trajectory was learned; lets
  // the last replayed step finish without a DONE round trip.
  let replayCompletion: number | undefined
  const learnedSteps: MemoryStep[] = []
  // Label of each learned step's target when it was chosen among same-shaped
  // siblings: candidates for template variables.
  const learnedLabels: (string | undefined)[] = []
  let replayTemplateKey: string | undefined
  let learnedCompletion: number | undefined
  // Executed mutation targets, for cycle detection (A,B,A,B,... loops).
  const mutationKeys: string[] = []
  let learningTainted = false
  const abandonReplay = async (reason: string) => {
    if (!replayPlan) return
    replayPlan = undefined
    trace.push({ step: decisions, stateId: observation?.fingerprint ?? "unobserved", source: "memory", note: `memory replay stopped: ${reason}; continuing with Jev` })
    if (memory && memoryKeyValue) await memory.recordFailure(replayTemplateKey ?? memoryKeyValue).catch(() => undefined)
  }

  const remaining = () => Math.max(1, deadline - Date.now())
  const finish = (status: GuiTaskStatus, observation?: DesktopObservation, note?: string): GuiTaskResult => {
    metrics.elapsedMs = Math.max(0, Date.now() - startedAt)
    if (status === "done" && memory && memoryKeyValue && !learningTainted && learnedSteps.length > 0) {
      void memory.recordSuccess(memoryKeyValue, learnedSteps, learnedCompletion).catch(() => undefined)
      const template = parameterize(input.target.app, input.goal, slotsForMemory, Boolean(input.readOnly), learnedSteps, learnedLabels)
      if (template) void memory.recordSuccess(template.key, template.steps, learnedCompletion).catch(() => undefined)
    }
    if (note) trace.push({ step: decisions, stateId: observation?.fingerprint ?? "unobserved", note })
    return { status, appLaunched, goalVerified, lastAction, actions, decisions, evidence: observation?.context.slice(0, 2_000) ?? "", metrics, trace }
  }
  if (signal?.aborted) return finish("aborted")
  emit({ type: "launching", step: 0, status: "running", payload: { app: input.target.app } })
  const launchStarted = performance.now()
  let launched: LaunchData
  try {
    const resolved = await resolveApp(input.target.app, signal)
    try {
      launched = (await client.run<LaunchData>(["launch", resolved.displayName, "--activate", "--timeout", String(remaining())], { timeoutMs: remaining(), signal })).data!
    } catch (error) {
      const expectedPid = error instanceof DesktopCommandError && error.detail.code === "APP_UNRESPONSIVE"
        && error.detail.disposition?.delivery === "delivered_unverified"
        && error.detail.details && typeof error.detail.details === "object"
        ? (error.detail.details as { expected_pid?: unknown }).expected_pid
        : undefined
      if (typeof expectedPid !== "number") throw error
      // Electron-style apps can return a helper PID from NSWorkspace even
      // though the requested main app is already running and AX-addressable.
      launched = { app: resolved.displayName, pid: expectedPid }
    }
    appLaunched = true
    if (launched.renderer === "chromium") await delay(Math.min(CHROMIUM_RENDERER_SETTLE_MS, remaining()), undefined, { signal })
  } catch (error) {
    // A missing Accessibility grant is recoverable only by the user, so it is
    // a blocked task, not an app failure; PERM_DENIED is the authoritative code.
    if (error instanceof DesktopCommandError && error.detail.code === "PERM_DENIED") {
      return finish("blocked", undefined, safeError(error))
    }
    return finish(signal?.aborted ? "aborted" : "error", undefined, safeError(error))
  } finally {
    metrics.launchMs += performance.now() - launchStarted
  }

  if (memory && memoryKeyValue) {
    let entry = await memory.lookup(memoryKeyValue).catch(() => undefined)
    if (!entry || entry.successes <= entry.failures) {
      // Same task shape with a different item ("open {X}'s card").
      const templated = await lookupTemplate(memory, input.target.app, input.goal, slotsForMemory, Boolean(input.readOnly)).catch(() => undefined)
      if (templated) {
        entry = templated.entry
        replayTemplateKey = templated.key
      }
    }
    if (entry && entry.successes > entry.failures) {
      replayPlan = entry.steps
      replayCompletion = entry.completion
    }
  }

  let observation: DesktopObservation | undefined
  // Observation produced by the post-action settle loop; reused as the next
  // turn's observation so a settled tree is never walked twice.
  let prefetched: DesktopObservation | undefined
  let staleRetries = 0
  let consecutiveFailures = 0
  while (true) {
    if (signal?.aborted) return finish("aborted", observation)
    if (Date.now() >= deadline) return finish("timeout", observation)

    const observationStarted = performance.now()
    try {
      const observeOnce = (windowId?: string) => observe(client, {
        app: launched.app || input.target.app,
        windowId,
        root,
        goal: input.goal,
        textSlots: input.textSlots ?? [],
        usedSlotIds,
        allowPressEnter,
      }, { timeoutMs: remaining(), signal })
      try {
        observation = prefetched && !root
          ? attachMedia(prefetched, prefetched.mediaSkipped ? await readMediaFact(client, { timeoutMs: Math.min(remaining(), 5_000), signal }) : undefined)
          : await observeOnce(launched.window?.id)
        prefetched = undefined
      } catch (error) {
        if (error instanceof DesktopCommandError && error.detail.code === "WINDOW_NOT_FOUND") {
          // Window ids only live for one app session, and apps rebuilding a
          // window present no window for a moment. Drop the cached id and
          // retry with settle time before giving up.
          launched.window = undefined
          let refreshed: DesktopObservation | undefined
          for (let attempt = 0; attempt < 2 && !refreshed; attempt++) {
            await delay(Math.min(1_500, remaining()), undefined, { signal })
            try {
              refreshed = await observeOnce(undefined)
            } catch (retryError) {
              if (retryError instanceof DesktopCommandError && retryError.detail.code === "WINDOW_NOT_FOUND") continue
              throw retryError
            }
          }
          if (!refreshed) throw error
          observation = refreshed
        } else {
          throw error
        }
      }
    } catch (error) {
      if (error instanceof DesktopCommandError && error.detail.code === "PERM_DENIED") {
        return finish("blocked", observation, safeError(error))
      }
      return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
    } finally {
      metrics.observationMs += performance.now() - observationStarted
    }
    appLaunched = true
    if (previousIdentities) {
      // Only the first observation after an action carries "new" markers.
      observation = markNewCandidates(observation, previousIdentities)
      previousIdentities = undefined
    }
    emit({ type: "observed", step: decisions, status: "running", payload: { app: observation.app, window: observation.title, surface: observation.surface, candidateCount: observation.candidates.length, complete: observation.complete } })

    if (pendingDrill && observation.root) {
      if (candidateSignature(observation) === pendingDrill.signature) {
        // The drill revealed exactly the candidates the full window already
        // offered: inspecting deeper cannot help. Widen deterministically and
        // stop offering this region for inspection — without spending another
        // Jev decision on it.
        drillExhausted.add(pendingDrill.key)
        root = undefined
        repeatedDrillKey = undefined
        allowPressEnter = false
        consecutiveWaits = 0
        unchangedMutations = 0
        trace.push({ step: decisions, stateId: observation.fingerprint, note: "DRILL revealed no new candidates; widened to the window and excluded that region from further inspection" })
        history.push("DRILL revealed no new candidates; returned to the whole window; that region is excluded from further inspection, choose an action on an observed target")
      }
      pendingDrill = undefined
    }

    if (pendingMutation) {
      const changed = pendingMutation.before !== observation.fingerprint
      pendingMutation.entry.changed = changed
      // Structured evidence for Jev: what the delivered action actually did to
      // the interface, not just whether the fingerprint moved.
      const diffNote = describeDiff(diffTrees(pendingMutation.beforeTree, observation.tree))
      history[pendingMutation.historyIndex] += changed
        ? `; diff: ${diffNote}`
        : `; no accessibility change (${diffNote})`
      history[pendingMutation.historyIndex] += `; changed=${changed}`
      unchangedMutations = changed ? 0 : unchangedMutations + 1
      pendingMutation = undefined
      if (unchangedMutations >= 3) return finish("blocked", observation, "Three delivered actions produced no observable accessibility change")
    }
    if (actions >= input.budget.maxActions) return finish("max_actions", observation)
    if (decisions >= input.budget.maxDecisions) return finish("max_decisions", observation)

    const slots = input.textSlots ?? []
    const redact = (text: string) => redactLocalSlots(text, slots)
    const decisionStarted = performance.now()
    let decision: DesktopDecision
    try {
      const current = observation
      // Read-only tasks (inspect and report) never see mutation candidates:
      // the model cannot click, type, submit or send, so a mis-chosen row
      // cannot change application state.
      const eligible = current.candidates.filter(candidate =>
        !(candidate.speculative && (quarantined.has(targetKey(candidate)) || quarantined.has(targetKey(candidate, true))))
        && !verifiedFailures.has(targetKey(candidate))
        && !(candidate.operation === "DRILL" && drillExhausted.has(targetKey(candidate))))
      const offered = input.readOnly
        ? eligible.filter(candidate => !isMutation(candidate.operation) && !isContextualMutation(candidate.operation) && candidate.operation !== "PRESS_ENTER")
        : eligible
      // Affordance Memory replay: the next remembered step, matched by
      // observed identity against what is offered right now. A miss hands
      // control back to Jev for the rest of the task (self-heal).
      let replayed: DesktopDecision | undefined
      if (replayPlan && replayIndex < replayPlan.length) {
        let resolved = resolveStep(replayPlan, replayIndex, offered, slots)
        if (resolved.skip) {
          replayIndex++
          resolved = resolveStep(replayPlan, replayIndex, offered, slots)
        }
        const step = replayPlan[replayIndex]
        const match = resolved.candidate
        if (match) {
          // An inserted SCROLL_TO does not consume the remembered step.
          if (!(match.operation === "SCROLL_TO" && step.operation !== "SCROLL_TO")) replayIndex++
          replayMisses = 0
          replayed = { operation: match.operation, candidateId: match.id, confidence: 1, model: "affordance-memory", latencyMs: 0, probabilities: { [match.id]: 1 }, usage: { inputTokens: 0, outputTokens: 0 }, ...(typeof step.risk === "number" ? { risk: step.risk } : {}) }
        } else if (replayIndex > 0 && replayMisses < REPLAY_WAIT_POLLS && !root) {
          // The remembered target may still be loading (search results,
          // navigation). Re-observe briefly before giving up on replay.
          replayMisses++
          await delay(Math.min(REPLAY_WAIT_POLL_MS, remaining()), undefined, { signal })
          continue
        } else {
          await abandonReplay(`step ${replayIndex + 1} (${step.operation}) has no unique matching target`)
        }
      }
      const knownRisks: Record<string, number> = {}
      for (const candidate of offered) {
        const cached = riskCache.get(targetKey(candidate))
        if (typeof cached === "number") knownRisks[candidate.id] = cached
      }
      const askJev = () => {
        metrics.jevCalls++
        return decide(
          redact(input.goal),
          offered.filter(candidate => !(candidate.operation === "ACTIVATE" && !candidate.ref)).map(candidate => ({
            ...candidate,
            description: redact(candidate.description),
            criteria: candidate.criteria && Object.fromEntries(Object.entries(candidate.criteria).map(([key, value]) => [key, redact(value)])),
          })),
          redact(current.context),
          history.map(redact),
          signal,
          { knownRisks },
        )
      }
      if (replayed) {
        decision = replayed
      } else {
        try {
          decision = await askJev()
        } catch (error) {
          if (signal?.aborted || !isRetryableJevError(error)) throw error
          // One retry for transport failures only. Invalid requests such as a
          // context overflow are deterministic and must surface immediately.
          await delay(Math.min(1_000, remaining()), undefined, { signal })
          decision = await askJev()
        }
      }
    } catch (error) {
      return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
    } finally {
      metrics.decisionMs += performance.now() - decisionStarted
    }
    decisions++
    const stepStarted = performance.now()
    const fromMemory = decision.model === "affordance-memory"
    if (fromMemory) metrics.replayedSteps++
    metrics.inputTokens += decision.usage.inputTokens
    metrics.outputTokens += decision.usage.outputTokens
    for (const [id, value] of Object.entries(decision.risks ?? {})) {
      const risky = observation.candidates.find(item => item.id === id)
      if (risky) riskCache.set(targetKey(risky), value)
    }
    let candidate = observation.candidates.find(item => item.id === decision.candidateId)
    if (!candidate || candidate.operation !== decision.operation) return finish("error", observation, "Jev selected a candidate outside the current observation")
    if (typeof decision.risk === "number") riskCache.set(targetKey(candidate), decision.risk)
    const entry: GuiTaskTrace = { step: decisions, stateId: observation.fingerprint, operation: decision.operation, candidateId: candidate.id, candidate: candidate.description, confidence: decision.confidence, source: fromMemory ? "memory" : "jev" }
    trace.push(entry)
    emit({ type: "decided", step: decisions, status: "running", payload: { operation: decision.operation, candidate: candidate.description, confidence: decision.confidence, model: decision.model, latencyMs: decision.latencyMs } })

    if (decision.operation === "DONE") {
      if (root) {
        // A drilled leaf cannot prove a multi-part goal (such as recipient
        // and sent message) on its own. Re-check the whole window before
        // accepting completion; no desktop action or extra Jev target is
        // invented by this deterministic verification step.
        root = undefined
        repeatedDrillKey = undefined
        entry.outcome = "completion_requires_full_window"
        history.push("DONE in a drilled region; verify the whole window before completion")
        continue
      }
      const undelivered = (input.textSlots ?? []).filter(slot => !usedSlotIds.has(slot.id))
      if (undelivered.length > 0) {
        // Self-consistency check (TypeSafe cookbook): a caller-prepared text
        // that was never entered anywhere contradicts most goals. Re-ask Jev
        // with that fact made explicit; accept DONE only if it repeats it.
        const reminder = [...history, `WARNING: prepared text slots ${undelivered.map(slot => slot.id).join(", ")} were never delivered to any field; the goal mentions them.`]
        metrics.jevCalls++
        const recheck = await decide(
          redact(input.goal),
          observation.candidates.filter(candidate => !(candidate.operation === "ACTIVATE" && !candidate.ref)).map(candidate => ({
            ...candidate,
            description: redact(candidate.description),
            criteria: candidate.criteria && Object.fromEntries(Object.entries(candidate.criteria).map(([key, value]) => [key, redact(value)])),
          })),
          redact(observation.context),
          reminder.map(redact),
          signal,
        )
        decisions++
        metrics.inputTokens += recheck.usage.inputTokens
        metrics.outputTokens += recheck.usage.outputTokens
        if (recheck.operation !== "DONE") {
          decision = recheck
          history.push(`DONE rejected on recheck: prepared text ${undelivered.map(slot => slot.id).join(", ")} was never entered; continue the task`)
          entry.outcome = "done_rejected_on_recheck"
          trace.push({ step: decisions, stateId: observation.fingerprint, operation: recheck.operation, candidateId: recheck.candidateId, candidate: candidate.description, confidence: recheck.confidence })
          // Fall through to execute the recheck decision below.
        } else {
          goalVerified = true
          entry.outcome = "goal_verified_by_jev_recheck"
          return finish("done", observation)
        }
      } else {
        goalVerified = true
        entry.outcome = "goal_verified_by_jev"
        return finish("done", observation)
      }
    }
    if (decision.operation !== "DONE") {
      // Re-asked decision replaces the original; re-resolve its candidate.
      const recheckCandidate = observation.candidates.find(item => item.id === decision.candidateId && item.operation === decision.operation)
      if (!recheckCandidate) return finish("error", observation, "Jev recheck selected a candidate outside the current observation")
      candidate = recheckCandidate
    }
    if (decision.operation === "BLOCKED") return finish("blocked", observation, "Jev found no safe supplied action that can advance the goal")
    if (["SET_VALUE", "TYPE_TEXT"].includes(decision.operation) && !findSlot(input, candidate.slotId)) return finish("needs_text", observation, `No local text is available for ${candidate.slotId ?? "the selected field"}`)
    // Jev chooses ordinary actions regardless of its numeric confidence. Risk
    // assessment is independent of confidence: even a confident click may send
    // a message, purchase something, or delete data.
    if (isMutation(candidate.operation)) {
      const riskStarted = performance.now()
      try {
        // The fan-out decision already answered the undo-risk question for
        // this exact target; only fall back to a separate call when absent.
        const cachedRisk = typeof decision.risk === "number" ? decision.risk : riskCache.get(targetKey(candidate))
        const risk = typeof cachedRisk === "number"
          ? { probability: cachedRisk, usage: { inputTokens: 0, outputTokens: 0 } }
          : (metrics.jevCalls++, await assessRisk(redact(input.goal), decision.operation, redact(candidate.description), signal))
        riskCache.set(targetKey(candidate), risk.probability)
        metrics.inputTokens += risk.usage.inputTokens
        metrics.outputTokens += risk.usage.outputTokens
        if (risk.probability >= 0.5) {
          const summary = `${input.target.app}：${confirmationLabel(decision.operation)} ${candidate.description.split(";")[0]}\n目标：${input.goal}`
          const approved = confirm ? await confirm(summary).catch(() => false) : false
          if (!approved) return finish("needs_review", observation, `The selected action may be hard to undo (risk=${risk.probability.toFixed(2)}) and requires user confirmation`)
          entry.note = `user confirmed irreversible step (risk=${risk.probability.toFixed(2)})`
        }
      } catch (error) {
        return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
      } finally {
        metrics.decisionMs += performance.now() - riskStarted
      }
    }

    if (decision.operation === "DRILL") {
      const drillKey = `${candidate.ref ?? ""}:${observation.fingerprint}`
      const drillCount = (drillCounts.get(candidate.description) ?? 0) + 1
      drillCounts.set(candidate.description, drillCount)
      if (drillCount >= 3) {
        // Re-entering the same region cannot reveal anything new; tell Jev
        // explicitly so it picks an action instead of looping on inspection.
        drillExhausted.add(targetKey(candidate))
        root = undefined
        repeatedDrillKey = undefined
        entry.outcome = "drill_exhausted"
        history.push(`DRILL ${candidate.description} already inspected ${drillCount} times with nothing new; choose an action on an observed target instead of inspecting again`)
        if (drillCount >= 5) return finish("blocked", observation, "Jev kept inspecting the same region without choosing an action")
        continue
      }
      if (repeatedDrillKey === drillKey) {
        root = undefined
        repeatedDrillKey = undefined
        allowPressEnter = false
        entry.outcome = "repeated_region_widened"
        history.push(`DRILL repeated for ${candidate.description}; widened to the window`)
        continue
      }
      repeatedDrillKey = drillKey
      pendingDrill = { key: targetKey(candidate), signature: candidateSignature(observation) }
      root = candidate.ref
      allowPressEnter = false
      consecutiveWaits = 0
      unchangedMutations = 0
      entry.outcome = "observed_deeper"
      history.push(`DRILL ${candidate.description}`)
      learnedSteps.push({ operation: "DRILL", identity: memoryIdentity(candidate, slots) })
      learnedLabels.push(undefined)
      continue
    }
    if (decision.operation === "WIDEN") {
      root = undefined
      repeatedDrillKey = undefined
      allowPressEnter = false
      consecutiveWaits = 0
      unchangedMutations = 0
      entry.outcome = "observed_window"
      history.push("WIDEN")
      learnedSteps.push({ operation: "WIDEN", identity: memoryIdentity(candidate, slots) })
      learnedLabels.push(undefined)
      continue
    }
    if (decision.operation === "WAIT") {
      consecutiveWaits++
      unchangedMutations = 0
      if (consecutiveWaits >= 3) return finish("blocked", observation, "Jev waited three consecutive turns without selecting a progress operation")
      await delay(Math.min(250, remaining()), undefined, { signal })
      entry.outcome = "waited"
      history.push("WAIT")
      continue
    }

    const actionStarted = performance.now()
    try {
      const mutating = isMutation(candidate.operation) || isContextualMutation(candidate.operation)
      const identitiesBefore = new Set(observation.candidates.filter(item => item.ref).map(item => targetKey(item, true)))
      const executed = await executeCandidateDetailed(client, launched.app || input.target.app, candidate, input, remaining(), signal, mutating ? Math.min(EVENT_SETTLE_TIMEOUT_MS, remaining()) : undefined)
      const outcome = executed.delivery
      actions++
      consecutiveWaits = 0
      entry.outcome = outcome
      lastAction = { operation: decision.operation, delivery: outcome }
      if (candidate.slotId) usedSlotIds.add(candidate.slotId)
      consecutiveFailures = 0
      allowPressEnter = ["SET_VALUE", "TYPE_TEXT", "FOCUS"].includes(decision.operation)
      if (mutating) {
        const settleStarted = performance.now()
        const observeSettled = () => observe(client, { app: launched.app || input.target.app, goal: input.goal, textSlots: input.textSlots ?? [], usedSlotIds, allowPressEnter, skipMedia: true }, { timeoutMs: remaining(), signal })
        const before = observation.treeFingerprint ?? observation.fingerprint
        const report = executed.settle
        if (report?.supported) {
          // Event-driven: the worker already blocked until the app posted
          // accessibility notifications and went quiet. Observe once.
          metrics.settleEvents += report.events ?? 0
          entry.note = entry.note ?? (report.events ? `settled after ${report.events} AX events (${(report.notifications ?? []).join(",")}) in ${report.ms}ms` : `no AX events within ${report.ms}ms`)
          try {
            prefetched = await observeSettled()
          } catch {
            prefetched = undefined
          }
        } else {
          // Polling fallback: re-observe until the tree differs from the
          // pre-action state (or a short ceiling passes). Media is not read
          // inside the loop; it is attached once below.
          const settleDeadline = Date.now() + Math.min(SETTLE_CEILING_MS, remaining())
          for (;;) {
            await delay(SETTLE_POLL_MS, undefined, { signal })
            try {
              const next = await observeSettled()
              prefetched = next
              if ((next.treeFingerprint ?? next.fingerprint) !== before || Date.now() >= settleDeadline) break
            } catch {
              prefetched = undefined
              break
            }
          }
        }
        // Busy-aware settle: the app acknowledged the action but is still
        // working (progress/busy indicator present, or an autocomplete field
        // was typed into and its suggestions have not arrived yet). Keep
        // observing, bounded, instead of spending a Jev WAIT turn on it.
        if (prefetched) {
          const busyDeadline = Date.now() + Math.min(BUSY_CEILING_MS, remaining())
          const awaitingSuggestions = candidate.operation === "SET_VALUE" || candidate.operation === "TYPE_TEXT"
            ? isAutocompleteField(candidate) && !hasNewPopupList(observation.tree, prefetched.tree)
            : false
          let suggestionDeadline = awaitingSuggestions ? Date.now() + SUGGESTION_WAIT_MS : 0
          while (prefetched && Date.now() < busyDeadline && (isBusy(prefetched.tree) || Date.now() < suggestionDeadline)) {
            await delay(BUSY_POLL_MS, undefined, { signal })
            try {
              prefetched = await observeSettled()
            } catch {
              prefetched = undefined
              break
            }
            if (suggestionDeadline && prefetched && hasNewPopupList(observation.tree, prefetched.tree)) suggestionDeadline = 0
          }
        }
        if (prefetched?.mediaSkipped) prefetched = attachMedia(prefetched, await readMediaFact(client, { timeoutMs: Math.min(remaining(), 5_000), signal }))
        metrics.settleMs += performance.now() - settleStarted
        previousIdentities = identitiesBefore
      }
      // Delivery is a code decision, not a rival candidate. When the semantic
      // accessibility press left the tree exactly as it was, give the same
      // target one exact-window pointer delivery before spending a Jev turn on
      // it: a separate near-identical candidate is the option-level duplicate
      // that makes a choice look uncertain.
      if (prefetched && candidate.operation === "CLICK" && !candidate.headed && !candidate.speculative
        && actions < input.budget.maxActions && prefetched.fingerprint === observation.fingerprint) {
        try {
          const retry = await executeCandidateDetailed(client, launched.app || input.target.app, { ...candidate, headed: true }, input, remaining(), signal, Math.min(EVENT_SETTLE_TIMEOUT_MS, remaining()))
          actions++
          const note = retry.settle?.events ? `${retry.settle.events} AX events` : `no AX events within ${retry.settle?.ms ?? 0}ms`
          entry.note = `${entry.note ? `${entry.note}; ` : ""}semantic press changed nothing; retried as pointer delivery (${note})`
          try {
            prefetched = await observe(client, { app: launched.app || input.target.app, goal: input.goal, textSlots: input.textSlots ?? [], usedSlotIds, allowPressEnter, skipMedia: true }, { timeoutMs: remaining(), signal })
          } catch {
            prefetched = undefined
          }
        } catch (error) {
          entry.note = `${entry.note ? `${entry.note}; ` : ""}semantic press changed nothing; pointer delivery failed: ${safeError(error)}`
        }
      }
      // Verify inferred (speculative) actions against their expectations
      // right away, using the settled successor observation. A wrong guess is
      // undone and its target excluded so the next turn takes another route.
      const settled = prefetched
      let verdict: "side_effect" | "no_effect" | undefined
      let verdictDetail: string | undefined
      if (settled) {
        if (candidate.speculative && candidate.expect?.includes("no_overlay") && observation.surface === "window" && settled.surface !== "window") verdict = "side_effect"
        else if (candidate.speculative && settled.fingerprint === observation.fingerprint) verdict = "no_effect"
        else if (["SET_VALUE", "TYPE_TEXT"].includes(candidate.operation) && outcome !== "delivered_verified") {
          // value_equals: after delivery the field itself must hold the
          // prepared text; a driver-verified delivery already proved this.
          const slot = findSlot(input, candidate.slotId)
          const field = slot?.value ? findNodeByIdentity(settled.tree, candidate) : undefined
          if (field && typeof field.value === "string" && slot && !field.value.includes(slot.value)) {
            verdict = "no_effect"
            verdictDetail = "the observed field value does not contain the prepared text"
          } else if (field && typeof field.value === "string" && slot) {
            verdictDetail = `verified: the field now holds the prepared ${slot.id} text`
          }
        } else if (candidate.operation === "CLEAR") {
          const field = findNodeByIdentity(settled.tree, candidate)
          if (field && typeof field.value === "string" && field.value.length > 0) {
            verdict = "no_effect"
            verdictDetail = "the field still holds text after clearing"
          }
        }
      }
      if (verdict) {
        // A side effect disqualifies every inferred action on that target;
        // no effect only disqualifies the attempted operation (a single click
        // may select a row that a double-click would open).
        quarantined.add(targetKey(candidate, verdict === "side_effect"))
        if (verdict === "no_effect" && ["SET_VALUE", "TYPE_TEXT", "CLEAR"].includes(candidate.operation)) verifiedFailures.add(targetKey(candidate))
        entry.verdict = verdict
        if (verdict === "side_effect") {
          try {
            await executeCandidate(client, launched.app || input.target.app, { id: "undo", operation: "DISMISS", description: "undo unexpected overlay" }, input, remaining(), signal)
            entry.note = `unexpected ${settled!.surface} opened; dismissed with Escape`
          } catch (error) {
            entry.note = `unexpected ${settled!.surface} opened; Escape failed: ${safeError(error)}`
          }
          prefetched = undefined
        }
        history.push(`${decision.operation} ${candidate.description}: ${outcome}; verdict=${verdict}${verdictDetail ? ` (${verdictDetail})` : ""}${verdict === "side_effect" ? ` (opened an unrelated ${settled!.surface}; undone with Escape)` : ""}; this target is excluded, choose a different target or route`)
        pendingMutation = undefined
        unchangedMutations = verdict === "no_effect" ? unchangedMutations + 1 : 0
        emit({ type: "acted", step: decisions, status: "running", payload: { operation: decision.operation, candidate: candidate.description, outcome, verdict } })
        root = undefined
        repeatedDrillKey = undefined
        staleRetries = 0
        if (fromMemory) await abandonReplay(`remembered ${decision.operation} produced verdict=${verdict}`)
        entry.ms = Math.round(performance.now() - stepStarted)
        if (unchangedMutations >= 3) return finish("blocked", settled, "Three delivered actions produced no observable accessibility change")
        continue
      }
      if (isReplayableOperation(candidate.operation)) {
        const learnedRisk = riskCache.get(targetKey(candidate))
        learnedSteps.push({ operation: candidate.operation, identity: memoryIdentity(candidate, slots), ...(candidate.slotId ? { slotId: candidate.slotId } : {}), ...(typeof learnedRisk === "number" ? { risk: learnedRisk } : {}) })
        learnedLabels.push(candidate.criteria?.sibling ? /"([^"]+)"/.exec(candidate.criteria.what ?? "")?.[1] : undefined)
      }
      entry.ms = Math.round(performance.now() - stepStarted)
      const historyIndex = history.push(`${decision.operation} ${candidate.description}: ${outcome}${!verdict && verdictDetail ? `; ${verdictDetail}` : ""}`) - 1
      if (mutating && isMutation(candidate.operation)) {
        mutationKeys.push(targetKey(candidate, true))
        const cycle = repeatedCycle(mutationKeys)
        if (cycle && cycle.repeats >= 3) {
          entry.ms = Math.round(performance.now() - stepStarted)
          return finish("blocked", prefetched ?? observation, `The same ${cycle.length}-step action sequence repeated ${cycle.repeats} times; stopping to avoid looping on application state`)
        }
        if (cycle && cycle.repeats === 2) history[historyIndex] += `; WARNING: this completes the same ${cycle.length}-step action sequence a second time. Its effect is already in the observation; do not start it again. Choose DONE if the goal is satisfied, otherwise a different target`
      }
      // Predicted completion + local evidence: finish without a separate DONE
      // round trip. Every condition must hold; otherwise the normal loop asks.
      const predicted = typeof decision.completesGoal === "number" ? decision.completesGoal : fromMemory && replayPlan && replayIndex >= replayPlan.length ? replayCompletion : undefined
      if (typeof predicted === "number" && predicted >= COMPLETION_THRESHOLD && prefetched && mutating && isMutation(candidate.operation)) {
        const evidence = completionEvidence(observation, prefetched, candidate, outcome, verdictDetail)
        const undelivered = (input.textSlots ?? []).filter(slot => !usedSlotIds.has(slot.id))
        const overlayOpened = prefetched.surface !== "window" && observation.surface === "window"
        if (evidence && undelivered.length === 0 && !overlayOpened) {
          entry.note = `${entry.note ? `${entry.note}; ` : ""}completion predicted (p=${predicted.toFixed(2)}) and confirmed by ${evidence}`
          goalVerified = true
          entry.outcome = `${outcome}; goal_verified_by_prediction`
          learnedCompletion = predicted
          return finish("done", prefetched)
        }
      }
      // Window activation/focus is validated by the next foreground-gated
      // action, not by an AX fingerprint change. Activating a window can leave
      // the accessibility tree byte-for-byte identical.
      if (isMutation(candidate.operation) || isContextualMutation(candidate.operation)) pendingMutation = { before: observation.fingerprint, beforeTree: observation.tree, entry, historyIndex }
      else pendingMutation = undefined
      emit({ type: "acted", step: decisions, status: "running", payload: { operation: decision.operation, candidate: candidate.description, outcome } })
      root = undefined
      repeatedDrillKey = undefined
      staleRetries = 0
    } catch (error) {
      entry.note = safeError(error)
      if (fromMemory) await abandonReplay(`remembered ${decision.operation} failed: ${safeError(error)}`)
      if (error instanceof DesktopCommandError) lastAction = { operation: decision.operation, delivery: error.detail.disposition?.delivery }
      if (error instanceof DesktopCommandError && error.safeToRetry && error.detail.code === "STALE_REF" && staleRetries < 1) {
        staleRetries++
        root = undefined
        history.push(`${decision.operation} stale before delivery; refreshed without replaying the old ref`)
        continue
      }
      actions++
      // A failed action the driver proved was not delivered (retry safe,
      // nothing happened on screen) is candidate-specific, not task-terminal:
      // record the failure and let Jev choose a different path next turn.
      // Only delivery-uncertain failures stop the task for review.
      if (!(error instanceof DesktopCommandError)) return finish("error", observation, safeError(error))
      if (!error.safeToRetry) return finish("needs_review", observation, safeError(error))
      consecutiveFailures++
      if (consecutiveFailures >= 3) return finish("blocked", observation, `Three consecutive actions failed without delivery; last: ${safeError(error)}`)
      history.push(`${decision.operation} failed before delivery (${safeError(error)}); choose a different candidate`)
      continue
    } finally {
      metrics.actionMs += performance.now() - actionStarted
    }
  }
}

type SettleReport = { supported?: boolean; changed?: boolean; events?: number; notifications?: string[]; ms?: number }

async function executeCandidate(
  client: DesktopDriver,
  app: string,
  candidate: DesktopCandidate,
  input: GuiTaskInput,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return (await executeCandidateDetailed(client, app, candidate, input, timeoutMs, signal)).delivery
}

/** Execute one candidate. With `settleMs` (xa11y only) the worker arms an
 * AXObserver before dispatch and blocks until the app settles; its report is
 * returned alongside the delivery disposition. */
async function executeCandidateDetailed(
  client: DesktopDriver,
  app: string,
  candidate: DesktopCandidate,
  input: GuiTaskInput,
  timeoutMs: number,
  signal?: AbortSignal,
  settleMs?: number,
): Promise<{ delivery: string; settle?: SettleReport }> {
  const settleArgs = settleMs ? ["--settle-timeout-ms", String(Math.round(settleMs))] : []
  const baseClient = client
  let settle: SettleReport | undefined
  const wrapped: DesktopDriver = {
    dispose: () => client.dispose(),
    async run<T>(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }) {
      const isAction = !["activate-app", "snapshot", "launch", "now-playing", "menubar"].includes(args[0] === "--headed" ? args[1] : args[0])
      const envelope = await baseClient.run<T>(isAction ? [...args, ...settleArgs] : args, isAction && settleArgs.length ? { ...options, timeoutMs: (options?.timeoutMs ?? timeoutMs) + (settleMs ?? 0) + 5_000 } : options)
      const report = (envelope.data as { settle?: SettleReport } | undefined)?.settle
      if (isAction && report && typeof report === "object") settle = report
      return envelope
    },
  }
  // Any mutation can change menu enabled states; never serve a stale menu.
  if (candidate.operation !== "DRILL" && candidate.operation !== "WIDEN") invalidateMenuCache(client)
  const delivery = await executeCandidateRaw(wrapped, app, candidate, input, timeoutMs, signal)
  return { delivery, ...(settle ? { settle } : {}) }
}

async function executeCandidateRaw(
  client: DesktopDriver,
  app: string,
  candidate: DesktopCandidate,
  input: GuiTaskInput,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const common = { timeoutMs, signal }
  if (needsForeground(candidate)) {
    // Deterministic precondition: the Rust worker rejects pointer/keyboard
    // delivery unless the target owns the foreground. Activate the app
    // (idempotent, no snapshot ref consumed) right before delivery.
    await client.run(["activate-app", "--app", app, "--timeout-ms", String(timeoutMs)], common)
  }
  // Defense in depth: a read-only task must never deliver a mutating step,
  // even if a stale candidate survived into the current observation.
  if (input.readOnly && (isMutation(candidate.operation) || isContextualMutation(candidate.operation) || candidate.operation === "PRESS_ENTER")) {
    throw new Error(`read-only task refused ${candidate.operation}`)
  }
  if (candidate.operation === "PRESS_ENTER") {
    const result = await client.run<Record<string, unknown>>(["press", "return", "--app", app], common)
    return delivery(result)
  }
  if (candidate.operation === "MENU_ITEM") {
    if (!candidate.menuPath?.length) throw new Error("MENU_ITEM requires an observed menu path")
    return delivery(await client.run<Record<string, unknown>>(["menu-press", JSON.stringify(candidate.menuPath), "--app", app, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "DISMISS") {
    return delivery(await client.run<Record<string, unknown>>(["press", "escape", "--app", app], common))
  }
  if (candidate.operation === "RIGHT_CLICK") {
    if (!candidate.ref) throw new Error("RIGHT_CLICK requires an observed element ref")
    return delivery(await client.run(["right-click", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "CLEAR") {
    if (!candidate.ref) throw new Error("CLEAR requires an observed element ref")
    return delivery(await client.run(["clear", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "ACTIVATE") {
    if (candidate.ref) return delivery(await client.run(["activate", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
    return delivery(await client.run(["activate-app", "--app", app, "--timeout-ms", String(timeoutMs)], common))
  }
  if (!candidate.ref) throw new Error(`${candidate.operation} requires an observed element ref`)
  if (candidate.operation === "FOCUS") {
    return delivery(await client.run(["focus", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  // The worker's `press` is the semantic AX action; `click`/`double-click`
  // are physical pointer delivery at the re-identified element's bounds.
  if (candidate.operation === "CLICK") {
    return delivery(await client.run([candidate.headed ? "click" : "press", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "DOUBLE_CLICK") {
    return delivery(await client.run(["double-click", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "SCROLL_TO") return delivery(await client.run(["scroll-to", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  if (candidate.operation === "CHECK") return delivery(await client.run(["check", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  if (candidate.operation === "UNCHECK") return delivery(await client.run(["uncheck", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  if (candidate.operation === "EXPAND") return delivery(await client.run(["expand", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  if (candidate.operation === "COLLAPSE") return delivery(await client.run(["collapse", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  if (candidate.operation === "SCROLL_DOWN" || candidate.operation === "SCROLL_UP") return delivery(await client.run(["scroll", candidate.ref, "--direction", candidate.operation === "SCROLL_DOWN" ? "down" : "up", "--amount", "3", "--timeout-ms", String(timeoutMs)], common))
  if (["SET_VALUE", "TYPE_TEXT"].includes(candidate.operation)) {
    const slot = findSlot(input, candidate.slotId)
    if (!slot) throw new Error("Selected text candidate has no prepared local value")
    const command = candidate.operation === "SET_VALUE" ? "set-value" : "type"
    const args = [command, candidate.ref, slot.value, "--timeout-ms", String(timeoutMs)]
    if (candidate.headed) args.unshift("--headed")
    return delivery(await client.run(args, common))
  }
  throw new Error(`Unsupported desktop operation: ${candidate.operation}`)
}

function delivery(envelope: { data?: Record<string, unknown> }): string {
  const disposition = envelope.data?.disposition
  if (disposition && typeof disposition === "object" && "delivery" in disposition) return String((disposition as { delivery?: unknown }).delivery ?? "delivered")
  return "delivered"
}

function confirmationLabel(operation: DesktopCandidate["operation"]): string {
  const labels: Partial<Record<DesktopCandidate["operation"], string>> = { PRESS_ENTER: "按回车提交", CLICK: "点击", DOUBLE_CLICK: "双击", RIGHT_CLICK: "右键打开菜单", SET_VALUE: "写入", TYPE_TEXT: "输入", CLEAR: "清空字段" }
  return labels[operation] ?? operation
}

function needsForeground(candidate: DesktopCandidate): boolean {
  if (candidate.operation === "ACTIVATE" && !candidate.ref) return false
  if (["DRILL", "WIDEN", "WAIT", "DONE", "BLOCKED"].includes(candidate.operation)) return false
  // Background-safe semantic AX operations (see ax.rs dispatch_observed).
  if (!candidate.headed && ["CLICK", "SET_VALUE", "TYPE_TEXT", "RIGHT_CLICK", "CLEAR", "SCROLL_TO", "MENU_ITEM"].includes(candidate.operation)) return false
  return true
}

function findSlot(input: GuiTaskInput, id: string | undefined) {
  return input.textSlots?.find(slot => slot.id === id)
}

function isMutation(operation: DesktopCandidate["operation"]): boolean {
  return !["ACTIVATE", "FOCUS", "DRILL", "WIDEN", "WAIT", "DONE", "BLOCKED", "SCROLL_TO", "SCROLL_DOWN", "SCROLL_UP", "DISMISS", "RIGHT_CLICK"].includes(operation)
}

/** Changes visible UI state (opens a context menu) without being destructive:
 * excluded from risk confirmation and undo-risk fan-out, but still settled,
 * diffed and forbidden in read-only tasks. */
function isContextualMutation(operation: DesktopCandidate["operation"]): boolean {
  return operation === "RIGHT_CLICK"
}

/** Observed identity of a candidate's target, stable across snapshots.
 * `state` and `holds` are excluded: both change as a result of the very
 * action being judged, so they cannot participate in a stable identity. */
function targetKey(candidate: DesktopCandidate, anyOperation = false): string {
  const key = candidate.identity
    ? JSON.stringify(candidate.identity)
    : stableCriteria(candidate.criteria) ?? candidate.description.split(";")[0]
  return `${anyOperation ? "*" : candidate.operation}:${key}`
}

/** Stable comparison of what a region offers, used to detect a drill that
 * revealed nothing new. Descriptions are AX-derived and layout-dependent, so
 * equality is best-effort: a mismatch just falls back to the normal flow. */
function candidateSignature(observation: DesktopObservation): string {
  return observation.candidates.map(candidate => `${candidate.operation}:${candidate.description}`).sort().join("|")
}

const BUSY_ROLES = new Set(["progress_bar", "busy_indicator", "progress_indicator"])

/** An indeterminate progress/busy indicator is visible (role-based only). */
function isBusy(root: DesktopNode): boolean {
  const queue = [root]
  for (let index = 0; index < queue.length && index < 4_000; index++) {
    const node = queue[index]
    if (BUSY_ROLES.has(node.role) && !(node.states ?? []).includes("hidden") && (node.value === undefined || node.value === "")) return true
    queue.push(...(node.children ?? []))
  }
  return false
}

function isAutocompleteField(candidate: DesktopCandidate): boolean {
  return /^combo_?box\b/i.test(candidate.criteria?.what ?? candidate.description)
}

/** A list/menu/listbox that did not exist before appeared (suggestions). */
function hasNewPopupList(before: DesktopNode, after: DesktopNode): boolean {
  const count = (root: DesktopNode) => {
    let total = 0
    const queue = [root]
    for (let index = 0; index < queue.length; index++) {
      if (/^(list|menu|list_box|listbox)$/.test(queue[index].role)) total++
      queue.push(...(queue[index].children ?? []))
    }
    return total
  }
  return count(after) > count(before)
}

/** Local, application-agnostic proof that a delivered action took effect:
 * a driver/field value readback, or an observed interface change that is
 * not a failure indicator. Returns a short description, or undefined. */
function completionEvidence(before: DesktopObservation, after: DesktopObservation, candidate: DesktopCandidate, outcome: string, verdictDetail?: string): string | undefined {
  if (verdictDetail?.startsWith("verified:")) return "field value readback"
  if (outcome === "delivered_verified" && ["SET_VALUE", "TYPE_TEXT"].includes(candidate.operation)) return "driver value readback"
  const beforeTree = before.treeFingerprint ?? before.fingerprint
  const afterTree = after.treeFingerprint ?? after.fingerprint
  if (beforeTree === afterTree && before.media === after.media) return undefined
  const diff = diffTrees(before.tree, after.tree)
  // A new alert or error text means the action did not simply succeed.
  if (diff.added.some(item => /^(alert|dialog|sheet)\b/.test(item) || /error|failed|错误|失败|无法/i.test(item))) return undefined
  if (before.media !== after.media && after.media) return "media state change"
  return `interface change (${describeDiff(diff).slice(0, 120)})`
}

/** A trailing sequence of 2-3 mutation targets repeated back to back.
 * Single-target repeats (scrolling, "next track") are legitimate and ignored. */
function repeatedCycle(keys: readonly string[]): { length: number; repeats: number } | undefined {
  for (let length = 2; length <= 3; length++) {
    if (keys.length < length * 2) continue
    const tail = keys.slice(-length)
    if (new Set(tail).size < 2) continue
    let repeats = 1
    while (keys.length >= length * (repeats + 1) && keys.slice(-length * (repeats + 1), -length * repeats).every((key, i) => key === tail[i])) repeats++
    if (repeats >= 2) return { length, repeats }
  }
  return undefined
}

/** Mark candidates whose target did not exist before the last delivered
 * action. Only informative when a minority of the interface changed; a full
 * navigation marks nothing. */
function markNewCandidates(observation: DesktopObservation, before: ReadonlySet<string>): DesktopObservation {
  const targets = observation.candidates.filter(candidate => candidate.ref && candidate.criteria)
  const fresh = new Set(targets.filter(candidate => !before.has(targetKey(candidate, true))).map(candidate => candidate.id))
  if (fresh.size === 0 || fresh.size > MAX_NEW_MARKERS || fresh.size > targets.length * 0.6) return observation
  return {
    ...observation,
    candidates: observation.candidates.map(candidate => fresh.has(candidate.id)
      ? { ...candidate, criteria: { ...candidate.criteria, new: "appeared after the last action" } }
      : candidate),
  }
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

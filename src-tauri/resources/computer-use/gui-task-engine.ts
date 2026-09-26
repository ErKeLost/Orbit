import { setTimeout as delay } from "node:timers/promises"
import { AgentDesktopCommandError, type AgentDesktopClient, type LaunchData } from "./agent-desktop-client.ts"
import { resolveDesktopApp } from "./desktop-app-resolver.ts"
import { observeDesktop } from "./desktop-observation.ts"
import { assessDesktopRisk, decideDesktop, isRetryableJevError, redactLocalSlots } from "./jev.ts"
import { validateTaskInput, type DesktopCandidate, type DesktopDecision, type DesktopObservation, type GuiTaskEvent, type GuiTaskInput, type GuiTaskMetrics, type GuiTaskResult, type GuiTaskStatus, type GuiTaskTrace } from "./gui-task-contract.ts"

const CHROMIUM_RENDERER_SETTLE_MS = 2_000
const SETTLE_POLL_MS = 60
const SETTLE_CEILING_MS = 900

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
}: {
  input: GuiTaskInput
  client: AgentDesktopClient
  signal?: AbortSignal
  decide?: typeof decideDesktop
  observe?: typeof observeDesktop
  resolveApp?: typeof resolveDesktopApp
  assessRisk?: typeof assessDesktopRisk
  emit?: (event: GuiTaskEvent) => void
  confirm?: (summary: string) => Promise<boolean>
}): Promise<GuiTaskResult> {
  validateTaskInput(input)
  const startedAt = Date.now()
  const deadline = startedAt + input.budget.maxDurationMs
  const metrics: GuiTaskMetrics = { elapsedMs: 0, launchMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0 }
  const trace: GuiTaskTrace[] = []
  const history: string[] = []
  const usedSlotIds = new Set<string>()
  let root: string | undefined
  let repeatedDrillKey: string | undefined
  const drillCounts = new Map<string, number>()
  let allowPressEnter = false
  let consecutiveWaits = 0
  let unchangedMutations = 0
  let pendingMutation: { before: string; entry: GuiTaskTrace; historyIndex: number } | undefined
  let actions = 0
  let decisions = 0
  let appLaunched = false
  let goalVerified = false
  let lastAction: GuiTaskResult["lastAction"]

  const remaining = () => Math.max(1, deadline - Date.now())
  const finish = (status: GuiTaskStatus, observation?: DesktopObservation, note?: string): GuiTaskResult => {
    metrics.elapsedMs = Math.max(0, Date.now() - startedAt)
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
      launched = (await client.run<LaunchData>(["launch", client.backend === "xa11y" ? resolved.displayName : resolved.launchId, "--activate", "--timeout", String(remaining())], { timeoutMs: remaining(), signal })).data!
    } catch (error) {
      const expectedPid = error instanceof AgentDesktopCommandError && error.detail.code === "APP_UNRESPONSIVE"
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
    if (error instanceof AgentDesktopCommandError && error.detail.code === "PERM_DENIED") {
      return finish("blocked", undefined, safeError(error))
    }
    return finish(signal?.aborted ? "aborted" : "error", undefined, safeError(error))
  } finally {
    metrics.launchMs += performance.now() - launchStarted
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
        observation = prefetched && !root ? prefetched : await observeOnce(launched.window?.id)
        prefetched = undefined
      } catch (error) {
        if (error instanceof AgentDesktopCommandError && error.detail.code === "WINDOW_NOT_FOUND") {
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
              if (retryError instanceof AgentDesktopCommandError && retryError.detail.code === "WINDOW_NOT_FOUND") continue
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
      if (error instanceof AgentDesktopCommandError && error.detail.code === "PERM_DENIED") {
        return finish("blocked", observation, safeError(error))
      }
      return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
    } finally {
      metrics.observationMs += performance.now() - observationStarted
    }
    appLaunched = true
    emit({ type: "observed", step: decisions, status: "running", payload: { app: observation.app, window: observation.title, surface: observation.surface, candidateCount: observation.candidates.length, complete: observation.complete } })

    if (pendingMutation) {
      const changed = pendingMutation.before !== observation.fingerprint
      pendingMutation.entry.changed = changed
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
      const offered = input.readOnly
        ? current.candidates.filter(candidate => !isMutation(candidate.operation) && candidate.operation !== "PRESS_ENTER")
        : current.candidates
      const askJev = () => decide(
          redact(input.goal),
          offered.filter(candidate => !(candidate.operation === "ACTIVATE" && !candidate.ref)).map(candidate => ({
            ...candidate,
            description: redact(candidate.description),
            criteria: candidate.criteria && Object.fromEntries(Object.entries(candidate.criteria).map(([key, value]) => [key, redact(value)])),
          })),
          redact(current.context),
          history.map(redact),
          signal,
        )
        try {
          decision = await askJev()
        } catch (error) {
          if (signal?.aborted || !isRetryableJevError(error)) throw error
          // One retry for transport failures only. Invalid requests such as a
          // context overflow are deterministic and must surface immediately.
          await delay(Math.min(1_000, remaining()), undefined, { signal })
          decision = await askJev()
        }
    } catch (error) {
      return finish(signal?.aborted ? "aborted" : "error", observation, safeError(error))
    } finally {
      metrics.decisionMs += performance.now() - decisionStarted
    }
    decisions++
    metrics.inputTokens += decision.usage.inputTokens
    metrics.outputTokens += decision.usage.outputTokens
    let candidate = observation.candidates.find(item => item.id === decision.candidateId)
    if (!candidate || candidate.operation !== decision.operation) return finish("error", observation, "Jev selected a candidate outside the current observation")
    const entry: GuiTaskTrace = { step: decisions, stateId: observation.fingerprint, operation: decision.operation, candidateId: candidate.id, candidate: candidate.description, confidence: decision.confidence }
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
        const risk = typeof decision.risk === "number"
          ? { probability: decision.risk, usage: { inputTokens: 0, outputTokens: 0 } }
          : await assessRisk(redact(input.goal), decision.operation, redact(candidate.description), signal)
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
      root = candidate.ref
      allowPressEnter = false
      consecutiveWaits = 0
      unchangedMutations = 0
      entry.outcome = "observed_deeper"
      history.push(`DRILL ${candidate.description}`)
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
      const outcome = await executeCandidate(client, launched.app || input.target.app, candidate, input, remaining(), signal)
      actions++
      consecutiveWaits = 0
      entry.outcome = outcome
      lastAction = { operation: decision.operation, delivery: outcome }
      if (candidate.slotId) usedSlotIds.add(candidate.slotId)
      consecutiveFailures = 0
      allowPressEnter = ["SET_VALUE", "TYPE_TEXT", "FOCUS"].includes(decision.operation)
      if (isMutation(candidate.operation)) {
        // Auto-wait instead of a fixed sleep: re-observe until the tree
        // differs from the pre-action state (or a short ceiling passes).
        // Fast apps settle in one poll; slow renderers get up to the ceiling.
        const before = observation.fingerprint
        const settleDeadline = Date.now() + Math.min(SETTLE_CEILING_MS, remaining())
        for (;;) {
          await delay(SETTLE_POLL_MS, undefined, { signal })
          try {
            const next = await observe(client, { app: launched.app || input.target.app, goal: input.goal, textSlots: input.textSlots ?? [], usedSlotIds, allowPressEnter }, { timeoutMs: remaining(), signal })
            prefetched = next
            if (next.fingerprint !== before || Date.now() >= settleDeadline) break
          } catch {
            prefetched = undefined
            break
          }
        }
      }
      const historyIndex = history.push(`${decision.operation} ${candidate.description}: ${outcome}`) - 1
      // Window activation/focus is validated by the next foreground-gated
      // action, not by an AX fingerprint change. Activating a window can leave
      // the accessibility tree byte-for-byte identical.
      if (isMutation(candidate.operation)) pendingMutation = { before: observation.fingerprint, entry, historyIndex }
      else pendingMutation = undefined
      emit({ type: "acted", step: decisions, status: "running", payload: { operation: decision.operation, candidate: candidate.description, outcome } })
      root = undefined
      repeatedDrillKey = undefined
      staleRetries = 0
    } catch (error) {
      entry.note = safeError(error)
      if (error instanceof AgentDesktopCommandError) lastAction = { operation: decision.operation, delivery: error.detail.disposition?.delivery }
      if (error instanceof AgentDesktopCommandError && error.safeToRetry && error.detail.code === "STALE_REF" && staleRetries < 1) {
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
      if (!(error instanceof AgentDesktopCommandError)) return finish("error", observation, safeError(error))
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

async function executeCandidate(
  client: AgentDesktopClient,
  app: string,
  candidate: DesktopCandidate,
  input: GuiTaskInput,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const common = { timeoutMs, signal }
  if (client.backend === "xa11y" && needsForeground(candidate)) {
    // Deterministic precondition: the Rust worker rejects pointer/keyboard
    // delivery unless the target owns the foreground. Activate the app
    // (idempotent, no snapshot ref consumed) right before delivery.
    await client.run(["activate-app", "--app", app, "--timeout-ms", String(timeoutMs)], common)
  }
  // Defense in depth: a read-only task must never deliver a mutating step,
  // even if a stale candidate survived into the current observation.
  if (input.readOnly && (isMutation(candidate.operation) || candidate.operation === "PRESS_ENTER")) {
    throw new Error(`read-only task refused ${candidate.operation}`)
  }
  if (candidate.operation === "PRESS_ENTER") {
    const result = await client.run<Record<string, unknown>>(["press", "return", "--app", app], common)
    return delivery(result)
  }
  if (candidate.operation === "ACTIVATE") {
    if (client.backend === "xa11y" && candidate.ref) return delivery(await client.run(["activate", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
    if (client.backend === "xa11y") return delivery(await client.run(["activate-app", "--app", app, "--timeout-ms", String(timeoutMs)], common))
    if (!candidate.ref) throw new Error("ACTIVATE requires an observed window ref for this desktop backend")
    return delivery(await client.run(["activate", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (!candidate.ref) throw new Error(`${candidate.operation} requires an observed element ref`)
  if (candidate.operation === "FOCUS") {
    return delivery(await client.run(["focus", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
  }
  if (candidate.operation === "CLICK") {
    if (client.backend === "xa11y" && !candidate.headed) {
      return delivery(await client.run(["press", candidate.ref, "--timeout-ms", String(timeoutMs)], common))
    }
    const args = ["click", candidate.ref, "--timeout-ms", String(timeoutMs)]
    if (candidate.headed && client.backend !== "xa11y") args.unshift("--headed")
    return delivery(await client.run(args, common))
  }
  if (candidate.operation === "DOUBLE_CLICK") {
    const args = ["double-click", candidate.ref, "--timeout-ms", String(timeoutMs)]
    if (candidate.headed && client.backend !== "xa11y") args.unshift("--headed")
    return delivery(await client.run(args, common))
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
  const labels: Partial<Record<DesktopCandidate["operation"], string>> = { PRESS_ENTER: "按回车提交", CLICK: "点击", DOUBLE_CLICK: "双击", SET_VALUE: "写入", TYPE_TEXT: "输入" }
  return labels[operation] ?? operation
}

function needsForeground(candidate: DesktopCandidate): boolean {
  if (candidate.operation === "ACTIVATE" && !candidate.ref) return false
  if (["DRILL", "WIDEN", "WAIT", "DONE", "BLOCKED"].includes(candidate.operation)) return false
  // Background-safe semantic AX operations (see ax.rs dispatch_observed).
  if (!candidate.headed && ["CLICK", "SET_VALUE", "TYPE_TEXT"].includes(candidate.operation)) return false
  return true
}

function findSlot(input: GuiTaskInput, id: string | undefined) {
  return input.textSlots?.find(slot => slot.id === id)
}

function isMutation(operation: DesktopCandidate["operation"]): boolean {
  return !["ACTIVATE", "FOCUS", "DRILL", "WIDEN", "WAIT", "DONE", "BLOCKED", "SCROLL_TO", "SCROLL_DOWN", "SCROLL_UP"].includes(operation)
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

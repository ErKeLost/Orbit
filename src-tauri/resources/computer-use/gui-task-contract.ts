import type { DesktopNode } from "./agent-desktop-client.ts"

export type { DesktopNode }

export type TextSlot = { id: string; value: string; description: string }
export type ExecutionBudget = { maxActions: number; maxDecisions: number; maxDurationMs: number }
export type GuiTaskInput = {
  goal: string
  target: { app: string }
  textSlots?: TextSlot[]
  /** Only inspect the already-open view; forbid clicks, text entry and sends. */
  readOnly?: boolean
  /** Experimental narrow lookahead depth (0 = off). Not part of the tool schema. */
  lookahead?: number
  budget: ExecutionBudget
}

export type DesktopOperation =
  | "FOCUS"
  | "ACTIVATE"
  | "CLICK"
  | "DOUBLE_CLICK"
  | "RIGHT_CLICK"
  | "SET_VALUE"
  | "TYPE_TEXT"
  | "CLEAR"
  | "CHECK"
  | "UNCHECK"
  | "EXPAND"
  | "COLLAPSE"
  | "SCROLL_DOWN"
  | "SCROLL_UP"
  | "SCROLL_TO"
  | "PRESS_ENTER"
  | "MENU_ITEM"
  | "DISMISS"
  | "DRILL"
  | "WIDEN"
  | "WAIT"
  | "DONE"
  | "BLOCKED"

export type DesktopCandidate = {
  id: string
  operation: DesktopOperation
  description: string
  /** Structured identity fields sent to Jev as Choice criteria; operation
   * semantics stay in description. Structured criteria disambiguate better
   * than a flat sentence. */
  criteria?: Record<string, string>
  ref?: string
  /** MENU_ITEM: exact title path from the menu bar. */
  menuPath?: string[]
  slotId?: string
  headed?: boolean
  /** Why this action is believed to work. Declared = the element advertises
   * it; structural/geometric = inferred from layout and must be verified. */
  evidence?: "declared" | "structural" | "geometric"
  /** Inferred, not declared: the verifier must check the result. */
  speculative?: boolean
  /** Generic expectations the verifier checks after delivery. */
  expect?: DesktopExpectation[]
}

/** `no_overlay`: an ordinary activation must not open an unrelated menu,
 * popover, sheet or alert. `value_equals`: a text mutation must leave the
 * field holding the caller-prepared value (checked from the settled tree). */
export type DesktopExpectation = "no_overlay" | "value_equals"

export type DesktopObservation = {
  app: string
  windowId: string
  title: string
  surface: string
  root?: string
  snapshotId?: string
  complete: boolean
  capturedAt: number
  candidates: DesktopCandidate[]
  context: string
  fingerprint: string
  /** Hash of the accessibility tree alone (no OS media fact). */
  treeFingerprint?: string
  /** OS media-session fact included in context, when available. */
  media?: string
  /** Taken without reading the media fact (settle poll); see attachMedia. */
  mediaSkipped?: boolean
  /** Retained skeleton tree; the engine diffs consecutive observations so
   * Jev receives what actually changed, not just a changed=true boolean. */
  tree: DesktopNode
}

export type DesktopDecision = {
  operation: DesktopOperation
  candidateId: string
  confidence: number
  model: string
  latencyMs: number
  probabilities: Record<string, number>
  usage: { inputTokens: number; outputTokens: number }
  /** Undo-risk probability answered in the same Jev request, when asked. */
  risk?: number
  /** Every undo-risk answer of this request, by candidate id (cacheable). */
  risks?: Record<string, number>
  /** Predicted probability that the chosen step completes the whole goal. */
  completesGoal?: number
  /** Predicted following CLICK targets (narrow lookahead), in order. */
  lookahead?: { candidateId: string; confidence: number }[]
}

export type GuiTaskMetrics = {
  elapsedMs: number
  launchMs: number
  observationMs: number
  decisionMs: number
  actionMs: number
  inputTokens: number
  outputTokens: number
  /** Jev round trips (step decisions, rechecks and separate risk calls). */
  jevCalls: number
  /** Steps executed from Affordance Memory without asking Jev. */
  replayedSteps: number
  /** Steps executed from a guarded lookahead prediction (no new request). */
  lookaheadSteps: number
  /** Time spent waiting for the app to settle after actions. */
  settleMs: number
  /** Accessibility notifications observed while settling. */
  settleEvents: number
}

export type GuiTaskStatus = "done" | "blocked" | "needs_review" | "needs_text" | "aborted" | "max_actions" | "max_decisions" | "timeout" | "error"
export type GuiTaskTrace = {
  step: number
  stateId: string
  operation?: DesktopOperation
  candidateId?: string
  candidate?: string
  confidence?: number
  outcome?: string
  changed?: boolean
  /** Verifier result for an inferred action. */
  verdict?: "side_effect" | "no_effect"
  /** Who chose this step. */
  source?: "jev" | "memory" | "lookahead"
  /** Wall-clock time of this step (decision + action + settle). */
  ms?: number
  note?: string
}
export type GuiTaskResult = {
  status: GuiTaskStatus
  appLaunched: boolean
  goalVerified: boolean
  lastAction?: { operation: DesktopOperation; delivery?: string }
  actions: number
  decisions: number
  evidence: string
  metrics: GuiTaskMetrics
  trace: GuiTaskTrace[]
}
export type GuiTaskEvent = {
  type: "launching" | "observed" | "decided" | "acted" | "status"
  step: number
  status: GuiTaskStatus | "running"
  payload: Record<string, unknown>
}

export function validateTaskInput(input: GuiTaskInput): void {
  if (!input.goal?.trim() || !input.target?.app?.trim() || !input.budget || (input.readOnly !== undefined && typeof input.readOnly !== "boolean")) throw new Error("Invalid GUI task contract")
  const { maxActions, maxDecisions, maxDurationMs } = input.budget
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error("Invalid GUI action budget")
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 200) throw new Error("Invalid GUI decision budget")
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > 10 * 60_000) throw new Error("Invalid GUI duration budget")
  const ids = new Set<string>()
  for (const slot of input.textSlots ?? []) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(slot.id) || ids.has(slot.id) || typeof slot.value !== "string" || slot.value.length > 10_000 || !slot.description?.trim()) throw new Error("Invalid text slot")
    ids.add(slot.id)
  }
}

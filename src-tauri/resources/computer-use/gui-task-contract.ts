import type { DesktopNode } from "./desktop-driver.ts"

export type { DesktopNode }

export type TextSlot = { id: string; value: string; description: string }
/** The observation text budget. The observer builds to exactly this size and the
 * state sanitizer truncates at the same value, so a request is never cut
 * mid-line by a budget the observer did not know about: one number, one place. */
/** One Jev request carries the observation and the questions in a single input
 * budget. Measured against the live service: a request up to ~125K characters
 * is accepted and one above it is rejected, whatever the split between the two.
 * The offer set needs the larger share, so the observation takes a third. */
export const REQUEST_CHARS = 125_000
export const OBSERVATION_CHARS = Math.floor(REQUEST_CHARS / 3)

/** Criteria keys that change as a result of the action being judged, so they
 * cannot take part in a stable identity. Shared so the engine's exclusion sets
 * and affordance memory agree on what "the same target" means when a candidate
 * carries criteria but no dedicated identity (menu commands, test candidates). */
const VOLATILE_CRITERIA_KEYS = ["state", "holds", "local_match", "goal_match", "new", "at", "sibling", "structure", "contains"]

export function stableCriteria(criteria: Readonly<Record<string, string>> | undefined): string | undefined {
  if (!criteria) return undefined
  const stable = Object.fromEntries(Object.entries(criteria)
    .filter(([key]) => !VOLATILE_CRITERIA_KEYS.includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))
  return Object.keys(stable).length ? JSON.stringify(stable) : undefined
}
export type ExecutionBudget = { maxActions: number; maxDecisions: number; maxDurationMs: number }
export type GuiTaskInput = {
  goal: string
  target: { app: string }
  textSlots?: TextSlot[]
  /** Only inspect the already-open view; forbid clicks, text entry and sends. */
  readOnly?: boolean
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
  /** What the decision model sees for this target: a short label plus the few
   * observations that discriminate it from its siblings. Short by design; the
   * detail an element carries belongs in the state once, not repeated per
   * candidate. */
  criteria?: Record<string, string>
  /** How the engine re-identifies this target across snapshots. Kept out of
   * `criteria` so making the model-facing view terser cannot destabilise
   * quarantine, risk caching or affordance memory. Order is stable, so two
   * runs over one window produce the same key. */
  identity?: Record<string, string | number>
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
  source?: "jev" | "memory"
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

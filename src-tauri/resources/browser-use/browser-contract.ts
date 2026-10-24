/**
 * The `browser_task` contract, mirroring `gui-task-contract.ts`.
 *
 * Same shape on purpose: the calling model already knows how to budget a tool,
 * keep exact text out of the decision model's view, and read a structured
 * result. A second contract with its own vocabulary would only make the two
 * tools harder to use together.
 */

import type { BrowserAction, BrowserObservation } from "./browser-driver.ts"

export type { BrowserAction, BrowserObservation }

/** One exact string the caller prepared; the decision model sees only its purpose. */
export type TextSlot = { id: string; value: string; description: string }

export type ExecutionBudget = { maxActions: number; maxDecisions: number; maxDurationMs: number }

export type BrowserTaskInput = {
  goal: string
  /** Where to start. Omitted reuses the page the browser column already shows. */
  url?: string
  textSlots?: TextSlot[]
  /**
   * Whether the run may have its own model write a field value that no prepared
   * slot covers. On by default: asking the caller for every string would make
   * "search Wikipedia for X" fail on the value it already stated. Set false when
   * a value must come only from `textSlots` — nothing is then generated, and a
   * field with no slot stops the run.
   */
  allowGeneratedText?: boolean
  /** Inspect and scroll only: no clicks, no typing, no selections. */
  readOnly?: boolean
  budget: ExecutionBudget
}

export type BrowserDecision = {
  /** The observed action this decision resolves to. Absent for DONE/BLOCKED,
   * which are decisions about the run rather than about an element. */
  action?: BrowserAction
  operation: string
  target?: string
  slotId?: string
  confidence: number
  probabilities: Record<string, number>
  model: string
  latencyMs: number
  usage: { inputTokens: number; outputTokens: number }
  /** Probability that this step is hard to undo, when it was asked for. */
  irreversible?: number
  /** The request as sent, for diagnostics and tests. */
  request: Record<string, unknown>
}

export type BrowserTaskStatus =
  | "done"
  | "blocked"
  | "needs_text"
  | "needs_review"
  | "aborted"
  | "max_actions"
  | "max_decisions"
  | "timeout"
  | "error"

export type BrowserTaskStep = {
  step: number
  operation: string
  target?: string
  /** The observed label, so a failure is readable without the raw element table. */
  label?: string
  confidence?: number
  verdict?: "changed" | "no_change"
  /** Set when the step typed: which slot, never its value. */
  slotId?: string
  ms?: number
  note?: string
}

export type BrowserTaskFailure = {
  stage: "launch" | "observe" | "decide" | "risk-gate" | "deliver" | "budget" | "slot"
  branch?: string
  detail: string
  hint?: string
}

export type BrowserTaskMetrics = {
  elapsedMs: number
  observationMs: number
  decisionMs: number
  actionMs: number
  inputTokens: number
  outputTokens: number
  jevCalls: number
  /** Values the run's own model wrote (no prepared slot covered the field). */
  generatedValues: number
  /** Which engine actually drove the run: `view` is the app's own browser tab,
   * `chrome` the CDP fallback. Reported so a silent fall back is visible. */
  engine?: "view" | "chrome"
  /** Why the view was not the engine, when it was tried and failed. */
  engineFallback?: string
}

export type BrowserTaskResult = {
  status: BrowserTaskStatus
  /** The page the run ended on, so the caller can look at it. */
  url: string
  title: string
  goalVerified: boolean
  steps: number
  decisions: number
  /** Visible page text at the end, bounded: evidence, not a transcript. */
  evidence: string
  /** A PNG of the page as the run last saw it, when the engine could take one and
   * the run stopped anywhere but `done`/`aborted`. The text cannot show an overlay. */
  screenshotPath?: string
  metrics: BrowserTaskMetrics
  trace: BrowserTaskStep[]
  failure?: BrowserTaskFailure
}

export const REQUEST_CHARS = 125_000
/** How much page text may reach the decision model. The observer caps itself at
 * the same number so a request is never cut mid-line by a budget the observer
 * did not know about. */
export const EVIDENCE_CHARS = 1_600

export function validateTaskInput(input: BrowserTaskInput): void {
  if (!input.goal?.trim() || !input.budget) throw new Error("Invalid browser task contract")
  const { maxActions, maxDecisions, maxDurationMs } = input.budget
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > 100) throw new Error("Invalid browser action budget")
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 200) throw new Error("Invalid browser decision budget")
  if (!Number.isInteger(maxDurationMs) || maxDurationMs < 1_000 || maxDurationMs > 10 * 60_000) throw new Error("Invalid browser duration budget")
  if (input.readOnly !== undefined && typeof input.readOnly !== "boolean") throw new Error("Invalid browser task contract")
  const ids = new Set<string>()
  for (const slot of input.textSlots ?? []) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(slot.id) || ids.has(slot.id) || typeof slot.value !== "string" || slot.value.length > 10_000 || !slot.description?.trim()) {
      throw new Error("Invalid browser text slot")
    }
    ids.add(slot.id)
  }
}


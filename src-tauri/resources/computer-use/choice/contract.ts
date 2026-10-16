import type { CuaCandidate, CuaObservation } from "../cua/types.ts"
import type { VisualRegion } from "../cua/types.ts"

/**
 * The bounded-choice contract.
 *
 * `v2` is the version that tags each candidate with its `source` (ax / visual /
 * page). It is a NEW version rather than a new field because v1 validators
 * reject unknown keys, so adding `source` in place would break every v1 reader.
 *
 * The request is the only thing the chooser sees: the goal, the observation,
 * the history, progress, and bounded candidates. Never tool names, arguments,
 * coordinates, screenshots or credentials.
 */
export const CHOICE_REQUEST_SCHEMA = "cua.jev_choice_request_v2"

export const MIN_CANDIDATES = 2
export const MAX_CANDIDATES = 32
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export type ChoiceRegion = {
  id: string
  kind: "text" | "icon"
  text?: string
  confidence: number
  interactive: boolean
  x: number
  y: number
  width: number
  height: number
}

export type ChoiceRequest = {
  schema: typeof CHOICE_REQUEST_SCHEMA
  goal: string
  capture_id: string | null
  snapshot_id: string | null
  regions: ChoiceRegion[]
  history: string[]
  progress: Record<string, number>
  candidates: Array<{ id: string; description: string; source: string | null }>
}

export type ChoiceAnswer = {
  selectedId: string
  confidence: number
  probabilities: Record<string, number>
}

export type BuildChoiceInput = {
  goal: string
  observation: CuaObservation
  candidates: readonly CuaCandidate[]
  history: readonly string[]
  /** Required steps and how many times this run has performed them. */
  progress?: Record<string, number>
  regions?: readonly VisualRegion[]
  captureId?: string
}

export function buildChoiceRequest(input: BuildChoiceInput): ChoiceRequest {
  const candidates = input.candidates.filter(candidate => ID_PATTERN.test(candidate.id))
  if (candidates.length < MIN_CANDIDATES) throw new Error(`choice request needs at least ${MIN_CANDIDATES} candidates`)
  if (candidates.length > MAX_CANDIDATES) throw new Error(`choice request supports at most ${MAX_CANDIDATES} candidates`)
  const ids = new Set(candidates.map(candidate => candidate.id))
  if (ids.size !== candidates.length) throw new Error("choice request contains duplicate candidate IDs")
  for (const reserved of ["reobserve", "abstain"]) {
    if (!ids.has(reserved)) throw new Error(`choice request must always carry the reserved ${reserved} candidate`)
  }
  return {
    schema: CHOICE_REQUEST_SCHEMA,
    goal: input.goal,
    capture_id: input.captureId ?? input.observation.captureId ?? null,
    snapshot_id: input.observation.snapshotId ?? null,
    regions: (input.regions ?? []).map(toChoiceRegion),
    history: [...input.history],
    progress: input.progress ?? {},
    candidates: candidates.map(candidate => ({
      id: candidate.id,
      description: candidate.description.slice(0, 1_000),
      source: candidate.source,
    })),
  }
}

export function toChoiceRegion(region: VisualRegion): ChoiceRegion {
  return {
    id: region.id,
    kind: region.kind,
    text: region.text ?? region.label,
    confidence: region.confidence,
    interactive: region.interactive,
    x: region.bounds.x,
    y: region.bounds.y,
    width: region.bounds.w,
    height: region.bounds.h,
  }
}

/**
 * Strict answer validation. A structurally invalid answer is retryable noise,
 * never a silent default: the loop would otherwise act on an invented id.
 */
export function validateChoiceAnswer(
  answer: { type?: string; choice?: string; confidence?: number; probabilities?: Readonly<Record<string, number>> } | undefined,
  candidates: readonly CuaCandidate[],
): ChoiceAnswer {
  const ids = candidates.map(candidate => candidate.id)
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string" || !ids.includes(answer.choice)) {
    throw new Error("invalid choice answer: unknown candidate selected")
  }
  const probabilities = answer.probabilities
  if (!probabilities || Object.keys(probabilities).length !== ids.length || ids.some(id => !Object.hasOwn(probabilities, id))) {
    throw new Error("invalid choice answer: incomplete probability distribution")
  }
  const values = Object.values(probabilities)
  if (values.some(value => !finite(value)) || Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) > 0.02) {
    throw new Error("invalid choice answer: probabilities do not sum to one")
  }
  if (!finite(answer.confidence) || probabilities[answer.choice] < Math.max(...values) - 1e-6) {
    throw new Error("invalid choice answer: confidence is not maximal")
  }
  return { selectedId: answer.choice, confidence: answer.confidence, probabilities: { ...probabilities } }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
}

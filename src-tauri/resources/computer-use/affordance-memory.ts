import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DesktopCandidate, DesktopOperation, TextSlot } from "./gui-task-contract.ts"

/**
 * Affordance Memory: a local cache of verified task trajectories.
 *
 * A trajectory is learned only from a task that finished `done`, and records
 * each executed step as (operation, observed target identity). Replay matches
 * a step against the *current* offered candidates by identity; any mismatch
 * falls back to the normal Jev loop (self-heal). Nothing app-specific is
 * encoded, and caller-prepared slot values are never written to disk.
 */

export type MemoryStep = {
  operation: DesktopOperation
  identity: string
  slotId?: string
  /** Undo-risk probability observed when the step was learned. */
  risk?: number
}

export type MemoryEntry = {
  steps: MemoryStep[]
  /** Set when the learned run finished by predicted completion + evidence:
   * the final replayed step may finish the same way. */
  completion?: number
  successes: number
  failures: number
  updatedAt: number
}

export interface AffordanceMemory {
  lookup(key: string): Promise<MemoryEntry | undefined>
  /** All entries, for template (parameterized) matching. */
  list?(): Promise<[string, MemoryEntry][]>
  recordSuccess(key: string, steps: MemoryStep[], completion?: number): Promise<void>
  recordFailure(key: string): Promise<void>
}

const MAX_ENTRIES = 500
const MAX_STEPS = 40
/** Identity fields that change as a result of acting, or only locate a
 * target in one layout (list position, row count, geometry), and therefore
 * cannot identify it across runs. Role, label, container path, in_item and
 * capabilities remain: a same-named control in a reordered list still
 * matches, a renamed or relocated one does not. */
const VOLATILE_CRITERIA = new Set(["state", "holds", "local_match", "goal_match", "new", "at", "sibling", "structure", "contains"])

export function memoryKey(app: string, goal: string, slots: readonly TextSlot[], readOnly: boolean): string {
  const redacted = redact(goal, slots).replace(/\s+/g, " ").trim().toLowerCase()
  const slotIds = slots.map(slot => slot.id).sort().join(",")
  return JSON.stringify([app.trim().toLowerCase(), redacted, slotIds, readOnly])
}

export function memoryIdentity(candidate: DesktopCandidate, slots: readonly TextSlot[]): string {
  const base = candidate.criteria
    ? Object.fromEntries(Object.entries(candidate.criteria)
      .filter(([key]) => !VOLATILE_CRITERIA.has(key))
      // Container paths embed a summary of their current contents
      // (`list containing "a · b · c"`); keep only the container role.
      .map(([key, value]) => [key, key === "where" ? value.replace(/ containing "[^"]*"/g, "") : value])
      .sort(([a], [b]) => a.localeCompare(b)))
    : { what: candidate.description.split(";")[0] }
  return redact(JSON.stringify([candidate.headed ? "headed" : "semantic", base]), slots)
}

/**
 * Parameterized trajectories (workflow-use style variables). A step whose
 * target was chosen among same-shaped siblings (a contact, a row, a menu
 * item) and whose label appears verbatim in the goal becomes a variable:
 * "给李四发送…" + click table_cell "李四"  →  "给{v1}发送…" + click "{v1}".
 * A new goal matching the template binds v1 and replays with it; the bound
 * label must then be a unique live candidate, or replay stops (self-heal).
 */
export type ParameterizedTrajectory = { key: string; steps: MemoryStep[] }

export function parameterize(app: string, goal: string, slots: readonly TextSlot[], readOnly: boolean, steps: readonly MemoryStep[], labels: readonly (string | undefined)[]): ParameterizedTrajectory | undefined {
  const redactedGoal = normalizeGoal(redact(goal, slots))
  const values = [...new Set(labels.filter((label): label is string => Boolean(label && label.length >= 2 && redactedGoal.includes(label))))]
    // Longest first, so one label that contains another is bound whole.
    .sort((a, b) => b.length - a.length)
  if (values.length === 0) return undefined
  let template = redactedGoal
  let templateSteps = steps.map(step => ({ ...step }))
  values.forEach((value, index) => {
    const placeholder = `{v${index + 1}}`
    template = template.split(value).join(placeholder)
    const encoded = JSON.stringify(value).slice(1, -1)
    templateSteps = templateSteps.map(step => ({ ...step, identity: step.identity.split(encoded).join(placeholder) }))
  })
  // A template must keep some fixed text, or it would match any goal.
  if (template.replace(/\{v\d+\}/g, "").trim().length < 4) return undefined
  return { key: JSON.stringify([app.trim().toLowerCase(), template.toLowerCase(), slots.map(slot => slot.id).sort().join(","), readOnly]), steps: templateSteps }
}

/** Find a parameterized trajectory whose template matches this goal and
 * return its steps with the variables bound. */
export async function lookupTemplate(memory: AffordanceMemory, app: string, goal: string, slots: readonly TextSlot[], readOnly: boolean): Promise<{ key: string; entry: MemoryEntry } | undefined> {
  if (!memory.list) return undefined
  const target = normalizeGoal(redact(goal, slots))
  const slotIds = slots.map(slot => slot.id).sort().join(",")
  for (const [key, entry] of await memory.list()) {
    let parsed: unknown
    try { parsed = JSON.parse(key) } catch { continue }
    if (!Array.isArray(parsed) || parsed[0] !== app.trim().toLowerCase() || parsed[2] !== slotIds || parsed[3] !== readOnly) continue
    const template = String(parsed[1])
    if (!/\{v\d+\}/.test(template) || entry.successes <= entry.failures) continue
    const names: string[] = []
    const pattern = template.split(/(\{v\d+\})/).map(part => {
      if (/^\{v\d+\}$/.test(part)) { names.push(part); return "(.+?)" }
      return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }).join("")
    const match = new RegExp(`^${pattern}$`, "i").exec(target)
    if (!match) continue
    const bindings = new Map(names.map((name, index) => [name, match[index + 1]]))
    return {
      key,
      entry: {
        ...entry,
        steps: entry.steps.map(step => ({ ...step, identity: [...bindings].reduce((identity, [name, value]) => identity.split(name).join(JSON.stringify(value).slice(1, -1)), step.identity) })),
      },
    }
  }
  return undefined
}

function normalizeGoal(goal: string): string {
  return goal.replace(/\s+/g, " ").trim()
}

/** Waiting and terminal choices are never replayed; DRILL/WIDEN are kept
 * because a remembered target may only be offered inside a drilled region. */
export function isReplayableOperation(operation: DesktopOperation): boolean {
  return !["WAIT", "DONE", "BLOCKED"].includes(operation)
}

/** Operation-independent identity: SCROLL_TO X and CLICK X share it. */
export function sameTarget(step: MemoryStep, candidate: DesktopCandidate, slots: readonly TextSlot[]): boolean {
  return memoryIdentity(candidate, slots) === step.identity
}

/**
 * Resolve a remembered step against the live candidates, treating
 * "bring into view" as layout-dependent: a remembered SCROLL_TO whose target
 * is already directly actionable is skipped (`skip`), and a remembered
 * activation whose target is now offscreen is preceded by its SCROLL_TO.
 */
export function resolveStep(steps: readonly MemoryStep[], index: number, candidates: readonly DesktopCandidate[], slots: readonly TextSlot[]): { candidate?: DesktopCandidate; skip?: boolean } {
  const step = steps[index]
  const direct = matchStep(step, candidates, slots)
  if (step.operation === "SCROLL_TO") {
    const next = steps[index + 1]
    if (!direct && next && next.identity === step.identity && matchStep(next, candidates, slots)) return { skip: true }
    return direct ? { candidate: direct } : {}
  }
  if (direct) return { candidate: direct }
  const scroll = candidates.filter(candidate => candidate.operation === "SCROLL_TO" && candidate.ref && sameTarget(step, candidate, slots))
  return scroll.length === 1 ? { candidate: scroll[0] } : {}
}

/** Find the unique current candidate matching a remembered step. */
export function matchStep(step: MemoryStep, candidates: readonly DesktopCandidate[], slots: readonly TextSlot[]): DesktopCandidate | undefined {
  const matches = candidates.filter(candidate =>
    candidate.operation === step.operation
    && (candidate.slotId ?? undefined) === (step.slotId ?? undefined)
    && (candidate.ref || !["CLICK", "DOUBLE_CLICK", "RIGHT_CLICK", "SET_VALUE", "TYPE_TEXT", "CLEAR", "FOCUS", "CHECK", "UNCHECK", "EXPAND", "COLLAPSE", "SCROLL_TO", "SCROLL_UP", "SCROLL_DOWN"].includes(candidate.operation))
    && memoryIdentity(candidate, slots) === step.identity)
  return matches.length === 1 ? matches[0] : undefined
}

function redact(text: string, slots: readonly TextSlot[]): string {
  let out = text
  for (const slot of [...slots].filter(slot => slot.value).sort((a, b) => b.value.length - a.value.length)) out = out.split(slot.value).join(`[slot:${slot.id}]`)
  return out
}

type Store = { version: 1; entries: Record<string, MemoryEntry> }

export function defaultMemoryPath(): string {
  return process.env.ORBIT_CU_MEMORY_PATH?.trim() || join(homedir(), ".pi/agent/orbit-computer-use/memory.json")
}

/** JSON-file memory. Every failure degrades to "no memory"; it can never
 * break a task. */
export function createFileMemory(path = defaultMemoryPath()): AffordanceMemory {
  let cache: Store | undefined
  let writing = Promise.resolve()
  const load = async (): Promise<Store> => {
    if (cache) return cache
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as Store
      cache = parsed?.version === 1 && parsed.entries && typeof parsed.entries === "object" ? parsed : { version: 1, entries: {} }
    } catch {
      cache = { version: 1, entries: {} }
    }
    return cache
  }
  const persist = async (store: Store) => {
    const keys = Object.keys(store.entries)
    if (keys.length > MAX_ENTRIES) {
      for (const key of keys.sort((a, b) => store.entries[a].updatedAt - store.entries[b].updatedAt).slice(0, keys.length - MAX_ENTRIES)) delete store.entries[key]
    }
    writing = writing.then(async () => {
      try {
        await mkdir(dirname(path), { recursive: true })
        const temp = `${path}.${process.pid}.tmp`
        await writeFile(temp, JSON.stringify(store), { mode: 0o600 })
        await rename(temp, path)
      } catch { /* memory is best effort */ }
    })
    await writing
  }
  return {
    async lookup(key) {
      const entry = (await load()).entries[key]
      return entry && entry.steps.length > 0 ? entry : undefined
    },
    async list() {
      return Object.entries((await load()).entries)
    },
    async recordSuccess(key, steps, completion) {
      if (steps.length === 0 || steps.length > MAX_STEPS) return
      const store = await load()
      const previous = store.entries[key]
      const same = previous && JSON.stringify(previous.steps.map(({ risk: _r, ...step }) => step)) === JSON.stringify(steps.map(({ risk: _r, ...step }) => step))
      store.entries[key] = { steps, ...(typeof completion === "number" ? { completion } : {}), successes: same ? previous.successes + 1 : 1, failures: same ? previous.failures : 0, updatedAt: Date.now() }
      await persist(store)
    },
    async recordFailure(key) {
      const store = await load()
      const entry = store.entries[key]
      if (!entry) return
      entry.failures++
      entry.updatedAt = Date.now()
      if (entry.failures > entry.successes + 2) delete store.entries[key]
      await persist(store)
    },
  }
}

export function createInMemoryMemory(): AffordanceMemory & { entries: Map<string, MemoryEntry> } {
  const entries = new Map<string, MemoryEntry>()
  return {
    entries,
    async lookup(key) { return entries.get(key) },
    async list() { return [...entries] },
    async recordSuccess(key, steps, completion) {
      const previous = entries.get(key)
      entries.set(key, { steps, ...(typeof completion === "number" ? { completion } : {}), successes: (previous?.successes ?? 0) + 1, failures: previous?.failures ?? 0, updatedAt: Date.now() })
    },
    async recordFailure(key) {
      const entry = entries.get(key)
      if (!entry) return
      entry.failures++
      if (entry.failures > entry.successes + 2) entries.delete(key)
    },
  }
}

export function memoryEnabled(): boolean {
  return process.env.ORBIT_CU_MEMORY !== "0"
}

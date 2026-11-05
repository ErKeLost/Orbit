import type { CuaCandidate, CuaObservation } from "../cua/types.ts"
import { roleClass } from "./roles.ts"

/**
 * Geometric candidates: targets the accessibility tree proves exist but does
 * not expose an action for.
 *
 * This is the lesson agent-desktop makes unavoidable. Its refs only exist for
 * addressable elements, and where an app publishes no action it still offers an
 * addressable fallback — `mouse-click --xy`, addressed in the same screenshot
 * space the observation returned. A candidate set built only from `AXPress`
 * cannot see a WebView song row or a label-only "play all" control at all,
 * which is exactly where the chooser used to abstain.
 *
 * A coordinate click is evidence-free, so the rules are deliberately narrow:
 *
 * - the label must be named by the goal and be at least two characters,
 * - the label must sit on a real row (a sibling label on the same baseline
 *   within a short horizontal gap) or stand alone as a control,
 * - the observation must carry a `captureId`: coordinates without the capture
 *   they were measured in are not deliverable,
 * - at most three candidates, always `escalated`, so the physical-input
 *   confirmation gate applies and the success is verified afterwards.
 *
 * Everything else is left out. A wrong coordinate is worse than a missing
 * candidate: it spends the chooser's turn on an action nobody can verify.
 */

/** Two labels share a baseline when their tops are within this many pixels. */
const BASELINE_TOLERANCE = 6
/** Labels further apart than this on one baseline belong to different columns. */
const COLUMN_GAP = 160
/** Goal tokens shorter than this are too generic to anchor a coordinate click. */
const MIN_LABEL = 2
const MAX_GEOMETRIC = 3
/** Rows whose left edge sits inside this fraction of the window are navigation. */
const NAV_RAIL_FRACTION = 0.12
/** Vertical pitch tolerance when deciding that rows form one list. */
const PITCH_TOLERANCE = 4
/** A list needs at least this many rows at one pitch before it can be ordered. */
const MIN_LIST_ROWS = 3

/**
 * Positional goals ("the first result", "the last message") name no label, so a
 * candidate set keyed on labels can never answer them. The tree still shows the
 * order, so the ordering itself is the evidence: a run of rows at one vertical
 * pitch to the right of the navigation rail is a list, and its first or last row
 * is what the goal means.
 */
const FIRST_INTENT = /(第一|首个|首行|首条|第一个|最上|最前|顶部|排在最前|\bfirst\b|\btop\b)/i
const LAST_INTENT = /(最后|末条|最后一条|最下|底部|\blast\b|\bbottom\b)/i

type Frame = { x: number; y: number; w: number; h: number }

/**
 * Element frames are reported in screen coordinates, while a pointer click is
 * addressed in window-local screenshot pixels. Delivering a raw frame centre
 * therefore lands somewhere else entirely — offset by the window origin and
 * scaled by the screenshot ratio. This converts one into the other.
 */
export function pointerPoint(frame: Frame, observation: Pick<CuaObservation, "windowBounds" | "screenshot">): { x: number; y: number } {
  const bounds = observation.windowBounds
  const scale = bounds && observation.screenshot?.width ? observation.screenshot.width / bounds.w : 1
  const centreX = frame.x + frame.w / 2
  const centreY = frame.y + frame.h / 2
  if (!bounds) return { x: Math.round(centreX), y: Math.round(centreY) }
  return { x: Math.round((centreX - bounds.x) * scale), y: Math.round((centreY - bounds.y) * scale) }
}
type Member = { label: string; frame: Frame; role: string }

function frameOf(value: unknown): Frame | undefined {
  if (!value || typeof value !== "object") return undefined
  const frame = value as Record<string, unknown>
  const numbers = ["x", "y", "w", "h"].map(key => frame[key])
  if (numbers.some(number => typeof number !== "number" || !Number.isFinite(number))) return undefined
  const [x, y, w, h] = numbers as number[]
  return w > 0 && h > 0 ? { x, y, w, h } : undefined
}

/** Labels that may anchor a click: readable text, not the window chrome. */
function candidatesFrom(observation: CuaObservation): Member[] {
  const members: Member[] = []
  for (const element of observation.elements) {
    if (element.enabled === false) continue
    const cls = roleClass(element.role)
    if (cls !== "text" && cls !== "link" && cls !== "image" && cls !== "row") continue
    // One-character titles are real ("蓝", "7"): they may anchor a row, but
    // they are never matched against a goal or used as a standalone control.
    const label = (element.label ?? element.value ?? "").trim()
    const frame = frameOf(element.frame)
    if (!label || !frame) continue
    members.push({ label, frame, role: cls })
  }
  return members
}

/** Nearest label to the right on the same baseline, if it is close enough. */
function adjacentOnRow(member: Member, members: readonly Member[]): boolean {
  return members.some(other => {
    if (other === member) return false
    if (Math.abs(other.frame.y - member.frame.y) > BASELINE_TOLERANCE) return false
    const gap = other.frame.x - (member.frame.x + member.frame.w)
    const gapLeft = member.frame.x - (other.frame.x + other.frame.w)
    return (gap >= -2 && gap <= COLUMN_GAP) || (gapLeft >= -2 && gapLeft <= COLUMN_GAP)
  })
}

/** How strongly a label is named by the goal: longer in-goal text wins. */
function match(label: string, goal: string): number {
  if (label.length < MIN_LABEL || !goal.includes(label)) return 0
  return label.length >= 4 ? 3 : label.length >= 3 ? 2 : 1
}

/** Which end of a list the goal names, if either. */
export function positionalIntent(goal: string): "first" | "last" | undefined {
  if (FIRST_INTENT.test(goal)) return "first"
  if (LAST_INTENT.test(goal)) return "last"
  return undefined
}

/** Clusters of same-baseline labels, widest columns first. */
function baselineClusters(members: readonly Member[]): Member[][] {
  const clusters: Member[][] = []
  for (const member of [...members].sort((left, right) => left.frame.y - right.frame.y || left.frame.x - right.frame.x)) {
    const cluster = clusters.find(candidate => Math.abs(candidate[0].frame.y - member.frame.y) <= BASELINE_TOLERANCE)
    if (cluster) cluster.push(member)
    else clusters.push([member])
  }
  return clusters
}

/**
 * Rows that behave like one list: same vertical pitch, at least three of them,
 * and outside the navigation rail. Nothing here names an application; it is the
 * shape a list has.
 */
export function listRows(observation: CuaObservation): Member[][] {
  const members = candidatesFrom(observation)
  const rail = observation.windowBounds ? observation.windowBounds.x + observation.windowBounds.w * NAV_RAIL_FRACTION : undefined
  const clusters = baselineClusters(members)
    // The left edge of a row is the leftmost label in it.
    .map(cluster => ({ cluster, left: Math.min(...cluster.map(member => member.frame.x)), y: Math.min(...cluster.map(member => member.frame.y)) }))
    .filter(entry => rail === undefined || entry.left >= rail)
    .sort((left, right) => left.y - right.y)
  if (clusters.length < MIN_LIST_ROWS) return []
  const pitches = new Map<number, number>()
  for (let index = 1; index < clusters.length; index++) {
    const delta = clusters[index].y - clusters[index - 1].y
    if (delta < PITCH_TOLERANCE * 3) continue
    const bucket = Math.round(delta / PITCH_TOLERANCE) * PITCH_TOLERANCE
    pitches.set(bucket, (pitches.get(bucket) ?? 0) + 1)
  }
  const [pitch, count] = [...pitches.entries()].sort((left, right) => right[1] - left[1])[0] ?? [0, 0]
  if (!pitch || count < MIN_LIST_ROWS - 1) return []
  return clusters
    .filter(entry => Math.abs((entry.y - clusters[0].y) % pitch) <= PITCH_TOLERANCE)
    .map(entry => entry.cluster)
}

/**
 * True when geometric candidates are worth paying for: either the goal names a
 * label the tree exposes without an action, or it names a position in a list
 * that the tree shows but does not address.
 */
export function wantsGeometry(observation: CuaObservation, goal: string, readOnly: boolean): boolean {
  if (readOnly || !goal.trim()) return false
  if (positionalIntent(goal) && listRows(observation).length >= MIN_LIST_ROWS) return true
  return observation.elements.some(element => {
    const label = (element.label ?? element.value ?? "").trim()
    if (label.length < MIN_LABEL || !goal.includes(label)) return false
    if (!frameOf(element.frame)) return false
    return !element.actions.some(action => /^AXPress$/i.test(action))
  })
}

export function geometricCandidates(observation: CuaObservation, goal: string, readOnly: boolean): CuaCandidate[] {
  if (readOnly || !observation.captureId || !goal.trim()) return []
  const members = candidatesFrom(observation)
  const scored = members
    .map(member => ({ member, score: match(member.label, goal) }))
    .filter(entry => entry.score > 0)
    // A named label that shares its baseline with another label is part of a
    // row; a named label on its own is a control. Both are addressable by
    // coordinates, but the row case is the one accessibility refuses to expose.
    .map(entry => ({ ...entry, inRow: adjacentOnRow(entry.member, members) }))
    .sort((left, right) => right.score - left.score || left.member.frame.y - right.member.frame.y)
    .slice(0, MAX_GEOMETRIC)
  const seen = new Set<string>()
  const candidates: CuaCandidate[] = []
  /** Rows chosen because the goal names a position rather than a label. */
  const positional = scored.length ? [] : orderedRows(observation, goal)
  for (const entry of [...scored.map(item => ({ member: item.member, inRow: item.inRow })), ...positional.map(member => ({ member, inRow: true }))]) {
    const { member, inRow } = entry
    const { x, y } = pointerPoint(member.frame, observation)
    const identity = `geo:${member.label}:${Math.round(member.frame.y)}`
    if (seen.has(identity)) continue
    seen.add(identity)
    candidates.push({
      id: `geo.${Math.round(member.frame.y)}.${Math.round(member.frame.x)}`,
      description: `${inRow ? "click the centre of the row containing" : "click"} "${member.label}" at ${x},${y} with a real pointer; accessibility exposes no action for it, so this is the only route and its effect must be verified afterwards`,
      source: "ax",
      operation: "click",
      tool: "click",
      args: {
        x,
        y,
        capture_id: observation.captureId,
        pid: observation.pid,
        window_id: observation.windowId,
        delivery_mode: "foreground",
      },
      label: member.label,
      identity: `${identity}:px`,
      escalated: true,
      legacyOperation: "CLICK",
    })
  }
  return candidates
}

/** The row a positional goal points at: the first or last of the detected list. */
function orderedRows(observation: CuaObservation, goal: string): Member[] {
  const intent = positionalIntent(goal)
  if (!intent) return []
  const rows = listRows(observation)
  if (rows.length < MIN_LIST_ROWS) return []
  const ordered = [...rows].sort((left, right) => Math.min(...left.map(member => member.frame.y)) - Math.min(...right.map(member => member.frame.y)))
  const chosen = intent === "first" ? ordered.slice(0, 2) : ordered.slice(-2).reverse()
  // Anchor each row at its leftmost label: that is the row's own name, and the
  // right-hand labels are usually links that navigate somewhere else.
  return chosen.map(row => [...row].sort((left, right) => left.frame.x - right.frame.x)[0])
}

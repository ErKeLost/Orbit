import type { TextSlot } from "../gui-task-contract.ts"
import type { EscalationRung } from "../cua/errors.ts"
import { elementLabel, editableElements } from "../cua/observation.ts"
import type { CuaCandidate, CuaObservation, VisualRegion } from "../cua/types.ts"
import { hasPress, hasShowMenu, isActionable, isTextRole, roleClass } from "./roles.ts"
import { isRisky } from "./policy.ts"

/**
 * Candidate sources.
 *
 * Every candidate is a COMPLETE action (tool + frozen arguments) built by this
 * code before the chooser sees anything. The chooser receives opaque ids and
 * descriptions; it can never widen the action space, invent a tool, or supply a
 * coordinate.
 */

export type BuildContext = {
  goal: string
  readOnly: boolean
  pid: number
  windowId: number
  textSlots: readonly TextSlot[]
  usedSlotIds: ReadonlySet<string>
  /** A text operation was just delivered, so Return is a real next step. */
  allowEnter: boolean
  /** Token of the field the last text operation targeted. */
  lastTypedToken?: string
  /** Unstripped rows, kept so a menu-bar command can be addressed by path. */
  allElements: readonly CuaElementLike[]
  /**
   * Rungs the driver recommended after refusing a background action, keyed by
   * the target identity it refused. The contract is explicit: a background
   * refusal is never retried in the foreground implicitly, so the next rung is
   * offered as a *separate* candidate the chooser must pick.
   */
  escalate?: ReadonlyMap<string, EscalationRung>
  /** Present only when the visual fallback was explicitly enabled and used. */
  visual?: { captureId: string; regions: readonly VisualRegion[] }
  /**
   * The loop's offer-set cap hid candidates. Scrolling is then the only way to
   * reveal what was hidden, so the scroll candidates are built even when the
   * accessibility walk itself was complete.
   */
  forceScroll?: boolean
}

type CuaElementLike = CuaObservation["elements"][number]

/** The maximum number of menu-bar commands offered, so they never crowd a window. */
const MAX_MENU_CANDIDATES = 3

/** Operations that can be re-delivered through the driver's next rung. */
const ESCALATABLE_OPERATIONS = new Set(["click", "right_click", "type_text", "set_value", "scroll"])

export function buildCandidates(observation: CuaObservation, context: BuildContext): CuaCandidate[] {
  const seen = new Set<string>()
  const candidates: CuaCandidate[] = []
  // One identity per element, computed once: the same map is what the verifier
  // uses to find the target again in the successor observation.
  const identities = elementIdentities(observation.elements)

  const push = (candidate: CuaCandidate) => {
    let id = candidate.id
    for (let suffix = 2; seen.has(id); suffix++) id = `${candidate.id}-${suffix}`
    seen.add(id)
    candidates.push({ ...candidate, id })
  }
  /** Push a candidate, and its explicit next-rung twin when the driver asked for one. */
  const pushEscalated = (candidate: CuaCandidate, frame: CuaElementLike["frame"]) => {
    push(candidate)
    const rung = candidate.identity ? context.escalate?.get(candidate.identity) : undefined
    // The pointer rung is capture-bound, so the twin needs the capture the
    // coordinates were read from, not just the frame.
    const twin = escalatedTwin(candidate, rung, { windowId: context.windowId, pid: context.pid, frame, captureId: observation.captureId })
    if (twin) push(twin)
  }

  // Menu-bar commands, only when the goal names the command.
  for (const menu of menuCandidates(context)) push(menu)

  // Text entries first: they are the reason most gui_task runs exist.
  const slot = context.readOnly ? undefined : context.textSlots.find(item => !context.usedSlotIds.has(item.id))
  if (slot) {
    for (const element of editableElements(observation.elements)) {
      const label = elementLabel(element)
      const info = identities.get(element) ?? { identity: identityOf("text_entry", label), count: 1 }
      pushEscalated({
        id: candidateId("ax", "text_entry", label, element.elementIndex),
        description: `text_entry ${label ? `"${clip(label, 60)}"` : "(unlabelled)"}${element.inWebContent ? " in web content" : ""}${siblingNote(info)}; enter the caller-prepared text for ${clip(slot.description, 60)} (slot ${slot.id}) through this element's own text capability`,
        source: "ax",
        operation: "type_text",
        tool: "type_text",
        args: { element_token: element.elementToken, text: slot.value, delivery_mode: "background" },
        elementToken: element.elementToken,
        identity: info.identity,
        slotId: slot.id,
        label,
        risky: isRisky(label),
        legacyOperation: "TYPE_TEXT",
      }, element.frame)
    }
  }

  // Pressable controls and context-menu-only controls are mutually exclusive:
  // an element that declares a press gets `click`, an element that only
  // declares a menu gets `right_click`. Offering both for one element is the
  // "two options that mean the same thing" that depresses confidence.
  for (const element of observation.elements) {
    if (element.enabled === false) continue
    const cls = roleClass(element.role)
    // A text entry never also gets a `click`: `type_text` already focuses and
    // fills it, so a second candidate for the same element is the near-duplicate
    // that splits the choice and, once the field holds the text, can only
    // produce a no-effect click.
    if (cls === "text_entry") continue
    if (!isActionable(cls) && !isTextRole(cls)) continue
    const label = elementLabel(element)
    if (!label && !element.inWebContent) continue
    const info = identities.get(element) ?? { identity: identityOf(cls, label), count: 1 }
    const press = hasPress(element.actions)
    const menu = hasShowMenu(element.actions)
    const base = { elementToken: element.elementToken, label, identity: info.identity, risky: isRisky(label) } as const
    if (element.inWebContent && /^axmenuitem$/i.test(element.role) && press) {
      push({ ...base, id: candidateId("ax", cls, label, element.elementIndex), description: `${cls} "${clip(label ?? "", 70)}" in the open menu${menu ? " (also has a submenu)" : ""}${siblingNote(info)}; press it to choose this command`, source: "ax", operation: "click", tool: "click", args: { element_token: element.elementToken, action: "press" }, legacyOperation: "CLICK" })
      continue
    }
    if (press) {
      pushEscalated({ ...base, id: candidateId("ax", cls, label, element.elementIndex), description: `${cls} "${clip(label ?? "(unlabelled)", 70)}"${element.selected ? " (currently selected)" : ""}${siblingNote(info)}; press it through its native semantic action`, source: "ax", operation: "click", tool: "click", args: { element_token: element.elementToken, action: "press" }, legacyOperation: cls === "row" ? "DOUBLE_CLICK" : "CLICK" }, element.frame)
    }
    if (menu && !press) {
      pushEscalated({ ...base, id: candidateId("ax", cls, label, element.elementIndex), description: `${cls} "${clip(label ?? "(unlabelled)", 70)}"${siblingNote(info)}; open its context menu without choosing any item yet`, source: "ax", operation: "right_click", tool: "right_click", args: { element_token: element.elementToken }, legacyOperation: "RIGHT_CLICK" }, element.frame)
    }
  }

  // Return submits the text the previous step entered.
  if (context.allowEnter && context.lastTypedToken) {
    push({
      id: "ax.key.return",
      description: "press_key Return on the field the previous step filled, to submit the prepared text",
      source: "ax",
      operation: "press_key",
      tool: "press_key",
      args: { key: "return", element_token: context.lastTypedToken },
      elementToken: context.lastTypedToken,
      identity: "key:return",
      legacyOperation: "PRESS_ENTER",
    })
  }

  // Escape closes whatever is in front.
  if (observation.overlay) {
    push({
      id: "ax.key.escape",
      description: `press_key Escape to close the open ${observation.overlay} without choosing any of its items`,
      source: "ax",
      operation: "press_key",
      tool: "press_key",
      args: { key: "escape", pid: context.pid, window_id: context.windowId },
      identity: "key:escape",
      legacyOperation: "DISMISS",
    })
  }

  // A partial walk justifies scrolling. So does a capped offer set: the cap
  // hides candidates the window really has, and scrolling is what reveals them.
  if (context.forceScroll || (observation.truncated && !observation.complete)) {
    const capped = context.forceScroll === true && observation.complete
    for (const direction of ["down", "up"] as const) {
      pushEscalated({
        id: `ax.scroll.${direction}`,
        description: capped
          ? `scroll the window ${direction}; the offer set was capped, so the list that was shown is not the whole window`
          : `scroll the window ${direction}; the accessibility walk found more content than it could return`,
        source: "ax",
        operation: "scroll",
        tool: "scroll",
        args: { direction, amount: 3, by: "line", pid: context.pid, window_id: context.windowId },
        identity: `scroll:${direction}`,
        legacyOperation: direction === "down" ? "SCROLL_DOWN" : "SCROLL_UP",
      }, undefined)
    }
  }

  // Visual fallback: only when the accessibility source found no usable target
  // for a step, and only for regions whose text matches the goal exactly.
  if (context.visual) candidates.push(...buildVisualCandidates(context.visual, context))

  // Reserved. Their ids are the contract's; always last.
  push({ id: "done", description: "every part of the goal is visibly satisfied on this screen right now; finish the task", source: null, operation: "done", tool: null, args: {}, label: "完成", legacyOperation: "DONE" })
  push({ id: "reobserve", description: "read the window again; nothing is changed (use when the screen is still loading or the last action's effect is not visible yet)", source: null, operation: "reobserve", tool: null, args: {}, label: "重新观察", legacyOperation: "WAIT" })
  push({ id: "abstain", description: "stop: no supplied action can safely advance the goal from this screen", source: null, operation: "abstain", tool: null, args: {}, label: "停止", legacyOperation: "BLOCKED" })
  return candidates
}

/**
 * The explicit next rung the driver asked for.
 *
 * Only built when the driver refused the *background* route for this exact
 * target, so the offer set stays small in the normal case. It carries its own id
 * and identity, so quarantining the refused background attempt cannot also hide
 * the rung that might work.
 *
 * Two rungs are built, and they are not the same action:
 *
 * - `foreground` re-runs the same semantic operation with the window raised.
 * - `px` is a pointer delivery at the target's observed centre. It is kept as
 *   its own candidate with its own id and description rather than being folded
 *   into the foreground twin, because a pointer click is not a semantic press
 *   and the chooser must be told which one it is choosing. A pointer click is
 *   also **capture-bound** — the driver addresses it by `x,y` plus the
 *   `capture_id` those coordinates were read from — so the twin is only built
 *   when a frame *and* a capture id are known. A candidate that cannot be
 *   delivered is worse than no candidate: it spends the chooser's turn on a
 *   certain refusal, so the px twin is dropped instead.
 */
export function escalatedTwin(candidate: CuaCandidate, rung: EscalationRung | undefined, geometry: { windowId: number; pid: number; frame?: CuaElementLike["frame"]; captureId?: string }): CuaCandidate | undefined {
  if (!rung || !ESCALATABLE_OPERATIONS.has(candidate.operation)) return undefined
  if (rung === "foreground") {
    return {
      ...candidate,
      id: `${candidate.id}.fg`,
      description: `${candidate.description} — FOREGROUND: this one action raises the window and then restores the previous app; choose it only because the background route was refused`,
      args: { ...candidate.args, delivery_mode: "foreground", window_id: candidate.args.window_id ?? geometry.windowId },
      identity: candidate.identity ? `${candidate.identity}:fg` : undefined,
      escalated: true,
    }
  }
  if (rung === "px") {
    const frame = geometry.frame
    // A pointer delivery is capture-bound: `x,y` without the `capture_id` they
    // came from is not something the driver can execute. Dropping the twin when
    // either is missing is honest: a candidate that is certain to be refused is
    // worse than no candidate, because it spends the chooser's turn and the
    // escalation ladder then has nothing left to offer.
    if (!frame || !geometry.captureId) return undefined
    const x = Math.round(frame.x + frame.w / 2)
    const y = Math.round(frame.y + frame.h / 2)
    const args = { ...candidate.args } as Record<string, unknown>
    delete args.element_token
    return {
      ...candidate,
      id: `${candidate.id}.px`,
      description: `${candidate.description} — POINTER: the background route was refused and the driver recommends pointer delivery, so this clicks the observed centre of the target (${x},${y}) with a real pointer; choose it only because the background route was refused`,
      args: { ...args, x, y, capture_id: geometry.captureId, pid: geometry.pid, window_id: geometry.windowId, delivery_mode: "foreground" },
      identity: candidate.identity ? `${candidate.identity}:px` : undefined,
      escalated: true,
    }
  }
  // "page" is a route this engine does not build; the driver would need a page
  // handle the loop has no way to name, so it is left out rather than guessed.
  return undefined
}

/**
 * Menu-bar commands whose leaf label the goal names. Bounded, so the menu tree
 * never floods the offer set; an unmentioned command stays reachable by
 * rephrasing the goal.
 */
export function menuCandidates(context: BuildContext): CuaCandidate[] {
  const goal = context.goal.toLowerCase()
  const results: CuaCandidate[] = []
  for (const element of context.allElements) {
    if (!/^axmenuitem$/i.test(element.role)) continue
    const label = elementLabel(element)
    if (!label || !goal.includes(label.toLowerCase())) continue
    const path = menuPath(context.allElements, element)
    if (path.length < 2) continue
    results.push({
      id: candidateId("ax", "menu_item", path.join(">"), element.elementIndex),
      description: `menu command "${path.join(" > ")}" from the application menu bar`,
      source: "ax",
      operation: "menu",
      tool: "invoke_menu",
      args: { pid: context.pid, window_id: context.windowId, path },
      elementToken: element.elementToken,
      identity: `menu:${path.join(">")}`,
      label,
      risky: isRisky(label),
      legacyOperation: "MENU_ITEM",
    })
    if (results.length >= MAX_MENU_CANDIDATES) break
  }
  return results
}

/** Walk `parentIndex` to the top-level menu bar item to build an exact path. */
export function menuPath(elements: readonly CuaElementLike[], element: CuaElementLike): string[] {
  const byIndex = new Map(elements.map(item => [item.elementIndex, item]))
  const path: string[] = []
  let current: CuaElementLike | undefined = element
  let guard = 0
  while (current && guard++ < 16) {
    const label = elementLabel(current)
    if (label && !/^axmenu$/i.test(current.role)) path.unshift(label)
    current = current.parentIndex === undefined ? undefined : byIndex.get(current.parentIndex)
  }
  return path
}

/**
 * A visual target must be an exact, unique text match above the confidence
 * floor, and is addressed by a capture-bound pointer click at its centre.
 */
export function buildVisualCandidates(visual: { captureId: string; regions: readonly VisualRegion[] }, context: BuildContext): CuaCandidate[] {
  const wanted = context.textSlots.map(slot => slot.value).filter(Boolean)
  const results: CuaCandidate[] = []
  for (const region of visual.regions) {
    const text = region.text ?? region.label
    if (!text) continue
    if (region.confidence < 0.8) continue
    if (!region.interactive && !wanted.some(value => value === text)) continue
    const matches = visual.regions.filter(other => (other.text ?? other.label) === text)
    if (matches.length !== 1) continue
    results.push({
      id: candidateId("visual", region.kind, text, 0),
      description: `visual ${region.kind} "${clip(text, 60)}" at ${Math.round(region.bounds.x)},${Math.round(region.bounds.y)}; pointer-click its centre (accessibility did not name this control)`,
      source: "visual",
      operation: "click",
      tool: "click",
      args: {
        x: Math.round(region.bounds.x + region.bounds.w / 2),
        y: Math.round(region.bounds.y + region.bounds.h / 2),
        capture_id: visual.captureId,
        pid: context.pid,
        window_id: context.windowId,
        delivery_mode: "background",
      },
      identity: `visual:${region.kind}:${text}`,
      label: text,
      legacyOperation: "CLICK",
    })
    if (results.length >= 8) break
  }
  return results
}

/** ASCII-only, snapshot-stable id. Labels are hashed, so non-ASCII is fine. */
export function candidateId(source: string, cls: string, label: string | undefined, ordinal: number): string {
  const safe = cls.replace(/[^a-z0-9_]/gi, "_")
  const digest = fnv1a(`${label ?? ""}|${ordinal}`).toString(16).padStart(8, "0").slice(0, 8)
  return `${source}.${safe}.${digest}`
}

/**
 * The stable identity of a target across snapshots.
 *
 * A positional suffix is added only when more than one element shares the role
 * and label. Without it, a list of thirty rows each labelled "更多" collapses to
 * one identity: quarantining one wrong click would withhold the *correct*
 * sibling too, and the repeat brake would count different rows as one. The
 * suffix is the occurrence among same-role same-label elements in tree order —
 * not the snapshot's `elementIndex`, which is renumbered by any insertion — so
 * inserting an unrelated element does not renumber the siblings. A label that
 * occurs once keeps its bare identity, which is what the quarantine and repeat
 * brakes already rely on.
 */
export function identityOf(cls: string, label: string | undefined, ordinal?: number): string {
  const base = `${cls}:${label ?? "#"}`
  return ordinal === undefined ? base : `${base}#${ordinal}`
}

export type ElementIdentity = {
  identity: string
  /** Present only when more than one element shares this role and label. */
  ordinal?: number
  count: number
}

/** One identity per element of an observation, in tree order. */
export function elementIdentities(elements: readonly CuaElementLike[]): Map<CuaElementLike, ElementIdentity> {
  const parts = elements.map(element => ({ cls: roleClass(element.role), label: elementLabel(element) }))
  const counts = new Map<string, number>()
  for (const part of parts) {
    const key = `${part.cls}\u0000${part.label ?? ""}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const seen = new Map<string, number>()
  const out = new Map<CuaElementLike, ElementIdentity>()
  elements.forEach((element, index) => {
    const { cls, label } = parts[index]!
    const key = `${cls}\u0000${label ?? ""}`
    const occurrence = seen.get(key) ?? 0
    seen.set(key, occurrence + 1)
    const count = counts.get(key) ?? 1
    out.set(element, count > 1
      ? { identity: identityOf(cls, label, occurrence), ordinal: occurrence, count }
      : { identity: identityOf(cls, label), count })
  })
  return out
}

/** Index one observation's elements by the identity the candidates carry. */
export function indexByIdentity(elements: readonly CuaElementLike[]): Map<string, CuaElementLike> {
  const out = new Map<string, CuaElementLike>()
  for (const [element, info] of elementIdentities(elements)) if (!out.has(info.identity)) out.set(info.identity, element)
  return out
}

/** The positional hint that lets a chooser tell identical siblings apart. */
function siblingNote(info: ElementIdentity): string {
  return info.ordinal === undefined ? "" : ` (${info.ordinal + 1} of ${info.count} controls with the same label)`
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

import { createHash } from "node:crypto"
import type { CuaDriver } from "./driver.ts"
import type { CuaElement, CuaObservation } from "./types.ts"
import { isTextRole, roleClass, type RoleClass } from "../candidates/roles.ts"

/** Budgets chosen so the walk finishes and says so, rather than silently cutting. */
const MAX_ELEMENTS = 2_500
const WALK_TIMEOUT_MS = 6_000

export type ObserveInput = {
  pid: number
  windowId: number
  /** Screenshots are opt-in: only the visual fallback needs pixels. */
  includeScreenshot?: boolean
  timeoutMs?: number
}

/**
 * One observation: the driver's element rows become a compact table the chooser
 * can read, plus the lines that make a screen signature.
 *
 * The driver returns EMPTY elements with `degraded_reason: ax_window_unresolved`
 * when the window's accessibility surface cannot be resolved. That is reported
 * as `complete: false` with no elements — never as "this window is empty".
 */
export async function observe(driver: CuaDriver, input: ObserveInput): Promise<CuaObservation> {
  const raw = await driver.getWindowState({
    pid: input.pid,
    windowId: input.windowId,
    includeAccessibilityTree: true,
    includeScreenshot: input.includeScreenshot === true,
    treeFormat: "elements",
    maxElements: MAX_ELEMENTS,
    timeoutMs: input.timeoutMs ?? WALK_TIMEOUT_MS,
  })
  const degradedReason = typeof raw.raw.degraded_reason === "string" ? raw.raw.degraded_reason : undefined
  const degraded = Boolean(degradedReason)
  const elements = stripMenuBar(raw.elements)
  const overlay = detectOverlay(elements)
  const lines = elements.map(describeElement)
  const context = buildContext(raw, elements, lines, { degraded, overlay, complete: raw.elementsComplete })
  return {
    pid: input.pid,
    windowId: input.windowId,
    app: raw.appName,
    title: raw.windowTitle,
    elements,
    complete: raw.elementsComplete && !degraded,
    truncated: raw.truncated || !raw.elementsComplete,
    total: raw.totalElementCount,
    snapshotId: raw.snapshotId,
    captureId: raw.captureId,
    screenshot: raw.screenshot ? { width: raw.screenshot.width, height: raw.screenshot.height } : undefined,
    context,
    lines,
    fingerprint: createHash("sha1").update(`${raw.appName}\u0000${raw.windowTitle}\u0000${lines.join("\n")}`).digest("hex"),
    overlay,
    ...(degradedReason ? { degradedReason } : {}),
    capturedAt: Date.now(),
  }
}

/**
 * Drop the always-present menu bar subtree. It is 40–60% of a macOS window's
 * rows and none of it is on screen; an open popup menu is *not* under the menu
 * bar and is kept, because its items are the point of the current screen.
 */
export function stripMenuBar(elements: readonly CuaElement[]): CuaElement[] {
  const kept: CuaElement[] = []
  let skipDeeperThan = Number.POSITIVE_INFINITY
  for (const element of elements) {
    if (element.depth <= skipDeeperThan && skipDeeperThan !== Number.POSITIVE_INFINITY) skipDeeperThan = Number.POSITIVE_INFINITY
    if (skipDeeperThan !== Number.POSITIVE_INFINITY && element.depth > skipDeeperThan) continue
    if (/^axmenubar$/i.test(element.role.trim())) {
      skipDeeperThan = element.depth
      continue
    }
    kept.push(element)
  }
  return kept
}

const OVERLAY_ROLES = /^(axsheet|axdialog|axpopover|axalert|axmenu|sheet|dialog|popover|alert|menu)$/i

/** A popup/dialog currently in front, so Escape is a real option. */
export function detectOverlay(elements: readonly CuaElement[]): string | undefined {
  const found = elements.find(element => OVERLAY_ROLES.test(element.role.trim()))
  return found ? found.role : undefined
}

/** The short, stable line for one element: role class, label, value, actions. */
export function describeElement(element: CuaElement): string {
  const cls = roleClass(element.role)
  const label = element.label ?? element.valueDescription
  const value = element.value
  const parts = [`[${element.elementIndex}] ${cls}`]
  if (label) parts.push(`"${clip(label, 80)}"`)
  if (value && value !== label) parts.push(`holds="${clip(value, 80)}"`)
  const actions = element.actions.filter(Boolean)
  if (actions.length) parts.push(actions.map(action => action.replace(/^AX/, "")).join(","))
  if (element.inWebContent) parts.push("web")
  return parts.join(" ")
}

function buildContext(
  raw: { appName: string; windowTitle: string; totalElementCount: number; elementsComplete: boolean },
  elements: readonly CuaElement[],
  lines: readonly string[],
  facts: { degraded: boolean; overlay?: string; complete: boolean },
): string {
  const header = [
    `app=${raw.appName}`,
    `window=${raw.windowTitle}`,
    `elements=${elements.length}${facts.complete ? "" : ` of ${raw.totalElementCount} (partial)`}`,
    facts.degraded ? "degraded=ax_window_unresolved (the accessibility surface for this window is not resolvable right now)" : undefined,
    facts.overlay ? `overlay=${facts.overlay} (Escape closes it)` : undefined,
  ].filter(Boolean).join("\n")
  return `${header}\nelements:\n${lines.join("\n")}`
}

/** The editable controls on this screen, in tree order. */
export function editableElements(elements: readonly CuaElement[]): CuaElement[] {
  return elements.filter(element => isTextRole(roleClass(element.role)) && element.enabled !== false && element.actions.length > 0)
}

export function elementLabel(element: CuaElement): string | undefined {
  const label = element.label ?? element.valueDescription ?? element.value
  return label?.trim() ? label.trim() : undefined
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

export type { RoleClass }

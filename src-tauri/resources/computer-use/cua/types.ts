import type { DesktopOperation } from "../gui-task-contract.ts"

/** Which perception produced a candidate. `visual` is the extension fallback. */
export type CandidateSourceKind = "ax" | "visual" | "page"

/**
 * The closed operation vocabulary sent to the chooser. It is deliberately
 * smaller than the old `DesktopOperation`: the driver owns the action ladder,
 * so escalation is a *new candidate* on the next turn, never a hidden retry.
 */
export type CuaOperation =
  | "click"
  | "double_click"
  | "right_click"
  | "type_text"
  | "set_value"
  | "press_key"
  | "hotkey"
  | "scroll"
  | "menu"
  | "done"
  | "reobserve"
  | "abstain"

/** An action the runner has fully built. The chooser only ever sees `id`. */
export type CuaCandidate = {
  id: string
  description: string
  source: CandidateSourceKind | null
  operation: CuaOperation
  /** MCP tool name, or null for a reserved candidate. */
  tool: string | null
  /** Frozen, complete arguments. Never edited after construction. */
  args: Readonly<Record<string, unknown>>
  /** Snapshot-bound handle, for quarantine by stable identity. */
  elementToken?: string
  /** Stable identity across snapshots, used for quarantine and repeat brakes. */
  identity?: string
  /** Local text slot this candidate would deliver. */
  slotId?: string
  /** Label carried for evidence and diagnostics only; never sent as an id. */
  label?: string
  /** Policy: requires explicit allowance in the goal or the run is read-only. */
  risky?: boolean
  /** A last-resort candidate that changes the interface (foreground delivery). */
  escalated?: boolean
  /** The old operation name, so trace/failure reporting stays familiar. */
  legacyOperation: DesktopOperation
}

export type VisualRegion = {
  id: string
  kind: "text" | "icon"
  text?: string
  label?: string
  confidence: number
  interactive: boolean
  bounds: { x: number; y: number; w: number; h: number }
}

export type CuaFocus = {
  token?: string
  role: string
  label?: string
  holds?: string
  identity?: string
}

export type CuaObservation = {
  pid: number
  windowId: number
  app: string
  title: string
  elements: CuaElement[]
  focus?: CuaFocus
  /** Complete=false means the walk was cut; an empty area cannot be concluded. */
  complete: boolean
  truncated: boolean
  total: number
  snapshotId?: string
  captureId?: string
  screenshot?: { width: number; height: number }
  /** Compact table handed to the chooser. */
  context: string
  /** The same content as lines, for screen signatures and stall detection. */
  lines: string[]
  fingerprint: string
  /** True when a dialog/sheet/menu/popover is open, so Escape is offered. */
  overlay?: string
  /** The driver's own degraded reason, e.g. ax_window_unresolved. */
  degradedReason?: string
  capturedAt: number
}

/** Minimal shape of one driver element row, kept structurally compatible. */
export type CuaElement = {
  elementIndex: number
  elementToken?: string
  role: string
  depth: number
  parentIndex?: number
  label?: string
  value?: string
  valueDescription?: string
  enabled?: boolean
  selected?: boolean
  inWebContent?: boolean
  actions: string[]
  frame?: { x: number; y: number; w: number; h: number }
}

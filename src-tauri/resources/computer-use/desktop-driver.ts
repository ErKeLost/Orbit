/**
 * Desktop driver protocol: the JSON-lines contract between the gui_task
 * engine and the native macOS accessibility worker (`ax_control`, Rust).
 * One implementation ships (xa11y-client.ts); tests and the fixture
 * benchmark provide in-memory drivers with the same shape.
 */

export type DesktopError = {
  code: string
  message: string
  suggestion?: string
  details?: unknown
  disposition?: { delivery?: string; retry?: string }
}

export type DesktopEnvelope<T = Record<string, unknown>> = {
  version: string
  ok: boolean
  command: string
  data?: T
  error?: DesktopError
}

export type DesktopBounds = { x: number; y: number; width: number; height: number }
export type DesktopNode = {
  role: string
  name?: string
  description?: string
  value?: string
  ref_id?: string
  native_id?: { kind: string; value: string }
  states?: string[]
  available_actions?: string[]
  bounds?: DesktopBounds
  children_count?: number
  children?: DesktopNode[]
}

export type SnapshotData = {
  app: string
  window: { id: string; title: string }
  snapshot_id?: string
  complete: boolean
  truncated?: boolean
  nodes_observed?: number
  ref_count: number
  tree: DesktopNode
}

export type LaunchData = {
  app: string
  pid: number
  process_instance?: string
  window?: { id: string; title: string }
  renderer?: string
}

export class DesktopCommandError extends Error {
  constructor(
    readonly command: string,
    readonly detail: DesktopError,
  ) {
    super(`${command} failed (${detail.code}): ${detail.message}${detail.suggestion ? ` ${detail.suggestion}` : ""}`)
    this.name = "DesktopCommandError"
  }

  get safeToRetry(): boolean {
    return this.detail.disposition?.retry === "safe"
  }
}

export interface DesktopDriver {
  run<T>(args: string[], options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<DesktopEnvelope<T>>
  dispose(): Promise<void>
}

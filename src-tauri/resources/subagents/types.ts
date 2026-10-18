/**
 * Shared wire types for the Pi sub-agent runtime and Orbit's activity panel.
 * Keep these types JSON-safe: the same snapshot crosses the extension/RPC
 * boundary and is consumed by the webview.
 */
export type AgentStatus = "queued" | "running" | "completed" | "failed" | "aborted"

export interface AgentNode {
  id: string
  parentId: string | null
  /** Canonical path, e.g. `/root/arch_pipeline`. Codex-style agent identity. */
  path: string
  name: string
  task: string
  status: AgentStatus
  summary: string
  startedAt: number
  /**
   * The top-level user turn this worker was spawned in. The published snapshot
   * keeps only this turn's settled workers, so a new message never shows the
   * previous turn's sub-agents. Internal to the runtime; not part of the wire
   * contract the GUI reads.
   */
  turn?: number
  endedAt?: number
  model?: string
  /** 头像图标（Iconify 名字），模型在 spawn 时给的；不存在就回落中性图标。 */
  logo?: string
  pid?: number
  sessionId?: string
  sessionPath?: string
  childrenIds: string[]
  children?: AgentNode[]
  error?: string
}

export interface AgentSnapshot {
  version: 1
  rootId: string
  active: AgentNode[]
  recent: AgentNode[]
  updatedAt: number
}

export interface AgentResult {
  agent: AgentNode
  output: string
  snapshot: AgentSnapshot
  usage?: Record<string, unknown>
}

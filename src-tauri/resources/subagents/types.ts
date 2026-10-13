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
  endedAt?: number
  model?: string
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

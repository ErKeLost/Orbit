import { randomUUID } from "node:crypto"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core"
import { filterForkSession } from "./fork.ts"
import { modelReference, type WorkerModel } from "./model-ref.ts"
import { joinAgentPath, resolveAgentPath, ROOT_PATH, validateAgentName } from "./paths.ts"
import { TreeSlots } from "./tree-slots.ts"
import type { AgentNode, AgentResult, AgentSnapshot, AgentStatus } from "./types.ts"

type PublishSnapshot = (snapshot: AgentSnapshot) => void

/**
 * Pushes a finished worker's result back into the supervisor's own context.
 *
 * This is the asynchronous half of the Codex collaboration model: `spawn_agent`
 * returns as soon as the worker is running, and the result arrives later as an
 * injected message rather than as a tool result. The host wires this to
 * `pi.sendMessage()`, which owns turn triggering and queueing.
 */
export type DeliverResult = (node: AgentNode, output: string) => void

export interface RuntimeOptions {
  deliver?: DeliverResult
  /**
   * Whether to strip tool payloads from the inherited history. Codex forks only
   * the conversation and drops tool calls/results; set false to inherit the raw
   * parent session file instead.
   */
  filterFork?: boolean
  /** This process's own canonical agent path. Defaults to `PI_GUI_AGENT_PATH` or `/root`. */
  selfPath?: string
}
type ChildEvent = Record<string, unknown> & { type?: string; id?: string; command?: string; success?: boolean }

/**
 * How a child worker receives the parent conversation.
 *
 * - `inherit` forks the parent session file when the worker starts, so it sees
 *   the parent's complete message history (tool results included) and keeps a
 *   `parentSession` lineage header. Pi owns the context window and compaction;
 *   Orbit never re-serializes the transcript.
 * - `isolated` starts an empty session. The worker only sees the delegated
 *   task, which keeps cost flat for independent work and lets the supervisor
 *   decide exactly what background to hand over.
 */
export type AgentContextMode = "inherit" | "isolated"

export interface TaskInput {
  name?: string
  task: string
  cwd?: string
  /** Provider and id travel apart; see `model-ref.ts` for why. */
  model?: WorkerModel
  thinking?: string
  context?: AgentContextMode
}

export interface SpawnOptions extends TaskInput {
  parentId?: string
}

interface ChildResponse {
  success?: boolean
  data?: unknown
  error?: string
}

interface PendingRequest {
  resolve: (value: ChildResponse) => void
  reject: (error: Error) => void
}

interface ChildHandle {
  process: ChildProcessWithoutNullStreams
  pending: Map<string, PendingRequest>
  buffer: string
  output: string
  streamingText: string
  streamingThinking: string
  lastProgress: string
  settled: Promise<void>
  settle: () => void
  resetSettled: () => void
  settledDone: boolean
  closed: Promise<void>
  markClosed: () => void
  exited: boolean
  detachAbort?: () => void
  failure?: { status: "failed" | "aborted"; message: string }
  usage?: Record<string, unknown>
  /** Whether this worker inherited the supervisor's history through a fork. */
  inherited: boolean
  /** Messages sent while the worker was idle; flushed into its next prompt. */
  queued: string[]
  /** Tail of the worker's stderr, kept so a failure can be explained. */
  stderr: string
  /** Armed while the worker is settled and idle; reclaims the process on expiry. */
  idleTimer?: ReturnType<typeof setTimeout>
}

const TERMINAL_STATUSES = new Set<AgentStatus>(["completed", "failed", "aborted"])
/** Workers that may run at once. Advertised to the model in the agent instructions. */
export const MAX_ACTIVE_CHILDREN = 8
/** Workers kept alive for follow-up work; settled ones are evicted oldest-first. */
const MAX_LIVE_CHILDREN = 12
const CHILD_EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "entry.ts")
/** Shared tree budget: children inherit the directory and the limit through the environment. */
const TREE_DIR_ENV = "PI_GUI_AGENT_TREE_DIR"
const TREE_LIMIT_ENV = "PI_GUI_AGENT_TREE_LIMIT"

/**
 * Built-in extensions every worker keeps.
 *
 * `--no-extensions` disables extension *discovery* and built-in extensions in
 * one switch. That is what stops Orbit's own GUI extension (and any user or
 * project extension) from registering itself inside a worker, but it also
 * strips the capabilities that make a worker as capable as its supervisor.
 * Re-adding the built-ins explicitly restores them without turning discovery
 * back on.
 *
 * `builtin:tool-search` registers inactive and is activated by the MCP
 * extension when a server declares `exposure: "deferred"`. `builtin:llama.cpp`
 * is kept so a worker can resolve a model the supervisor runs locally.
 */
const CHILD_BUILTIN_EXTENSIONS = ["builtin:mcp", "builtin:codemode", "builtin:tool-search", "builtin:llama.cpp"]
/** Bytes of a worker report the supervisor sees. Codex does not truncate; we do,
 * because one verbose worker can otherwise eat the supervisor's context. */
function modelOutputLimitBytes(): number {
  const configured = Number(process.env.ORBIT_PI_AGENT_OUTPUT_LIMIT_BYTES)
  return Number.isFinite(configured) && configured > 0 ? configured : 50 * 1024
}
const DEFAULT_WAIT_TIMEOUT_MS = 30_000
/**
 * A settled worker keeps its process so follow-up work starts fast, but it is
 * not free: each one holds a Node runtime plus the whole Pi tool surface. Codex
 * reclaims idle residents; we do the same after a grace period instead of
 * waiting for the `MAX_LIVE_CHILDREN` watermark.
 *
 * Read per arm so a test can shorten it with `ORBIT_PI_IDLE_WORKER_TTL_MS`.
 */
function idleWorkerTtlMs(): number {
  const configured = Number(process.env.ORBIT_PI_IDLE_WORKER_TTL_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 10 * 60 * 1000
}
/**
 * Codex's `wait_agent` returns these exact strings; keeping them byte-identical
 * means a model that learned the contract from Codex reads the same signal here.
 */
const WAIT_COMPLETED = "Wait completed."
const WAIT_INTERRUPTED = "Wait interrupted by new input."
const WAIT_TIMED_OUT = "Wait timed out."
/**
 * Bound the completion buffer. A supervisor that never waits (or is asleep for a
 * long run) would otherwise retain one entry per finished worker forever.
 */
const MAX_PENDING_UPDATES = 32

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function textFromMessage(message: unknown): string {
  if (!message || typeof message !== "object") return ""
  const content = (message as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return ""
      const item = part as { type?: unknown; text?: unknown }
      return item.type === "text" && typeof item.text === "string" ? item.text : ""
    })
    .filter(Boolean)
    .join("")
}

function safeSummary(value: string, limit = 220): string {
  const compact = value.replace(/\s+/g, " ").trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}

export function modelVisibleOutput(value: string): string {
  const limit = modelOutputLimitBytes()
  const bytes = Buffer.from(value, "utf8")
  if (bytes.byteLength <= limit) return value
  const visible = bytes.subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "")
  return `${visible}\n\n[子 agent 输出已截断；完整内容保留在子会话中]`
}

function currentPiInvocation(args: string[]): { command: string; args: string[] } {
  // The bridge exports the exact resolved runtime to every parent process.
  // Prefer it over argv[1], because Pi's bundled launcher can itself be a
  // wrapper and argv[1] may point at a temporary script in packaged builds.
  const configuredNode = process.env.ORBIT_PI_NODE_PATH
  const configuredPi = process.env.ORBIT_PI_CLI_PATH
  if (configuredNode && configuredPi && existsSync(configuredNode) && existsSync(configuredPi)) {
    return { command: configuredNode, args: [configuredPi, ...args] }
  }

  // Development and direct-extension execution still have the bridge's
  // `node <project-pi>/dist/.../cli.js` shape. Reusing argv[1] keeps those
  // children on the exact same package/version as the parent.
  const entry = process.argv[1]
  if (entry && existsSync(entry)) return { command: process.execPath, args: [entry, ...args] }

  // This branch is useful when Pi is distributed as a standalone executable.
  const runtimeName = basename(process.execPath).toLowerCase()
  if (!/^(node|bun)(\.exe)?$/.test(runtimeName)) return { command: process.execPath, args }

  // A test harness or an unusual launcher may not expose argv[1]. Keep a
  // clear error at spawn time instead of silently selecting another Pi install.
  throw new Error("无法定位当前 Pi 执行入口，拒绝回退到其他 Pi 安装")
}

function makeTaskPrompt(task: TaskInput, node: AgentNode, selfPath: string, inherited: boolean): string {
  // Codex delivers the initial task in the same envelope a finished worker uses
  // for its answer, so one format covers both directions of the tree.
  const header = [
    "Message Type: NEW_TASK",
    `Task name: ${node.path}`,
    `Sender: ${selfPath}`,
    "Payload:",
  ].join("\n")
  // The inherited history is delivered by Pi as real messages, not as text in
  // this prompt, so the worker only needs to be told that it can rely on it.
  const lineage = inherited
    ? "\n你已继承父 agent 的完整对话上下文（含工具调用与结果）。直接基于它完成委派任务，不要重复父已经做过的工作。"
    : ""
  return `${header}\n${task.task.trim()}${lineage}`
}

export function resultText(node: AgentNode, output: string): string {
  const heading = `${node.name} [${node.status}]\nagent_id: ${node.id}`
  if (node.status === "failed" || node.status === "aborted") return `${heading}\n${modelVisibleOutput(node.error || output || "没有返回结果")}`
  return `${heading}\n${modelVisibleOutput(output || node.summary || "已完成，但没有文本摘要")}`
}

/**
 * Owns all child Pi processes for one parent Pi session.
 *
 * There is intentionally no fixed concurrency/depth policy here. Pi decides
 * how many workers to request; this class only provides lifecycle, cancellation
 * and back-pressure-free event publication. The recent list is bounded to keep
 * status payloads cheap even for long-running sessions.
 */
export class SubagentRuntime {
  readonly rootId: string
  /** This process's own canonical path: `/root` for a supervisor, its own path for a worker. */
  readonly selfPath: string
  private readonly parentSessionFile?: string
  private readonly sessionBaseDir?: string
  /** One slot per running worker, shared across the whole agent tree. */
  private readonly treeSlots?: TreeSlots
  /** nodeId → slot file, so a reclaimed worker returns its slot exactly once. */
  private readonly slots = new Map<string, string>()
  private readonly nodes = new Map<string, AgentNode>()
  private readonly children = new Map<string, ChildHandle>()
  private readonly publish: PublishSnapshot
  private readonly deliver?: DeliverResult
  private readonly filterFork: boolean
  /** Workers that reached a terminal state since the last `waitForUpdate`. */
  private readonly updates: AgentNode[] = []
  /**
   * Every in-flight `wait_agent` call. Codex wakes each waiter on mailbox
   * activity; a single slot would let a second concurrent wait silently steal
   * the first one's wake-up and report a false timeout.
   */
  private readonly waiters = new Set<() => void>()
  private disposed = false
  private publishTimer?: ReturnType<typeof setTimeout>
  private lastPublishedAt = 0
  /** Increments on every top-level user turn; see {@link AgentNode.turn}. */
  private turn = 0

  constructor(rootId: string, publish: PublishSnapshot, parentSessionFile?: string, options: RuntimeOptions = {}) {
    this.rootId = rootId
    // A worker inherits its own path from the supervisor that spawned it, so a
    // nested agent's children hang off the right branch of the tree.
    this.selfPath = options.selfPath || process.env.PI_GUI_AGENT_PATH || ROOT_PATH
    this.parentSessionFile = parentSessionFile
    this.publish = publish
    this.deliver = options.deliver
    this.filterFork = options.filterFork ?? true
    this.sessionBaseDir = parentSessionFile ? join(dirname(parentSessionFile), "subagents") : undefined
    // A worker's own session dir is nested inside the supervisor's, so the tree
    // budget cannot be derived from it: the spawner passes the root directory and
    // the limit down through the environment.
    const inheritedTreeDir = process.env[TREE_DIR_ENV]
    const treeDir = inheritedTreeDir || (this.sessionBaseDir ? join(this.sessionBaseDir, ".tree") : undefined)
    const inheritedLimit = Number(process.env[TREE_LIMIT_ENV])
    const treeLimit = Number.isFinite(inheritedLimit) && inheritedLimit > 0 ? inheritedLimit : MAX_ACTIVE_CHILDREN
    this.treeSlots = treeDir ? new TreeSlots(treeDir, treeLimit) : undefined
    this.emit()
  }

  /**
   * Workers that finished during the current user turn.
   *
   * `this.nodes` keeps every worker the process ever spawned — a follow-up turn
   * has to be able to address them by path — but the *published* recent list
   * must not. It used to be "every settled worker, capped at 80", so once a
   * single worker had finished, every later turn's fold showed the whole
   * accumulated history: a message sent four seconds ago displayed workers with
   * 4m19s elapsed. The GUI renders the feed under the newest prompt only, so
   * scoping it to this turn loses nothing.
   *
   * Live workers are deliberately not scoped: a worker spawned two turns ago
   * that is still running is live work and stays visible until it settles.
   */
  private settledThisTurn(): AgentNode[] {
    return [...this.nodes.values()]
      .filter((node) => TERMINAL_STATUSES.has(node.status) && node.turn === this.turn)
      .sort((a, b) => a.startedAt - b.startedAt)
      .slice(-80)
  }

  private emit(force = false): void {
    const now = Date.now()
    const delay = 64 - (now - this.lastPublishedAt)
    if (!force && delay > 0) {
      if (!this.publishTimer) this.publishTimer = setTimeout(() => {
        this.publishTimer = undefined
        this.emit(true)
      }, delay)
      return
    }
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    this.lastPublishedAt = now
    const all = [...this.nodes.values()].sort((a, b) => a.startedAt - b.startedAt)
    const active = all.filter((node) => !TERMINAL_STATUSES.has(node.status))
    const recent = this.settledThisTurn()
    this.publish({ version: 1, rootId: this.rootId, active, recent, updatedAt: now })
  }

  private update(id: string, patch: Partial<AgentNode>): AgentNode {
    const current = this.nodes.get(id)
    if (!current) throw new Error(`未知的 agent: ${id}`)
    const next = { ...current, ...patch }
    this.nodes.set(id, next)
    this.emit(Boolean(patch.status && TERMINAL_STATUSES.has(patch.status)))
    return next
  }

  private parentId(value: string | undefined): string | null {
    if (!value) return null
    return this.nodes.has(value) ? value : null
  }

  private attachChild(parentId: string | null, childId: string): void {
    if (!parentId) return
    const parent = this.nodes.get(parentId)
    if (!parent || parent.childrenIds.includes(childId)) return
    this.nodes.set(parentId, { ...parent, childrenIds: [...parent.childrenIds, childId] })
  }

  private createNode(options: SpawnOptions): AgentNode {
    const id = randomUUID()
    const parentId = this.parentId(options.parentId)
    const name = options.name?.trim() || `agent_${this.nodes.size + 1}`
    const parentPath = parentId ? this.nodes.get(parentId)?.path ?? this.selfPath : this.selfPath
    // `spawn` validated the name before reaching here.
    const path = joinAgentPath(parentPath, name) as string
    const node: AgentNode = {
      id,
      parentId,
      path,
      name,
      task: options.task.trim(),
      status: "queued",
      summary: "等待启动",
      startedAt: Date.now(),
      turn: this.turn,
      childrenIds: [],
      ...(options.model ? { model: modelReference(options.model) } : {}),
    }
    this.nodes.set(id, node)
    this.attachChild(parentId, id)
    this.emit()
    return node
  }

  private setFromNestedSnapshot(nodeId: string, value: unknown): void {
    if (!value || typeof value !== "object") return
    const snapshot = value as { active?: unknown; recent?: unknown }
    const nested = [...(Array.isArray(snapshot.active) ? snapshot.active : []), ...(Array.isArray(snapshot.recent) ? snapshot.recent : [])]
      .filter((item): item is AgentNode => Boolean(item && typeof item === "object" && typeof (item as AgentNode).id === "string"))
      .map((item) => item.parentId === null ? { ...item, parentId: nodeId } : item)
      .slice(-80)
    const parent = this.nodes.get(nodeId)
    if (!parent) return
    const childIds = [...new Set(nested.filter((item) => item.parentId === nodeId).map((item) => item.id))]
    this.nodes.set(nodeId, { ...parent, childrenIds: childIds, children: nested })
    this.emit()
  }

  private handleEvent(node: AgentNode, handle: ChildHandle, event: ChildEvent): void {
    const type = event.type
    if (type === "message_update") {
      const update = event.assistantMessageEvent as { type?: unknown; delta?: unknown; content?: unknown; toolName?: unknown } | undefined
      const updateType = typeof update?.type === "string" ? update.type : ""
      const channel = updateType.split("_", 1)[0]
      if (channel !== "text" && channel !== "thinking") return
      if (updateType.endsWith("_start")) handle.streamingText = ""
      if (updateType.endsWith("_delta") && typeof update?.delta === "string") handle.streamingText += update.delta
      if (updateType.endsWith("_end") && typeof update?.content === "string") handle.streamingText = update.content
      if (update?.type === "thinking_start") handle.streamingThinking = ""
      if (update?.type === "thinking_delta" && typeof update.delta === "string") handle.streamingThinking += update.delta
      if (update?.type === "thinking_end" && typeof update.content === "string") handle.streamingThinking = update.content
      const text = handle.streamingText || handle.streamingThinking
      if (text.trim()) {
        handle.lastProgress = safeSummary(text)
        this.update(node.id, { status: "running", summary: handle.lastProgress })
      }
      return
    }
    if (type === "tool_execution_start" || type === "tool_execution_update") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "工具"
      const args = event.args && typeof event.args === "object" ? event.args as Record<string, unknown> : {}
      const target = Object.values(args).find((value): value is string => typeof value === "string" && value.trim().length > 0)
      this.update(node.id, { status: "running", summary: safeSummary(`${toolName}${target ? `: ${target}` : ""}`) })
      return
    }
    if (type === "message_end" || type === "tool_result_end") {
      const message = event.message as { role?: unknown } | undefined
      // Ignore the child's echoed user prompt. Only assistant/tool output is
      // useful as a live summary for the parent activity row.
      if (type === "message_end" && message?.role !== "assistant") return
      const text = textFromMessage(event.message)
      if (text) {
        handle.output = text
        handle.lastProgress = safeSummary(text)
        this.update(node.id, { summary: handle.lastProgress })
      }
      if (event.message && typeof event.message === "object") {
        const usage = (event.message as { usage?: unknown }).usage
        if (usage && typeof usage === "object" && !Array.isArray(usage)) handle.usage = usage as Record<string, unknown>
      }
      if (message?.role === "assistant") {
        const assistant = message as { stopReason?: unknown; errorMessage?: unknown }
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
          handle.failure = {
            status: assistant.stopReason === "aborted" ? "aborted" : "failed",
            message: typeof assistant.errorMessage === "string" ? assistant.errorMessage : `子 agent ${assistant.stopReason}`,
          }
        }
      }
      return
    }
    if (type === "extension_ui_request" && event.method === "setStatus" && event.statusKey === "gui-agents") {
      try {
        this.setFromNestedSnapshot(node.id, JSON.parse(typeof event.statusText === "string" ? event.statusText : ""))
      } catch {
        // A malformed nested status should not interrupt the worker.
      }
      return
    }
    if (type === "agent_settled") {
      const current = this.nodes.get(node.id)
      if (current && !TERMINAL_STATUSES.has(current.status)) {
        // Pi reports `aborted` on settle (1.1.0+), which is authoritative: a run
        // aborted before its first assistant message leaves no `stopReason`
        // behind, so message_end alone would report it as completed.
        const failure = handle.failure ?? (event.aborted === true ? { status: "aborted" as const, message: "子 agent 已中止" } : undefined)
        this.update(node.id, {
          status: failure?.status || "completed",
          summary: failure?.message || (handle.output ? safeSummary(handle.output) : current.summary || "已完成"),
          ...(failure ? { error: failure.message } : {}),
          endedAt: Date.now(),
        })
      }
      handle.settledDone = true
      handle.settle()
      // The worker finished a turn. Report it to the supervisor asynchronously.
      this.finishRun(node.id)
      return
    }
    if (type === "agent_end") {
      const messages = Array.isArray(event.messages) ? event.messages : []
      const last = [...messages].reverse().map(textFromMessage).find(Boolean)
      if (last) handle.output = last
      return
    }
    if (type === "response" && event.command === "get_state" && event.success && event.data && typeof event.data === "object") {
      const state = event.data as { model?: { provider?: string; id?: string }; pid?: number; sessionId?: string; sessionFile?: string }
      const model = state.model?.provider && state.model.id ? `${state.model.provider}/${state.model.id}` : undefined
      this.update(node.id, {
        ...(model ? { model } : {}),
        ...(handle.process.pid ? { pid: handle.process.pid } : {}),
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        ...(state.sessionFile ? { sessionPath: state.sessionFile } : {}),
      })
    }
  }

  /**
   * The session file to fork for an inherited worker, or undefined when the
   * caller asked for an isolated one. `inherit` needs a parent session file to
   * fork, and Pi persists sessions lazily (on the first conversation entry), so
   * a missing file silently degrades to an empty session rather than failing
   * the delegation.
   *
   * When filtering is enabled the parent's entries are rewritten into a
   * tool-free transcript first (Codex's `keep_forked_rollout_item` behaviour),
   * which drops the bulky tool payloads a worker can read again for itself.
   * The rewritten file lives in the worker's own session dir and is only a fork
   * source, never the worker's session.
   */
  private forkSource(options: SpawnOptions, sessionDir: string | undefined): string | undefined {
    if ((options.context ?? "inherit") !== "inherit") return undefined
    const file = this.parentSessionFile
    if (!file || !existsSync(file)) return undefined
    if (!this.filterFork || !sessionDir) return file
    try {
      const { content } = filterForkSession(readFileSync(file, "utf8"))
      if (!content) return file
      const target = join(sessionDir, "fork-source.jsonl")
      writeFileSync(target, content)
      return target
    } catch {
      // A filter failure must never block delegation; inherit verbatim instead.
      return file
    }
  }

  /**
   * Keep the number of live worker processes bounded. Settled workers are the
   * only eviction candidates: active ones are doing work, and a settled one can
   * always be replaced by a fresh spawn (the equivalent of Codex's `not_found`).
   */
  private evictSettledWorkers(): void {
    if (this.children.size < MAX_LIVE_CHILDREN) return
    const candidates = [...this.nodes.values()]
      .filter((node) => TERMINAL_STATUSES.has(node.status) && this.children.has(node.id))
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt))
    for (const victim of candidates) {
      if (this.children.size < MAX_LIVE_CHILDREN) break
      const handle = this.children.get(victim.id)
      if (!handle) continue
      // Drop the handle first: everything below this point is asynchronous, and
      // a stale handle must never be reachable in the meantime.
      this.children.delete(victim.id)
      void this.stopProcess(victim.id, handle, false)
    }
  }

  /**
   * Record a worker's terminal turn: notify waiters and hand the result to the
   * host for asynchronous injection. Every terminal turn reports once, so a
   * reopened worker (via `send`) reports again on its next settle.
   */
  private finishRun(nodeId: string): void {
    const node = this.nodes.get(nodeId)
    if (!node || !TERMINAL_STATUSES.has(node.status)) return
    const handle = this.children.get(nodeId)
    const output = handle?.output.trim() || node.summary || ""
    this.updates.push(node)
    if (this.updates.length > MAX_PENDING_UPDATES) this.updates.splice(0, this.updates.length - MAX_PENDING_UPDATES)
    // Wake every waiter, not just the newest one.
    for (const wake of [...this.waiters]) wake()
    this.waiters.clear()
    // The turn is over: the concurrency slot goes back while the process stays
    // warm for follow-up work.
    this.releaseSlot(nodeId)
    if (handle) this.armIdleTimer(nodeId, handle)
    this.deliver?.(node, output)
  }

  /**
   * Reclaim a settled worker once it has been idle long enough. Any new task
   * cancels the timer, so a worker the supervisor keeps talking to is never
   * collected underneath it.
   */
  private armIdleTimer(nodeId: string, handle: ChildHandle): void {
    this.clearIdleTimer(handle)
    handle.idleTimer = setTimeout(() => {
      handle.idleTimer = undefined
      if (this.disposed) return
      if (this.children.get(nodeId) !== handle) return
      this.children.delete(nodeId)
      void this.stopProcess(nodeId, handle, false)
    }, idleWorkerTtlMs())
    handle.idleTimer.unref?.()
  }

  private clearIdleTimer(handle: ChildHandle): void {
    if (!handle.idleTimer) return
    clearTimeout(handle.idleTimer)
    handle.idleTimer = undefined
  }

  /**
   * Return a tree slot. A worker holds one only while it is running a turn, so
   * this fires when it settles as well as when its process is reclaimed: the
   * budget bounds concurrency, not residency.
   */
  private releaseSlot(nodeId: string): void {
    const slot = this.slots.get(nodeId)
    if (!slot) return
    this.slots.delete(nodeId)
    this.treeSlots?.release(slot)
  }

  private createChild(node: AgentNode, options: SpawnOptions, signal: AbortSignal | undefined): ChildHandle {
    // Keep the child extension but disable discovered user/project extensions;
    // this prevents the GUI extension from recursively registering itself while
    // still loading the small, explicit child control surface.
    const args = [
      "--mode", "rpc", "--offline", "--no-extensions",
      ...CHILD_BUILTIN_EXTENSIONS.flatMap((name) => ["--extension", name]),
      "--extension", CHILD_EXTENSION,
    ]
    let sessionDir: string | undefined
    if (this.sessionBaseDir) {
      sessionDir = join(this.sessionBaseDir, node.id)
      mkdirSync(sessionDir, { recursive: true })
      args.push("--session-dir", sessionDir)
    }
    // Pi copies the fork source's entries into a fresh session inside the
    // worker's own session dir and keeps the parent link in the header, so
    // lineage and isolation both survive.
    const forkFrom = this.forkSource(options, sessionDir)
    if (forkFrom) args.push("--fork", forkFrom)
    if (options.model) args.push("--provider", options.model.provider, "--model", options.model.id)
    if (options.thinking) args.push("--thinking", options.thinking)
    const invocation = currentPiInvocation(args)
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd || process.cwd(),
      env: {
        ...process.env,
        PI_GUI_SUBAGENT: "1",
        PI_GUI_AGENT_ID: node.id,
        PI_GUI_AGENT_PATH: node.path,
        PI_GUI_AGENT_PARENT_ID: node.parentId || "",
        ...(this.treeSlots ? { [TREE_DIR_ENV]: this.treeSlots.dir, [TREE_LIMIT_ENV]: String(this.treeSlots.budget) } : {}),
      },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let settle!: () => void
    let settled = new Promise<void>((resolve) => { settle = resolve })
    let markClosed!: () => void
    const closed = new Promise<void>((resolve) => { markClosed = resolve })
    const resetSettled = () => {
      handle.settledDone = false
      handle.failure = undefined
      handle.output = ""
      handle.streamingText = ""
      handle.streamingThinking = ""
      handle.usage = undefined
      settled = new Promise<void>((resolve) => { settle = resolve })
      handle.settled = settled
      handle.settle = settle
    }
    const handle: ChildHandle = {
      process: child,
      pending: new Map(),
      buffer: "",
      output: "",
      inherited: Boolean(forkFrom),
      queued: [],
      stderr: "",
      streamingText: "",
      streamingThinking: "",
      lastProgress: "启动中",
      settled,
      settle,
      resetSettled,
      settledDone: false,
      closed,
      markClosed,
      exited: false,
    }
    const finish = () => {
      if (!handle.settledDone) {
        handle.settledDone = true
        handle.settle()
      }
    }
    const failPending = (message: string) => {
      for (const pending of handle.pending.values()) pending.reject(new Error(message))
      handle.pending.clear()
    }
    const processLine = (line: string) => {
      if (!line.trim()) return
      let event: ChildEvent
      try { event = JSON.parse(line) as ChildEvent } catch { return }
      if (event.type === "response" && typeof event.id === "string") {
        const pending = handle.pending.get(event.id)
        if (pending) {
          handle.pending.delete(event.id)
          pending.resolve({ success: event.success, data: event.data, error: typeof event.error === "string" ? event.error : undefined })
        }
      }
      this.handleEvent(node, handle, event)
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      handle.buffer += chunk.toString()
      const lines = handle.buffer.split("\n")
      handle.buffer = lines.pop() || ""
      for (const line of lines) processLine(line.replace(/\r$/, ""))
    })
    child.stderr.on("data", (chunk: Buffer | string) => {
      const text = chunk.toString().trim()
      if (!text) return
      handle.stderr = `${handle.stderr}${text}\n`.slice(-2_000)
      this.update(node.id, { summary: safeSummary(text) })
    })
    child.once("error", (error) => {
      handle.exited = true
      handle.markClosed()
      handle.detachAbort?.()
      failPending(errorText(error))
      this.update(node.id, { status: "failed", summary: errorText(error), error: errorText(error), endedAt: Date.now() })
      this.finishRun(node.id)
      finish()
    })
    child.once("close", (code, signalName) => {
      handle.exited = true
      handle.markClosed()
      handle.detachAbort?.()
      if (handle.buffer.trim()) processLine(handle.buffer)
      failPending(`子 agent 进程已退出 (${code ?? signalName ?? "unknown"})`)
      const current = this.nodes.get(node.id)
      if (current && !TERMINAL_STATUSES.has(current.status)) {
        const aborted = signal?.aborted
        this.update(node.id, {
          status: aborted ? "aborted" : code === 0 ? "completed" : "failed",
          summary: handle.output ? safeSummary(handle.output) : aborted ? "已取消" : code === 0 ? "已完成" : "进程异常退出",
          ...(code === 0 || aborted ? {} : { error: `子 agent 进程退出码 ${code ?? "unknown"}` }),
          endedAt: Date.now(),
        })
      }
      this.finishRun(node.id)
      finish()
    })
    return handle
  }

  private request(handle: ChildHandle, command: Record<string, unknown>, timeoutMs = 30_000): Promise<ChildResponse> {
    if (handle.process.stdin.destroyed) return Promise.reject(new Error("子 agent stdin 已关闭"))
    const id = randomUUID()
    const payload = JSON.stringify({ ...command, id }) + "\n"
    return new Promise<ChildResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        handle.pending.delete(id)
        reject(new Error(`Pi 子 agent 请求超时: ${String(command.type)}`))
      }, timeoutMs)
      handle.pending.set(id, {
        resolve: (value) => { clearTimeout(timeout); resolve(value) },
        reject: (error) => { clearTimeout(timeout); reject(error) },
      })
      handle.process.stdin.write(payload, (error) => {
        if (!error) return
        clearTimeout(timeout)
        handle.pending.delete(id)
        reject(error)
      })
    })
  }

  private async stopProcess(nodeId: string, handle: ChildHandle, markAborted = true): Promise<void> {
    this.clearIdleTimer(handle)
    this.releaseSlot(nodeId)
    const current = this.nodes.get(nodeId)
    if (markAborted && current && !TERMINAL_STATUSES.has(current.status)) this.update(nodeId, { status: "aborted", summary: "已取消", endedAt: Date.now() })
    try { await this.request(handle, { type: "clear_queue" }, 5_000) } catch { /* process may be exiting */ }
    try { await this.request(handle, { type: "abort" }, 15_000) } catch { /* process may be exiting */ }
    // `agent_settled` means the child is idle, not that its RPC process exited.
    // Explicit interruption/disposal must still terminate that idle process.
    if (!handle.exited) {
      try { handle.process.kill("SIGTERM") } catch { /* ignore */ }
      await Promise.race([handle.closed, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
    }
    if (!handle.exited) {
      try { handle.process.kill("SIGKILL") } catch { /* ignore */ }
      await Promise.race([handle.closed, new Promise<void>((resolve) => setTimeout(resolve, 1_000))])
    }
    this.children.delete(nodeId)
  }

  async spawn(options: SpawnOptions, signal?: AbortSignal, onUpdate?: AgentToolUpdateCallback<AgentSnapshot>): Promise<AgentResult> {
    if (this.disposed) throw new Error("sub-agent runtime 已关闭")
    if (!options.task?.trim()) throw new Error("子 agent 任务不能为空")
    // Rejecting beats rewriting: a name the model can predict is worth more than
    // one it has to notice was changed. Mirrors Codex's `validate_agent_name`.
    const requested = options.name?.trim() || `agent_${this.nodes.size + 1}`
    const invalid = validateAgentName(requested)
    if (invalid) throw new Error(invalid)
    if (this.snapshot().active.length >= MAX_ACTIVE_CHILDREN) throw new Error(`子 agent 并发数不能超过 ${MAX_ACTIVE_CHILDREN}`)
    this.evictSettledWorkers()
    // The tree budget is charged before the process exists, so a fan-out cannot
    // briefly overshoot the limit while children are starting.
    const slot = this.treeSlots?.acquire()
    const node = this.createNode(options)
    if (slot) this.slots.set(node.id, slot)
    this.update(node.id, { status: "running", summary: "正在启动" })
    let handle: ChildHandle | undefined
    try {
      handle = this.createChild(node, options, signal)
      this.children.set(node.id, handle)
      const emitUpdate = () => {
        const current = this.nodes.get(node.id)
        if (!current) return
        onUpdate?.({ content: [{ type: "text", text: `${current.name}: ${current.summary}` }], details: this.snapshot() })
      }
      const abort = () => { void this.stopProcess(node.id, handle as ChildHandle) }
      if (signal) {
        if (signal.aborted) abort()
        else {
          signal.addEventListener("abort", abort, { once: true })
          handle.detachAbort = () => signal.removeEventListener("abort", abort)
        }
      }
      try {
        // No `new_session` here: an inherited worker already owns a session that
        // carries the parent history, and asking for a new one would throw that
        // context away. An isolated worker starts empty anyway.
        const state = await this.request(handle, { type: "get_state" }, 30_000)
        if (state.success === false) throw new Error(state.error || "Pi 子 agent 状态读取失败")
        const prompt = makeTaskPrompt(options, node, this.selfPath, handle.inherited)
        // Messages queued while the worker was idle ride along with its next task.
        const queued = handle.queued.splice(0)
        const accepted = await this.request(handle, { type: "prompt", message: queued.length > 0 ? `${queued.join("\n")}\n\n${prompt}` : prompt }, 30_000)
        if (accepted.success === false) throw new Error(accepted.error || "Pi 子 agent 拒绝了任务")
      } catch (error) {
        // Record the real failure *before* stopping the process. Otherwise the
        // close handler sees a still-running node and replaces the cause with
        // the generic "process exited with code N", hiding why the spawn failed.
        const detail = [errorText(error), handle.stderr.trim()].filter(Boolean).join("\n")
        const current = this.nodes.get(node.id)
        if (current && !TERMINAL_STATUSES.has(current.status)) {
          this.update(node.id, { status: signal?.aborted ? "aborted" : "failed", summary: errorText(error), error: detail, endedAt: Date.now() })
        }
        await this.stopProcess(node.id, handle, false)
        throw error
      }
      const current = this.nodes.get(node.id) || node
      emitUpdate()
      return { agent: current, output: "", snapshot: this.snapshot() }
    } catch (error) {
      const message = errorText(error)
      const current = this.nodes.get(node.id)
      if (current && !TERMINAL_STATUSES.has(current.status)) this.update(node.id, { status: signal?.aborted ? "aborted" : "failed", summary: message, error: message, endedAt: Date.now() })
      throw error
    } finally {
      // Keep the process handle for wait/send/interrupt. It is reaped by
      // interrupt, session_shutdown, or a later explicit cleanup.
    }
  }

  /**
   * Wait until any worker reports a terminal turn, or the timeout elapses.
   *
   * This is the Codex `wait_agent` contract: it waits for a *signal* and
   * deliberately returns no worker content, because content reaches the
   * supervisor asynchronously through the delivery hook.
   */
  async waitForUpdate(
    timeoutMs = DEFAULT_WAIT_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<{ message: string; timedOut: boolean; interrupted: boolean; updated: AgentNode[] }> {
    // The model-visible text is deliberately identical to Codex's three
    // outcomes: the contract is ``a signal``, not a report. Who finished travels
    // as structured data (the snapshot and the returned node list), never as
    // prose, because a report in the message would invite the model to read
    // results out of tool output instead of the delivered envelopes.
    const drain = () => this.updates.splice(0)
    if (this.updates.length > 0) {
      return { message: WAIT_COMPLETED, timedOut: false, interrupted: false, updated: drain() }
    }
    if (this.children.size === 0) {
      return { message: "No live agents.", timedOut: false, interrupted: false, updated: [] }
    }

    let interrupted = false
    let woken = false
    let timer: ReturnType<typeof setTimeout> | undefined
    await new Promise<void>((resolve) => {
      let done = false
      const finish = (reason: "update" | "timeout" | "interrupt") => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.waiters.delete(wake)
        if (reason === "interrupt") interrupted = true
        resolve()
      }
      const onAbort = () => finish("interrupt")
      const wake = () => {
        // Woken counts as an update even when a sibling wait drained the buffer
        // first: the signal is shared, the drained list is not.
        woken = true
        finish("update")
      }
      timer = setTimeout(() => finish("timeout"), Math.max(0, timeoutMs))
      timer.unref?.()
      this.waiters.add(wake)
      if (signal) {
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener("abort", onAbort, { once: true })
      }
    })

    const updated = drain()
    if (interrupted) {
      return { message: WAIT_INTERRUPTED, timedOut: false, interrupted: true, updated }
    }
    return woken || updated.length > 0
      ? { message: WAIT_COMPLETED, timedOut: false, interrupted: false, updated }
      : { message: WAIT_TIMED_OUT, timedOut: true, interrupted: false, updated: [] }
  }

  /**
   * Codex splits message delivery in two: `steer` reaches a running worker
   * promptly without starting a turn, `followUp` also starts a turn when the
   * worker is idle.
   *
   * Pi has no "queue without starting" for an idle RPC agent, so a steer to an
   * idle worker is buffered here and prepended to its next task.
   */
  async send(agentId: string, message: string, mode: "steer" | "followUp" = "steer"): Promise<AgentNode> {
    const node = this.nodes.get(agentId)
    const handle = this.children.get(agentId)
    if (!node || !handle) throw new Error(`找不到正在运行的 agent: ${agentId}`)
    // A message to a settled worker must keep it alive: the idle reclaimer must
    // never collect the process between the queue write and its next turn.
    this.clearIdleTimer(handle)
    const wasTerminal = TERMINAL_STATUSES.has(node.status)
    if (wasTerminal && mode === "steer") {
      handle.queued.push(message)
      // Codex delivers a queue-only message on the target's next turn. Pi has no
      // queue-only prompt for an idle RPC agent, so the message waits here and is
      // prepended to the next `followup_task`. The tool result says so instead of
      // reporting a delivery that will not happen on its own.
      return this.update(agentId, { summary: safeSummary(`已排队，等待下一次 followup_task 投递：${message}`) })
    }
    if (wasTerminal) handle.resetSettled()
    // A settled worker released its tree slot when its turn ended, so resuming
    // work has to claim one again — a follow-up is as much a running turn as a
    // fresh spawn.
    if (wasTerminal && this.treeSlots) this.slots.set(agentId, this.treeSlots.acquire())
    this.update(agentId, { status: "running", summary: "正在处理补充消息", endedAt: undefined, error: undefined })
    try {
      const queued = handle.queued.splice(0)
      const body = queued.length > 0 ? `${queued.join("\n")}\n\n${message}` : message
      const response = await this.request(handle, {
        type: "prompt",
        message: body,
        ...(!wasTerminal ? { streamingBehavior: mode } : {}),
      }, 30_000)
      if (response.success === false) throw new Error(response.error || "Pi 拒绝了消息")
      return this.nodes.get(agentId) || node
    } catch (error) {
      const messageText = errorText(error)
      this.releaseSlot(agentId)
      this.update(agentId, { status: "failed", summary: messageText, error: messageText, endedAt: Date.now() })
      throw error
    }
  }


  /**
   * Resolve a model-supplied target to an agent id.
   *
   * Accepts, in order, the opaque agent id, an absolute path (`/root/a/b`), or
   * a reference relative to this agent (`b`, `a/b`). Matching Codex, an
   * ambiguous reference is rejected rather than guessed.
   */
  resolveAgentId(target: string): string {
    const value = target.trim()
    if (!value) throw new Error("目标 agent 不能为空")
    if (this.nodes.has(value)) {
      if (!this.children.has(value)) throw new Error(`agent 已被回收，请重新 spawn: ${value}`)
      return value
    }
    const path = resolveAgentPath(this.selfPath, value)
    if (path) {
      const matches = [...this.nodes.values()].filter((node) => node.path === path)
      if (matches.length === 1) {
        if (!this.children.has(matches[0].id)) throw new Error(`agent 已被回收，请重新 spawn: ${value}`)
        return matches[0].id
      }
      if (matches.length > 1) throw new Error(`agent 路径不唯一: ${value}`)
    }
    // A bare name still works when it is unambiguous, which keeps simple cases
    // forgiving without making the reference rules fuzzy.
    const byName = [...this.nodes.values()].filter((node) => node.name === value)
    if (byName.length === 1) return byName[0].id
    if (byName.length > 1) throw new Error(`agent 名称不唯一，请改用规范路径: ${value}`)
    throw new Error(`找不到 agent: ${value}`)
  }

  /** Canonical paths of workers that have not been evicted and can still accept work. */
  liveAgentNames(): string[] {
    return [...this.nodes.values()]
      .filter((node) => this.children.has(node.id))
      .map((node) => `${node.path} [${node.status}]`)
  }

  /** Names of workers that have not been evicted and can still accept work. */
  async interrupt(agentId: string): Promise<AgentNode> {
    const node = this.nodes.get(agentId)
    const handle = this.children.get(agentId)
    if (!node) throw new Error(`未知的 agent: ${agentId}`)
    if (handle) await this.stopProcess(agentId, handle)
    return this.nodes.get(agentId) || node
  }

  snapshot(): AgentSnapshot {
    const all = [...this.nodes.values()].sort((a, b) => a.startedAt - b.startedAt)
    return {
      version: 1,
      rootId: this.rootId,
      active: all.filter((node) => !TERMINAL_STATUSES.has(node.status)),
      recent: this.settledThisTurn(),
      updatedAt: Date.now(),
    }
  }

  output(agentId?: string): string {
    if (agentId) return modelVisibleOutput(this.children.get(agentId)?.output.trim() || this.nodes.get(agentId)?.summary || "")
    return modelVisibleOutput([...this.nodes.values()]
      .filter((node) => TERMINAL_STATUSES.has(node.status))
      .map((node) => resultText(node, this.children.get(node.id)?.output.trim() || ""))
      .join("\n\n---\n\n"))
  }

  /**
   * A new top-level user turn starts.
   *
   * Workers are deliberately **not** reclaimed here. An input event can race a
   * spawn (the GUI sends its mode-sync prompts concurrently with the user's own
   * message), and killing live work because a new message arrived is never
   * right. Process pressure is handled by {@link evictSettledWorkers}, which
   * only ever touches workers that have already finished, and by `dispose`.
   *
   * The tree itself is left in place so a follow-up turn can still address the
   * workers it spawned; the published snapshot keeps only this turn's entries.
   */
  beginUserTurn(): void {
    this.turn += 1
    this.updates.length = 0
    // Publish straight away rather than on the 64ms throttle: the previous
    // turn's workers have to leave the fold the moment the new prompt arrives.
    this.emit(true)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.publishTimer) clearTimeout(this.publishTimer)
    this.publishTimer = undefined
    for (const handle of this.children.values()) this.clearIdleTimer(handle)
    this.waiters.clear()
    this.slots.clear()
    this.treeSlots?.dispose()
    await Promise.all([...this.children.entries()].map(([id, handle]) => this.stopProcess(id, handle)))
    this.children.clear()
    this.emit(true)
  }
}

export { currentPiInvocation, safeSummary, textFromMessage }

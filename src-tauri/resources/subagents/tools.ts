import type { AgentToolResult } from "@earendil-works/pi-agent-core"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { parseModelReference, type WorkerModel } from "./model-ref.ts"
import { MAX_ACTIVE_CHILDREN, modelVisibleOutput, SubagentRuntime, type AgentContextMode, type TaskInput } from "./runtime.ts"
import { ROOT_PATH } from "./paths.ts"
import type { AgentNode, AgentSnapshot } from "./types.ts"

type RuntimeContext = Pick<ExtensionContext, "cwd" | "model" | "thinkingLevel" | "sessionManager" | "ui">
type ToolResult = AgentToolResult<AgentSnapshot & { agent?: AgentNode; output?: string }>

/**
 * The collaboration surface. This mirrors Codex's V2 multi-agent tool set
 * exactly: there is deliberately no batch `spawn_agents`, because spawning is
 * asynchronous, so N independent workers are requested by emitting N
 * `spawn_agent` calls rather than by a batch primitive.
 */
export const SUBAGENT_TOOL_NAMES = [
  "spawn_agent",
  "send_message",
  "followup_task",
  "wait_agent",
  "interrupt_agent",
  "list_agents",
] as const

/** customType of the message a finished worker injects into the supervisor. */
export const SUBAGENT_RESULT_TYPE = "subagent_result"

const DEFAULT_WAIT_TIMEOUT_MS = 30_000
const MAX_WAIT_TIMEOUT_MS = 600_000

/**
 * Collaboration notes appended to every agent that can spawn workers, mirroring
 * Codex's shared multi-agent usage hint (`DEFAULT_MULTI_AGENT_V2_SHARED_USAGE_HINT_TEXT`
 * plus the wait and concurrency guidance).
 *
 * The Codex `functions.exec` note is intentionally omitted: there it warns that
 * collaboration tools are absent from the script namespace, while a Pi custom
 * tool defaults to `direct` exposure, so codemode can in fact reach them.
 */
export const SHARED_AGENT_NOTES = `
All agents share the same directory. In detail:
- All agents have access to the same filesystem as you.
- All agents use the same current working directory.
- As a result, edits made by one agent are immediately visible to all other agents.
- Do not revert or rewrite another agent's changes without saying so.

When calling wait_agent, prefer longer waits (minutes) over frequent short polls: each call blocks until a worker reports, and returns only a signal, never results.

There are ${MAX_ACTIVE_CHILDREN} concurrency slots, so up to ${MAX_ACTIVE_CHILDREN} workers can be active at once.`

export const ROOT_ORCHESTRATION_INSTRUCTIONS = `
<multi_agent_mode>
You are the supervisor for this task, at agent path /root, and remain responsible for the final answer. You are not blocked while workers run: spawn_agent returns as soon as a worker starts, and that worker's result arrives later as a separate message in this conversation, formatted:

Message Type: FINAL_ANSWER
Task name: /root
Sender: <the worker's path>
Payload:
<result>

So never expect worker output inside the spawn_agent tool result, and do not re-read files the workers already reported on. Each worker's canonical path is <your path>/<task_name>, and you can address it by that path, by a path relative to you, or by its agent id. Delegate when a specialist or independent parallel work will improve the result; do not delegate trivial requests by habit. Request independent work by emitting several spawn_agent calls; they start concurrently. Use wait_agent to block until any worker reports; it returns only a signal ("Wait completed."), never content, so read the result messages from the conversation instead of from the tool result. Do not poll it by reflex: wait only when your next step is blocked on a worker. Use send_message to redirect a running worker without starting a turn, followup_task to give an existing worker more work and wake it if idle, interrupt_agent to stop one, and list_agents to inspect the tree (optionally filtered by path prefix). Workers inherit this conversation by default, so write the task itself rather than restating background you already covered.
${SHARED_AGENT_NOTES}
</multi_agent_mode>`

export const CHILD_ORCHESTRATION_INSTRUCTIONS = `
<multi_agent_mode>
You are a specialist delegated by a parent supervisor. Complete only the assigned task, use the available repository tools, and return a concise result with evidence and changed files: your final answer is delivered back to the supervisor automatically, so make it self-contained. You can spawn your own workers with spawn_agent the same way, and their results will arrive as separate FINAL_ANSWER messages. Delegate further only when the assigned task has a genuinely independent workstream that cannot be handled directly.
${SHARED_AGENT_NOTES}
</multi_agent_mode>`

const ThinkingSchema = { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] } as const
const ContextSchema = {
  type: "string",
  enum: ["inherit", "isolated"],
  description: "inherit (default) forks the supervisor conversation so the worker sees the discussion; isolated starts empty and sees only message",
} as const
const TaskSchema = {
  type: "object",
  properties: {
    task_name: {
      type: "string",
      description:
        "Stable task name for the new agent: lowercase letters, digits and underscores only. The agent's canonical path becomes <your path>/<task_name>.",
    },
    message: { type: "string", description: "Complete task delegated to the new agent" },
    cwd: { type: "string", description: "子 agent 工作目录，默认当前项目" },
    model: { type: "string", description: "可选模型，格式 provider/model" },
    thinking: ThinkingSchema,
    context: ContextSchema,
  },
  required: ["task_name", "message"],
  additionalProperties: false,
} as const
const TargetSchema = {
  type: "object",
  properties: {
    target: { type: "string", description: "Agent id or canonical path returned by spawn_agent" },
    message: { type: "string", description: "Message text to deliver" },
  },
  required: ["target", "message"],
  additionalProperties: false,
} as const

// The tool surface takes the model as one `provider/model` string (that is what
// the model itself will type), while the runtime wants the two halves.
type SpawnInput = Omit<TaskInput, "name" | "task" | "model"> & { task_name: string; message: string; model?: string; context?: AgentContextMode }

function toolResult(text: string, snapshot: AgentSnapshot, agent?: AgentNode, output?: string): ToolResult {
  return {
    content: [{ type: "text", text: modelVisibleOutput(text) }],
    details: { ...snapshot, ...(agent ? { agent } : {}), ...(output !== undefined ? { output: modelVisibleOutput(output) } : {}) },
  }
}

function workerModel(input: SpawnInput, ctx: RuntimeContext): WorkerModel | undefined {
  // The parent's own pair is already resolved, so it travels as two values:
  // joining them into `provider/id` makes Pi re-parse the prefix, and a name
  // that only differs in case from a built-in catalog provider resolves to that
  // catalog entry instead of the authenticated one.
  const requested = input.model?.trim()
  if (!requested) return ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined
  // An explicit override stays `provider/model` on the tool surface. A bare id
  // inherits the supervisor's provider rather than silently dropping the wish.
  return parseModelReference(requested) ?? (ctx.model ? { provider: ctx.model.provider, id: requested } : undefined)
}

function taskOptions(input: SpawnInput, ctx: RuntimeContext): TaskInput {
  // The supervisor conversation is delivered by Pi through a filtered session
  // fork, not by re-serializing it here.
  return {
    name: input.task_name,
    task: input.message,
    cwd: input.cwd || ctx.cwd,
    model: workerModel(input, ctx),
    thinking: input.thinking || ctx.thinkingLevel,
    context: input.context ?? "inherit",
  }
}

/**
 * Format a finished worker's result the way Codex does: an envelope naming the
 * recipient and the sender, so a result is never confused with user input.
 */
function resultMessage(recipient: string, node: AgentNode, output: string): string {
  return [
    "Message Type: FINAL_ANSWER",
    `Task name: ${recipient}`,
    `Sender: ${node.path}`,
    `Status: ${node.status}`,
    ...(node.error ? [`Error: ${node.error}`] : []),
    "Payload:",
    modelVisibleOutput(output || node.summary || "(no output)"),
  ].join("\n")
}

function runtimeFor(ctx: RuntimeContext, current: { runtime?: SubagentRuntime }, pi: ExtensionAPI): SubagentRuntime {
  if (current.runtime) return current.runtime
  const rootId = process.env.PI_GUI_AGENT_ID || ctx.sessionManager.getSessionId()
  // A worker is told its own path by the supervisor that spawned it, so a
  // nested tree keeps branching from the right place.
  const selfPath = process.env.PI_GUI_AGENT_PATH || ROOT_PATH
  current.runtime = new SubagentRuntime(
    rootId,
    (snapshot) => ctx.ui.setStatus("gui-agents", JSON.stringify(snapshot)),
    ctx.sessionManager.getSessionFile(),
    {
      selfPath,
      // The asynchronous half of the collaboration model. While the supervisor
      // is running this steers into its next request; when it is idle it starts
      // a turn, so a result is never stranded.
      deliver: (node, output) => {
        pi.sendMessage(
          {
            customType: SUBAGENT_RESULT_TYPE,
            content: [{ type: "text", text: resultMessage(selfPath, node, output) }],
            // The payload is context for the supervisor, not a turn of its own.
            // It is injected visibly so the worker's report stays readable inside
            // the supervisor's work fold, next to the activity rows that name it,
            // while the supervisor's own prose remains the answer the user reads.
            display: true,
            details: { agent: node, output: modelVisibleOutput(output) },
          },
          { triggerTurn: true },
        )
      },
    },
  )
  return current.runtime
}

function resolveTarget(runtime: SubagentRuntime, target: string): string {
  return runtime.resolveAgentId(target)
}

export function registerSubagentTools(pi: ExtensionAPI): void {
  const state: { runtime?: SubagentRuntime } = {}

  pi.registerTool({
    name: "spawn_agent",
    label: "Spawn agent",
    description:
      "Spawn a new agent to work on the specified task. Returns as soon as the agent has started; its final answer is delivered to you later as a separate message, not as this tool's result. The spawned agent gets the same tools as you and can spawn its own workers.",
    promptGuidelines: [
      "Use spawn_agent for one specialized task. It returns immediately; emit several calls when independent work should run in parallel.",
      "The worker already sees this conversation unless you pass context: \"isolated\", so describe the task itself instead of re-summarizing prior work.",
      "Never assume a worker's answer is in the spawn_agent result; it arrives as a later FINAL_ANSWER message.",
    ],
    executionMode: "sequential",
    parameters: TaskSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as SpawnInput
      const runtime = runtimeFor(ctx, state, pi)
      const result = await runtime.spawn(taskOptions(input, ctx), signal, onUpdate)
      return toolResult(
        `${result.agent.path} (agent_id: ${result.agent.id}) started. Its result will arrive as a separate FINAL_ANSWER message sent by ${result.agent.path}.`,
        result.snapshot,
        result.agent,
      )
    },
  })

  pi.registerTool({
    name: "send_message",
    label: "Message agent",
    description: "Send a message to an existing agent. The message is delivered promptly. Does not trigger a new turn.",
    parameters: TargetSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { target: string; message: string }
      const runtime = runtimeFor(ctx, state, pi)
      const agent = await runtime.send(resolveTarget(runtime, input.target), input.message, "steer")
      // A settled worker has no turn to steer, so the message waits for the next
      // followup_task. Say that instead of reporting a delivery that will not
      // happen on its own.
      const delivered = agent.status === "running"
      return toolResult(
        delivered ? `${agent.path}: 消息已投递` : `${agent.path}: 该 agent 当前空闲，消息已排队，将在下一次 followup_task 时一并投递`,
        runtime.snapshot(),
        agent,
      )
    },
  })

  pi.registerTool({
    name: "followup_task",
    label: "Follow up agent",
    description:
      "Send a follow-up task to an existing non-root agent and trigger a turn if it is idle. The answer arrives later as a separate message.",
    parameters: TargetSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { target: string; message: string }
      const runtime = runtimeFor(ctx, state, pi)
      const agent = await runtime.send(resolveTarget(runtime, input.target), input.message, "followUp")
      return toolResult(`${agent.path}: 已追加任务`, runtime.snapshot(), agent)
    },
  })

  pi.registerTool({
    name: "wait_agent",
    label: "Wait agent",
    description:
      "Wait for a worker update, including completions and failures. Returns only a signal — never worker content, which is delivered as separate messages — so check the conversation for the result after this returns. Prefer long timeouts over polling.",
    parameters: {
      type: "object",
      properties: {
        timeout_ms: {
          type: "number",
          description: `Timeout in milliseconds. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}, max ${MAX_WAIT_TIMEOUT_MS}.`,
        },
      },
      additionalProperties: false,
    } as const,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const input = params as { timeout_ms?: number }
      const runtime = runtimeFor(ctx, state, pi)
      const requested = typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms) ? input.timeout_ms : DEFAULT_WAIT_TIMEOUT_MS
      const timeout = Math.min(Math.max(requested, 0), MAX_WAIT_TIMEOUT_MS)
      const outcome = await runtime.waitForUpdate(timeout, signal)
      // The model-visible text is Codex's signal; who finished stays structured.
      return toolResult(outcome.message, runtime.snapshot(), outcome.updated.at(-1))
    },
  })

  pi.registerTool({
    name: "interrupt_agent",
    label: "Interrupt agent",
    description: "Interrupt an agent's current turn, if any. The agent's process is reclaimed; spawn a new one to continue the work.",
    parameters: {
      type: "object",
      properties: { target: { type: "string", description: "Agent id or canonical path returned by spawn_agent" } },
      required: ["target"],
      additionalProperties: false,
    } as const,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { target: string }
      const runtime = runtimeFor(ctx, state, pi)
      const agent = await runtime.interrupt(resolveTarget(runtime, input.target))
      return toolResult(`${agent.path}: ${agent.status}`, runtime.snapshot(), agent)
    },
  })

  pi.registerTool({
    name: "list_agents",
    label: "List agents",
    description: "List live agents in the current supervisor tree. Optionally filter by canonical path prefix.",
    parameters: {
      type: "object",
      properties: {
        path_prefix: { type: "string", description: "Canonical path prefix filter without a trailing slash. Omit to list all live agents." },
      },
      additionalProperties: false,
    } as const,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const input = params as { path_prefix?: string }
      const runtime = runtimeFor(ctx, state, pi)
      const snapshot = runtime.snapshot()
      const prefix = input.path_prefix?.trim().replace(/\/+$/, "")
      const live = runtime.liveAgentNames()
      const filtered = prefix ? live.filter((entry) => entry.split(" ")[0].startsWith(prefix)) : live
      const body = filtered.length > 0 ? filtered.join("\n") : "(no live agents)"
      return toolResult(body, snapshot)
    },
  })

  // A new top-level user turn clears the pending result mailbox. Workers are
  // deliberately left running: the GUI sends its mode-sync prompts concurrently
  // with the user's own message, so reclaiming here could kill live work.
  pi.on("input", async (event) => {
    if (event.streamingBehavior) return
    if (event.source !== "interactive" && event.source !== "rpc") return
    state.runtime?.beginUserTurn()
  })

  pi.on("before_agent_start", async (event) => {
    if (!SUBAGENT_TOOL_NAMES.some((name) => pi.getActiveTools().includes(name))) return
    const instructions = process.env.PI_GUI_SUBAGENT === "1" ? CHILD_ORCHESTRATION_INSTRUCTIONS : ROOT_ORCHESTRATION_INSTRUCTIONS
    return { systemPrompt: `${event.systemPrompt}\n\n${instructions}` }
  })

  pi.on("session_shutdown", async () => {
    if (state.runtime) await state.runtime.dispose()
    state.runtime = undefined
  })
}

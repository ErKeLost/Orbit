import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createXa11yClient } from "./xa11y-client.ts"
import type { AgentDesktopClient } from "./agent-desktop-client.ts"
import type { GuiTaskEvent, GuiTaskInput, GuiTaskResult } from "./gui-task-contract.ts"
import { runGuiTaskEngine } from "./gui-task-engine.ts"
import { createFileMemory, memoryEnabled } from "./affordance-memory.ts"

const taskSchema = {
  type: "object",
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 2_000 },
    target: {
      type: "object",
      properties: { app: { type: "string", minLength: 1, maxLength: 256 } },
      required: ["app"],
      additionalProperties: false,
    },
    readOnly: { type: "boolean", description: "Inspect the already-open app view without clicking, typing or submitting; only observation and scrolling are allowed." },
    textSlots: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9._-]{1,128}$" },
          value: { type: "string", maxLength: 10_000 },
          description: { type: "string", minLength: 1, maxLength: 512 },
        },
        required: ["id", "value", "description"],
        additionalProperties: false,
      },
      maxItems: 50,
    },
    budget: {
      type: "object",
      properties: {
        maxActions: { type: "integer", minimum: 1, maximum: 100 },
        maxDecisions: { type: "integer", minimum: 1, maximum: 200 },
        maxDurationMs: { type: "integer", minimum: 1_000, maximum: 600_000 },
      },
      required: ["maxActions", "maxDecisions", "maxDurationMs"],
      additionalProperties: false,
    },
  },
  required: ["goal", "target", "budget"],
  additionalProperties: false,
} as const

export function registerGuiTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "gui_task",
    label: "GUI task",
    description: "Attach to one desktop app and complete one natural-language goal through native Rust xa11y observations, bounded Jev choices, verified AX actions, and local text slots.",
    promptGuidelines: ["Provide one complete desktop goal and the user's natural-language application name. Do not plan UI steps, guess labels, provide selectors, describe coordinates, or invent completion predicates. The local loop observes the live accessibility tree and Jev chooses each operation and target. Put every exact non-sensitive string that may need to be typed in textSlots with a short purpose; Jev sees only the purpose and slot ID, never the value. Use a budget proportionate to the task. The runtime opens or attaches to the target app, uses accessibility without screenshots, and stops on done, blocked, uncertain delivery, cancellation, or budget exhaustion."],
    parameters: taskSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as GuiTaskInput
      let client: AgentDesktopClient | undefined
      try {
        client = await createXa11yClient(signal)
        const result = await runGuiTaskEngine({
          input,
          client,
          signal,
          emit: event => publishProgress(onUpdate, event),
          // Local learned trajectories (no slot values); ORBIT_CU_MEMORY=0 disables.
          ...(memoryEnabled() ? { memory: createFileMemory() } : {}),
          // Irreversible steps (send, delete, purchase) pause for an in-app
          // user confirmation and then continue in the same run. Without an
          // interactive client the engine stops with needs_review instead.
          confirm: ctx?.hasUI
            ? (summary: string) => ctx.ui.confirm("确认桌面操作", summary, { signal })
            : undefined,
        })
        return { content: [{ type: "text", text: formatResult(input, result) }], details: result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = signal?.aborted ? "aborted" : "error"
        const result: GuiTaskResult = {
          status,
          appLaunched: false,
          goalVerified: false,
          actions: 0,
          decisions: 0,
          evidence: "",
          metrics: { elapsedMs: 0, launchMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, replayedSteps: 0, lookaheadSteps: 0, settleMs: 0, settleEvents: 0 },
          trace: [{ step: 0, stateId: "unobserved", note: message }],
        }
        return { content: [{ type: "text", text: status === "aborted" ? "[aborted]" : `[error] ${message}` }], details: result }
      } finally {
        await client?.dispose().catch(() => undefined)
      }
    },
  })
}

function publishProgress(onUpdate: ((result: { content: [{ type: "text"; text: string }]; details: Record<string, unknown> }) => void) | undefined, event: GuiTaskEvent): void {
  onUpdate?.({ content: [{ type: "text", text: progressText(event) }], details: { kind: "gui_task_progress", event } })
}

function progressText(event: GuiTaskEvent): string {
  if (event.type === "launching") return `正在连接 ${String(event.payload.app ?? "桌面应用")}`
  if (event.type === "observed") return `已读取界面 · ${event.payload.candidateCount ?? 0} 个 AX 候选`
  if (event.type === "decided") return `Jev 选择 ${operationLabel(event.payload.operation)} · ${event.payload.latencyMs ?? 0}ms`
  if (event.type === "acted") return `已执行 ${operationLabel(event.payload.operation)} · ${String(event.payload.outcome ?? "已交付")}`
  return String(event.status)
}

function operationLabel(value: unknown): string {
  const labels: Record<string, string> = {
    ACTIVATE: "激活",
    FOCUS: "聚焦",
    CLICK: "点击", DOUBLE_CLICK: "双击", SET_VALUE: "写入", TYPE_TEXT: "输入", CHECK: "勾选", UNCHECK: "取消勾选", EXPAND: "展开", COLLAPSE: "收起",
    SCROLL_DOWN: "向下滚动", SCROLL_UP: "向上滚动", SCROLL_TO: "滚动到目标", PRESS_ENTER: "回车", DRILL: "读取局部", WIDEN: "返回全窗",
    WAIT: "等待", DONE: "完成", BLOCKED: "停止",
  }
  return labels[String(value)] ?? "操作"
}

export function formatResult(input: GuiTaskInput, result: GuiTaskResult): string {
  const last = [...result.trace].reverse().find(entry => entry.operation)
  const reason = [...result.trace].reverse().find(entry => entry.note)?.note
  const timing = `elapsed=${result.metrics.elapsedMs}ms launch=${Math.round(result.metrics.launchMs)}ms observation=${Math.round(result.metrics.observationMs)}ms decision=${Math.round(result.metrics.decisionMs)}ms action=${Math.round(result.metrics.actionMs)}ms settle=${Math.round(result.metrics.settleMs ?? 0)}ms jev_calls=${result.metrics.jevCalls ?? 0} replayed=${result.metrics.replayedSteps ?? 0}`
  const launch = result.appLaunched ? "已打开并读取应用界面" : "未确认应用已打开"
  const action = result.lastAction ? `最近动作=${result.lastAction.operation} 交付=${result.lastAction.delivery ?? "未知"}` : "尚无桌面动作"
  const goal = result.goalVerified ? "Jev 根据当前界面判断目标已完成" : "目标未获 Jev 验证"
  return `[${result.status}] ${input.goal}\n应用=${launch}；${action}；${goal}\nactions=${result.actions} decisions=${result.decisions} ${timing}\njev=${last?.operation ?? "not_called"}${last?.confidence === undefined ? "" : ` confidence=${last.confidence.toFixed(2)}`}${reason ? `\nreason=${reason}` : ""}\n${result.evidence}`
}

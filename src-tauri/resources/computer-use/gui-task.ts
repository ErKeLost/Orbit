import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createXa11yClient } from "./xa11y-client.ts"
import type { DesktopDriver } from "./desktop-driver.ts"
import type { GuiTaskEvent, GuiTaskInput, GuiTaskResult } from "./gui-task-contract.ts"
import { runGuiTaskEngine } from "./gui-task-engine.ts"
import { createFileMemory, memoryEnabled } from "./affordance-memory.ts"
import { connectDriver } from "./cua/driver.ts"
import { assertDriverPermissions } from "./cua/binary.ts"
import { DriverUnavailableError } from "./cua/errors.ts"
import { runCuaTask, visionMode } from "./loop/engine.ts"

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
  // The default engine is the Cua Driver, which has no DRILL/WIDEN progressive
  // observation and no native xa11y worker. Promising the legacy operations in
  // the tool description would make the calling model plan steps the engine
  // cannot deliver, so the text follows `engineName()`.
  const cua = engineName() === "cua"
  pi.registerTool({
    name: "gui_task",
    label: "GUI task",
    description: cua
      ? "Attach to one desktop app and complete one natural-language goal through live accessibility observations, bounded Jev choices, verified driver actions, and local text slots."
      : "Attach to one desktop app and complete one natural-language goal through native Rust xa11y observations, bounded Jev choices, verified AX actions, and local text slots.",
    promptGuidelines: cua ? CUA_GUIDELINES : LEGACY_GUIDELINES,
    parameters: taskSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as GuiTaskInput
      const emit = (event: GuiTaskEvent) => publishProgress(onUpdate, event)
      // The Cua Driver engine is the default; the legacy ax_control engine stays
      // selectable until parity is verified on real tasks.
      if (engineName() === "cua") {
        const vision = visionMode(process.env.ORBIT_CU_VISUAL)
        const visualFallback = process.env.ORBIT_CU_VISUAL_REGIONS === "1"
        let driver: Awaited<ReturnType<typeof connectDriver>> | undefined
        try {
          driver = await connectDriver({ signal })
          // Fail before the first turn rather than mid-run: an ungranted driver
          // is a launch problem, and the first tool call would otherwise report
          // it as a delivery failure. Screen Recording is only required when
          // this run will actually capture pixels.
          await assertDriverPermissions(driver, { needsScreen: vision !== "off" || visualFallback })
          const result = await runCuaTask(input, {
            driver,
            signal,
            emit,
            // Screenshot to the chooser: ORBIT_CU_VISUAL=1 (auto) | always | off.
            vision,
            // Perception-extension regions (AGPL; never bundled) are separate.
            visualFallback,
            confirm: ctx?.hasUI ? (summary: string) => ctx.ui.confirm("确认桌面操作", summary, { signal }) : undefined,
          })
          return { content: [{ type: "text", text: formatResult(input, result) }], details: result }
        } catch (error) {
          return { content: [{ type: "text", text: formatResult(input, failureResult(error, signal)) }], details: failureResult(error, signal) }
        } finally {
          await driver?.dispose().catch(() => undefined)
        }
      }
      let client: DesktopDriver | undefined
      try {
        client = await createXa11yClient(signal)
        const result = await runGuiTaskEngine({
          input,
          client,
          signal,
          emit,
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
        const result = failureResult(error, signal)
        return { content: [{ type: "text", text: result.status === "aborted" ? "[aborted]" : `[error] ${String((error as Error)?.message ?? error)}` }], details: result }
      } finally {
        await client?.dispose().catch(() => undefined)
      }
    },
  })
}

/** `cua` (Cua Driver) is the default; `legacy` keeps the ax_control worker. */
export function engineName(): "cua" | "legacy" {
  return process.env.ORBIT_CU_ENGINE?.trim().toLowerCase() === "legacy" ? "legacy" : "cua"
}

/** The Cua Driver engine's guidelines: no DRILL/WIDEN, no native xa11y worker. */
const CUA_GUIDELINES = [
  "Provide one complete desktop goal and the user's natural-language application name. Do not plan UI steps, guess labels, provide selectors, describe coordinates, or invent completion predicates. The local loop observes the live accessibility tree and Jev chooses one operation and target per turn. Put every exact non-sensitive string that may need to be typed in textSlots with a short purpose; Jev sees only the purpose and slot ID, never the value. Use a budget proportionate to the task. The runtime opens or attaches to the target app, drives it through accessibility without screenshots by default, and stops on done, blocked, uncertain delivery, a confirmation it cannot show, cancellation, or budget exhaustion.",
  "A background action can be refused. When that happens the engine offers the driver's next rung (FOREGROUND or POINTER) as a separate candidate; choose it only when the background route was refused, and expect a confirmation for it. There is no drill/widen step: read the window as it is, or scroll when a list is longer than the window.",
]

/** The legacy ax_control worker's guidelines, kept for `ORBIT_CU_ENGINE=legacy`. */
const LEGACY_GUIDELINES = [
  "Provide one complete desktop goal and the user's natural-language application name. Do not plan UI steps, guess labels, provide selectors, describe coordinates, or invent completion predicates. The local loop observes the live accessibility tree and Jev chooses each operation and target. Put every exact non-sensitive string that may need to be typed in textSlots with a short purpose; Jev sees only the purpose and slot ID, never the value. Use a budget proportionate to the task. The runtime opens or attaches to the target app, uses accessibility without screenshots, and stops on done, blocked, uncertain delivery, cancellation, or budget exhaustion.",
]

function failureResult(error: unknown, signal?: AbortSignal): GuiTaskResult {
  const message = error instanceof Error ? error.message : String(error)
  const unavailable = error instanceof DriverUnavailableError
  const status: GuiTaskResult["status"] = signal?.aborted ? "aborted" : "error"
  return {
    status,
    appLaunched: false,
    goalVerified: false,
    actions: 0,
    decisions: 0,
    evidence: "",
    metrics: { elapsedMs: 0, launchMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, replayedSteps: 0, settleMs: 0, settleEvents: 0 },
    trace: [{ step: 0, stateId: "unobserved", note: message }],
    ...(unavailable ? { failure: { stage: "launch" as const, branch: error.code, detail: message, hint: "安装 Cua Driver 并在系统设置中授予辅助功能与屏幕录制" } } : {}),
  }
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
  const launch = result.appLaunched
    ? "已打开并读取应用界面"
    : result.status === "blocked" && reason?.includes("PERM_DENIED")
      ? "辅助功能授权不足；未能验证应用界面，应用可能已经打开"
      : "未确认应用已打开"
  const action = result.lastAction ? `最近动作=${result.lastAction.operation} 交付=${result.lastAction.delivery ?? "未知"}` : "尚无桌面动作"
  const goal = result.goalVerified ? "Jev 根据当前界面判断目标已完成" : "目标未获 Jev 验证"
  // 失败必须能定位到分支：调用方（模型）看不到循环内部，这一行是它诊断的唯一入口。
  const failureLine = result.failure
    ? `\n失败分支=${result.failure.stage}${result.failure.branch ? `/${result.failure.branch}` : ""}：${result.failure.detail}${result.failure.hint ? `\n建议=${result.failure.hint}` : ""}`
    : ""
  return `[${result.status}] ${input.goal}\n应用=${launch}；${action}；${goal}${failureLine}\nactions=${result.actions} decisions=${result.decisions} ${timing}\njev=${last?.operation ?? "not_called"}${last?.confidence === undefined ? "" : ` confidence=${last.confidence.toFixed(2)}`}${reason ? `\nreason=${reason}` : ""}\n${result.evidence}`
}

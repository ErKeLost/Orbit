/**
 * `browser_task`: one goal, one browser, one verified result.
 *
 * The tool surface is intentionally the same shape as `gui_task`: the calling
 * model supplies a complete goal, an optional start address, the exact strings
 * that may need to be typed, and a budget. It does not plan steps, name
 * selectors, or describe what "done" looks like — the loop reads the live page
 * and Jev chooses one operation and one observed target per turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { runBrowserTask, type BrowserTaskEvent } from "./browser-engine.ts"
import type { BrowserTaskInput, BrowserTaskResult } from "./browser-contract.ts"

const taskSchema = {
  type: "object",
  properties: {
    goal: { type: "string", minLength: 1, maxLength: 2_000 },
    url: { type: "string", maxLength: 2_048, description: "Where to start. Omit to keep using the page the browser column already shows." },
    textSlots: {
      type: "array",
      description: "Every exact string the page may need typed, with a short purpose. The decision model sees only the purpose, never the value.",
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
    allowGeneratedText: {
      type: "boolean",
      description: "Let the run's own model write a field value that no textSlot covers. Default true; set false when a value must come only from textSlots.",
    },
    readOnly: { type: "boolean", description: "Inspect and scroll the current page without clicking, typing or selecting anything." },
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
  required: ["goal", "budget"],
  additionalProperties: false,
} as const

export function registerBrowserTask(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "browser_task",
    label: "Browser task",
    description: "Open or navigate Orbit's browser column and finish one web goal: read the live page, click, type and select, then report what the page actually shows. Use this directly for opening the browser, even without a destination URL.",
    promptGuidelines: [
      "Give one complete web goal and, when the task starts somewhere specific, a start URL. Do not plan clicks, name selectors or CSS, describe coordinates, or invent what 'done' looks like: the loop reads the live page and a decision model picks one operation and one observed element per step.",
      "Put every exact string you already know in textSlots with a short purpose — search terms, names, dates, addresses, codes. They win over anything the run would write itself, and the decision model sees only each purpose, never the value.",
      "Fields no textSlot covers are written by the run's own model, reading the goal and the page (this is what makes 'search for X' work without preparing X first). It never invents personal data: a value it cannot know stops the run with needs_text naming the field, so re-issue with that value added. Use allowGeneratedText: false when every value must come from textSlots.",
      "Use readOnly for inspection goals (read, summarise, check a page) so nothing on the page can be changed.",
      "The primary browser is the native view in Orbit's column, using its selected profile. A separate Chrome profile is a compatibility fallback, reported in the result; its login state may differ. Never try to bypass a sign-in wall, paywall or captcha.",
      "Steps that look irreversible (buying, sending, publishing, deleting) pause for the user's confirmation; if there is no one to confirm, the run stops with needs_review rather than acting.",
      "Set the budget to the size of the job, not larger: a task that needs ten steps should not be given a hundred. The result reports status, the page it ended on, and the page's own visible text as evidence.",
      "Prefer browser_task over gui_task when the goal is a website: the element table is the page's own DOM and the input is a real browser click, not a synthetic one.",
    ],
    parameters: taskSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const input = params as BrowserTaskInput
      try {
        const result = await runBrowserTask({
          input,
          scope: ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId(),
          signal,
          emit: event => publish(onUpdate, event),
          ...(ctx?.hasUI
            ? { confirm: (summary: string) => ctx.ui.confirm("确认浏览器操作", summary, { signal }) }
            : {}),
        })
        return { content: [{ type: "text", text: formatResult(input, result) }], details: result }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const aborted = Boolean(signal?.aborted)
        return {
          content: [{ type: "text", text: aborted ? "[aborted]" : `[error] ${message}` }],
          details: {
            status: aborted ? "aborted" : "error",
            url: input.url ?? "",
            title: "",
            goalVerified: false,
            steps: 0,
            decisions: 0,
            evidence: "",
            metrics: { elapsedMs: 0, observationMs: 0, decisionMs: 0, actionMs: 0, inputTokens: 0, outputTokens: 0, jevCalls: 0, generatedValues: 0 },
            trace: [],
            failure: { stage: "launch", detail: message },
          } satisfies BrowserTaskResult,
        }
      }
    },
  })
}

function publish(
  onUpdate: ((result: { content: [{ type: "text"; text: string }]; details: Record<string, unknown> }) => void) | undefined,
  event: BrowserTaskEvent,
): void {
  onUpdate?.({ content: [{ type: "text", text: progressText(event) }], details: { kind: "browser_task_progress", event } })
}

function progressText(event: BrowserTaskEvent): string {
  if (event.type === "launching") return `正在打开浏览器${event.payload.url ? ` · ${String(event.payload.url)}` : ""}`
  if (event.type === "observed") return `已读取页面 · ${event.payload.candidates ?? 0} 个可操作元素`
  if (event.type === "decided") return `Jev 选择 ${OPERATION_LABELS[String(event.payload.operation)] ?? event.payload.operation} · ${event.payload.latencyMs ?? 0}ms`
  if (event.type === "acted") return `已执行 ${OPERATION_LABELS[String(event.payload.operation)] ?? event.payload.operation} · ${String(event.payload.label ?? "")}`
  return String(event.status)
}

const OPERATION_LABELS: Record<string, string> = {
  CLICK: "点击",
  TYPE_TEXT: "输入",
  SELECT: "选择",
  SCROLL_DOWN: "向下滚动",
  SCROLL_UP: "向上滚动",
  WAIT: "等待",
  DONE: "完成",
  BLOCKED: "停止",
}

export function formatResult(input: BrowserTaskInput, result: BrowserTaskResult): string {
  const last = result.trace.at(-1)
  const timing = `engine=${result.metrics.engine ?? "?"}${result.metrics.engineFallback ? ` (fallback: ${result.metrics.engineFallback})` : ""} elapsed=${result.metrics.elapsedMs}ms observe=${Math.round(result.metrics.observationMs)}ms decide=${Math.round(result.metrics.decisionMs)}ms act=${Math.round(result.metrics.actionMs)}ms jev_calls=${result.metrics.jevCalls}`
  const outcome = result.goalVerified
    ? "Jev 根据当前页面判断目标已完成"
    : result.status === "needs_text"
      ? "缺少字段值，未执行输入"
      : result.status === "needs_review"
        ? "需要用户确认后继续"
        : "目标未获验证"
  const failure = result.failure
    ? `\n失败分支=${result.failure.stage}${result.failure.branch ? `/${result.failure.branch}` : ""}：${result.failure.detail}${result.failure.hint ? `\n建议=${result.failure.hint}` : ""}`
    : ""
  const step = last ? `\n最近步骤=${OPERATION_LABELS[last.operation] ?? last.operation}${last.label ? `「${last.label}」` : ""}${last.verdict ? ` 页面=${last.verdict === "changed" ? "已变化" : "未变化"}` : ""}` : ""
  const shot = result.screenshotPath ? `\n截图=${result.screenshotPath}` : ""
  return `[${result.status}] ${input.goal}\n页面=${result.title || "(无标题)"} ${result.url}；${outcome}${failure}\nactions=${result.steps} decisions=${result.decisions} ${timing}${step}${shot}\n--- 页面可见内容 ---\n${result.evidence}`
}

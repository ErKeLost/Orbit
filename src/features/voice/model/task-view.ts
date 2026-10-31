import type { Snapshot, SessionEvent } from "@/lib/rpc-core"
import { messageText } from "./messageText"

export type TaskFact = { sequence: number; at: number; type: string; text: string }
export type TaskView = {
  sessionFile: string; title: string; state: "idle" | "running" | "waiting_input" | "failed" | "completed" | "cancelled"
  goal: string; activeTools: string[]; completedTools: number; latestReply: string; error: string | null
  facts: TaskFact[]; observedAt: number; throughEventId: number; confirmation?: { id: string; question: string }
}
const compact = (value: unknown, limit = 600): string => {
  if (typeof value === "string") return value.replace(/\s+/g, " ").slice(0, limit)
  if (value && typeof value === "object") {
    const result = value as { content?: { type?: string; text?: string }[] }
    if (Array.isArray(result.content)) return compact(result.content.filter(p => p.type === "text").map(p => p.text ?? "").join(" "), limit)
  }
  return ""
}
export function eventFact({ event, sequence, observedAt }: SessionEvent): TaskFact | null {
  if (event.type === "tool_execution_start") return { sequence, at: observedAt, type: event.type, text: `${event.toolName ?? "tool"} started` }
  if (event.type === "tool_execution_update") {
    const text = compact(event.partialResult)
    return text ? { sequence, at: observedAt, type: event.type, text } : null
  }
  if (event.type === "tool_execution_end") return { sequence, at: observedAt, type: event.type, text: `${event.toolName ?? "tool"}: ${event.isError ? "failed" : "finished"}. ${compact(event.result)}` }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = compact(messageText(event.message))
    return text ? { sequence, at: observedAt, type: event.type, text } : null
  }
  return null
}
export function taskView(snapshot: Snapshot, facts: TaskFact[] = []): TaskView {
  const transcript = snapshot.transcript
  const messages = transcript.messages
  const lastUserIndex = messages.findLastIndex(item => item.message.role === "user")
  const lastUser = messages[lastUserIndex]
  // Earlier rounds cannot describe the result or clarification of this round.
  const lastReply = messages.slice(lastUserIndex + 1).findLast(item => item.message.role === "assistant")
  const tools = Object.values(transcript.tools)
  const confirmation = snapshot.dialogs[0]
  const question = confirmation ? ("message" in confirmation ? String(confirmation.message ?? "") : "title" in confirmation ? confirmation.title : "") : ""
  return {
    sessionFile: snapshot.state?.sessionFile ?? "", title: snapshot.state?.sessionName ?? compact(lastUser ? messageText(lastUser.message) : "", 60),
    state: confirmation ? "waiting_input" : transcript.running || transcript.submitted ? "running" : transcript.error ? "failed" : transcript.aborted ? "cancelled" : lastReply ? "completed" : "idle",
    goal: lastUser ? compact(messageText(lastUser.message), 1000) : "", activeTools: tools.filter(tool => tool.running).map(tool => tool.name), completedTools: tools.filter(tool => !tool.running).length,
    latestReply: lastReply ? compact(messageText(lastReply.message), 1800) : "", error: transcript.error,
    facts: facts.slice(-12), observedAt: facts.at(-1)?.at ?? Date.now(), throughEventId: facts.at(-1)?.sequence ?? 0,
    ...(confirmation ? { confirmation: { id: confirmation.id, question } } : {}),
  }
}
export function progressReply(view: TaskView, language: string) {
  const zh = language === "zh"
  if (view.state === "waiting_input") return zh ? `正在等你确认：${view.confirmation?.question}` : `It is waiting for your decision: ${view.confirmation?.question}`
  if (view.state === "failed") return zh ? `这一轮出错了：${view.error}` : `The task failed: ${view.error}`
  if (view.state === "cancelled") return zh ? "这项任务已停止。" : "The task has stopped."
  if (view.state === "running") {
    const recent = view.facts.at(-1)?.text
    return zh ? `任务还在进行。${recent ? `最近的进展是：${recent}` : view.activeTools.length ? `当前正在运行 ${view.activeTools.join("、")}。` : "正在生成下一步回复。"}` : `It is still running. ${recent || (view.activeTools.length ? `Currently running ${view.activeTools.join(", ")}.` : "The agent is preparing its next response.")}`
  }
  return view.state === "completed" ? (zh ? "这一轮已经结束。" : "This turn has finished.") : (zh ? "这条会话目前没有正在运行的任务。" : "There is no task running in this session.")
}

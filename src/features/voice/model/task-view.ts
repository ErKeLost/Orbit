import type { Snapshot, SessionEvent } from "@/lib/rpc-core"
import { messageText } from "./messageText"

export type TaskFact = { sequence: number; at: number; type: string; text: string }
export type TaskView = {
  sessionFile: string; title: string; state: "idle" | "running" | "waiting_input" | "failed" | "settled" | "cancelled"
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
    state: confirmation ? "waiting_input" : transcript.running || transcript.submitted ? "running" : transcript.error ? "failed" : transcript.aborted ? "cancelled" : lastReply ? "settled" : "idle",
    goal: lastUser ? compact(messageText(lastUser.message), 1000) : "", activeTools: tools.filter(tool => tool.running).map(tool => tool.name), completedTools: tools.filter(tool => !tool.running).length,
    latestReply: lastReply ? compact(messageText(lastReply.message), 1800) : "", error: transcript.error,
    facts: facts.slice(-12), observedAt: facts.at(-1)?.at ?? Date.now(), throughEventId: facts.at(-1)?.sequence ?? 0,
    ...(confirmation ? { confirmation: { id: confirmation.id, question } } : {}),
  }
}
/** Safe status-only fallback. Task evidence is rendered by the voice model. */
export function progressReply(view: TaskView, language: "en" | "es") {
  const messages = {
    waiting_input: ["It is waiting for your decision. Please review the question in the task session.", "Está esperando tu decisión. Revisa la pregunta en la sesión."],
    failed: ["The task failed. Please review the details in the task session.", "La tarea ha fallado. Revisa los detalles en la sesión."],
    cancelled: ["The task has stopped.", "La tarea se ha detenido."],
    running: ["It is still running.", "La tarea sigue en curso."],
    settled: ["There is a new reply in the task session. Please review it there.", "Hay una nueva respuesta en la sesión de la tarea. Revísala allí."],
    idle: ["There is no task running in this session.", "No hay ninguna tarea en curso en esta sesión."],
  }
  return messages[view.state][language === "es" ? 1 : 0]!
}

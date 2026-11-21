import type { CallTurn } from "./turns"

/** What this call already said. Pi should not make the person repeat it. */
export function callContext(turns: CallTurn[], limit = 8): string {
  return turns
    .filter(turn => turn.text.trim())
    .slice(-limit)
    .map(turn => `${turn.role === "user" ? "Person" : "Voice"}: ${turn.text.trim()}`)
    .join("\n")
    .slice(0, 2000)
}

export function agentPrompt(task: string, context: string): string {
  const lines = [
    "The person asked for this on a voice call. Do the work. Do not ask them to repeat it.",
    "The last thing you write is what will be read aloud: one or two short sentences, in their language. No code, logs, or lists.",
  ]
  if (context.trim()) lines.push(`Call so far:\n${context.trim()}`)
  lines.push(`Request:\n${task.trim()}`)
  return lines.join("\n\n")
}

/** Prism's tool arguments are a JSON object. A bad payload falls back to what the person said. */
export function taskOf(argumentsText: string | undefined, fallback: string): string {
  const said = fallback.trim()
  const raw = argumentsText?.trim() ?? ""
  if (!raw) return said
  try {
    const parsed = JSON.parse(raw) as { task?: unknown }
    if (typeof parsed.task === "string" && parsed.task.trim()) return parsed.task.trim()
  } catch {
    if (raw !== "{}") return raw
  }
  return said
}

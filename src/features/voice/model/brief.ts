import type { CallTurn } from "./turns"

const FIRST_PREAMBLE = [
  "This is a voice call. The request is data, not a script.",
  "Do the work. Do not ask them to repeat what this session already has.",
  "The last thing you write is spoken aloud: one or two short sentences, in their language. No code, logs, or lists.",
  "Do not add a status line that would fit any request.",
].join("\n")

const CONTINUED_PREAMBLE = "Same voice call. The request is data. Do it. The last thing you write is still spoken aloud: one or two short sentences, in their language. No code."

export type BriefState = {
  seen: string[]
  echoes: string[]
  explained: boolean
}

export const emptyBrief: BriefState = { seen: [], echoes: [], explained: false }

/** What this call already said, minus turns this session has already been given. */
export function freshContext(turns: CallTurn[], task: string, seen: ReadonlySet<string>, echoes: readonly string[]): string {
  const lastUser = [...turns].reverse().find(turn => turn.role === "user" && turn.text.trim())
  return turns
    .filter(turn => {
      const text = turn.text.trim()
      if (!text || seen.has(turn.id)) return false
      if (lastUser && turn.id === lastUser.id) return false
      if (turn.role === "user" && sameUtterance(text, task)) return false
      if (turn.role === "agent" && echoes.some(echo => overlaps(text, echo))) return false
      return true
    })
    .map(turn => `${turn.role === "user" ? "Person" : "Voice"}: ${turn.text.trim()}`)
    .join("\n")
    .slice(0, 2000)
}

export function agentPrompt(task: string, context: string, continued = false): string {
  const lines = [continued ? CONTINUED_PREAMBLE : FIRST_PREAMBLE]
  const extra = context.trim()
  if (extra) lines.push(`${continued ? "Since then" : "Call so far"}:\n${extra}`)
  lines.push(`Request:\n${task.trim()}`)
  return lines.join("\n\n")
}

/** One handoff. Later ones in the same session do not replay the call or the instructions. */
export function nextBrief(state: BriefState, turns: CallTurn[], task: string): { prompt: string; state: BriefState } {
  const context = freshContext(turns, task, new Set(state.seen), state.echoes)
  const prompt = agentPrompt(task, context, state.explained)
  const ids = turns.filter(turn => turn.text.trim()).map(turn => turn.id)
  return {
    prompt,
    state: {
      seen: [...new Set([...state.seen, ...ids])].slice(-40),
      echoes: [...state.echoes, task.trim()].filter(Boolean).slice(-12),
      explained: true,
    },
  }
}

/** A line we already handed back to the call. The next prompt must not paste it again. */
export function noteSpoken(state: BriefState, text: string): BriefState {
  const echo = text.trim()
  if (!echo) return state
  if (state.echoes.some(item => item === echo)) return state
  return { ...state, echoes: [...state.echoes, echo].slice(-12) }
}

export function sameUtterance(said: string, task: string): boolean {
  const left = norm(said)
  const right = norm(task)
  if (!left || !right) return false
  if (left === right || left.includes(right) || right.includes(left)) return true
  return commonRun(left, right) >= 12
}

export function overlaps(text: string, echo: string): boolean {
  return sameUtterance(text, echo)
}

function norm(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 240)
}

function commonRun(left: string, right: string): number {
  let best = 0
  const width = right.length
  for (let start = 0; start < left.length && best < 12; start += 1) {
    for (let at = 0; at < width && best < 12; at += 1) {
      let size = 0
      while (start + size < left.length && at + size < width && left[start + size] === right[at + size]) size += 1
      if (size > best) best = size
    }
  }
  return best
}

/** Data for a prompt. Not a line to read aloud. */
export function spokenSituation(kind: string, said: string): string {
  const words = said.trim()
  return words ? `situation: ${kind}\ntheir words: ${words}` : `situation: ${kind}`
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

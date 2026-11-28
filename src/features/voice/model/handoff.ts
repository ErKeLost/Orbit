/**
 * Jev still answers one question: should these words leave the call?
 * A yes, or Prism calling ask_agent, uses the session this call opened,
 * sends only what that session has not already heard, and brings the result back to Rime.
 * Pause or hangup drops the send and the playback.
 */
import { invoke } from "@/lib/native"
import { connections, request } from "@/lib/rpc-core"
import { connect, connectionSnapshot } from "@/lib/rpc-connection"
import { changeSession, deliveryFor, sendPrompt } from "@/lib/rpc-session"
import { useWorkspace } from "@/lib/store"
import { bindCall, clearVoiceBinding, dropAnnouncements, noteDispatch, voiceBinding, voiceCurrent, voiceToken, type VoiceBinding } from "./binding"
import { emptyBrief, nextBrief, noteSpoken, spokenSituation, type BriefState } from "./brief"
import { speakOut, lastAssistantText, stopLocalAudio } from "./desk"
import { voiceCall } from "./call"
import { gateBody, gateOpen } from "./route"
import type { CallTurn } from "./turns"

export type Handoff = "sent" | "no" | "no-project" | "failed" | "spoken"

const WAIT_MS = 70_000
const claimed = new Set<string>()
let inflight: Promise<AgentReply> | null = null
let inflightToken = 0
let opening: Promise<VoiceBinding | "no-project" | "failed"> | null = null
let sessionEpoch = 0
let sentWork = false
const briefs = new Map<string, BriefState>()

type AgentReply = {
  spoken: string
  pending: boolean
  reason: "ok" | "duplicate" | "no-project" | "failed" | "cancelled"
}

type SettledDetail = { connectionId?: string; error?: string | null; aborted?: boolean }

export async function handToAgent(said: string, turns: CallTurn[]): Promise<Handoff> {
  const text = said.trim()
  if (!text) return "no"
  let open = false
  try {
    open = gateOpen(await invoke<unknown>("voice_classify", { request: gateBody(text) }))
  } catch {
    return "no"
  }
  if (!open) return "no"
  const token = voiceToken()
  if (!voiceCurrent(token) || !voiceCall.canSpeak()) return "no"
  voiceCall.hold(text)
  const result = await askAgent(text, turns)
  if (!voiceCurrent(token) || result.reason === "cancelled") return "no"
  if (result.reason === "no-project") {
    if (result.spoken) await speakOut(result.spoken)
    return "no-project"
  }
  if (result.reason === "failed") {
    if (result.spoken) await speakOut(result.spoken)
    return "failed"
  }
  if (result.reason === "duplicate" || result.pending) return "sent"
  if (result.spoken) await speakOut(result.spoken)
  return "spoken"
}

/** Prism already said it is checking. This runs Pi and returns what Rime should say next. */
export async function askAgent(task: string, turns: CallTurn[]): Promise<AgentReply> {
  const text = task.trim()
  if (!text) return { spoken: "", pending: false, reason: "failed" }
  const token = voiceToken()
  if (!voiceCurrent(token)) return { spoken: "", pending: false, reason: "cancelled" }
  if (inflight && voiceCurrent(inflightToken)) return { spoken: "", pending: true, reason: "duplicate" }
  inflightToken = token
  const run = runAgent(text, turns, token)
  inflight = run
  try {
    return await run
  } finally {
    if (inflight === run) inflight = null
  }
}

async function runAgent(task: string, turns: CallTurn[], token: number): Promise<AgentReply> {
  if (!voiceCurrent(token)) return { spoken: "", pending: false, reason: "cancelled" }
  const key = task.toLowerCase().slice(0, 180)
  if (claimed.has(key)) return { spoken: "", pending: true, reason: "duplicate" }
  claimed.add(key)
  window.setTimeout(() => claimed.delete(key), 120_000)

  const session = await ensureVoiceSession()
  if (!voiceCurrent(token)) return { spoken: "", pending: false, reason: "cancelled" }
  if (session === "no-project") return { spoken: spokenSituation("no open project", task), pending: false, reason: "no-project" }
  if (session === "failed") return { spoken: spokenSituation("could not open a session", task), pending: false, reason: "failed" }

  const next = nextBrief(briefs.get(session.sessionFile) ?? emptyBrief, turns, task)
  const running = connectionSnapshot(session.connectionId)?.transcript.running
    ?? (useWorkspace.getState().connectionId === session.connectionId && useWorkspace.getState().transcript.running)
  const command = running
    ? { type: "prompt" as const, message: next.prompt, streamingBehavior: "followUp" as const }
    : { type: "prompt" as const, message: next.prompt }
  const prepared = await deliveryFor(command, session.connectionId)
  if (!voiceCurrent(token)) return { spoken: "", pending: false, reason: "cancelled" }
  const queued = "streamingBehavior" in prepared.command && prepared.command.streamingBehavior === "followUp"
  const watch = queued ? null : watchTurn(session.connectionId, WAIT_MS)
  try {
    await sendPrompt(prepared.command, session.connectionId)
  } catch {
    watch?.cancel()
    return { spoken: spokenSituation("could not send", task), pending: false, reason: "failed" }
  }
  sentWork = true
  briefs.set(session.sessionFile, next.state)
  if (briefs.size > 20) {
    const oldest = briefs.keys().next().value
    if (oldest && oldest !== session.sessionFile) briefs.delete(oldest)
  }
  if (!voiceCurrent(token)) {
    watch?.cancel()
    return { spoken: "", pending: false, reason: "cancelled" }
  }
  if (queued || !watch) {
    noteDispatch()
    return { spoken: "", pending: true, reason: "ok" }
  }
  const settled = await watch.done
  if (!voiceCurrent(token) || settled === "cancelled") return { spoken: "", pending: false, reason: "cancelled" }
  if (settled === "timeout") {
    noteDispatch()
    return { spoken: "", pending: true, reason: "ok" }
  }
  if (settled === "aborted") return { spoken: "", pending: false, reason: "cancelled" }
  if (settled === "error") return { spoken: spokenSituation("the work failed", task), pending: false, reason: "ok" }
  const snap = connectionSnapshot(session.connectionId)
  const last = snap ? lastAssistantText(snap.transcript) : ""
  const spoken = await speakable(session.cwd, last)
  if (!voiceCurrent(token)) return { spoken: "", pending: false, reason: "cancelled" }
  rememberSpoken(session.sessionFile, spoken)
  return { spoken, pending: false, reason: "ok" }
}

function rememberSpoken(sessionFile: string, text: string) {
  const current = briefs.get(sessionFile)
  if (!current) return
  briefs.set(sessionFile, noteSpoken(current, text))
}

/** Clicking the call opens a new session in the current directory. It does not reuse the one on screen. */
export function beginFreshVoiceSession(): Promise<VoiceBinding | "no-project" | "failed"> {
  const mine = ++sessionEpoch
  sentWork = false
  clearVoiceBinding()
  const task = openFresh(mine)
  opening = task
  void task.finally(() => {
    if (opening === task) opening = null
  })
  return task
}

async function openFresh(mine: number): Promise<VoiceBinding | "no-project" | "failed"> {
  const cwd = useWorkspace.getState().cwd
  if (!cwd) return "no-project"
  const state = useWorkspace.getState()
  try {
    if (state.connection !== "online" || !connections.has(state.connectionId)) await connect(cwd)
    if (mine !== sessionEpoch || useWorkspace.getState().cwd !== cwd) return "failed"
    await changeSession({ type: "new_session" }, { keepPanel: true })
  } catch {
    return "failed"
  }
  const created = await waitForBinding(mine)
  if (!created || mine !== sessionEpoch) return "failed"
  return created
}

async function ensureVoiceSession(): Promise<VoiceBinding | "no-project" | "failed"> {
  if (opening) {
    const created = await opening
    if (typeof created !== "string") return created
    return created
  }
  const existing = liveBinding()
  if (existing) return existing
  return beginFreshVoiceSession()
}

export function cancelVoiceSessionOpening() {
  sessionEpoch++
  opening = null
}

/** Stop every send and every sound this call still owes. The session stays in the list. */
export function haltVoiceWork() {
  claimed.clear()
  const owed = voiceBinding()?.owed ?? 0
  const sent = sentWork
  sentWork = false
  dropAnnouncements()
  stopLocalAudio()
  const binding = voiceBinding()
  if (!binding || !connections.has(binding.connectionId)) return
  const id = binding.connectionId
  const snap = connectionSnapshot(id)
  const running = snap?.transcript.running
    ?? (useWorkspace.getState().connectionId === id && useWorkspace.getState().transcript.running)
  if (!running && !sent && owed <= 0) return
  void request({ type: "clear_queue" }, 30_000, id).catch(() => undefined)
  void request({ type: "abort" }, 60_000, id).catch(() => undefined)
}

function liveBinding() {
  const binding = voiceBinding()
  if (!binding || !connections.has(binding.connectionId)) return null
  return binding
}

async function waitForBinding(mine: number): Promise<VoiceBinding | null> {
  const start = Date.now()
  for (;;) {
    if (mine !== sessionEpoch) return null
    bindCall()
    const live = liveBinding()
    if (live) return live
    if (Date.now() - start > 4000) return null
    await new Promise(resolve => window.setTimeout(resolve, 50))
  }
}

function watchTurn(connectionId: string, timeoutMs: number) {
  let cancel = () => {}
  const done = new Promise<"done" | "timeout" | "error" | "aborted" | "cancelled">(resolve => {
    let finished = false
    const finish = (value: "done" | "timeout" | "error" | "aborted" | "cancelled") => {
      if (finished) return
      finished = true
      window.removeEventListener("orbit-turn-settled", onSettled)
      window.clearTimeout(timer)
      resolve(value)
    }
    const onSettled = (event: Event) => {
      const detail = (event as CustomEvent<SettledDetail>).detail
      if (!detail || detail.connectionId !== connectionId) return
      finish(detail.aborted ? "aborted" : detail.error ? "error" : "done")
    }
    window.addEventListener("orbit-turn-settled", onSettled)
    const timer = window.setTimeout(() => finish("timeout"), timeoutMs)
    cancel = () => finish("cancelled")
  })
  return { done, cancel }
}

async function speakable(cwd: string, text: string): Promise<string> {
  const trimmed = text.trim()
  if (!trimmed) return ""
  if (trimmed.length <= 280 && !trimmed.includes("```")) return trimmed.slice(0, 400)
  try {
    const summary = await invoke<string>("pi_oneshot", {
      cwd,
      prompt: [
        "You have no tools. Summarize this for speech in the user's language, one or two short sentences. No code.",
        trimmed.slice(0, 2000),
      ].join("\n"),
    })
    const spoken = summary.trim().slice(0, 400)
    return spoken || trimmed.slice(0, 280)
  } catch {
    return trimmed.slice(0, 280)
  }
}

/**
 * Jev still answers one question: should these words leave the call?
 * A yes, or Prism calling ask_agent, opens a session if the desk has none,
 * sends the call so far with the request, and brings the result back to Rime.
 */
import { invoke } from "@/lib/native"
import { connections } from "@/lib/rpc-core"
import { connect, connectionSnapshot } from "@/lib/rpc-connection"
import { changeSession, deliveryFor, sendPrompt } from "@/lib/rpc-session"
import { useWorkspace } from "@/lib/store"
import { bindCall, noteDispatch, voiceBinding, type VoiceBinding } from "./binding"
import { agentPrompt, callContext } from "./brief"
import { speakOut, lastAssistantText } from "./desk"
import { voiceCall } from "./call"
import { gateBody, gateOpen } from "./route"
import type { CallTurn } from "./turns"

export type Handoff = "sent" | "no" | "no-project" | "failed" | "spoken"

const WAIT_MS = 70_000
const claimed = new Set<string>()
let inflight: Promise<AgentReply> | null = null

type AgentReply = {
  spoken: string
  pending: boolean
  reason: "ok" | "duplicate" | "no-project" | "failed"
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
  voiceCall.hold(text)
  const result = await askAgent(text, turns)
  if (result.reason === "no-project") return "no-project"
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
  if (!text) return { spoken: "再说一次要查什么。", pending: false, reason: "failed" }
  if (inflight) return { spoken: "还在做，好了告诉你。", pending: true, reason: "duplicate" }
  const run = runAgent(text, turns)
  inflight = run
  try {
    return await run
  } finally {
    if (inflight === run) inflight = null
  }
}

async function runAgent(task: string, turns: CallTurn[]): Promise<AgentReply> {
  const key = task.toLowerCase().slice(0, 180)
  if (claimed.has(key)) return { spoken: "还在做，好了告诉你。", pending: true, reason: "duplicate" }
  claimed.add(key)
  window.setTimeout(() => claimed.delete(key), 120_000)

  const session = await ensureVoiceSession()
  if (session === "no-project") return { spoken: "没有打开的项目。", pending: false, reason: "no-project" }
  if (session === "failed") return { spoken: "没能开出会话。", pending: false, reason: "failed" }

  const running = connectionSnapshot(session.connectionId)?.transcript.running
    ?? (useWorkspace.getState().connectionId === session.connectionId && useWorkspace.getState().transcript.running)
  const command = running
    ? { type: "prompt" as const, message: agentPrompt(task, callContext(turns)), streamingBehavior: "followUp" as const }
    : { type: "prompt" as const, message: agentPrompt(task, callContext(turns)) }
  const prepared = await deliveryFor(command, session.connectionId)
  const queued = "streamingBehavior" in prepared.command && prepared.command.streamingBehavior === "followUp"
  const watch = queued ? null : watchTurn(session.connectionId, WAIT_MS)
  try {
    await sendPrompt(prepared.command, session.connectionId)
  } catch {
    watch?.cancel()
    return { spoken: "没发出去。", pending: false, reason: "failed" }
  }
  if (queued || !watch) {
    noteDispatch()
    return { spoken: "还在做，好了告诉你。", pending: true, reason: "ok" }
  }
  const settled = await watch.done
  if (settled === "timeout") {
    noteDispatch()
    return { spoken: "还在做，好了告诉你。", pending: true, reason: "ok" }
  }
  if (settled === "aborted") return { spoken: "停了。", pending: false, reason: "ok" }
  if (settled === "error") return { spoken: "失败了。", pending: false, reason: "ok" }
  const snap = connectionSnapshot(session.connectionId)
  const last = snap ? lastAssistantText(snap.transcript) : ""
  const spoken = await speakable(session.cwd, last)
  return { spoken, pending: false, reason: "ok" }
}

async function ensureVoiceSession(): Promise<VoiceBinding | "no-project" | "failed"> {
  bindCall()
  const existing = liveBinding()
  if (existing) return existing
  const cwd = useWorkspace.getState().cwd
  if (!cwd) return "no-project"
  const state = useWorkspace.getState()
  if (state.connection !== "online" || !state.connectionId || !connections.has(state.connectionId)) {
    try {
      await connect(cwd)
    } catch {
      return "failed"
    }
    bindCall()
    const connected = liveBinding()
    if (connected) return connected
  }
  const panel = useWorkspace.getState().panel
  try {
    await changeSession({ type: "new_session" })
  } catch {
    return "failed"
  }
  if (useWorkspace.getState().panel !== panel) useWorkspace.getState().set({ panel })
  const created = await waitForBinding()
  return created ?? "failed"
}

function liveBinding() {
  const binding = voiceBinding()
  if (!binding || !connections.has(binding.connectionId)) return null
  return binding
}

async function waitForBinding(): Promise<VoiceBinding | null> {
  const start = Date.now()
  for (;;) {
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
  if (!trimmed) return "做完了。"
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

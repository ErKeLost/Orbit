/**
 * Jev's only job on a call: should these words go to the working session?
 * Prism already heard them and is already answering. This does not speak.
 */
import { invoke } from "@/lib/native"
import { connections } from "@/lib/rpc-core"
import { connectionSnapshot } from "@/lib/rpc-connection"
import { deliveryFor, sendPrompt } from "@/lib/rpc-session"
import { useWorkspace } from "@/lib/store"
import { noteDispatch, voiceBinding } from "./binding"
import { gateBody, gateOpen } from "./route"

export type Handoff = "sent" | "no" | "no-session" | "failed"

export async function handToAgent(said: string): Promise<Handoff> {
  const text = said.trim()
  if (!text) return "no"
  const binding = voiceBinding()
  let open = false
  try {
    open = gateOpen(await invoke<unknown>("voice_classify", { request: gateBody(text) }))
  } catch {
    return "no"
  }
  if (!open) return "no"
  if (!binding || !connections.has(binding.connectionId)) return "no-session"
  const running = connectionSnapshot(binding.connectionId)?.transcript.running
    ?? (useWorkspace.getState().connectionId === binding.connectionId && useWorkspace.getState().transcript.running)
  const command = running
    ? { type: "prompt" as const, message: text, streamingBehavior: "followUp" as const }
    : { type: "prompt" as const, message: text }
  const prepared = await deliveryFor(command, binding.connectionId)
  noteDispatch()
  try {
    await sendPrompt(prepared.command, binding.connectionId)
  } catch {
    const current = voiceBinding()
    if (current && current.owed > 0) current.owed -= 1
    return "failed"
  }
  return "sent"
}

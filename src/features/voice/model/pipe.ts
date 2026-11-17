/**
 * The desk pipe. On the computer it is localhost. On the phone the speech
 * engine is not on this device, so the same calls go through the paired host.
 */
import { invoke } from "@/lib/native"
import { mobileRuntime } from "@/lib/runtime"

const ROOT = "http://127.0.0.1:3001"

export type DeskTurn = { id: string; said: string; heard: string }

type DeskReply = {
  status?: number
  body?: { id?: string; said?: string; heard?: string; text?: string }
}

function local(path: string, init?: RequestInit, timeoutMs = 8000) {
  return fetch(`${ROOT}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs), cache: "no-store" })
}

export async function claimDesk(owner: string) {
  if (mobileRuntime()) {
    const reply = await invoke<DeskReply>("speech_engine_desk", { action: "claim", owner })
    if (reply.status === 404) await invoke("speech_engine_desk", { action: "hello" })
    return
  }
  const response = await local("/desk/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner }),
  }, 2000).catch(() => undefined)
  if (!response || response.status === 404) await local("/desk/hello", { method: "POST" }, 2000).catch(() => undefined)
}

export async function releaseDesk(owner: string) {
  if (mobileRuntime()) {
    await invoke("speech_engine_desk", { action: "release", owner }).catch(() => undefined)
    return
  }
  await local("/desk/release", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ owner }),
  }, 2000).catch(() => undefined)
}

export async function nextDesk(owner: string, timeoutMs: number): Promise<DeskTurn | null> {
  if (mobileRuntime()) {
    const reply = await invoke<DeskReply>("speech_engine_desk", {
      action: "next",
      owner,
      timeout: Math.max(1, Math.round(timeoutMs / 1000)),
    })
    if (!reply || reply.status === 204) return null
    const turn = reply.body
    if (!turn?.id || !turn.said) return null
    return { id: turn.id, said: turn.said, heard: turn.heard ?? "" }
  }
  const response = await local(
    `/desk/next?timeout=${timeoutMs}&owner=${encodeURIComponent(owner)}`,
    undefined,
    timeoutMs + 2000,
  )
  if (response.status === 204) return null
  if (!response.ok) throw new Error(`desk ${response.status}`)
  const turn = (await response.json()) as DeskTurn
  if (!turn.id || !turn.said) return null
  return turn
}

export async function chunkDesk(id: string, text: string) {
  if (mobileRuntime()) {
    await invoke("speech_engine_desk", { action: "chunk", id, text })
    return
  }
  await local("/desk/chunk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, text }),
  })
}

export async function endDesk(id: string) {
  if (mobileRuntime()) {
    await invoke("speech_engine_desk", { action: "end", id })
    return
  }
  await local("/desk/end", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  })
}

/** True when the speech engine has spoken an announcement back. */
export async function spokenDesk(): Promise<boolean> {
  if (mobileRuntime()) {
    const reply = await invoke<DeskReply>("speech_engine_desk", { action: "spoken" })
    return reply.status === 200 && Boolean(reply.body?.text)
  }
  const response = await local("/desk/spoken", undefined, 2000)
  return response.ok
}

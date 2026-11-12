export type CallTurn = { id: string; role: "user" | "agent"; text: string }

const MAX_TURNS = 40

export function upsertTurn(turns: CallTurn[], turn: CallTurn, mode: "replace" | "append"): CallTurn[] {
  const index = turns.findIndex(item => item.id === turn.id)
  if (index === -1) return [...turns, turn].slice(-MAX_TURNS)
  const next = [...turns]
  next[index] = mode === "replace" ? { ...next[index], text: turn.text } : { ...next[index], text: `${next[index].text}${turn.text}` }
  return next
}

/** `agent_response` is a snapshot, not a chunk. A shorter late event must not wipe a longer live caption. */
export function applyAgentSnapshot(turns: CallTurn[], id: string, text: string): CallTurn[] {
  const current = turns.find(item => item.id === id)
  if (current && text.length < current.text.length) return turns
  return upsertTurn(turns, { id, role: "agent", text }, "replace")
}

export function applyAgentPart(turns: CallTurn[], id: string, type: "start" | "delta" | "stop", text: string): CallTurn[] {
  if (type === "start") {
    if (turns.some(item => item.id === id)) return text ? applyAgentSnapshot(turns, id, text) : turns
    return upsertTurn(turns, { id, role: "agent", text }, "replace")
  }
  if (!text) return turns
  return upsertTurn(turns, { id, role: "agent", text }, "append")
}

export function disconnectNotice(details: { reason?: string; message?: string; context?: { type?: string } } | undefined): string | null {
  if (!details || details.reason === "user") return null
  if (details.context?.type === "max_duration_exceeded") return "这通通话到了时长上限，已经挂断。"
  if (details.reason === "error") return details.message || "语音连接出错"
  if (details.reason === "agent") return "通话已结束"
  return null
}

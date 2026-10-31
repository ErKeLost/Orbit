import { answerDialog, sendPrompt } from "@/lib/rpc-session"
import { current, connections, request } from "@/lib/rpc-core"
import type { VoiceDecision } from "../../../../src-tauri/resources/voice/contract"

export type VoiceBinding = { connectionId: string; sessionFile: string }
export function boundSnapshot(binding: VoiceBinding) {
  const snapshot = current(binding.connectionId)
  if (!connections.has(binding.connectionId) || snapshot.connection !== "online" || snapshot.state?.sessionFile !== binding.sessionFile) throw new Error("关注的会话已经关闭或更换，请重新选择会话")
  return snapshot
}

export class CommandGateway {
  private receipts = new Map<string, Promise<void>>()
  execute(commandId: string, binding: VoiceBinding, decision: VoiceDecision, text: string, announcedConfirmation?: string, signal?: AbortSignal): Promise<void> {
    const existing = this.receipts.get(commandId)
    if (existing) return existing
    const command = this.deliver(binding, decision, text, announcedConfirmation, signal)
    this.receipts.set(commandId, command)
    if (this.receipts.size > 200) this.receipts.delete(this.receipts.keys().next().value!)
    // Failed or unknown delivery is not retried automatically: that could duplicate a real task.
    return command
  }
  private async deliver(binding: VoiceBinding, decision: VoiceDecision, text: string, announcedConfirmation?: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const snapshot = boundSnapshot(binding)
    if (decision.intent === "reply_confirmation") {
      const dialog = snapshot.dialogs.find(item => item.id === announcedConfirmation)
      if (!dialog || dialog !== snapshot.dialogs[0]) throw new Error("这项确认已经失效，请先听新的确认内容")
      const response = decision.confirmationResponse
      if (!response || response.id !== dialog.id || !Number.isFinite(response.confidence) || response.confidence < 0.85) throw new Error("还无法确认你的回答，请明确回复这项确认")
      let answer: { confirmed?: boolean; cancelled?: boolean; value?: string }
      if (response.action === "cancel") answer = {cancelled:true}
      else if (dialog.method === "confirm" && ["confirm","reject"].includes(response.action)) answer = {confirmed:response.action === "confirm"}
      else if (dialog.method === "select" && response.action === "select" && Number.isInteger(response.optionIndex) && response.optionIndex! >= 0 && response.optionIndex! < dialog.options.length) answer = {value:dialog.options[response.optionIndex!]!}
      else if ((dialog.method === "input" || dialog.method === "editor") && response.action === "text") answer = {value:text}
      else throw new Error("回答与当前确认类型不匹配，请重新说明")
      await answerDialog(dialog, answer, binding.connectionId)
      return
    }
    // Ask Pi itself before a write; the rendering snapshot may lag a transition.
    const state = await request<{ sessionFile?: string; isStreaming?: boolean }>({ type: "get_state" }, 5000, binding.connectionId)
    signal?.throwIfAborted()
    boundSnapshot(binding)
    if (state.sessionFile !== binding.sessionFile) throw new Error("会话身份已改变，未发送任务")
    if (decision.intent === "control_task") {
      await request({ type: "abort" }, 8000, binding.connectionId)
      return
    }
    const behavior = decision.intent === "steer_task" ? "steer" : decision.intent === "queue_task" || state.isStreaming ? "followUp" : undefined
    // A new unrelated task queues behind current work. Only an explicit steer redirects it.
    await sendPrompt({ type: "prompt", message: text, ...(behavior ? { streamingBehavior: behavior } : {}) }, binding.connectionId, state.isStreaming === true, () => { signal?.throwIfAborted(); boundSnapshot(binding) })
  }
}

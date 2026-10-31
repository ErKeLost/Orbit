import { request, subscribeSessionEvents } from "@/lib/rpc-core"
import { VOICE_STATUS, type VoiceServiceEvent } from "../../../../src-tauri/resources/voice/contract"

export async function checkVoiceService(target: string) {
  const result = await request<{ commands: { name: string }[] }>({ type: "get_commands" }, 8000, target)
  if (!result.commands.some(command => command.name === "gui-voice")) throw new Error("语音服务已更新，请重连这个项目后开始对话")
}

export function voiceService(target: string, input: Record<string, unknown>, signal: AbortSignal, onEvent?: (event: VoiceServiceEvent) => void): Promise<VoiceServiceEvent> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("Aborted", "AbortError")); return }
    const id = crypto.randomUUID()
    let settled = false
    const finish = (error?: Error, result?: VoiceServiceEvent) => {
      if (settled) return
      settled = true
      unsubscribe(); clearTimeout(timeout); signal.removeEventListener("abort", abort)
      if (error) reject(error); else resolve(result!)
    }
    const abort = () => {
      void request({ type: "prompt", message: `/gui-voice ${JSON.stringify({ id, action: "cancel" })}` }, 3000, target).catch(() => undefined)
      finish(new DOMException("Aborted", "AbortError"))
    }
    const unsubscribe = subscribeSessionEvents(target, ({ event }) => {
      if (event.type !== "extension_ui_request" || event.method !== "setStatus" || event.statusKey !== VOICE_STATUS || typeof event.statusText !== "string") return
      let value: VoiceServiceEvent
      try { value = JSON.parse(event.statusText) } catch { return }
      if (value.id !== id) return
      if (value.type === "error") { finish(new Error(value.text || "语音请求失败")); return }
      onEvent?.(value)
      if (value.type !== "delta") finish(undefined, value)
    })
    const timeout = window.setTimeout(() => {
      void request({ type: "prompt", message: `/gui-voice ${JSON.stringify({ id, action: "cancel" })}` }, 3000, target).catch(() => undefined)
      finish(new Error("语音服务响应超时，请重试这句话"))
    }, input.action === "answer" ? 45000 : 15000)
    signal.addEventListener("abort", abort, { once: true })
    void request({ type: "prompt", message: `/gui-voice ${JSON.stringify({ ...input, id })}` }, 8000, target).catch(error => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

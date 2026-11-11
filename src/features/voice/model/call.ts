/**
 * 一通通话。
 *
 * 这一层刻意很薄：麦克风、断句、打断、识别、合成全部由 ElevenLabs 处理，
 * 这里只做三件事——拿 token 起会话、把状态和消息摊平给页面、结束时收尾。
 * Pi 在哪？不在这。Pi 在 `tools/speech-engine` 那一端，ElevenLabs 直接把
 * 转写发过去，再把回答的文本念出来。
 *
 * 所以这里没有任何音频代码：没有 AudioContext、没有 PCM、没有重采样。
 */
import { Conversation, type VoiceConversation } from "@elevenlabs/client"
import { speechEngineToken } from "@/lib/rpc-projects"
import { probeSpeechEngine } from "./health"

export type CallState = "off" | "connecting" | "listening" | "thinking" | "speaking"
export type CallTurn = { id: string; role: "user" | "agent"; text: string }
/** 页面那一层要的形状：用户、助手、以及系统提示（比如引擎出错）。 */
export type VoiceLogItem = { id: string; kind: "user" | "agent" | "system"; text: string }
export type CallSnapshot = {
  state: CallState
  error: string | null
  muted: boolean
  turns: CallTurn[]
  /** 输入音量，来自服务端的 VAD 分数；没有它球就只能是死的。 */
  level: number
  outputLevel: number
  engineId: string
}

const empty: CallSnapshot = { state: "off", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "" }

export class VoiceCall {
  private value: CallSnapshot = empty
  private listeners = new Set<() => void>()
  private conversation: VoiceConversation | null = null
  private epoch = 0
  private turn = 0

  getSnapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private update(patch: Partial<CallSnapshot>) {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private fail(message: string) {
    this.conversation = null
    this.update({ state: "off", error: message, level: 0, outputLevel: 0 })
  }

  async start() {
    if (this.value.state !== "off" || this.conversation) return
    const epoch = ++this.epoch
    this.update({ state: "connecting", error: null, turns: [], level: 0, outputLevel: 0 })
    try {
      // 先确认本机那一端还活着：它死了的话，WebRTC 照样会接通，然后对面一直不出声。
      const health = await probeSpeechEngine()
      if (epoch !== this.epoch) return
      if (!health.running) return this.fail(health.reason)
      const { token, engineId } = await speechEngineToken()
      if (epoch !== this.epoch) return
      if (health.engineId && engineId && health.engineId !== engineId) {
        return this.fail(`正在跑的服务端认的是 ${health.engineId}，应用配的是 ${engineId}：两边不一致。重新跑一次 tools/speech-engine/up.sh。`)
      }
      this.update({ engineId })
      const conversation = (await Conversation.startSession({
        conversationToken: token,
        onConnect: () => {
          if (epoch === this.epoch) this.update({ state: "listening" })
        },
        onDisconnect: () => {
          if (epoch !== this.epoch) return
          this.conversation = null
          this.update({ state: "off", level: 0, outputLevel: 0, muted: false })
        },
        onError: (message: string) => {
          if (epoch === this.epoch) this.fail(message || "语音连接出错")
        },
        onModeChange: ({ mode }) => {
          if (epoch !== this.epoch) return
          this.update({ state: mode === "speaking" ? "speaking" : "listening", level: mode === "speaking" ? 0 : this.value.level })
        },
        onVadScore: ({ vadScore }: { vadScore: number }) => {
          if (epoch !== this.epoch || this.value.state === "speaking") return
          // 每帧都写 store 会让整页重渲染；只在肉眼能看出差别时更新。
          if (Math.abs(vadScore - this.value.level) < 0.04) return
          this.update({ level: Math.min(1, vadScore) })
        },
        onMessage: ({ message, role }: { message: string; role: string }) => {
          if (epoch !== this.epoch || !message.trim()) return
          const speaker: "user" | "agent" = role === "user" ? "user" : "agent"
          const last = this.value.turns.at(-1)
          // 同一句的分片追加到同一条，不要一句一个气泡。
          const turns = last && last.role === speaker
            ? [...this.value.turns.slice(0, -1), { ...last, text: `${last.text} ${message}`.trim() }]
            : [...this.value.turns, { id: `turn-${++this.turn}`, role: speaker, text: message.trim() }]
          this.update({ turns: turns.slice(-40), state: speaker === "agent" ? "thinking" : this.value.state })
        },
        textOnly: false,
      })) as VoiceConversation
      if (epoch !== this.epoch) {
        void conversation.endSession()
        return
      }
      this.conversation = conversation
      if (!this.value.error) this.update({ state: "listening" })
    } catch (error) {
      if (epoch !== this.epoch) return
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  async stop() {
    this.epoch++
    const conversation = this.conversation
    this.conversation = null
    this.update({ state: "off", muted: false, level: 0, outputLevel: 0 })
    await conversation?.endSession().catch(() => undefined)
  }

  /** 打断正在播放的回答：让服务端把它当成一次用户活动，不需要挂断。 */
  interrupt() {
    this.conversation?.sendUserActivity()
  }

  setMuted(muted: boolean) {
    this.conversation?.setMicMuted(muted)
    this.update({ muted, level: muted ? 0 : this.value.level })
  }

  clearError() {
    this.update({ error: null })
  }
}

export const voiceCall = new VoiceCall()

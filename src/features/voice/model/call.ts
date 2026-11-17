/**
 * 一通通话。
 *
 * 麦克风、断句、打断、识别、合成在 ElevenLabs。这里拿 WebRTC token，把实时字幕和
 * 音量摊平给页面。Pi 在 `tools/speech-engine`：ElevenLabs 把转写送过去，再把
 * 流式回答念出来。Realtime 模型不能接自定义 LLM，所以这条链路是 Speech Engine。
 */
import { Conversation, type VoiceConversation, type DisconnectionDetails } from "@elevenlabs/client"
import { speechEngineToken } from "@/lib/rpc-projects"
import { bindCall } from "./binding"
import { probeSpeechEngine } from "./health"
import { ANNOUNCE_PREFIX } from "./route"
import { applyAgentPart, applyAgentSnapshot, disconnectNotice, upsertTurn, type CallTurn } from "./turns"

export type { CallTurn }
export type CallState = "off" | "connecting" | "listening" | "thinking" | "speaking"
export type VoiceLogItem = { id: string; kind: "user" | "agent" | "system"; text: string }
export type CallSnapshot = {
  state: CallState
  error: string | null
  muted: boolean
  turns: CallTurn[]
  /** 输入音量，来自服务端的 VAD 分数。输出音量要本地轮询，协议里没有这个事件。 */
  level: number
  outputLevel: number
  engineId: string
}

const empty: CallSnapshot = { state: "off", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "" }

type EarSession = Parameters<typeof Conversation.startSession>[0]
type EarOptions = Omit<EarSession, "conversationToken" | "signedUrl" | "connectionType" | "agentId">

/**
 * UDP WebRTC dies on a VPN. Relay forces TURN (still WebRTC, but TCP-friendly),
 * and the signed URL is a plain WebSocket. One attempt at a time: a timed-out
 * session would keep the microphone.
 *
 * The two starts are different overloads. Spreading the callbacks does not
 * narrow them, so each call is checked as one complete session config.
 */
async function openEar(cred: { token: string; signedUrl?: string }, options: EarOptions) {
  const errors: string[] = []
  try {
    return await Conversation.startSession({
      ...options,
      conversationToken: cred.token,
      connectionType: "webrtc",
      webRtc: { iceTransportPolicy: "relay" },
    } as EarSession)
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
  }
  if (cred.signedUrl) {
    try {
      return await Conversation.startSession({
        ...options,
        signedUrl: cred.signedUrl,
        connectionType: "websocket",
      } as EarSession)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(`连不上语音。${errors.at(-1) ?? "没有可用通路"}。中继和 WebSocket 都试过了，不用关 VPN；若仍失败，看电脑上的语音服务是否在跑。`)
}

export class VoiceCall {
  private value: CallSnapshot = empty
  private listeners = new Set<() => void>()
  private conversation: VoiceConversation | null = null
  private epoch = 0
  private outputFrame = 0

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
    this.watchOutput(false)
    this.update({ state: "off", error: message, level: 0, outputLevel: 0 })
  }
  private turns(next: CallTurn[], state?: CallState) {
    this.update(state ? { turns: next, state } : { turns: next })
  }
  private watchOutput(on: boolean) {
    cancelAnimationFrame(this.outputFrame)
    this.outputFrame = 0
    if (!on) return
    const tick = () => {
      const conversation = this.conversation
      if (!conversation || this.value.state !== "speaking") return
      const level = Math.min(1, conversation.getOutputVolume())
      if (Math.abs(level - this.value.outputLevel) >= 0.04) this.update({ outputLevel: level })
      this.outputFrame = requestAnimationFrame(tick)
    }
    this.outputFrame = requestAnimationFrame(tick)
  }

  async start() {
    if (this.value.state !== "off" || this.conversation) return
    const epoch = ++this.epoch
    this.watchOutput(false)
    this.update({ state: "connecting", error: null, muted: false, turns: [], level: 0, outputLevel: 0 })
    bindCall()
    const desk = await import("./desk")
    const held = desk.holdDesk()
    try {
      const health = await probeSpeechEngine()
      if (epoch !== this.epoch) {
        desk.dropDesk(held)
        return
      }
      if (!health.running) {
        desk.dropDesk(held)
        return this.fail(health.reason)
      }
      const { token, engineId, signedUrl } = await speechEngineToken()
      if (epoch !== this.epoch) {
        desk.dropDesk(held)
        return
      }
      if (health.engineId && engineId && health.engineId !== engineId) {
        desk.dropDesk(held)
        return this.fail(`正在跑的服务端认的是 ${health.engineId}，应用配的是 ${engineId}：两边不一致。重新跑一次 tools/speech-engine/up.sh。`)
      }
      this.update({ engineId })
      const conversation = (await openEar({ token, signedUrl }, {
        stripAudioTags: true,
        onConnect: () => {
          if (epoch === this.epoch) this.update({ state: "listening" })
        },
        onDisconnect: (details: DisconnectionDetails) => {
          desk.dropDesk(held)
          if (epoch !== this.epoch) return
          this.conversation = null
          this.watchOutput(false)
          const notice = disconnectNotice(details)
          this.update({ state: "off", level: 0, outputLevel: 0, muted: false, ...(notice ? { error: notice } : {}) })
        },
        onError: (message: string) => {
          if (epoch === this.epoch) this.fail(message || "语音连接出错")
        },
        onModeChange: ({ mode }) => {
          if (epoch !== this.epoch) return
          const speaking = mode === "speaking"
          this.update({ state: speaking ? "speaking" : "listening", outputLevel: speaking ? this.value.outputLevel : 0 })
          this.watchOutput(speaking)
        },
        onInterruption: () => {
          if (epoch !== this.epoch) return
          this.watchOutput(false)
          this.update({ state: "listening", outputLevel: 0 })
        },
        onVadScore: ({ vadScore }: { vadScore: number }) => {
          if (epoch !== this.epoch || this.value.state === "speaking") return
          if (Math.abs(vadScore - this.value.level) < 0.04) return
          this.update({ level: Math.min(1, vadScore) })
        },
        onIncomingEvent: (event: { type?: string; tentative_user_transcription_event?: { user_transcript?: string; event_id?: number } }) => {
          if (epoch !== this.epoch || event.type !== "tentative_user_transcript") return
          const text = event.tentative_user_transcription_event?.user_transcript?.trim()
          const eventId = event.tentative_user_transcription_event?.event_id
          if (!text || eventId === undefined) return
          this.turns(upsertTurn(this.value.turns, { id: `user-${eventId}`, role: "user", text }, "replace"))
        },
        onMessage: ({ message, role, event_id, response_id }: { message: string; role: string; event_id?: number; response_id?: string }) => {
          if (epoch !== this.epoch || !message.trim() || message.includes(ANNOUNCE_PREFIX)) return
          if (role === "user") {
            this.turns(upsertTurn(this.value.turns, { id: event_id === undefined ? "user-live" : `user-${event_id}`, role: "user", text: message.trim() }, "replace"), "thinking")
            return
          }
          this.turns(applyAgentSnapshot(this.value.turns, response_id ?? (event_id === undefined ? "agent-live" : `agent-${event_id}`), message.trim()))
        },
        onAgentChatResponsePart: ({ text, type, event_id, response_id }) => {
          if (epoch !== this.epoch) return
          this.turns(applyAgentPart(this.value.turns, response_id ?? `agent-${event_id}`, type, text))
        },
        onAgentResponseCorrection: ({ event_id, response_id, corrected_agent_response }) => {
          if (epoch !== this.epoch) return
          this.turns(applyAgentSnapshot(this.value.turns, response_id ?? `agent-${event_id}`, corrected_agent_response))
        },
        textOnly: false,
      })) as VoiceConversation
      if (epoch !== this.epoch) {
        desk.dropDesk(held)
        void conversation.endSession()
        return
      }
      this.conversation = conversation
      if (!this.value.error) this.update({ state: "listening" })
    } catch (error) {
      desk.dropDesk(held)
      if (epoch !== this.epoch) return
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  async stop() {
    this.epoch++
    void import("./desk").then(module => module.dropDesk())
    const conversation = this.conversation
    this.conversation = null
    this.watchOutput(false)
    this.update({ state: "off", muted: false, level: 0, outputLevel: 0 })
    await conversation?.endSession().catch(() => undefined)
  }

  /** 打断正在播放的回答。任务取消发生在桌子上，这里只通知 ElevenLabs。 */
  interrupt() {
    this.conversation?.sendUserActivity()
  }

  /** Ask ElevenLabs to speak a sentence the user did not say. Returns false when the call is down. */
  announce(sentence: string) {
    const conversation = this.conversation
    if (!conversation || this.value.state === "off") return false
    conversation.sendUserMessage(`${ANNOUNCE_PREFIX}${sentence}`)
    return true
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

/**
 * One call. Prism owns the microphone, the turn, the interruption and the voice.
 * Starting a call opens a new session in the current directory.
 * Pause or hangup stops playback and stops anything this call still wanted to send.
 */
import { Channel } from "@tauri-apps/api/core"
import { invoke } from "@/lib/native"
import { mobileRuntime } from "@/lib/runtime"
import { useWorkspace } from "@/lib/store"
import { nextVoiceToken } from "./binding"
import { taskOf } from "./brief"
import { askAgent, beginFreshVoiceSession, haltVoiceWork, handToAgent } from "./handoff"
import { PcmPlayer } from "./pcm-player"
import { quietPrismError } from "./prism-fault"
import { PrismMic } from "./prism-mic"
import { upsertTurn, type CallTurn } from "./turns"

export type { CallTurn }
export type CallState = "off" | "connecting" | "listening" | "thinking" | "speaking"
export type VoiceLogItem = { id: string; kind: "user" | "agent" | "system"; text: string }
export type CallSnapshot = {
  state: CallState
  error: string | null
  muted: boolean
  turns: CallTurn[]
  level: number
  outputLevel: number
  engineId: string
}

const empty: CallSnapshot = { state: "off", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "" }

type PrismEvent = {
  kind?: string
  text?: string
  audio?: string
  itemId?: string
  message?: string
  code?: string
  callId?: string
  responseId?: string
  arguments?: string
}

export class VoiceCall {
  private value: CallSnapshot = empty
  private listeners = new Set<() => void>()
  private mic: PrismMic | null = null
  private player = new PcmPlayer(level => {
    if (Math.abs(level - this.value.outputLevel) >= 0.04) this.update({ outputLevel: level })
  })
  private epoch = 0
  private sent = new Set<string>()
  private replyId = ""
  private said = ""
  private jevTimer = 0
  private handoffGen = 0
  /** False after pause or hangup, until the person speaks again. */
  private mouth = false
  /** The reply that pause cut. Later chunks of it must not start playing again. */
  private droppedItem = ""

  getSnapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(patch: Partial<CallSnapshot>) {
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private fail(message: string) {
    void invoke("rime_prism_close").catch(() => undefined)
    this.mic?.stop()
    this.mic = null
    void this.player.close()
    this.player = new PcmPlayer(level => this.update({ outputLevel: level }))
    this.update({ state: "off", error: message, level: 0, outputLevel: 0 })
  }
  private turns(next: CallTurn[], state?: CallState) {
    this.update(state ? { turns: next, state } : { turns: next })
  }

  canSpeak() {
    return this.mouth && this.value.state !== "off"
  }

  async start() {
    if (this.value.state !== "off") return
    if (mobileRuntime()) return this.fail("这通语音在电脑上开。手机端还没接 Prism。")
    if (!useWorkspace.getState().cwd) return this.fail("没有打开的项目。")
    const epoch = ++this.epoch
    this.sent.clear()
    this.replyId = ""
    this.mouth = true
    nextVoiceToken()
    this.update({ state: "connecting", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "prism" })
    void beginFreshVoiceSession()
    try {
      const config = await invoke<{ hasCredential?: boolean }>("rime_config")
      if (epoch !== this.epoch) return
      if (!config.hasCredential) return this.fail("还没有配置 Rime API Key（在语音设置里填一次即可）。")
      const channel = new Channel<PrismEvent>()
      channel.onmessage = event => { if (epoch === this.epoch) this.onPrism(event) }
      await invoke("rime_prism_open", { onEvent: channel })
      if (epoch !== this.epoch) {
        await invoke("rime_prism_close").catch(() => undefined)
        return
      }
      await this.player.prepare()
      const mic = new PrismMic({
        onAudio: audio => { void invoke("rime_prism_audio", { audioBase64: audio }).catch(() => undefined) },
        onLevel: level => {
          if (epoch !== this.epoch || Math.abs(level - this.value.level) < 0.04) return
          this.update({ level })
        },
        onError: message => { if (epoch === this.epoch) this.fail(message) },
      })
      this.mic = mic
      await mic.start()
      if (epoch !== this.epoch) return
      this.update({ state: "listening" })
    } catch (error) {
      if (epoch !== this.epoch) return
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private onPrism(event: PrismEvent) {
    if (event.kind === "speech_started") {
      this.cut()
      this.update({ state: "listening" })
      return
    }
    if (event.kind === "tool_pending") {
      if (!this.mouth) return
      this.handoffGen++
      window.clearTimeout(this.jevTimer)
      return
    }
    if (event.kind === "tool_call") {
      this.handoffGen++
      window.clearTimeout(this.jevTimer)
      if (!this.mouth) {
        void this.quietTool(event)
        return
      }
      void this.onTool(event)
      return
    }
    if ((event.kind === "audio" || event.kind === "reply") && !this.mouth) return
    if (event.kind === "transcript" && event.text) {
      this.mouth = true
      void invoke("rime_prism_quiet", { hush: false }).catch(() => undefined)
      this.said = event.text
      this.turns(upsertTurn(this.value.turns, { id: `user-${this.value.turns.length}`, role: "user", text: event.text }, "replace"), "listening")
      if (!this.sent.has(event.text)) {
        this.sent.add(event.text)
        this.armFallback(event.text)
      }
      return
    }
    if (event.kind === "reply" && event.text) {
      if (this.droppedItem && this.replyId === this.droppedItem) return
      const id = this.replyId || `agent-${this.value.turns.length}`
      this.replyId = ""
      this.turns(upsertTurn(this.value.turns, { id, role: "agent", text: event.text }, "replace"), "speaking")
      return
    }
    if (event.kind === "audio" && event.audio) {
      const itemId = event.itemId ?? ""
      if (this.droppedItem && itemId === this.droppedItem) return
      if (this.droppedItem && itemId && itemId !== this.droppedItem) this.droppedItem = ""
      if (!this.replyId) this.replyId = `agent-${this.value.turns.length}`
      this.player.push(event.audio, itemId)
      if (this.value.state !== "speaking") this.update({ state: "speaking" })
      return
    }
    if (event.kind === "error" && event.message && !quietPrismError(event.code, event.message)) this.update({ error: event.message })
    if (event.kind === "closed" && this.value.state !== "off" && this.value.state !== "connecting") {
      this.fail(this.value.error || "语音连接已断开")
    }
  }

  private armFallback(text: string) {
    window.clearTimeout(this.jevTimer)
    const gen = ++this.handoffGen
    this.jevTimer = window.setTimeout(() => {
      if (gen !== this.handoffGen) return
      void handToAgent(text, this.value.turns)
    }, 1200)
  }

  private async onTool(event: PrismEvent) {
    if (!this.mouth || this.value.state === "off") {
      await this.quietTool(event)
      return
    }
    const task = taskOf(event.arguments, this.said)
    const result = await askAgent(task, this.value.turns)
    if (!this.mouth || result.reason === "cancelled") {
      await this.quietTool(event)
      return
    }
    const spoken = result.spoken.trim()
    const finished = Boolean(spoken) && !result.pending && !spoken.startsWith("situation:")
    if (!finished) {
      await this.quietTool(event)
      if (spoken.startsWith("situation:") && this.mouth) this.announce(spoken)
      return
    }
    if (!event.callId || !event.responseId) {
      this.announce(spoken)
      return
    }
    try {
      const fate = await invoke<string>("rime_prism_tool_result", {
        callId: event.callId,
        responseId: event.responseId,
        output: spoken,
        speak: true,
      })
      if (fate !== "continued" && this.mouth) this.announce(spoken)
    } catch {
      if (this.mouth) this.announce(spoken)
    }
  }

  private async quietTool(event: PrismEvent) {
    if (!event.callId || !event.responseId) return
    await invoke("rime_prism_tool_result", {
      callId: event.callId,
      responseId: event.responseId,
      output: "stopped",
      speak: false,
    }).catch(() => undefined)
  }

  private cut() {
    const heard = this.player.stop()
    if (heard.itemId) void invoke("rime_prism_truncate", { itemId: heard.itemId, audioEndMs: heard.heardMs }).catch(() => undefined)
  }

  async stop() {
    this.epoch++
    this.mouth = false
    this.droppedItem = this.replyId
    this.handoffGen++
    window.clearTimeout(this.jevTimer)
    nextVoiceToken()
    this.mic?.stop()
    this.mic = null
    this.player.stop()
    this.hush()
    this.update({ state: "off", muted: false, level: 0, outputLevel: 0 })
    await invoke("rime_prism_close").catch(() => undefined)
  }

  /** Cut the sound and the work. The call stays up so they can speak again. */
  pause() {
    if (this.value.state === "off") return
    this.mouth = false
    this.droppedItem = this.replyId
    this.handoffGen++
    window.clearTimeout(this.jevTimer)
    nextVoiceToken()
    this.cut()
    this.hush()
    if (this.value.state !== "listening" && this.value.state !== "connecting") this.update({ state: "listening", outputLevel: 0 })
  }

  interrupt() {
    this.pause()
  }

  private hush() {
    haltVoiceWork()
    void invoke("rime_prism_quiet").catch(() => undefined)
  }

  /** Say a sentence the person did not ask for. False when the call is down. */
  announce(sentence: string) {
    if (!this.canSpeak() || !sentence.trim()) return false
    void invoke("rime_prism_nudge", { text: sentence }).catch(() => undefined)
    return true
  }

  /** Name the specific request, then hand it to Pi. Not a fixed holding line. */
  hold(said: string) {
    if (!this.canSpeak() || !said.trim()) return false
    void invoke("rime_prism_hold", { text: said }).catch(() => undefined)
    return true
  }

  setMuted(muted: boolean) {
    this.mic?.setMuted(muted)
    this.update({ muted, level: muted ? 0 : this.value.level })
  }

  clearError() {
    this.update({ error: null })
  }
}

export const voiceCall = new VoiceCall()

/**
 * One call. Prism owns the microphone, the turn, the interruption and the voice.
 * Jev only decides whether the words go to the working session.
 */
import { Channel } from "@tauri-apps/api/core"
import { invoke } from "@/lib/native"
import { mobileRuntime } from "@/lib/runtime"
import { bindCall } from "./binding"
import { handToAgent } from "./handoff"
import { PcmPlayer } from "./pcm-player"
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

type PrismEvent = { kind?: string; text?: string; audio?: string; itemId?: string; message?: string }

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

  async start() {
    if (this.value.state !== "off") return
    if (mobileRuntime()) return this.fail("这通语音在电脑上开。手机端还没接 Prism。")
    const epoch = ++this.epoch
    this.sent.clear()
    this.replyId = ""
    this.update({ state: "connecting", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "prism" })
    bindCall()
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
    if (event.kind === "transcript" && event.text) {
      this.turns(upsertTurn(this.value.turns, { id: `user-${this.value.turns.length}`, role: "user", text: event.text }, "replace"), "listening")
      if (!this.sent.has(event.text)) {
        this.sent.add(event.text)
        const said = event.text
        void handToAgent(said).then(result => {
          if (result === "no-session") this.announce("没有正在用的会话。")
        })
      }
      return
    }
    if (event.kind === "reply" && event.text) {
      const id = this.replyId || `agent-${this.value.turns.length}`
      this.replyId = ""
      this.turns(upsertTurn(this.value.turns, { id, role: "agent", text: event.text }, "replace"), "speaking")
      return
    }
    if (event.kind === "audio" && event.audio) {
      if (!this.replyId) this.replyId = `agent-${this.value.turns.length}`
      this.player.push(event.audio, event.itemId ?? "")
      if (this.value.state !== "speaking") this.update({ state: "speaking" })
      return
    }
    if (event.kind === "error" && event.message) this.update({ error: event.message })
    if (event.kind === "closed" && this.value.state !== "off" && this.value.state !== "connecting") {
      this.fail(this.value.error || "语音连接已断开")
    }
  }

  private cut() {
    const heard = this.player.stop()
    if (heard.itemId) void invoke("rime_prism_truncate", { itemId: heard.itemId, audioEndMs: heard.heardMs }).catch(() => undefined)
  }

  async stop() {
    this.epoch++
    this.mic?.stop()
    this.mic = null
    this.player.stop()
    this.update({ state: "off", muted: false, level: 0, outputLevel: 0 })
    await invoke("rime_prism_close").catch(() => undefined)
  }

  interrupt() {
    this.cut()
    if (this.value.state === "speaking") this.update({ state: "listening", outputLevel: 0 })
  }

  /** Say a sentence the person did not ask for. False when the call is down. */
  announce(sentence: string) {
    if (this.value.state === "off" || !sentence.trim()) return false
    void invoke("rime_prism_nudge", { text: sentence }).catch(() => undefined)
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

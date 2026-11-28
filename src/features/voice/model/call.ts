/**
 * One call. Prism owns the microphone, the turn, the interruption and the voice.
 * Starting a call opens a new session in the current directory.
 * Pause or hangup stops playback and stops anything this call still wanted to send.
 */
import { Channel } from "@tauri-apps/api/core"
import { invoke } from "@/lib/native"
import { mobileRuntime } from "@/lib/runtime"
import { remoteCanInvoke } from "@/lib/remote-workspace"
import { subscribeVoiceRemote } from "@/lib/voice-remote"
import { useWorkspace } from "@/lib/store"
import { nextVoiceToken } from "./binding"
import { taskOf } from "./brief"
import { askAgent, beginFreshVoiceSession, cancelVoiceSessionOpening, haltVoiceWork, handToAgent } from "./handoff"
import { microphoneError } from "./microphone-error"
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
  private player = this.createPlayer()
  private opening: Promise<unknown> | null = null
  private closing: Promise<unknown> = Promise.resolve()
  private replyTimer: ReturnType<typeof setTimeout> | undefined
  private audioPending = 0
  private connectionReady = false
  private seenAudio = false
  private receivedReply = false
  private turnSequence = 0
  private waitingForTool = false
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
  private unlistenRemote: (() => void) | null = null

  getSnapshot = () => this.value
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private createPlayer() {
    return new PcmPlayer(level => {
      if (Math.abs(level - this.value.outputLevel) >= 0.04 || (level === 0 && this.value.outputLevel !== 0)) this.update({ outputLevel: level })
    }, () => {
      if (this.receivedReply && this.value.state === "speaking") this.update({ state: "listening" })
    })
  }
  private update(patch: Partial<CallSnapshot>) {
    if ((Object.keys(patch) as (keyof CallSnapshot)[]).every(key => patch[key] === this.value[key])) return
    this.value = { ...this.value, ...patch }
    for (const listener of this.listeners) listener()
  }
  private fail(message: string) {
    if (this.value.state !== "off") void this.stop()
    this.update({ error: message })
  }
  private waitForReply(message: string, milliseconds: number) {
    clearTimeout(this.replyTimer)
    this.replyTimer = setTimeout(() => {
      if (this.value.state !== "off") this.update({ state: "listening", error: message })
    }, milliseconds)
  }
  private turns(next: CallTurn[], state?: CallState) {
    this.update(state ? { turns: next, state } : { turns: next })
  }

  canSpeak() {
    return this.mouth && this.value.state !== "off"
  }

  async start() {
    if (this.value.state !== "off") return
    if (mobileRuntime() && !remoteCanInvoke("rime_prism_open")) {
      return this.fail("手机要先连上电脑。语音在电脑上接通，麦和声音在这台手机上。")
    }
    if (!useWorkspace.getState().cwd) return this.fail("没有打开的项目。")
    const epoch = ++this.epoch
    this.sent.clear()
    this.replyId = ""
    this.said = ""
    this.droppedItem = ""
    this.mouth = true
    this.audioPending = 0
    this.connectionReady = false
    this.seenAudio = false
    this.receivedReply = false
    this.turnSequence = 0
    this.waitingForTool = false
    nextVoiceToken()
    this.update({ state: "connecting", error: null, muted: false, turns: [], level: 0, outputLevel: 0, engineId: "prism" })
    const mic = new PrismMic({
      onAudio: audio => { if (epoch === this.epoch && this.connectionReady) this.sendAudio(audio, epoch) },
      onLevel: level => {
        if (epoch === this.epoch && (Math.abs(level - this.value.level) >= 0.04 || level === 0)) this.update({ level })
      },
      onError: message => { if (epoch === this.epoch) this.fail(message) },
    })
    this.mic = mic
    // Unlock both audio contexts in the initiating tap, before any network await.
    const playback = this.player.prepare()
    const capture = mic.start()
    const prepareAudio = Promise.all([playback, capture]);
    void prepareAudio.catch(error => {
      if (epoch === this.epoch) this.fail(microphoneError(error))
    });
    try {
      await this.closing
      if (epoch !== this.epoch) return
      const config = await invoke<{ hasCredential?: boolean }>("rime_config")
      if (epoch !== this.epoch) return
      if (!config.hasCredential) return this.fail("还没有配置 Rime API Key（在语音设置里填一次即可）。")
      if (mobileRuntime()) {
        this.unlistenRemote = subscribeVoiceRemote(event => {
          if (epoch === this.epoch) this.onPrism(event)
        })
        this.opening = invoke("rime_prism_open")
      } else {
        const channel = new Channel<PrismEvent>()
        channel.onmessage = event => { if (epoch === this.epoch) this.onPrism(event) }
        this.opening = invoke("rime_prism_open", { onEvent: channel })
      }
      await this.opening
      if (epoch !== this.epoch) return
      await prepareAudio
      if (epoch !== this.epoch) return
      this.connectionReady = true
      this.update({ state: "listening" })
      void beginFreshVoiceSession().catch(() => undefined)
      this.waitForReply("麦克风没有传来音频，请检查权限后重新接通。", 4_000)
    } catch (error) {
      if (epoch === this.epoch) this.fail(microphoneError(error))
    }
  }

  private sendAudio(audio: string, epoch: number) {
    if (!this.seenAudio) {
      this.seenAudio = true
      clearTimeout(this.replyTimer)
      if (this.value.error) this.update({ error: null })
    }
    if (this.audioPending >= 12) {
      this.fail("音频上传跟不上，请检查手机与电脑的连接后重新接通。")
      return
    }
    this.audioPending++
    void invoke("rime_prism_audio", { audioBase64: audio }).catch(error => {
      if (epoch === this.epoch) this.fail(`音频发送失败：${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => {
      if (epoch === this.epoch) this.audioPending--
    })
  }

  private onPrism(event: PrismEvent) {
    if (event.kind === "speech_started") {
      this.cut()
      this.replyId = ""
      this.receivedReply = false
      this.waitingForTool = false
      this.turnSequence++
      this.update({ state: "listening", error: null })
      this.waitForReply("暂时没有收到识别结果，请停顿一下后再说一次。", 15_000)
      return
    }
    if (event.kind === "speech_stopped") {
      this.update({ state: "thinking" })
      this.waitForReply("暂时没有收到识别结果，请再说一次。", 12_000)
      return
    }
    if (event.kind === "transcription_error") {
      clearTimeout(this.replyTimer)
      this.update({ state: "listening", error: event.message || "没听清，请再说一次。" })
      return
    }
    if (event.kind === "idle" || event.kind === "audio_done") {
      if (event.kind === "audio_done" && event.itemId && this.replyId && event.itemId !== this.replyId) return
      this.receivedReply = true
      if (!this.player.playing && this.value.state === "speaking") this.update({ state: "listening" })
      return
    }
    if (event.kind === "response_failed") {
      clearTimeout(this.replyTimer)
      this.receivedReply = true
      this.update({ state: this.player.playing ? "speaking" : "listening", error: event.message || "Rime 没能完成回复。请再说一次。" })
      return
    }
    if (event.kind === "tool_pending") {
      if (!this.mouth) return
      this.waitingForTool = true
      this.update({ state: this.player.playing ? "speaking" : "thinking" })
      this.waitForReply("Rime 未完成任务交接，请再说一次。", 12_000)
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
      this.waitingForTool = true
      clearTimeout(this.replyTimer)
      this.update({ state: "thinking" })
      void this.onTool(event).catch(error => {
        if (this.mouth) this.update({ state: "listening", error: `语音任务未完成：${String(error)}` })
      })
      return
    }
    if ((event.kind === "audio" || event.kind === "reply") && !this.mouth) return
    if (event.kind === "transcript" && event.text) {
      this.mouth = true
      void invoke("rime_prism_quiet", { hush: false }).catch(() => undefined)
      clearTimeout(this.replyTimer)
      this.said = event.text
      const id = event.itemId || `user-${this.turnSequence}`
      const state = this.player.playing ? "speaking" : this.receivedReply ? "listening" : "thinking"
      this.turns(upsertTurn(this.value.turns, { id, role: "user", text: event.text }, "replace"), state)
      if (!this.waitingForTool && !this.sent.has(id)) {
        this.sent.add(id)
        if (state === "thinking") this.waitForReply("已经听到这句话，但语音服务还没有回复。请再试一次。", 16_000)
        this.armFallback(event.text)
      }
      return
    }
    if (event.kind === "reply" && event.text) {
      const id = event.itemId || this.replyId || `agent-${this.turnSequence}`
      if (this.droppedItem && id === this.droppedItem) return
      clearTimeout(this.replyTimer)
      this.receivedReply = true
      this.turns(upsertTurn(this.value.turns, { id, role: "agent", text: event.text }, "replace"), this.player.playing ? "speaking" : "listening")
      return
    }
    if (event.kind === "audio" && event.audio) {
      const itemId = event.itemId ?? ""
      if (this.droppedItem && itemId === this.droppedItem) return
      if (this.droppedItem && itemId && itemId !== this.droppedItem) this.droppedItem = ""
      clearTimeout(this.replyTimer)
      const id = itemId || this.replyId || `agent-${this.turnSequence}`
      if (this.replyId !== id) {
        this.replyId = id
        this.receivedReply = false
      }
      this.player.push(event.audio, itemId)
      if (!this.player.playing) this.update({ state: "listening", error: "系统暂停了音频播放，请重新接通。" })
      else if (this.value.state !== "speaking") this.update({ state: "speaking", error: null })
      return
    }
    if (event.kind === "error" && event.message && !quietPrismError(event.code, event.message)) this.update({ error: event.message })
    if (event.kind === "closed" && this.value.state !== "off") {
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
    const epoch = this.epoch
    const task = taskOf(event.arguments, this.said)
    const result = await askAgent(task, this.value.turns)
    if (epoch !== this.epoch) return
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
      if (fate !== "continued" && epoch === this.epoch && this.mouth) this.announce(spoken)
    } catch {
      if (epoch === this.epoch && this.mouth) this.announce(spoken)
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
    if (heard.itemId) {
      this.droppedItem = heard.itemId
      void invoke("rime_prism_truncate", { itemId: heard.itemId, audioEndMs: heard.heardMs }).catch(() => undefined)
    }
  }

  async stop() {
    if (this.value.state === "off") return
    this.epoch++
    this.mouth = false
    this.connectionReady = false
    clearTimeout(this.replyTimer)
    cancelVoiceSessionOpening()
    this.droppedItem = this.replyId
    this.handoffGen++
    window.clearTimeout(this.jevTimer)
    nextVoiceToken()
    this.mic?.stop()
    this.mic = null
    this.unlistenRemote?.()
    this.unlistenRemote = null
    const opening = this.opening
    this.opening = null
    const player = this.player
    this.player = this.createPlayer()
    void player.close().catch(() => undefined)
    haltVoiceWork()
    this.update({ state: "off", muted: false, level: 0, outputLevel: 0 })
    if (opening) {
      this.closing = opening.catch(() => undefined).then(() => invoke("rime_prism_close")).catch(() => undefined)
      await this.closing
    }
  }

  /** Cut the sound and the work. The call stays up so they can speak again. */
  pause() {
    if (this.value.state === "off") return
    clearTimeout(this.replyTimer)
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
